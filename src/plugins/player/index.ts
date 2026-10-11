import TrackPlayer, { State } from 'react-native-track-player'
import { Platform } from 'react-native'
import { updateOptions, setVolume, setPlaybackRate, migratePlayerCache, destroy as destroyPlayer, getPosition, setPause } from './utils'
import { getCurrentTrack, restoreTrack, updateMetaData } from './playList'
import { applyNativePlayWithOthersNow, isNativeFlacActive, restoreNativeFlacPlayback, setNativePlayWithOthersPolicy, snapshotNativeFlacPlayback } from './nativeFlac'
import { pauseNowPlaying, playNowPlaying } from '@/utils/nativeModules/nowPlaying'
import { soundEffectController } from './soundEffect'
import settingState from '@/store/setting/state'
import playerState from '@/store/player/state'

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
 * 【第 33 轮第 4 条 → 第 34 轮第 2 条反转】第 33 轮曾让这条下发链顺手「勾选就抑制元数据 +
 * 清掉已发布的卡片」，以达到「退出灵动岛占用」。第 34 轮用户把需求改成：勾选后
 * **要显示锁屏播放器界面**、「还是保留同时播放功能」（原话），所以那条抑制已整体撤销
 * （见 @/utils/nativeModules/nowPlaying 的说明）。现在无论勾选与否都按当前曲目
 * **重新发布一次元数据**：锁屏播放器与当前播放状态保持一致；「前台不显示灵动岛播放器、
 * 切到后台锁屏 + 灵动岛一起显示」是系统的前后台行为，代码不介入。
 *
 * 【第 56 轮第 3 条】(b)(c)(d) 三件收口（用户原话「勾选上就立即执行设置……取消勾选就立即
 * 占用灵动岛，取消和勾选会自动暂停播放歌曲」）：
 *   (b) 立即执行：改走 applyNativePlayWithOthersNow——除写标记外，满足安全闸门时当场重配
 *       音频会话，不再等「下一首 / 下一次 prepareAudioSession」。闸门是「引擎必须已停」，
 *       所以这一路下发**两处**：本体内那处管「切换时已经暂停 / 没在播」，函数尾在
 *       setPause 之后那处管「正在播放时切换」（引擎这一刻才真的停下来）；
 *   (c) 占用/退出占用：会话口径（混音 = 让出 Now Playing 主会话资格 / 独占 + LongFormAudio =
 *       重新成为主会话）就是系统据以决定锁屏卡片与灵动岛占用的那个状态，切换当场落下；
 *       「只关灵动岛、保留锁屏」这种粒度 iOS 没有公开 API（第 34 轮定案），代码不硬做系统 UI；
 *   (d) 切换即暂停：值真的变了才停（冷启动/幂等下发不停），停在最后一步，见函数尾。
 */
// 【第 56 轮第 3 条】上一次真正下发过的口径（null = 本进程还没下发过）。
// 只有「值真的变了」才算用户勾/取消勾选 —— 冷启动 initial 里的首次下发、以及任何幂等
// 重复下发都不算，绝不能顺手把用户正在听的歌暂停掉（见下方 (d) 分支）。
let lastAppliedPlayWithOthers: boolean | null = null

const syncPlayWithOthersEnabled = async() => {
  if (Platform.OS != 'ios') return
  const enabled = settingState.setting['player.isHandleAudioFocus'] === false
  const switched = lastAppliedPlayWithOthers != null && lastAppliedPlayWithOthers != enabled
  lastAppliedPlayWithOthers = enabled
  await setNativePlayWithOthersPolicy(enabled)
  if (!playerState.musicInfo.id) return
  // 【第 56 轮第 3 条 (b)(c)】立即生效：除静态标记外，安全闸门满足时**当场**重配音频会话
  //（原生 applyPlayWithOthersNow：只有本机引擎持有音源且已停下才真的重配，理由与闸门写在
  // AppDelegate.mm 那一段）。第 33 轮的「要等下一次 prepareAudioSession 才生效」到此收口。
  // 放在重发布之前：口径先落地，卡片/系统播放态再按新口径对齐。返回 false（只写了标记）
  // 不是错误，也不再重试——在激活态会话上反复重设分类正是第 24 轮实锤的失声路径。
  // 这一处覆盖的是「切换时已经暂停 / 没在播」：引擎已停，闸门当场满足。
  // 「正在播放时切换」由函数尾再下发一次收口（见那里：那一刻引擎才真的停下来）。
  await applyNativePlayWithOthersNow(enabled)
  // 立即按当前曲目重新发布（不等下一行歌词）：与 core/player/nowPlaying.ts 的
  // syncNowPlayingMetadata 同款调用形状。首次发布 / 重发布都是幂等的。
  void updateMetaData(playerState.musicInfo, playerState.isPlay, playerState.lastLyric, true)
  // 状态重对齐：原生的位置 / 歌词时钟只在 Playing 时运行，它同时是前台 4Hz 位置事件的
  // 枢纽（进度条唯一驱动源），必须与播放状态保持一致。
  if (playerState.isPlay) await playNowPlaying().catch(() => {})
  else await pauseNowPlaying().catch(() => {})
  // 【第 56 轮第 3 条 (d)】切换即自动暂停（用户原话「取消和勾选会自动暂停播放歌曲」）。
  // 放在最后：先按切换前的真实状态把会话口径与卡片对齐好，再停下这一首，并把系统播放态
  // 同步成暂停（pauseNowPlaying 幂等）。暂停动作走 plugins/player/utils 的 setPause——
  // 与 core/player 的 pause() 是同一个原语（先渐出再停，第 39/47 轮口径），
  // 不是自己搓引擎调用。已暂停时不必再走一遍渐出。
  if (switched && playerState.isPlay) {
    await setPause()
    // 【第 56 轮第 3 条 (b)(c)】停下来的这一刻**再下发一次**：上面那一处（约第 68 行）在
    // 「正在播放时切换」这条主用例上必然被原生闸门挡回（引擎还在跑 ⇒ 只写标记、resolve NO，
    // 见 AppDelegate.mm 的闸门）—— 而这正是用户报的「勾选上不会立即配置好，而是需要下首歌
    // 才执行」：会话口径还是旧的，得等下一次 prepareAudioSession。setPause（含 300ms 渐出）
    // 返回时引擎已经停下（pause 桥在 renderQueue 内无条件 [engine pause]，同步 resolve），
    // 闸门此刻才满足，于是这里当场把会话口径换过来：勾选 ⇒ 混音会话（退出灵动岛占用）、
    // 取消勾选 ⇒ 独占 + LongFormAudio（立即占用）。幂等：写标记不产生副作用，重配走的是
    // 同一个 prepareAudioSession（会话分类的唯一真源）。
    await applyNativePlayWithOthersNow(enabled)
    await pauseNowPlaying().catch(() => {})
  }
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
  // 【第 24 轮】冷启动也把「与其他应用同时播放」策略下发给原生（重启后口径不丢）。
  // 【第 34 轮第 2 条】第 33 轮在这里补过一句「冷启动先立起元数据抑制口径」，随抑制整体撤销。
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
  isEngineOnMusic,
  useBufferProgress,
  initTrackInfo,
} from './utils'
