import { getData, saveData } from '@/plugins/storage'
import { createClient, type FileStat } from 'webdav'
import settingState from '@/store/setting/state'
import { webDAVLog } from './logger'
import { btoa } from 'react-native-quick-base64'
import { downloadFile, existsFile, mkdir, stat, unlink, temporaryDirectoryPath } from '@/utils/fs'
import { enforceCacheLimit } from '@/utils/nativeModules/cache'
import { stringMd5 } from 'react-native-quick-md5'

const CONFIG_KEY = '@webdav_music_config'
const audioExts = new Set([
  'mp3',
  'flac',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'wma',
  'ape',
])

// 网盘内可作为封面的图片扩展名 + 目录级通用封面文件名
const picExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])
const genericPicNames = new Set(['cover', 'folder', 'front', 'album', 'back', 'poster', 'thumb'])

async function getClient() {
  const settings = settingState.setting
  const url = settings['sync.webdav.url']
  const username = settings['sync.webdav.username']
  const password = settings['sync.webdav.password']

  if (!url || !username) {
    webDAVLog.error('WebDAV 未配置')
    throw new Error('WebDAV 未配置')
  }

  // createClient imported at top
  return createClient(url, { username, password })
}

const normalizePath = (path: string | undefined, name: string) => {
  return path ? `${path}/${name}` : `/${name}`
}

const getExt = (name: string) => {
  const ext = name.split('.').pop()
  return ext && ext != name ? ext.toLowerCase() : ''
}

const getBaseName = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

const parseFileName = (fileName: string) => {
  const dotIndex = fileName.lastIndexOf('.')
  const rawName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  if (!rawName.includes('-')) return { name: rawName.trim(), singer: '' }
  const [left, ...rest] = rawName.split('-')
  return {
    name: left.trim(),
    singer: rest.join('-').trim(),
  }
}

export const getWebDAVConfig = async(): Promise<LX.WebDAV.Config> => {
  const config = (await getData<LX.WebDAV.Config>(CONFIG_KEY)) ?? {
    selectedFolder: null,
    songs: [],
    filterPath: null,
  }
  config.songs = (config.songs ?? []).map(normalizeWebDAVMusicInfo)
  return config
}

export const saveWebDAVFilterPath = async(filterPath: string | null) => {
  const config = await getWebDAVConfig()
  config.filterPath = filterPath
  await saveWebDAVConfig(config)
  return config
}

export const saveWebDAVConfig = async(config: LX.WebDAV.Config) => {
  await saveData(CONFIG_KEY, config)
}

export const listWebDAVFolders = async(folder?: LX.WebDAV.DriveFolder | null) => {
  const client = await getClient()
  const basePath = folder?.path ?? '/'

  let contents: Array<any & { type: string }>
  try {
    contents = await client.getDirectoryContents(basePath) as Array<any & { type: string }>
  } catch (error: any) {
    webDAVLog.error('listWebDAVFolders error', { error, status: error.status })
    if (error.status === 404 || error.status === 409) {
      return []
    }
    throw error
  }

  return contents
    .filter(item => item.type === 'directory')
    .sort((a, b) => a.basename.localeCompare(b.basename))
    .map<LX.WebDAV.DriveFolder>(item => ({
    id: item.filename,
    name: item.basename,
    parentId: folder?.id,
    path: normalizePath(folder?.path, item.basename),
  }))
}

export const saveWebDAVSelectedFolder = async(folder: LX.WebDAV.DriveFolder | null) => {
  const config = await getWebDAVConfig()
  config.selectedFolder = folder
  await saveWebDAVConfig(config)
  return config
}

