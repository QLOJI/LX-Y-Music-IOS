import BackgroundTimer from 'react-native-background-timer'
import { Platform } from 'react-native'
import settingState from '@/store/setting/state'
import {
  getNativeFlacDuration,
  isNativeFlacActive,
} from './nativeFlac'
import { getPositionStamped, elapsedSnapshotFields } from './utils'
import playerState from '@/store/player/state'
import { getTimelineDuration } from '@/core/player/timeline'
import {
  formatNowPlayingTitleLine,
  getCurrentTrack,
  getTrackDuration,
  initTrackInfo as handleInitTrackInfo,
  restoreTrack,
  trackPlayerState as state,
  updateCurrentTrackMetadata,
} from './trackPlayerCore'
import { loadPlaybackResource } from './engine/resourceLoader'

export { getCurrentTrack, restoreTrack }
export { state }

const resolveMetadataDuration = (duration: number) => {
  if (duration > 0) return duration
  if (playerState.progress.maxPlayTime > 0) return playerState.progress.maxPlayTime
  return getTimelineDuration(playerState.playMusicInfo.musicInfo, duration)
}

// 逐行歌词 force 更新的时长缓存：同一首歌内时长不变，首次解析后直接复用，
// 省去每行歌词一次的时长桥接往返（getTrackDuration / getNativeFlacDuration）。
// 类型与 musicInfo.id 一致（`string | null`）——部分音源的 id 本身就是 null；
// 比较处用松散 `!=`，null 与 undefined 视为同一「未缓存」语义，故无需额外区分。
let cachedDurationMusicId: string | null | undefined

export const updateMetaData = async(musicInfo: LX.Player.MusicInfo, isPlay: boolean, lyric?: string, force = false) => {
  const prevIsPlaying = state.isPlaying
  state.isPlaying = isPlay
  if (force) {
    if (!(state.prevDuration > 0) || cachedDurationMusicId != musicInfo.id) {
      const duration = resolveMetadataDuration(isNativeFlacActive() ? await getNativeFlacDuration() : await getTrackDuration())
      state.prevDuration = duration
      cachedDurationMusicId = musicInfo.id
    }
    delayUpdateMusicInfo(musicInfo, lyric, isPlay)
    return
  }
  if (!force && isPlay == prevIsPlaying) {
    const duration = resolveMetadataDuration(isNativeFlacActive() ? await getNativeFlacDuration() : await getTrackDuration())
    if (state.prevDuration != duration) {
      state.prevDuration = duration
      cachedDurationMusicId = musicInfo.id
      const trackInfo = await getCurrentTrack()
      if (trackInfo && musicInfo) {
        delayUpdateMusicInfo(musicInfo, lyric, isPlay)
      }
    }
  } else {
    const [duration, trackInfo] = await Promise.all([isNativeFlacActive() ? getNativeFlacDuration() : getTrackDuration(), getCurrentTrack()])
    state.prevDuration = resolveMetadataDuration(duration)
    cachedDurationMusicId = musicInfo.id
    if (trackInfo && musicInfo) {
      delayUpdateMusicInfo(musicInfo, lyric, isPlay)
    }
  }
}

export const initTrackInfo = async(musicInfo: LX.Player.PlayMusic, mInfo: LX.Player.MusicInfo) => {
  await handleInitTrackInfo(musicInfo, mInfo, delayUpdateMusicInfo)
}

const handlePlayMusic = async(musicInfo: LX.Player.PlayMusic, url: string, time: number, quality?: LX.Quality | null) => {
  await loadPlaybackResource({ musicInfo, url, time, quality })
}
let playPromise = Promise.resolve()
let actionId = Math.random()
export const playMusic = (musicInfo: LX.Player.PlayMusic, url: string, time: number, quality?: LX.Quality | null) => {
  const id = actionId = Math.random()
  void playPromise.finally(() => {
    if (id != actionId) return
    playPromise = handlePlayMusic(musicInfo, url, time, quality).catch((err: Error & { lxHandled?: boolean }) => {
      console.log(err)
      if (!err?.lxHandled) {
        global.app_event.error()
        global.app_event.playerError()
      }
    })
  })
}

