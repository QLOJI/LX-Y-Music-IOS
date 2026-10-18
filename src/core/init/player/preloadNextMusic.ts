import { getLyricInfo, getMusicUrlInfo } from '@/core/music'
import { removeMusicUrlAll } from '@/core/music/utils'
import { getNextPlayMusicInfo, resetRandomNextMusicInfo } from '@/core/player/player'
import { startPreload } from '@/core/player/preload'
import { checkUrl } from '@/utils/request'
import playerState from '@/store/player/state'
import { isCached } from '@/plugins/player/utils'
import { prefetchNativeFlacPlayback } from '@/plugins/player/nativeFlac'
import { onPreloadNext } from '@/utils/nativeModules/utils'


const preloadMusicInfo = {
  isLoading: false,
  preProgress: 0,
  // 竞态保护（对齐上游 usePreloadNextMusic 的 requestId）：每次发起预加载递增，
  // 异步各步回来后校验——期间切歌/失效时旧结果全部作废，不会把旧歌的 info 挂进来
  requestId: 0,
  info: null as LX.Player.PlayMusicInfo | null,
}
const resetPreloadInfo = () => {
  // request 递增而非归零：让所有在途异步结果因 id 不匹配而作废（含归零后的旧请求）
  preloadMusicInfo.requestId++
  preloadMusicInfo.preProgress = 0
  preloadMusicInfo.info = null
  preloadMusicInfo.isLoading = false
}
const warmPreloadUrl = async(musicInfo: LX.Player.PlayMusic, url: string, quality?: LX.Quality | null) => {
  if (await prefetchNativeFlacPlayback(musicInfo, url, quality)) return

  const [cached, available] = await Promise.all([
    isCached(url),
    checkUrl(url).then(() => true).catch(() => false),
  ])
  if (!cached && !available) throw new Error('preload unavailable')
}
const preloadNextMusicUrl = async(curTime: number) => {
  if (preloadMusicInfo.isLoading || curTime - preloadMusicInfo.preProgress < 2) return
  const currentMusicId = playerState.musicInfo.id
  if (!currentMusicId) return

  // 【第 124 轮】最后 10 秒的取链不再受「音频预加载」开关门控：这条是用户点名的
  // 核心行为（取下一首链接、下首直接复用缓存），与参考工程一致 —— 参考工程的
  // usePreloadNextMusic 里也没有这道开关；开关只控制 core/player/preload.ts 的完整
  // 预加载（歌词预取 + 换源兜底链）。此前一旦持久化值为 false，整条取链就静默失踪。

  preloadMusicInfo.isLoading = true
  const requestId = ++preloadMusicInfo.requestId
  preloadMusicInfo.preProgress = curTime
  console.log('preload next music url')
  const info = await getNextPlayMusicInfo().catch(() => null)
  if (!info || requestId !== preloadMusicInfo.requestId || playerState.musicInfo.id !== currentMusicId) {
    if (requestId === preloadMusicInfo.requestId) preloadMusicInfo.isLoading = false
    return
  }

  preloadMusicInfo.info = info
  let warmed = false
  const urlInfo = await getMusicUrlInfo({ musicInfo: info.musicInfo }).catch(() => null)
  if (urlInfo?.url) {
    console.log('preload url', urlInfo.url)
    try {
      if (requestId !== preloadMusicInfo.requestId) return
      await warmPreloadUrl(info.musicInfo, urlInfo.url, urlInfo.quality)
      warmed = true
    } catch {
      // 【第 53 轮第 2 条】预热失败 = 这条链接不可用：先把它的缓存整体作废再重取。
      // 不作废的话，下一次播放这首歌时读缓存仍会**首选命中**这条坏链（预取写入的坏链
      // 与重取到的好链可能落在不同档位的键上，见 core/music/utils.removeMusicUrlAll 的
      // 两段式说明），于是「先拿坏链试一次、再重新请求一次」的循环永远打不破——
      // 与用户要求的「链接可用就沿用缓存、别再取链」正好相反。
      await removeMusicUrlAll(info.musicInfo).catch(() => {})
      const refreshedUrlInfo = await getMusicUrlInfo({ musicInfo: info.musicInfo, isRefresh: true }).catch(() => null)
      console.log('preload url refresh', refreshedUrlInfo?.url ?? '')
      if (requestId !== preloadMusicInfo.requestId) return
      if (refreshedUrlInfo?.url) {
        try {
          await warmPreloadUrl(info.musicInfo, refreshedUrlInfo.url, refreshedUrlInfo.quality)
          warmed = true
        } catch {}
      }
    }
  }
  if (requestId === preloadMusicInfo.requestId) {
    preloadMusicInfo.isLoading = false
    // 【第 123 轮】这一轮没拿到可用链接（取链失败 / 预热失败）不占 memo：后面的进度拍
    // （2s 防重入后）还能再试一次，不会因为一次网络抖动就整首不再预取。
    if (!warmed) preloadMusicInfo.info = null
  }
}

