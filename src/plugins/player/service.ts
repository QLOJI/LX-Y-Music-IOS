/* eslint-disable @typescript-eslint/no-misused-promises */
import TrackPlayer, { Event as TPEvent } from 'react-native-track-player'
import { AppState, Platform } from 'react-native'
// 【第 49 轮·双通路单一漏斗（2026-10-10）】切歌（playNext/playPrev）与 markTimeoutExitInteraction
// 重新回到本文件：锁屏 / 灵动岛的遥控命令现在统一进本文件的 dispatchRemoteCommand 漏斗。
// 第 20 轮曾把 RNTP 侧的五段监听连同这两个调用一并删掉（当时的理由是「一次按键跳两首」），
// 但用户第 43~49 轮连续复现「锁屏/灵动岛按键没反应、进度条拖不动」，而参考工程
// （lx-music-mobile-ios-adaptation）两条通路都在、锁屏一切正常 —— 第 49 轮按用户授权
// 1:1 恢复这条通路；两条通路并存时的重复投递由漏斗的窗口去重兜住（见漏斗注释）。
import { pause, play, playNext, playPrev, togglePlay } from '@/core/player/player'
// 【第 49 轮】任何遥控命令（两条通路进来的都算）都要续期「超时退出」的交互时间
import { markTimeoutExitInteraction } from '@/core/player/timeoutExit'
// 【第 22 轮】用户手动暂停闸门：置位后所有自动续播入口都不许出声（见 core/player/manualPause.ts）
// 【第 49 轮】遥控漏斗的 pause 分支落闸（markManualPause）—— remoteCommand.ts 已瘦身为纯适配器
import { clearManualPause, isManualPause, markManualPause } from '@/core/player/manualPause'
import { initUnifiedPlayerController } from './controller'
import { exitApp } from '@/core/common'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
// 【第 41 轮】打断恢复后的音量重贴也是一次「外部直写」：同步渐入渐出模块的当前音量账本
import { syncVolumeFadeState } from './volumeFade'

let isInitialized = false
let shouldResumeAfterDuck = false
let duckRecoveryTimeouts: Array<ReturnType<typeof setTimeout>> = []

const clearDuckRecoveryTimeouts = () => {
  for (const timeout of duckRecoveryTimeouts) clearTimeout(timeout)
  duckRecoveryTimeouts = []
}

// —— 第 21 轮·优化 1：「最近 3s 确实在播」时间窗 ——
// 记恢复意图不再用中断开始瞬间的 playerState.isPlay 快照：车机蓝牙下导航播报（或来电）
// 会先触发一次路由暂停，isPlay 已经被置成 false，中断通知随后才到；用快照就会把
// 「刚才明明在播」误记成「用户已经暂停」，表现为播报结束不恢复（用户第 21 轮报的 bug）。
// 「确实在播」的时刻由 1s 心跳刷新，心跳只在播放期间存在（暂停后下一拍自己停表），
// 不为待机添功耗。
const RECENT_PLAYING_WINDOW_MS = 3000
// 超过这个时长的抢占视为「其它App长期占用音频」：即使 iOS 没给 ShouldResume（RNTP 报
// permanent）也不抢回来，避免和导航/通话拉锯；短于它的短暂中断（播报、提示音）仍恢复。
const SHORT_INTERRUPTION_MAX_MS = 30000
let lastPlayingAt = 0
let playingHeartbeat: ReturnType<typeof setInterval> | null = null
let interruptedAt = 0

// —— 第 31 轮·追加：短暂系统音忽略窗口 ——
// 电源键的锁定音 / 系统提示音这类短促系统音同样会让 iOS 发一对「打断开始 → 很快结束」。
// 独占模式下立刻 pause 会把一声提示音放大成「音乐被切一下再接回」（用户报：按电源键或
// 系统提示音时音乐会短暂变化）。改为延迟决定：窗口内「结束」先到 → 当作提示音，播放
// 全程不被触碰；超时才真正 pause（导航 / 通话 / 其它音乐照旧）。任何用户动作（播放 /
// 切歌 / 停止 / 遥控）都会撤销待决暂停 —— 用户要的音乐优先。数值与原生侧
// LXShortInterruptionIgnoreMs 同值，可在真机上按需调。
const SHORT_INTERRUPTION_IGNORE_MS = 1500
let interruptionPauseTimer: ReturnType<typeof setTimeout> | null = null

