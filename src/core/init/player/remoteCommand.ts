import { onRemoteCommand } from '@/utils/nativeModules/utils'
import { pause, play, playNext, playPrev, togglePlay } from '@/core/player/player'
import { markTimeoutExitInteraction } from '@/core/player/timeoutExit'
import playerState from '@/store/player/state'
// 【第 20 轮·遥控命令单一通路（2026-10-03）】本文件是车机 / 方向盘 / 控制中心
// （MPRemoteCommandCenter → LXRemoteCommand → 'remote-command'）的**唯一**处理入口：
// src/plugins/player/service.ts 原先还挂着同一批命令的 RNTP 监听（remote-play 等），
// 一次按键两条通路各跑一遍 ⇒ 一次跳两首 / 播放暂停互相抵消 / 进度条重复 seek，
// 那些监听已删除，用户手动播放/暂停所需的 cancelResumePending 改由这里调用。
import { cancelResumePending } from '@/plugins/player/service'
// 【第 22 轮】用户主动暂停要落「手动暂停」闸门（遥控 'pause' 分支），见 core/player/manualPause.ts
import { markManualPause } from '@/core/player/manualPause'

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
        // 【第 22 轮】再落一道「手动暂停」闸门：只清一次标记挡不住打断开始 / 回前台这类
        // **重新**置位的途径（用户报的「手动暂停后，其它音频播完回软件又自己开始播放」）。
        // 【第 35 轮第 1 条】闸门只在「这次 pause 真的会暂停」时才落。配合原生侧
        // 「有信息就永远启用全部命令」（AppDelegate.mm LXSyncRemoteCommandAvailability），
        // 锁屏卡片重绘期间（playbackState 被短暂切成相反值）系统可能按**显示出来的**状态
        // 投递一条与真实播放态相反的 pause/play —— 那条 pause 落到一首本来就在暂停的歌上时，
        // 只会白白把闸门锁死，之后所有自动续播入口都不再出声（第 22 轮那个 bug 的另一种成因）。
        // 已经暂停就不动闸门：pause() 本身幂等，重复调用无副作用。
        if (playerState.isPlay) markManualPause()
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
