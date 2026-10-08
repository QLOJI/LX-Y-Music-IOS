import * as webdav from '@/utils/webdav'
import { overwriteListFull } from '@/core/list'
import { filterSensitiveSettingsForSync, getAllDataForSync } from './syncHelpers'
import { confirmDialog, toast } from '@/utils/tools'
import { updateSetting } from '@/core/common'
import settingState from '@/store/setting/state'
import { webDAVLog } from '@/core/webdavMusic/logger'
import { debounce } from '@/utils/common'
import { getOperationQueue, clearOperationQueue, loadOperationQueue } from './opQueue'
import { applyListOperation } from '@/utils/listManage'
import { overwriteUserApis } from '@/core/userApi.ts'
import { getPlayHistory, savePlayHistory } from '@/utils/data'
import {
  normalizeDownloadTasksForSync,
  normalizeRemoteSyncedDownloadTasks,
  saveDownloadTasks,
} from '@/utils/data/download'
import downloadState from '@/store/download/state'
// 【第 34 轮第 1 条】与「同步服务地址」（LX 同步服务）那套的互斥窗口，见下方 waitForListNegotiation
import { isListNegotiating } from '@/plugins/sync'

// ---------------------------------------------------------------------------
// 【第 34 轮第 1 条】两套同步的「互不相互影响」
//
// 用户原话：「请判断 WebDAV 同步和同步服务地址同步是否有冲突，使其独立不相互影响」。
// 判断结论：**确实存在一处真实冲突**，不在网络层而在数据层 —— 两套同步都在写同一份本地歌单，
// 而且都用「全量覆盖」（本文件是 overwriteListFull，LX 那边是 list_data_overwrite），
// 但 LX 同步服务这一侧是**带协商的**：
//   socket 打开 → 客户端上报本地歌单的 md5 → 服务端拿自己的数据比对 →
//   可能反过来问客户端「同步方式」（合并 / 覆盖）→ 再拉取 / 下发全量歌单 → finished()。
// 从「上报 md5」到「完成」这段窗口里，本地歌单被 WebDAV 同步改写会发生两件坏事：
//   ① 服务端据 md5 得出的「谁更新 / 要不要合并」结论对不上真实数据；
//   ② 这段窗口里 LX 客户端还没注册本地变更事件（list_sync_finished 之后才注册），
//      所以 WebDAV 写进去的新数据不会被推送给服务端 —— 服务端的快照从此是旧的。
// 所以让行规则是：**LX 那边处于歌单协商窗口时，WebDAV 这边不碰歌单**。
//   · 手动（立即同步歌单 / 上传歌单 / 下载歌单）：先等窗口结束（有界 15 秒，等待期间给提示）；
//     等不到就明确告诉用户稍后再试，不硬闯；
//   · 自动（3 秒去抖 / 冷启动补同步）：本就在下面 debouncedSync 里让行，等不到就下一轮再来；
//     本地未同步的变更记在 opQueue 里（持久化、跨进程存活），不会因为这一轮没同步而丢。
// 窗口之外（包括两套同步都连着、都空闲时）互不干扰：LX 客户端在 finished() 之后会注册
// 本地变更事件，WebDAV 写进去的歌单会被它当作本地变更推给服务端，两边自然收敛。
// ---------------------------------------------------------------------------
const LX_NEGOTIATION_WAIT_MAX_MS = 15000
const LX_NEGOTIATION_POLL_MS = 500
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/**
 * 让「同步服务地址」的歌单协商先跑完。
 * @returns true = 现在可以动本地歌单；false = 对方还在协商，本次让行（手动已给提示）
 */
