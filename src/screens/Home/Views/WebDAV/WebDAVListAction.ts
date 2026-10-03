import { findMusic } from '@/utils/musicSdk'
import { getWebDAVConfig, updateWebDAVMusicMeta, getWebDAVDownloadUrl, saveWebDAVConfig, downloadWebDAVFile, getWebDAVAuthHeaders, getWebDAVFileState, type WebDAVFileState } from '@/core/webdavMusic/drive'
import { mkdir, unlink, getWebDAVPrivateDirectory } from '@/utils/fs'
import { toast, requestStoragePermission } from '@/utils/tools'
import settingState from '@/store/setting/state'
import { updateListMusics, addListMusics } from '@/core/list'
import { webDAVLog } from '@/core/webdavMusic/logger'
import { readPic, readMetadata } from '@/utils/localMediaMetadata'
import { handleGetOnlinePicUrl } from '@/core/music'
import { LIST_IDS } from '@/config/constant'


/**
 * 【第 28 轮】文件是不是「真的下完了」的统一判定见 drive.ts 的 getWebDAVFileState。
 * 这里原来自己写了一份 existsFile 判断：RNFS 是**直接写目标路径**的（不是先写临时文件再
 * 改名），中途失败/被取消/断网会在原地留一个半截文件 —— 此后 existsFile 永远为真，
 * 下载被静默跳过，半截文件被当成「已下载」返回给播放器/下载列表。
 * 这正是「点了下载什么都没发生、再点也没反应」的成因之一，现在四处（播放 ×2、下载 ×2）
 * 共用 drive.ts 那一份判定。
 */

/** 【第 28 轮】把各种 Error 里的可读原因抠出来 —— RNFS 的错对象经常没有 message，直接拼会变成 "undefined" */
const getErrorMessage = (error: any): string => {
  if (!error) return '未知错误'
  return error.message || error.code || (typeof error === 'string' ? error : String(error))
}

const parsePathForName = (filePath: string) => ({
  ext: filePath.split('.').pop()?.toLowerCase() || '',
  nameWithoutExt: filePath.substring(0, filePath.lastIndexOf('.')),
  fileName: filePath.split('/').pop() || '',
})

const chunk = <T>(arr: T[], size: number): T[][] => {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}

