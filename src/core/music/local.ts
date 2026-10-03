import { saveLyric, saveMusicUrl, getPlayerLyric } from '@/utils/data'
import {
  buildLyricInfo,
  getCachedLyricInfo,
  getOnlineOtherSourceLyricByLocal,
  getOnlineOtherSourceLyricInfo,
  getOnlineOtherSourceMusicUrl,
  getOnlineOtherSourceMusicUrlByLocal,
  getOnlineOtherSourcePicByLocal,
  getOnlineOtherSourcePicUrl,
  getOtherSource,
} from './utils'
import { getLocalFilePath } from '@/utils/music'
import { readLyric, readPic } from '@/utils/localMediaMetadata'
import { stat, existsFile, readDir, readFile } from '@/utils/fs'
import { searchMusic } from '@/utils/musicSdk'
import { toNewMusicInfo } from '@/utils'
import settingState from '@/store/setting/state'
import type * as WebDAVDriveModule from '@/core/webdavMusic/drive'
const appEvent = global.app_event

let webDAVModule: typeof WebDAVDriveModule | null = null
let webDAVLog: {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
} | null = null

const loadWebDAVModule = async() => {
  if (!webDAVModule) {
    webDAVModule = await import('@/core/webdavMusic/drive')
    const logger = await import('@/core/webdavMusic/logger')
    webDAVLog = logger.webDAVLog
  }
  return webDAVModule
}

const getOtherSourceByLocal = async <T>(
  musicInfo: LX.Music.MusicInfoLocal,
  handler: (infos: LX.Music.MusicInfoOnline[]) => Promise<T>,
) => {
  let result: LX.Music.MusicInfoOnline[] = []

  const tryHandler = async(sources: LX.Music.MusicInfoOnline[]) => {
    if (sources.length) {
      try {
        return await handler(sources)
      } catch {}
    }
    return null
  }

  result = await getOtherSource(musicInfo)
  const handlerResult = await tryHandler(result)
  if (handlerResult !== null) return handlerResult

  if (musicInfo.name.includes('-')) {
    const [name, singer] = musicInfo.name.split('-').map((val) => val.trim())
    result = await getOtherSource(
      {
        ...musicInfo,
        name,
        singer,
      },
      true,
    )
    const handlerResult1 = await tryHandler(result)
    if (handlerResult1 !== null) return handlerResult1

    result = await getOtherSource(
      {
        ...musicInfo,
        name: singer,
        singer: name,
      },
      true,
    )
    const handlerResult2 = await tryHandler(result)
    if (handlerResult2 !== null) return handlerResult2
  }

  let fileName =
    (await stat(musicInfo.meta.filePath).catch(() => ({ name: null }))).name ??
    musicInfo.meta.filePath.split(/\/|\\/).at(-1)
  if (fileName) {
    fileName = fileName.substring(0, fileName.lastIndexOf('.'))
    if (fileName != musicInfo.name) {
      if (fileName.includes('-')) {
        const [name, singer] = fileName.split('-').map((val) => val.trim())
        result = await getOtherSource(
          {
            ...musicInfo,
            name,
            singer,
          },
          true,
        )
        const handlerResult3 = await tryHandler(result)
        if (handlerResult3 !== null) return handlerResult3

        result = await getOtherSource(
          {
            ...musicInfo,
            name: singer,
            singer: name,
          },
          true,
        )
        const handlerResult4 = await tryHandler(result)
        if (handlerResult4 !== null) return handlerResult4
      } else {
        result = await getOtherSource(
          {
            ...musicInfo,
            name: fileName,
            singer: '',
          },
          true,
        )
        const handlerResult5 = await tryHandler(result)
        if (handlerResult5 !== null) return handlerResult5
      }
    }
  }

  const fuzzyResults = await searchMusic({
    name: musicInfo.name,
    singer: '',
    source: '',
  })

  if (fuzzyResults.length > 0) {
    const allOnlineResults: LX.Music.MusicInfoOnline[] = []
    for (const source of fuzzyResults) {
      allOnlineResults.push(...source.list.map((s: any) => toNewMusicInfo(s) as LX.Music.MusicInfoOnline))
    }

    const sortedResults = allOnlineResults.sort((a, b) => {
      const name = musicInfo.name.toLowerCase()
      const aMatch = a.name.toLowerCase().includes(name) || name.includes(a.name.toLowerCase())
      const bMatch = b.name.toLowerCase().includes(name) || name.includes(b.name.toLowerCase())
      if (aMatch && !bMatch) return -1
      if (!aMatch && bMatch) return 1
      return 0
    })

    const handlerResult6 = await tryHandler(sortedResults)
    if (handlerResult6 !== null) return handlerResult6
  }

  throw new Error('source not found')
}

