import settingState from '@/store/setting/state'
import { webDAVLog } from '@/core/webdavMusic/logger'

import { createClient, type FileStat } from 'webdav'

let client: any = null

function getClient() {
  if (client) return client

  const settings = settingState.setting
  const url = settings['sync.webdav.url']
  const username = settings['sync.webdav.username']
  const password = settings['sync.webdav.password']

  if (!url || !username) {
    webDAVLog.warn('WebDAV 未配置: URL 或用户名为空')
    return null
  }

  // createClient imported at top
  client = createClient(url, { username, password })
  return client
}

/**
 * When WebDAV configuration changes, call this function to reset the client instance.
 */
export function resetClient() {
  client = null
}

/** 给一个 Promise 套超时：到点就 reject（原 Promise 的后续 settle 被忽略）。 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, ms)
    p.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * 测试连接（第 33 轮第 3 条：用户原话「点击测试连接后没有任何提示连接成功或者失败文字」）。
 *
 * 以前这里只有一个裸的 `getDirectoryContents('/')`：
 *   ① **没有超时** —— 服务器 TCP 连得上但不回包（半死 / 被中间设备静默丢包）时这个 Promise
 *      永不 settle，「测试连接」按钮就永远停在「测试中...」并保持禁用，用户看不到任何结果；
 *   ② 探的是根目录 `/`，而用户真正要用的是「同步路径」—— 服务器只开放子目录（根不可列）时
 *      会被误判成「连接失败」，反过来根可列但同步路径没权限时又会误判成成功。
 *
 * 现在：探「同步路径」（没填就探根），带超时；404/409（路径不存在）不算失败 —— 那恰恰说明
 * 服务器和账号都是通的，只是目录还没建（首次同步会自动建）。结果同步写进 WebDAV 日志，
 * 界面提示由调用方 toast。
 */
export async function testConnection(timeoutMs = 15000): Promise<boolean> {
  const cli = await getClient()
  if (!cli) throw new Error('WebDAV 未配置')

  const rawPath = settingState.setting['sync.webdav.path'] || '/'
  const cleanPath = '/' + rawPath.replace(/^\/|\/$/g, '')
  const probePath = cleanPath === '/' ? '/' : cleanPath + '/'

  webDAVLog.info(`[Test] 探测 ${probePath} ...`)
  try {
    await withTimeout(
      cli.getDirectoryContents(probePath) as Promise<unknown>,
      timeoutMs,
      `连接超时（${Math.round(timeoutMs / 1000)} 秒内服务器没有响应）`,
    )
    webDAVLog.info(`[Test] 成功：${probePath} 可访问`)
    return true
  } catch (error: any) {
    if ((error?.status === 404 || error?.status === 409) && probePath !== '/') {
      webDAVLog.info(`[Test] ${probePath} 尚不存在，但服务器可达（首次同步会自动创建该目录）`)
      return true
    }
    webDAVLog.error(`[Test] 失败：${error?.stack ?? error?.message ?? error}`)
    throw error
  }
}

/**
 * Create directories step by step, compatible with servers that do not support recursive creation.
 * @param cli WebDAV client instance
 * @param dirPath directory path to create
 */
async function ensureDirectoryExists(cli: any, dirPath: string): Promise<void> {
  if (!dirPath || dirPath === '/') return

  const segments = dirPath.split('/').filter(Boolean)
  let currentPath = ''

  for (const segment of segments) {
    currentPath += `/${segment}`
    try {
      if (!(await cli.exists(currentPath))) {
        webDAVLog.info(`Directory ${currentPath} not found, creating it...`)
        await cli.createDirectory(currentPath)
      }
    } catch (error: any) {
      throw new Error(`创建目录 ${currentPath} 失败: ${error.message}`)
    }
  }
}

/**
 * Upload file, automatically create parent directories if they do not exist.
 * @param path full file path, e.g., /LX_Music/playlists.json
 * @param content file content
 */
export async function uploadFile(path: string, content: string): Promise<void> {
  const cli = await getClient()
  if (!cli) throw new Error('WebDAV 未配置')

  // 1. 提取目录路径
  const dirPath = path.substring(0, path.lastIndexOf('/'))

  // 2. 确保目录存在
  await ensureDirectoryExists(cli, dirPath)

  // 3. 上传文件
  webDAVLog.info(`All directories exist. Uploading file to ${path}...`)
  await cli.putFileContents(path, content, { overwrite: true })
}

/**
 * Download file, return null if file does not exist.
 * @param path full file path
 */
export async function downloadFile(path: string): Promise<string | null> {
  const cli = await getClient()
  if (!cli) throw new Error('WebDAV 未配置')
  try {
    webDAVLog.info(`Attempting to download file: ${path}`)
    return await cli.getFileContents(path, { format: 'text' })
  } catch (error: any) {
    if (error.status === 404 || error.status === 409) {
      // 【第 28 轮】原话是 "downloadFile: File not found on server: xxx"，用户直接把它读成了
      // 「歌曲下载失败」——其实这里是**歌单同步**在探远端有没有 playlists.json，
      // 首次同步远端当然没有，属正常流程（紧接着就会上传本地状态）。日志得自己说清楚，
      // 不然每次同步都在日志里刷一行看着像报错的东西。歌曲下载走的是另一条链路
      // （core/webdavMusic/drive.ts 的 downloadWebDAVFile）。
      webDAVLog.info(`[Sync] remote lists file not found (normal on first sync; songs are downloaded via the music module): ${path}`)
      return null
    }
    webDAVLog.error(`downloadFile: Unexpected error for "${path}":`, error)
    throw error
  }
}

/**
 * Get file status, return null if file does not exist.
 * @param path full file path
 */
export async function getStat(path: string): Promise<any | null> {
  const cli = await getClient()
  if (!cli) throw new Error('WebDAV 未配置')
  try {
    return await cli.stat(path) as Promise<FileStat>
  } catch (error: any) {
    if (error.status === 404 || error.status === 409) {
      webDAVLog.info(`getStat: File or path not found for "${path}", returning null.`)
      return null
    }
    webDAVLog.error(`getStat: Unexpected error for "${path}":`, error)
    throw error
  }
}
