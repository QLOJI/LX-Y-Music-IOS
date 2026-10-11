import TrackPlayer, { Capability, RepeatMode, State } from 'react-native-track-player'
import BackgroundTimer from 'react-native-background-timer'
import { playMusic as handlePlayMusic } from './playList'
import { destroyTrackPlayerCore } from './trackPlayerCore'
import { existsFile, moveFile, privateStorageDirectoryPath, temporaryDirectoryPath } from '@/utils/fs'
import { toast } from '@/utils/tools'
import { NativeModules, Platform } from 'react-native'
import { getAccuratePosition, getAccuratePositionStamped, seekToTime, type StampedPosition } from './seek'
import {
  getNativeFlacDuration,
  getNativeFlacPosition,
  getNativeFlacPositionStamped,
  getNativeFlacTrackId,
  isNativeFlacActive,
  getNativeFlacState,
  pauseNativeFlacPlayback,
  resetNativeFlacPlayback,
  resumeNativeFlacPlayback,
  seekNativeFlacPlayback,
  setNativeFlacRate,
  setNativeFlacVolume,
  stopNativeFlacPlayback,
} from './nativeFlac'
import { onUnifiedPlayerEvent } from './engine'
// 【第 39 轮第 4 条】播放 / 暂停的渐入渐出（本模块只依赖 nativeFlac + TrackPlayer，不成环）
// 【第 41 轮】多一个 syncVolumeFadeState：音量条 / 回前台重贴音量这类「直写」要把
// 渐入渐出模块的「当前音量」账本一起改掉，否则下一次斜坡的起点是错的（第一拍就是跳变）。
import { armVolumeFadeIn, fadeOutThenPause, syncVolumeFadeState } from './volumeFade'
import playerState from '@/store/player/state'
// import { PlayerMusicInfo } from '@/store/modules/player/playInfo'


export { useBufferProgress } from './hook'

const NativeTrackPlayerModule = NativeModules.TrackPlayerModule as {
  updateNowPlayingMetadata?: (metadata: {
    title?: string
    artist?: string
    album?: string
    artwork?: string
    duration?: number
    elapsedTime?: number
    isLiveStream?: boolean
  }) => Promise<void>
  getPosition?: () => Promise<number>
  getDuration?: () => Promise<number>
  getCacheSize?: () => Promise<number>
  clearCache?: () => Promise<void>
}

const emptyIdRxp = /\/\/default$/
const tempIdRxp = /\/\/default$|\/\/default\/\/restorePlay$/
export const isEmpty = (trackId = global.lx.playerTrackId) => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return false
  // console.log(trackId)
  return !trackId || emptyIdRxp.test(trackId)
}
export const isTempId = (trackId = global.lx.playerTrackId) => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return false
  return !trackId || tempIdRxp.test(trackId)
}

/**
 * 【第 53 轮第 1 条】引擎里当前装载的曲目，是不是这一首。
 *
 * 用途：`core/player/player.ts` 的刷新分支（播放错误 / 25s 加载超时后的重取）要
 * 「沿用引擎当前位置」续播**同一首**。但刷新请求发出时新歌的流可能还没真正装载
 * （引擎里仍是上一首），此刻 `getPosition()` 回报的是上一首的位置 —— 当成起播位置
 * 用出去，新歌就从旧歌进度开始播放（上一首 / 下一首 / 退出重开后切歌都会命中，
 * 用户实测「播到 1:00 后切歌，新歌从 1:00 开始」）。
 *
 * 判据取「引擎自己的曲目 id」，不取 playerState —— 后者在切歌瞬间就已经是新歌了
 * （setPlayMusicInfo 同步写入），分不出引擎跟没跟上：
 *   · nativeFlac 路径的曲目 id 是 `nativeflac://<音乐id>`（nativeFlac.ts 拼的）；
 *   · AVPlayer 路径是 `<音乐id>__//<随机>__//<url>`（trackPlayerCore.buildTracks 拼的）。
 * 下载条目（Download.ListItem）外层是下载 id、内层才是音乐 id（nativeFlac 拼 id 用的是
 * 内层），两个都算命中，避免把「引擎确实在放这首歌」误判成不在。
 */