const toMusicInfo = (item: FileStat, path: string): LX.WebDAV.MusicInfo => {
  const ext = getExt(item.basename)
  const title = parseFileName(item.basename)
  const modifiedTime = item.lastmod ? new Date(item.lastmod).getTime() : 0
  return {
    id: `webdav_${item.filename}`,
    name: title.name,
    singer: title.singer,
    source: 'local',
    interval: null,
    meta: {
      webdav: true,
      fileName: item.basename,
      filePath: path,
      remotePath: path,
      ext,
      size: item.size,
      lastModifiedTime: modifiedTime,
      songId: path,
      albumName: '',
    },
  }
}

export const normalizeWebDAVMusicInfo = (musicInfo: LX.WebDAV.MusicInfo) => {
  const title = parseFileName(musicInfo.meta.fileName || musicInfo.name)
  musicInfo.name = title.name
  musicInfo.singer = title.singer
  // 清掉历史脏封面值（getWebDAVConfig 读盘时就会走到这里，等于给已落盘的坏数据做一次读时修复）：
  // 类型上 meta.picUrl 是 string|null，但历史上写入过非字符串 —— 音源 SDK getPic 没解包就返回的
  // 请求对象被当 URL 存了进来，JSON 落盘后是 {"picUrl":{"promise":{}}}，读回来是个普通对象。
  // 它一旦流到列表行 <Image url={...}>，Image.tsx 的 `url.startsWith` 就是 undefined 再被调用
  // ⇒ 渲染期致命错误「undefined is not a function」。这里当成"没有封面"（空串），
  // 让封面链路重新去取（详见 core/music/utils.ts resolvePicUrl 注释）。
  if (musicInfo.meta.picUrl !== undefined && musicInfo.meta.picUrl !== null && typeof musicInfo.meta.picUrl !== 'string') {
    musicInfo.meta.picUrl = ''
  }
  return musicInfo
}

const scanFolder = async(
  folder: LX.WebDAV.DriveFolder | null,
  onProgress?: (count: number, folderPath: string) => void,
) => {
  const client = await getClient()
  const result: LX.WebDAV.MusicInfo[] = []
  const basePath = folder?.path ?? '/'

  let contents: Array<any & { type: string }>
  try {
    contents = await client.getDirectoryContents(basePath) as Array<any & { type: string }>
  } catch (error: any) {
    webDAVLog.error('scanFolder error', { error, status: error.status })
    if (error.status === 404 || error.status === 409) {
      return result
    }
    throw error
  }

  // 第一遍：收集当前目录的图片与歌词文件，供同名/通用封面匹配
  const picMap = new Map<string, string>()
  const lrcMap = new Map<string, string>()
  let genericPic = ''
  for (const item of contents) {
    if (item.type !== 'file') continue
    const ext = getExt(item.basename)
    const path = normalizePath(folder?.path, item.basename)
    const base = getBaseName(item.basename).toLowerCase()
    if (ext === 'lrc') {
      lrcMap.set(base, path)
    } else if (picExts.has(ext)) {
      picMap.set(base, path)
      if (genericPicNames.has(base)) genericPic = path
    }
  }

  // 第二遍：处理子目录与音频
  for (const item of contents) {
    const path = normalizePath(folder?.path, item.basename)
    if (item.type === 'directory') {
      try {
        result.push(
          ...(await scanFolder(
            { id: item.filename, name: item.basename, parentId: folder?.id, path },
            onProgress,
          )),
        )
      } catch (error: any) {
        webDAVLog.error('scanFolder recursive error', { path, error, status: error.status })
        // Skip folders that return 403 or other errors
      }
      onProgress?.(result.length, path)
      continue
    }
    if (item.type !== 'file') continue
    const ext = getExt(item.basename)
    if (!audioExts.has(ext)) continue
    const musicInfo = toMusicInfo(item, path)
    // 网盘内封面/歌词：优先同目录同名，其次目录通用封面
    const audioBase = getBaseName(item.basename).toLowerCase()
    const picPath = picMap.get(audioBase) ?? genericPic
    const lrcPath = lrcMap.get(audioBase)
    if (picPath) musicInfo.meta.picPath = picPath
    if (lrcPath) musicInfo.meta.lrcPath = lrcPath
    result.push(musicInfo)
  }
  return result
}

