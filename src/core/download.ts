import RNFetchBlob from '@/utils/rnFetchBlob'
import { toMD5, toast, requestStoragePermission } from '@/utils/tools'
import { getMusicUrl, getLyricInfo, getPicPath } from '@/core/music'
import { getFileExtension, getFileExtensionFromUrl } from '@/screens/Home/Views/Mylist/MusicList/download/utils'
import { mergeLyrics } from '@/screens/Home/Views/Mylist/MusicList/download/lrcTool'
import { writeFile, unlink, downloadFile, mkdir, moveFile, copyFile, stopDownload, getWebDAVPrivateDirectory } from '@/utils/fs'
import { getDefaultDownloadPath } from '@/utils/downloadPath'
import { writeMetadata, writePic, writeLyric, isWriteSupported } from '@/utils/localMediaMetadata'
import settingState from '@/store/setting/state'
import downloadState from '@/store/download/state'
import downloadActions from '@/store/download/action'
import { filterFileName, sizeFormate } from '@/utils'
import {
  getWebDAVDownloadUrl,
  getWebDAVAuthHeaders,
  downloadWebDAVFile,
  updateWebDAVMusicMeta,
} from '@/core/webdavMusic/drive'
import { webDAVLog } from '@/core/webdavMusic/logger'
import DownloadTask = LX.Download.DownloadTask
import wySdk from '@/utils/musicSdk/wy'
import bilibiliSdk from '@/utils/musicSdk/bilibili'

const taskQueue: DownloadTask[] = []
let isProcessing = false
const DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36',
}
const WY_MEDIA_HEADERS = {
  'User-Agent': '',
}
const getDownloadHeaders = (task: DownloadTask) => {
  return task.musicInfo.source === 'wy' ? WY_MEDIA_HEADERS : DOWNLOAD_HEADERS
}

// 【第 26 轮】只有 http(s) 能交给 RNFS 的 fromUrl。
// file:// 与无 scheme 的本地路径交给 fromUrl，iOS 上是 NSURLErrorUnsupportedURL
// —— 用户截图里下载管理那条「unsupported URL」就是这么来的（见 startDownload 的注释）。
const isDownloadableUrl = (value?: string | null): boolean => !!value && /^https?:\/\//i.test(value)

const isWebDAVMusicInfo = (musicInfo: LX.Music.MusicInfo): boolean =>
  musicInfo.source === 'local' && !!(musicInfo.meta as any)?.webdav

/**
 * 【第 30 轮】这首歌的下载落盘目录。
 *
 * WebDAV 在「配置」页有自己的下载目录（webdav.downloadPath，见 WebDAVDownloadPath 组件），
 * 下载管理器此前一律用全局 download.path —— 从 WebDAV 列表点下载的文件会落到音乐下载目录里，
 * 与配置页显示的路径对不上（而且老的 WebDAV 专用下载链路读的是这个键）。现在 WebDAV 歌曲
 * 优先用 webdav.downloadPath（未设置时回退 WebDAV 私有目录，与 WebDAVListAction 同口径），
 * 其余音源一律维持 download.path 原行为。
 */
const resolveDownloadDir = (musicInfo: LX.Music.MusicInfo): string => {
  if (isWebDAVMusicInfo(musicInfo)) {
    const webdavPath = settingState.setting['webdav.downloadPath']
    if (webdavPath && typeof webdavPath === 'string' && webdavPath.trim()) return webdavPath.trim()
    return getWebDAVPrivateDirectory()
  }
  return settingState.setting['download.path'] || getDefaultDownloadPath()
}

let currentDownloadTask: any | null = null

const processQueue = async() => {
  if (isProcessing || taskQueue.length === 0) return
  isProcessing = true

  const task = taskQueue.shift()
  if (!task) {
    isProcessing = false
    return
  }

  try {
    await startDownload(task)
  } catch (error: any) {
    downloadActions.updateTask(task.id, { status: 'error', errorMsg: error.message })
  } finally {
    isProcessing = false
    processQueue()
  }
}