export const handleWebDAVBatchDownload = async(
  songs: LX.WebDAV.MusicInfo[],
  onProgress?: (current: number, total: number, currentSong: string) => void,
): Promise<string[]> => {
  // 【第 28 轮】入口先落一行日志。原来权限判断在日志之前，「权限不足」的提前 return 是
  // 完全没有日志的 —— 用户点完下载，日志里一行都看不到，根本没法定位「点了没反应」。
  webDAVLog.info('handleWebDAVBatchDownload: invoked', { songCount: songs.length })

  const hasPermission = await requestStoragePermission()
  if (!hasPermission) {
    webDAVLog.warn('handleWebDAVBatchDownload: storage permission denied')
    toast('请授予存储权限后重试', 'long')
    return []
  }

  const downloadDir = getDefaultDownloadDir()
  const downloadedPaths: string[] = []
  // 【第 28 轮】记下每一首的失败原因：原来只有一句「没有成功下载任何歌曲」，
  // 用户看不出是 302 直链的问题、鉴权问题还是磁盘问题。
  const failures: string[] = []

  webDAVLog.info('handleWebDAVBatchDownload: starting batch download', { songCount: songs.length, downloadDir })

  try {
    await mkdir(downloadDir)

    const headers = getWebDAVAuthHeaders()

    let currentIndex = 0
    for (const musicInfo of songs) {
      currentIndex++
      const fileName = musicInfo.meta.fileName
      const filePath = `${downloadDir}/${fileName}`

      if (onProgress) {
        onProgress(currentIndex, songs.length, fileName)
      }

      // 【第 28 轮】半截文件当「没下过」处理：判定统一走 drive.ts 的 getWebDAVFileState
      // （只 existsFile 的话，中断留下的半个文件会让每次点下载都静默跳过）。
      const fileState = await getWebDAVFileState(filePath, musicInfo.meta.size)
      const fileExists = fileState === 'complete'
      if (fileState === 'incomplete') {
        webDAVLog.warn('handleWebDAVBatchDownload: incomplete file found, removing and re-downloading', { filePath })
        await unlink(filePath).catch(() => {})
      }

      if (musicInfo.meta.filePath && !fileExists) {
        webDAVLog.info('handleWebDAVBatchDownload: file was deleted, clearing old filePath', { oldPath: musicInfo.meta.filePath })
        // 传 null 显式清空（传 undefined 会被 update 判断跳过，永远清不掉）
        await updateWebDAVMusicMeta(musicInfo.id, { filePath: null })
      }

      if (fileExists) {
        webDAVLog.info('handleWebDAVBatchDownload: file already exists, skipping', { filePath })
        downloadedPaths.push(filePath)

        await updateWebDAVMusicMeta(musicInfo.id, { filePath })
        continue
      }

      try {
        const downloadUrl = getWebDAVDownloadUrl(musicInfo)
        webDAVLog.info('handleWebDAVBatchDownload: downloading', { currentIndex, fileName, downloadUrl })

        // 【第 28 轮】改走第 26 轮的统一下载阶梯（直下 → 解析 302 直链 → 抛错）。
        // 这里原本是裸的 downloadFile(...).promise，整条菜单下载链路是唯一漏掉阶梯的地方：
        // 「连接换直链」型服务器上裸下拿不到字节，而播放预下载走的是同一个阶梯、同一条 URL，
        // 所以一直是「能播不能下」。（阶梯内部每次尝试前会先删目标文件，半截文件也一并清掉。）
        const usedUrl = await downloadWebDAVFile(downloadUrl, filePath, { headers })
        if (usedUrl !== downloadUrl) {
          webDAVLog.info('handleWebDAVBatchDownload: downloaded via resolved direct url', { fileName })
        }

        const fileMetadata = await readMetadata(filePath).catch(() => null)

        const updates: Record<string, any> = { filePath }

        if (fileMetadata) {
          if (fileMetadata.albumName) updates.albumName = fileMetadata.albumName
          if (fileMetadata.name && !musicInfo.name) updates.name = fileMetadata.name
          if (fileMetadata.singer && !musicInfo.singer) updates.singer = fileMetadata.singer
        }

        await updateWebDAVMusicMeta(musicInfo.id, updates)

        const picPath = await readPic(filePath).catch(() => null)
        if (picPath) {
          const newPicUrl = picPath.startsWith('/') ? `file://${picPath}` : picPath
          await updateWebDAVMusicMeta(musicInfo.id, { picUrl: newPicUrl })
        }

        downloadedPaths.push(filePath)
        webDAVLog.info('handleWebDAVBatchDownload: download completed', { currentIndex, fileName, filePath })
      } catch (error: any) {
        const message = getErrorMessage(error)
        failures.push(`${fileName}: ${message}`)
        webDAVLog.error('handleWebDAVBatchDownload: download failed', { fileName, message, error })
      }
    }

    webDAVLog.info('handleWebDAVBatchDownload: batch download completed', {
      downloadedCount: downloadedPaths.length,
      failedCount: failures.length,
    })
    if (failures.length) {
      webDAVLog.warn('handleWebDAVBatchDownload: failure samples', { first: failures.slice(0, 3) })
      // 全军覆没时说清原因（原来调用方只弹一句「没有成功下载任何歌曲」）
      if (downloadedPaths.length === 0 && songs.length > 0) {
        toast(`下载失败：${failures[0]}`, 'long')
      }
    }
    return downloadedPaths
  } catch (error: any) {
    webDAVLog.error('handleWebDAVBatchDownload: batch download failed', { message: getErrorMessage(error), error })
    throw error
  }
}

