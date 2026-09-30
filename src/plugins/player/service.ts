/* eslint-disable @typescript-eslint/no-misused-promises */
import TrackPlayer, { Event as TPEvent } from 'react-native-track-player'
import { AppState, Platform } from 'react-native'
import { pause, play, playNext, playPrev } from '@/core/player/player'
import { markTimeoutExitInteraction } from '@/core/player/timeoutExit'
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

// —— iOS 被其它软件抢占后“自动续播”的辅助 ——
// 打断刚结束时音频会话未必能立刻激活、play() 也是异步的，因此按退避补试几次；
// 期间一旦用户手动暂停/切歌/停止/真正播放，都会取消。
const RESUME_RETRY_DELAYS = [120, 500, 1500]
let resumeTimer: ReturnType<typeof setTimeout> | null = null
let resumeRetryCount = 0
let wasBackgroundPlaying = false

const clearResumeTimer = () => {
  if (resumeTimer != null) {
    clearTimeout(resumeTimer)
    resumeTimer = null
  }
}

const cancelResumePending = () => {
  shouldResumeAfterDuck = false
  resumeRetryCount = 0
  clearResumeTimer()
}

const scheduleAutoResume = () => {
  clearResumeTimer()
  if (global.lx.isPlayedStop || playerState.isPlay) return cancelResumePending()
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
  TrackPlayer.addEventListener(TPEvent.RemotePlay, () => {
    // console.log('remote-play')
    // 用户手动(锁屏/通知栏/耳机)要求播放：取消“被抢占后自动续播”的待恢复标记，直接播放
    cancelResumePending()
    markTimeoutExitInteraction()
    play()
  })

  TrackPlayer.addEventListener(TPEvent.RemotePause, () => {
    // console.log('remote-pause')
    // 用户手动要求暂停：清除自动续播标记，避免之后被兜底逻辑误自动播放
    cancelResumePending()
    markTimeoutExitInteraction()
    void pause()
  })

  TrackPlayer.addEventListener(TPEvent.RemoteNext, () => {
    // console.log('remote-next')
    markTimeoutExitInteraction()
    void playNext()
  })

  TrackPlayer.addEventListener(TPEvent.RemotePrevious, () => {
    // console.log('remote-previous')
    markTimeoutExitInteraction()
    void playPrev()
  })

  TrackPlayer.addEventListener(TPEvent.RemoteStop, () => {
    // console.log('remote-stop')
    cancelResumePending()
    clearDuckRecoveryTimeouts()
    global.lx.isPlayedStop = false
    exitApp('Remote Stop')
  })

  TrackPlayer.addEventListener(TPEvent.RemoteDuck, ({ permanent, paused, ducking }) => {
    // iOS 无 Android 的“永久/临时”audio focus 区分，来电/它App出声的“打断开始”与
    // “打断结束”都可能以 permanent==true 送达。这里改用 paused 区分两种状态，
    // 避免“结束”事件被当成永久失去焦点、把待自动续播标记覆盖掉而不恢复。
    if (Platform.OS == 'ios') {
      if (ducking) {
        // 仅降低音量(混合播放)：暂不暂停，记录待恢复
        shouldResumeAfterDuck ||= playerState.isPlay
        clearDuckRecoveryTimeouts()
        return
      }
      if (paused) {
        // 打断开始：自动暂停并记录“待自动续播”。
        // 不能依赖当前 isPlay 判断：native 可能先把状态置为暂停、事件顺序不定，
        // 只要收到打断开始(且不是用户手动停止/结束)就视为需要恢复。
        if (!global.lx.isPlayedStop) shouldResumeAfterDuck = true
        clearDuckRecoveryTimeouts()
        clearResumeTimer()
        void pause()
        return
      }
      // 打断结束 / 音量恢复：若之前被自动暂停则继续播放（带退避补试）
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
      play()
    }
  })

  TrackPlayer.addEventListener(TPEvent.RemoteSeek, async({ position }) => {
    markTimeoutExitInteraction()
    global.app_event.setProgress(position as number)
  })
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
  // 清除时机：用户手动暂停(RemotePause)、手动播放、真正开始播放(play)、切歌(musicToggled)、
  // 歌曲自然结束(playerEnded)、停止退出(RemoteStop/isPlayedStop) 都会取消，不会误自动播放。
  AppState.addEventListener('change', (state) => {
    if (state == 'background') {
      // iOS：退到后台瞬间若正在播放先预置续播标记；Android 有自己的 audio focus 流程，不在此预置
      wasBackgroundPlaying = Platform.OS == 'ios' && playerState.isPlay
      if (wasBackgroundPlaying && !global.lx.isPlayedStop) shouldResumeAfterDuck = true
      return
    }
    if (state != 'active') return
    const wasBgPlaying = wasBackgroundPlaying
    wasBackgroundPlaying = false
    if (global.lx.isPlayedStop || playerState.isPlay) return cancelResumePending()
    // 回到前台且已暂停：若退到后台前正在播放，则自动续播（用户手动暂停/切歌/自然结束都会先清除标记）
    if (wasBgPlaying) scheduleAutoResume()
  })
  // 一旦进入播放(任意途径触发)，清除待续播标记，避免后续重复自动播放
  global.app_event.on('play', () => {
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