export const isEngineOnMusic = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem): boolean => {
  const ids: Array<string | null | undefined> = 'progress' in musicInfo
    ? [musicInfo.id, musicInfo.metadata.musicInfo.id]
    : [musicInfo.id]
  const trackId = Platform.OS == 'ios' && isNativeFlacActive() ? getNativeFlacTrackId() : global.lx.playerTrackId
  if (!trackId) return false
  const isNative = trackId.startsWith('nativeflac://')
  return ids.some(id => id != null && (isNative ? trackId == `nativeflac://${id}` : trackId.startsWith(`${id}__//`)))
}

// export const replacePlayTrack = async(newTrack, oldTrack) => {
//   console.log('replaceTrack')
//   await TrackPlayer.add(newTrack)
//   await TrackPlayer.skip(newTrack.id)
//   await TrackPlayer.remove(oldTrack.id)
// }

// let timeout
// let isFirstPlay = true
// const updateInfo = async track => {
//   if (isFirstPlay) {
//     // timeout = setTimeout(() => {
//     await delayUpdateMusicInfo(track)
//     isFirstPlay = false
//     // }, 500)
//   }
// }


// 解决快速切歌导致的通知栏歌曲信息与当前播放歌曲对不上的问题
// const debouncePlayMusicTools = {
//   prevPlayMusicPromise: Promise.resolve(),
//   trackInfo: {},
//   isDelayUpdate: false,
//   isDebounced: false,
//   delay: 1000,
//   delayTimer: null,
//   debounce(fn, delay = 100) {
//     let timer = null
//     let _tracks = null
//     let _time = null
//     return (tracks, time) => {
//       if (!this.isDebounced && _tracks != null) this.isDebounced = true
//       _tracks = tracks
//       _time = time
//       if (timer) {
//         BackgroundTimer.clearTimeout(timer)
//         timer = null
//       }
//       if (this.isDelayUpdate) {
//         if (this.updateDelayTimer) {
//           BackgroundTimer.clearTimeout(this.updateDelayTimer)
//           this.updateDelayTimer = null
//         }
//         timer = BackgroundTimer.setTimeout(() => {
//           timer = null
//           let tracks = _tracks
//           let time = _time
//           _tracks = null
//           _time = null
//           this.isDelayUpdate = false
//           fn(tracks, time)
//         }, delay)
//       } else {
//         this.isDelayUpdate = true
//         fn(tracks, time)
//         this.updateDelayTimer = BackgroundTimer.setTimeout(() => {
//           this.updateDelayTimer = null
//           this.isDelayUpdate = false
//         }, this.delay)
//       }
//     }
//   },
//   delayUpdateMusicInfo() {
//     if (this.delayTimer) BackgroundTimer.clearTimeout(this.delayTimer)
//     this.delayTimer = BackgroundTimer.setTimeout(() => {
//       this.delayTimer = null
//       if (this.trackInfo.tracks && this.trackInfo.tracks.length) delayUpdateMusicInfo(this.trackInfo.tracks[0])
//     }, this.delay)
//   },
//   init() {
//     return this.debounce((tracks, time) => {
//       tracks = [...tracks]
//       this.trackInfo.tracks = tracks
//       this.trackInfo.time = time
//       return this.prevPlayMusicPromise.then(() => {
//         // console.log('run')
//         if (this.trackInfo.tracks === tracks) {
//           this.prevPlayMusicPromise = handlePlayMusic(tracks, time).then(() => {
//             if (this.isDebounced) {
//               this.delayUpdateMusicInfo()
//               this.isDebounced = false
//             }
//           })
//         }
//       })
//     }, 200)
//   },
// }