export const handleWebDAVDownloadAndImport = async(
  songs: LX.WebDAV.MusicInfo[],
  setLoadingText: (text: string) => void,
): Promise<void> => {
  if (songs.length === 0) {
    toast('没有可下载的歌曲')
    return
  }

  setLoadingText(`正在下载 0/${songs.length}...`)
  webDAVLog.info('handleWebDAVDownloadAndImport: starting process', { songCount: songs.length })

  try {
    const downloadedPaths = await handleWebDAVBatchDownload(songs, (current, total, fileName) => {
      setLoadingText(`正在下载 ${current}/${total}...\n${fileName}`)
    })

    if (downloadedPaths.length === 0) {
      // 【第 28 轮】这里原来只弹一句 toast 就 return，**没有清 setLoadingText**：
      // 标题上那行「正在下载 0/N...」会永久留着，而「扫描并下载」按钮的 disabled 条件里
      // 带着 `!!batchLoadingText` —— 于是下载功能从此点不动，只能重启 App，这就是
      // 「下载还是不行 / 再点也没反应」的终态。失败原因由 handleWebDAVBatchDownload
      // 汇总后自己弹（带具体错误），这里不再重复弹，只负责收拾状态。
      webDAVLog.warn('handleWebDAVDownloadAndImport: nothing downloaded, clearing loading text')
      setLoadingText('')
      return
    }

    webDAVLog.info('handleWebDAVDownloadAndImport: download completed', { downloadedCount: downloadedPaths.length })

    const files = downloadedPaths.map(path => {
      const name = path.split('/').pop() || ''
      return { path, name } as any
    })

    setLoadingText('正在添加到列表...')
    await addListMusics(
      LIST_IDS.DOWNLOAD,
      files.map(buildLocalMusicInfoByFilePath),
      settingState.setting['list.addMusicLocationType'],
    )

    toast(global.i18n.t('list_select_local_file_temp_add_tip', { total: files.length }), 'long')

    setLoadingText('正在读取音乐标签...')

    const createLocalMusicInfos = async(
      filePaths: string[],
      errorPath: string[],
    ): Promise<LX.Music.MusicInfoLocal[]> => {
      const list: LX.Music.MusicInfoLocal[] = []
      for (const batch of chunk(filePaths, 5)) {
        const results = await Promise.all(
          batch.map(async(path) => {
            const info = await readMetadata(path)
            const picPath = await readPic(path).catch(() => null)
            return { path, info, picPath }
          }),
        )
        for (const { path, info, picPath } of results) {
          if (!info) {
            errorPath.push(path)
            continue
          }
          list.push(buildLocalMusicInfo(path, info, picPath))
        }
      }
      return list
    }

    const createThrottleAddMusics = (
      add: (listId: string, musicInfos: LX.Music.MusicInfoLocal[]) => Promise<void>,
      remove: (listId: string, errorPath: string[]) => Promise<void>,
      listId: string,
    ) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let _musicInfos: LX.Music.MusicInfoLocal[] = []
      let _errorPath: string[] = []
      return (musicInfos: LX.Music.MusicInfoLocal[], errorPath?: string[]) => {
        if (musicInfos.length) _musicInfos.push(...musicInfos)
        if (errorPath) _errorPath.push(...errorPath)
        if (timer) return
        timer = setTimeout(async() => {
          timer = null
          const musicInfos = _musicInfos
          const errorPath = _errorPath
          _musicInfos = []
          _errorPath = []
          if (musicInfos.length) await add(listId, musicInfos)
          if (errorPath.length) await remove(listId, errorPath)
        }, 100)
      }
    }

    const handleUpdateMusics = async(
      filePaths: string[],
      throttleUpdateMusics: (musicInfos: LX.Music.MusicInfoLocal[], errorPath?: string[]) => void,
      index: number = -1,
      total: number = 0,
      errorPath: string[] = [],
    ) => {
      if (!total) total = filePaths.length
      const paths = filePaths.slice(index + 1, index + 11)
      const musicInfos = await createLocalMusicInfos(paths, errorPath)
      if (musicInfos.length) {
        throttleUpdateMusics(musicInfos)
        await updateListMusics(musicInfos.map((info) => ({ id: LIST_IDS.DOWNLOAD, musicInfo: info })))
      }
      setLoadingText(`正在读取标签 ${Math.min(index + 11, total)}/${total}...`)
      index += 10
      if (filePaths.length - 1 > index) { await handleUpdateMusics(filePaths, throttleUpdateMusics, index, total, errorPath) } else {
        if (errorPath.length) {
          toast(
            global.i18n.t('list_select_local_file_result_failed_tip', {
              total,
              success: total - errorPath.length,
              failed: errorPath.length,
            }),
            'long',
          )
        } else {
          toast(global.i18n.t('list_select_local_file_result_tip', { total }), 'long')
        }
        throttleUpdateMusics([], errorPath)
        setLoadingText('')
      }
    }

    const throttleUpdateMusics = createThrottleAddMusics(
      async(listId, musicInfos) => {
        return updateListMusics(musicInfos.map((info) => ({ id: listId, musicInfo: info })))
      },
      async(_listId, _errorPath) => {
        return Promise.resolve()
      },
      LIST_IDS.DOWNLOAD,
    )

    await handleUpdateMusics(downloadedPaths, throttleUpdateMusics)

    webDAVLog.info('handleWebDAVDownloadAndImport: all processes completed')
  } catch (error: any) {
    webDAVLog.error('handleWebDAVDownloadAndImport: process failed', { error: error.message })
    toast(`导入失败：${error.message}`, 'long')
    setLoadingText('')
  }
}