const startDownload = async(task: DownloadTask) => {
  downloadActions.updateTask(task.id, { status: 'downloading' })

  let url = ''
  let headers: any = getDownloadHeaders(task)
  // 【第 26 轮】本地 / WebDAV 歌曲在下载管理里**没有可下载的远端地址**：
  // getMusicUrl 对 source=local 返回的是本地文件路径（普通本地音乐 = 原文件；WebDAV = 已预下载
  // 到 Caches 的那份副本）。此前它被直接当 fromUrl 交给 RNFS，iOS 上是
  // NSURLErrorUnsupportedURL —— 用户截图里下载管理那条「unsupported URL」就是这个。
  // 现在明确分流：WebDAV 用远端直链下载，本地音乐直接复制；任何无 scheme 的路径都不再进 downloadFile。
  let localSourcePath = ''
  let isWebDAVSource = false
  if (task.isForceCookie && task.musicInfo.source === 'wy') {
    const highQualityLevels: LX.Quality[] = ['flac', 'hires', 'master', 'atmos', 'atmos_plus']
    console.log(`[Batch Download] Forcing cookie for ${task.musicInfo.name}`)
    try {
      const result: any = await (wySdk.cookie.getMusicUrl(task.musicInfo, task.quality) as any).promise
      if (!result.url) throw new Error('Cookie 未能获取到URL')
      if (result.level === 'exhigh' && highQualityLevels.includes(task.quality)) {
        throw new Error(`请求的音质 ${task.quality} 不可用`)
      }
      url = result.url
    } catch (error: any) {
      toast(`${task.musicInfo.name} 下载失败: ${error.message}`, 'short')
      removeTask(task.id)
      return
    }
  } else if (task.musicInfo.source === 'bilibili') {
    console.log('[Download] 处理 bilibili 源')
    try {
      const result: any = await (bilibiliSdk.getMusicUrl(task.musicInfo, task.quality) as any).promise
      url = result.url
      if (result.headers) {
        headers = result.headers
        console.log('[Download] 使用 bilibili 自定义 headers')
      }
    } catch (error: any) {
      toast(`${task.musicInfo.name} 下载失败: ${error.message}`, 'short')
      removeTask(task.id)
      return
    }
  } else if (isWebDAVMusicInfo(task.musicInfo)) {
    // WebDAV：直链 + Basic Auth（同一套 headers 也用于第二级的直链重试）
    isWebDAVSource = true
    url = getWebDAVDownloadUrl(task.musicInfo as LX.WebDAV.MusicInfo)
    headers = getWebDAVAuthHeaders()
    webDAVLog.info('downloadManager: WebDAV download source ready', { fileName: task.fileName })
  } else if (task.musicInfo.source === 'local') {
    // 普通本地音乐：本来就是本地文件，「下载」= 复制到下载目录，没有网络请求
    localSourcePath = String((task.musicInfo.meta as any)?.filePath || '')
    if (!localSourcePath) {
      webDAVLog.warn('downloadManager: local source has no filePath, fallback to getMusicUrl')
      const resolved = await getMusicUrl({ musicInfo: task.musicInfo, quality: task.quality, isRefresh: true })
      localSourcePath = resolved
    }
  } else {
    url = await getMusicUrl({ musicInfo: task.musicInfo, quality: task.quality, isRefresh: true })
    if (!isDownloadableUrl(url)) {
      // 兜底：任何来源只要给回的是本地路径（无 scheme / file://），就改走复制，绝不交给 RNFS.fromUrl
      webDAVLog.warn('downloadManager: resolved url is not downloadable, use local copy', { source: task.musicInfo.source })
      localSourcePath = url
      url = ''
    }
  }

  const isBilibiliSource = task.musicInfo.source === 'bilibili'
  let finalFilePath = task.filePath

  // 本地复制时没有 URL，扩展名从源文件路径推（同样是「真实文件」的扩展名）
  const urlExtension = getFileExtensionFromUrl(url || localSourcePath)
  const taskExt = task.filePath.substring(task.filePath.lastIndexOf('.') + 1).toLowerCase()

  let downloadFilePath = task.filePath
  if (isBilibiliSource && urlExtension) {
    const downloadDir = resolveDownloadDir(task.musicInfo)
    downloadFilePath = `${downloadDir}/${task.fileName}.download.${urlExtension}`
    console.log(`[Download] Bilibili 源使用临时路径下载: ${downloadFilePath}`)
  } else if (urlExtension && urlExtension !== taskExt) {
    const downloadDir = resolveDownloadDir(task.musicInfo)
    downloadFilePath = `${downloadDir}/${task.fileName}.download.${urlExtension}`
    finalFilePath = `${downloadDir}/${task.fileName}.${urlExtension}`
    console.log(`[Download] URL 扩展名(${urlExtension})与任务扩展名(${taskExt})不一致，使用真实扩展名下载: ${downloadFilePath} -> ${finalFilePath}`)
  }

  await requestStoragePermission()

  if (!task.isForceCookie) {
    toast(`${task.fileName} 正在下载...`, 'short')
  }
  let lastWritten = 0
  let lastTime = Date.now()
  let downloadedFilePath: string
  const effectiveDownloadDir = resolveDownloadDir(task.musicInfo)
  // 【第 26 轮】进度回调抽成具名函数：现在三条下载路径（本地复制 / WebDAV 直链 / 普通下载）共用它
  const onProgress = (res: { bytesWritten: number, contentLength: number }) => {
    const now = Date.now()
    const written = res.bytesWritten
    const total = res.contentLength
    const deltaTime = now - lastTime
    if (deltaTime === 0) return

    const deltaBytes = written - lastWritten
    const speed = deltaBytes / (deltaTime / 1000)

    lastWritten = written
    lastTime = now
    const percent = total > 0 ? written / total : 0
    downloadActions.updateTask(task.id, {
      progress: {
        ...task.progress,
        percent,
        downloaded: written,
        total,
        speed: `${sizeFormate(speed)}/s`,
      },
    })
  }
  try {
    await mkdir(effectiveDownloadDir)

    if (localSourcePath) {
      // 【第 26 轮】本地文件（普通本地音乐 / 任何回退到本地副本的来源）：没有网络请求，直接复制。
      // 绝不能把这种路径交给 downloadFile —— file:// 或无 scheme 的路径在 iOS 上就是 unsupported URL。
      await copyFile(localSourcePath, downloadFilePath)
      console.log('[Download] 本地文件复制完成:', localSourcePath, '->', downloadFilePath)
    } else if (isWebDAVSource) {
      try {
        // 【第 26 轮】WebDAV 走远端直链：drive.ts 的 downloadWebDAVFile 负责三级阶梯
        // （直接请求 → HEAD/GET 解析出 302 之后的直链再请求 → 抛错），并在每次尝试前清掉半截文件。
        // onTask 把真实的 RNFS task 交出来，removeTask 的「取消」才能 stopDownload(jobId)。
        await downloadWebDAVFile(url, downloadFilePath, { headers, progress: onProgress }, (t) => {
          currentDownloadTask = t
        })
      } catch (webdavError: any) {
        // 兜底：远端直链全部失败时，用播放时已预下载到 Caches 的那份副本（getMusicUrl 的 WebDAV 分支）。
        // 这样「下载」不会白点；但只有拿到的东西确实是本地文件才复制，拿到 http(s) 说明兜底也失败，原样抛出。
        webDAVLog.warn('downloadManager: WebDAV direct download failed, try playback cache', {
          error: webdavError?.message,
        })
        const cachedPath = await getMusicUrl({
          musicInfo: task.musicInfo,
          quality: task.quality,
          isRefresh: false,
        })
        if (!cachedPath || isDownloadableUrl(cachedPath)) throw webdavError
        await unlink(downloadFilePath).catch(() => {})
        await copyFile(cachedPath, downloadFilePath)
        webDAVLog.info('downloadManager: WebDAV download recovered from playback cache')
      }
    } else {
      const downloadTask = downloadFile(url, downloadFilePath, {
        headers,
        progress: onProgress,
      })
      currentDownloadTask = downloadTask
      await downloadTask.promise
    }

    downloadedFilePath = downloadFilePath
    console.log('下载完成:', downloadedFilePath)

    if (finalFilePath !== downloadedFilePath) {
      try {
        await moveFile(downloadedFilePath, finalFilePath)
        downloadedFilePath = finalFilePath
        console.log(`[Download] 重命名为最终路径: ${downloadedFilePath}`)
      } catch (renameError) {
        console.warn('[Download] 重命名失败:', renameError)
      }
    }

    // 【第 26 轮】WebDAV 下载成功后把落盘路径写回歌曲 meta：下次播放 local.ts:getMusicUrl 直接命中
    // 「本地已有该文件」的离线分支，不再为了播放又去 Caches 预下载一份（省一次网盘请求）。
    // 写回的是**下载目录里的正式文件**，不是会被系统回收的 Caches 副本。
    if (isWebDAVSource) {
      try {
        await updateWebDAVMusicMeta(task.musicInfo.id, { filePath: downloadedFilePath })
        webDAVLog.info('downloadManager: WebDAV local path written back', { id: task.musicInfo.id })
      } catch (writeBackError: any) {
        // 写回失败不影响下载结果本身，只是下次播放仍走预下载
        webDAVLog.warn('downloadManager: write back WebDAV local path failed', { error: writeBackError?.message })
      }
    }

    if (!isBilibiliSource) {
      await handleMetadata(task, downloadedFilePath)
    } else {
      console.log('[Download] Bilibili 源跳过元数据处理')
      downloadActions.updateTask(task.id, { metadataStatus: { cover: 'success', lyric: 'success', tags: 'success' } })
    }
    try {
      await RNFetchBlob.fs.scanFile([{ path: downloadedFilePath }])
      console.log(`[Download Manager] Media scan requested for: ${downloadedFilePath}`)
    } catch (scanError) {
      console.error(`[Download Manager] Failed to request media scan for ${downloadedFilePath}:`, scanError)
    }
    downloadActions.updateTask(task.id, { status: 'completed', progress: { ...task.progress, percent: 1 }, filePath: downloadedFilePath })

    // 下载完成后缓存歌词（内存缓存 + 同名 .lrc），保证离线也能显示歌词
    void cacheLyricForOffline(task, downloadedFilePath)

    if (!task.isForceCookie) {
      toast(`${task.fileName} 下载完成!`, 'short')
    }
  } finally {
    currentDownloadTask = null
  }
}