const clearInterruptionPauseTimer = () => {
  if (interruptionPauseTimer != null) {
    clearTimeout(interruptionPauseTimer)
    interruptionPauseTimer = null
  }
}

// 窗口到期 = 打断仍在持续：按旧口径立即暂停（用户动作会提前撤销本计时器；
// 到点前已停止播放也不再出声）。
const scheduleInterruptionPause = () => {
  clearInterruptionPauseTimer()
  interruptionPauseTimer = setTimeout(() => {
    interruptionPauseTimer = null
    if (global.lx.isPlayedStop) return
    void pause()
  }, SHORT_INTERRUPTION_IGNORE_MS)
}

const stopPlayingHeartbeat = () => {
  if (playingHeartbeat != null) {
    clearInterval(playingHeartbeat)
    playingHeartbeat = null
  }
}

// 标记「此刻确实在播」并保证心跳在跑；心跳随后每 1s 刷新一次，
// 一旦发现已经不在播就自己停表（lastPlayingAt 保留 —— 时间窗要能跨过这次暂停）。
const startPlayingHeartbeat = () => {
  lastPlayingAt = Date.now()
  if (playingHeartbeat != null) return
  playingHeartbeat = setInterval(() => {
    if (playerState.isPlay) lastPlayingAt = Date.now()
    else stopPlayingHeartbeat()
  }, 1000)
}

/** 「最近 3s 确实在播」：此刻在播，或者最后一次确认在播发生在 3s 之内 */
const wasPlayingRecently = () => {
  if (playerState.isPlay) {
    // 此刻在播：顺手刷新时刻并起心跳（兜住 play 事件没送达的途径）
    startPlayingHeartbeat()
    return true
  }
  return lastPlayingAt > 0 && Date.now() - lastPlayingAt <= RECENT_PLAYING_WINDOW_MS
}

/** 【第 24 轮】「与其他应用同时播放」是否开启（勾选 = player.isHandleAudioFocus 为 false）。 */
const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] === false

// —— iOS 被其它软件抢占后“自动续播”的辅助 ——
// 打断刚结束时音频会话未必能立刻激活、play() 也是异步的，因此补试一次（600ms 后）；
// 期间一旦用户手动暂停/切歌/停止/真正播放，都会取消。
const RESUME_RETRY_DELAYS = [600]
let resumeTimer: ReturnType<typeof setTimeout> | null = null
let resumeRetryCount = 0
let wasBackgroundPlaying = false

const clearResumeTimer = () => {
  if (resumeTimer != null) {
    clearTimeout(resumeTimer)
    resumeTimer = null
  }
}

// 【第 20 轮·遥控命令单一通路（2026-10-03）】导出给遥控命令漏斗调用（第 49 轮起是本文件的
// dispatchRemoteCommand；在此之前是 remoteCommand.ts）：
// 用户手动播放/暂停（锁屏 / 控制中心 / 车机方向盘）后必须现场作废「被抢占自动续播」
// 的待恢复标记，否则用户手动暂停后仍会被 scheduleAutoResume 兜底逻辑重新拉起。
// 不能改挂到 app_event 'pause' 上：缓冲时的暂停也发那个事件，会把标记误清。
export const cancelResumePending = () => {
  shouldResumeAfterDuck = false
  resumeRetryCount = 0
  // 【第 33 轮第 4 条】「不放停」重取阶梯同样属于「待恢复」意图：用户任何明确动作
  //（播放、手动暂停、切歌、停止、遥控、自然播完）都会走到这里，一并撤销。
  clearMixReclaimTimer()
  clearResumeTimer()
  // 【第 31 轮·追加】任何「用户意图 / 播放状态明确」的动作都会走到这里（播放、手动暂停、
  // 切歌、停止、遥控、自然播完）：一并撤销短暂系统音窗口里的待决暂停。
  clearInterruptionPauseTimer()
}

