#!/usr/bin/env node
/**
 * sim-bluetooth-audio-stability.js —— 「连上蓝牙后播放时不时没声音 / 卡顿」（第 31 轮·条五）
 * 与「蓝牙音频设备接入 / 移除时暂停播放」（第 31 轮·条六）契约。
 *
 * 需求原话（2026-10-03 第 31 轮）：
 *   「又发现一个bug：1、连接蓝牙设置后，播放音乐时，会出现时不时的声音消失或者卡顿，
 *     请保证蓝牙稳定输出音频。」
 *
 * 根因：原生流式 FLAC 引擎（StreamingFlacPlayerModule）**没有监听** AVAudioSessionRouteChange /
 * AVAudioEngineConfigurationChange。iOS 在蓝牙连上 / 断开、A2DP ↔ HFP 切换、硬件采样率变化时
 * 会把 AVAudioEngine 停掉并把音频会话重新协商；引擎停在旧路由上、或会话被系统收走但
 * isRunning 仍报 YES（同一个坑在第 13 轮打断里记过一次：`isRunning` 为真但 IO 已被掐断），
 * 用户看到的就是「进度条在走、声音没了」或断续卡顿。
 *
 * 本轮口径（ios/LxMusicMobile/AppDelegate.mm）：
 *   ① 注册两个观察者：AVAudioSessionRouteChange（object=会话）与
 *      AVAudioEngineConfigurationChange（object=nil，引擎实例每个流都可能换）。
 *   ② 路由变化的真断连（OldDeviceUnavailable 且新路由没有耳机类输出）不恢复 —— JS 侧
 *      headphones-disconnected 会暂停播放，这里抢放会在扬声器上外放几百毫秒；被抢占 /
 *      换设备（新路由仍是耳机类）与未知原因照常恢复。
 *   ③ 恢复节奏：路由变化立刻一次 + 0.15/0.6/1.5s 重试（通知会成串来）；引擎配置变化
 *      立刻一次 + 0/0.3/1.0s（系统通常已把引擎停了，要快）。
 *   ④ 恢复门槛（一条不满足就撤）：有流、非手动暂停、非系统打断、有 sourceNode、
 *      不在 idle/stopped、非「真断连回扬声器」。
 *   ⑤ 恢复动作全部落在 renderQueue：重设会话（playback + LongFormAudio + setActive:YES）
 *      → 硬件格式变了才 stop 引擎（不重建整张图：重建会清 PCM 环、与解码线程抢缓冲，
 *      位置靠 playbackAnchorFrame 守恒）→ ensureAudioEngineRunningLocked →
 *      重贴音量/音效 → maybeStartPlaybackLocked → 记下渲染帧数快照。
 *   ⑥ IO 死检（0.35s 后）：引擎在跑 + 渲染开着 + 环里**有**数据，却整整 350ms 一帧都没被
 *      取走 → 判定 IO 已被掐断 → stop + start 重挂输出。环里没数据 = 正常缓冲，不动引擎。
 *   ⑦ 以上失败一律 emitWarningMessage（不是 error）——JS 侧 nativeFlac.ts 把原生 error 当
 *      「暂停」，用 error 会把可自愈的路由抖动升级成停播。
 *   ⑧ 建图成功时记下硬件输出采样率（configuredHardwareSampleRate），图销毁时清零。
 *
 * 为什么必须靠契约脚本：「谁在什么时候恢复、哪些情况不恢复、恢复落在哪个队列、探针什么时候
 * 才允许重启引擎」全是形状与时序 —— 把重试数组删成一次、把 manualPause 门槛摘掉、把
 * emitWarningMessage 换成 error、把「帧数没涨才重启」的判断删掉，tsc/eslint 全是绿的
 * （本工程根本没有 tsc/eslint/Xcode），真机上就是「越修越断」「暂停被顶开」「正常缓冲被反复重启」。
 * 带反例自检。
 *
 * —— 第 31 轮·条六（需求原话：「而且当有蓝牙音频设备连接或者断开时，将暂停播放音乐。」）——
 *
 * 与条五共用同一份原生路由变化处理器，但判定口径相反：条五要「别停」（自愈抢放），条六要
 * 「停住」（用户要求）。分界靠的是**前后两条路由的蓝牙有无翻转**：
 *   hadBluetooth = 旧路由有蓝牙输出，hasBluetooth = 新路由有蓝牙输出，两者不等才发
 *   bluetooth-device-changed（主队列），JS 侧暂停并落手动暂停闸门。
 * 只比「有无」不比端口明细：通话会把同一台车机的 A2DP 换成 HFP，端口签名天天变，比明细
 * 会让「接电话」变成「换设备」而误暂停，也会把第 21/22 轮的车机蓝牙通话后自动续播打断。
 * 蓝牙真断开时旧口径的 headphones-disconnected 仍照发（第 21 轮语义不变），两边都会
 * 调 pause()，第二次因 playerState.isPlay 已为 false 提前返回，无副作用。
 *
 * 运行：node scripts/sim-bluetooth-audio-stability.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去块注释与整行 `//` 注释（保留行尾注释；断言锚点全都不是注释）
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  native: 'ios/LxMusicMobile/AppDelegate.mm',
  nativeFlac: 'src/plugins/player/nativeFlac.ts',
  playerInit: 'src/core/init/player/player.ts',
  utilsTs: 'src/utils/nativeModules/utils.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

/** 取 ObjC 方法体：签名命中处起，到首个行首的 `}` 为止（含闭合括号） */
const objcBody = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  const rest = src.slice(start)
  const end = /\n\}\n/.exec(rest)
  return end ? rest.slice(0, end.index + 3) : null
}