export const scanWebDAVSongs = async(
  folder: LX.WebDAV.DriveFolder | null,
  onProgress?: (count: number, folderPath: string) => void,
) => {
  const songs = await scanFolder(folder, onProgress)
  songs.sort((a, b) => b.meta.lastModifiedTime - a.meta.lastModifiedTime)

  const config = await getWebDAVConfig()
  const existingSongsMap = new Map<string, LX.WebDAV.MusicInfo>()
  for (const song of config.songs ?? []) {
    existingSongsMap.set(song.id, song)
  }

  const mergedSongs = songs.map(newSong => {
    const existing = existingSongsMap.get(newSong.id)
    if (existing) Object.assign(newSong.meta, existing.meta)
    return newSong
  })

  config.selectedFolder = folder
  config.songs = mergedSongs
  config.scannedAt = Date.now()
  await saveWebDAVConfig(config)
  return config
}

// WebDAV 直链播放/下载的认证 headers：服务器通常需 Basic 认证
export const getWebDAVAuthHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Mobile Safari/537.36',
  }
  const username = settingState.setting['sync.webdav.username']
  const password = settingState.setting['sync.webdav.password']
  if (username && password) {
    headers.Authorization = 'Basic ' + btoa(`${username}:${password}`)
  }
  return headers
}

/**
 * 【第 28 轮】本地文件到底是「没有」「半截」还是「完整」。
 *
 * 第 28 轮之前的判断一律是 existsFile —— 而 RNFS 的 downloadFile 是**直接写目标路径**的
 * （不写临时文件再改名），下载中断、被取消、断网都会在原地留一个半截文件。
 * 于是「路径上有东西」在四个地方都被当成「已下完」：
 *   ① 播放：用户的已下载文件（local.ts getMusicUrl）
 *   ② 播放：私有缓存里的那份（本文件 downloadWebDAVMusic）
 *   ③ 菜单「下载」 ④ 扫描并下载（WebDAVListAction）
 * 表现就是「点了没反应 / 播一下就停 / 再怎么点都不重新下」。这里统一成一处判断：
 * 用 PROPFIND 报的 meta.size 校验实际字节数（留 1% 容差，避免服务端字节数与目录大小
 * 差几十字节就来回重下）；拿不到期望大小就退回旧的「存在即完整」行为，不做更坏的假设。
 */
export type WebDAVFileState = 'missing' | 'incomplete' | 'complete'

export const getWebDAVFileState = async(
  filePath: string,
  expectedSize?: number,
): Promise<WebDAVFileState> => {
  if (!await existsFile(filePath).catch(() => false)) return 'missing'
  if (!expectedSize || expectedSize <= 0) return 'complete'
  const info = await stat(filePath).catch(() => null)
  if (!info || !info.isFile) return 'complete'
  return info.size >= expectedSize * 0.99 ? 'complete' : 'incomplete'
}

// 播放/封面缓存目录（Caches，可被系统清理，不参与 iCloud 备份）。
// 注意与 getWebDAVPrivateDirectory（用户手动下载目录，位于 Documents）区分：
// 这里是流式播放自动预下载的临时缓存，可被系统回收；用户手动下载的文件要保留。
const getWebDAVCacheDirectory = () => `${temporaryDirectoryPath}/WebDAV`