// —— 第 49 轮·漏斗去重（双通路并存）——
// 窗口取值依据：真实连按间隔 ≥100ms，远大于一次命令的处理时间；被丢弃的重复项
// **不刷新**时间戳（否则持续投递会把窗口无限延长，把之后用户的正常连按一并吞掉）。
// play / pause / toggle 共用一条合成的「播放暂停」键，两条通路给的命令名可能不同
//（原生侧固定发 toggle，RNTP 侧按状态发 play 或 pause），所以按命令名各自计时即可 ——
// 不同名命令本就该各执行一次，不会互相吞。
const ACTION_DEDUP_WINDOW_MS = 150
const SKIP_DEDUP_WINDOW_MS = 100
const SEEK_DEDUP_WINDOW_MS = 100
const SEEK_DEDUP_POSITION_TOLERANCE = 0.5

const lastActionCommandAt: Record<'play' | 'pause' | 'toggle', number> = { play: 0, pause: 0, toggle: 0 }
const lastSkipCommandAt: Record<'next' | 'previous', number> = { next: 0, previous: 0 }
const lastSeek = { at: 0, position: Number.NaN }

// 返回 true = 重复投递，丢弃。
const shouldSuppressActionCommand = (command: 'play' | 'pause' | 'toggle') => {
  const now = Date.now()
  if (now - lastActionCommandAt[command] < ACTION_DEDUP_WINDOW_MS) return true
  lastActionCommandAt[command] = now
  return false
}

// 返回 true = 重复投递，丢弃。
const shouldSuppressSkipCommand = (command: 'next' | 'previous') => {
  const now = Date.now()
  if (now - lastSkipCommandAt[command] < SKIP_DEDUP_WINDOW_MS) return true
  lastSkipCommandAt[command] = now
  return false
}

// seek 的重复判据是「同一位置」：拖动本身会送来一串**不同**位置，纯时间窗会把拖动吞掉。
const shouldSuppressSeekCommand = (position: number) => {
  const now = Date.now()
  if (now - lastSeek.at < SEEK_DEDUP_WINDOW_MS && Math.abs(position - lastSeek.position) <= SEEK_DEDUP_POSITION_TOLERANCE) return true
  lastSeek.at = now
  lastSeek.position = position
  return false
}

// —— 第 49 轮·双通路单一漏斗（2026-10-10）——
// 锁屏 / 灵动岛 / 控制中心 / 车机 / 耳机的遥控命令有**两条**原生通路可以送达 JS：
//   ① 本工程原生侧：MPRemoteCommandCenter 的 target（AppDelegate.mm LXInstallRemoteCommandHandlers）
//      → NSNotification 'LXRemoteCommand' → UtilsModule 'remote-command' 事件
//      → src/core/init/player/remoteCommand.ts（第 49 轮起为纯适配器，转手调本漏斗）；
//   ② RNTP 原生侧：SwiftAudioEx RemoteCommandController 的 target → remote-play / remote-pause /
//      remote-next / remote-previous / remote-seek 事件 → 本文件（下方 registerPlaybackService）。
// 第 20 轮曾把 ② 整条删掉以消除「一次按键跳两首」（iOS 会把同一条命令投递给**所有** target，
// 两条通路各跑一遍 playNext）；但只留 ① 时 ① 一旦失效就没有任何兜底 —— 用户第 43~49 轮连续
// 复现的「锁屏/灵动岛按键没反应、进度条拖不动」正落在这种只剩单点的情况下。参考工程
//（lx-music-mobile-ios-adaptation）两条通路都在、锁屏一切正常（它能拖进度条，靠的正是 ② 的
// RemoteSeek 监听）—— 第 49 轮据此按用户授权 1:1 恢复 ②。并存后的重复投递一律由本漏斗的
// 窗口去重兜住：无论命令来自哪条通路、甚至两条都来，都只执行一次。
// 任何遥控命令都先续期「超时退出」的交互时间（用户正在操作，超时不许在操作中途触发）。
export const dispatchRemoteCommand = (command: string, position?: number) => {
  markTimeoutExitInteraction()

  switch (command) {
    case 'play':
      // 用户手动(锁屏/通知栏/耳机/车机)要求播放：作废「被抢占后自动续播」的
      // 待恢复标记，直接播放（与旧 RNTP RemotePlay 监听同一口径）
      if (shouldSuppressActionCommand('play')) break
      cancelResumePending()
      play()
      break
    case 'pause':
      // 用户手动要求暂停：清除自动续播标记，避免之后被兜底逻辑误自动播放
      // 【第 22 轮】再落一道「手动暂停」闸门：只清一次标记挡不住打断开始 / 回前台这类
      // **重新**置位的途径（用户报的「手动暂停后，其它音频播完回软件又自己开始播放」）。
      // 【第 35 轮第 1 条】闸门只在「这次 pause 真的会暂停」时才落。配合原生侧
      // 「显示态与启停态同源」的可用性判据（AppDelegate.mm LXSyncRemoteCommandAvailability，
      // 第 36 轮按参考工程定），
      // 锁屏卡片重绘期间（playbackState 被短暂切成相反值）系统可能按**显示出来的**状态
      // 投递一条与真实播放态相反的 pause/play —— 那条 pause 落到一首本来就在暂停的歌上时，
      // 只会白白把闸门锁死，之后所有自动续播入口都不再出声（第 22 轮那个 bug 的另一种成因）。
      // 已经暂停就不动闸门：pause() 本身幂等，重复调用无副作用。
      if (shouldSuppressActionCommand('pause')) break
      if (playerState.isPlay) markManualPause()
      cancelResumePending()
      void pause()
      break
    case 'toggle':
      if (shouldSuppressActionCommand('toggle')) break
      cancelResumePending()
      togglePlay()
      break
    case 'next':
      if (shouldSuppressSkipCommand('next')) break
      void playNext()
      break
    case 'previous':
      if (shouldSuppressSkipCommand('previous')) break
      void playPrev()
      break
    case 'seek':
      // 拖进度条：位置非法（事件里没带字段）直接丢；两条通路同时送达的**同一位置**
      // 只认第一份（拖动过程本身是一串变化的位置，不受影响）
      if (typeof position != 'number') break
      if (shouldSuppressSeekCommand(position)) break
      global.app_event.setProgress(position)
      break
  }
}