const getDefaultDownloadDir = () => {
  const settings = settingState.setting
  const webdavPath = settings['sync.webdav.downloadPath']
  if (webdavPath && typeof webdavPath === 'string' && webdavPath.trim()) {
    return webdavPath.trim()
  }
  return getWebDAVPrivateDirectory()
}

const buildLocalMusicInfo = (
  filePath: string,
  metadata: Awaited<ReturnType<typeof readMetadata>>,
  picPath: string | null,
): LX.Music.MusicInfoLocal => {
  const { nameWithoutExt, fileName } = parsePathForName(filePath)
  return {
    id: `local_${filePath}`,
    name: metadata?.name || nameWithoutExt,
    singer: metadata?.singer || '',
    albumName: metadata?.albumName || '',
    interval: metadata?.interval ? `${metadata.interval}s` : '',
    source: 'local' as const,
    meta: {
      picUrl: picPath ? (picPath.startsWith('/') ? `file://${picPath}` : picPath) : '',
      filePath,
      fileName,
    },
  } as unknown as LX.Music.MusicInfoLocal
}

const buildLocalMusicInfoByFilePath = (filePath: string): LX.Music.MusicInfoLocal => {
  const { nameWithoutExt, fileName } = parsePathForName(filePath)
  return {
    id: `local_${filePath}`,
    name: nameWithoutExt,
    singer: '',
    albumName: '',
    interval: '',
    source: 'local' as const,
    meta: {
      picUrl: '',
      fileName,
      // filePath 必须带上：下载列表先添加后补全标签的两段式流程中，
      // 中途任何播放/判断逻辑都依赖 meta.filePath 定位本地文件。
      filePath,
    },
  } as unknown as LX.Music.MusicInfoLocal
}

/**
 * 下载单首 WebDAV 歌曲，返回封面 URL
 *
 * 【第 28 轮】这个函数的成功路径原本**没有任何用户可见反馈**：不打日志、不弹提示、
 * 不写「下载列表」（addListMusics 只有批量那条路才调）—— 用户点 ⋮ 菜单的「下载」，
 * 看到的就是「什么都没发生」，于是「下载还是不行」。更糟的是失败分支里：
 * `existsFile` 只认「路径上有东西」，断点/取消留下的半截文件会让它永远为真，
 * 整段下载被静默跳过，连 `下载失败：xxx` 的提示都弹不出来。
 * 现在：入口落日志 → 半截文件先删掉 → 走第 26 轮统一下载阶梯 → 无论新下还是复用，
 * 都保证这首歌在「下载列表」里（listMusicAdd 按 id 去重，重复点不会有第二条）。
 */