// 由远程路径构造 WebDAV 直链 URL（保留 / 分隔，仅对每段编码）
const getWebDAVRemoteUrl = (remoteFilePath: string): string => {
  const url = settingState.setting['sync.webdav.url']
  if (!url) {
    webDAVLog.error('getWebDAVRemoteUrl: WebDAV 未配置')
    throw new Error('WebDAV 未配置')
  }

  let remote = String(remoteFilePath || '')
  // 【第 26 轮】remotePath 本身已经是完整 URL 时直接使用（有的服务器的直链就是这样存进 meta 的），
  // 再拼 baseUrl 会变成 https://host/dav/https://host/… 这种必然 404 的地址。
  if (/^https?:\/\//i.test(remote)) return remote
  if (!remote.startsWith('/')) remote = '/' + remote

  if (
    remote.includes('/storage/emulated/') ||
    remote.includes('/sdcard/') ||
    remote.includes('/storage/self/')
  ) {
    webDAVLog.warn('getWebDAVRemoteUrl: detected local path in remoteFilePath', { remoteFilePath: remote })
  }

  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url
  // 逐段编码：encodeURIComponent 会把路径分隔符 / 编成 %2F，
  // 整体编码后 URL 变成 "音乐%2F歌曲.mp3"，大多数 WebDAV 服务器
  // （坚果云/Alist/Nextcloud）会 404。正确做法是保留 / 分隔，
  // 只对每一段中的空格、中文、# 等特殊字符编码。
  const encodedFilePath = remote
    .substring(1)
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return `${baseUrl}/${encodedFilePath}`
}

export const getWebDAVDownloadUrl = (musicInfo: LX.WebDAV.MusicInfo) => {
  let remoteFilePath = String(musicInfo.meta.remotePath || musicInfo.meta.songId || musicInfo.meta.filePath)

  if (remoteFilePath.includes('/storage/emulated/') || remoteFilePath.includes('/sdcard/') || remoteFilePath.includes('/storage/self/')) {
    webDAVLog.warn('getWebDAVDownloadUrl: detected local path in remoteFilePath, using songId instead', { remoteFilePath, songId: musicInfo.meta.songId })
    remoteFilePath = String(musicInfo.meta.songId || musicInfo.meta.filePath)
  }

  return getWebDAVRemoteUrl(remoteFilePath)
}

export interface WebDAVMusicMetaUpdate {
  picUrl?: string
  filePath?: string | null
}

export const updateWebDAVMusicMeta = async(musicId: string, update: WebDAVMusicMetaUpdate): Promise<void> => {
  const config = await getWebDAVConfig()
  const songIndex = config.songs.findIndex(song => song.id === musicId)
  if (songIndex === -1) {
    return
  }

  const song = config.songs[songIndex]
  if (update.picUrl !== undefined) {
    // 只落字符串：调用方若把「上游没解包的请求对象」当 URL 传进来（历史 bug 的入口），
    // 落盘会变成 {"picUrl":{"promise":{}}}，下次进列表读回来就是脏 meta.picUrl，
    // 一路流到 <Image url> 触发渲染期致命错误（详见 core/music/utils.ts resolvePicUrl 注释）。
    // 非字符串直接忽略：宁可这首歌这次不写封面，也不把坏数据固化进配置。
    if (typeof update.picUrl === 'string') song.meta.picUrl = update.picUrl
  }
  // filePath 允许显式清空（传 null 或 ''）：文件被本地删除后需要清掉旧路径，
  // 否则播放链路会一直误判"已下载"而尝试读取不存在的文件。
  if (update.filePath !== undefined) {
    song.meta.filePath = update.filePath || ''
  }

  config.songs[songIndex] = song
  await saveWebDAVConfig(config)
}

// 拉取网盘内封面图片：下载到本地缓存目录，返回 file:// 本地路径
// （FastImage 固定 defaultHeaders，无法注入 Basic Auth，需先下载到本地）
export const fetchWebDAVPic = async(musicInfo: LX.WebDAV.MusicInfo): Promise<string | null> => {
  const picPath = musicInfo.meta.picPath
  if (!picPath) return null
  try {
    const url = getWebDAVRemoteUrl(picPath)
    const coversDir = `${getWebDAVCacheDirectory()}/covers`
    const ext = picPath.split('.').pop()?.toLowerCase() || 'jpg'
    // 同音频缓存：用 md5 避免 encodeURIComponent 与 downloadFile 内部 decodeURIComponent 冲突
    const localPath = `${coversDir}/${stringMd5(picPath)}.${ext}`
    if (await existsFile(localPath)) return `file://${localPath}`
    await mkdir(coversDir)
    // 【第 26 轮】走统一下载阶梯（直下 → 解析 302 直链 → 抛错），失败不留半截文件
    await downloadWebDAVFile(url, localPath, { headers: getWebDAVAuthHeaders() })
    return `file://${localPath}`
  } catch (err) {
    webDAVLog.warn('fetchWebDAVPic: failed', { err })
    return null
  }
}

// 拉取网盘内同名 .lrc 歌词文本（通过直链 + Basic Auth）
export const fetchWebDAVLrc = async(musicInfo: LX.WebDAV.MusicInfo): Promise<string | null> => {
  const lrcPath = musicInfo.meta.lrcPath
  if (!lrcPath) return null
  try {
    const url = getWebDAVRemoteUrl(lrcPath)
    const response = await fetch(url, { headers: getWebDAVAuthHeaders() })
    if (!response.ok) return null
    const text = await response.text()
    return text?.trim() ? text : null
  } catch (err) {
    webDAVLog.warn('fetchWebDAVLrc: failed', { err })
    return null
  }
}

/**
 * 【第 26 轮】直链解析：把「WebDAV 地址」换成服务端 302 之后真正提供字节的地址。
 *
 * 用户的服务器如果是「连接返回 302 直链」的配置，NSURLSession 一般会自动跟随；但
 * ① 跨主机跳转时 Authorization 会被系统丢掉，跳转目标若要鉴权就 401；
 * ② 直链常带查询串/签名，RNFS 与 fetch 对编码的处理不完全一致。
 * 所以这里显式解析一次，**只在直下失败后调用**（正常路径不增加往返），拿到就再下一次。
 *
 * 先 HEAD（省流量），不支持 HEAD（405/501）时退到 GET + Range: bytes=0-0。
 * 拿不到（没跳转 / 报错）返回 ''，由调用方决定兜底。
 */
export const resolveWebDAVDirectUrl = async(
  url: string,
  headers?: Record<string, string>,
): Promise<string> => {
  const reqHeaders = headers ?? getWebDAVAuthHeaders()
  try {
    // RN 的 fetch 自动跟随重定向，response.url 是**最终**地址
    const response = await fetch(url, { method: 'HEAD', headers: reqHeaders })
    if (response.url && response.url !== url) return response.url
  } catch (err) {
    webDAVLog.warn('resolveWebDAVDirectUrl: HEAD failed', { err })
  }
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { ...reqHeaders, Range: 'bytes=0-0' },
    })
    if (response.url && response.url !== url) return response.url
  } catch (err) {
    webDAVLog.warn('resolveWebDAVDirectUrl: GET failed', { err })
  }
  return ''
}