const scheduleAutoResume = () => {
  clearResumeTimer()
  if (global.lx.isPlayedStop || playerState.isPlay) return cancelResumePending()
  // 【第 22 轮】手动暂停闸门：用户主动暂停后，即使各条路径又把待恢复标记立了起来
  //（打断开始 / 退后台预置），这里也一律不出声，直到用户自己重新按下播放。
  if (isManualPause()) return cancelResumePending()
  if (!shouldResumeAfterDuck) return
  shouldResumeAfterDuck = false
  resumeRetryCount = 0
  const attempt = () => {
    if (global.lx.isPlayedStop) return cancelResumePending()
    if (playerState.isPlay) return cancelResumePending()
    play()
    if (resumeRetryCount >= RESUME_RETRY_DELAYS.length) return cancelResumePending()
    const delay = RESUME_RETRY_DELAYS[resumeRetryCount++]
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      attempt()
    }, delay)
  }
  attempt()
}

// —— 第 33 轮第 4 条：勾选「与其他应用同时播放」期间的「不放停」兜底 ——
// 非混音会话下系统打断仍会让底层引擎停摆（原生 Began 分支：不对外呈现暂停、但照停引擎
// 并让出会话）；若「结束」通知因进程被挂起 / 平台异常没送达，就留下「状态在播、没有声音」，
// 而现有各条自动续播路径都救不了（scheduleAutoResume 在 playerState.isPlay 为真时直接早退）。
// 这里在混音分支补一条**有界**的重取阶梯：按固定延时调 play() 重取会话 / 重启引擎
//（nativeFlac 路径 = 原生 resume：prepareAudioSession 抢回会话 + 重启引擎；引擎已在播时
// 该调用幂等，不会重复发声）。用户任何明确动作（手动暂停 / 停止 / 切歌 / 开始播放）都会经
// cancelResumePending 撤销整条阶梯。延时表集中在这里，真机可按需调。
const MIX_RECLAIM_DELAYS = [1200, 3000, 7000, 15000]
let mixReclaimTimer: ReturnType<typeof setTimeout> | null = null
let mixReclaimCount = 0

const clearMixReclaimTimer = () => {
  if (mixReclaimTimer != null) {
    clearTimeout(mixReclaimTimer)
    mixReclaimTimer = null
  }
  mixReclaimCount = 0
}