export const handleWebDAVDownload = async(
  musicInfo: LX.WebDAV.MusicInfo,
): Promise<string | undefined> => {
  // 【第 29 轮】入口日志提到函数第一行，并且整段「下载前的准备」都套上 try/catch。
  // 原来日志排在 `musicInfo.meta.fileName` 之后：meta 缺字段时第一行就抛错 —— 日志一行没有、
  // toast 一句没有，调用方（列表页 handleDownload）当时也没有 catch，用户看到的就是
  // 「下载按钮按了没反应」。现在无论哪一步失败，都落日志 + 弹出具体原因。
  webDAVLog.info('handleWebDAVDownload: invoked', { musicId: musicInfo?.id, fileName: musicInfo?.meta?.fileName })

  let downloadDir = ''
  let fileName = ''
  let filePath = ''
  let fileState: WebDAVFileState
  try {
    downloadDir = getDefaultDownloadDir()
    fileName = musicInfo?.meta?.fileName ?? ''
    if (!fileName) {
      webDAVLog.warn('handleWebDAVDownload: missing fileName')
      toast('无法获取文件名')
      return undefined
    }
    filePath = `${downloadDir}/${fileName}`
    // 【第 28 轮】半截文件当「没下过」处理（判定统一走 drive.ts 的 getWebDAVFileState）
    fileState = await getWebDAVFileState(filePath, musicInfo.meta.size)
  } catch (error: any) {
    const message = getErrorMessage(error)
    webDAVLog.error('handleWebDAVDownload: prepare failed', { message, error })
    toast(`下载失败：${message}`, 'long')
    return undefined
  }

  const exists = fileState === 'complete'
  if (fileState === 'incomplete') {
    webDAVLog.warn('handleWebDAVDownload: incomplete file found, removing and re-downloading', { filePath })
    await unlink(filePath).catch(() => {})
  }

  let justDownloaded = false
  if (!exists) {
    try {
      const headers = getWebDAVAuthHeaders()

      const downloadUrl = getWebDAVDownloadUrl(musicInfo)
      webDAVLog.info('handleWebDAVDownload: downloading', { fileName, downloadUrl })
      await mkdir(downloadDir)
      // 【第 28 轮】和批量路径一样改走第 26 轮的阶梯（直下 → 解析 302 直链 → 抛错）。
      // 原来这里是裸的 downloadFile(...).promise —— 同一份 URL，「连接换直链」的服务器上
      // 播放预下载（走阶梯）能成功、菜单下载（不走阶梯）就失败，差别只在这个阶梯。
      const usedUrl = await downloadWebDAVFile(downloadUrl, filePath, { headers })
      if (usedUrl !== downloadUrl) {
        webDAVLog.info('handleWebDAVDownload: downloaded via resolved direct url', { fileName })
      }

      const fileMetadata = await readMetadata(filePath).catch(() => null)
      const updates: Record<string, any> = { filePath }
      if (fileMetadata) {
        if (fileMetadata.albumName) updates.albumName = fileMetadata.albumName
        if (fileMetadata.name && !musicInfo.name) updates.name = fileMetadata.name
        if (fileMetadata.singer && !musicInfo.singer) updates.singer = fileMetadata.singer
      }
      await updateWebDAVMusicMeta(musicInfo.id, updates)
      justDownloaded = true
    } catch (error: any) {
      const message = getErrorMessage(error)
      webDAVLog.error('handleWebDAVDownload: download failed', { fileName, message, error })
      toast(`下载失败：${message}`, 'long')
      return undefined
    }
  } else {
    webDAVLog.info('handleWebDAVDownload: file already complete, reuse it', { filePath })
  }

  // 【第 28 轮】落到磁盘还不够，得让它出现在「下载列表」里 —— 用户判断「下载成功没成功」
  // 就看那里面有没有这首歌。listMusicAdd 会按 id 过滤已存在的，重复点不会多出一条。
  try {
    await addListMusics(
      LIST_IDS.DOWNLOAD,
      [buildLocalMusicInfoByFilePath(filePath)],
      settingState.setting['list.addMusicLocationType'],
    )
    toast(justDownloaded ? '下载完成，已添加到下载列表' : '该歌曲已在下载列表')
    webDAVLog.info('handleWebDAVDownload: added to download list', { fileName, filePath, justDownloaded })
  } catch (error: any) {
    webDAVLog.warn('handleWebDAVDownload: add to download list failed', { message: getErrorMessage(error), error })
  }

  try {
    const picPath = await readPic(filePath).catch(() => null)
    if (picPath) {
      const newPicUrl = picPath.startsWith('/') ? `file://${picPath}` : picPath
      await updateWebDAVMusicMeta(musicInfo.id, { picUrl: newPicUrl })
      return newPicUrl
    }
  } catch {
    // ignore
  }

  return undefined
}

/**
 * 从在线音乐源获取封面
 */
export const handleFetchWebDAVPicFromOnline = async(
  musicInfo: LX.WebDAV.MusicInfo,
): Promise<string | undefined> => {
  try {
    const searchResult = await findMusic({
      name: musicInfo.name || '',
      singer: musicInfo.singer || '',
      albumName: musicInfo.meta.albumName || '',
      interval: musicInfo.interval || '',
      source: 'kw',
    })

    if (searchResult.length === 0) {
      toast('未找到匹配的在线歌曲')
      return undefined
    }

    const matched = searchResult[0] as LX.Music.MusicInfoOnline
    const result = await handleGetOnlinePicUrl({
      musicInfo: matched,
      isRefresh: true,
      onToggleSource: () => {},
      allowToggleSource: false,
    })

    if (result.url) {
      await updateWebDAVMusicMeta(musicInfo.id, { picUrl: result.url })
      return result.url
    }
  } catch (error: any) {
    webDAVLog.error('handleFetchWebDAVPicFromOnline: failed', { error: error.message })
    toast(`获取封面失败：${error.message}`, 'long')
  }

  return undefined
}

/**
 * 从 WebDAV 列表中移除歌曲
 */
export const handleWebDAVRemove = async(
  musicInfo: LX.WebDAV.MusicInfo,
): Promise<void> => {
  try {
    const config = await getWebDAVConfig()
    const songs = (config.songs || []).filter(s => s.id !== musicInfo.id)
    await saveWebDAVConfig({ ...config, songs })
    toast('已移除')
  } catch (error: any) {
    webDAVLog.error('handleWebDAVRemove: failed', { error: error.message })
    toast(`移除失败：${error.message}`, 'long')
  }
}
