import { onRemoteCommand } from '@/utils/nativeModules/utils'
import { pause, play, playNext, playPrev, togglePlay } from '@/core/player/player'
import { markTimeoutExitInteraction } from '@/core/player/timeoutExit'
// 【第 20 轮·遥控命令单一通路（2026-10-03）】本文件是车机 / 方向盘 / 控制中心
// （MPRemoteCommandCenter → LXRemoteCommand → 'remote-command'）的**唯一**处理入口：
// src/plugins/player/service.ts 原先还挂着同一批命令的 RNTP 监听（remote-play 等），
// 一次按键两条通路各跑一遍 ⇒ 一次跳两首 / 播放暂停互相抵消 / 进度条重复 seek，
// 那些监听已删除，用户手动播放/暂停所需的 cancelResumePending 改由这里调用。
import { cancelResumePending } from '@/plugins/player/service'

// 切歌在途去重（第 20 轮·遥控命令单一通路，2026-10-03）。
// 车机侧对同一物理按键可能重复投递（一次按下送来多条 next/previous）——单通路之后
// 这是「一次按键跳两首」的剩余来源。真实连按间隔 ≥100ms，远大于一次切歌的处理时间，
// 所以 100ms 窗口不会吞掉用户操作；next 与 previous 各自计时，快速「下一曲→上一曲」
// 不会被误并成一条（共用一份时间戳时前者会吞掉后者）。
const SKIP_DEDUP_WINDOW_MS = 100
const lastSkipCommandAt: Record<'next' | 'previous', number> = { next: 0, previous: 0 }

// 返回 true = 重复投递，丢弃。
// 被丢弃的重复项**不刷新**时间戳：否则持续投递的重复项会把窗口无限延长，
// 把窗口之后用户的正常连按一并吞掉。
const shouldSuppressSkipCommand = (command: 'next' | 'previous') => {
  const now = Date.now()
  if (now - lastSkipCommandAt[command] < SKIP_DEDUP_WINDOW_MS) return true
  lastSkipCommandAt[command] = now
  return false
}

export default () => {
  onRemoteCommand((event) => {
    markTimeoutExitInteraction()

    switch (event.command) {
      case 'play':
        // 用户手动(锁屏/通知栏/耳机/车机)要求播放：作废「被抢占后自动续播」的
        // 待恢复标记，直接播放（与旧 RNTP RemotePlay 监听同一口径）
        cancelResumePending()
        play()
        break
      case 'pause':
        // 用户手动要求暂停：清除自动续播标记，避免之后被兜底逻辑误自动播放
        cancelResumePending()
        void pause()
        break
      case 'toggle':
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
        if (typeof event.position == 'number') {
          global.app_event.setProgress(event.position)
        }
        break
    }
  })
}