// let musicId = null
// let duration = 0
const updateMetaInfo = async(mInfo: LX.Player.MusicInfo, lyric?: string, isPlaying = state.isPlaying) => {
  console.log('updateMetaInfo', lyric)
  const isShowNotificationImage = settingState.setting['player.isShowNotificationImage']
  // const mInfo = formatMusicInfo(musicInfo)
  // console.log('+++++updateMusicPic+++++', track.artwork, track.duration)

  // if (track.musicId == musicId) {
  //   if (global.playInfo.musicInfo.img != null) artwork = global.playInfo.musicInfo.img
  //   if (track.duration != null) duration = global.playInfo.duration
  // } else {
  //   musicId = track.musicId
  //   artwork = global.playInfo.musicInfo.img
  //   duration = global.playInfo.duration || 0
  // }
  // console.log('+++++updateMetaInfo+++++', mInfo.name)
  state.isPlaying = isPlaying
  let artwork = isShowNotificationImage ? mInfo.pic ?? undefined : undefined
  let name: string
  let singer: string
  let album: string | undefined
  if (Platform.OS == 'ios') {
    name = formatNowPlayingTitleLine(mInfo.name ?? 'Unknow', mInfo.singer ?? '')
    singer = lyric ?? ''
    album = ''
  } else if (!state.isPlaying || lyric == null) {
    name = mInfo.name ?? 'Unknow'
    singer = mInfo.singer ?? 'Unknow'
    album = mInfo.album ?? undefined
  } else {
    name = lyric
    singer = `${mInfo.name}${mInfo.singer ? ` - ${mInfo.singer}` : ''}`
    album = mInfo.album ?? undefined
  }
  // 带快照时间信息的位置（nativeFlac 原生时钟戳 / AVPlayer 年龄估计）：
  // elapsedTimeSnapshotAt / elapsedTimeAgeMs 随发布透传，原生歌词时钟在每次
  // 元数据发布重锚时把锚点回放到快照时刻——换行发布的桥接往返不再被钉进锚点
  // （修灵动岛/控制中心歌词恒定滞后）。控制中心歌词由原生时钟（锚点 + 速率外推）
  // 驱动，读的是 nowPlayingInfo 缓存的 PlaybackRate：pauseNowPlaying 会把该缓存
  // 写成 0，而逐行元数据不带 playbackRate 时缓存永远停在 0，原生时钟判定「非播放」
  // 直接 return，歌词冻结（暂停/播放一次才恢复）。每次发布都带上当前真实速率
  // （暂停时给 0），缓存与系统进度外推都不会再被写脏；原生侧同时据此把可能残留
  // 的时钟冻结标志解除。
  // 【第 48 轮】首发即完整（用户原话：「歌曲刚开始播放时，锁屏界面的歌曲进度、歌词、
  // 歌曲时间显示都不显示，要等到第一句歌词加载时，直接就跳到了 0:14 位置，请修复这个
  // 问题，确保锁屏界面的歌曲进度、歌词、歌曲时间实时显示没有延迟」）：
  //   ① duration 不再直接发 `state.prevDuration || 0`。prevDuration 靠桥接往返解析，
  //      **首次发布**时还是 0 / -1（clearTracks 置 -1）；发出去的 0 被系统当作
  //      「总时长未知」——锁屏左右两侧都渲染 -:--、进度条整条不可拖（67.jpg 那张），
  //      一直要等到第一句歌词那次发布（那时 prevDuration 已解析好）才整块跳出来，
  //      正是用户描述的「到 0:14 才整块出现」。改为走 resolveMetadataDuration：
  //      引擎时长 → 进度模块 maxPlayTime → 元数据 interval —— 最后一级是**纯元数据**，
  //      起播第 0 帧就已知（nativeFlac 流式路径的引擎时长恒为 0，必须靠它兜底）。
  //   ② elapsedTime 不再「快照取不到就整个不带这个字段」（第 47 轮的写法，原意只防
  //      「把 0 当真实位置、把歌词锚点钉回第 0 行」）：缺字段时系统同样渲染 -:--。
  //      取不到带戳快照时退回 **JS 侧进度位置**，且不带戳 —— 原生按「就是现在」处理，
  //      既不外推也不把锚点回放到过去：字段永远在，位置也不说谎。
  const stamped = await getPositionStamped().catch(() => null)
  const elapsedSeconds = Number.isFinite(playerState.progress.nowPlayTime) && playerState.progress.nowPlayTime > 0
    ? playerState.progress.nowPlayTime
    : 0
  const elapsedFields = stamped
    ? { elapsedTime: stamped.position, ...elapsedSnapshotFields(stamped) }
    : { elapsedTime: elapsedSeconds }
  const metadata = {
    title: name,
    artist: singer,
    album,
    artwork,
    duration: resolveMetadataDuration(state.prevDuration),
    ...elapsedFields,
    ...(Platform.OS == 'ios'
      ? { playbackRate: isPlaying ? settingState.setting['player.playbackRate'] : 0 }
      : {}),
  }
  await updateCurrentTrackMetadata(metadata)
}


