/**
 * sim-r62-mix-continuity.js
 *
 * 「勾选『与其他应用同时播放』后，所有情况下都持续出声」契约不变量
 * （第 62 轮第 2 条，2026-10-11）。
 *
 * 需求原话：
 *   「2、当我勾选上"与其他应用同时播放"选项，不会自动暂停音乐，而且在一些直播软件打开和关闭时，
 *     会出现短暂的声音消失，应该是这些直播软件有清理音频的功能，这个需要解决，当我勾选上
 *     "与其他应用同时播放"选项，保证所有情况下都可以持续播放音乐」
 *   （中途追加）「当我勾选上"与其他应用同时播放"选项，迷你播放器栏还显示播放图标不是暂停图标」
 *
 * 现场拆成四条互不相干的断点，全部在 ios/LxMusicMobile/AppDelegate.mm：
 *
 *   ① **自愈链被门槛挡死**：`recoverStreamingOutputForRouteChange:` 的旧门槛是
 *      `if (self.manualPause || self.interruptedBySystem) return;`，而混音态的打断 Began 分支
 *      虽然「原地不动」，却照旧把 `interruptedBySystem` 置上 —— 于是路由变化 / 引擎配置变化
 *      通知全被忽略，而直播类应用开麦 / 关麦恰恰是**悄悄掐断输出 IO**（引擎 isRunning 仍为真），
 *      唯一的救命路径就是这条自愈链 + 其中 0.35s 的 IO 死检。
 *   ② **自愈链会抢会话**：混音分支下面那截「退回非混音口径」的兜底 = 抢占（setCategory
 *      options:0 再 setActive）。起播抢一下是对的，自愈抢就会和正在出声的应用来回拉锯。
 *      拆出 `prepareAudioSessionAllowingExclusiveFallback:`，自愈路径传 NO。
 *   ③ **resume 把「会话被占」当故障**：混音态下会话被别家占着是常态，旧写法 emitError +
 *      reject ⇒ JS `global.app_event.error()` 把播放态翻成暂停（迷你播放器栏显示 ▶），
 *      而且 service.ts 的混音重取阶梯以 `playerState.isPlay` 为闸门 —— 一翻就把整条阶梯掐死。
 *      混音态改为 warning + 继续；warning 在驱动层是**惰性**的（nativeFlacDriver 没有 case）。
 *   ④ **媒体服务重置没人管**：mediaserverd 崩溃 / 重启时会话、引擎、音频单元全部作废，
 *      而且不会有打断 / 路由通知 —— 旧实现完全没有监听，表现是「再也没声音，重启 App 才好」。
 *
 * 配套（JS 侧，交叉守卫）：controller.ts 的 shouldSuppressSystemPause —— 勾选期间引擎自报的
 * 'paused' / 'buffering' 不得把播放态翻掉（第 59 / 60 轮的口径，本轮不再改动，只防回归）。
 *
 * 为什么必须靠契约脚本：这些都是「哪条路允许抢会话、失败上报用 error 还是 warning、
 * 恢复节奏挂在哪个队列上」的口径，原生改错一个字（把 warning 写回 error、把 NO 写成 YES、
 * 把恢复阶梯挪到 dispatch_sync 里）在真机上就是「一响一停」「越修越断」，而本工程没有
 * Xcode 也没有原生单测。带反例自检。
 *
 * 运行：node scripts/sim-r62-mix-continuity.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  native: 'ios/LxMusicMobile/AppDelegate.mm',
  controller: 'src/plugins/player/controller.ts',
  driver: 'src/plugins/player/engine/drivers/nativeFlacDriver.ts',
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

const countOf = (src, needle) => src.split(needle).length - 1

// ---------------------------------------------------------------------------
// 不变量 A：会话准备的两套口径（用户动作可抢 / 自愈不可抢）
// ---------------------------------------------------------------------------

const sessionPolicyInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  const plain = objcBody(code, '- (BOOL)prepareAudioSession:(NSError **)error {')
  if (plain == null) {
    reasons.push('prepareAudioSession: 缺失（起播 / 用户主动恢复的入口没了）')
  } else if (!plain.includes('return [self prepareAudioSessionAllowingExclusiveFallback:YES error:error];')) {
    reasons.push('prepareAudioSession: 没有委托给统一实现（allowExclusiveFallback:YES）—— 起播路径必须保留「抢一下」的能力')
  }

  const helper = objcBody(code, '- (BOOL)prepareAudioSessionAllowingExclusiveFallback:(BOOL)allowExclusiveFallback error:(NSError **)error {')
  if (helper == null) {
    reasons.push('prepareAudioSessionAllowingExclusiveFallback:error: 缺失（自愈路径没有「不退回独占」的口径）')
  } else {
    const guardAt = helper.indexOf('if (!allowExclusiveFallback) return NO;')
    if (guardAt < 0) {
      reasons.push('缺 allowExclusiveFallback 闸门（自愈路径会退回独占组合 = 抢会话）')
    }
    const mixAt = helper.indexOf('AVAudioSessionRouteSharingPolicyDefault')
    if (mixAt < 0) {
      reasons.push('混音组合的 setCategory（RouteSharingPolicyDefault + MixWithOthers）缺失')
    }
    const exclusiveAt = helper.indexOf('AVAudioSessionRouteSharingPolicyLongFormAudio')
    if (exclusiveAt < 0) {
      reasons.push('非混音口径的 setCategory（RouteSharingPolicyLongFormAudio）缺失（勾选取消后没声音）')
    }
    if (guardAt >= 0 && mixAt >= 0 && guardAt < mixAt) {
      reasons.push('allowExclusiveFallback 闸门落在混音分支之前（混音组合根本没试过就放弃）')
    }
    if (guardAt >= 0 && exclusiveAt >= 0 && guardAt > exclusiveAt) {
      reasons.push('allowExclusiveFallback 闸门落在独占回退之后（闸门形同虚设）')
    }
    if (!helper.includes('if ([session setActive:YES error:error]) return [session setActive:YES error:error];') &&
        !helper.includes('options:AVAudioSessionCategoryOptionMixWithOthers\n                       error:error]) return [session setActive:YES error:error];')) {
      reasons.push('混音分支成功后没有直接 setActive:YES（混音组合白设）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：自愈路径不抢会话 / 不把「会话被占」当故障
// ---------------------------------------------------------------------------

const selfHealingInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  const recover = objcBody(code, '- (void)recoverStreamingOutputForRouteChange:(BOOL)treatAsDisconnect {')
  if (recover == null) {
    reasons.push('recoverStreamingOutputForRouteChange: 缺失（自愈链没了）')
  } else if (!recover.includes('[self prepareAudioSessionAllowingExclusiveFallback:NO error:&sessionError]')) {
    reasons.push('路由自愈没有用「不退回独占」的口径重设会话（会和正在出声的应用拉锯）')
  }

  const resume = objcBody(code, 'RCT_REMAP_METHOD(resume, resumeStreamWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {')
  if (resume == null) {
    reasons.push('resumeStreamWithResolver 缺失（恢复播放的入口没了）')
    return reasons
  }

  // ① 会话失败：独占态照旧 error + reject，混音态只 warning
  if (!resume.includes('BOOL sessionReady = [self prepareAudioSession:&sessionError];')) {
    reasons.push('resume 没有记录会话准备结果（sessionReady）')
  }
  const sessionErrorBlock = '    if (!sessionReady && !LXPlayWithOthersEnabled) {\n      [self emitErrorMessage:'
  if (!resume.includes(sessionErrorBlock)) {
    reasons.push('resume 的会话失败没有按混音态分流（!sessionReady && !LXPlayWithOthersEnabled 才发 error）')
  }
  const sessionWarnBlock = '    if (!sessionReady) {\n      [self emitWarningMessage:'
  if (!resume.includes(sessionWarnBlock)) {
    reasons.push('resume 的混音态会话失败没有降级为 warning（JS 会把 error 当暂停，迷你播放器栏显示 ▶）')
  }
  const sessionErrAt = resume.indexOf(sessionErrorBlock)
  const sessionWarnAt = resume.indexOf(sessionWarnBlock)
  if (sessionErrAt >= 0 && sessionWarnAt >= 0 && sessionErrAt > sessionWarnAt) {
    reasons.push('resume 的 warning 分支落在 error 分支之前（分流顺序反了）')
  }

  // ② 引擎失败：同一套分流
  const engineErrorBlock = '    if (engineError != nil && !LXPlayWithOthersEnabled) {\n      [self emitErrorMessage:'
  if (!resume.includes(engineErrorBlock)) {
    reasons.push('resume 的引擎失败没有按混音态分流（勾选后引擎起不来会被当致命错误）')
  }
  if (!resume.includes('    if (engineError != nil) {\n      [self emitWarningMessage:')) {
    reasons.push('resume 的混音态引擎失败没有降级为 warning')
  }

  // ③ error 上报点必须恰好两个，且都带 !LXPlayWithOthersEnabled 闸门
  const errCount = countOf(resume, '[self emitErrorMessage:')
  if (errCount !== 2) {
    reasons.push(`resume 里的 emitErrorMessage 出现 ${errCount} 处（应恰好 2 处、且都在 !LXPlayWithOthersEnabled 分支里）`)
  }
  const guardedErrCount = countOf(resume, '!LXPlayWithOthersEnabled) {\n      [self emitErrorMessage:')
  if (guardedErrCount !== 2) {
    reasons.push(`emitErrorMessage 只有 ${guardedErrCount} 处带混音闸门（勾选状态下会把播放态翻成暂停）`)
  }

  // ④ 混音态每次 resume 挂一次 IO 死检（对方开麦 / 关麦掐断 IO 的兜底）
  const probeAt = resume.indexOf('if (LXPlayWithOthersEnabled && self.engine != nil) {')
  if (probeAt < 0) {
    reasons.push('resume 没有混音态的 IO 死检（对方掐断 IO 后没人重挂输出）')
  } else {
    const resolveAt = resume.indexOf('resolve(nil);')
    if (!resume.includes('self.renderFramesAtLivenessProbe = _renderedFrames.load(std::memory_order_acquire);')) {
      reasons.push('混音死检没有取渲染帧数快照（没有基准，比对无从谈起）')
    }
    if (!resume.includes('0.35 * NSEC_PER_SEC') || !resume.includes('[self checkStreamingOutputLivenessLocked];')) {
      reasons.push('混音死检没有 0.35s 后的 checkStreamingOutputLivenessLocked')
    }
    if (resolveAt >= 0 && probeAt > resolveAt) {
      reasons.push('混音死检挂在 resolve 之后（异常路径会跳过它）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：媒体服务重置自愈
// ---------------------------------------------------------------------------

const mediaServicesInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  if (!/selector:@selector\(handleMediaServicesWereReset:\)\s*\n\s*name:AVAudioSessionMediaServicesWereResetNotification\s*\n\s*object:\[AVAudioSession sharedInstance\]/.test(code)) {
    reasons.push('没有把 handleMediaServicesWereReset: 注册到 AVAudioSessionMediaServicesWereResetNotification（媒体服务重置后没人管）')
  }

  const handler = objcBody(code, '- (void)handleMediaServicesWereReset:(NSNotification *)notification {')
  if (handler == null) {
    reasons.push('handleMediaServicesWereReset: 处理器缺失')
    return reasons
  }
  if (!handler.includes('if (self.currentURL.length == 0 || self.manualPause) return;')) {
    reasons.push('媒体服务重置处理器没有「没流 / 手动暂停就撤」的门槛')
  }
  const stopAt = handler.indexOf('if (self.engine != nil) [self.engine stop];')
  if (stopAt < 0) {
    reasons.push('媒体服务重置后没有停掉作废的引擎（带着失效音频单元的引擎 isRunning 可能仍为真，恢复链会整段跳过）')
  }
  const scheduleAt = handler.indexOf('[self scheduleStreamingOutputRecoveryWithDelays:@[ @0.1, @0.6, @2.0 ] treatAsDisconnect:NO];')
  if (scheduleAt < 0) {
    reasons.push('媒体服务重置后没有走既有的恢复链（@[ @0.1, @0.6, @2.0 ] treatAsDisconnect:NO）')
  }
  if (stopAt >= 0 && scheduleAt >= 0 && stopAt > scheduleAt) {
    reasons.push('媒体服务重置先恢复再停引擎（顺序反了：引擎带着失效单元时恢复链会整段跳过）')
  }
  if (handler.includes('emitErrorMessage')) {
    reasons.push('媒体服务重置用 error 上报（JS 侧把 error 当暂停，会把可自愈的重置升级成停播）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：混音态打断时也补一条原生重取阶梯
// ---------------------------------------------------------------------------

const interruptionRecoveryInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  const handler = objcBody(code, '- (void)performInterruptionBeganHandling {')
  if (handler == null) {
    reasons.push('performInterruptionBeganHandling 缺失（打断处理找不到）')
    return reasons
  }

  if (!handler.includes('__block BOOL shouldArmMixRecovery = NO;')) {
    reasons.push('缺 shouldArmMixRecovery 标记（混音态的重取阶梯没有开关）')
  }
  const mixAt = handler.indexOf('if (LXPlayWithOthersEnabled) {')
  if (mixAt < 0) {
    reasons.push('缺混音态「整段让行」分支（第 58 轮口径）')
  } else {
    const returnAt = handler.indexOf('\n    }\n', mixAt)
    const armAt = handler.indexOf('shouldArmMixRecovery = YES;', mixAt)
    if (armAt < 0) {
      reasons.push('混音态让行分支没有置 shouldArmMixRecovery（原地不动之外没有原生兜底）')
    } else if (returnAt >= 0 && armAt > returnAt) {
      reasons.push('shouldArmMixRecovery 置在让行分支之外（混音态仍然不会挂重取阶梯）')
    }
  }

  const armBlockAt = handler.indexOf('if (shouldArmMixRecovery) {')
  if (armBlockAt < 0) {
    reasons.push('没有消费 shouldArmMixRecovery（混音态的恢复阶梯从未被挂上）')
  } else {
    if (!handler.includes('[self scheduleStreamingOutputRecoveryWithDelays:@[ @0.4, @1.2, @3.0 ] treatAsDisconnect:NO];')) {
      reasons.push('混音态的恢复节奏不是 @[ @0.4, @1.2, @3.0 ] treatAsDisconnect:NO')
    }
    const syncAt = handler.indexOf('dispatch_sync(self.renderQueue, ^{')
    if (syncAt >= 0 && armBlockAt < syncAt) {
      reasons.push('恢复阶梯挂在 dispatch_sync 之前（会话操作会阻塞几十毫秒，不该压在 renderQueue 的同步块外拍）')
    }
    const flagAt = handler.indexOf('self.interruptedBySystem = YES;')
    if (flagAt >= 0 && armBlockAt > flagAt) {
      reasons.push('恢复阶梯挂在 interruptedBySystem 置位之后（顺序与第 13 轮口径不符）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 E：JS 侧配套（warning 惰性 + 混音态不吞手动暂停）
// ---------------------------------------------------------------------------

const jsInvariants = (files) => {
  const reasons = []
  const controller = stripComments(files.controller)
  const driver = stripComments(files.driver)

  // ① 驱动层：error → bus error（会翻播放态）；warning 在驱动层必须保持惰性
  if (!driver.includes("case 'error':")) {
    reasons.push('nativeFlacDriver 没有把原生 error 映射成 bus error（这条链路变了，契约要重审）')
  }
  if (driver.includes("case 'warning':")) {
    reasons.push('nativeFlacDriver 新增了 warning 处理 —— 混音态的原生失败上报依赖「warning 在驱动层惰性」，本契约需要重审')
  }

  // ② 混音态不许引擎自报的暂停 / 缓冲把播放态翻掉
  const suppress = controller.indexOf('const shouldSuppressSystemPause = () => {')
  if (suppress < 0) {
    reasons.push('shouldSuppressSystemPause 缺失（勾选后引擎自报暂停会把 UI 翻成暂停）')
  } else {
    const body = controller.slice(suppress, suppress + 400)
    for (const [needle, label] of [
      ["if (Platform.OS != 'ios') return false", '非 iOS 直接放行'],
      ['if (!isPlayWithOthers()) return false', '未勾选直接放行'],
      ['if (isManualPause()) return false', '手动暂停不吞'],
      ['if (global.lx.isPlayedStop) return false', '停止 / 播完不吞'],
      ['return playerState.isPlay', '只在 UI 认为在播时吞'],
    ]) {
      if (!body.includes(needle)) reasons.push(`shouldSuppressSystemPause 少了「${label}」（${needle}）`)
    }
  }
  if (!controller.includes('if (!shouldSuppressSystemPause()) global.app_event.pause()')) {
    reasons.push("controller.ts 的 'buffering' 分支没走 shouldSuppressSystemPause（第 60 轮的残余暂停路径会回来）")
  }
  if (!controller.includes('if (shouldSuppressSystemPause()) break')) {
    reasons.push("controller.ts 的 'paused' 分支没走 shouldSuppressSystemPause")
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------

const runCounterExamples = () => {
  const results = []
  const ce = (name, detail, ok, reasons) => results.push({
    name,
    detail: ok ? detail : `${detail}；reasons=${JSON.stringify(reasons ?? [])}`,
    ok: !!ok,
  })
  const withNative = (patched) => ({ ...REAL, native: patched })
  const nativeCE = (tampered, fn, needle) => {
    if (tampered === REAL.native) return [null, ['（tamper 没打上）']]
    // AppDelegate 侧的不变量函数吃的是**源码字符串**（不是 files 对象）
    const rs = fn(tampered)
    return [rs.some((r) => r.includes(needle)), rs]
  }

  // b1 自愈路径退回可直接抢占的口径
  {
    const t = REAL.native.replace(
      '[self prepareAudioSessionAllowingExclusiveFallback:NO error:&sessionError]',
      '[self prepareAudioSessionAllowingExclusiveFallback:YES error:&sessionError]',
    )
    const [ok, rs] = nativeCE(t, selfHealingInvariants, '不退回独占')
    ce('b1 自愈路径允许抢会话', '又和正在出声的应用拉锯（一响一停）', ok, rs)
  }

  // b2 allowExclusiveFallback 闸门删掉
  {
    const t = REAL.native.replace('      if (!allowExclusiveFallback) return NO;\n', '')
    const [ok, rs] = nativeCE(t, sessionPolicyInvariants, 'allowExclusiveFallback 闸门')
    ce('b2 删掉 allowExclusiveFallback 闸门', '自愈路径退回独占组合', ok, rs)
  }

  // b3 混音态会话失败退回 error + reject（第 62 轮前的写法）
  {
    const t = REAL.native.replace(
      '    if (!sessionReady && !LXPlayWithOthersEnabled) {',
      '    if (!sessionReady) {',
    )
    const [ok, rs] = nativeCE(t, selfHealingInvariants, '按混音态分流')
    ce('b3 会话失败不分流', 'JS 把 error 当暂停 → 迷你播放器栏显示 ▶、重取阶梯被掐死', ok, rs)
  }

  // b4 混音态引擎失败退回 error
  {
    const t = REAL.native.replace(
      '    if (engineError != nil && !LXPlayWithOthersEnabled) {',
      '    if (engineError != nil) {',
    )
    const [ok, rs] = nativeCE(t, selfHealingInvariants, '引擎失败没有按混音态分流')
    ce('b4 引擎失败不分流', '勾选后引擎起不来就整单 reject', ok, rs)
  }

  // b5 混音态 IO 死检摘掉
  {
    const t = REAL.native.replace(
      '    if (LXPlayWithOthersEnabled && self.engine != nil) {\n      dispatch_async(self.renderQueue, ^{\n        self.renderFramesAtLivenessProbe = _renderedFrames.load(std::memory_order_acquire);\n      });\n      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)), self.renderQueue, ^{\n        [self checkStreamingOutputLivenessLocked];\n      });\n    }\n',
      '',
    )
    const [ok, rs] = nativeCE(t, selfHealingInvariants, '没有混音态的 IO 死检')
    ce('b5 摘掉混音态 IO 死检', '对方掐断 IO 后没人重挂输出', ok, rs)
  }

  // b6 媒体服务重置观察者摘掉
  {
    const t = REAL.native.replace(
      '                                             selector:@selector(handleMediaServicesWereReset:)\n                                                 name:AVAudioSessionMediaServicesWereResetNotification\n                                               object:[AVAudioSession sharedInstance]];\n',
      '',
    )
    const [ok, rs] = nativeCE(t, mediaServicesInvariants, '没有把 handleMediaServicesWereReset: 注册')
    ce('b6 摘掉媒体服务重置观察者', 'mediaserverd 重启后再也没声音', ok, rs)
  }

  // b7 媒体服务重置先恢复再停引擎（顺序反了）
  {
    const t = REAL.native.replace(
      '  dispatch_async(self.renderQueue, ^{\n    if (self.engine != nil) [self.engine stop];\n  });\n  [self scheduleStreamingOutputRecoveryWithDelays:@[ @0.1, @0.6, @2.0 ] treatAsDisconnect:NO];',
      '  [self scheduleStreamingOutputRecoveryWithDelays:@[ @0.1, @0.6, @2.0 ] treatAsDisconnect:NO];\n  dispatch_async(self.renderQueue, ^{\n    if (self.engine != nil) [self.engine stop];\n  });',
    )
    const [ok, rs] = nativeCE(t, mediaServicesInvariants, '先恢复再停引擎')
    ce('b7 媒体服务重置顺序反了', '引擎带着失效单元 → 恢复链整段跳过', ok, rs)
  }

  // b8 混音态打断不挂原生重取阶梯
  {
    const t = REAL.native.replace('      shouldArmMixRecovery = YES;\n', '')
    const [ok, rs] = nativeCE(t, interruptionRecoveryInvariants, '没有置 shouldArmMixRecovery')
    ce('b8 混音态不挂重取阶梯', '只有 JS 那条 1s 起拍、每次都要过桥的阶梯', ok, rs)
  }

  // b9 重取阶梯挪进 dispatch_sync（会话操作压在 renderQueue 上）
  {
    const t = REAL.native.replace(
      '  if (shouldArmMixRecovery) {\n    [self scheduleStreamingOutputRecoveryWithDelays:@[ @0.4, @1.2, @3.0 ] treatAsDisconnect:NO];\n  }\n',
      '',
    ).replace(
      '  dispatch_sync(self.renderQueue, ^{\n    BOOL shouldHandle =',
      '  if (shouldArmMixRecovery) {\n    [self scheduleStreamingOutputRecoveryWithDelays:@[ @0.4, @1.2, @3.0 ] treatAsDisconnect:NO];\n  }\n  dispatch_sync(self.renderQueue, ^{\n    BOOL shouldHandle =',
    )
    const [ok, rs] = nativeCE(t, interruptionRecoveryInvariants, '挂在 dispatch_sync 之前')
    ce('b9 重取阶梯挂在同步块之前', '会话操作阻塞 renderQueue', ok, rs)
  }

  // b10 混音态被引擎自报暂停翻掉（JS 侧回归）
  {
    const t = REAL.controller.replace('if (shouldSuppressSystemPause()) break', 'if (false) break')
    if (t === REAL.controller) {
      ce('b10 paused 分支不看混音门', '勾选后引擎自报暂停就把 UI 翻成暂停', false, ['（tamper 没打上）'])
    } else {
      const rs = jsInvariants({ ...REAL, controller: t })
      ce('b10 paused 分支不看混音门', '勾选后引擎自报暂停就把 UI 翻成暂停',
        rs.some((r) => r.includes("'paused' 分支没走 shouldSuppressSystemPause")), rs)
    }
  }

  // b11 驱动层给 warning 加了副作用（混音态失败上报不再是惰性的）
  {
    const t = REAL.driver.replace("        case 'error':", "        case 'warning':\n          bus.emit({ type: 'error', driver: 'nativeFlac', error: event })\n          break\n        case 'error':")
    if (t === REAL.driver) {
      ce('b11 驱动层给 warning 加副作用', 'warning 不再是惰性上报', false, ['（tamper 没打上）'])
    } else {
      const rs = jsInvariants({ ...REAL, driver: t })
      ce('b11 驱动层给 warning 加副作用', 'warning 不再是惰性上报',
        rs.some((r) => r.includes('新增了 warning 处理')), rs)
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-r62-mix-continuity ===')

const checks = [
  ['会话准备两套口径（AppDelegate.mm）', () => sessionPolicyInvariants(REAL.native)],
  ['自愈不抢会话 + resume 分流（AppDelegate.mm）', () => selfHealingInvariants(REAL.native)],
  ['媒体服务重置自愈（AppDelegate.mm）', () => mediaServicesInvariants(REAL.native)],
  ['混音态打断的原生重取阶梯（AppDelegate.mm）', () => interruptionRecoveryInvariants(REAL.native)],
  ['JS 侧配套：warning 惰性 + 混音不吞手动暂停', () => jsInvariants(REAL)],
]

let invOk = true
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    console.log(`\n[${name}]\n  PASS`)
  } else {
    invOk = false
    console.log(`\n[${name}]`)
    reasons.forEach((r) => console.log('  FAIL ' + r))
  }
}

console.log('\n[反例自检]')
const ceResults = runCounterExamples()
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.ok ? '已拦下' : `未拦下（${r.detail}）`}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