/**
 * 【第 26 轮】统一的「从 WebDAV 取一份文件到本地」入口（播放预下载 / 封面 / 手动下载共用）。
 *
 * 三级阶梯，任一级成功即返回，全失败才抛：
 *   ① 直接用 WebDAV 地址下载（NSURLSession 自动跟随 302，显式带 Basic Auth）
 *   ② 显式解析出 302 之后的直链，再下一次（「连接换直链」型服务器）
 *   ③ 抛错 —— 由调用方兜底（下载管理会退到「复制播放缓存里的那份副本」）
 *
 * onTask 把底层下载句柄交回调用方，保证「取消下载」仍然有效。
 */
export const downloadWebDAVFile = async(
  url: string,
  localPath: string,
  options: Parameters<typeof downloadFile>[2] = {},
  onTask?: (task: any) => void,
): Promise<string> => {
  const headers = options.headers ?? getWebDAVAuthHeaders()
  let lastError: any = null

  // 每次尝试先删掉目标文件：上一次失败可能留下半截文件，而调用方是用 existsFile
  // 判断「是否已下载」的 —— 留半截等于把坏文件当成完整音频/封面向外返回。
  const attempt = async(target: string) => {
    await unlink(localPath).catch(() => {})
    const task = downloadFile(target, localPath, { ...options, headers })
    onTask?.(task)
    await task.promise
  }

  try {
    await attempt(url)
    return url
  } catch (err) {
    lastError = err
    webDAVLog.warn('downloadWebDAVFile: direct download failed, try resolving redirect', { url, err })
  }

  const directUrl = await resolveWebDAVDirectUrl(url, headers)
  if (directUrl) {
    try {
      await attempt(directUrl)
      webDAVLog.info('downloadWebDAVFile: downloaded via resolved direct url')
      return directUrl
    } catch (err) {
      lastError = err
      webDAVLog.warn('downloadWebDAVFile: resolved direct url download failed', { err })
    }
  }

  await unlink(localPath).catch(() => {})
  throw lastError ?? new Error('WebDAV download failed')
}