const scheduleMixReclaim = () => {
  if (!isPlayWithOthers()) return
  clearMixReclaimTimer()
  const attempt = () => {
    mixReclaimTimer = null
    if (global.lx.isPlayedStop || !playerState.isPlay || isManualPause() || !isPlayWithOthers()) return clearMixReclaimTimer()
    // 与 scheduleAutoResume 同一原语：play() 在 nativeFlac 路径落到原生 resume，
    // 引擎已在播时幂等（不会重复出声）。
    play()
    if (mixReclaimCount >= MIX_RECLAIM_DELAYS.length) return clearMixReclaimTimer()
    const delay = MIX_RECLAIM_DELAYS[mixReclaimCount++]
    mixReclaimTimer = setTimeout(attempt, delay)
  }
  mixReclaimTimer = setTimeout(attempt, MIX_RECLAIM_DELAYS[0])
  mixReclaimCount = 1
}

const restoreConfiguredVolume = () => {
  clearDuckRecoveryTimeouts()

  const applyVolume = () => {
    // 【第 41 轮】打断恢复（duck 回填）的直写同样要同步账本：账本脱节会让下一次
    // 渐入/渐出的第一拍变成跳变（那一声爆音）。斜坡在跑时以斜坡写入为准，不覆盖。
    syncVolumeFadeState(settingState.setting['player.volume'])
    void TrackPlayer.setVolume(settingState.setting['player.volume']).catch(() => {})
  }

  applyVolume()
  duckRecoveryTimeouts = [250, 1000].map(delay => setTimeout(applyVolume, delay))
}

