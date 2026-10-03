/**
 * rn-fetch-blob 兼容 shim（iOS 适配）
 *
 * 安卓分支直接依赖 npm 包 `rn-fetch-blob`，但 iOS 工程未安装该原生包。
 * 为让代码在 iOS 上编译通过并保留下载/保存封面等能力，这里用已安装的
 * `react-native-fs` 实现一个最小兼容层，仅覆盖本项目实际调用的接口：
 *   - RNFetchBlob.fs.dirs.{MusicDir, PictureDir, DownloadDir, CacheDir, DocumentDir}
 *   - RNFetchBlob.fs.{exists, mkdir, mv, unlink, scanFile}
 *   - RNFetchBlob.config({ path, headers }).fetch('GET', url)
 *
 * 注意：scanFile 在 iOS 上无对应能力，这里作为空操作（no-op）以保证调用不报错。
 *
 * 【第 21 轮·优化 2（2026-10-03）】`fetch` 以前是**占位实现**：直接 resolve 一个
 * path()/base64() 都返回空的壳，压根没有网络请求。调用方 await 完它以为下载好了，
 * 实际磁盘上什么都没有 —— 用户报的「长按封面点『下载封面』无效」就是它
 *（弹了「正在下载封面…」，然后既没有文件、也不报错，因为一切都「成功」了）。
 * 现在按真实语义实现：http(s) 走 @/utils/fs 的 downloadFile（默认 UA + 250ms 进度限流），
 * file:// 走 copyFile，落盘前先删同目标文件，支持调用方自定义 headers。
 */
import {
  DocumentDirectoryPath,
  PicturesDirectoryPath,
  DownloadDirectoryPath,
  CachesDirectoryPath,
  exists as fsExists,
  mkdir as fsMkdir,
  moveFile,
  unlink as fsUnlink,
} from 'react-native-fs'
import { copyFile, downloadFile, existsFile, readFile, unlink } from '@/utils/fs'

interface FetchResult {
  path: () => string
  base64: () => Promise<string>
}

export interface FetchHeaders {
  [name: string]: string | number | undefined
}

export interface FetchConfigOptions {
  /** 落盘路径。本项目所有调用点都显式传（rn-fetch-blob 不传时落临时目录的行为未实现） */
  path?: string
  /** 默认请求头；fetch 的第三个参数可以再按次覆盖 */
  headers?: FetchHeaders | Array<{ name: string, value: string }>
}

// fs.ios.ts 的 downloadFile 只在「调用方没传 headers」时才补默认 UA；本 shim 要把调用方的
// headers 透传下去，就会把默认 UA 顶掉 —— 部分音源封面 CDN 对无 UA 请求直接返 403。
// 这里补同一份 UA：两处字面量必须逐字一致（scripts/sim-cover-download.js 会比对），
// 改 fs.ios.ts 的默认值时要同步这里。
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile'

const normalizeHeaders = (
  headers?: FetchHeaders | Array<{ name: string, value: string }> | null,
): Record<string, string> | null => {
  if (!headers) return null
  const result: Record<string, string> = {}
  if (Array.isArray(headers)) {
    // rn-fetch-blob 的数组写法：[{ name: 'Referer', value: '...' }]
    for (const item of headers) {
      if (!item || typeof item.name != 'string' || item.value == null) continue
      result[item.name] = String(item.value)
    }
  } else {
    for (const [name, value] of Object.entries(headers)) {
      if (value == null) continue
      result[name] = String(value)
    }
  }
  return Object.keys(result).length ? result : null
}

const withDefaultUserAgent = (headers: Record<string, string> | null) => {
  const merged: Record<string, string> = { ...headers }
  const hasUserAgent = Object.keys(merged).some(name => name.toLowerCase() == 'user-agent')
  if (!hasUserAgent) merged['User-Agent'] = DEFAULT_USER_AGENT
  return merged
}

const downloadTo = async(url: string, targetPath: string, headers: Record<string, string> | null) => {
  if (typeof targetPath != 'string' || targetPath.length == 0) {
    throw new Error('RNFetchBlob.config({ path }) 缺少落盘路径，无法下载')
  }

  // 落盘前先删同目标文件：RNFS 在目标已存在时可能直接报错，且旧文件残留会和新内容混淆。
  // unlink 自身对「文件不存在」是 no-op（见 @/utils/fs 的实现），这里再兜一层 catch ——
  // 删不掉（权限/占用）不该阻断本次下载，后续写入失败会由下面的 exists 检查兜住。
  await unlink(targetPath).catch(() => {})

  try {
    if (url.startsWith('file://')) {
      // 本地文件（已下载歌曲的伴随封面等）：直接复制，不走网络
      await copyFile(url, targetPath)
    } else {
      const { promise } = downloadFile(url, targetPath, { headers: withDefaultUserAgent(headers) })
      // RNFS 的 downloadFile 对非 2xx 会 reject（错误信息里带状态码）；这里再读一次
      // statusCode 兜住「resolve 了但其实是错误页」的实现差异，保证失败一定抛出去，
      // 不会再出现「静默成功」。
      const result = await promise
      const statusCode = Number((result as { statusCode?: number } | undefined)?.statusCode ?? 0)
      if (statusCode > 0 && (statusCode < 200 || statusCode >= 300)) {
        throw new Error(`HTTP ${statusCode}`)
      }
    }
  } catch (err: any) {
    // 失败时清掉可能留下的半截文件（RNFS 失败一般不留，但 file:// 分支的 copyFile 可能留）
    await unlink(targetPath).catch(() => {})
    throw new Error(`下载失败: ${err?.message ?? err}`)
  }

  if (!(await existsFile(targetPath))) {
    throw new Error('下载失败: 文件未写入磁盘')
  }
  return targetPath
}

const config = (opts: FetchConfigOptions = {}) => ({
  async fetch(
    method: string,
    url: string,
    headers?: FetchHeaders | Array<{ name: string, value: string }>,
  ): Promise<FetchResult> {
    // 本 shim 只实现「下载到本地文件」这一种语义（rn-fetch-blob 的 POST/body 等能力未实现）。
    // 与其静默按 GET 处理、把调用方带沟里，不如直接报错 —— 目前全仓调用点都是 'GET'。
    if (typeof method == 'string' && method.toUpperCase() != 'GET') {
      throw new Error(`RNFetchBlob shim 只实现了 GET 下载，收到 ${method}`)
    }
    const targetPath = opts.path ?? ''
    const merged = normalizeHeaders(headers ?? opts.headers)
    await downloadTo(url, targetPath, merged)
    return {
      path: () => targetPath,
      base64: async() => readFile(targetPath, 'base64'),
    }
  },
})

const fs = {
  dirs: {
    DocumentDir: DocumentDirectoryPath,
    MusicDir: DocumentDirectoryPath, // iOS 无独立 Music 目录，落到 Document
    PictureDir: PicturesDirectoryPath,
    DownloadDir: DownloadDirectoryPath,
    CacheDir: CachesDirectoryPath,
  },
  exists: async(p: string) => fsExists(p),
  mkdir: async(p: string) => fsMkdir(p),
  mv: async(from: string, to: string) => moveFile(from, to).then(() => undefined),
  unlink: async(p: string) => fsUnlink(p),
  // iOS 不需要媒体库扫描，no-op
  scanFile: async(_paths: Array<{ path: string }>) => Promise.resolve(),
}

const RNFetchBlob = {
  config,
  fs,
}

export default RNFetchBlob
