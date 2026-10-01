import { saveLyric, saveMusicUrl, getMusicUrl as getStoreMusicUrl } from '@/utils/data'
import {
  setLastTryQuality,
  buildLyricInfo,
  getPlayQuality,
  handleGetOnlineLyricInfo,
  handleGetOnlineMusicUrl,
  handleGetOnlinePicUrl,
  getCachedLyricInfo, QUALITY_RANK,
} from './utils'
import { updateListMusics } from '@/core/list'
import settingState from '@/store/setting/state'

import wySdk from '@/utils/musicSdk/wy'

import { fetchAndApplyDetailedQuality } from '@/utils/musicSdk/wy/musicDetail.js'
import userState from '@/store/user/state'

/* export const setMusicUrl = ({ musicInfo, type, url }: {
  musicInfo: LX.Music.MusicInfo
  type: LX.Quality
  url: string
}) => {
  saveMusicUrl(musicInfo, type, url)
}

export const setPic = (datas: {
  listId: string
  musicInfo: LX.Music.MusicInfo
  url: string
}) => {
  datas.musicInfo.img = datas.url
  updateMusicInfo({
    listId: datas.listId,
    id: datas.musicInfo.songmid,
    data: { img: datas.url },
    musicInfo: datas.musicInfo,
  })
}
 */

// 取流并回传「链接 + 达成档」：quality 取自各分支实际达成（或缓存/请求已知）的档位，
// 供播放器（playerState.quality）与音质标使用；只要 url 的旧调用方走文件末尾的 getMusicUrl 包装。
export const getMusicUrlInfo = async({
  musicInfo,
  quality,
  isRefresh,
  allowToggleSource = true,
  onToggleSource = () => {},
  silent = false,
}: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  silent?: boolean
}): Promise<{ url: string, quality: LX.Quality | null }> => {
  // if (!musicInfo._types[type]) {
  //   if (!(musicInfo.source == 'kw' && type == '128k')) throw new Error('该歌曲没有可播放的音频')

  //   // return Promise.reject(new Error('该歌曲没有可播放的音频'))
  // }

  let currentMusicInfo = musicInfo
  const preferredQuality = settingState.setting['player.playQuality']

  const isWySource = currentMusicInfo.source === 'wy'
  const hasFullDetails = currentMusicInfo.meta._full
  if (!silent) console.log('播放：currentMusicInfo:', currentMusicInfo)

  if (isWySource && !hasFullDetails) {
    // 仅用于决定「是否向 wy 拉取音质详情」的位次判断：候选链已改为固定天梯、忽略 _qualitys
    // （utils.ts C-11-3），这里仍按 QUALITY_RANK（排序基准，含历史档）比位次，语义不变。
    // `?? {}` 兜底：详情缺失时 Object.keys(undefined) 会直接抛错，连带整条 wy 取链挂掉。
    const availableQualities = Object.keys(currentMusicInfo.meta._qualitys ?? {}) as LX.Quality[]
    const preferredQualityIndex = QUALITY_RANK.indexOf(preferredQuality)
    const maxAvailableQualityIndex = Math.min(...availableQualities.map(q => QUALITY_RANK.indexOf(q)))

    if (preferredQualityIndex < maxAvailableQualityIndex) {
      if (!silent) console.log('用户想要的音质比当前已知的最好音质还要高，获取音质详情')
      currentMusicInfo = await fetchAndApplyDetailedQuality(currentMusicInfo, 0, silent)
    } else {
      if (!silent) console.log('用户想要的音质比当前已知的最好音质还要低，无需获取音质详情')
      void fetchAndApplyDetailedQuality(currentMusicInfo, 0, silent)
    }
  }

  const targetQuality = quality ?? getPlayQuality(preferredQuality, currentMusicInfo)

  // 如果不是刷新请求，先检查缓存
  if (!isRefresh) {
    const cachedUrl = await getStoreMusicUrl(currentMusicInfo, targetQuality)
    if (cachedUrl) {
      setLastTryQuality(currentMusicInfo.id, targetQuality)
      // 缓存命中没有「本次请求回传的达成档」：缓存按档位为键存取（utils/data.ts saveMusicUrl/
      // getMusicUrl），targetQuality 命中的这条缓存链接本身就属于该档，用该已知档位兜底。
      return { url: cachedUrl, quality: targetQuality }
    }
  }

  const highQualityLevels: LX.Quality[] = ['flac', 'hires', 'master', 'atmos', 'atmos_plus']

  const isVipUser = userState.wy_vip_type !== 0
  const isVipSong = currentMusicInfo.meta.fee === 1
  const isHighQuality = highQualityLevels.includes(targetQuality)

  const preferApi = !isWySource || (!isVipUser && (isVipSong || isHighQuality))

  if (!silent) console.log('vip:' + userState.wy_vip_type)
  if (preferApi) {
    try {
      if (!silent) console.log('Attempting to get music URL via custom API')
      // 【C-11-3 配套】这里传「调用方显式档」而不是 targetQuality：
      // 未显式指定（播放主链路）→ 由 handleGetOnlineMusicUrl 按固定天梯从用户偏好档开始逐级降级；
      // 显式指定（下载 / 失败降级重试）→ 只请求该档。若传 targetQuality（它总非空）会把候选链
      // 卡成单档，固定天梯在本路径就失效了。
      const result = await handleGetOnlineMusicUrl({
        musicInfo: currentMusicInfo,
        quality,
        onToggleSource,
        isRefresh,
        allowToggleSource,
      })
      if (!silent) console.log('Custom API request succeeded', result)
      if (!silent) console.log('### [WHITEBOX_API_URL] 异步 URL 真正就绪 ###', { title: currentMusicInfo.name, songId: currentMusicInfo.id, url: result.url })
      void saveMusicUrl(currentMusicInfo, result.quality, result.url)
      setLastTryQuality(currentMusicInfo.id, result.quality)
      // result.quality 是 handleGetOnlineMusicUrl 回传的「达成档」（含固定天梯降级/换源结果），原样带出
      return { url: result.url, quality: result.quality }
    } catch (apiError) {
      if (!silent) console.log('Custom API request failed', apiError)
      throw apiError
    }
  }

  if (musicInfo.source == 'wy' && settingState.setting['common.wy_cookie']) {
    try {
      const { url } = await wySdk.cookie.getMusicUrl(currentMusicInfo, targetQuality).promise
      if (url) {
        void saveMusicUrl(currentMusicInfo, targetQuality, url)
        setLastTryQuality(currentMusicInfo.id, targetQuality)
        if (currentMusicInfo.id !== musicInfo.id) void saveMusicUrl(musicInfo, targetQuality, url)
        // cookie 接口不回传实际档位，与上方 setLastTryQuality 同口径，按请求档兜底
        return { url, quality: targetQuality }
      }
    } catch (error) {
      if (!silent) console.log('Get music url with cookie failed, fallback to custom api', error)
    }
  }

  return handleGetOnlineMusicUrl({
    musicInfo: currentMusicInfo,
    // 同上面的 preferApi 分支：传显式档而非 targetQuality，让固定天梯降级链生效
    quality,
    onToggleSource,
    isRefresh,
    allowToggleSource,
  }).then(({ url, quality: targetQuality, musicInfo: targetMusicInfo, isFromCache }) => {
    if (targetMusicInfo.id != currentMusicInfo.id && !isFromCache) { void saveMusicUrl(targetMusicInfo, targetQuality, url) }
    void saveMusicUrl(currentMusicInfo, targetQuality, url)
    setLastTryQuality(currentMusicInfo.id, targetQuality)
    if (currentMusicInfo.id !== musicInfo.id) void saveMusicUrl(musicInfo, targetQuality, url)
    // 这里的 targetQuality 来自 handleGetOnlineMusicUrl 回传的「达成档」（含换源结果），随 url 一起带出
    return { url, quality: targetQuality }
  })
}

