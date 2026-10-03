import TrackPlayer, { State } from 'react-native-track-player'
import { Platform } from 'react-native'
import { updateOptions, setVolume, setPlaybackRate, migratePlayerCache, destroy as destroyPlayer, getPosition } from './utils'
import { getCurrentTrack, restoreTrack, updateMetaData } from './playList'
import { isNativeFlacActive, restoreNativeFlacPlayback, setNativePlayWithOthersPolicy, snapshotNativeFlacPlayback } from './nativeFlac'
import { soundEffectController } from './soundEffect'
import settingState from '@/store/setting/state'
import playerState from '@/store/player/state'

// const listenEvent = () => {
//   TrackPlayer.addEventListener('playback-error', err => {
//     console.log('playback-error', err)
//   })
//   TrackPlayer.addEventListener('playback-state', info => {
//     console.log('playback-state', info)
//   })
//   TrackPlayer.addEventListener('playback-track-changed', info => {
//     console.log('playback-track-changed', info)
//   })
//   TrackPlayer.addEventListener('playback-queue-ended', info => {
//     console.log('playback-queue-ended', info)
//   })
// }

/**
 * 【第 24 轮】下发「与其他应用同时播放」策略（勾选 = !player.isHandleAudioFocus）。
 *
 * 幂等、不重建播放器、不碰音频会话：旧实现在设置切换时调 reloadConfig()（destroy +
 * setupPlayer + restoreTrack），会话在**激活态**被重设分类 —— 混音开关一翻，锁屏 /
 * 灵动岛播放卡片消失、原生引擎有进度没声音（用户第 24 轮实锤）。现在只把标记交给
 * 原生（StreamingFlacPlayerModule.setPlayWithOthers），行为在打断分支即时生效，
 * 切换设置不打断当前播放。
 */
const syncPlayWithOthersEnabled = async() => {
  if (Platform.OS != 'ios') return
  await setNativePlayWithOthersPolicy(settingState.setting['player.isHandleAudioFocus'] === false)
}

const initial = async({ volume, playRate, cacheSize, isHandleAudioFocus, isEnableAudioOffload: _isEnableAudioOffload }: {
  volume: number
  playRate: number
  cacheSize: number
  isHandleAudioFocus: boolean
  isEnableAudioOffload: boolean
}) => {
  if (global.lx.playerStatus.isIniting || global.lx.playerStatus.isInitialized) return
  global.lx.playerStatus.isIniting = true
  console.log('Cache Size', cacheSize * 1024)
  await migratePlayerCache()
  await TrackPlayer.setupPlayer({
    maxCacheSize: cacheSize * 1024,
    // —— 在线播放缓冲优化（作用于 iOS 原生 AVPlayer 预读策略）——
    minBuffer: 5, // 起播 / seek 后至少先缓冲 5s 再播放，避免高码率开头卡顿
    maxBuffer: 300, // 前向缓冲上限（秒）：保留充足预读余量，又避免无上限拉满整首
    backBuffer: 30, // 保留 30s 后方缓冲，后退 seek 无需重新拉流
    preferredForwardBufferDuration: 60, // 引导 AVPlayer 提前预读约 60s，弱网更平滑
    waitForBuffer: true, // 缓冲不足时等待而非中断播放
    handleAudioFocus: isHandleAudioFocus,
    audioOffload: false,
    autoUpdateMetadata: false,
    // iOS 音频会话：**始终**标准 Playback、非混音。
    // 【第 24 轮】原先「同时播放 ⇒ iosCategoryOptions: ['mixWithOthers']」是一条死路，
    // 用户实锤两个现象：
    //   ① mixWithOthers（mixable 会话）会让本应用失去 Now Playing 主会话资格 —— 锁屏 /
    //      灵动岛播放卡片当场消失（取消勾选又回来），与「始终显示」直接冲突；
    //   ② 它与原生流式引擎 prepareAudioSession 的 LongFormAudio 路由策略互斥
    //      （setCategory 报 -50），会话被停用后表现为「歌曲在走、没有声音」。
    // 因此「同时播放」改为**策略开关**（service.ts 打断分支 + 原生
    // LXPlayWithOthersEnabled）：勾选 = 不因其它音频暂停自己；会话始终非混音、卡片始终在。
    // 参考分支面向安卓，未声明这两项；iOS 缺少它会丢失音频会话配置。
    iosCategory: 'playback',
    iosCategoryOptions: [],
  } as any)
  global.lx.playerStatus.isInitialized = true
  global.lx.playerStatus.isIniting = false
  await updateOptions()
  // 【第 24 轮】冷启动也把「与其他应用同时播放」策略下发给原生（重启后口径不丢）
  await syncPlayWithOthersEnabled()
  await setVolume(volume)
  await setPlaybackRate(playRate)
  await soundEffectController.applyCurrentConfig()
  // listenEvent()
}


const isInitialized = () => global.lx.playerStatus.isInitialized

const getPlayerConfig = () => ({
  volume: settingState.setting['player.volume'],
  playRate: settingState.setting['player.playbackRate'],
  cacheSize: settingState.setting['player.cacheSize'] ? parseInt(settingState.setting['player.cacheSize']) : 0,
  isHandleAudioFocus: settingState.setting['player.isHandleAudioFocus'],
  isEnableAudioOffload: settingState.setting['player.isEnableAudioOffload'],
})

let reconfigurePromise = Promise.resolve()
const reloadConfig = async() => {
  const run = async() => {
    if (global.lx.playerStatus.isIniting || !global.lx.playerStatus.isInitialized) return

    if (Platform.OS == 'ios' && isNativeFlacActive()) {
      const snapshot = await snapshotNativeFlacPlayback()
      global.lx.playerStatus.ignoreTrackPlayerLifecycle = true
      try {
        await destroyPlayer()
        await initial(getPlayerConfig())
        if (snapshot) {
          await restoreNativeFlacPlayback(snapshot)
        }
        if (playerState.musicInfo.id) {
          const isPlay = snapshot ? !['idle', 'paused', 'stopped'].includes(snapshot.state) : playerState.isPlay
          void updateMetaData(playerState.musicInfo, isPlay, playerState.lastLyric, true)
        }
      } finally {
        global.lx.playerStatus.ignoreTrackPlayerLifecycle = false
      }
      return
    }

    const [track, position, currentState] = await Promise.all([
      getCurrentTrack(),
      getPosition(),
      TrackPlayer.getState(),
    ])
    const shouldRestoreTrack = typeof track?.id == 'string' && !/\/\/default$/.test(track.id)

    await destroyPlayer()
    await initial(getPlayerConfig())

    if (!shouldRestoreTrack || !track) return
    await restoreTrack(track, position, currentState == State.Playing)
  }

  reconfigurePromise = reconfigurePromise.then(run, run)
  return reconfigurePromise
}


export {
  initial,
  isInitialized,
  reloadConfig,
  syncPlayWithOthersEnabled,
  setVolume,
  setPlaybackRate,
}

export {
  setResource,
  setPause,
  setPlay,
  setCurrentTime,
  getDuration,
  setStop,
  resetPlay,
  getPosition,
  updateMetaData,
  onStateChange,
  isEmpty,
  useBufferProgress,
  initTrackInfo,
} from './utils'