async function waitForListNegotiation(isManual: boolean): Promise<boolean> {
  if (!isListNegotiating()) return true
  webDAVLog.info('[Sync] LX sync service is negotiating lists, WebDAV sync steps aside for now.')
  if (isManual) toast('正在等待「同步服务地址」完成歌单协商...')
  const deadline = Date.now() + LX_NEGOTIATION_WAIT_MAX_MS
  while (isListNegotiating() && Date.now() < deadline) {
    await sleep(LX_NEGOTIATION_POLL_MS)
  }
  if (!isListNegotiating()) return true
  webDAVLog.warn('[Sync] LX sync service still negotiating, skip this turn.')
  if (isManual) toast('「同步服务地址」仍在协商歌单，请稍后再试', 'long')
  return false
}

let listsChanged = false
let isSyncing = false
let nextListsUploadExtraData: ListsSyncExtraData | null = null

interface ListsSyncFile {
  version?: string
  lastModified: number
  data: LX.List.ListDataFull
  playHistory?: LX.Player.PlayHistoryItem[]
  downloadTasks?: LX.Download.DownloadTask[]
}

interface ListsSyncExtraData {
  playHistory: LX.Player.PlayHistoryItem[]
  downloadTasks: LX.Download.DownloadTask[]
}

void loadOperationQueue()

const debouncedSync = debounce(() => {
  if (!settingState.setting['sync.webdav.enable'] || !settingState.setting['sync.webdav.syncLists']) return
  // 【第 34 轮第 1 条】「同步服务地址」正在协商歌单 → 本轮让行，3 秒后再看一次。
  // 不在这里丢改动：listsChanged 保持置位（下面 .finally 里才清），opQueue 也还在，
  // 等协商窗口结束（服务端 finished() 或窗口封顶 90 秒到期）自然会同步上去。
  if (isListNegotiating()) {
    webDAVLog.info('[Sync] LX sync service is negotiating lists, auto sync re-queued.')
    debouncedSync()
    return
  }
  if (listsChanged) {
    void triggerWebDAVSync(false).finally(() => {
      listsChanged = false
    })
  }
}, 3000)

export const markListsChanged = () => {
  if (!settingState.setting['sync.webdav.enable']) return
  listsChanged = true
  debouncedSync()
}

/**
 * 冷启动补同步（第 19 轮第 5 条）：
 * 启动时不再无条件跑一次 WebDAV 歌单同步 —— 用户原话「启用同步后，退出后，
 * 每次返回软件都会马上同步一次」。只有本地确实攒着「没同步上去的歌单操作」
 * （opQueue 非空，持久化在 storage 里、跨进程存活）才补一次；
 * 其余情况等用户手动「立即同步歌单」，或运行中产生真实变更时由 debouncedSync 触发。
 */
export const syncPendingChangesOnStartup = async() => {
  if (!settingState.setting['sync.webdav.enable'] || !settingState.setting['sync.webdav.url']) return
  await loadOperationQueue()
  if (getOperationQueue().length === 0) {
    webDAVLog.info('[Sync] Startup: no pending local operations, skip auto sync.')
    return
  }
  webDAVLog.info(`[Sync] Startup: ${getOperationQueue().length} pending local operations, sync now.`)
  await triggerWebDAVSync()
}

function getRemoteListsFilePath(): string {
  const path = settingState.setting['sync.webdav.path'] || '/LX_Music/'
  const cleanPath = '/' + path.replace(/^\/|\/$/g, '')
  return `${cleanPath}/playlists.json`
}

function getRemoteSettingsFilePath(): string {
  const path = settingState.setting['sync.webdav.path'] || '/LX_Music/'
  const cleanPath = '/' + path.replace(/^\/|\/$/g, '')
  return `${cleanPath}/settings.json`
}

function getRemoteUserApisFilePath(): string {
  const path = settingState.setting['sync.webdav.path'] || '/LX_Music/'
  const cleanPath = '/' + path.replace(/^\/|\/$/g, '')
  return `${cleanPath}/user_apis.json`
}