/** 取一段切片（from 之后的 to 之前） */
const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  const end = src.indexOf(to, start + from.length)
  if (end <= start) return null
  return src.slice(start, end)
}

// ---------------------------------------------------------------------------
// 不变量：蓝牙 / 路由变化后的输出自愈
// ---------------------------------------------------------------------------

const bluetoothStabilityInvariants = (files) => {
  const reasons = []
  const src = files.native
  const code = stripComments(src)

  // —— ① 两个观察者 ——
  if (!/selector:@selector\(handleAudioRouteChangeWhileStreaming:\)\s*\n\s*name:AVAudioSessionRouteChangeNotification/.test(code)) {
    reasons.push('没把 handleAudioRouteChangeWhileStreaming: 注册到 AVAudioSessionRouteChangeNotification（蓝牙路由变化没人管 = 本 bug 的根因）')
  }
  if (!/selector:@selector\(handleAudioEngineConfigurationChangeWhileStreaming:\)\s*\n\s*name:AVAudioEngineConfigurationChangeNotification/.test(code)) {
    reasons.push('没把 handleAudioEngineConfigurationChangeWhileStreaming: 注册到 AVAudioEngineConfigurationChangeNotification（硬件格式变化后引擎停在旧格式上）')
  }

  // —— ② 耳机类输出判定（真断连 vs 被抢占）——
  const helper = objcBody(code, '- (BOOL)currentRouteHasHeadphoneOutput {')
  if (helper == null) {
    reasons.push('currentRouteHasHeadphoneOutput 缺失（真断连判定没有依据）')
  } else {
    if (!/if \(route == nil\) return NO;/.test(helper)) {
      reasons.push('currentRouteHasHeadphoneOutput 没做 nil 路由防护（取不到路由时会崩）')
    }
    for (const port of ['AVAudioSessionPortHeadphones', 'AVAudioSessionPortBluetoothA2DP', 'AVAudioSessionPortBluetoothHFP', 'AVAudioSessionPortBluetoothLE']) {
      if (!helper.includes(port)) reasons.push(`currentRouteHasHeadphoneOutput 少了 ${port}（该端口会被误判成「真断连」）`)
    }
  }

  // —— ③ 路由变化处理器：读完 reason 再决定是否当断连 ——
  const routeHandler = objcBody(code, '- (void)handleAudioRouteChangeWhileStreaming:(NSNotification *)notification {')
  if (routeHandler == null) {
    reasons.push('handleAudioRouteChangeWhileStreaming: 缺失')
  } else {
    if (!routeHandler.includes('AVAudioSessionRouteChangeReasonKey')) {
      reasons.push('路由变化处理器没读 AVAudioSessionRouteChangeReasonKey（分不清断连 / 抢占 / 换设备）')
    }
    if (!routeHandler.includes('AVAudioSessionRouteChangeReasonOldDeviceUnavailable')) {
      reasons.push('路由变化处理器没有 OldDeviceUnavailable 判定（真拔线时会在扬声器上抢放几百毫秒）')
    }
    if (/AVAudioSessionRouteChangeReasonUnknown\s*\)\s*return;/.test(routeHandler)) {
      reasons.push('路由变化处理器对未知原因直接 return（蓝牙切换常报未知原因，恢复会被漏掉）')
    }
    if (!routeHandler.includes('@[ @0.15, @0.6, @1.5 ]')) {
      reasons.push('路由变化没有 0.15/0.6/1.5s 的重试节奏（路由变化通知成串来，只恢复一次会漏掉后面几次）')
    }
    if (!routeHandler.includes('treatAsDisconnect:isPhysicalDisconnect')) {
      reasons.push('路由变化处理器没把「是否真断连」传下去（无法区分拔线与抢占）')
    }
  }

  // —— ④ 引擎配置变化处理器：要快 ——
  const configHandler = objcBody(code, '- (void)handleAudioEngineConfigurationChangeWhileStreaming:(NSNotification *)notification {')
  if (configHandler == null) {
    reasons.push('handleAudioEngineConfigurationChangeWhileStreaming: 缺失')
  } else {
    if (!configHandler.includes('@[ @0, @0.3, @1.0 ]')) {
      reasons.push('引擎配置变化没有「立刻 + 0/0.3/1.0s」的恢复节奏（系统已把引擎停了，慢了就是断音）')
    }
    if (!configHandler.includes('treatAsDisconnect:NO')) {
      reasons.push('引擎配置变化不该按「真断连」处理（配置变化时新路由往往就是目标设备）')
    }
  }

  // —— ⑤ 调度器：立刻一次 + 主队列延迟重试 ——
  const scheduler = objcBody(code, '- (void)scheduleStreamingOutputRecoveryWithDelays:(NSArray<NSNumber *> *)delays treatAsDisconnect:(BOOL)treatAsDisconnect {')
  if (scheduler == null) {
    reasons.push('scheduleStreamingOutputRecoveryWithDelays:treatAsDisconnect: 缺失')
  } else {
    if (!scheduler.includes('[self recoverStreamingOutputForRouteChange:treatAsDisconnect];')) {
      reasons.push('调度器没有「立刻恢复一次」（只挂延迟重试，前 0.15s 是静音）')
    }
    if (!scheduler.includes('dispatch_after(') || !scheduler.includes('dispatch_get_main_queue()')) {
      reasons.push('调度器的延迟重试没落在主队列（通知回调线程不确定，会话/引擎操作要回主队列）')
    }
    if (!scheduler.includes('MAX(delay.doubleValue, 0)')) {
      reasons.push('调度器没把负延迟夹到 0（负值 dispatch_after 无意义）')
    }
  }

  // —— ⑥ 恢复主体：门槛 + 落点 + 动作 ——
  const recover = objcBody(code, '- (void)recoverStreamingOutputForRouteChange:(BOOL)treatAsDisconnect {')
  if (recover == null) {
    reasons.push('recoverStreamingOutputForRouteChange: 缺失（没有任何自愈动作）')
  } else {
    if (!recover.includes('if (self.currentURL.length == 0) return;')) {
      reasons.push('恢复主体没有「没流就撤」的门槛（会把别的状态搅乱）')
    }
    if (!recover.includes('if (self.manualPause || self.interruptedBySystem) return;')) {
      reasons.push('恢复主体缺「手动暂停 / 系统打断中不抢会话」门槛（暂停会被顶开、打断期间抢不回会话）')
    }
    if (!recover.includes('[self.currentState isEqualToString:@"idle"]') || !recover.includes('[self.currentState isEqualToString:@"stopped"]')) {
      reasons.push('恢复主体没排除 idle / stopped（已结束的流被重新拉起）')
    }
    if (!recover.includes('if (treatAsDisconnect && ![self currentRouteHasHeadphoneOutput]) return;')) {
      reasons.push('恢复主体没挡「真断连回扬声器」（耳机拔了还在扬声器上出声，用户报的就是这个方向的失败）')
    }
    if (!recover.includes('[self prepareAudioSession:&sessionError]')) {
      reasons.push('恢复主体没有重设音频会话 prepareAudioSession（路由变化后会话要重新 setActive，否则引擎起了也没声）')
    }
    if (!recover.includes('dispatch_async(self.renderQueue, ^{')) {
      reasons.push('恢复动作没落在 renderQueue（引擎 / PCM 环 / 音量都归它管，跨队列改会打架）')
    }
    if (!recover.includes('BOOL hardwareFormatChanged') ||
        !recover.includes('if (self.engine.isRunning && hardwareFormatChanged) {') ||
        !recover.includes('[self.engine stop];')) {
      reasons.push('恢复主体没有「硬件采样率变了才 stop 引擎重挂」（44.1k ↔ 48k 不重挂 = 继续没声）')
    }
    if (!recover.includes('[self ensureAudioEngineRunningLocked:&engineError]')) {
      reasons.push('恢复主体没有把引擎拉起来（ensureAudioEngineRunningLocked）')
    }
    if (!recover.includes('emitWarningMessage') || recover.includes('emitErrorMessage')) {
      reasons.push('恢复失败用 error 上报（JS 侧把原生 error 当暂停，会把可自愈的抖动升级成停播）')
    }
    if (!recover.includes('if (hardwareSampleRate > 0) self.configuredHardwareSampleRate = hardwareSampleRate;')) {
      reasons.push('恢复主体没更新 configuredHardwareSampleRate（下次比较的基准永远停在第一次建图）')
    }
    if (!recover.includes('[self restorePlaybackOutputLocked];') || !recover.includes('[self maybeStartPlaybackLocked];')) {
      reasons.push('恢复主体没有重贴音量/音效 + 接回播放（引擎起来了但音量/播放态没恢复）')
    }
    if (!recover.includes('self.renderFramesAtLivenessProbe = _renderedFrames.load(std::memory_order_acquire);')) {
      reasons.push('恢复主体没记渲染帧数快照（IO 死检没有基准）')
    }
    if (!recover.includes('0.35 * NSEC_PER_SEC') || !recover.includes('self.renderQueue') ||
        !recover.includes('[self checkStreamingOutputLivenessLocked];')) {
      reasons.push('恢复主体没在 renderQueue 上挂 0.35s 的 IO 死检（引擎 isRunning 为真但 IO 被掐断时没人救）')
    }
  }

  // —— ⑦ IO 死检：只在「有数据却一帧没取走」时才重启 ——
  const liveness = objcBody(code, '- (void)checkStreamingOutputLivenessLocked {')
  if (liveness == null) {
    reasons.push('checkStreamingOutputLivenessLocked 缺失（引擎报告在跑但 IO 已死时不会自愈）')
  } else {
    if (!liveness.includes('if (![self shouldRestorePlaybackOutputLocked]) return;')) {
      reasons.push('IO 死检没有复用 shouldRestorePlaybackOutputLocked（停播 / 手动暂停时还会重启引擎）')
    }
    if (!liveness.includes('if (self.engine == nil || !self.engine.isRunning) return;')) {
      reasons.push('IO 死检没先要求引擎在跑（引擎没跑是另一条路径的事）')
    }
    if (!liveness.includes('if (!self.playbackStarted || !_sourceRenderingEnabled.load(std::memory_order_acquire)) return;')) {
      reasons.push('IO 死检没要求「已起播 + 渲染开着」（缓冲期/未起播时不该动引擎）')
    }
    const atEmpty = liveness.indexOf('if (queuedFrames <= 0) return;')
    const atStuck = liveness.indexOf('if (renderedFrames != self.renderFramesAtLivenessProbe) return;')
    if (atEmpty < 0) {
      reasons.push('IO 死检没排除「环里没数据」= 正常缓冲（会在正常等缓冲时反复重启引擎 → 越修越卡）')
    }
    if (atStuck < 0) {
      reasons.push('IO 死检没要求「帧数 350ms 没涨」（不等就重启 = 每 0.35s 掐一次 IO）')
    }
    if (atEmpty >= 0 && atStuck >= 0 && atStuck < atEmpty) {
      reasons.push('IO 死检顺序倒了：先判帧数后判空环（空环时帧数本就不涨，会误判成 IO 死）')
    }
    if (!liveness.includes('[self.engine stop];') || !liveness.includes('[self ensureAudioEngineRunningLocked:&engineError]') ||
        !liveness.includes('[self restorePlaybackOutputLocked];') || !liveness.includes('[self maybeStartPlaybackLocked];')) {
      reasons.push('IO 死检没做完整的「停 → 起 → 重贴输出 → 接回播放」')
    }
    if (!liveness.includes('emitWarningMessage') || liveness.includes('emitErrorMessage')) {
      reasons.push('IO 死检失败用 error 上报（会把自愈失败升级成 JS 侧暂停）')
    }
  }

  // —— ⑧ 硬件采样率记录的生命周期 ——
  if (!/self\.streamError = error \?: LXError\(@"streaming_flac_engine", @"Failed to start AVAudioEngine"\);[\s\S]{0,400}?self\.configuredHardwareSampleRate = self\.engine\.outputNode\.inputFormat\(forBus:0\)\.sampleRate;/.test(code)) {
    reasons.push('建图成功时没记 configuredHardwareSampleRate（无法判断硬件格式有没有变）')
  }
  const cleanup = objcBody(code, '- (void)cleanupAudioGraphLocked {')
  if (cleanup == null) {
    reasons.push('cleanupAudioGraphLocked 锚点漂移（取不到图销毁流程）')
  } else if (!cleanup.includes('self.configuredHardwareSampleRate = 0;')) {
    reasons.push('图销毁时没把 configuredHardwareSampleRate 清零（下次建图拿旧值比较，误判格式变化）')
  }
  if (!code.includes('@property (nonatomic, assign) double configuredHardwareSampleRate;') ||
      !code.includes('@property (nonatomic, assign) int64_t renderFramesAtLivenessProbe;')) {
    reasons.push('两个新状态属性没声明（configuredHardwareSampleRate / renderFramesAtLivenessProbe）')
  }

  // —— ⑨ JS 侧口径：warning 不暂停 / error 才暂停 / 真断连仍由 JS 暂停 ——
  const nfCode = stripComments(files.nativeFlac)
  const warningCase = slice(nfCode, "case 'warning':", 'break')
  if (warningCase == null) {
    reasons.push('nativeFlac.ts 的 warning 分支锚点漂移')
  } else if (warningCase.includes('currentState')) {
    reasons.push('nativeFlac.ts 把 warning 也当成状态变更（自愈失败会把播放态改成暂停）')
  }
  const errorCase = slice(nfCode, "case 'error':", 'break')
  if (errorCase == null || !errorCase.includes("currentState = 'paused'")) {
    reasons.push('nativeFlac.ts 的 error 分支不再暂停（本脚本「用 warning 而不是 error」的前提不成立，需重新评估恢复失败的上报级别）')
  }
  if (!files.playerInit.includes('onHeadphonesDisconnected(() => {') ||
      !files.playerInit.includes('void pause()')) {
    reasons.push('JS 侧真断连暂停（headphones-disconnected → pause）不在了（原生「真断连不恢复」的口径失去对端）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量（条六）：蓝牙音频设备接入 / 移除 → 暂停播放
// ---------------------------------------------------------------------------

const bluetoothAutoPauseInvariants = (files) => {
  const reasons = []
  const code = stripComments(files.native)

  // —— ① 原生判定：这条路由有没有蓝牙输出（只看有无，不比端口明细）——
  const helper = objcBody(code, '- (BOOL)routeHasBluetoothOutput:(AVAudioSessionRouteDescription *)route {')
  if (helper == null) {
    reasons.push('routeHasBluetoothOutput: 缺失（蓝牙接入 / 移除没有判定依据）')
  } else {
    if (!/if \(route == nil\) return NO;/.test(helper)) {
      reasons.push('routeHasBluetoothOutput: 没做 nil 路由防护')
    }
    for (const port of ['AVAudioSessionPortBluetoothA2DP', 'AVAudioSessionPortBluetoothHFP', 'AVAudioSessionPortBluetoothLE']) {
      if (!helper.includes(port)) reasons.push(`routeHasBluetoothOutput: 少了 ${port}（该蓝牙设备接不上/断不掉检测）`)
    }
  }

  // —— ② 路由变化处理器：前后两条路由的「有没有蓝牙」翻转才发事件 ——
  const handler = objcBody(code, '- (void)handleAudioRouteChange:(NSNotification *)notification {')
  if (handler == null) {
    reasons.push('handleAudioRouteChange: 锚点漂移（取不到 UtilsModule 的路由变化处理器）')
  } else {
    if (!handler.includes('BOOL hadBluetooth = [self routeHasBluetoothOutput:previousRouteForBluetooth];') ||
        !handler.includes('BOOL hasBluetooth = [self routeHasBluetoothOutput:[AVAudioSession sharedInstance].currentRoute];')) {
      reasons.push('蓝牙判定没有同时看旧路由与新路由（只看一条 = 分不清「接入」与「移除」，也无法区分「本来就在」）')
    }
    if (!handler.includes('if (hadBluetooth != hasBluetooth) {')) {
      reasons.push('蓝牙判定没有用「前后翻转」做闸门（只要当前路由有蓝牙就发 = 通话时 A2DP↔HFP 切换、导航抢占都会误暂停）')
    }
    if (!handler.includes('if (previousRouteForBluetooth != nil) {')) {
      reasons.push('蓝牙判定没有要求旧路由存在（系统没给旧路由时会误发暂停）')
    }
    const atEmit = handler.indexOf('[self sendEventWithName:@"bluetooth-device-changed" body:nil];')
    const atGate = handler.indexOf('AVAudioSessionRouteChangeReasonOldDeviceUnavailable')
    if (atEmit < 0) {
      reasons.push('蓝牙接入 / 移除没有发 bluetooth-device-changed 事件（JS 侧收不到，用户要求落不了地）')
    }
    if (atEmit >= 0 && !/(dispatch_async\(dispatch_get_main_queue\(\), \^\{\s*\n\s*)\[self sendEventWithName:@"bluetooth-device-changed" body:nil\];/.test(handler)) {
      reasons.push('bluetooth-device-changed 没有在主队列上发（路由通知的线程不确定，RN sendEventWithName 要在主队列）')
    }
    if (atEmit >= 0 && atGate >= 0 && atEmit > atGate) {
      reasons.push('蓝牙判定被放在 OldDeviceUnavailable 闸门之后（接入是 NewDeviceAvailable，永远走不到那里）')
    }
    // 老路不许动：headphones-disconnected 仍在新路由判定之后照发（第 21 轮口径）
    const atHp = handler.indexOf('sendEventWithName:@"headphones-disconnected"')
    const atNewRoute = handler.indexOf('routeHasHeadphoneOutput:currentRoute')
    if (atHp < 0 || atNewRoute < 0 || atHp < atNewRoute) {
      reasons.push('headphones-disconnected 的旧口径被改动了（仍须在新路由判定之后才发，第 21 轮）')
    }
  }

  // —— ③ 事件必须在 supportedEvents 里声明（否则 RN 直接丢弃）——
  // 两个坑都要躲：① 不能只搜整份源码里有没有这个字符串 —— 发事件那一行本身就带
  // `@"bluetooth-device-changed"`，声明被删了照样搜得到，必须限定在声明表方法体内；
  // ② 本文件有三张 supportedEvents 声明表（流式 FLAC / api-action / UtilsModule），
  // 要认准带 remote-command 的那张（UtilsModule）。
  const supportedSignature = '- (NSArray<NSString *> *)supportedEvents {'
  const supportedTables = []
  for (let at = code.indexOf(supportedSignature); at >= 0; at = code.indexOf(supportedSignature, at + supportedSignature.length)) {
    const body = objcBody(code.slice(at), supportedSignature)
    if (body != null) supportedTables.push(body)
  }
  const supported = supportedTables.find((body) => body.includes('@"remote-command"')) ?? null
  if (supported == null) {
    reasons.push('supportedEvents 声明表锚点漂移（找不到 UtilsModule 那张带 remote-command 的表）')
  } else {
    if (!supported.includes('@"bluetooth-device-changed"')) {
      reasons.push('bluetooth-device-changed 未在 supportedEvents 声明（RN 会丢弃该事件）')
    }
    if (!supported.includes('@"headphones-disconnected", @"remote-command"')) {
      reasons.push('supportedEvents 里既有的 headphones-disconnected / remote-command 声明被破坏了')
    }
  }

  // —— ④ JS 侧：订阅 + 暂停（且暂停要落手动暂停闸门，否则被打断流程几百毫秒后自动续播）——
  const utilsCode = stripComments(files.utilsTs)
  const listener = slice(utilsCode, 'export const onBluetoothDeviceChanged = (handler: () => void)', 'export const onHeadphonesDisconnected = (handler: () => void)')
  if (listener == null) {
    reasons.push('utils.ts 没有导出 onBluetoothDeviceChanged（原生事件没有订阅入口）')
  } else {
    if (!listener.includes("eventEmitter.addListener('bluetooth-device-changed', () => {")) {
      reasons.push('onBluetoothDeviceChanged 没有监听 bluetooth-device-changed')
    }
    if (!listener.includes('if (!UtilsModule) return () => {}')) {
      reasons.push('onBluetoothDeviceChanged 没做原生缺失时的空订阅降级')
    }
  }

  const initCode = stripComments(files.playerInit)
  const block = slice(initCode, 'onBluetoothDeviceChanged(() => {', '\n  }\n')
  if (block == null) {
    reasons.push('core/init/player/player.ts 没有订阅 onBluetoothDeviceChanged（接通了原生事件但没人暂停）')
  } else {
    if (!block.includes('if (!playerState.isPlay) return')) {
      reasons.push('蓝牙设备变化时没判「正在播才暂停」（未播放时白跑一趟）')
    }
    if (!block.includes('markManualPause()')) {
      reasons.push('蓝牙设备变化暂停时没落手动暂停闸门（蓝牙切换常伴随打断，3s「最近在播」时间窗会把暂停顶开）')
    }
    if (!block.includes('void pause()')) {
      reasons.push('蓝牙设备变化没有真的暂停播放')
    }
    const atMark = block.indexOf('markManualPause()')
    const atPause = block.indexOf('void pause()')
    if (atMark >= 0 && atPause >= 0 && atMark > atPause) {
      reasons.push('markManualPause 落在 pause 之后（pause 途中可能已被打断流程顶上恢复意图）')
    }
  }
  if (!initCode.includes('import { onBluetoothDeviceChanged, onHeadphonesDisconnected } from \'@/utils/nativeModules/utils\'')) {
    reasons.push('player.ts 没有引入 onBluetoothDeviceChanged')
  }
  if (!initCode.includes("import { markManualPause } from '@/core/player/manualPause'")) {
    reasons.push('player.ts 没有引入 markManualPause（手动暂停闸门）')
  }
  if (initCode.indexOf('onBluetoothDeviceChanged(() => {') < initCode.indexOf("if (Platform.OS == 'ios') {")) {
    reasons.push('蓝牙暂停订阅没在 iOS 专属分支里（Android 上会挂一个永远不来的事件）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检：改回旧实现 / 拆掉任一道保险，都必须被拦下
// ---------------------------------------------------------------------------

const runCounterExamples = () => {
  const src = REAL.native
  const results = []
  const ce = (name, detail, ok) => results.push({ name, detail, ok: !!ok })

  const withNative = (patched) => ({ ...REAL, native: patched })

  // n1 拆掉路由变化观察者（本 bug 的原始状态）
  const n1 = src.replace('@selector(handleAudioRouteChangeWhileStreaming:)', '@selector(handleAudioSessionInterruption:)')
  ce('n1 拆掉路由变化观察者', '注册被摘 → 不变量报「没注册 AVAudioSessionRouteChange」',
    n1 !== src && bluetoothStabilityInvariants(withNative(n1)).length > 0 &&
    bluetoothStabilityInvariants(withNative(n1)).some((r) => r.includes('AVAudioSessionRouteChangeNotification')))

  // n2 不区分真断连（OldDeviceUnavailable 判定删掉）
  const n2 = src.replace('BOOL isPhysicalDisconnect = reason == AVAudioSessionRouteChangeReasonOldDeviceUnavailable;', 'BOOL isPhysicalDisconnect = NO;')
  ce('n2 删掉真断连判定', '拔耳机也在扬声器上抢放',
    n2 !== src && bluetoothStabilityInvariants(withNative(n2)).some((r) => r.includes('OldDeviceUnavailable')))

  // n3 摘掉手动暂停 / 打断门槛
  const n3 = src.replace('  if (self.manualPause || self.interruptedBySystem) return;\n  if (self.sourceNode == nil', '  if (self.sourceNode == nil')
  ce('n3 摘掉手动暂停/打断门槛', '暂停被顶开、打断期间抢会话',
    n3 !== src && bluetoothStabilityInvariants(withNative(n3)).some((r) => r.includes('手动暂停')))

  // n4 不重设会话
  const n4 = src.replace(
    '  if (treatAsDisconnect && ![self currentRouteHasHeadphoneOutput]) return;\n\n  NSError *sessionError = nil;\n  if (![self prepareAudioSession:&sessionError]) return;',
    '  if (treatAsDisconnect && ![self currentRouteHasHeadphoneOutput]) return;\n\n  NSError *sessionError = nil;',
  )
  ce('n4 恢复时不重设会话', '引擎起了也没声',
    n4 !== src && bluetoothStabilityInvariants(withNative(n4)).some((r) => r.includes('prepareAudioSession')))

  // n5 恢复失败改用 error 上报
  const n5 = src.replace(
    '[self emitWarningMessage:engineError.localizedDescription ?: @"Failed to restart audio engine after route change" code:nil statusName:nil];',
    '[self emitErrorMessage:engineError.localizedDescription ?: @"Failed to restart audio engine after route change"];',
  )
  ce('n5 恢复失败改报 error', 'JS 侧把路由抖动当暂停 → 停播',
    n5 !== src && bluetoothStabilityInvariants(withNative(n5)).some((r) => r.includes('error 上报')))

  // n6 不挂 IO 死检
  const n6 = src.replace('      [self checkStreamingOutputLivenessLocked];\n', '')
  ce('n6 不挂 IO 死检', 'isRunning 为真但 IO 已死时没人救',
    n6 !== src && bluetoothStabilityInvariants(withNative(n6)).some((r) => r.includes('IO 死检')))

  // n7 死检不看帧数是否停涨（无脑重启）
  const n7 = src.replace('  if (renderedFrames != self.renderFramesAtLivenessProbe) return;\n', '')
  ce('n7 死检不看帧数停涨', '每 0.35s 掐一次 IO → 比原来还卡',
    n7 !== src && bluetoothStabilityInvariants(withNative(n7)).some((r) => r.includes('帧数')))

  // n8 不按硬件格式变化重挂输出
  const n8 = src.replace('    if (self.engine.isRunning && hardwareFormatChanged) {', '    if (NO && hardwareFormatChanged) {')
  ce('n8 不按硬件格式重挂输出', '44.1k ↔ 48k 切换后继续没声',
    n8 !== src && bluetoothStabilityInvariants(withNative(n8)).some((r) => r.includes('硬件采样率')))

  // n9 图销毁不清硬件格式记录
  const n9 = src.replace('  // 【第 31 轮·条五】图没了：硬件格式记录一并清零，下次建图重新记\n  self.configuredHardwareSampleRate = 0;\n', '')
  ce('n9 图销毁不清格式记录', '下次建图拿旧值比较 → 误判',
    n9 !== src && bluetoothStabilityInvariants(withNative(n9)).some((r) => r.includes('清零')))

  // n10 摘掉「真断连回扬声器不恢复」的挡板
  const n10 = src.replace('  if (treatAsDisconnect && ![self currentRouteHasHeadphoneOutput]) return;\n', '')
  ce('n10 摘掉真断连挡板', '耳机拔了还在扬声器抢放',
    n10 !== src && bluetoothStabilityInvariants(withNative(n10)).some((r) => r.includes('真断连回扬声器')))

  // n11 路由变化只恢复一次（没有重试节奏）
  const n11 = src.replace(
    '[self scheduleStreamingOutputRecoveryWithDelays:@[ @0.15, @0.6, @1.5 ] treatAsDisconnect:isPhysicalDisconnect];',
    '[self scheduleStreamingOutputRecoveryWithDelays:@[ @0.15 ] treatAsDisconnect:isPhysicalDisconnect];',
  )
  ce('n11 路由变化只恢复一次', '通知成串来时后面几次漏掉',
    n11 !== src && bluetoothStabilityInvariants(withNative(n11)).some((r) => r.includes('重试节奏')))

  // n12 死检不排除「环里没数据」（正常缓冲被反复重启）
  const n12 = src.replace('  if (queuedFrames <= 0) return;\n', '')
  ce('n12 死检不排除空环', '正常等缓冲时反复重启 → 越修越卡',
    n12 !== src && bluetoothStabilityInvariants(withNative(n12)).some((r) => r.includes('正常缓冲')))

  // n13 JS 侧 warning 也改状态（「用 warning 而不是 error」的口径被破坏）
  const n13 = REAL.nativeFlac.replace("      case 'warning':\n        listener({", "      case 'warning':\n        currentState = 'paused'\n        listener({")
  ce('n13 warning 也改播放态', '自愈告警把播放态改成暂停',
    n13 !== REAL.nativeFlac && bluetoothStabilityInvariants({ ...REAL, nativeFlac: n13 }).length > 0 &&
    bluetoothStabilityInvariants({ ...REAL, nativeFlac: n13 }).some((r) => r.includes('warning')))

  // —— 条六：蓝牙接入 / 移除 → 暂停 ——
  const btEmitStmt = '[self sendEventWithName:@"bluetooth-device-changed" body:nil];'

  // b1 事件不在 supportedEvents 里声明（RN 静默丢弃）
  const b1 = src.replace('@"player-seeked", @"bluetooth-device-changed" ]', '@"player-seeked" ]')
  ce('b1 事件未声明 supportedEvents', 'RN 丢弃 → 收不到暂停',
    b1 !== src && bluetoothAutoPauseInvariants({ ...REAL, native: b1 }).some((r) => r.includes('supportedEvents')))

  // b2 蓝牙判定挪到 OldDeviceUnavailable 闸门之后（接入事件永远走不到）
  const btEmitAt = src.indexOf(btEmitStmt)
  const withoutEmit = src.slice(0, btEmitAt) + 'nil;' + src.slice(btEmitAt + btEmitStmt.length)
  const hpAnchor = '[self sendEventWithName:@"headphones-disconnected" body:nil];'
  const b2 = withoutEmit.replace(hpAnchor, hpAnchor + '\n    ' + btEmitStmt)
  ce('b2 蓝牙判定挪到 reason 闸门后', '接入（NewDeviceAvailable）被判走不到',
    b2 !== src && bluetoothAutoPauseInvariants({ ...REAL, native: b2 }).some((r) => r.includes('闸门之后')))

  // b3 丢掉「前后翻转」闸门（当前路由有蓝牙就发 = 通话 A2DP↔HFP 切换也暂停）
  const b3 = src.replace('if (hadBluetooth != hasBluetooth) {', 'if (hasBluetooth) {')
  ce('b3 丢掉前后翻转闸门', '通话 Profile 切换 / 抢占被误判成接入',
    b3 !== src && bluetoothAutoPauseInvariants({ ...REAL, native: b3 }).some((r) => r.includes('前后翻转')))

  // b4 JS 侧不再订阅（原生发了没人暂停）
  const b4 = REAL.playerInit.replace('    onBluetoothDeviceChanged(() => {\n      if (!playerState.isPlay) return\n      markManualPause()\n      void pause()\n    })\n', '')
  ce('b4 JS 侧不再订阅蓝牙事件', '原生事件没人接',
    b4 !== REAL.playerInit && bluetoothAutoPauseInvariants({ ...REAL, playerInit: b4 }).some((r) => r.includes('onBluetoothDeviceChanged')))

  // b5 暂停不落手动暂停闸门（3s 时间窗把暂停顶开）
  const b5 = REAL.playerInit.replace('      markManualPause()\n      void pause()\n    })\n  }\n}', '      void pause()\n    })\n  }\n}')
  ce('b5 不落手动暂停闸门', '暂停几百毫秒后被自动续播顶开',
    b5 !== REAL.playerInit && bluetoothAutoPauseInvariants({ ...REAL, playerInit: b5 }).some((r) => r.includes('手动暂停闸门')))

  // b6 蓝牙判定漏掉 HFP（通话型蓝牙设备接不上 / 断不掉检测）。
  // 注意：同一行端口判定在 routeHasHeadphoneOutput: 里也有一份（在前），所以只能改
  // routeHasBluetoothOutput: 自己的方法体，不能对整份源码做首处替换。
  const btHelperBody = objcBody(src, '- (BOOL)routeHasBluetoothOutput:(AVAudioSessionRouteDescription *)route {')
  const b6 = btHelperBody == null ? src : src.replace(btHelperBody, btHelperBody.replace('        [portType isEqualToString:AVAudioSessionPortBluetoothHFP] ||\n', ''))
  ce('b6 判定漏掉 HFP 端口', '车机 / 耳机通话端口不算蓝牙',
    b6 !== src && bluetoothAutoPauseInvariants({ ...REAL, native: b6 }).some((r) => r.includes('BluetoothHFP')))

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-bluetooth-audio-stability ===')
console.log('蓝牙 / 路由变化后的音频输出自愈（观察者 + 重试节奏 + 门槛 + renderQueue 落点 + IO 死检 + 硬件格式记录）（第 31 轮·条五）')
console.log('蓝牙音频设备接入 / 移除 → 暂停播放（前后翻转判定 + 主队列事件 + supportedEvents + JS 订阅 + 手动暂停闸门）（第 31 轮·条六）')
console.log()

const checks = [
  ['条五 蓝牙稳定输出（两个观察者 / 真断连判定 / 重试节奏 / 恢复门槛与动作 / IO 死检 / 硬件格式生命周期 / JS warning 口径）', () => bluetoothStabilityInvariants(REAL)],
  ['条六 蓝牙接入 / 移除自动暂停（前后翻转判定 / 主队列事件 / supportedEvents 声明 / JS 订阅 + 手动暂停闸门）', () => bluetoothAutoPauseInvariants(REAL)],
]

let invOk = true
const passCount = []
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    passCount.push(name)
    console.log(`\n[${name}]\n  PASS`)
  } else {
    invOk = false
    console.log(`\n[${name}]`)
    ;[...new Set(reasons)].forEach((r) => console.log('  FAIL ' + r))
  }
}

console.log('\n[反例自检]')
const ceResults = runCounterExamples()
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.detail}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${passCount.length}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