// 下载完成后缓存歌词：仅当用户明确勾选「下载歌词文件」时才写出同名 .lrc；
// 「写入内嵌歌词」已由 handleMetadata 把歌词嵌入音频文件内部，不再额外生成 .lrc。
const cacheLyricForOffline = async(task: DownloadTask, filePath: string) => {
  try {
    if (!settingState.setting['download.writeLyric']) return
    const lyrics = await getLyricInfo({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline })
    const merged = mergeLyrics(lyrics.lyric, lyrics.tlyric, lyrics.rlyric)
    if (merged) {
      const lrcPath = `${filePath.substring(0, filePath.lastIndexOf('.'))}.lrc`
      try {
        if (!(await RNFetchBlob.fs.exists(lrcPath))) {
          await writeFile(lrcPath, merged)
        }
      } catch (e: any) {
        console.warn('[Download] 写入离线歌词文件失败:', e?.message || e)
      }
    }
    console.log(`[Download] 离线歌词已缓存: ${task.fileName}`)
  } catch (e: any) {
    console.warn('[Download] 离线歌词缓存失败（不影响歌曲）:', e?.message || e)
  }
}

const handleMetadata = async(task: DownloadTask, filePath: string) => {
  // 按原生写入能力判断（iOS 的 LocalMediaMetadata 内联模块同样支持标签/封面/内嵌歌词写入），
  // 不再按平台一刀切跳过；能力不可用时整段跳过，避免误报与假成功
  // （与 MusicList/listAction.ts 的下载写入守卫保持一致）。
  if (!isWriteSupported()) return
  console.log('开始处理元数据:', filePath)

  const fileExt = filePath.substring(filePath.lastIndexOf('.') + 1).toLowerCase()
  console.log(`[Metadata] 文件格式: ${fileExt}`)

  if (settingState.setting['download.writeMetadata']) {
    try {
      const title = settingState.setting['download.writeAlias'] && task.musicInfo.alias
        ? `${task.musicInfo.name} (${task.musicInfo.alias})`
        : task.musicInfo.name

      await writeMetadata(filePath, {
        name: title,
        singer: task.musicInfo.singer,
        albumName: task.musicInfo.meta.albumName,
      }, true)
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, tags: 'success' } })
    } catch (e: any) {
      console.error('[Metadata] 标签信息写入失败:', e?.message || e)
      toast('标签信息写入失败', 'short')
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, tags: 'fail' } })
    }
  }

  const downloadDir = settingState.setting['download.path'] || getDefaultDownloadPath()
  if (settingState.setting['download.writePicture']) {
    try {
      // 【第 26 轮】封面来源改用分发器 getPicPath：本地 / WebDAV 歌曲走本地链路（网盘内同名封面、
      // 音频内嵌封面、离线在线匹配），在线歌曲与原来的 getPicUrl **完全等价**（分发器的在线分支调的就是它）。
      // 此前写死 getPicUrl（在线专用），WebDAV 歌曲在这里永远拿不到封面，封面写入静默失败。
      const picSource = await getPicPath({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline })
      if (!picSource) throw new Error('未找到可用封面')
      const extension = getFileExtensionFromUrl(picSource) || 'jpg'
      const tempPicPath = `${downloadDir}/temp.${extension}`
      console.log(`[Metadata] 获取封面: ${picSource} -> ${tempPicPath}`)
      if (isDownloadableUrl(picSource)) {
        const { promise } = downloadFile(picSource, tempPicPath)
        await promise
      } else {
        // 本地路径 / file://（本地音乐内嵌封面、WebDAV 缓存封面）：复制，不能交给 downloadFile
        await copyFile(picSource, tempPicPath)
      }
      console.log('[Metadata] 封面下载完成，开始写入到音频文件')
      await writePic(filePath, tempPicPath)
      await unlink(tempPicPath)
      console.log('[Metadata] 封面写入完成')
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, cover: 'success' } })
    } catch (e: any) {
      console.error('[Metadata] 封面写入失败:', e?.message || e)
      toast('封面写入失败', 'short')
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, cover: 'fail' } })
    }
  }

  if (settingState.setting['download.writeLyric'] || settingState.setting['download.writeEmbedLyric']) {
    try {
      const lyrics = await getLyricInfo({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline })
      const baseFilePath = filePath.substring(0, filePath.lastIndexOf('.'))
      const romaLyric = settingState.setting['download.writeRomaLyric'] ? lyrics.rlyric : null

      if (settingState.setting['download.writeEmbedLyric']) {
        const embedLyricContent = mergeLyrics(lyrics.lyric, lyrics.tlyric, romaLyric)
        if (embedLyricContent) {
          console.log('[Metadata] 写入嵌入歌词')
          await writeLyric(filePath, embedLyricContent)
        }
      }
      if (settingState.setting['download.writeLyric']) {
        const finalLyricContent = mergeLyrics(lyrics.lyric, lyrics.tlyric, romaLyric)
        if (finalLyricContent) {
          const lrcPath = `${baseFilePath}.lrc`
          console.log(`[Metadata] 写入歌词文件: ${lrcPath}`)
          await writeFile(lrcPath, finalLyricContent)
        }
      }
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, lyric: 'success' } })
    } catch (e: any) {
      console.error('[Metadata] 歌词写入失败:', e?.message || e)
      toast('歌词写入失败', 'short')
      downloadActions.updateTask(task.id, { metadataStatus: { ...task.metadataStatus, lyric: 'fail' } })
    }
  }
}