async function uploadUserApis(path: string): Promise<number> {
  const timestamp = Date.now()
  const { userApis } = await getAllDataForSync()
  const dataObject = {
    version: '2',
    lastModified: timestamp,
    data: userApis,
  }
  await webdav.uploadFile(path, JSON.stringify(dataObject))
  return timestamp
}

async function uploadLists(path: string, listsData: LX.List.ListDataFull): Promise<number> {
  const timestamp = Date.now()
  const { playHistory, downloadTasks } = nextListsUploadExtraData ?? await getAllDataForSync()
  nextListsUploadExtraData = null
  const dataObject: Record<string, any> = {
    version: '2',
    lastModified: timestamp,
    data: listsData,
  }
  if (settingState.setting['sync.webdav.syncPlayHistory']) {
    dataObject.playHistory = playHistory
  }
  if (settingState.setting['sync.webdav.syncDownloadTasks']) {
    dataObject.downloadTasks = downloadTasks
  }
  await webdav.uploadFile(path, JSON.stringify(dataObject))
  updateSetting({ 'sync.webdav.lastSyncTimeLists': timestamp })
  return timestamp
}

const normalizeRemoteListsData = (remoteData: ListsSyncFile | any): ListsSyncFile => ({
  ...remoteData,
  data: remoteData.data,
  lastModified: remoteData.lastModified ?? 0,
  playHistory: Array.isArray(remoteData.playHistory) ? remoteData.playHistory : undefined,
  downloadTasks: Array.isArray(remoteData.downloadTasks) ? remoteData.downloadTasks : undefined,
})

const mergePlayHistory = (
  localHistory: LX.Player.PlayHistoryItem[],
  remoteHistory?: LX.Player.PlayHistoryItem[],
) => {
  const historyMap = new Map<string, LX.Player.PlayHistoryItem>()
  for (const item of remoteHistory ?? []) historyMap.set(item.id, item)
  for (const item of localHistory) historyMap.set(item.id, item)
  return [...historyMap.values()]
    .sort((a, b) => b.playedAt - a.playedAt)
    .slice(0, 5000)
}

const mergeDownloadTasks = (
  localTasks: LX.Download.DownloadTask[],
  remoteTasks?: LX.Download.DownloadTask[],
) => {
  const taskMap = new Map<string, LX.Download.DownloadTask>()
  for (const task of remoteTasks ?? []) taskMap.set(task.id, task)
  for (const task of localTasks) taskMap.set(task.id, task)
  return normalizeDownloadTasksForSync([...taskMap.values()].sort((a, b) => b.createdAt - a.createdAt))
}

const mergeDownloadTasksForLocal = (
  localTasks: LX.Download.DownloadTask[],
  remoteTasks?: LX.Download.DownloadTask[],
) => {
  const taskMap = new Map<string, LX.Download.DownloadTask>()
  for (const task of normalizeRemoteSyncedDownloadTasks(remoteTasks ?? [])) taskMap.set(task.id, task)
  for (const task of localTasks) taskMap.set(task.id, task)
  return [...taskMap.values()].sort((a, b) => b.createdAt - a.createdAt)
}