const registerPlaybackService = async() => {
  if (isInitialized) return

  console.log('reg services...')
  initUnifiedPlayerController()

  // 【第 49 轮·双通路单一漏斗（2026-10-10）】五段 RNTP 遥控监听恢复（1:1 对齐参考工程
  // lx-music-mobile-ios-adaptation 的 registerPlaybackService —— 用户的锁屏能点、进度条
  // 能拖就是靠这条路；第 20 轮删掉它们是为「一次按键跳两首」，现在重复投递改由
  // dispatchRemoteCommand 的窗口去重兜住，不再靠删通路）。
  // 处理逻辑一律不写在这儿：命令名转手交给漏斗，语义（播放/暂停落点、手动暂停闸门、
  // 去重）只有一份实现，与 remoteCommand.ts 转手的 'remote-command' 事件共用。
  TrackPlayer.addEventListener(TPEvent.RemotePlay, () => {
    dispatchRemoteCommand('play')
  })

  TrackPlayer.addEventListener(TPEvent.RemotePause, () => {
    dispatchRemoteCommand('pause')
  })

  TrackPlayer.addEventListener(TPEvent.RemoteNext, () => {
    dispatchRemoteCommand('next')
  })

  TrackPlayer.addEventListener(TPEvent.RemotePrevious, () => {
    dispatchRemoteCommand('previous')
  })

  TrackPlayer.addEventListener(TPEvent.RemoteSeek, ({ position }) => {
    dispatchRemoteCommand('seek', position as number)
  })

  // RemoteStop（停止退出）与 RemoteDuck（来电/路由打断的音量闪避与自动续播见下方
  // autoResume 兜底注释）是 RNTP 独有的两条：本工程原生侧不转发，落点只能在这里。
  TrackPlayer.addEventListener(TPEvent.RemoteStop, () => {
    // console.log('remote-stop')
    cancelResumePending()
    clearDuckRecoveryTimeouts()
    global.lx.isPlayedStop = false
    exitApp('Remote Stop')
  })

  TrackPlayer.addEventListener(TPEvent.RemoteDuck, ({ permanent, paused, ducking }) => {
    // iOS 侧的三种事件（RNTP ios/RNTrackPlayer/RNTrackPlayer.swift 的 handleInterruption，
    // 上游 fork commit d4a062f7 原样）：
    //   打断开始            → { paused: true }                     ← 没有 permanent
    //   打断结束·应恢复      → { paused: false }                    ← iOS 给了 ShouldResume
    //   打断结束·不该自动恢复 → { paused: true, permanent: true }    ← iOS 没给 ShouldResume
    // 【第 21 轮·优化 1】分流必须用 permanent 一起判：只看 paused 会把第三种（结束）
    // 当成新的打断开始，于是永远等不到「恢复」这一步 —— 正是用户报的「播报结束后不恢复」
    // 的另一半原因（另一半是 dependencies-patch.js 补上的「缺 ShouldResume 也要发事件」）。
    // Android 才有真正意义上的 permanent（永久失去 audio focus），语义见下方分支。
    if (Platform.OS == 'ios') {
      // 【第 24 轮】「与其他应用同时播放」（勾选 = !player.isHandleAudioFocus）单独一条策略分支。
      // 【第 33 轮第 4 条】会话口径更新：勾选态下**允许**混音（用户原话「退出灵动岛占用……
      // 不论后台什么音频在播，软件音频正常播放」），落点是原生流式引擎（无损档）的
      // prepareAudioSession 混音分支（AppDelegate.mm，由 LXPlayWithOthersEnabled 守卫）；
      // 但 RNTP / AVPlayer 这条路径（非无损档）的会话分类仍是 setupPlayer 时定死的非混音
      //（运行期改分类 = 第 24 轮实锤的 -50 禁区，见 plugins/player/index.ts 的会话注释），
      // 所以这条策略分支仍要承担「不因其它音频暂停自己 + 引擎被停掉后拉回来」：
      //   打断开始 → 不调 pause()、不对外呈现暂停（原生 Began 分支同口径不 emit paused），
      //              并布防有界重取阶梯（scheduleMixReclaim，第 33 轮第 4 条）
      //   打断结束 → 恢复音量 + 走自动续播（原生侧会重启引擎，两边幂等）
      // 取消勾选即回到下面的独占分支（第 21/22 轮口径：暂停 + 短暂中断自动续播，一字未改）。
      if (isPlayWithOthers()) {
        if (ducking) {
          // 仅降低音量(混合播放)：不暂停，只记时刻与待恢复意图
          shouldResumeAfterDuck ||= !isManualPause() && wasPlayingRecently()
          interruptedAt = Date.now()
          clearDuckRecoveryTimeouts()
          return
        }
        if (paused && !permanent) {
          // 打断开始：**不暂停**。与独占分支的唯一区别就是去掉 void pause() —— 用户在
          // 「同时播放」下要求其它音频不能让我们停下来（第 24 轮需求 1）。恢复意图照记，
          // 但受手动暂停闸门约束，用户主动暂停后不会自说自话出声。
          if (!global.lx.isPlayedStop && !isManualPause()) shouldResumeAfterDuck = true
          interruptedAt = Date.now()
          clearDuckRecoveryTimeouts()
          // 【第 33 轮第 4 条】打断开始即布防「不放停」重取阶梯：引擎若被系统停掉而「结束」
          // 通知丢失，这条阶梯会把声音拉回来（isPlay 仍为真时其余自动续播路径全线早退）。
          scheduleMixReclaim()
          clearResumeTimer()
          return
        }
        // 打断结束 / 音量恢复：把音量拉回配置值，并给自动续播一次机会（未被手动暂停时才出声）
        interruptedAt = 0
        restoreConfiguredVolume()
        scheduleAutoResume()
        // 【第 33 轮第 4 条】结束分支也布防一次：通知顺序异常（先结束后又有残留打断）时兜底
        scheduleMixReclaim()
        return
      }
      if (ducking) {
        // 仅降低音量(混合播放)：暂不暂停，记录待恢复
        // 【第 21 轮·优化 1】改用「最近 3s 确实在播」：车机蓝牙下导航播报会先走一次
        // 路由暂停（isPlay 已是 false），这里若还看瞬间快照就记不上恢复意图。
        // 【第 22 轮】手动暂停闸门优先：3s 时间窗会把「手动暂停后 3 秒内被打断」误记成
        //「刚才确实在播」，用户手动暂停后其它音频一响就把恢复意图立起来 —— 直接否决。
        shouldResumeAfterDuck ||= !isManualPause() && wasPlayingRecently()
        interruptedAt = Date.now()
        clearDuckRecoveryTimeouts()
        return
      }
      if (paused && !permanent) {
        // 打断开始：自动暂停并记录“待自动续播”。
        // 不能依赖当前 isPlay 判断：native 可能先把状态置为暂停、事件顺序不定，
        // 只要收到打断开始(且不是用户手动停止/结束)就视为需要恢复。
        // 【第 21 轮·优化 1】记下打断开始时刻，结束分支据此区分短暂中断与长时间抢占。
        // 【第 22 轮】手动暂停闸门：用户主动暂停在先，其它音频引起的打断不允许立恢复意图
        //（用户报的「别的音频播完就自己开始播放」的主要来源就是这条无条件置位）。
        if (!global.lx.isPlayedStop && !isManualPause()) shouldResumeAfterDuck = true
        interruptedAt = Date.now()
        clearDuckRecoveryTimeouts()
        clearResumeTimer()
        // 【第 31 轮·追加】短暂系统音忽略窗口：不立刻暂停，推迟 SHORT_INTERRUPTION_IGNORE_MS；
        // 窗口内若「结束」先到（电源键 / 提示音），待决暂停被撤销，播放全程不被触碰。
        scheduleInterruptionPause()
        return
      }
      // 打断结束 / 音量恢复：若之前被自动暂停则继续播放（带退避补试）
      // 【第 21 轮·优化 1】iOS 在很多抢占场景（车机蓝牙 + 导航播报）下不带
      // AVAudioSessionInterruptionOptionKey（RNTP 侧因此报 permanent=true，且旧版 RNTP
      // 会直接 return 不发事件 —— dependencies-patch.js 已补）。短暂中断照旧恢复；
      // 只有连续超过 SHORT_INTERRUPTION_MAX_MS 的抢占才保持暂停，不跟导航/通话抢音频。
      // 【第 31 轮·追加】窗口内结束 = 电源键 / 系统提示音这类短暂系统音：我们还没暂停过 ——
      // 撤销待决。scheduleAutoResume 只在「真被停掉」时出声（还在播 → 直接取消意图不出声，
      // 见其内部 isPlay 判定）—— 短暂系统音不留停播，也不做多余的恢复动作。
      if (interruptionPauseTimer != null) {
        clearInterruptionPauseTimer()
        interruptedAt = 0
        return scheduleAutoResume()
      }
      const wasLongInterruption = interruptedAt > 0 && Date.now() - interruptedAt > SHORT_INTERRUPTION_MAX_MS
      interruptedAt = 0
      if (permanent && wasLongInterruption) return cancelResumePending()
      restoreConfiguredVolume()
      scheduleAutoResume()
      return
    }

    // —— Android：保留原 audio focus 语义 ——
    if (permanent) {
      // Android 永久失去焦点(其它App持续出声)不自动抢回
      shouldResumeAfterDuck = false
      clearDuckRecoveryTimeouts()
      if (paused) void pause()
      return
    }

    if (ducking) {
      shouldResumeAfterDuck ||= playerState.isPlay
      clearDuckRecoveryTimeouts()
      return
    }

    if (paused) {
      shouldResumeAfterDuck = playerState.isPlay
      clearDuckRecoveryTimeouts()
      void pause()
      return
    }

    if (ducking === false) restoreConfiguredVolume()

    if (shouldResumeAfterDuck) {
      shouldResumeAfterDuck = false
      // 【第 22 轮】手动暂停闸门：与 iOS 同一口径 —— 用户主动暂停后不自动出声
      if (!isManualPause()) play()
    }
  })

  // （原 RemoteSeek 监听同样已删除：seek 现在只走 remoteCommand.ts 的 'seek' 分支，
  //   两条通路重复 seek 会互相覆盖，控制中心拖一下进度条实际跳两次。）
  // 【第 21 轮·优化 1】服务注册时若已经在播（冷启动直接恢复播放等），先把「确实在播」
  // 心跳起起来：这类途径不一定补发 'play' 事件，没有心跳时暂停后时间窗会立刻过期。
  if (playerState.isPlay) startPlayingHeartbeat()

  isInitialized = true
}


