import TrackPlayer, { State } from 'react-native-track-player'
import { Platform } from 'react-native'
import { updateOptions, setVolume, setPlaybackRate, migratePlayerCache, destroy as destroyPlayer, getPosition } from './utils'
import { getCurrentTrack, restoreTrack, updateMetaData } from './playList'
import { isNativeFlacActive, restoreNativeFlacPlayback, setNativePlayWithOthersPolicy, snapshotNativeFlacPlayback } from './nativeFlac'
import { clearNowPlayingInfo, pauseNowPlaying, playNowPlaying, setNowPlayingInfoSuppressed } from '@/utils/nativeModules/nowPlaying'
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
 *
 * 【第 33 轮第 4 条】这条下发链多担一件事：勾选态下**退出灵动岛 / 锁屏卡片占用**
 * （用户原话「勾选后，退出灵动岛占用」）。做法是「抑制元数据发布 + 切换那一刻清一次
 * 已发布的卡片」（见 @/utils/nativeModules/nowPlaying 的 setNowPlayingInfoSuppressed），
 * 取消勾选再按当前曲目重新发布 —— 仍然不重建播放器、不碰激活态会话分类。
 */
const syncPlayWithOthersEnabled = async() => {
  if (Platform.OS != 'ios') return
  const enabled = settingState.setting['player.isHandleAudioFocus'] === false
  // 【第 33 轮第 4 条】先把 JS 侧抑制口径立起来（同步赋值、没有桥往返窗口），再下发原生策略
  setNowPlayingInfoSuppressed(enabled)
  await setNativePlayWithOthersPolicy(enabled)
  if (!playerState.musicInfo.id) return
  if (enabled) {
    // 勾选 = 退出灵动岛 / 锁屏占用（用户原话）：清掉已发布的卡片。清卡是幂等的，同时把
    // 原生播放态置回 Stopped，所以下面要重新对齐一次状态。
    await clearNowPlayingInfo().catch(() => {})
  } else {
    // 取消勾选 = 立即按当前曲目重新发布（不等下一行歌词），锁屏卡片与锁屏歌词一起回来。
    // 与 core/player/nowPlaying.ts 的 syncNowPlayingMetadata 同款调用形状。
    void updateMetaData(playerState.musicInfo, playerState.isPlay, playerState.lastLyric, true)
  }
  // 状态重对齐：原生在「缓存为空」时发布内部会早退（不会凭空把卡片建回来），但原生的
  // 位置 / 歌词时钟只在 Playing 时运行，它同时是前台 4Hz 位置事件的枢纽（进度条唯一
  // 驱动源），必须与播放状态保持一致。
  if (playerState.isPlay) await playNowPlaying().catch(() => {})
  else await pauseNowPlaying().catch(() => {})
}

const initial = async({ volume, playRate, cacheSize, isHandleAudioFocus, isEnableAudioOffload }: {
  volume: number
  playRate: number
  cacheSize: number
  isHandleAudioFocus: boolean
  /** 用户第 33 轮第 7 条：这个形参以前叫 `_isEnableAudioOffload`（下划线前缀 = 声明了不用），
   *  「启用音频卸载」开关因此是个空开关 —— 见下方 setupPlayer 的 audioOffload。 */
  isEnableAudioOffload: boolean
}) => {
  if (global.lx.playerStatus.isIniting || global.lx.playerStatus.isInitialized) return
  global.lx.playerStatus.isIniting = true
  console.log('Cache Size', cacheSize * 1024)
  await migratePlayerCache()
  await TrackPlayer.setupPlayer({
    maxCacheSize: cacheSize * 1024,
    // —— 在线播放缓冲优化（作用于 iOS 原生 AVPlayer 预读策略）——
    // 【第 33 轮第 5 条】起播 / seek 后先缓冲 10s 再播放（用户原话「设定缓存歌曲时间为 10 秒，
    // 加载歌曲 10 秒缓存后再播放歌曲」）。本项只作用于 iOS 原生 AVPlayer 路径（非无损档）；
    // 无损档走原生流式引擎，其 10 秒门槛在 ios/LxMusicMobile/AppDelegate.mm 里（同一轮一起改）。
    minBuffer: 10,
    maxBuffer: 300, // 前向缓冲上限（秒）：保留充足预读余量，又避免无上限拉满整首
    backBuffer: 30, // 保留 30s 后方缓冲，后退 seek 无需重新拉流
    preferredForwardBufferDuration: 60, // 引导 AVPlayer 提前预读约 60s，弱网更平滑
    waitForBuffer: true, // 缓冲不足时等待而非中断播放
    handleAudioFocus: isHandleAudioFocus,
    // 【第 33 轮第 7 条】「启用音频卸载」接线：以前这里硬编码 false，而设置页的开关照常展示
    // ⇒ 勾不勾都一样（用户原话「目前不可用需修复」）。现与参考工程
    // lx-music-mobile-ios-adaptation 的写法逐字一致：audioOffload 取设置值。
    // 取值时机 = 播放器初始化（冷启动 / reloadConfig），与上游同口径 —— 设置页的提示文案
    // 本来就写明「可以关闭该选项后完全重启应用再试」，所以不做「切换即重建播放器」：
    // 第 24 轮已定案，播放中重建播放器会让锁屏 / 灵动岛卡片消失、原生引擎有进度没声音。
    audioOffload: isEnableAudioOffload,
    autoUpdateMetadata: false,
    // iOS 音频会话：RNTP / AVPlayer 这条路径（非无损档）**始终**标准 Playback、非混音。
    // 【第 24 轮】原先「同时播放 ⇒ iosCategoryOptions 带混音」是一条死路，用户实锤两个现象：
    //   ① 混音（mixable 会话）会让本应用失去 Now Playing 主会话资格 —— 锁屏 /
    //      灵动岛播放卡片当场消失；
    //   ② 它与原生流式引擎 prepareAudioSession 的 LongFormAudio 路由策略互斥
    //      （setCategory 报 -50），会话被停用后表现为「歌曲在走、没有声音」。
    // 【第 33 轮第 4 条】用户把①反转为需求（勾选后**就是要**退出灵动岛 / 锁屏占用），
    // 但②仍然成立，且这条 RNTP 路径的分类是在 setupPlayer 时定死的、运行期改分类要
    // updateOptions 重设激活态会话（第 24 轮实锤的 -50 禁区），因此这里保持非混音不变：
    // 勾选后的「卡片退出」由 nowPlaying 抑制开关完成，「不停播」由 service.ts 的混音分支
    // + 有界重取阶梯兜底；真正的「同时出声」落在原生流式引擎（无损档）的
    // prepareAudioSession 混音分支（AppDelegate.mm，同一轮一起改）。
    // 参考分支面向安卓，未声明这两项；iOS 缺少它会丢失音频会话配置。
    iosCategory: 'playback',
    iosCategoryOptions: [],
  } as any)
  global.lx.playerStatus.isInitialized = true
  global.lx.playerStatus.isIniting = false
  await updateOptions()
  // 【第 33 轮第 4 条】冷启动先把「退出卡片占用」的抑制口径立起来（此刻还没有任何发布者），
  // 防止初始化窗口内一次早到的元数据发布把卡片又建出来；勾选态下的这一步与下面的
  // syncPlayWithOthersEnabled 同值、幂等。
  setNowPlayingInfoSuppressed(settingState.setting['player.isHandleAudioFocus'] === false)
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