export const retryMetadata = async(taskId: string) => {
  const task = downloadState.tasks.find(t => t.id === taskId)
  if (!task?.filePath) {
    toast('任务或文件不存在，无法重试')
    return
  }

  // 写入能力不可用时跳过（同 handleMetadata，按原生模块可用性而非平台判断）
  if (!isWriteSupported()) {
    toast('当前平台不支持写入元数据')
    return
  }

  console.log(`[Retry Metadata] 开始重试元数据写入，文件: ${task.filePath}`)
  toast('正在尝试重新获取元信息...')
  const filePath = task.filePath
  const metadataStatus = { ...task.metadataStatus }

  const fileExt = filePath.substring(filePath.lastIndexOf('.') + 1).toLowerCase()
  console.log(`[Retry Metadata] 文件格式: ${fileExt}`)

  if (metadataStatus.tags === 'fail' && settingState.setting['download.writeMetadata']) {
    try {
      const title = settingState.setting['download.writeAlias'] && task.musicInfo.alias
        ? `${task.musicInfo.name} (${task.musicInfo.alias})`
        : task.musicInfo.name

      console.log(`[Retry Metadata] 写入标签: title=${title}, singer=${task.musicInfo.singer}`)
      await writeMetadata(filePath, {
        name: title,
        singer: task.musicInfo.singer,
        albumName: task.musicInfo.meta.albumName,
      }, true)
      metadataStatus.tags = 'success'
      console.log('[Retry Metadata] 标签写入成功')
    } catch (e: any) {
      console.error(`[Retry Metadata] Write Tags Error for ${task.musicInfo.name}:`, e?.message || e)
      metadataStatus.tags = 'fail'
    }
  }

  if (metadataStatus.cover === 'fail' && settingState.setting['download.writePicture']) {
    try {
      // 【第 26 轮】同 handleMetadata：走分发器，本地 / WebDAV 歌曲才有封面可拿
      const picSource = await getPicPath({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline })
      if (!picSource) throw new Error('未找到可用封面')
      const extension = getFileExtensionFromUrl(picSource) || 'jpg'
      const picPath = `${RNFetchBlob.fs.dirs.CacheDir}/lx_temp_pic_${task.id}.${extension}`

      console.log(`[Retry Metadata] 获取封面: ${picSource} -> ${picPath}`)
      if (isDownloadableUrl(picSource)) {
        const { promise } = downloadFile(picSource, picPath)
        await promise
      } else {
        await copyFile(picSource, picPath)
      }
      console.log('[Retry Metadata] 封面下载完成，开始写入')
      await writePic(filePath, picPath)
      await unlink(picPath)
      metadataStatus.cover = 'success'
      console.log('[Retry Metadata] 封面写入成功')
    } catch (e: any) {
      console.error(`[Retry Metadata] Write Cover Error for ${task.musicInfo.name}:`, e?.message || e)
      metadataStatus.cover = 'fail'
    }
  }

  if (metadataStatus.lyric === 'fail' && (settingState.setting['download.writeLyric'] || settingState.setting['download.writeEmbedLyric'])) {
    try {
      const lyrics = await getLyricInfo({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline })
      const baseFilePath = filePath.substring(0, filePath.lastIndexOf('.'))
      const romaLyric = settingState.setting['download.writeRomaLyric'] ? lyrics.rlyric : null

      if (settingState.setting['download.writeEmbedLyric']) {
        const embedLyricContent = mergeLyrics(lyrics.lyric, lyrics.tlyric, romaLyric)
        if (embedLyricContent) {
          console.log('[Retry Metadata] 写入嵌入歌词')
          await writeLyric(filePath, embedLyricContent)
        }
      }
      if (settingState.setting['download.writeLyric']) {
        const finalLyricContent = mergeLyrics(lyrics.lyric, lyrics.tlyric, romaLyric)
        if (finalLyricContent) {
          const lrcPath = `${baseFilePath}.lrc`
          console.log(`[Retry Metadata] 写入歌词文件: ${lrcPath}`)
          await writeFile(lrcPath, finalLyricContent)
        }
      }
      metadataStatus.lyric = 'success'
      console.log('[Retry Metadata] 歌词写入成功')
    } catch (e: any) {
      console.error(`[Retry Metadata] Write Lyric Error for ${task.musicInfo.name}:`, e?.message || e)
      metadataStatus.lyric = 'fail'
    }
  }

  downloadActions.updateTask(task.id, { metadataStatus })

  if (Object.values(metadataStatus).every(s => s !== 'fail')) {
    toast('元信息已全部修复成功！')
  } else {
    toast('部分元信息修复失败，请检查日志', 'long')
  }
}

