import { Platform } from 'react-native'
import RNFetchBlob from '@/utils/rnFetchBlob'
import { mkdir, existsFile, moveFile, unlink } from '@/utils/fs'
import { getFileExtensionFromUrl } from '@/screens/Home/Views/Mylist/MusicList/download/utils'
import { requestStoragePermission, toast } from '@/utils/tools'
import { saveImageToPhotosLibrary } from '@/utils/nativeModules/utils'

const sanitizeFileName = (name: string) =>
  (name.trim() || 'image').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)

export interface SaveImageResult {
  /** true = 已写进系统相册（iOS），此时不再给出沙盒路径，临时文件已删除 */
  savedToPhotos: boolean
  /** savedToPhotos=false 时的落盘路径（Android 公共图片目录 / iOS 原生不可用时的沙盒兜底） */
  path: string
}

/**
 * 保存图片到「用户能找到的地方」。
 *
 * 【第 21 轮·优化 2（2026-10-03）】iOS 分支以前把图片写进应用沙盒的 Pictures 目录就完事，
 * 用户在任何系统相册里都看不到 —— 用户报的「保存了但找不到」就是这么来的。现在 iOS 走
 * 系统相册（PHPhotoLibrary，需要 Info.plist 的 NSPhotoLibraryAddUsageDescription），
 * 沙盒只作为「原生方法不可用」时的兜底。Android 行为不变（公共图片目录 + 媒体库扫描）。
 *
 * 失败/无权限返回 null（内部已 toast，调用方判空即可）。
 */
export const saveImageToPictures = async(url: string, name: string = 'image'): Promise<SaveImageResult | null> => {
  const isGranted = await requestStoragePermission()
  if (isGranted !== true) {
    toast('没有存储权限，无法保存图片', 'short')
    return null
  }

  const extension = getFileExtensionFromUrl(url) || 'jpg'
  if (Platform.OS == 'ios') return saveToPhotosOnIOS(url, name, extension)
  return saveToPublicPictures(url, name, extension)
}

// —— iOS：下载到缓存临时文件 → 写系统相册 → 删临时文件 ——
// 必须落成真实文件：PHAssetChangeRequest 只吃 file URL。保存成功后这张临时文件就没用了，
// 留在缓存里只是白占空间（用户存十张封面就多十份整图），所以 finally 里一律删掉；
// 兜底分支（原生不可用）会把文件 move 进沙盒图片目录，unlink 对不存在的路径是 no-op。
const saveToPhotosOnIOS = async(url: string, name: string, extension: string): Promise<SaveImageResult | null> => {
  const tmpPath = `${RNFetchBlob.fs.dirs.CacheDir}/lx_save_image_${Date.now()}.${extension}`
  try {
    await RNFetchBlob.config({ path: tmpPath }).fetch('GET', url)
    const saved = await saveImageToPhotosLibrary(tmpPath)
    if (saved === true) return { savedToPhotos: true, path: tmpPath }
    if (saved === null) {
      // 原生方法不可用（旧构建）：退回沙盒图片目录，至少把文件留下，并把真实路径告诉用户
      const fallbackPath = await saveToSandboxPictures(tmpPath, name, extension)
      return { savedToPhotos: false, path: fallbackPath }
    }
    toast('保存失败，请在「设置 → 隐私与安全性 → 照片」中允许本应用添加照片', 'long')
    return null
  } catch (err: any) {
    toast(`保存图片失败: ${err?.message ?? err}`, 'long')
    return null
  } finally {
    await unlink(tmpPath).catch(() => {})
  }
}

// iOS 兜底落盘目录：沙盒内 Pictures/LX-Y Music（与历史行为一致，文件可经「文件」App 访问）
const saveToSandboxPictures = async(tmpPath: string, name: string, extension: string) => {
  const picBaseDir = RNFetchBlob.fs.dirs.PictureDir || RNFetchBlob.fs.dirs.DownloadDir
  const saveDir = `${picBaseDir}/LX-Y Music`
  if (!(await existsFile(saveDir))) {
    try {
      await mkdir(saveDir)
    } catch (err) {
      // 建目录失败就落到图片目录根下（下面 exists 检查兜底）
    }
  }
  const fileName = `${sanitizeFileName(name)}_${Date.now()}.${extension}`
  const targetPath = (await existsFile(saveDir)) ? `${saveDir}/${fileName}` : `${picBaseDir}/${fileName}`
  await moveFile(tmpPath, targetPath)
  return targetPath
}

// —— Android：公共图片目录 + 媒体库扫描（历史行为，保持不变）——
const saveToPublicPictures = async(url: string, name: string, extension: string): Promise<SaveImageResult | null> => {
  const picBaseDir = RNFetchBlob.fs.dirs.PictureDir || RNFetchBlob.fs.dirs.DownloadDir
  const saveDir = `${picBaseDir}/LX-X-Music`
  const fileName = `${sanitizeFileName(name)}_${Date.now()}.${extension}`
  const filePath = `${saveDir}/${fileName}`

  if (!(await RNFetchBlob.fs.exists(saveDir))) {
    try {
      await RNFetchBlob.fs.mkdir(saveDir)
    } catch (err) {
      // Fallback to the base pictures/download directory below.
    }
  }

  const targetPath = (await RNFetchBlob.fs.exists(saveDir))
    ? filePath
    : `${picBaseDir}/${fileName}`

  // 【第 21 轮·优化 2】fetch 现在是真实下载（见 utils/rnFetchBlob.ts），失败会抛错，
  // 不会再出现「提示保存成功、磁盘上没有文件」的静默假成功。
  await RNFetchBlob.config({ path: targetPath }).fetch('GET', url)
  await RNFetchBlob.fs.scanFile([{ path: targetPath }])
  return { savedToPhotos: false, path: targetPath }
}