// 解决快速切歌导致的通知栏歌曲信息与当前播放歌曲对不上的问题
const debounceUpdateMetaInfoTools = {
  updateMetaPromise: Promise.resolve(),
  musicInfo: null as LX.Player.MusicInfo | null,
  debounce(fn: (musicInfo: LX.Player.MusicInfo, lyric?: string, isPlaying?: boolean) => void | Promise<void>) {
    // let delayTimer = null
    let isDelayRun = false
    let timer: number | null = null
    let _musicInfo: LX.Player.MusicInfo | null = null
    let _lyric: string | undefined
    let _isPlaying: boolean | undefined
    return (musicInfo: LX.Player.MusicInfo, lyric?: string, isPlaying?: boolean) => {
      // console.log('debounceUpdateMetaInfoTools', musicInfo)
      if (timer) {
        BackgroundTimer.clearTimeout(timer)
        timer = null
      }
      // if (delayTimer) {
      //   BackgroundTimer.clearTimeout(delayTimer)
      //   delayTimer = null
      // }
      if (isDelayRun) {
        _musicInfo = musicInfo
        _lyric = lyric
        _isPlaying = isPlaying
        // 冷却窗口内的更新（含每行歌词 → 控制中心）下一拍立即合并推送：
        // 此前这里也是 500ms,且每行歌词都会重置定时器,歌词密集时控制中心
        // 要等出 500ms 空隙才更新,表现为歌词滞后音乐 1~2s
        timer = BackgroundTimer.setTimeout(() => {
          timer = null
          let musicInfo = _musicInfo
          let lyric = _lyric
          let isPlaying = _isPlaying
          _musicInfo = null
          _lyric = undefined
          _isPlaying = undefined
          if (!musicInfo) return
          // isDelayRun = false
          void fn(musicInfo, lyric, isPlaying)
        }, 0)
      } else {
        isDelayRun = true
        void fn(musicInfo, lyric, isPlaying)
        BackgroundTimer.setTimeout(() => {
          // delayTimer = null
          isDelayRun = false
        }, 500)
      }
    }
  },
  init() {
    return this.debounce(async(musicInfo: LX.Player.MusicInfo, lyric?: string, isPlaying?: boolean) => {
      this.musicInfo = musicInfo
      return this.updateMetaPromise.then(() => {
        // console.log('run')
        if (this.musicInfo?.id === musicInfo.id) {
          this.updateMetaPromise = updateMetaInfo(musicInfo, lyric, isPlaying)
        }
      })
    })
  },
}

export const delayUpdateMusicInfo = debounceUpdateMetaInfoTools.init()

// export const delayUpdateMusicInfo = ((fn, delay = 800) => {
//   let delayTimer = null
//   let isDelayRun = false
//   let timer = null
//   let _track = null
//   return track => {
//     _track = track
//     if (timer) {
//       BackgroundTimer.clearTimeout(timer)
//       timer = null
//     }
//     if (isDelayRun) {
//       if (delayTimer) {
//         BackgroundTimer.clearTimeout(delayTimer)
//         delayTimer = null
//       }
//       timer = BackgroundTimer.setTimeout(() => {
//         timer = null
//         let track = _track
//         _track = null
//         isDelayRun = false
//         fn(track)
//       }, delay)
//     } else {
//       isDelayRun = true
//       fn(track)
//       delayTimer = BackgroundTimer.setTimeout(() => {
//         delayTimer = null
//         isDelayRun = false
//       }, 500)
//     }
//   }
// })(track => {
//   console.log('+++++delayUpdateMusicPic+++++', track.artwork)
//   updateMetaInfo(track)
// })