// 兼容旧调用方：仍返回纯 url 字符串（列表下载 / 源测试 / download.ts 等直接调用点零改动）；
// 需要「达成档」的调用方改用上面的 getMusicUrlInfo
export const getMusicUrl = async(args: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  silent?: boolean
}): Promise<string> => getMusicUrlInfo(args).then(({ url }) => url)

export const getPicUrl = async({
  musicInfo,
  listId,
  isRefresh,
  allowToggleSource = true,
  onToggleSource = () => {},
}: {
  musicInfo: LX.Music.MusicInfoOnline
  listId?: string | null
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<string> => {
  if (musicInfo.meta.picUrl && !isRefresh) return musicInfo.meta.picUrl
  return handleGetOnlinePicUrl({ musicInfo, onToggleSource, isRefresh, allowToggleSource }).then(
    ({ url }) => {
      // picRequest = null
      if (listId) {
        musicInfo.meta.picUrl = url
        void updateListMusics([{ id: listId, musicInfo }])
      }
      // savePic({ musicInfo, url, listId })
      return url
    },
  )
}
export const getLyricInfo = async({
  musicInfo,
  isRefresh,
  allowToggleSource = true,
  onToggleSource = () => {},
}: {
  musicInfo: LX.Music.MusicInfoOnline
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<LX.Player.LyricInfo> => {
  let cachedLyricInfo: LX.Music.LyricInfo | null = null
  if (!isRefresh) {
    cachedLyricInfo = await getCachedLyricInfo(musicInfo)
    if (cachedLyricInfo) {
      const hasTranslation = !!(cachedLyricInfo.tlyric && cachedLyricInfo.tlyric.trim().length > 0)
      if (hasTranslation || musicInfo.source !== 'tx') {
        return buildLyricInfo(cachedLyricInfo)
      }
    }
  }
  // lrcRequest = music[musicInfo.source].getLyric(musicInfo)
  return handleGetOnlineLyricInfo({ musicInfo, onToggleSource, isRefresh, allowToggleSource }).then(
    async({ lyricInfo, musicInfo: targetMusicInfo, isFromCache }) => {
      if (isFromCache) return buildLyricInfo(lyricInfo)

      const apiHasTranslation = !!(lyricInfo.tlyric && lyricInfo.tlyric.trim().length > 0)
      if (!apiHasTranslation && cachedLyricInfo?.lyric) {
        const merged = { ...lyricInfo, lyric: lyricInfo.lyric || cachedLyricInfo.lyric }
        if (targetMusicInfo.id == musicInfo.id) void saveLyric(musicInfo, merged)
        else void saveLyric(targetMusicInfo, merged)
        return buildLyricInfo(merged)
      }

      if (targetMusicInfo.id == musicInfo.id) void saveLyric(musicInfo, lyricInfo)
      else void saveLyric(targetMusicInfo, lyricInfo)

      return buildLyricInfo(lyricInfo)
    },
  ).catch(async(err) => {
    if (cachedLyricInfo?.lyric) {
      return buildLyricInfo(cachedLyricInfo)
    }
    throw err
  })
}