const getRemoteDownloadTasksForLocal = (remoteTasks: LX.Download.DownloadTask[]) => {
  const localTaskMap = new Map(downloadState.tasks.map(task => [task.id, task]))
  return normalizeRemoteSyncedDownloadTasks(remoteTasks)
    .map(task => {
      const localTask = localTaskMap.get(task.id)
      if (!localTask) return task
      return {
        ...task,
        status: localTask.status,
        errorMsg: localTask.errorMsg,
        progress: localTask.progress,
        metadataStatus: localTask.metadataStatus,
        isRemoteSynced: localTask.isRemoteSynced,
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}

const getMergedExtraData = async(remoteData: ListsSyncFile): Promise<ListsSyncExtraData> => {
  const localHistory = settingState.setting['sync.webdav.syncPlayHistory'] ? await getPlayHistory() : []
  return {
    playHistory: settingState.setting['sync.webdav.syncPlayHistory'] ? mergePlayHistory(localHistory, remoteData.playHistory) : [],
    downloadTasks: settingState.setting['sync.webdav.syncDownloadTasks'] ? mergeDownloadTasks(downloadState.tasks, remoteData.downloadTasks) : [],
  }
}


const hasLocalExtraDataChanges = async(remoteData: ListsSyncFile) => {
  const localHistory = settingState.setting['sync.webdav.syncPlayHistory'] ? await getPlayHistory() : []
  const localDownloads = settingState.setting['sync.webdav.syncDownloadTasks'] ? normalizeDownloadTasksForSync(downloadState.tasks) : []
  const remoteHistory = settingState.setting['sync.webdav.syncPlayHistory'] ? (remoteData.playHistory ?? []) : []
  const remoteDownloads = settingState.setting['sync.webdav.syncDownloadTasks'] ? normalizeDownloadTasksForSync(remoteData.downloadTasks ?? []) : []
  return JSON.stringify({ playHistory: localHistory, downloadTasks: localDownloads }) !== JSON.stringify({ playHistory: remoteHistory, downloadTasks: remoteDownloads })
}

async function applySyncedExtraData(remoteData: ListsSyncFile) {
  if (settingState.setting['sync.webdav.syncPlayHistory'] && Array.isArray(remoteData.playHistory)) {
    await savePlayHistory(remoteData.playHistory)
    global.app_event.playHistoryUpdated()
  }
  if (settingState.setting['sync.webdav.syncDownloadTasks'] && Array.isArray(remoteData.downloadTasks)) {
    const tasks = getRemoteDownloadTasksForLocal(remoteData.downloadTasks)
    downloadState.tasks = tasks
    await saveDownloadTasks(tasks)
    global.app_event.download_list_changed()
  }
}

async function applyMergedExtraData(remoteData: ListsSyncFile) {
  if (settingState.setting['sync.webdav.syncPlayHistory']) {
    const localHistory = await getPlayHistory()
    await savePlayHistory(mergePlayHistory(localHistory, remoteData.playHistory))
    global.app_event.playHistoryUpdated()
  }

  if (settingState.setting['sync.webdav.syncDownloadTasks']) {
    const tasks = mergeDownloadTasksForLocal(downloadState.tasks, remoteData.downloadTasks)
    downloadState.tasks = tasks
    await saveDownloadTasks(tasks)
    global.app_event.download_list_changed()
  }
}

async function uploadSettings(path: string): Promise<number> {
  const timestamp = Date.now()
  const { settings } = await getAllDataForSync()
  const dataObject = {
    version: '2',
    lastModified: timestamp,
    data: settings,
  }
  await webdav.uploadFile(path, JSON.stringify(dataObject))
  return timestamp
}

export async function manualUploadSettingsAndApis() {
  if (isSyncing) {
    toast('正在同步中，请稍后...')
    return
  }
  if (!settingState.setting['sync.webdav.enable'] || !settingState.setting['sync.webdav.url']) {
    toast('请先启用并配置 WebDAV 同步')
    return
  }

  const confirm = await confirmDialog({
    title: '确认上传',
    message: '这将使用本地的“设置”和“自定义音源”完全覆盖云端的数据，此操作不可逆，确定要继续吗？',
    confirmButtonText: '上传',
  })
  if (!confirm) return

  // 【第 33 轮第 3 条】isSyncing = true 挪进 try：以前它写在 try 外面、紧接着一句 toast，
  // 这一小段一旦出岔子（同步抛错等）标记就永久停在 true —— 之后四个手动按钮 + 自动同步
  // 全部只回一句「正在同步中，请稍后...」，用户看到的就是「所有按钮全部锁死、点了没反应」。
  try {
    isSyncing = true
    toast('开始上传...')
    const remoteSettingsPath = getRemoteSettingsFilePath()
    const remoteUserApisPath = getRemoteUserApisFilePath()

    await uploadSettings(remoteSettingsPath)
    await uploadUserApis(remoteUserApisPath)

    toast('上传成功！')
  } catch (error: any) {
    webDAVLog.error(`[Manual Upload] Failed: ${error.stack ?? error.message}`)
    toast(`上传失败: ${error.message}`, 'long')
  } finally {
    isSyncing = false
  }
}

export async function manualDownloadSettingsAndApis() {
  if (isSyncing) {
    toast('正在同步中，请稍后...')
    return
  }
  if (!settingState.setting['sync.webdav.enable'] || !settingState.setting['sync.webdav.url']) {
    toast('请先启用并配置 WebDAV 同步')
    return
  }

  const confirm = await confirmDialog({
    title: '确认下载',
    message: '这将使用云端的“设置”和“自定义音源”完全覆盖本地的数据，此操作不可逆，确定要继续吗？',
    confirmButtonText: '下载',
  })
  if (!confirm) return

  // 【第 33 轮第 3 条】同手动上传：标记进 try，杜绝永久卡在「正在同步中」
  try {
    isSyncing = true
    toast('开始下载...')
    const remoteSettingsPath = getRemoteSettingsFilePath()
    const remoteUserApisPath = getRemoteUserApisFilePath()

    const remoteSettingsContent = await webdav.downloadFile(remoteSettingsPath)
    if (remoteSettingsContent) {
      const remoteSettingsData = JSON.parse(remoteSettingsContent)
      updateSetting(filterSensitiveSettingsForSync(remoteSettingsData.data))
    } else {
      toast('云端未找到设置文件，跳过设置同步')
    }

    const remoteUserApisContent = await webdav.downloadFile(remoteUserApisPath)
    if (remoteUserApisContent) {
      const remoteApisData = JSON.parse(remoteUserApisContent)
      await overwriteUserApis(remoteApisData.data)
    } else {
      toast('云端未找到自定义音源文件，跳过音源同步')
    }

    toast('下载同步完成！')
  } catch (error: any) {
    webDAVLog.error(`[Manual Download] Failed: ${error.stack ?? error.message}`)
    toast(`下载失败: ${error.message}`, 'long')
  } finally {
    isSyncing = false
  }
}

export async function manualUploadLists() {
  if (isSyncing) {
    toast('正在同步中，请稍后...')
    return
  }
  if (!settingState.setting['sync.webdav.enable'] || !settingState.setting['sync.webdav.url']) {
    toast('请先启用并配置 WebDAV 同步')
    return
  }
  // 【第 34 轮第 1 条】「同步服务地址」正在协商歌单时让行（说明见 waitForListNegotiation）
  if (!await waitForListNegotiation(true)) return

  const confirm = await confirmDialog({
    title: '确认上传歌单',
    message: '这将使用本地的“所有歌单”完全覆盖云端的数据，此操作不可逆，确定要继续吗？',
    confirmButtonText: '上传',
  })
  if (!confirm) return

  // 【第 33 轮第 3 条】同手动上传：标记进 try，杜绝永久卡在「正在同步中」
  try {
    isSyncing = true
    toast('开始上传歌单...')
    const remoteListsPath = getRemoteListsFilePath()
    const { lists } = await getAllDataForSync()
    await uploadLists(remoteListsPath, lists)
    await clearOperationQueue()
    toast('歌单上传成功！')
  } catch (error: any) {
    webDAVLog.error(`[Manual Upload Lists] Failed: ${error.stack ?? error.message}`)
    toast(`上传失败: ${error.message}`, 'long')
  } finally {
    isSyncing = false
  }
}

export async function manualDownloadLists() {
  if (isSyncing) {
    toast('正在同步中，请稍后...')
    return
  }
  if (!settingState.setting['sync.webdav.enable'] || !settingState.setting['sync.webdav.url']) {
    toast('请先启用并配置 WebDAV 同步')
    return
  }
  // 【第 34 轮第 1 条】「同步服务地址」正在协商歌单时让行（说明见 waitForListNegotiation）
  if (!await waitForListNegotiation(true)) return

  const confirm = await confirmDialog({
    title: '确认下载歌单',
    message: '这将使用云端的“所有歌单”完全覆盖本地的数据，此操作不可逆，确定要继续吗？',
    confirmButtonText: '下载',
  })
  if (!confirm) return

  // 【第 33 轮第 3 条】同手动上传：标记进 try，杜绝永久卡在「正在同步中」
  try {
    isSyncing = true
    toast('开始下载歌单...')
    const remoteListsPath = getRemoteListsFilePath()
    const remoteListsContent = await webdav.downloadFile(remoteListsPath)
    if (remoteListsContent) {
      const remoteData = normalizeRemoteListsData(JSON.parse(remoteListsContent))
      await overwriteListFull(remoteData.data)
      await applySyncedExtraData(remoteData)
      await clearOperationQueue()
      updateSetting({ 'sync.webdav.lastSyncTimeLists': remoteData.lastModified })
      toast('歌单下载同步完成！')
    } else {
      toast('云端未找到歌单文件')
    }
  } catch (error: any) {
    webDAVLog.error(`[Manual Download Lists] Failed: ${error.stack ?? error.message}`)
    toast(`下载失败: ${error.message}`, 'long')
  } finally {
    isSyncing = false
  }
}

export async function triggerWebDAVSync(isManual = false) {
  if (isSyncing) {
    if (isManual) toast('正在同步中，请稍后...')
    return
  }
  if (!settingState.setting['sync.webdav.enable'] || !settingState.setting['sync.webdav.url']) {
    if (isManual) toast('请先启用并配置 WebDAV 同步')
    return
  }

  // 【第 34 轮第 1 条】让行闸门放在确认对话框之前：不能先让用户确认「覆盖」再告诉他等一等
  if (!await waitForListNegotiation(isManual)) return

  const remoteListsPath = getRemoteListsFilePath()

  // 【第 33 轮第 3 条】标记进 try：见上方手动上传的说明（永久卡「正在同步中」的成因之一）
  try {
    isSyncing = true
    if (isManual) toast('开始同步歌单...')

    const remoteListsContent = await webdav.downloadFile(remoteListsPath)

    if (remoteListsContent === null) {
      webDAVLog.info('[Sync] Remote lists not found. Uploading local state.')
      const { lists } = await getAllDataForSync()
      await uploadLists(remoteListsPath, lists)
      await clearOperationQueue()
      if (isManual) toast('歌单上传成功！')
    } else {
      const remoteData = normalizeRemoteListsData(JSON.parse(remoteListsContent))
      const remoteTimestamp = remoteData.lastModified
      const localTimestamp = settingState.setting['sync.webdav.lastSyncTimeLists'] ?? 0

      if (localTimestamp === 0) {
        webDAVLog.info('[Sync] First sync detected with existing remote data. Prompting user.')
        const userChoice = await confirmDialog({
          title: '首次同步确认',
          message: '云端已存在歌单数据。由于这是该设备上首次同步，请选择您的操作：\n\n“下载”：将使用云端数据覆盖本地（推荐用于恢复数据）。\n“上传”：将使用本地数据覆盖云端（请务必确认本地数据是您最终想要的版本）。',
          cancelButtonText: '下载云端并覆盖本地',
          confirmButtonText: '上传本地并覆盖云端',
        })

        if (userChoice === true) {
          webDAVLog.info('[Sync] User chose to upload local state during first sync.')
          const { lists: currentLocalLists } = await getAllDataForSync()
          await uploadLists(remoteListsPath, currentLocalLists)
          await clearOperationQueue()
          toast('本地歌单已上传覆盖云端！')
          return
        } else if (userChoice === false) {
          webDAVLog.info('[Sync] User chose to download remote state during first sync.')
          await overwriteListFull(remoteData.data)
          await applySyncedExtraData(remoteData)
          await clearOperationQueue()
          updateSetting({ 'sync.webdav.lastSyncTimeLists': remoteTimestamp })
          toast('已从云端同步歌单数据到本地！')
          return
        } else {
          webDAVLog.info('[Sync] First sync resolution cancelled.')
          if (isManual) toast('同步已取消')
          return
        }
      }

      const hasRemoteUpdate = remoteTimestamp > localTimestamp
      const localOpQueue = getOperationQueue()
      const hasLocalChanges = localOpQueue.length > 0 || listsChanged || await hasLocalExtraDataChanges(remoteData)

      if (hasRemoteUpdate) {
        webDAVLog.info('[Sync] Remote is newer. Starting merge process.')
        let mergedData = remoteData.data
        let conflictOccurred = false

        if (hasLocalChanges) {
          nextListsUploadExtraData = await getMergedExtraData(remoteData)
          webDAVLog.info(`[Sync] Applying ${localOpQueue.length} local operations onto remote data.`)
          try {
            for (const op of localOpQueue) {
              mergedData = await applyListOperation(mergedData, op)
            }
          } catch (error: any) {
            conflictOccurred = true
            webDAVLog.error('[Sync] A true conflict occurred during operation merge:', error.message)
          }
        }

        if (conflictOccurred) {
          nextListsUploadExtraData = null
          const userChoice = await confirmDialog({
            title: '同步冲突',
            message: '云端和本地的歌单修改无法自动合并。请选择要保留的版本：\n\n为防止意外，建议在操作前先备份当前歌单。',
            cancelButtonText: '云端覆盖本地',
            confirmButtonText: '本地覆盖云端',
          })
          if (userChoice === true) {
            webDAVLog.info('[Sync] Conflict resolved by user: Force pushing local state.')
            const { lists: currentLocalLists } = await getAllDataForSync()
            await uploadLists(remoteListsPath, currentLocalLists)
            await clearOperationQueue()
            toast('已强制使用本地歌单覆盖云端！')
          } else if (userChoice === false) {
            webDAVLog.info('[Sync] Conflict resolved by user: Force pulling remote state.')
            await overwriteListFull(remoteData.data)
            await applySyncedExtraData(remoteData)
            await clearOperationQueue()
            updateSetting({ 'sync.webdav.lastSyncTimeLists': remoteTimestamp })
            toast('已从云端同步歌单，本地更改已放弃！')
          } else {
            webDAVLog.info('[Sync] Conflict resolution cancelled by user.')
            toast('操作已取消')
          }
        } else {
          webDAVLog.info('[Sync] Merge successful or only remote changes detected.')
          await overwriteListFull(mergedData)
          if (hasLocalChanges) {
            await uploadLists(remoteListsPath, mergedData)
            await applyMergedExtraData(remoteData)
            if (isManual) toast('歌单合并同步成功！')
          } else {
            await applySyncedExtraData(remoteData)
            updateSetting({ 'sync.webdav.lastSyncTimeLists': remoteTimestamp })
            if (isManual) toast('歌单已从云端同步！')
          }
          await clearOperationQueue()
        }
      } else if (hasLocalChanges) {
        webDAVLog.info('[Sync] Local has unsynced changes. Uploading.')
        const { lists: currentLocalLists } = await getAllDataForSync()
        await uploadLists(remoteListsPath, currentLocalLists)
        await clearOperationQueue()
        if (isManual) toast('本地歌单已上传！')
      } else if (isManual) {
        webDAVLog.info('[Sync] Lists are up to date.')
        toast('歌单已是最新，无需同步')
      }
    }
  } catch (error: any) {
    webDAVLog.error(`[Sync] Sync failed: ${error.stack ?? error.message}`)
    toast(`同步失败: ${error.message}`, 'long')
  } finally {
    isSyncing = false
  }
}
