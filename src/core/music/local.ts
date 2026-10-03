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
import { unlink, stat, existsFile, readDir, readFile } from '@/utils/fs'
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

/**
 * 【第 28 轮】WebDAV 在线封面兜底搜索的并发闸 + 会话内失败备忘。
 *
 * 第 27 轮给 WebDAV 加的封面兜底是「一首歌一次跨平台搜索」，但封面分支的调用方是
 * **列表的每一行**（行挂载就会请求一次封面）。325 首的列表一进页面就等于瞬间发起
 * 几百次 findMusic，用户的日志里 17:25:14 那一片 `getOnlineOtherSourcePicByLocal failed`
 * 就是这场风暴（而且失败不记录，滚动一次就重来一轮）。
 * 这里加两道闸：
 *   ① 最多 2 个搜索在飞，其余排队 —— 把「几百并发」压成两条流水线；
 *   ② 本次会话内搜过且没结果的 歌名|歌手 记下来，不再重试（上限 300 条，满了整体清空重来）。
 * 不重试是刻意的取舍：失败多半是搜索源本身没这首歌或超时，连点没意义；
 * 用户想要单曲重试还有 ⋮ 菜单「在线封面」，那条路（handleFetchWebDAVPicFromOnline）
 * 不经过这里的备忘，随时可重试。
 */
const WEBDAV_COVER_SEARCH_CONCURRENCY = 2
const WEBDAV_COVER_MISS_CACHE_MAX = 300
let webdavCoverSearchActive = 0
const webdavCoverSearchQueue: Array<() => void> = []
const webdavCoverSearchMisses = new Set<string>()

const acquireWebdavCoverSearch = () => new Promise<void>((resolve) => {
  if (webdavCoverSearchActive < WEBDAV_COVER_SEARCH_CONCURRENCY) {
    webdavCoverSearchActive++
    resolve()
  } else {
    webdavCoverSearchQueue.push(() => {
      webdavCoverSearchActive++
      resolve()
    })
  }
})

const releaseWebdavCoverSearch = () => {
  const next = webdavCoverSearchQueue.shift()
  if (next) {
    // 名额直接转交给排队者，活跃计数保持不减（避免中间有别的搜索插队）
    next()
  } else {
    webdavCoverSearchActive--
  }
}

const getWebdavCoverMissKey = (musicInfo: LX.Music.MusicInfoLocal) =>
  `${musicInfo.name ?? ''}|${musicInfo.singer ?? ''}`

const markWebdavCoverMiss = (musicInfo: LX.Music.MusicInfoLocal) => {
  if (webdavCoverSearchMisses.size >= WEBDAV_COVER_MISS_CACHE_MAX) webdavCoverSearchMisses.clear()
  webdavCoverSearchMisses.add(getWebdavCoverMissKey(musicInfo))
}

/**
 * 【第 29 轮】清空「搜过没结果」的失败备忘。
 *
 * 第 28 轮的备忘是为了压住「列表逐行重发的搜索风暴」，但它的副作用正好是用户这一轮的抱怨：
 * 一首歌只要搜过一次没结果，之后**每次**进列表 / 扫描 / 刷新都会被上面那个 has() 直接跳过，
 * 于是「封面缺失或者未更新」的歌永远不会被自动补上，只能靠 ⋮ 菜单「在线封面」手动点。
 * 现在由列表页在每轮封面巡检开始时调用本函数：本次巡检把失败的首歌重新查一遍；
 * 请求量仍由下面的 2 并发闸（以及列表页的分批推进）收口，备忘在单轮巡检内继续生效
 * （行内 useCoverUrl 在巡检推进过程中再问同一首时，会把这一轮已经确认查不到的歌挡掉）。
 */
export const clearWebdavCoverMisses = () => {
  webdavCoverSearchMisses.clear()
}