export const retryTask = (taskId: string) => {
  const task = downloadState.tasks.find(t => t.id === taskId)
  if (!task) return

  if (task.status === 'error' || !task.filePath) {
    toast('正在重新下载...')
    removeTask(task.id)
    setTimeout(() => {
      addTask(task.musicInfo, task.quality)
    }, 200)
  } else if (Object.values(task.metadataStatus ?? {}).includes('fail')) {
    void retryMetadata(task.id)
  }
}

export const resumeTask = async(taskId: string) => {
  const task = downloadState.tasks.find(t => t.id === taskId)
  if (!task) return
  if (task.status !== 'paused') return

  if (taskQueue.some(t => t.id === task.id)) {
    return
  }

  try {
    await unlink(task.filePath)
  } catch (error) {
    // Ignore cleanup failures so we can still restart the download.
  }

  downloadActions.updateTask(task.id, {
    status: 'waiting',
    errorMsg: '',
    progress: { percent: 0, speed: '', downloaded: 0, total: 0 },
    metadataStatus: { cover: 'pending', lyric: 'pending', tags: 'pending' },
  })
  taskQueue.push(task)
  processQueue()
}

export const addTask = (musicInfo: LX.Music.MusicInfo, quality: LX.Quality, isForceCookie: boolean = false) => {
  let extension = getFileExtension(quality)
  if (musicInfo.source === 'bilibili') {
    extension = 'mp3'
  }

  let finalSingerString = musicInfo.singer
  if (musicInfo.artists && musicInfo.artists.length > 6) {
    finalSingerString = musicInfo.artists.slice(0, 6).map(artist => artist.name).join('、') + '...'
  }
  let fileName = settingState.setting['download.fileName']
    .replace('歌名', musicInfo.name)
    .replace('歌手', finalSingerString)
  fileName = filterFileName(fileName)
  const downloadDir = settingState.setting['download.path'] || getDefaultDownloadPath()
  const filePath = `${downloadDir}/${fileName}.${extension}`

  const task: DownloadTask = {
    id: toMD5(`${musicInfo.id}-${quality}`),
    musicInfo,
    quality,
    status: 'waiting',
    filePath,
    fileName,
    progress: { percent: 0, speed: '', downloaded: 0, total: 0 },
    metadataStatus: { cover: 'pending', lyric: 'pending', tags: 'pending' },
    createdAt: Date.now(),
    isForceCookie,
  }

  if (downloadState.tasks.some(t => t.id === task.id)) {
    toast('任务已存在')
    return
  }

  downloadActions.addTask(task)
  taskQueue.push(task)
  processQueue()
}