const playMusic = ((fn: (musicInfo: LX.Player.PlayMusic, url: string, time: number, quality?: LX.Quality | null) => void, delay = 800) => {
  let delayTimer: number | null = null
  let isDelayRun = false
  let timer: number | null = null
  let _musicInfo: LX.Player.PlayMusic | null = null
  let _url = ''
  let _time = 0
  let _quality: LX.Quality | null = null
  return (musicInfo: LX.Player.PlayMusic, url: string, time: number, quality?: LX.Quality | null) => {
    _musicInfo = musicInfo
    _url = url
    _time = time
    _quality = quality ?? null
    if (timer) {
      BackgroundTimer.clearTimeout(timer)
      timer = null
    }
    if (isDelayRun) {
      if (delayTimer) {
        BackgroundTimer.clearTimeout(delayTimer)
        delayTimer = null
      }
      timer = BackgroundTimer.setTimeout(() => {
        timer = null
        let musicInfo = _musicInfo
        let url = _url
        let time = _time
        let quality = _quality
        _musicInfo = null
        _url = ''
        _time = 0
        _quality = null
        isDelayRun = false
        fn(musicInfo!, url, time, quality)
      }, delay)
    } else {
      isDelayRun = true
      fn(musicInfo, url, time, quality ?? null)
      delayTimer = BackgroundTimer.setTimeout(() => {
        delayTimer = null
        isDelayRun = false
      }, 500)
    }
  }
})((musicInfo, url, time, quality) => {
  handlePlayMusic(musicInfo, url, time, quality)
})

export const setResource = (musicInfo: LX.Player.PlayMusic, url: string, duration?: number, quality?: LX.Quality | null) => {
  playerState.quality = quality ?? null
  playMusic(musicInfo, url, duration ?? 0, quality)
}

export const setPlay = async() => {
  // 【第 47 轮】用户的播放意图作废在途的暂停复核（PAUSE_VERIFY_MS 窗口内按下的播放
  // 优先，复核绝不允许把刚起来的播放又按停）。
  pauseVerifyToken++
  // 【第 39 轮第 4 条】预约「播放开始时渐入」：此刻是暂停态，先把音量压到 0（听不见），
  // 真正出声时由 controller.ts 的 'playing' 分支把音量斜坡升上去（见 volumeFade.ts）。
  armVolumeFadeIn()
  if (Platform.OS == 'ios' && isNativeFlacActive()) return resumeNativeFlacPlayback()
  return TrackPlayer.play()
}
export const getPosition = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return getNativeFlacPosition()
  return getAccuratePosition()
}

// 带快照时间信息的位置（分流对齐 getPosition）：nativeFlac 路径带原生时钟戳
// （精确回放）；AVPlayer 路径带年龄估计（中点补偿）；nativeFlac 快照失败时
// 退回同引擎无戳路径（snapshotAt/ageMs = 0，等于旧行为，不会串到 RNTP 位置）。
export const getPositionStamped = async(): Promise<StampedPosition> => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) {
    const stamped = await getNativeFlacPositionStamped().catch(() => null)
    if (stamped) return stamped
    return { position: await getNativeFlacPosition().catch(() => 0), snapshotAt: 0, ageMs: 0 }
  }
  return getAccuratePositionStamped()
}

// StampedPosition → Now Playing 发布键：原生戳优先（elapsedTimeSnapshotAt），
// 否则年龄（elapsedTimeAgeMs）。两者都无 → 空对象（原生退回旧行为）。
// 自定义键仅被歌词时钟重锚消费，不会写入系统 info 字典。
export const elapsedSnapshotFields = (stamped: StampedPosition) => {
  if (stamped.snapshotAt > 0) return { elapsedTimeSnapshotAt: stamped.snapshotAt }
  if (stamped.ageMs > 0) return { elapsedTimeAgeMs: stamped.ageMs }
  return {}
}

export const getPlaybackEngineState = async(): Promise<'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'stopped'> => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) {
    return getNativeFlacState().catch(() => 'playing' as const)
  }
  try {
    const state = await TrackPlayer.getState()
    switch (state) {
      case State.Playing: return 'playing'
      case State.Buffering: return 'buffering'
      case State.Connecting: return 'loading'
      case State.Paused: return 'paused'
      case State.Stopped: return 'stopped'
      default: return 'idle'
    }
  } catch { return 'playing' }
}