// 整文件预下载 WebDAV 音频到本地私有缓存目录，返回本地绝对路径。
// iOS 的 AVPlayer 无法可靠注入 Authorization/User-Agent 头，
// 直链流式播放不稳定，改为用 downloadFile（NSURLSession，能正确携带 Basic Auth）
// 先下载到私有缓存，再播放本地文件。
export const downloadWebDAVMusic = async(musicInfo: LX.WebDAV.MusicInfo): Promise<string> => {
  const remotePath = String(musicInfo.meta.remotePath || musicInfo.meta.songId || musicInfo.meta.filePath)
  const cacheDir = `${getWebDAVCacheDirectory()}/music`
  const ext = musicInfo.meta.ext || getExt(musicInfo.meta.fileName || remotePath)
  // 缓存文件名用 remotePath 的 md5：downloadFile 内部 normalizePath 会 decodeURIComponent，
  // 若用 encodeURIComponent(remotePath) 生成文件名，下载实际写入的是“解码后”路径，而返回给
  // 播放器的是“编码后”路径，两者不一致导致播放器找不到文件、无法播放。
  const filePath = `${cacheDir}/${stringMd5(remotePath)}.${ext}`

  // 【第 28 轮】半截缓存文件不能算「已缓存」：只 existsFile 的话，上次中断留下的半个 flac
  // 会被当成缓存命中直接返回给播放器 —— 表现就是「点了没反应/播一下就停」。
  // 另外缓存命中要单独打一行日志：调用方那行「downloaded to local for playback」在
  // 命中缓存时也会照打（它只关心拿到本地路径），光看日志分不出这次到底下没下。
  const cacheState = await getWebDAVFileState(filePath, musicInfo.meta.size)
  if (cacheState === 'complete') {
    webDAVLog.info('downloadWebDAVMusic: cache hit', { filePath })
    return filePath
  }
  if (cacheState === 'incomplete') {
    webDAVLog.warn('downloadWebDAVMusic: incomplete cache file removed, re-downloading', { filePath })
    await unlink(filePath).catch(() => {})
  }

  await mkdir(cacheDir)
  const downloadUrl = getWebDAVDownloadUrl(musicInfo)
  // 【第 26 轮】走统一下载阶梯（直下 → 解析 302 直链 → 抛错）。
  // 「连接换直链」型服务器通常在这里第一次就成功；需要跟随 302 的由第二级兜。
  // （【第 28 轮】注释里原本写着用户自报的那台服务器域名，已删掉：交付物与源码里不落用户的
  //   WebDAV 地址 / 账号信息，只保留现象级描述。）
  await downloadWebDAVFile(downloadUrl, filePath, { headers: getWebDAVAuthHeaders() })

  // 下载完成后按上限对全部应用缓存做 LRU 清理，避免缓存无限累积
  // （不仅清 WebDAV 子目录，让 getAppCacheSize 显示的总大小也收敛到上限内）
  void enforceCacheLimit((settingState.setting['player.cacheLimit'] || 0) * 1024 * 1024)

  return filePath
}