export const removeTask = (id: string) => {
  const taskToRemove = downloadState.tasks.find(t => t.id === id)
  if (currentDownloadTask && taskToRemove && taskToRemove.status === 'downloading') {
    const jobId = currentDownloadTask.jobId
    if (typeof jobId === 'number') {
      stopDownload(jobId)
    }
    if (taskToRemove.filePath) {
      void unlink(taskToRemove.filePath).catch(() => {})
      console.log(`[Download Manager] Canceled and deleted partial file: ${taskToRemove.filePath}`)
    }
    currentDownloadTask = null
  } else if (taskToRemove && taskToRemove.status !== 'completed' && taskToRemove.filePath) {
    void unlink(taskToRemove.filePath).catch(() => {})
  }
  const taskIndex = taskQueue.findIndex(t => t.id === id)
  if (taskIndex > -1) taskQueue.splice(taskIndex, 1)
  downloadActions.removeTask(id)
  isProcessing = false
  processQueue()
}


/**
 * Batch download tasks - add download tasks with interval
 * @param musicInfos Selected song list
 */
export const batchDownload = async(musicInfos: LX.Music.MusicInfo[]) => {
  const cookie = settingState.setting['common.wy_cookie']
  const hasWyMusic = musicInfos.some(m => m.source === 'wy')

  if (hasWyMusic && !cookie) {
    toast('未配置网易云 Cookie，网易云音源将使用普通音质下载')
  }

  const quality = settingState.setting['download.quality']
  let wyCount = 0
  let otherCount = 0

  for (const musicInfo of musicInfos) {
    if (musicInfo.source === 'wy') wyCount++; else otherCount++
  }

  const tips = []
  if (wyCount > 0) tips.push(`${wyCount}首网易云${cookie ? '(Cookie)' : '(普通)'}`)
  if (otherCount > 0) tips.push(`${otherCount}首其他音源`)
  toast(`准备添加 ${musicInfos.length} 首歌曲到下载队列 (${tips.join(', ')})`)

  for (const musicInfo of musicInfos) {
    const isWyAndHasCookie = musicInfo.source === 'wy' && !!cookie
    addTask(musicInfo, quality, isWyAndHasCookie)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

/**
 * 直接按下载设置中的音质下载单曲，并提示所添加的音质（不再弹确认框）
 */
export const downloadMusic = (musicInfo: LX.Music.MusicInfo) => {
  if (!settingState.setting['download.enable']) {
    // 【第 30 轮】原来这里静默 return：设置里关掉「启用下载」后，WebDAV 列表 ⋮ 菜单的「下载」
    // 按下去什么都不发生、也没有任何解释（用户读到的还是「按钮没反应」）。现在明确提示一次。
    // 其他调用点大多自己判过这个开关（FeatureBtns / MoreBtn / DownloadBtn），不会重复弹。
    toast('下载功能已在设置中关闭', 'short')
    return
  }
  const quality = settingState.setting['download.quality'] as LX.Quality
  addTask(musicInfo, quality)
  toast(
    global.i18n.t('download_added_tip', { name: musicInfo.name, quality: global.i18n.t(quality) }),
    'short',
  )
}

/**
 * 【第 30 轮】与 downloadMusic 完全同一条链路，只是返回 Promise。
 *
 * 给「点了就必须有回声」的菜单入口用（WebDAV 列表 ⋮ 菜单的「下载」）：downloadMusic 是同步的，
 * 调用方拿不到失败信号 —— addTask 内部一旦抛错（文件名过滤、音质换算、设置缺键），
 * 老的 `void handleWebDAVDownload(...).catch(...)` 那种写法就永远等不到这次异常。
 * 这里把调用包进 async，异常统一变成 reject，调用方一个 .catch 就能落日志 + 提示。
 * 其余 6 个调用点（列表/播放页的下载按钮）是即点即走的按钮，保持同步调用不受影响。
 */
export const downloadMusicAsync = async(musicInfo: LX.Music.MusicInfo): Promise<void> => {
  downloadMusic(musicInfo)
}
