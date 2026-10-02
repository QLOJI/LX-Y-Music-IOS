import RNFS from 'react-native-fs'
import { NativeModules } from 'react-native'
import pako from 'pako'

export interface FileType {
  name: string
  path: string
  size: number
  isDirectory: boolean
  isFile: boolean
  lastModified: number
  mimeType?: string | null
  canRead: boolean
}

export interface OpenDocumentOptions {
  extTypes?: string[]
  toPath?: string
}

interface OpenDocumentResult extends FileType {
  data?: string
}

export type Encoding = 'utf8' | 'ascii' | 'base64'
export type HashAlgorithm = 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512'

const unsupportedError = (feature: string) => new Error(`${feature} is not supported on ios`)
const { FilePickerModule } = NativeModules
export const isSystemFileSelectorSupported = typeof FilePickerModule?.openDocument == 'function'
export const isManagedFolderSupported = false

const audioMimeTypeMap: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
}

const normalizePath = (path: string) => path.startsWith('file://')
  ? decodeURIComponent(path.replace(/^file:\/\//, ''))
  : decodeURIComponent(path)

const getName = (path: string) => {
  const normalizedPath = normalizePath(path)
  return normalizedPath.split('/').pop() ?? normalizedPath
}

const extnameRaw = (name: string) => name.lastIndexOf('.') > 0 ? name.substring(name.lastIndexOf('.') + 1) : ''
const getMimeType = (path: string) => {
  const ext = extnameRaw(getName(path)).toLowerCase()
  return audioMimeTypeMap[ext] ?? null
}

const toFileType = (path: string, size: number, isDirectory: boolean, lastModified?: Date | string | number | null): FileType => ({
  name: getName(path),
  path: normalizePath(path),
  size,
  isDirectory,
  isFile: !isDirectory,
  lastModified: lastModified ? new Date(lastModified).getTime() : Date.now(),
  mimeType: getMimeType(path),
  canRead: true,
})

const gzipBuffer = (buffer: Buffer | Uint8Array) => Buffer.from(pako.gzip(buffer))
const unGzipBuffer = (buffer: Buffer | Uint8Array) => Buffer.from(pako.ungzip(buffer))

export const extname = extnameRaw

export const temporaryDirectoryPath = RNFS.CachesDirectoryPath
export const externalStorageDirectoryPath = RNFS.DocumentDirectoryPath
export const privateStorageDirectoryPath = RNFS.DocumentDirectoryPath

export const getExternalStoragePaths = async(_is_removable?: boolean) => [RNFS.DocumentDirectoryPath]

export const selectManagedFolder = async(_isPersist: boolean = false): Promise<FileType> => {
  throw unsupportedError('Folder selection')
}
export const selectFile = async(options: OpenDocumentOptions): Promise<OpenDocumentResult> => {
  if (!isSystemFileSelectorSupported) throw unsupportedError('File selection')
  return FilePickerModule.openDocument(options) as Promise<OpenDocumentResult>
}
export const selectFolder = async(): Promise<{ path: string }> => {
  if (!isSystemFileSelectorSupported || typeof FilePickerModule?.selectFolder !== 'function') {
    throw unsupportedError('Folder selection')
  }
  const result = await (FilePickerModule.selectFolder() as Promise<{ path: string }>)
  const folderPath = result?.path ?? ''
  // 仅允许选择应用沙盒内的目录（可在“文件”App 中访问）。沙盒外目录无法持久写入（需安全作用域书签），故拒绝。
  if (!folderPath || !folderPath.startsWith(privateStorageDirectoryPath)) {
    throw new Error('请选择应用目录内的文件夹（可在“文件”App 的 LX-Y Music 中访问）')
  }
  return result
}
export const shareFile = async(path: string): Promise<void> => {
  if (!isSystemFileSelectorSupported || typeof FilePickerModule?.shareFile !== 'function') {
    throw unsupportedError('File sharing')
  }
  return FilePickerModule.shareFile(path) as Promise<void>
}
export const removeManagedFolder = async(_path: string) => {
  throw unsupportedError('Managed folder removal')
}
export const getManagedFolders = async(): Promise<string[]> => []
export const getPersistedUriList = async(): Promise<string[]> => []

export const readDir = async(path: string): Promise<FileType[]> => {
  const list = await RNFS.readDir(normalizePath(path))
  return list.map(item => toFileType(item.path, Number(item.size), item.isDirectory(), item.mtime))
}

export const unlink = async(path: string) => {
  const normalizedPath = normalizePath(path)
  const exists = await RNFS.exists(normalizedPath)
  if (!exists) return
  return RNFS.unlink(normalizedPath)
}

export const mkdir = async(path: string) => RNFS.mkdir(normalizePath(path))

export const stat = async(path: string): Promise<FileType> => {
  const info = await RNFS.stat(normalizePath(path))
  return toFileType(info.path, Number(info.size), info.isDirectory(), info.mtime)
}
export const hash = async(path: string, algorithm: HashAlgorithm) => RNFS.hash(normalizePath(path), algorithm)

export const readFile = async(path: string, encoding: Encoding = 'utf8') => RNFS.readFile(normalizePath(path), encoding)
export const read = async(path: string, length: number, position: number, encoding: Encoding = 'utf8') =>
  RNFS.read(normalizePath(path), length, position, encoding)


export const moveFile = async(fromPath: string, toPath: string) => RNFS.moveFile(normalizePath(fromPath), normalizePath(toPath))
export const gzipFile = async(fromPath: string, toPath: string) => {
  const source = await RNFS.readFile(normalizePath(fromPath), 'base64')
  const compressed = gzipBuffer(Buffer.from(source, 'base64')).toString('base64')
  return RNFS.writeFile(normalizePath(toPath), compressed, 'base64')
}
export const unGzipFile = async(fromPath: string, toPath: string) => {
  const source = await RNFS.readFile(normalizePath(fromPath), 'base64')
  const uncompressed = unGzipBuffer(Buffer.from(source, 'base64')).toString('base64')
  return RNFS.writeFile(normalizePath(toPath), uncompressed, 'base64')
}
export const gzipString = async(data: string, _encoding: Encoding = 'utf8') => gzipBuffer(Buffer.from(data, 'utf8')).toString('base64')
export const unGzipString = async(data: string, _encoding: Encoding = 'utf8') => unGzipBuffer(Buffer.from(data, 'base64')).toString('utf8')

export const existsFile = async(path: string) => RNFS.exists(normalizePath(path))

export const rename = async(path: string, name: string) => {
  const normalizedPath = normalizePath(path)
  const parent = normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
  const target = `${parent}/${name}`
  await RNFS.moveFile(normalizedPath, target)
  return target
}

export const writeFile = async(path: string, data: string, encoding: Encoding = 'utf8') => RNFS.writeFile(normalizePath(path), data, encoding)

export const appendFile = async(path: string, data: string, encoding: Encoding = 'utf8') => RNFS.appendFile(normalizePath(path), data, encoding)

/**
 * 下载进度回调限流间隔（毫秒）—— 2026-10-02 用户第 8 条 (3)。
 *
 * RNFS 的 progressInterval / progressDivider 默认都是 0，即**逐数据块**回调；
 * 每次回调都会串起 store 事件 + React 渲染（悬浮下载球、下载管理列表的进度条），
 * 一首歌下来就是几百上千次 JS 唤醒 —— 本 App 又有音频后台播放能力，进程常驻，
 * 锁屏后这些渲染工作照跑一整夜。统一限流到 250ms（≥250ms 回调一次）：
 * 进度/速度观感不变（速度本就按时间差算，限流后反而是更稳的平均值），
 * JS 唤醒次数降到 1/10 量级。
 *
 * 收敛在 downloadFile 这一个封装里，所有调用点（core/download.ts、
 * MetadataForm、Mylist/listAction、WebDAV 相关等 10 处）自动生效。
 */
const DOWNLOAD_PROGRESS_INTERVAL = 250

export const downloadFile = (url: string, path: string, options: Omit<RNFS.DownloadFileOptions, 'fromUrl' | 'toFile'> = {}) => {
  if (!options.headers) {
    options.headers = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile',
    }
  }
  return RNFS.downloadFile({
    fromUrl: url,
    toFile: normalizePath(path),
    // 默认限流；调用点显式传 progressInterval 时由 options 覆盖（展开在后，同名键后写者胜）
    progressInterval: DOWNLOAD_PROGRESS_INTERVAL,
    ...options,
  })
}

export const stopDownload = (jobId: number) => {
  RNFS.stopDownload(jobId)
}

export const getWebDAVPrivateDirectory = () => {
  const docDir = privateStorageDirectoryPath
  if (!docDir || typeof docDir !== 'string') {
    return `${RNFS.DocumentDirectoryPath}/WebDAV`
  }
  return `${docDir}/WebDAV`
}

export const copyFile = async(fromPath: string, toPath: string) =>
  RNFS.copyFile(normalizePath(fromPath), normalizePath(toPath))