export const getDuration = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return getNativeFlacDuration()
  if (Platform.OS == 'ios' && typeof NativeTrackPlayerModule?.getDuration == 'function') {
    return NativeTrackPlayerModule.getDuration()
  }
  return TrackPlayer.getDuration()
}
export const setStop = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) {
    global.lx.playerTrackId = ''
    return stopNativeFlacPlayback()
  }
  await TrackPlayer.stop()
  if (Platform.OS != 'ios' && !isEmpty()) await TrackPlayer.skipToNext()
}
export const setLoop = async(loop: boolean) => TrackPlayer.setRepeatMode(loop ? RepeatMode.Off : RepeatMode.Track)

/**
 * 【第 47 轮】暂停复核窗口（毫秒）。用户原话：「点击暂停按钮后，进度条暂停了，歌词还正常
 * 加载，声音也在继续播放」——显示态走了暂停、出声的那台引擎却没停。暂停动作发出后这么久
 * 如果 JS 仍认为在播（playerState.isPlay），就说明引擎没停 / 状态事件丢了，无条件再发一次。
 * 有界：每次按下只复核一次，且复核复用 setTimeout 一次性定时器，不新建常驻唤醒源
 * （第 42 轮省电口径 / 第 43 轮「不许周期性看门狗」）。
 */
const PAUSE_VERIFY_MS = 700
/**
 * 复核令牌：用户的播放意图（setPlay）与新的暂停（setPause）都让在途复核作废 ——
 * 复核是给「暂停没落地」兜底的，绝不能反过来把用户刚按下的播放又按停。
 */
let pauseVerifyToken = 0

/**
 * 【第 47 轮】RNTP 那台引擎「可能还在出声」的判据。
 * nativeFlac 驱动的曲目 id 以 nativeflac:// 开头（nativeFlac.ts 的 startNativeFlacPlayback
 * 拼出来的），而 global.lx.playerTrackId 记录的是**最后一次**的驱动归属：
 *   · 值带 nativeflac:// 前缀 = 最后驱动就是 nativeFlac ⇒ 可能出声的只有它自己，RNTP 跳过；
 *   · 值是别的 id（RNTP 自己的曲目）= 跨引擎切换的中间态，它的音频可能还没被清掉；
 *   · 值为空 = 连「最后驱动是谁」都不知道（reset / ended / 起播事件还没到的窗口）——
 *     此时**也按「可能持有」处理**：对空闲的 RNTP 发一次 pause 是幂等空操作，
 *     漏发一次就是用户听到的「点了暂停，声音还在继续」。
 * 只有「明确知道最后驱动就是 nativeFlac」这一种情况才跳过 RNTP。
 */
const rntpMayHoldTrack = () => {
  const id = global.lx.playerTrackId
  return !id || !id.startsWith('nativeflac://')
}

/**
 * 真正让声音停下来的动作。**两台引擎都要发**（幂等、各自吞错）：
 * 旧实现按 isNativeFlacActive() 二选一，只停了「当前驱动」那一台 —— 一旦两台都在出声
 * （驱动切换的中间态、或错误重试里 setStop 未 await 而新引擎先起），暂停就只落到空闲的
 * 那台，出声的那台照放：卡片 ▶、进度冻住、声音继续，正是用户这轮两张截图的形态。
 */
const pausePlayingEngines = async() => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) {
    await pauseNativeFlacPlayback().catch(() => {})
    if (rntpMayHoldTrack()) await TrackPlayer.pause().catch(() => {})
    return
  }
  await TrackPlayer.pause().catch(() => {})
}