export const getMusicUrl = async({
  musicInfo,
  isRefresh,
  allowToggleSource = true,
  onToggleSource = () => {},
}: {
  musicInfo: LX.Music.MusicInfoLocal
  isRefresh: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  allowToggleSource?: boolean
}): Promise<string> => {
  const isWebDAV = 'webdav' in musicInfo.meta && (musicInfo.meta as any).webdav === true
  if (isWebDAV) {
    const webDAVMusicInfo = musicInfo as LX.WebDAV.MusicInfo
    // 用户手动下载的文件优先（离线可播）
    if (webDAVMusicInfo.meta.filePath) {
      const localExists = await existsFile(webDAVMusicInfo.meta.filePath).catch(() => false)
      if (localExists) return webDAVMusicInfo.meta.filePath
    }
    // 未下载：整文件预下载到本地缓存后播放。
    // iOS 的 AVPlayer 无法可靠注入 Authorization/User-Agent，直链流式不稳定，
    // 改用 downloadFile 先下载再播放本地文件；失败即抛错，不走自定义源换源。
    const module = await loadWebDAVModule()
    const localPath = await module.downloadWebDAVMusic(webDAVMusicInfo)
    webDAVLog?.info('getMusicUrl: WebDAV downloaded to local for playback', { musicId: musicInfo.id })
    return localPath
  }

  if (!isRefresh) {
    const path = await getLocalFilePath(musicInfo)
    if (path) return path
  }

  try {
    return await getOnlineOtherSourceMusicUrlByLocal(musicInfo, isRefresh).then(
      ({ url, quality, isFromCache }) => {
        if (!isFromCache) void saveMusicUrl(musicInfo, quality, url)
        return url
      },
    )
  } catch {}

  if (!allowToggleSource) throw new Error('failed')

  onToggleSource()
  return getOtherSourceByLocal(musicInfo, async(otherSource) => {
    return getOnlineOtherSourceMusicUrl({
      musicInfos: [...otherSource],
      onToggleSource,
      isRefresh,
    }).then(({ url, quality: targetQuality, musicInfo: targetMusicInfo, isFromCache }) => {
      // saveLyric(musicInfo, data.lyricInfo)
      if (!isFromCache) void saveMusicUrl(targetMusicInfo, targetQuality, url)

      // TODO: save url ?
      return url
    })
  })
}

