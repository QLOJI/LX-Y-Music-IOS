/* eslint-disable @typescript-eslint/no-misused-promises */
import TrackPlayer, { Event as TPEvent } from 'react-native-track-player'
import { AppState, Platform } from 'react-native'
// 切歌（playNext/playPrev）与 markTimeoutExitInteraction 已随重复监听一并移出本文件：
// 现在只由唯一入口 remoteCommand.ts 调用（第 20 轮·遥控命令单一通路）。
import { pause, play } from '@/core/player/player'
// 【第 22 轮】用户手动暂停闸门：置位后所有自动续播入口都不许出声（见 core/player/manualPause.ts）
import { clearManualPause, isManualPause } from '@/core/player/manualPause'
import { initUnifiedPlayerController } from './controller'
import { exitApp } from '@/core/common'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'

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

// 【第 20 轮·遥控命令单一通路（2026-10-03）】导出给唯一入口 remoteCommand.ts 调用：
// 用户手动播放/暂停（锁屏 / 控制中心 / 车机方向盘）后必须现场作废「被抢占自动续播」
// 的待恢复标记，否则用户手动暂停后仍会被 scheduleAutoResume 兜底逻辑重新拉起。
// 不能改挂到 app_event 'pause' 上：缓冲时的暂停也发那个事件，会把标记误清。
export const cancelResumePending = () => {
  shouldResumeAfterDuck = false
  resumeRetryCount = 0
  clearResumeTimer()
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

const restoreConfiguredVolume = () => {
  clearDuckRecoveryTimeouts()

  const applyVolume = () => {
    void TrackPlayer.setVolume(settingState.setting['player.volume']).catch(() => {})
  }

  applyVolume()
  duckRecoveryTimeouts = [250, 1000].map(delay => setTimeout(applyVolume, delay))
}

const registerPlaybackService = async() => {
  if (isInitialized) return

  console.log('reg services...')
  initUnifiedPlayerController()

  // 【第 20 轮·遥控命令单一通路（2026-10-03）】这里**不再**监听 RNTP 的
  // RemotePlay / RemotePause / RemoteNext / RemotePrevious / RemoteSeek
  //（原来的五段监听已删除）。
  //
  // 根因（用户实锤，越狱 CarPlay）：同一批 MPRemoteCommandCenter 命令被挂了两套
  // target —— ① RNTP 原生侧（SwiftAudioEx RemoteCommandController）→ remote-* 事件
  // → 本文件；② 本工程原生侧（AppDelegate.mm 的 LXInstallRemoteCommandHandlers）
  // → 'remote-command' 事件 → core/init/player/remoteCommand.ts。一次物理按键两条
  // 通路各跑一遍 playNext() ⇒ 一次跳两首（短列表就成了「只在少数几首之间循环」）；
  // 播放/暂停则是开关两下互相抵消；控制中心进度条重复 seek。
  //
  // 现在的唯一入口是 remoteCommand.ts。RNTP 原生侧的 target 仍在、也仍会往 JS 发
  // remote-* 事件（命令能力由 plugins/player/utils.ts 的 defaultUpdateOptions 统一
  // 写入，两侧共享同一批命令对象，不要动它），但这里已无监听者，静默即无害。
  //
  // 只保留两个 RNTP 独有、本工程原生侧不转发的：RemoteStop（停止退出）与
  // RemoteDuck（来电/路由打断的音量闪避与自动续播见下方 autoResume 兜底注释）。
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
        void pause()
        return
      }
      // 打断结束 / 音量恢复：若之前被自动暂停则继续播放（带退避补试）
      // 【第 21 轮·优化 1】iOS 在很多抢占场景（车机蓝牙 + 导航播报）下不带
      // AVAudioSessionInterruptionOptionKey（RNTP 侧因此报 permanent=true，且旧版 RNTP
      // 会直接 return 不发事件 —— dependencies-patch.js 已补）。短暂中断照旧恢复；
      // 只有连续超过 SHORT_INTERRUPTION_MAX_MS 的抢占才保持暂停，不跟导航/通话抢音频。
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
    if (global.lx.isPlayedStop || playerState.isPlay) return cancelResumePending()
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