export const setPause = async() => {
  // 【第 39 轮第 4 条】先渐出（斜坡降到 0）再真暂停 —— 直接掐断正在出声的流就是那声
  // 「嘶哑 / 噪声」（见 volumeFade.ts 的说明）。真正的暂停动作以函数传入，斜坡跑完才执行；
  // 非 iOS 平台在 fadeOutThenPause 内部直通（同步调用真暂停），行为与改动前一致。
  // 【第 47 轮】暂停动作改为 pausePlayingEngines（双引擎收口），并在发出后有界复核一次。
  const token = ++pauseVerifyToken
  if (Platform.OS != 'ios') return fadeOutThenPause(pausePlayingEngines)
  await fadeOutThenPause(pausePlayingEngines)
  setTimeout(() => {
    if (token != pauseVerifyToken) return
    if (!playerState.isPlay) return
    void pausePlayingEngines()
  }, PAUSE_VERIFY_MS)
}
// export const skipToNext = () => TrackPlayer.skipToNext()
export const setCurrentTime = async(time: number) => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return seekNativeFlacPlayback(time)
  return seekToTime(time)
}
export const setVolume = async(num: number) => {
  // 【第 41 轮】音量条 / 冷启动 / 回前台重贴音量都会走这里：这是「外部直写」，
  // 必须同步渐入渐出模块的当前音量账本（斜坡起点取自它，账本错了下一拍就是一声跳变）。
  syncVolumeFadeState(num)
  if (Platform.OS == 'ios' && isNativeFlacActive()) return setNativeFlacVolume(num)
  return TrackPlayer.setVolume(num)
}
export const setPlaybackRate = async(num: number) => {
  if (Platform.OS == 'ios' && isNativeFlacActive()) return setNativeFlacRate(num)
  return TrackPlayer.setRate(num)
}
export const updateNowPlayingTitles = async(duration: number, title: string, artist: string, album: string) => {
  console.log('set playing titles', duration, title, artist, album)
  if (Platform.OS == 'ios') return Promise.resolve()
  return TrackPlayer.updateNowPlayingTitles(duration, title, artist, album)
}

export const resetPlay = async() => Promise.all([setPause(), setCurrentTime(0)])

export const isCached = async(url: string) => TrackPlayer.isCached(url)
export const getCacheSize = async() => {
  if (Platform.OS == 'ios') {
    if (typeof NativeTrackPlayerModule?.getCacheSize != 'function') return 0
    return NativeTrackPlayerModule.getCacheSize()
  }
  return TrackPlayer.getCacheSize()
}
export const clearCache = async() => {
  if (Platform.OS == 'ios') {
    if (typeof NativeTrackPlayerModule?.clearCache != 'function') return
    return NativeTrackPlayerModule.clearCache()
  }
  return TrackPlayer.clearCache()
}
export const migratePlayerCache = async() => {
  const newCachePath = temporaryDirectoryPath + '/TrackPlayer'
  if (await existsFile(newCachePath)) return
  const oldCachePath = privateStorageDirectoryPath + '/TrackPlayer'
  if (!await existsFile(oldCachePath)) return
  let timeout: number | null = BackgroundTimer.setTimeout(() => {
    timeout = null
    toast(global.i18n.t('player_cache_migrating'), 'long')
  }, 2_000)
  await moveFile(oldCachePath, newCachePath).finally(() => {
    if (timeout) BackgroundTimer.clearTimeout(timeout)
  })
}

export const destroy = async() => {
  if (global.lx.playerStatus.isIniting || !global.lx.playerStatus.isInitialized) return
  try {
    if (Platform.OS == 'ios') await resetNativeFlacPlayback().catch(() => {})
    await destroyTrackPlayerCore()
  } finally {
    global.lx.playerStatus.isInitialized = false
  }
}

type PlayStatus = 'None' | 'Ready' | 'Playing' | 'Paused' | 'Stopped' | 'Buffering' | 'Connecting'

type NativePlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'stopped'

