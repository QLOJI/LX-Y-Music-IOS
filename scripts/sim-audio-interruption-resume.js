#!/usr/bin/env node
/**
 * sim-audio-interruption-resume.js —— 「其他音频结束后自动续播 + 让出 / 让还音频会话」契约
 * （用户第 13 轮第 1 条 → 第 16 轮第 9 条修订）
 *
 * 第 13 轮需求原话（2026-10-02）：手动暂停时，其他音频播放结束后不会自动开始播放，
 * 只有不是手动暂停时，其他音频播放结束后会自动开始播放，而且其他音频播放时，要卸载
 * 占用音频，保证其他音频可以正常使用，其他音频结束播放时，再马上占用音频，开始自动播放。
 *
 * 第 16 轮需求原话（2026-10-02，第 9 条）：「这个问题还是没有达到效果，不是手动暂停时，
 * 其他音频播放结束后会自动开始播放，而且其他音频播放时，要卸载占用音频，保证其他音频
 * 可以正常使用，其他音频结束播放时，再马上占用音频，开始自动播放，目前会出现其他音频
 * 没有声音的情况，应该是没有卸载占用音频。」
 *   ⇒ 两点修订：
 *     ① 手动暂停 = 不续播（反转第 13 轮「与 manualPause 无关」的口径）；
 *     ② 「其他音频没声音」的根因是暂停态仍占着会话：pause 命令从
 *        prepareAudioSession（保持激活）改成 setActive:NO 让出会话；
 *        UIApplicationDidBecomeActive 观察者也只在实际播放时才重新激活会话。
 *
 * 收敛结果（ios/LxMusicMobile/AppDelegate.mm，原生 AVAudioEngine 流式 FLAC 路径）：
 *   Began：不再因为「没在出声 / 手动暂停」直接 return。只要拿到了打断通知就
 *     ① 置 interruptedBySystem（打断结束据此判断是否续播）；
 *     ② 在引擎确实停下后主动 setActive:NO + NotifyOthersOnDeactivation 让出会话。
 *   Ended：门槛 = interruptedBySystem && !manualPause。
 *     非手动暂停：抢回会话（prepareAudioSession）→ 起引擎 → maybeStartPlaybackLocked 续播；
 *     手动暂停：只清标记就返回，不抢会话、不续播（音频会话留给其他音频）。
 *     另一个不抢会话的出口：没有可播的流（sourceNode == nil / stopped / idle）。
 *   pause：置 manualPause + **保持会话常驻**（第 48 轮起不再 setActive:NO，见下），
 *     也不 prepareAudioSession（不主动抢）；interruptedBySystem 仍然不清
 *     （取消续播由 manualPause 门槛完成）。
 *
 * 第 48 轮（2026-10-10）：pause **不再主动让出音频会话**（删掉第 16 轮那一对
 * canReleaseSession + setActive:NO + NotifyOthersOnDeactivation）。用户原话：「锁屏界面和
 * 灵动岛界面还是不行，无法点击控制，无法拖动进度条调节播放时间，需要修复，请参考
 * lx-music-mobile-ios-adaptation 项目，这个项目的锁屏界面和灵动岛界面都可以控制，如果还是
 * 不行就一比一复制它的」。病根：暂停即让出会话 —— 卡片还在屏幕上，但本 App 不再是当前
 * 音频会话的持有者，系统把卡片画成失效态（灰 ▶ / 两侧 -:--）、MPRemoteCommandCenter 的
 * 按键与进度条拖动不再投递给本 App（第 43/44/45 轮「点一次就不能再点」的同一个根）。
 * 参考工程的会话是常驻的（它的 pause 只 prepareAudioSession，全文件没有任何 setActive:NO），
 * 本轮一比一对齐。第 16 轮第 9 条「暂停后其他音频要能出声」改由打断通路保证：其他音频
 * 激活自己的会话 → 系统发 Began → Began 执行体照旧 setActive:NO + NotifyOthersOnDeactivation
 * 交还会话（那条断言一个都没动）。
 *   DidBecomeActive：只有 now playing 状态是 Playing 时才 setActive:YES。
 *
 * 第 21 轮·优化 1（2026-10-03）：「关掉『与其他应用同时播放』后，车机蓝牙下高德播报即停、
 * 播报结束后不恢复；不外接蓝牙只 duck 正常」。根因三条 + 修法：
 *   ① 原生耳机拔出判定只看**旧**路由：导航播报抢走路由同样发 OldDeviceUnavailable 且旧路由
 *      是蓝牙 → 被误判成「耳机被拔」发 headphones-disconnected → JS 暂停。修法：判定同时看
 *      **新**路由（`routeHasHeadphoneOutput:` + currentRoute），抢占时新路由里车机还在 → 不发。
 *   ② JS 恢复意图只按中断开始瞬间的 isPlay 记：路由暂停先把 isPlay 置 false，中断事件随后才
 *      到 → 记成「用户已暂停」→ 不恢复。修法：service.ts 用「最近 3s 确实在播」时间窗
 *      （RECENT_PLAYING_WINDOW_MS + 1s 心跳）记意图；结束分支 permanent 且超过
 *      SHORT_INTERRUPTION_MAX_MS(30s) 才保持暂停；恢复后 600ms 只补试一次；意图由
 *      app_event 'stop' 清。
 *   ③ RNTP 中断结束分支缺 AVAudioSessionInterruptionOptionKey 时直接 return 不发事件：
 *      修法见 dependencies-patch.js 的 patchTrackPlayerInterruptionEndAlwaysEmit（`?? 0`）。
 *
 * 第 22 轮（2026-10-03）：「手动暂停后，播放其他音频结束，返回软件时也会自动开始播放」。
 * 根因：只清一次待恢复标记挡不住「打断开始 / 退后台预置」这些**重新置位**的途径
 * （打断开始分支是无条件 `shouldResumeAfterDuck = true`）。修法：service.ts 增加
 * 手动暂停闸门（core/player/manualPause.ts）—— 打断开始 / 退后台预置 / iOS 音量闪避 /
 * scheduleAutoResume 兜底 / Android 恢复，五处入口全部否决；app_event 'play'
 * （真正开始出声，含用户重新播放、点歌、切歌）是唯一复位口。
 *
 * 第 31 轮·追加（2026-10-04）：「按电源键 / 系统提示音时音乐会短暂声音变化」——短促系统音
 * 的「Began → Ended」也会被立刻处理成停引擎 / 让出会话。修法见
 * scripts/sim-short-interruption-ignore.js（两侧同值 1.5s 忽略窗口）：Began 只立即无条件置
 * interruptedBySystem，「停引擎 / 让出会话 / 呈现暂停」整段推迟到窗口到期。本脚本跟着把
 * 「Began 执行体」的锚点从 case 块改到 performInterruptionBeganHandling 方法体（上面这些
 * 要求语义一个不变）；case 块的「立即置标记 + 推迟调度」另由短窗口脚本断言。
 *
 * 本脚本从源码解析实际结构（不硬编码行号），每条关键断言配一个「改回旧实现就该判不合格」
 * 的反例自检。
 *
 * 运行：node scripts/sim-audio-interruption-resume.js
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const NATIVE = 'ios/LxMusicMobile/AppDelegate.mm'
const SERVICE = 'src/plugins/player/service.ts'
const PATCHER = 'dependencies-patch.js'

const results = []
let failed = 0
const check = (label, ok) => {
  results.push({ label, ok: !!ok })
  if (!ok) failed++
}

/** 取一个方法体：签名命中处起，到第一个位于行首的 `}` 为止 */
const methodBody = (s, signature) => {
  const start = s.indexOf(signature)
  if (start < 0) return null
  const rest = s.slice(start)
  const end = /\n\}\n/.exec(rest)
  return end ? rest.slice(0, end.index) : null
}