export const getPicUrl = async({
  musicInfo,
  listId: _listId,
  isRefresh,
  skipFilePic,
  onToggleSource = () => {},
}: {
  musicInfo: LX.Music.MusicInfoLocal
  listId?: string | null
  isRefresh: boolean
  skipFilePic?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<string> => {
  const isWebDAVMusic = 'webdav' in musicInfo.meta && (musicInfo.meta as any).webdav === true

  if (!isRefresh && !skipFilePic) {
    if (isWebDAVMusic) {
      // 网盘内封面文件优先（同目录同名 / 目录通用封面），下载到本地缓存
      try {
        const module = await loadWebDAVModule()
        const picUrl = await module.fetchWebDAVPic(musicInfo as LX.WebDAV.MusicInfo)
        if (picUrl) return picUrl
      } catch (err) {
        webDAVLog?.warn('getPicUrl: fetchWebDAVPic failed', { err })
      }

      const { picCachePath, readPic: extractPic } = await import('@/utils/localMediaMetadata')

      const audioFileName = (musicInfo.meta as any).fileName?.replace(/\.[^/.]+$/, '') || musicInfo.name
      const coverExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
      let foundPicUrl = ''

      try {
        const coverFiles = await readDir(picCachePath).catch(() => [])
        for (const file of coverFiles) {
          const fileName = file.name || ''
          const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase()
          const baseName = fileName.substring(0, fileName.lastIndexOf('.'))

          if (coverExtensions.includes(ext) && baseName.includes(audioFileName)) {
            foundPicUrl = `file://${picCachePath}/${fileName}`
            break
          }
        }
      } catch (err) {
        webDAVLog?.warn('getPicUrl: failed to read cover cache dir', { err })
      }

      if (foundPicUrl) {
        return foundPicUrl
      }

      const webdavPath = settingState.setting['webdav.downloadPath']
      let downloadDir = ''
      if (webdavPath && typeof webdavPath === 'string' && webdavPath.trim()) {
        downloadDir = webdavPath.trim()
      } else {
        const { getWebDAVPrivateDirectory } = await import('@/utils/fs')
        downloadDir = getWebDAVPrivateDirectory()
      }
      const audioFilePath = musicInfo.meta.filePath
      let targetFilePath = audioFilePath

      if (audioFilePath) {
        const audioExists = await existsFile(audioFilePath).catch(() => false)
        if (!audioExists) {
          targetFilePath = `${downloadDir}/${(musicInfo.meta as any).fileName}`
        }
      } else {
        targetFilePath = `${downloadDir}/${(musicInfo.meta as any).fileName}`
      }

      const targetExists = await existsFile(targetFilePath).catch(() => false)
      if (targetExists) {
        try {
          const pic = await extractPic(targetFilePath)
          if (pic) {
            const picUrl = pic.startsWith('/') ? `file://${pic}` : pic
            webDAVLog?.info('getPicUrl: extracted cover from audio', { picUrl })

            const module = await loadWebDAVModule()
            void module.updateWebDAVMusicMeta(musicInfo.id, { picUrl })

            appEvent.webdavPicUpdated(musicInfo.id, picUrl)

            return picUrl
          }
        } catch (err) {
          webDAVLog?.warn('getPicUrl: failed to extract cover', { err })
        }
      } else {
        webDAVLog?.warn('getPicUrl: audio file not found in download dir', { targetFilePath })
      }

      if (musicInfo.meta.picUrl) {
        if (musicInfo.meta.picUrl.startsWith('file://')) {
          const picFilePath = musicInfo.meta.picUrl.replace('file://', '')
          const picExists = await existsFile(picFilePath).catch(() => false)
          if (picExists) {
            webDAVLog?.info('getPicUrl: using cached picUrl', { picUrl: musicInfo.meta.picUrl })
            return musicInfo.meta.picUrl
          }
        } else {
          webDAVLog?.info('getPicUrl: using online picUrl', { picUrl: musicInfo.meta.picUrl })
          return musicInfo.meta.picUrl
        }
      }
      // 【第 25 轮】这里此前是 `return ''` —— 网盘内没有封面文件（也没有已下载音频的内嵌封面）时
      // 直接返回空，**根本走不到下面那段在线匹配**，于是列表里永远是灰占位。
      // 现在落到下面的 getOnlineOtherSourcePicByLocal（按 歌名+歌手 在线匹配封面），
      // 匹配失败再由末尾的 `if (isWebDAVMusic) return ''` 收口。
      webDAVLog?.info('getPicUrl: no pan cover found, try online match')
    }

    let pic = await readPic(musicInfo.meta.filePath).catch(() => null)
    if (pic) {
      if (pic.startsWith('/')) pic = `file://${pic}`
      return pic
    }

    if (musicInfo.meta.picUrl) return musicInfo.meta.picUrl
  }

  try {
    const result = await getOnlineOtherSourcePicByLocal(musicInfo)
    webDAVLog?.info('getPicUrl: fetched online cover', { url: result.url })
    // 【第 25 轮】在线匹配到的封面写回歌曲 meta 并落盘（updateWebDAVMusicMeta → WebDAV 配置），
    // 即「将封面存入缓存」（用户原话）。与上面「已下载音频的内嵌封面」那条路径同口径
    // （同样 updateWebDAVMusicMeta + webdavPicUpdated 广播），区别只是封面来源是在线匹配。
    // 写回之后：① WebDAV 列表行收到 webdavPicUpdated 立刻换成在线封面；② 下次进列表
    // meta.picUrl 已在，命中上面的分支直接返回，不再重发在线匹配；③ 播放时整份列表写入
    // 试听列表，这份 meta.picUrl 跟着进快照 ⇒ 试听列表里也显示同一张封面。
    // 落盘是 fire-and-forget：不挡当前这一帧的封面显示。
    if (isWebDAVMusic && result.url) {
      void (async() => {
        try {
          const module = await loadWebDAVModule()
          await module.updateWebDAVMusicMeta(musicInfo.id, { picUrl: result.url })
          appEvent.webdavPicUpdated(musicInfo.id, result.url)
        } catch (err) {
          webDAVLog?.warn('getPicUrl: persist online cover failed', { err })
        }
      })()
    }
    // 【第 27 轮】原来是 `return result.url` 无条件返回 —— 自定义源匹配到歌曲但拿不到封面时
    // url 是空串，也会照样 return，把下面的搜索兜底整条跳过。现在空串就往下走。
    if (result.url) return result.url
  } catch (err) {
    webDAVLog?.warn('getPicUrl: getOnlineOtherSourcePicByLocal failed', { err })
  }

  // 【第 27 轮】WebDAV 自动在线封面兜底。apis('local')（getOnlineOtherSourcePicByLocal）只在
  // 用户加载了声明 local 源的自定义源脚本时才有实现，没有就是 `Api is not found` 直接抛错，
  // 于是「扫描/刷新自动补封面」永远走空 —— 只有 ⋮ 菜单「从在线获取封面」能用，因为那条路走的是
  // findMusic + 内置平台接口。这里把兜底换成和菜单同一条链路：
  //   getOtherSourceByLocal = getOtherSource（findMusic 跨平台搜索）+ 内置平台 getPic，
  //   并且自带 歌名/歌手 互换、文件名拆分、"歌名-歌手"拆分、模糊搜索 多轮重试
  //   （见本文件 getOtherSourceByLocal，与普通本地音乐用的是同一个函数）。
  // onToggleSource 传空函数：WebDAV 歌曲不换源，只要封面（与菜单 allowToggleSource:false 同口径）。
  // 匹配到的封面同样写回 meta 并落盘（updateWebDAVMusicMeta + webdavPicUpdated 广播），
  // 所以列表行立刻换图、下次进列表不再重发、试听列表也跟着显示。
  if (isWebDAVMusic) {
    const matchedUrl = await getOtherSourceByLocal(musicInfo, async(otherSource) => {
      const { url } = await getOnlineOtherSourcePicUrl({
        musicInfos: [...otherSource],
        onToggleSource: () => {},
        isRefresh,
      })
      // 空串当失败处理，好让 getOtherSourceByLocal 继续用下一套 歌名/歌手 组合重试
      if (!url) throw new Error('empty cover url')
      return url
    }).catch(() => '')

    if (matchedUrl) {
      webDAVLog?.info('getPicUrl: WebDAV cover matched by online search', { url: matchedUrl })
      void (async() => {
        try {
          const module = await loadWebDAVModule()
          await module.updateWebDAVMusicMeta(musicInfo.id, { picUrl: matchedUrl })
          appEvent.webdavPicUpdated(musicInfo.id, matchedUrl)
        } catch (err) {
          webDAVLog?.warn('getPicUrl: persist searched cover failed', { err })
        }
      })()
      return matchedUrl
    }

    // 云盘（WebDAV）不走自定义源换源，搜索兜底也空就返回空
    return ''
  }

  onToggleSource()
  return getOtherSourceByLocal(musicInfo, async(otherSource) => {
    return getOnlineOtherSourcePicUrl({
      musicInfos: [...otherSource],
      onToggleSource,
      isRefresh,
    }).then(async({ url }) => {
      return url
    })
  })
}

const getMusicFileLyric = async(filePath: string) => {
  const lyric = await readLyric(filePath).catch(() => null)
  if (!lyric) return null
  return {
    lyric,
  }
}

// 读取音频文件同目录的同名 .lrc 歌词（离线可用）
const getSidecarLyric = async(filePath: string): Promise<string | null> => {
  if (!filePath) return null
  const base = filePath.substring(0, filePath.lastIndexOf('.'))
  if (!base) return null
  for (const ext of ['.lrc', '.LRC']) {
    try {
      if (await existsFile(`${base}${ext}`)) {
        const content = await readFile(`${base}${ext}`)
        if (content) return content
      }
    } catch {}
  }
  return null
}
export const getLyricInfo = async({
  musicInfo,
  isRefresh,
  skipFileLyric,
  onToggleSource = () => {},
}: {
  musicInfo: LX.Music.MusicInfoLocal
  skipFileLyric?: boolean
  isRefresh: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<LX.Player.LyricInfo> => {
  const isWebDAVMusic = 'webdav' in musicInfo.meta && (musicInfo.meta as any).webdav === true

  if (!isRefresh && !skipFileLyric) {
    if (isWebDAVMusic) {
      const playerLyricInfo = await getPlayerLyric(musicInfo)
      if (playerLyricInfo?.lyric && playerLyricInfo.rawlrcInfo?.lyric !== playerLyricInfo.lyric) {
        webDAVLog?.info('getLyricInfo: WebDAV music using edited lyric', { musicId: musicInfo.id })
        return buildLyricInfo(playerLyricInfo)
      }

      // 网盘内同名 .lrc 歌词优先（同目录同名匹配）
      try {
        const module = await loadWebDAVModule()
        const lrcText = await module.fetchWebDAVLrc(musicInfo as LX.WebDAV.MusicInfo)
        if (lrcText) {
          webDAVLog?.info('getLyricInfo: WebDAV music using pan lrc', { musicId: musicInfo.id })
          void saveLyric(musicInfo, { lyric: lrcText })
          return buildLyricInfo({ lyric: lrcText })
        }
      } catch (err) {
        webDAVLog?.warn('getLyricInfo: fetchWebDAVLrc failed', { err })
      }

      const lyricInfo = await getCachedLyricInfo(musicInfo)
      if (lyricInfo?.lyric) {
        webDAVLog?.info('getLyricInfo: WebDAV music using cached lyric', { musicId: musicInfo.id })
        return buildLyricInfo(lyricInfo)
      }

      const webdavPath = settingState.setting['webdav.downloadPath']
      let downloadDir = ''
      if (webdavPath && typeof webdavPath === 'string' && webdavPath.trim()) {
        downloadDir = webdavPath.trim()
      } else {
        const { getWebDAVPrivateDirectory } = await import('@/utils/fs')
        downloadDir = getWebDAVPrivateDirectory()
      }
      const audioFilePath = musicInfo.meta.filePath
      let targetFilePath = audioFilePath

      if (audioFilePath) {
        const audioExists = await existsFile(audioFilePath).catch(() => false)
        if (!audioExists) {
          targetFilePath = `${downloadDir}/${(musicInfo.meta as any).fileName}`
        }
      } else {
        targetFilePath = `${downloadDir}/${(musicInfo.meta as any).fileName}`
      }

      const targetExists = await existsFile(targetFilePath).catch(() => false)
      if (targetExists) {
        webDAVLog?.info('getLyricInfo: WebDAV music reading lyric from local file', { targetFilePath })
        const rawlrcInfo = await getMusicFileLyric(targetFilePath)
        if (rawlrcInfo) {
          webDAVLog?.info('getLyricInfo: WebDAV music found embedded lyric', { musicId: musicInfo.id })
          return buildLyricInfo(rawlrcInfo)
        }
      }
      webDAVLog?.info('getLyricInfo: WebDAV music fetching lyric from online source', { musicId: musicInfo.id })
      try {
        return await getOnlineOtherSourceLyricByLocal(musicInfo, isRefresh).then(
          async({ lyricInfo, isFromCache }) => {
            if (!isFromCache) void saveLyric(musicInfo, lyricInfo)
            webDAVLog?.info('getLyricInfo: WebDAV music fetched lyric successfully', { musicId: musicInfo.id })
            return buildLyricInfo(lyricInfo)
          },
        )
      } catch (err) {
        webDAVLog?.warn('getLyricInfo: WebDAV music online lyric fetch failed', { err })
      }

      // 【第 27 轮】歌词补齐兜底。上面 getOnlineOtherSourceLyricByLocal 内部走的也是 apis('local')
      // （只在用户加载了声明 local 源的自定义源脚本时才有实现），没有就是 `Api is not found`，
      // 于是 WebDAV 歌曲永远落回下面那句空歌词 —— 播放时列表里就是"无歌词"。
      // 这里补上与普通本地音乐同一条链路（见本文件末尾普通本地分支）：
      //   getOtherSourceByLocal = getOtherSource（findMusic 跨平台搜索）+ 内置平台 getLyric，
      //   自带 歌名/歌手 互换、文件名拆分、"歌名-歌手"拆分、模糊搜索 多轮重试。
      // getOnlineOtherSourceLyricInfo 会用 existTimeExp 校验"必须带时间轴"，纯文本歌词自动判失败
      // 并换下一个候选；拿到的歌词 saveLyric 落在 musicInfo.id 上，下次进来 :435 的缓存直接命中。
      const matchedLyricInfo = await getOtherSourceByLocal(musicInfo, async(otherSource) => {
        const { lyricInfo: matchedLyric, isFromCache } = await getOnlineOtherSourceLyricInfo({
          musicInfos: [...otherSource],
          onToggleSource: () => {},
          isRefresh,
        })
        if (!matchedLyric?.lyric) throw new Error('empty lyric')
        if (!isFromCache) void saveLyric(musicInfo, matchedLyric)
        return buildLyricInfo(matchedLyric)
      }).catch(() => null)

      if (matchedLyricInfo) {
        webDAVLog?.info('getLyricInfo: WebDAV music lyric matched by online search', { musicId: musicInfo.id })
        return matchedLyricInfo
      }

      // 云盘（WebDAV）不走自定义源换源，搜索兜底也空就返回空歌词
      return buildLyricInfo({ lyric: '' })
    }

    const playerLyricInfo = await getPlayerLyric(musicInfo)
    if (playerLyricInfo?.lyric && playerLyricInfo.rawlrcInfo?.lyric !== playerLyricInfo.lyric) {
      return buildLyricInfo(playerLyricInfo)
    }

    const rawlrcInfo = await getMusicFileLyric(musicInfo.meta.filePath)
    if (rawlrcInfo) return buildLyricInfo(rawlrcInfo)

    const sidecarLyric = await getSidecarLyric(musicInfo.meta.filePath)
    if (sidecarLyric) return buildLyricInfo({ lyric: sidecarLyric })

    const lyricInfo = await getCachedLyricInfo(musicInfo)
    if (lyricInfo?.lyric) return buildLyricInfo(lyricInfo)
  }

  try {
    return await getOnlineOtherSourceLyricByLocal(musicInfo, isRefresh).then(
      async({ lyricInfo, isFromCache }) => {
        if (!isFromCache) void saveLyric(musicInfo, lyricInfo)
        return buildLyricInfo(lyricInfo)
      },
    )
  } catch {}

  onToggleSource()
  return getOtherSourceByLocal(musicInfo, async(otherSource) => {
    return getOnlineOtherSourceLyricInfo({
      musicInfos: [...otherSource],
      onToggleSource,
      isRefresh,
    }).then(async({ lyricInfo, musicInfo: targetMusicInfo, isFromCache }) => {
      void saveLyric(musicInfo, lyricInfo)

      if (isFromCache) return buildLyricInfo(lyricInfo)
      void saveLyric(targetMusicInfo, lyricInfo)

      return buildLyricInfo(lyricInfo)
    })
  })
}