const mapNativeFlacPlayStatus = (state: NativePlayerState): PlayStatus => {
  switch (state) {
    case 'loading':
      return 'Connecting'
    case 'buffering':
      return 'Buffering'
    case 'playing':
      return 'Playing'
    case 'paused':
      return 'Paused'
    case 'stopped':
      return 'Stopped'
    case 'idle':
    default:
      return 'None'
  }
}

export const onStateChange = async(listener: (state: PlayStatus) => void) => {
  const removeUnifiedListener = onUnifiedPlayerEvent((event) => {
    switch (event.type) {
      case 'state':
        switch (event.state) {
          case 'loading':
            listener('Connecting')
            break
          case 'buffering':
            listener('Buffering')
            break
          case 'playing':
            listener('Playing')
            break
          case 'paused':
            listener('Paused')
            break
          case 'stopped':
            listener('Stopped')
            break
          case 'idle':
          default:
            listener('None')
            break
        }
        break
      case 'ended':
        listener('Stopped')
        break
      case 'error':
        listener('Paused')
        break
    }
  })
  if (Platform.OS == 'ios' && isNativeFlacActive()) {
    void getNativeFlacState().then((state) => {
      listener(mapNativeFlacPlayStatus(state))
    }).catch(() => {})
  } else {
    void TrackPlayer.getState().then((state) => {
      switch (state) {
        case State.Ready:
          listener('Ready')
          break
        case State.Playing:
          listener('Playing')
          break
        case State.Paused:
          listener('Paused')
          break
        case State.Stopped:
          listener('Stopped')
          break
        case State.Buffering:
          listener('Buffering')
          break
        case State.Connecting:
          listener('Connecting')
          break
        case State.None:
        default:
          listener('None')
          break
      }
    }).catch(() => {})
  }

  return () => {
    removeUnifiedListener()
  }
}

/**
 * Subscription player state chuange event
 * @param options state change event
 * @returns remove event function
 */
// export const playState = callback => TrackPlayer.addEventListener('playback-state', callback)

const defaultUpdateOptions = Platform.OS == 'ios'
  ? {
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SeekTo,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],
    }
  : {
      // Whether the player should stop running when the app is closed on Android
      // stopWithApp: true,

      // An array of media controls capabilities
      // Can contain CAPABILITY_PLAY, CAPABILITY_PAUSE, CAPABILITY_STOP, CAPABILITY_SEEK_TO,
      // CAPABILITY_SKIP_TO_NEXT, CAPABILITY_SKIP_TO_PREVIOUS, CAPABILITY_SET_RATING
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SeekTo,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],

      notificationCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],

      // // An array of capabilities that will show up when the notification is in the compact form on Android
      compactCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.Stop,
        Capability.SkipToNext,
      ],

      // Icons for the notification on Android (if you don't like the default ones)
      // playIcon: require('./play-icon.png'),
      // pauseIcon: require('./pause-icon.png'),
      // stopIcon: require('./stop-icon.png'),
      // previousIcon: require('./previous-icon.png'),
      // nextIcon: require('./next-icon.png'),
      // icon: notificationIcon, // The notification icon
    }

export const updateOptions = async(options = defaultUpdateOptions) => {
  return TrackPlayer.updateOptions(options)
}

// export const setMaxCache = async size => {
//   // const currentTrack = await TrackPlayer.getCurrentTrack()
//   // if (!currentTrack) return
//   // console.log(currentTrack)
//   // const currentTime = await TrackPlayer.getPosition()
//   // const state = await TrackPlayer.getState()
//   // await stop()
//   // await TrackPlayer.destroy()
//   // await TrackPlayer.setupPlayer({ maxCacheSize: size * 1024, maxBuffer: 1000, waitForBuffer: true })
//   // await updateOptions()
//   // await TrackPlayer.seekTo(currentTime)
//   // switch (state) {
//   //   case TrackPlayer.STATE_PLAYING:
//   //   case TrackPlayer.STATE_BUFFERING:
//   //     await TrackPlayer.play()
//   //     break
//   //   default:
//   //     break
//   // }
// }

// export {
//   useProgress,
// }

export { updateMetaData, initTrackInfo } from './playList'
