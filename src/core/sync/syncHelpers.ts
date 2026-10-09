import { getListMusics } from '@/core/list'
import listState from '@/store/list/state'
import settingState from '@/store/setting/state'
import { LIST_IDS } from '@/config/constant'
import { getPlayHistory, getUserApiList, getUserApiScript, getSyncHost } from '@/utils/data.ts'
import { normalizeDownloadTasksForSync } from '@/utils/data/download'
import downloadState from '@/store/download/state'

/**
 * 上传 / 下载设置时被剔除的键。
 *
 * 【第 39 轮第 3 条】`common.wy_cookie`（网易云音乐 Cookie，设置 → 平台设置）**从这里移除**：
 * 用户原话「WebDAV同步上传设置与音源时，未将平台设置中的网易云音乐cookie进行同步……
 * 优化同步内容，使其齐全」。以前它被当成敏感键在两条方向上都删掉，结果是：新设备从云端
 * 「下载设置与音源」后仍要手动重新粘贴一遍网易云 Cookie，歌单/日推/红心这些依赖登录态的
 * 功能在同步完之后是坏的。
 *
 * 仍保留过滤的两个键：`common.wy_serpapi_key` 是第三方接口密钥、`sync.webdav.password`
 * 是 WebDAV 口令本身（把口令同步到口令本来就能读的文件里没有意义，且会让「下载设置」
 * 把本机凭据覆盖成云端旧口令）。
 * 注意：`common.yt_cookie` 也继续过滤（该键在设置界面里没有任何入口，属历史遗留键）。
 */
const SENSITIVE_SETTING_KEYS: Array<keyof LX.AppSetting> = [
  'common.wy_serpapi_key',
  'common.yt_cookie',
  'sync.webdav.password',
]

export const filterSensitiveSettingsForSync = (settings: Partial<LX.AppSetting>) => {
  const nextSettings = { ...settings }
  for (const key of SENSITIVE_SETTING_KEYS) {
    delete nextSettings[key]
  }
  return nextSettings
}

export const getAllDataForSync = async() => {
  const defaultList = await getListMusics(listState.defaultList.id)
  const loveList = await getListMusics(listState.loveList.id)
  const tempList = await getListMusics(LIST_IDS.TEMP)
  const userList = []
  for await (const list of listState.userList) {
    userList.push({ ...list, list: await getListMusics(list.id) })
  }
  const lists = { defaultList, loveList, userList, tempList }
  const playHistory = await getPlayHistory()
  const downloadTasks = normalizeDownloadTasksForSync(downloadState.tasks)
  const settings = filterSensitiveSettingsForSync(settingState.setting)

  const userApiList = await getUserApiList()
  const userApiScripts: Record<string, string> = {}
  for (const api of userApiList) {
    userApiScripts[api.id] = await getUserApiScript(api.id)
  }
  const userApis = {
    list: userApiList,
    scripts: userApiScripts,
  }

  // 【第 39 轮第 3 条】「同步服务地址」不在 settings 快照里 —— 它存在存储数据
  // （@sync_host，见 config/constant.ts 的 storageDataPrefix.syncHost 与 utils/data.ts 的
  // getSyncHost/setSyncHost），所以「上传设置与音源」以前压根带不上它（用户原话：
  // 「也未将同步服务地址进行同步，优化同步内容，使其齐全」）。这里单独取出来随快照一起返回，
  // 由 webdavSync.ts 写进 settings.json、并在下载时写回本机。
  const syncHost = await getSyncHost()

  return { lists, playHistory, downloadTasks, settings, userApis, syncHost }
}