/**
 * 【第 31 轮】只清**一首歌**的「搜过没结果」备忘（行内封面加载失败后的单曲自愈用）。
 *
 * 与上面的整表清空分工不同：整表清空只在列表页起一轮巡检时调用（一次），而单曲自愈发生在
 * 巡检推进过程中的任意时刻 —— 这时若调 clearWebdavCoverMisses()，会把**其他歌**这一轮
 * 刚记下的失败备忘一起抹掉，后面每一行都会把已经确认查不到的搜索重发一遍（第 28 轮
 * 那场「几百并发搜索风暴」就是这么回来的）。所以单曲自愈只删自己这一条 key，
 * 既不打断在飞的巡检，也不重置别人的进度；同时下一轮巡检开始时的整表清空仍然照旧
 * （每轮巡检依旧把失败歌重新查一遍）。 */
export const clearWebdavCoverMiss = (musicInfo: LX.Music.MusicInfoLocal) => {
  webdavCoverSearchMisses.delete(getWebdavCoverMissKey(musicInfo))
}

/**
 * 本地条目 → 在线候选的多轮匹配（原样 → 「歌名-歌手」两种拆法 → 文件名两种拆法 →
 * 只按歌名模糊），每轮把候选交给 handler，handler 抛错就换下一轮。
 * 【第 31 轮】改为导出：localPlay（本地与下载专用链路）的在线歌词匹配复用它，
 * 治「本地文件名把歌名/歌手拆反 → 换源/歌词全搜不到」这一类问题（见 localPlay.matchOnlineLyric）。
 */
export const getOtherSourceByLocal = async <T>(
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
    const module = await loadWebDAVModule()
    // 用户手动下载的文件优先（离线可播）
    if (webDAVMusicInfo.meta.filePath) {
      // 【第 28 轮】这里原来只 existsFile 一下 —— 下载中断/取消留下的半截文件永远是 true，
      // 于是每次点播都把这个坏文件直接交给播放器（「点了没反应/播一下就停」），而且因为
      // 就地 return，连下面那行「downloaded to local for playback」都不会打，日志里一片安静。
      // 现在按字节数判定：半截的删掉，交给下面的预下载重新拿一份完整的。
      const fileState = await module.getWebDAVFileState(webDAVMusicInfo.meta.filePath, webDAVMusicInfo.meta.size)
      if (fileState === 'complete') return webDAVMusicInfo.meta.filePath
      if (fileState === 'incomplete') {
        webDAVLog?.warn('getMusicUrl: incomplete downloaded file removed, falling back to pre-download', {
          filePath: webDAVMusicInfo.meta.filePath,
        })
        await unlink(webDAVMusicInfo.meta.filePath).catch(() => {})
      }
    }
    // 未下载：整文件预下载到本地缓存后播放。
    // iOS 的 AVPlayer 无法可靠注入 Authorization/User-Agent，直链流式不稳定，
    // 改用 downloadFile 先下载再播放本地文件；失败即抛错，不走自定义源换源。
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
    // 【第 28 轮】搜过没结果的歌（失败备忘）直接跳过搜索：列表是逐行要封面的，同一首"查过没有"的
    // 歌反复重发 findMusic 搜索毫无意义（见文件上方 WEBDAV_COVER_SEARCH_* 注释）。
    if (webdavCoverSearchMisses.has(getWebdavCoverMissKey(musicInfo))) {
      webDAVLog?.info('getPicUrl: WebDAV cover search skipped (known miss)', { musicId: musicInfo.id })
    } else {
      // 【第 28 轮】没搜过的进并发闸，最多 WEBDAV_COVER_SEARCH_CONCURRENCY 个搜索同时飞
      await acquireWebdavCoverSearch()
      try {
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

        // 【第 28 轮】搜不到就记进备忘，本会话内不再为这首歌重发搜索（上限见 WEBDAV_COVER_MISS_CACHE_MAX）
        markWebdavCoverMiss(musicInfo)
      } finally {
        releaseWebdavCoverSearch()
      }
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