export default () => {
  if (global.lx.playerStatus.isRegisteredService) return
  console.log('handle registerPlaybackService...')
  TrackPlayer.registerPlaybackService(() => registerPlaybackService)
  global.lx.playerStatus.isRegisteredService = true

  // —— iOS：被其它软件出声抢占、自动暂停后的“自动续播”兜底 ——
  // 1) 进入后台瞬间若正在播放，先“预置”待续播标记：native 可能在应用被挂起期间因其它
  //    App 抢占而直接暂停，此时 RemoteDuck/JS 事件收不到；回到前台后据此自动续播。
  // 2) RemoteDuck 的“中断结束”事件若没能送达 JS，回到前台时也据此补一次续播。
  // 清除时机：用户手动暂停/播放（锁屏、控制中心、车机 —— 第 20 轮起由唯一入口
  // remoteCommand.ts 调用 cancelResumePending，本文件不再监听 remote-* 事件）、
  // 真正开始播放(play)、切歌(musicToggled)、歌曲自然结束(playerEnded)、
  // 停止退出(RemoteStop/isPlayedStop) 都会取消，不会误自动播放。
  // 【第 21 轮·优化 1】补挂 app_event 'stop'：显式停止后一律作废待续播标记
  //（旧实现只靠 RemoteStop / isPlayedStop 兜，应用内点「停止」不会清）。
  // 改用「最近 3s 确实在播」记意图后，'play' 时还要顺手把「确实在播」心跳起起来。
  AppState.addEventListener('change', (state) => {
    if (state == 'background') {
      // iOS：退到后台瞬间若正在播放先预置续播标记；Android 有自己的 audio focus 流程，不在此预置
      // 【第 21 轮·优化 1】判定同样换成「最近 3s 确实在播」：车机蓝牙下高德播报会先触发
      // 路由暂停，退后台那一刻 isPlay 可能刚被置 false，旧写法会漏掉这次预置。
      wasBackgroundPlaying = Platform.OS == 'ios' && wasPlayingRecently()
      // 【第 22 轮】手动暂停闸门：用户暂停后 3s 内切后台，wasPlayingRecently 仍是 true
      //（时间窗故意要跨过暂停），但这不是「刚才在播」而是「刚被用户叫停」——不预置续播标记。
      if (wasBackgroundPlaying && !global.lx.isPlayedStop && !isManualPause()) shouldResumeAfterDuck = true
      return
    }
    if (state != 'active') return
    const wasBgPlaying = wasBackgroundPlaying
    wasBackgroundPlaying = false
    if (global.lx.isPlayedStop || playerState.isPlay) {
      // 【第 33 轮第 4 条】勾选「与其他应用同时播放」+ 状态在播：回前台补一次会话重取。
      // 后台期间引擎被系统停掉而「结束」通知没送达时，这是把声音拉回来的兜底路径
      //（scheduleAutoResume 在 isPlay 为真时不动作）。先 cancel 再 arm，避免刚布防就被撤销。
      const reclaim = playerState.isPlay && !global.lx.isPlayedStop && !isManualPause() && isPlayWithOthers()
      cancelResumePending()
      if (reclaim) scheduleMixReclaim()
      return
    }
    // 回到前台且已暂停：仅在开启「返回软件时自动播放」且暂停确由系统中断/其它音频抢占造成时自动续播
    //（shouldResumeAfterDuck 只在被系统打断或退后台预置时置位，用户手动暂停/切歌/自然结束都会先清除标记）
    if (wasBgPlaying && shouldResumeAfterDuck && settingState.setting['player.autoPlayOnReturn']) scheduleAutoResume()
  })
  // 一旦进入播放(任意途径触发)，清除待续播标记，避免后续重复自动播放
  global.app_event.on('play', () => {
    // 【第 21 轮·优化 1】开始播放 = 「确实在播」时间窗起点，心跳负责在随后每秒续期
    startPlayingHeartbeat()
    cancelResumePending()
    // 【第 22 轮】播放真正开始（用户重新按播放 / 点歌 / 切歌）：抬起「手动暂停」闸门，
    // 之后的抢占-恢复流程照旧。这是闸门唯一的复位口（见 core/player/manualPause.ts）。
    clearManualPause()
  })
  // 【第 21 轮·优化 1】显式停止：作废待续播标记并停表（用户明确不要放了，不能自动拉起）
  global.app_event.on('stop', () => {
    stopPlayingHeartbeat()
    cancelResumePending()
  })
  // 歌曲自然播放结束：若停在后台结束的，不应在回到前台时被“自动续播”重新拉起
  global.app_event.on('playerEnded', () => {
    cancelResumePending()
  })
  // 切换歌曲：作废旧歌的待续播标记，避免新歌加载失败后误恢复
  global.app_event.on('musicToggled', () => {
    cancelResumePending()
  })
}