// 【第 113 轮】播放中就把下一首的歌词取好：自动切歌时歌词已在缓存里，0:00 就有
// 时间轴可显示（否则要等网络回来，前奏段是空的）。只在起播后触发 —— musicToggled
// 时洗牌袋还没记账，提前取会把当前歌当成下一首；最后 12 秒跳过，交给
// preloadNextMusicUrl 那条链，避免两个入口同时向袋子里取歌。
const lyricPrefetchInfo = { musicId: '', loading: false }
const preloadNextMusicLyric = async() => {
  const currentMusicId = playerState.musicInfo.id
  if (!currentMusicId) return
  if (lyricPrefetchInfo.loading || lyricPrefetchInfo.musicId === currentMusicId) return
  const { nowPlayTime, maxPlayTime } = playerState.progress
  if (maxPlayTime > 10 && maxPlayTime - nowPlayTime < 12) return

  lyricPrefetchInfo.musicId = currentMusicId
  lyricPrefetchInfo.loading = true
  try {
    const info = await getNextPlayMusicInfo().catch(() => null)
    if (!info || playerState.musicInfo.id !== currentMusicId) return
    await getLyricInfo({ musicInfo: info.musicInfo }).catch(() => {})
  } finally {
    lyricPrefetchInfo.loading = false
  }
}

export default () => {
  const setProgress = (time: number) => {
    if (!playerState.musicInfo.id) return
    preloadMusicInfo.preProgress = time
  }

  const handleSetPlayInfo = () => {
    resetPreloadInfo()
  }

  const handleConfigUpdated: typeof global.state_event.configUpdated = (keys, _settings) => {
    if (!keys.includes('player.togglePlayMethod')) return
    // 模式变了「下一首」也随之变化：memo 必须作废（第 113 轮起歌词预取会在起播时
    // 就写入 memo，不能再依赖 preloadMusicInfo.info 是否已有值）。
    resetRandomNextMusicInfo()
    if (!preloadMusicInfo.info || preloadMusicInfo.info.isTempPlay) return
    preloadMusicInfo.info = null
    preloadMusicInfo.preProgress = playerState.progress.nowPlayTime
  }

  const handlePlayProgressChanged: typeof global.state_event.playProgressChanged = (progress) => {
    const duration = progress.maxPlayTime
    // 触发时机（用户第 11 轮第 11 条）：播到最后 10 秒（剩余 < 10s）才开始预取下一首，
    // 不再是此前的一进歌（剩余 < 20s 起）就抢带宽。总长 ≤ 10s 的极短音频不预取，
    // 避免一开播就触发。preloadMusicInfo.info 有值即不再重复发起（一首歌只取一次）。
    if (duration > 10 && duration - progress.nowPlayTime < 10 && !preloadMusicInfo.info) {
      // 用户第 15 轮第 4 条：这里是「最后 10 秒」的统一触发点。先走本模块的暖链
      // （nativeFlac 预启动 / URL 预热），完成后再调 startPreload 跑完整预加载
      // （下一首歌词预取 + 换源兜底取链）。刻意串行：第二步能命中第一步刚写入的
      // URL 缓存（core/music 的 saveMusicUrl / getMusicUrl 按档位缓存），
      // 同一时刻不会对同一首歌发两次请求。core/player/preload.ts 内部还有一道
      // 时间闸（同样只放行最后 10 秒），controller 在起播时对它的调用不会再提前取歌。
      void preloadNextMusicUrl(progress.nowPlayTime)
        .catch(() => {})
        .then(() => {
          startPreload()
        })
    }
  }

  // 【第 125 轮】原生侧的最后 10 秒触发（锁屏 / 灵动岛 / 后台也发）：
  // JS 的 playProgressChanged 只在 App active 时才有，那些场景走这一条。
  // 与前台进度拍共用同一套守卫（isLoading / memo / requestId / 2s 防重入）。
  onPreloadNext((position) => {
    if (!playerState.playMusicInfo.musicInfo || preloadMusicInfo.info) return
    void preloadNextMusicUrl(position)
      .catch(() => {})
      .then(() => {
        startPreload()
      })
  })

  global.app_event.on('setProgress', setProgress)
  global.app_event.on('musicToggled', handleSetPlayInfo)
  global.app_event.on('play', () => {
    void preloadNextMusicLyric()
  })
  global.state_event.on('configUpdated', handleConfigUpdated)
  global.state_event.on('playProgressChanged', handlePlayProgressChanged)
}