/** 取 switch 里某个 case 的块体：case 头起，到下一个 case / default 为止 */
const caseBody = (s, header, next) => {
  const start = s.indexOf(header)
  if (start < 0) return null
  const rest = s.slice(start + header.length)
  const end = rest.indexOf(next)
  return end < 0 ? null : rest.slice(0, end)
}

/** 取注册通知观察者的 block 体：从通知名命中处起，到该 block 的 `}];` 为止 */
const notificationBlock = (s, marker) => {
  const start = s.indexOf(marker)
  if (start < 0) return null
  const rest = s.slice(start)
  const end = rest.indexOf('}];')
  return end < 0 ? null : rest.slice(0, end)
}

const readSource = () => fs.readFileSync(path.join(ROOT, NATIVE), 'utf8')
const readService = () => fs.readFileSync(path.join(ROOT, SERVICE), 'utf8')
const readPatcher = () => fs.readFileSync(path.join(ROOT, PATCHER), 'utf8')

/** 去掉行注释：断言只看代码，避免中文说明里提到 manualPause / ShouldResume 造成假命中 */
const stripComments = (s) => s.split('\n').map((line) => {
  const at = line.indexOf('//')
  return at < 0 ? line : line.slice(0, at)
}).join('\n')

/** 全部断言都从这里取结构；反例把其中一份源码换掉再跑一遍 */
const evaluate = (src, js) => {
  const { service: serviceSrc, patch: patchSrc } = js
  const handler = methodBody(src, '- (void)handleAudioSessionInterruption:(NSNotification *)notification {')
  const began = handler && caseBody(handler, 'case AVAudioSessionInterruptionTypeBegan: {', 'case AVAudioSessionInterruptionTypeEnded:')
  const ended = handler && caseBody(handler, 'case AVAudioSessionInterruptionTypeEnded: {', 'default:')
  // 【第 31 轮·追加】Began 的实际执行体（推迟到忽略窗口到期才跑；原 Began 分支整段搬来）。
  // case 块只负责「立即置标记 + 推迟调度」—— 上面这些要求断言锚点改到本方法体。
  const beganExec = methodBody(src, '- (void)performInterruptionBeganHandling {')
  const pause = methodBody(src, 'RCT_REMAP_METHOD(pause, pauseStreamWithResolver:')
  const stop = methodBody(src, 'RCT_REMAP_METHOD(stop, stopStreamWithResolver:')
  const active = notificationBlock(src, 'UIApplicationDidBecomeActiveNotification')
  const beganCode = began ? stripComments(began) : null
  const beganExecCode = beganExec ? stripComments(beganExec) : null
  const endedCode = ended ? stripComments(ended) : null
  const pauseCode = pause ? stripComments(pause) : null
  const stopCode = stop ? stripComments(stop) : null
  const activeCode = active ? stripComments(active) : null

  const atMarker = beganExecCode ? beganExecCode.indexOf('self.interruptedBySystem = YES;') : -1
  const atEarlyReturn = beganExecCode ? beganExecCode.indexOf('if (!shouldEmitPause) return;') : -1
  const atCaseMarker = beganCode ? beganCode.indexOf('self.interruptedBySystem = YES;') : -1
  const atCaseDeferral = beganCode ? beganCode.indexOf('[self scheduleDeferredInterruptionBeganHandling];') : -1
  const atManualGate = endedCode ? endedCode.indexOf('if (self.manualPause) return;') : -1
  const atReacquire = endedCode ? endedCode.indexOf('[self prepareAudioSession:&sessionError]') : -1

  // —— 第 21 轮·优化 1：路由变化判定（真拔线 vs 被抢占）——
  const routeFn = methodBody(src, '- (BOOL)routeHasHeadphoneOutput:(AVAudioSessionRouteDescription *)route {')
  const routeChange = methodBody(src, '- (void)handleAudioRouteChange:(NSNotification *)notification {')
  const routeFnCode = routeFn ? stripComments(routeFn) : null
  const routeChangeCode = routeChange ? stripComments(routeChange) : null
  const prevCheck = methodBody(src, '- (BOOL)shouldEmitHeadphonesDisconnectedForPreviousRoute:(AVAudioSessionRouteDescription *)route {')
  const prevCheckCode = prevCheck ? stripComments(prevCheck) : null

  // —— 第 21 轮·优化 1：JS 恢复意图（service.ts）——
  const svc = stripComments(serviceSrc)
  const patcher = patchSrc

  return {
    // —— Began：立即无条件置标记 + 推迟执行（第 31 轮·追加）+ 让出会话（执行体）——
    began_noLegacyReturn: !!beganExecCode && !beganExecCode.includes('if (!shouldHandle || self.manualPause) return;'),
    began_markerBeforeReturn: atMarker >= 0 && atEarlyReturn >= 0 && atMarker < atEarlyReturn,
    // 【第 31 轮·追加】case 块本身：收到通知就立即置标记并把完整处理推迟 —— 块内不许再有
    // 任何 return（早退只可能发生在推迟执行体里，那里的顺序由上行断言守着）。
    began_immediateDeferral: atCaseMarker >= 0 && atCaseDeferral >= 0 && atCaseMarker < atCaseDeferral &&
      !!beganCode && !/\breturn;/.test(beganCode),
    began_releasesSession: !!beganExecCode && beganExecCode.includes('setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation'),
    began_releaseGuarded: !!beganExecCode && /if \(canReleaseSession\) \{/.test(beganExecCode),
    began_releaseNeedsEngineStopped: !!beganExecCode && /canReleaseSession = self\.sourceNode != nil && \(self\.engine == nil \|\| !self\.engine\.isRunning\);/.test(beganExecCode),

    // —— Ended：门槛 = interruptedBySystem && !manualPause ——
    ended_guardIsMarkerOnly: !!endedCode && endedCode.includes('if (!self.interruptedBySystem) return;'),
    ended_noShouldResume: !!endedCode && !endedCode.includes('shouldResume'),
    ended_manualPauseGate: atManualGate >= 0 && atReacquire > atManualGate,
    ended_skipsWhenNothingToPlay: !!endedCode && /if \(self\.sourceNode == nil \|\| \[self\.currentState isEqualToString:@"stopped"\] \|\| \[self\.currentState isEqualToString:@"idle"\]\) return;/.test(endedCode),
    ended_reacquiresAndPlays: !!endedCode && endedCode.includes('[self prepareAudioSession:&sessionError]') && endedCode.includes('[self maybeStartPlaybackLocked]'),

    // —— pause：会话常驻（第 48 轮，对齐参考工程） + 不清待续播标记 ——
    // 用户第 48 轮原话：「无法点击控制，无法拖动进度条调节播放时间……如果还是不行就一比一
    // 复制它的」。暂停即让出会话 = 卡片被系统画成失效态（灰 ▶ / 两侧 -:--）、遥控命令与
    // 进度条拖动不再投递给本 App。参考工程的会话常驻，本轮一比一对齐：pause 里不许再出现
    // 任何 setActive:NO，也不许再留 canReleaseSession 那套让出账本（让出只发生在打断 Began）。
    pause_keepsSessionResident: !!pauseCode && !pauseCode.includes('setActive:NO'),
    pause_noReleaseBookkeeping: !!pauseCode && !pauseCode.includes('canReleaseSession'),
    pause_noSessionActivation: !!pauseCode && !pauseCode.includes('prepareAudioSession'),
    pause_setsManualPause: !!pauseCode && pauseCode.includes('self.manualPause = YES;'),
    pause_keepsInterruptionMarker: !!pauseCode && !/self\.interruptedBySystem = NO;/.test(pauseCode),

    // —— DidBecomeActive：只有真的在播放才抢回会话 ——
    active_gatedOnPlaying: !!activeCode && activeCode.includes('if (LXNowPlayingState == MPNowPlayingPlaybackStatePlaying) {') && activeCode.includes('setActive:YES'),

    // —— stop 才是取消待续播的出口 ——
    stop_cancelsResume: !!stopCode && /self\.interruptedBySystem = NO;/.test(stopCode),

    // —— 第 21 轮·优化 1：路由判定同时看旧路由与新路由 ——
    route_helperExists: !!routeFnCode &&
      routeFnCode.includes('AVAudioSessionPortBluetoothA2DP') &&
      routeFnCode.includes('AVAudioSessionPortHeadphones'),
    route_helperNullSafe: !!routeFnCode && /if \(route == nil\) return NO;/.test(routeFnCode),
    route_previousDelegates: !!prevCheckCode && /return \[self routeHasHeadphoneOutput:route\];/.test(prevCheckCode),
    route_checksNewRoute: !!routeChangeCode &&
      routeChangeCode.includes('[AVAudioSession sharedInstance].currentRoute') &&
      /if \(currentRoute != nil && \[self routeHasHeadphoneOutput:currentRoute\]\) return;/.test(routeChangeCode),
    route_stillEmitsForRealUnplug: !!routeChangeCode &&
      routeChangeCode.includes('sendEventWithName:@"headphones-disconnected"') &&
      routeChangeCode.indexOf('sendEventWithName:@"headphones-disconnected"') >
        routeChangeCode.indexOf('routeHasHeadphoneOutput:currentRoute'),

    // —— 第 21 轮·优化 1：恢复意图 =「最近 3s 确实在播」时间窗 ——
    svc_windowDefined: /const RECENT_PLAYING_WINDOW_MS = 3000/.test(svc),
    svc_windowFn: /const wasPlayingRecently = \(\) => \{[\s\S]{0,400}?lastPlayingAt > 0 && Date\.now\(\) - lastPlayingAt <= RECENT_PLAYING_WINDOW_MS/.test(svc),
    svc_heartbeatOnlyWhilePlaying: /playingHeartbeat = setInterval\(\(\) => \{[\s\S]{0,160}?if \(playerState\.isPlay\) lastPlayingAt = Date\.now\(\)[\s\S]{0,80}?else stopPlayingHeartbeat\(\)/.test(svc),
    svc_duckUsesWindow: /shouldResumeAfterDuck \|\|= !isManualPause\(\) && wasPlayingRecently\(\)/.test(svc),
    svc_backgroundUsesWindow: /wasBackgroundPlaying = Platform\.OS == 'ios' && wasPlayingRecently\(\)/.test(svc),
    svc_longPreemptionStaysPaused: /const SHORT_INTERRUPTION_MAX_MS = 30000/.test(svc) &&
      /if \(permanent && wasLongInterruption\) return cancelResumePending\(\)/.test(svc),
    svc_recordsInterruptionStart: (svc.match(/interruptedAt = Date\.now\(\)/g) || []).length >= 2,
    // iOS 三分流：began={paused:true} / ended 应恢复={paused:false} / ended 不该恢复={paused:true,permanent:true}。
    // 只看 paused 会把第三种（结束）当成新的开始 → 永远走不到恢复那一步。
    // 【第 24 轮】按 6 空格缩进锚定**独占分支**：第 24 轮新增的「与其他应用同时播放」策略分支
    // 里也有一句同形状的 `if (paused && !permanent) {`（8 空格）。不锚定的话，本断言会被那一支
    // 满足，m11 反例（篡改独占分支）就拦不下来（本轮实测）。
    svc_endedNotMistakenForStart: /^      if \(paused && !permanent\) \{/m.test(svc),
    svc_retryOnceAt600: /const RESUME_RETRY_DELAYS = \[600\]/.test(svc) && !svc.includes('120, 500, 1500'),
    svc_playArmsHeartbeat: /app_event\.on\('play', \(\) => \{[\s\S]{0,200}?startPlayingHeartbeat\(\)/.test(svc),
    svc_stopClearsIntent: /app_event\.on\('stop', \(\) => \{[\s\S]{0,200}?cancelResumePending\(\)/.test(svc),

    // —— 第 22 轮：手动暂停闸门（用户主动暂停后任何条件都不许自动出声）——
    svc_manualPauseImported: /import \{ clearManualPause, isManualPause \} from '@\/core\/player\/manualPause'/.test(svc),
    svc_scheduleHonorsManualPause: /if \(isManualPause\(\)\) return cancelResumePending\(\)/.test(svc),
    // 【第 24 轮】同样按 8 空格缩进锚定独占分支（混音分支同一句是 10 空格缩进）
    svc_interruptBeginHonorsManualPause: /^        if \(!global\.lx\.isPlayedStop && !isManualPause\(\)\) shouldResumeAfterDuck = true/m.test(svc),
    svc_backgroundHonorsManualPause: /if \(wasBackgroundPlaying && !global\.lx\.isPlayedStop && !isManualPause\(\)\) shouldResumeAfterDuck = true/.test(svc),
    svc_androidFinalHonorsManualPause: /if \(!isManualPause\(\)\) play\(\)/.test(svc),
    svc_playClearsManualPause: /app_event\.on\('play', \(\) => \{[\s\S]{0,400}?clearManualPause\(\)/.test(svc),

    // —— 第 21 轮·优化 1：RNTP 中断结束分支必须照发事件 ——
    patch_interruptionDefined: patcher.includes('const patchTrackPlayerInterruptionEndAlwaysEmit = async() =>'),
    patch_interruptionCalled: /await patchTrackPlayerInterruptionEndAlwaysEmit\(\)/.test(patcher),
    patch_interruptionDefaultsZero: /userInfo\[AVAudioSessionInterruptionOptionKey\] as\? UInt\) \?\? 0/.test(patcher),
    // 补丁只换「取 optionsValue 的那段 guard」：pattern 里不能出现 remote-duck / sendEvent，
    // 否则会把 .ended 分支的两个事件发送一起吞掉（那才是「事件照发」的底线）。
    patch_interruptionSurgical: patcher.includes('pattern: /guard let optionsValue =\\s*\\n\\s*userInfo\\[AVAudioSessionInterruptionOptionKey\\] as\\? UInt else \\{\\s*\\n\\s*return\\s*\\n\\s*\\}/') &&
      !/pattern: \/guard let optionsValue[\s\S]{0,240}?(remote-duck|sendEvent)/.test(patcher),
  }
}

const LABELS = {
  began_noLegacyReturn: 'Began 不再因「未出声 / 手动暂停」提前 return（旧写法会让 Ended 整单作废）',
  began_markerBeforeReturn: 'Began 的执行体里 interruptedBySystem = YES 在 shouldEmitPause 早退之前（无条件置位）',
  began_immediateDeferral: 'Began 收到通知立即无条件置标记并把完整处理推迟到忽略窗口到期（第 31 轮·追加）',
  began_releasesSession: 'Began 主动让出音频会话 setActive:NO + NotifyOthersOnDeactivation',
  began_releaseGuarded: '让出会话由 canReleaseSession 守着（不是无条件调用）',
  began_releaseNeedsEngineStopped: 'canReleaseSession 要求引擎已停下（否则掐断 IO，恢复后无声）',
  ended_guardIsMarkerOnly: 'Ended 先按 interruptedBySystem 作废无关的打断单',
  ended_noShouldResume: 'Ended 不依赖 ShouldResume（不等打断方的标志）',
  ended_manualPauseGate: 'Ended 手动暂停时直接返回（不抢会话、不续播，第 16 轮口径）',
  ended_skipsWhenNothingToPlay: 'Ended 对「无流 / stopped / idle」不抢会话（避免误播）',
  ended_reacquiresAndPlays: 'Ended 非手动暂停时抢回会话并起播（prepareAudioSession + maybeStartPlaybackLocked）',
  pause_keepsSessionResident: 'pause 会话常驻、不让出（第 48 轮对齐参考工程：让出 = 卡片被系统判失效，点不动 / 拖不动）',
  pause_noReleaseBookkeeping: 'pause 里不再有 canReleaseSession 那套让出账本（让出只发生在打断 Began）',
  pause_noSessionActivation: 'pause 不再 prepareAudioSession（旧写法保持激活 = 其他音频没声音的根因）',
  pause_setsManualPause: 'pause 置 manualPause（Ended 据此不续播）',
  pause_keepsInterruptionMarker: 'pause 不清 interruptedBySystem（取消续播改由 manualPause 门槛完成，标记留给 stop 清）',
  active_gatedOnPlaying: 'DidBecomeActive 只有 now playing 为 Playing 时才 setActive:YES（暂停态不抢会话）',
  stop_cancelsResume: 'stop 仍会取消待续播（用户明确结束播放的唯一出口）',

  // —— 第 21 轮·优化 1（一）：路由判定同时看旧路由与新路由 ——
  route_helperExists: '耳机输出判定抽成 routeHasHeadphoneOutput:（有线/A2DP/HFP/BLE 四类）',
  route_helperNullSafe: 'routeHasHeadphoneOutput: 对 nil 路由返回 NO（不会因取不到路由而崩）',
  route_previousDelegates: '旧路由判定委托给 routeHasHeadphoneOutput:（只有一份端口类型表）',
  route_checksNewRoute: '拔线判定还要看新路由：新路由里耳机类输出还在 = 被抢占，不发 headphones-disconnected',
  route_stillEmitsForRealUnplug: '真拔线/真断连仍发 headphones-disconnected（新路由 gate 之后照发）',

  // —— 第 21 轮·优化 1（二）：恢复意图 =「最近 3s 确实在播」时间窗 ——
  svc_windowDefined: 'service.ts 定义 RECENT_PLAYING_WINDOW_MS = 3000（最近在播时间窗）',
  svc_windowFn: 'wasPlayingRecently()：此刻在播，或最后一次确认在播在 3s 之内',
  svc_heartbeatOnlyWhilePlaying: '心跳只在播放期间存在（一发现不在播就停表，lastPlayingAt 留着跨过这次暂停）',
  svc_duckUsesWindow: 'iOS ducking 分支用时间窗记待恢复，且带手动暂停闸门（第 22 轮）',
  svc_backgroundUsesWindow: '退后台预置待续播也用时间窗（车机蓝牙下 isPlay 可能刚被路由暂停置 false）',
  svc_longPreemptionStaysPaused: '打断结束：permanent 且超过 30s 的长时间抢占保持暂停（不跟导航/通话抢音频）',
  svc_recordsInterruptionStart: '打断开始（ducking / paused）记下 interruptedAt，结束分支据此算抢占时长',
  svc_endedNotMistakenForStart: 'iOS 分流带 permanent 一起判（{paused:true,permanent:true} 是「结束」不是新的开始）',
  svc_retryOnceAt600: '恢复后 600ms 只补试一次（旧的 120/500/1500 三连退避已撤）',
  svc_playArmsHeartbeat: 'app_event play → 起「确实在播」心跳',
  svc_stopClearsIntent: 'app_event stop → 作废待续播标记（用户明确停止后不许自动拉起）',

  // —— 第 22 轮：手动暂停闸门 ——
  svc_manualPauseImported: 'service.ts 引入手动暂停闸门（isManualPause / clearManualPause，core/player/manualPause.ts）',
  svc_scheduleHonorsManualPause: 'scheduleAutoResume 兜底先查手动暂停闸门（手动暂停后不许被拉起）',
  svc_interruptBeginHonorsManualPause: '打断开始置恢复意图前先查手动暂停闸门（用户报的「别的音频播完自己开始播」主源）',
  svc_backgroundHonorsManualPause: '退后台预置恢复意图前先查手动暂停闸门（暂停后 3s 内切后台不预置）',
  svc_androidFinalHonorsManualPause: 'Android 恢复分支先查手动暂停闸门（与 iOS 同一口径）',
  svc_playClearsManualPause: 'app_event play → 复位手动暂停闸门（重新播放才恢复自动续播）',

  // —— 第 21 轮·优化 1（三）：RNTP 中断结束必须照发事件 ——
  patch_interruptionDefined: 'dependencies-patch.js 新增 patchTrackPlayerInterruptionEndAlwaysEmit',
  patch_interruptionCalled: '该补丁在驱动里被调用（node_modules 安装后自动生效）',
  patch_interruptionDefaultsZero: '缺 AVAudioSessionInterruptionOptionKey 时按 0 处理（不再 return 吞事件）',
  patch_interruptionSurgical: '补丁只换取 optionsValue 的 guard（不碰 .ended 的两个事件发送）',
}

console.log('='.repeat(92))
console.log('「其他音频结束后自动续播 + 让出 / 让还音频会话」契约模型（摘自 ' + NATIVE + '、' + SERVICE + '、' + PATCHER + '）')
console.log('='.repeat(92))

const src = readSource()
// 第 21 轮·优化 1：同一份断言表也覆盖 service.ts（恢复意图）与 dependencies-patch.js（RNTP 补丁）
const JS = { service: readService(), patch: readPatcher() }
const real = evaluate(src, JS)

for (const key of Object.keys(LABELS)) {
  const ok = real[key]
  check(LABELS[key], ok)
  console.log(`  ${ok ? '✅' : '❌'}  ${ok ? '' : '[FAIL] '}${LABELS[key]}`)
}

const assertCount = results.length

// —— 反例自检：每条修复改回旧实现（或拆掉）都必须被拦下 ——
console.log('\n[反例] 逐条还原旧实现 / 拆掉接线，必须判不合格')

const negResults = []
const neg = (label, ok) => {
  negResults.push(ok)
  console.log(`  ${ok ? '✅' : '❌'}  ${ok ? '' : '[FAIL] '}${label}`)
}

// m1 旧 Began：早退再置标记（手动暂停 / 未出声时标记不置位）
// 【第 31 轮·追加】锚点改到推迟执行体（2 空格）；case 块的「立即置标记」由 m15 守着。
const m1 = src.replace(
  '  self.interruptedBySystem = YES;\n  if (canReleaseSession) {',
  '  if (!shouldEmitPause) return;\n  self.interruptedBySystem = YES;\n  if (canReleaseSession) {',
)
const m1r = evaluate(m1, JS)
neg('反例 m1：early-return 早于标记（旧 Began 语义）被拦下',
  m1 !== src && !m1r.began_markerBeforeReturn)

// m2 旧 Began：不让出会话
const m2 = src.replace(/\n *\[\[AVAudioSession sharedInstance\] setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil\];/, '')
const m2r = evaluate(m2, JS)
neg('反例 m2：拆掉 Began 的让出会话（其他音频被占着）被拦下',
  m2 !== src && !m2r.began_releasesSession)

// m3 第 13 轮 Ended：manualPause / ShouldResume 都不当门槛（第 16 轮要挡住它）
const m3 = src.replace(
  '      if (self.manualPause) return;\n',
  '      BOOL shouldResume = ([userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue] & AVAudioSessionInterruptionOptionShouldResume) != 0;\n      if (!shouldResume) return;\n',
)
const m3r = evaluate(m3, JS)
neg('反例 m3：Ended 摘掉 manualPause 门槛（手动暂停也续播，第 16 轮用户报的 bug）被拦下',
  m3 !== src && !m3r.ended_manualPauseGate && !m3r.ended_noShouldResume)

// m4 旧 pause：清掉待续播标记
const m4 = src.replace(
  '    self.manualPause = YES;\n    // 【第 16 轮第 9 条】',
  '    self.manualPause = YES;\n    self.interruptedBySystem = NO;\n    // 【第 16 轮第 9 条】',
)
const m4r = evaluate(m4, JS)
neg('反例 m4：pause 清掉待续播标记（打断期间暂停即失效）被拦下',
  m4 !== src && !m4r.pause_keepsInterruptionMarker)

// m5 旧 pause：回到 prepareAudioSession（主动抢会话 = 暂停态压住其他音频）
// 【第 48 轮】锚点跟着 pause 首行更新：`__block BOOL canReleaseSession = NO;` 已随让出
// 逻辑删除，旧锚点整段失配 ⇒ replace 落空 ⇒ 反例会「假通过」（m5 必须被拦下才算数）。
const m5 = src.replace(
  'RCT_REMAP_METHOD(pause, pauseStreamWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {\n  dispatch_sync(self.renderQueue, ^{',
  'RCT_REMAP_METHOD(pause, pauseStreamWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {\n  NSError *sessionError = nil;\n  [self prepareAudioSession:&sessionError];\n  dispatch_sync(self.renderQueue, ^{',
)
const m5r = evaluate(m5, JS)
neg('反例 m5：pause 重新保持会话激活（其他音频没声音的根因）被拦下',
  m5 !== src && !m5r.pause_noSessionActivation)

// m6 旧 DidBecomeActive：无条件 setActive:YES
// 锚点必须带上紧随其后的那行注释：第 44 轮起，AppDelegate.mm 的 LXApplyNowPlayingInfo
// 里也有一行同形的 `if (LXNowPlayingState == ...) {`（且位置更靠前），只给裸行的
// `String.replace` 会改到那一处 —— 反例便悄悄失效（真机行为不变，但防线没了）。
const m6 = src.replace(
  '      if (LXNowPlayingState == MPNowPlayingPlaybackStatePlaying) {\n        // iOS 27 Beta 7 可能在应用切换/控制中心展开后丢弃当前媒体会话；\n',
  '      if (YES) {\n        // iOS 27 Beta 7 可能在应用切换/控制中心展开后丢弃当前媒体会话；\n',
)
const m6r = evaluate(m6, JS)
neg('反例 m6：DidBecomeActive 无条件抢回会话（暂停态压住其他音频）被拦下',
  m6 !== src && !m6r.active_gatedOnPlaying)

// —— 第 21 轮·优化 1 的反例 ——

// m7 旧路由判定：只看旧路由（导航播报抢占被误判成「耳机被拔」→ JS 暂停后不恢复）
const m7 = src.replace(
  /\n *if \(currentRoute != nil && \[self routeHasHeadphoneOutput:currentRoute\]\) return;/,
  '',
)
const m7r = evaluate(m7, JS)
neg('反例 m7：路由判定退回「只看旧路由」（车机蓝牙下导航播报被当成拔耳机）被拦下',
  m7 !== src && !m7r.route_checksNewRoute)

// m8 瞬间快照：恢复意图退回 playerState.isPlay
const m8s = JS.service.replace(/wasPlayingRecently\(\)/g, 'playerState.isPlay')
const m8r = evaluate(src, { service: m8s, patch: JS.patch })
neg('反例 m8：恢复意图退回瞬间 isPlay 快照（路由暂停抢先记成已暂停）被拦下',
  m8s !== JS.service && (!m8r.svc_duckUsesWindow || !m8r.svc_backgroundUsesWindow))

// m9 permanent 无条件恢复：拆掉 30s 长抢占门槛（跟导航/通话抢音频）
const m9s = JS.service.replace(
  '      if (permanent && wasLongInterruption) return cancelResumePending()\n',
  '',
)
const m9r = evaluate(src, { service: m9s, patch: JS.patch })
neg('反例 m9：拆掉「permanent + 超 30s 保持暂停」（长时间抢占被无条件抢回）被拦下',
  m9s !== JS.service && !m9r.svc_longPreemptionStaysPaused)

// m10 RNTP 补丁退回旧写法：缺 key 直接 return，事件不发
const m10p = JS.patch.replace(
  'userInfo[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0',
  'userInfo[AVAudioSessionInterruptionOptionKey] as? UInt else { return }',
)
const m10r = evaluate(src, { service: JS.service, patch: m10p })
neg('反例 m10：RNTP 补丁退回「缺 key 直接 return」（播报结束事件永远收不到）被拦下',
  m10p !== JS.patch && !m10r.patch_interruptionDefaultsZero)

// m11 iOS 分流退回「只看 paused」：{paused:true, permanent:true}（打断结束·不该自动恢复）
// 被当成新的打断开始 → 永远走不到恢复那一步
// 【第 24 轮】锚点必须用 /m 的 ^ 行首限定到**独占分支**：第 24 轮在同一 handler 里新增了
// 「与其他应用同时播放」策略分支（同形状、8 空格缩进）。纯字符串 replace('      if (paused…')
// 会先在 8 空格那行里从第 2 列开始匹配（6 空格 + if… 是它的子串），篡改落到混音分支上，
// 反例就失去拦截意义（本轮实测 m11/m14 未拦下）。
const m11s = JS.service.replace(/^      if \(paused && !permanent\) \{/m, '      if (paused) {')
const m11r = evaluate(src, { service: m11s, patch: JS.patch })
neg('反例 m11：iOS 分流退回「只看 paused」（打断结束被当成新的开始）被拦下',
  m11s !== JS.service && !m11r.svc_endedNotMistakenForStart)

// —— 第 22 轮：手动暂停闸门的反例 ——

// m12 拆掉 scheduleAutoResume 的闸门（手动暂停后仍会被兜底逻辑拉起）
const m12s = JS.service.replace('  if (isManualPause()) return cancelResumePending()\n', '')
const m12r = evaluate(src, { service: m12s, patch: JS.patch })
neg('反例 m12：拆掉 scheduleAutoResume 的手动暂停闸门被拦下',
  m12s !== JS.service && !m12r.svc_scheduleHonorsManualPause)

// m13 拆掉 play 事件的闸门复位（一次手动暂停后永远不出声）
const m13s = JS.service.replace('    clearManualPause()\n', '')
const m13r = evaluate(src, { service: m13s, patch: JS.patch })
neg('反例 m13：拆掉 play 事件的闸门复位（手动暂停后永远不出声）被拦下',
  m13s !== JS.service && !m13r.svc_playClearsManualPause)

// m14 打断开始退回无条件置位（用户报的「其它音频播完自己开始播」的旧实现）
// 【第 24 轮】同样用 /m 的 ^ 行首锚定独占分支（混音分支同一句是 10 空格缩进，见 m11 的说明）
const m14s = JS.service.replace(
  /^        if \(!global\.lx\.isPlayedStop && !isManualPause\(\)\) shouldResumeAfterDuck = true/m,
  '        if (!global.lx.isPlayedStop) shouldResumeAfterDuck = true',
)
const m14r = evaluate(src, { service: m14s, patch: JS.patch })
neg('反例 m14：打断开始退回无条件置恢复意图（手动暂停被覆盖）被拦下',
  m14s !== JS.service && !m14r.svc_interruptBeginHonorsManualPause)

// m15 第 31 轮·追加：Began 的标记挪到推迟调度之后（不再「立即置位」—— 窗口期路由自愈
// 会去抢被打断的会话，用户手动暂停期间也没有标记兜底）
const m15 = src.replace(
  '      self.interruptedBySystem = YES;\n      [self scheduleDeferredInterruptionBeganHandling];',
  '      [self scheduleDeferredInterruptionBeganHandling];\n      self.interruptedBySystem = YES;',
)
const m15r = evaluate(m15, JS)
neg('反例 m15：Began 的标记挪到推迟调度之后（不再立即置位）被拦下',
  m15 !== src && !m15r.began_immediateDeferral)

// m16 第 48 轮：pause 恢复「让出会话」（用户报的现场：暂停后锁屏卡片灰掉、点不动、
// 进度条拖不动 —— 系统判定 Now Playing 会话已失效）
const m16 = src.replace(
  '  });\n  // 【第 48 轮】暂停**不再让出音频会话**',
  '  });\n  [[AVAudioSession sharedInstance] setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];\n  // 【第 48 轮】暂停**不再让出音频会话**',
)
const m16r = evaluate(m16, JS)
neg('反例 m16：pause 恢复让出音频会话（卡片被判失效 → 点不动 / 拖不动）被拦下',
  m16 !== src && !m16r.pause_keepsSessionResident)

const negFailed = negResults.filter(ok => !ok).length

console.log()
console.log('='.repeat(92))
console.log(`结果：断言 ${assertCount - failed}/${assertCount} 通过；反例 ${negResults.length - negFailed}/${negResults.length} 拦下`)
console.log()

process.exit(failed || negFailed ? 1 : 0)
