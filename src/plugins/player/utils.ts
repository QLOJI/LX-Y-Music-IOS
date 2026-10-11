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
// 【第 63 轮第 2 条】多一个 cancelPendingFadeOut：切歌 / 停止（setStop）要作废在途的渐出，
// 否则「渐出跑完就真暂停」会在新歌起播后落地，把新歌按停（见那里的注释）。
import { armVolumeFadeIn, cancelPendingFadeOut, fadeOutThenPause, syncVolumeFadeState } from './volumeFade'
import { setIsPlay } from '@/core/player/playStatus'
import { pauseNowPlaying, playNowPlaying } from '@/utils/nativeModules/nowPlaying'
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

// }


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
  //
  // 【第 58 轮第 3 条】已在播时**不**预约。这个函数有两类调用者：真·恢复播放（togglePlay /
  // 自动续播 / 下一曲），以及**重取输出**（service.ts 的 scheduleMixReclaim 阶梯与打断结束
  // 分支 —— 勾选「与其他应用同时播放」后系统打断来回时的重取）。后者进来时 playerState.isPlay
  // 一直是 true（混音态下我们从不对外呈现暂停，重取阶梯本身也以 isPlay 为闸门），引擎早已跨过
  // 出声门槛。旧写法无条件 arm：armFadeIn 见 fadeTimer == null 就 stopRamp + silenceBothEngines
  // 把音量当场压 0，而重取不会再触发 'playing' 事件去放行渐入，音量只能干等预约的兜底期限
  // （ARM_TIMEOUT_MS = 1.5s）被一记写回 —— 用户听到的「声音自动不定时中断一下，然后又自动
  // 恢复」正是这六拍阶梯。真·恢复播放这一支 isPlay 本来就是 false，渐入照旧。
  //
  // 【第 62 轮第 3 条】闸门求值挪到「翻 UI」之前：下面新增的即时翻转会把 isPlay 改成 true，
  // 再读就成了「已在播」（正是第 58 轮要跳过的情形），渐入预约会被自己吃掉。
  // 判定只取一次快照 resuming，后面翻转与发布都以它为准，顺序改不动语义。
  const resuming = !playerState.isPlay
  if (resuming) armVolumeFadeIn()
  // 【第 62 轮第 3 条】用户原话：「播放/暂停按钮点击不应该有渐入渐出的动画延迟变化，
  // 只是音乐有渐入渐出的效果」。旧链路（togglePlay → setPlay → 引擎 play → 'playing' 事件
  // → app_event 'play' → setIsPlay(true)）里 UI 图标要等引擎跨过出声门槛才翻，听感上就是
  // 「点了播放键，图标慢半拍」。这里按下即翻：图标 / 状态文案立刻变，锁屏与灵动岛同刻发布
  // （playNowPlaying 只写「正在播」这一个状态位与播放速率，位置取原生上一份快照），
  // 音频侧的渐入（armVolumeFadeIn + 'playing' 分支的 applyVolumeOnPlayStart）完全不动。
  // 闸门用 resuming：重取输出（混音阶梯、回前台重取）进来时 isPlay 一直是 true，
  // 既不重复发布也不多做一次元数据桥往返。
  if (resuming) {
    setIsPlay(true)
    void playNowPlaying().catch(() => {})
  }
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
  // 【第 63 轮第 2 条】切歌（core/player/player.ts 的 handlePlay）/ 停止（player.stop()）/
  // 错误重载都收口在这里，两件「新指令作废在途意图」的事都在这一处做：
  //
  // ① pauseVerifyToken++ —— 上一次 setPause 的 700ms 复核不许把**新起的这首歌**按停。
  //    复核是在 `await fadeOutThenPause(...)` 之后才挂上的（setPause 末尾那行）：渐出可配到
  //    3 秒之后，一次「按下暂停 → 立刻切歌」的次序里，那条复核会排在**新歌起播之后**，
  //    而它认的是 setPause 进门领的号。旧值 300ms 时窗口太窄撞不上，3 秒之后是常态。
  //
  // ② cancelPendingFadeOut() —— 在途的「渐出跑完就真暂停」整条作废（含掐斜坡），
  //    否则它到点会执行 pausePlayingEngines() 把刚起的新歌按停。理由与判据写在
  //    volumeFade.ts 的同名函数上。
  //
  // 两句话都刻意放在平台分支**之前**：nativeFlac 与 RNTP 两条路都要作废（它们走的是同一条
  // 渐出 / 复核）。
  pauseVerifyToken++
  cancelPendingFadeOut()
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
  // 【第 62 轮第 3 条】按下即翻 UI（图标 / 锁屏 / 灵动岛），渐出与真暂停照旧异步跑完 ——
  // 旧链路里图标要等 300ms 渐出跑完、引擎发出 'paused' 才翻，正是用户这轮的投诉。
  // 只翻一次：isPlay 仍是播放态才翻，避免停止 / 错误路径重复发布。
  const token = ++pauseVerifyToken
  if (playerState.isPlay) {
    setIsPlay(false)
    void pauseNowPlaying({ playbackRate: 0 }).catch(() => {})
  }
  if (Platform.OS != 'ios') return fadeOutThenPause(pausePlayingEngines)
  await fadeOutThenPause(pausePlayingEngines)
  setTimeout(() => {
    // 【第 62 轮第 3 条】复核不再看 playerState.isPlay：UI 是按下即翻的，那一刻起
    // isPlay 恒为 false，旧闸门会让第 47 轮这条兜底永远早退（「点了暂停声音还在放」没了防线）。
    // pausePlayingEngines 自身幂等（两台引擎各吞错），带 token 的门控已足够挡住
    // 「复核窗口内又按了播放」的竞态。
    if (token != pauseVerifyToken) return
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
  // 【第 63 轮第 2 条】这个调用现在还会**掐掉在途渐变**（用户原话「可中断：渐入渐出过程中
  // 若用户手动调节音量……应能立即中断当前渐变并按新指令执行」），口径反转写在
  // volumeFade.ts 的 syncVolumeFadeState 上。真正会撞上这条的只有音量条 —— 冷启动 /
  // 重贴音量那几处各自带着 isVolumeFadeActive() 前置让行。
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

    }

export const updateOptions = async(options = defaultUpdateOptions) => {
  return TrackPlayer.updateOptions(options)
}

// }

export { updateMetaData, initTrackInfo } from './playList'
