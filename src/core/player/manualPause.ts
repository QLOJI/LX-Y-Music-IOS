// 【第 22 轮】「用户手动暂停」闸门。
//
// 用户原话：「手动暂停后，播放其他音频结束，返回软件时也会自动开始播放，
// 改为手动暂停后所有条件都不会播放的」。
//
// 旧实现里「被抢占后自动续播」的意图标记（plugins/player/service.ts 的 shouldResumeAfterDuck）
// 有两条会在手动暂停之后**重新**立起来的途径：
//   ① iOS 打断开始（RemoteDuck { paused: true }）：只要不是显式停止（isPlayedStop）就无条件
//      记「待恢复」——用户暂停后去其它 App 放音频，一次打断就把标记又立了起来；
//   ② 退到后台 / 音量打断时的 wasPlayingRecently() 3s 时间窗：手动暂停后 lastPlayingAt 仍在
//      窗口内，「暂停后 3 秒内切后台」会被当成「刚才确实在播」。
// 于是用户手动暂停、去别的 App 放音频、回来（或那段音频一结束）就被自动拉起。
// 只在个别置位点补 cancelResumePending 治不了根：标记会被上面两条途径重新置起来。
//
// 这个模块只存一个布尔量：用户最后一次对播放状态的主动操作是不是「暂停」。
//   置位：应用内播放/暂停按钮（togglePlay 走到暂停分支）、遥控 'pause' 命令、
//         deeplink 'pause' —— 都是用户主动动作；
//         系统自动暂停（缓冲、来电/导航打断、耳机拔出、播放结束）**不**置位。
//   复位：播放真正开始（app_event 'play'）—— 用户重新播放后，后续抢占-恢复流程照旧生效。
//   消费：plugins/player/service.ts 的每一个自动续播入口先过这道闸门，为 true 一律不出声。
//
// 单独建文件而不是塞进 core/player/player.ts 或 plugins/player/service.ts：设置方与消费方
// 互相 import 会成环（core/player/player.ts ← plugins/player/service.ts 已是既有方向），
// 这个小模块谁都不依赖，两边都能安全引用。
let manualPaused = false

/** 用户手动暂停：落闸并保持，直到播放真正开始（clearManualPause） */
export const markManualPause = () => {
  manualPaused = true
}

/** 播放真正开始（任意途径，含用户重新播放）：抬闸 */
export const clearManualPause = () => {
  manualPaused = false
}

/** 用户是否处于「手动暂停」状态：true 时任何自动续播路径都不允许出声 */
export const isManualPause = () => manualPaused
