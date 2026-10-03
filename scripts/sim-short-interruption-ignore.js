#!/usr/bin/env node
/**
 * sim-short-interruption-ignore.js —— 「短暂系统音不打断播放（忽略窗口）」契约（第 31 轮·追加）。
 *
 * 需求原话（2026-10-04）：「当我点击手机电源键或者系统发出提示音时，音乐会短暂声音大小
 * 变化，要避免一下声音影响音乐正常播放，只有超过一定长度的音乐才会进行声音大小变化」。
 *
 * 根因：iOS 对电源键锁定音 / 系统提示音这类短促系统音同样会发一对「打断开始 → 很快结束」
 * 的通知。本工程对打断开始的反应（原生：[self.engine pause] + 让出会话 + 呈现暂停；
 * 独占模式 JS：立刻 pause()）会把一声 0.3s 的系统音放大成「音乐被切一下再接回」——
 * 即用户听到的「短暂声音变化」。
 *
 * 修法（两侧同值 1500ms 的忽略窗口）：
 *   · AppDelegate.mm：Began 只立即无条件置 interruptedBySystem（第 13/16 轮口径：拿到打断
 *     通知就算数；同时让路由自愈在窗口期不抢会话），「停引擎 / 让出会话 / 呈现暂停」整段由
 *     scheduleDeferredInterruptionBeganHandling 推迟到 LXShortInterruptionIgnoreMs；窗口内
 *     Ended 整单撤销 + 轻量自愈（不启播、不发状态）；用户动作（恢复播放 / 停止 / 切歌复位）
 *     撤销待决。
 *   · service.ts：独占模式打断开始不再立刻 pause，改为 scheduleInterruptionPause() 推迟
 *     SHORT_INTERRUPTION_IGNORE_MS；窗口内「结束」先到 → 撤销待决（scheduleAutoResume 只在
 *     播放真被停掉时接回）；用户动作统一经 cancelResumePending 撤销待决。
 *   超过窗口的真实打断（导航播报 / 通话 / 其它音乐）行为与第 13/16/21/24 轮口径一字不差。
 *
 * 为什么必须靠契约脚本：窗口「漏在哪一侧」都不会崩、也过得了 tsc/eslint（本工程根本没有）：
 * 立刻停引擎（原生）/ 立刻 pause（JS）、Ended 不撤销、计时器不看待决标记、窗口值被改成 0、
 * 用户动作不撤销 —— 全是真机上「按电源键音乐被切一下」或「播报不恢复」的现场。带反例自检。
 *
 * 运行：node scripts/sim-short-interruption-ignore.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去整行 `//` 注释（行尾注释保留；断言锚点全都不是注释）
const stripComments = (s) => s.split('\n').map((line) => {
  const at = line.indexOf('//')
  return at < 0 ? line : line.slice(0, at)
}).join('\n')

const F = {
  native: 'ios/LxMusicMobile/AppDelegate.mm',
  service: 'src/plugins/player/service.ts',
}

const REAL = {
  native: read(F.native),
  service: read(F.service),
}

/** 取一个方法体：签名命中处起，到第一个位于行首的 `}` 为止 */
const methodBody = (s, signature) => {
  const start = s.indexOf(signature)
  if (start < 0) return null
  const rest = s.slice(start)
  const end = /\n\}\n/.exec(rest)
  return end ? rest.slice(0, end.index) : null
}

/** 取一个函数体（签名 → 第一个顶格 `}` 行，含结尾换行），给 JS 侧用 */
const bodyOf = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  const rest = src.slice(start)
  const end = /\n\}\n/.exec(rest)
  return end ? rest.slice(0, end.index + 3) : null
}

/** 取 switch 里某个 case 的块体：case 头起，到下一个 case / default 为止 */
const caseBody = (s, header, next) => {
  const start = s.indexOf(header)
  if (start < 0) return null
  const rest = s.slice(start + header.length)
  const end = rest.indexOf(next)
  return end < 0 ? null : rest.slice(0, end)
}

// ---------------------------------------------------------------------------
// 不变量 ①：原生 —— Began 立即置标记 + 推迟执行；Ended 窗口内整单撤销
// ---------------------------------------------------------------------------

const nativeInvariants = (src) => {
  const reasons = []
  const handler = methodBody(src, '- (void)handleAudioSessionInterruption:(NSNotification *)notification {')
  const began = handler && caseBody(handler, 'case AVAudioSessionInterruptionTypeBegan: {', 'case AVAudioSessionInterruptionTypeEnded:')
  const ended = handler && caseBody(handler, 'case AVAudioSessionInterruptionTypeEnded: {', 'default:')
  const beganC = began ? stripComments(began) : null
  const endedC = ended ? stripComments(ended) : null
  const scheduleM = methodBody(src, '- (void)scheduleDeferredInterruptionBeganHandling {')
  const execM = methodBody(src, '- (void)performInterruptionBeganHandling {')
  const healM = methodBody(src, '- (void)restoreOutputAfterIgnoredShortInterruption {')
  const resumeM = methodBody(src, 'RCT_REMAP_METHOD(resume, resumeStreamWithResolver:')
  const stopM = methodBody(src, 'RCT_REMAP_METHOD(stop, stopStreamWithResolver:')
  const resetM = methodBody(src, '- (void)resetStreamingState {')
  const scheduleC = scheduleM ? stripComments(scheduleM) : null
  const execC = execM ? stripComments(execM) : null
  const healC = healM ? stripComments(healM) : null
  const resumeC = resumeM ? stripComments(resumeM) : null
  const stopC = stopM ? stripComments(stopM) : null
  const resetC = resetM ? stripComments(resetM) : null

  // —— ①-a 窗口常量 ——
  if (!/static const int64_t LXShortInterruptionIgnoreMs = 1500;/.test(src)) {
    reasons.push('忽略窗口常量缺失或不是 1500ms（LXShortInterruptionIgnoreMs）—— 窗口没了 / 被改到不合理的值')
  }

  // —— ①-b Began：立即无条件置标记 + 推迟调度；不得再直接停引擎 / 让出会话 / 呈现暂停 ——
  if (beganC == null) {
    reasons.push('Began case 找不到（结构漂移，整个忽略窗口失去锚点）')
  } else {
    const atMarker = beganC.indexOf('self.interruptedBySystem = YES;')
    const atDefer = beganC.indexOf('[self scheduleDeferredInterruptionBeganHandling];')
    if (atMarker < 0) reasons.push('Began 不再立即置 interruptedBySystem（第 13/16 轮的无条件置位口径被拆）')
    if (atDefer < 0) reasons.push('Began 没有把完整处理推迟（缺 scheduleDeferredInterruptionBeganHandling 调用）')
    if (atMarker >= 0 && atDefer >= 0 && atMarker > atDefer) {
      reasons.push('Began 先调度推迟、后置标记（窗口期路由自愈会去抢被打断的会话）')
    }
    if (/\breturn;/.test(beganC)) reasons.push('Began case 里又出现了 return 早退（推迟执行必须无条件发生）')
    if (beganC.includes('[self.engine pause]')) reasons.push('Began 又直接停引擎 —— 短暂系统音会立刻把音乐切掉（用户报的现场）')
    if (beganC.includes('setActive:NO')) reasons.push('Began 又直接让出会话（短暂系统音也会走完整处理）')
    if (beganC.includes('emitState:@"paused"')) reasons.push('Began 又直接呈现暂停（短暂系统音会闪一下暂停 UI）')
  }

  // —— ①-c 推迟回调：必须看待决标记，只有仍待决才执行完整处理 ——
  if (scheduleC == null) {
    reasons.push('scheduleDeferredInterruptionBeganHandling 缺失（完整处理无处推迟）')
  } else {
    if (!scheduleC.includes('self.pendingShortInterruptionIgnore = YES;')) reasons.push('推迟调度没有置待决标记')
    if (!/dispatch_after\(dispatch_time\(DISPATCH_TIME_NOW, \(int64_t\)\(LXShortInterruptionIgnoreMs \* NSEC_PER_MSEC\)\), dispatch_get_main_queue\(\)/.test(scheduleC)) {
      reasons.push('推迟调度没有按 LXShortInterruptionIgnoreMs 走 dispatch_after（窗口时长失效）')
    }
    if (!scheduleC.includes('if (!strongSelf.pendingShortInterruptionIgnore) return;')) {
      reasons.push('推迟回调不看待决标记 —— 窗口内 Ended 撤销后仍会照跑完整处理（忽略窗口形同虚设）')
    }
    if (!scheduleC.includes('[strongSelf performInterruptionBeganHandling];')) reasons.push('推迟回调没有执行完整处理（真实打断不再停引擎 / 让出会话）')
  }

  // —— ①-d 完整处理（执行体）：原 Began 的四件套一个不少 ——
  if (execC == null) {
    reasons.push('performInterruptionBeganHandling 缺失（真实打断的完整处理不见了）')
  } else {
    if (!execC.includes('[self.engine pause]')) reasons.push('执行体不再停引擎（真实打断后音乐照响，会话却被系统掐着）')
    if (!execC.includes('shouldEmitPause = !LXPlayWithOthersEnabled;')) reasons.push('执行体丢了「与其他应用同时播放」的呈现口径（第 24 轮）')
    if (!/if \(canReleaseSession\) \{/.test(execC)) reasons.push('执行体丢了让出会话的 canReleaseSession 守卫')
    if (!execC.includes('setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation')) reasons.push('执行体不再让出会话（其他音频没声音的第 16 轮现场）')
    if (!execC.includes('if (!shouldEmitPause) return;')) reasons.push('执行体的 shouldEmitPause 早退不见了')
    if (!execC.includes('emitState:@"paused"')) reasons.push('执行体不再呈现暂停（独占模式 UI 停在「在播」）')
  }

  // —— ①-e Ended：窗口内整单撤销，且在标记守卫之前 ——
  if (endedC == null) {
    reasons.push('Ended case 找不到（结构漂移）')
  } else {
    const atBlip = endedC.indexOf('if (self.pendingShortInterruptionIgnore) {')
    const atGuard = endedC.indexOf('if (!self.interruptedBySystem) return;')
    if (atBlip < 0) reasons.push('Ended 缺少忽略窗口分支（短暂系统音走完整恢复流程）')
    if (atBlip >= 0) {
      if (atGuard >= 0 && atBlip > atGuard) reasons.push('忽略窗口分支在标记守卫之后（短暂系统音先被当真实打断处理）')
      const branch = atGuard > atBlip ? endedC.slice(atBlip, atGuard) : endedC.slice(atBlip)
      if (!branch.includes('self.pendingShortInterruptionIgnore = NO;')) reasons.push('忽略窗口分支不撤待决标记（同一次系统音还会被完整处理一遍）')
      if (!branch.includes('self.interruptedBySystem = NO;')) reasons.push('忽略窗口分支不回滚打断标记（第 13 轮口径：当没发生）')
      if (!branch.includes('[self restoreOutputAfterIgnoredShortInterruption];')) reasons.push('忽略窗口分支没有输出自愈（系统掐过会话就成了有进度没声音）')
    }
  }

  // —— ①-f 自愈：轻量（不启播、不发状态、不动暂停闸门）——
  if (healC == null) {
    reasons.push('restoreOutputAfterIgnoredShortInterruption 缺失')
  } else {
    if (!healC.includes('prepareAudioSession')) reasons.push('自愈不重设会话（被系统掐过的会话拿不回来）')
    if (!healC.includes('ensureAudioEngineRunningLocked')) reasons.push('自愈不保证引擎在跑（IO 停摆后无声）')
    if (!healC.includes('schedulePlaybackOutputRestoreWithDelays')) reasons.push('自愈不重贴音量 / 音效')
    if (healC.includes('maybeStartPlaybackLocked')) reasons.push('自愈启动播放（忽略窗口内播放没停过，多余启播 = 误播风险）')
    if (healC.includes('emitState')) reasons.push('自愈发状态事件（短暂系统音会闪 UI）')
    if (healC.includes('manualPause = NO')) reasons.push('自愈动手动暂停闸门（用户暂停会被悄悄抬起来）')
  }

  // —— ①-g 用户动作撤销待决：恢复播放 / 停止 / 切歌复位 ——
  const clearLine = 'self.pendingShortInterruptionIgnore = NO;'
  if (resumeC == null || !resumeC.includes(clearLine)) reasons.push('resume（用户主动恢复播放）不撤销待决暂停')
  if (stopC == null || !stopC.includes(clearLine)) reasons.push('stop 不撤销待决暂停')
  if (resetC == null || !resetC.includes(clearLine)) reasons.push('resetStreamingState（openStream / reset 都走它）不撤销待决暂停')

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 ②：service.ts —— 独占分支推迟暂停；窗口内结束撤销；用户动作统一撤销
// ---------------------------------------------------------------------------

const serviceInvariants = (serviceSrc) => {
  const reasons = []
  const svc = stripComments(serviceSrc)

  // —— ②-a 窗口常量与计时器工具 ——
  if (!/const SHORT_INTERRUPTION_IGNORE_MS = 1500/.test(svc)) {
    reasons.push('service.ts 缺 SHORT_INTERRUPTION_IGNORE_MS = 1500（与原生同值的窗口）')
  }
  const clearFn = bodyOf(svc, 'const clearInterruptionPauseTimer = () => {')
  const scheduleFn = bodyOf(svc, 'const scheduleInterruptionPause = () => {')
  if (clearFn == null) reasons.push('clearInterruptionPauseTimer 缺失')
  else if (!clearFn.includes('clearTimeout(interruptionPauseTimer)')) reasons.push('clearInterruptionPauseTimer 不真的清计时器')

  if (scheduleFn == null) reasons.push('scheduleInterruptionPause 缺失（独占分支没有推迟暂停的落点）')
  else {
    if (!scheduleFn.includes('clearInterruptionPauseTimer()')) reasons.push('scheduleInterruptionPause 不先清旧计时器（连续打断会堆叠暂停）')
    if (!scheduleFn.includes('interruptionPauseTimer = setTimeout(')) reasons.push('scheduleInterruptionPause 没有起计时器')
    if (!scheduleFn.includes('SHORT_INTERRUPTION_IGNORE_MS')) reasons.push('scheduleInterruptionPause 不用忽略窗口常量')
    if (!scheduleFn.includes('global.lx.isPlayedStop')) reasons.push('scheduleInterruptionPause 到点不查停止状态（停止退出会被拖回来）')
    if (!scheduleFn.includes('void pause()')) reasons.push('scheduleInterruptionPause 到点不暂停（真实长打断不再让位）')
  }

  // —— ②-b 独占分支：打断开始不再立刻 pause ——
  const mBegan = /^      if \(paused && !permanent\) \{/m.exec(svc)
  const atExclBegan = mBegan ? mBegan.index : -1
  const exclBeganBlock = atExclBegan < 0 ? null : svc.slice(atExclBegan, svc.indexOf('\n      }\n', atExclBegan))
  if (exclBeganBlock == null) {
    reasons.push('独占分支的「打断开始」块找不到（第 21 轮分流被改坏）')
  } else {
    if (!exclBeganBlock.includes('scheduleInterruptionPause()')) reasons.push('独占分支打断开始没有推迟暂停（立刻 pause = 用户报的现场）')
    if (exclBeganBlock.includes('void pause()')) reasons.push('独占分支打断开始又立刻 pause 了（短暂系统音会被切一下）')
  }

  // —— ②-c 结束分支：窗口内撤销待决（且在 30s 长抢占判定之前）——
  const atLong = svc.indexOf('const wasLongInterruption')
  const atBlip = atLong < 0 ? -1 : svc.lastIndexOf('if (interruptionPauseTimer != null) {', atLong)
  if (atBlip < 0 || atBlip < atExclBegan) {
    reasons.push('独占结束分支缺「窗口内结束」分支（短暂系统音会走完整恢复 / 长抢占判定）')
  } else {
    const blipBlock = svc.slice(atBlip, atLong)
    if (!blipBlock.includes('clearInterruptionPauseTimer()')) reasons.push('窗口内结束不撤待决暂停（同一次系统音还会被 pause 一次）')
    if (!blipBlock.includes('interruptedAt = 0')) reasons.push('窗口内结束不清打断时刻（长抢占判定会用到脏值）')
    if (!blipBlock.includes('scheduleAutoResume()')) reasons.push('窗口内结束不兜「播放真被停掉」的接回（原生层自停会留下停播）')
  }

  // —— ②-d 混音分支不许有暂停计时器（第 24 轮：混音不因其它音频暂停自己）——
  const atMix = svc.indexOf('if (isPlayWithOthers()) {')
  const atExclDuck = atMix < 0 ? -1 : svc.indexOf('\n      if (ducking) {', atMix)
  if (atMix < 0 || atExclDuck < 0) {
    reasons.push('混音 / 独占分流边界找不到（结构漂移）')
  } else if (svc.slice(atMix, atExclDuck).includes('scheduleInterruptionPause')) {
    reasons.push('混音分支引入了推迟暂停（「同时播放」下会被暂停）')
  }

  // —— ②-e 用户动作统一撤销 ——
  const cancelFn = bodyOf(svc, 'export const cancelResumePending = () => {')
  if (cancelFn == null) reasons.push('cancelResumePending 缺失')
  else if (!cancelFn.includes('clearInterruptionPauseTimer()')) reasons.push('cancelResumePending 不撤销待决暂停（用户动作后窗口仍会 1.5s 到点暂停）')

  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检：任一侧把忽略窗口改回去（或拆掉任一段），都必须被拦下
// ---------------------------------------------------------------------------

const runCounterExamples = () => {
  const results = []
  const ce = (name, detail, ok) => results.push({ name, detail, ok: !!ok })

  // n1 原生 Began 退回「立刻停引擎」：短暂系统音被切一下（用户报的现场）
  const n1 = REAL.native.replace(
    '      [self scheduleDeferredInterruptionBeganHandling];',
    '      if (self.engine != nil && self.engine.isRunning) [self.engine pause];',
  )
  ce('n1 原生 Began 退回立刻停引擎', '按电源键 / 提示音时音乐被切一下',
    n1 !== REAL.native && nativeInvariants(n1).length > 0)

  // n2 推迟回调不看待决标记：窗口内 Ended 撤销后仍照跑完整处理
  const n2 = REAL.native.replace('    if (!strongSelf.pendingShortInterruptionIgnore) return;\n', '')
  ce('n2 推迟回调不看待决标记', '忽略窗口形同虚设',
    n2 !== REAL.native && nativeInvariants(n2).length > 0)

  // n3 Ended 的忽略窗口分支被拆
  const n3 = REAL.native.replace('      if (self.pendingShortInterruptionIgnore) {', '      if (NO) {')
  ce('n3 Ended 拆掉忽略窗口分支', '短暂系统音走完整恢复流程',
    n3 !== REAL.native && nativeInvariants(n3).length > 0)

  // n4 忽略窗口分支挪到标记守卫之后（短暂系统音先被当真实打断）
  const n4 = REAL.native.replace(
    '      if (self.pendingShortInterruptionIgnore) {\n' +
    '        self.pendingShortInterruptionIgnore = NO;\n' +
    '        self.interruptedBySystem = NO;\n' +
    '        [self restoreOutputAfterIgnoredShortInterruption];\n' +
    '        return;\n' +
    '      }\n' +
    '      // 标记由 Began 分支无条件置位（含手动暂停 / 未出声），这里只看它。\n' +
    '      if (!self.interruptedBySystem) return;',
    '      // 标记由 Began 分支无条件置位（含手动暂停 / 未出声），这里只看它。\n' +
    '      if (!self.interruptedBySystem) return;\n' +
    '      if (self.pendingShortInterruptionIgnore) {\n' +
    '        self.pendingShortInterruptionIgnore = NO;\n' +
    '        self.interruptedBySystem = NO;\n' +
    '        [self restoreOutputAfterIgnoredShortInterruption];\n' +
    '        return;\n' +
    '      }',
  )
  ce('n4 忽略窗口分支挪到标记守卫之后', '短暂系统音先被当作真实打断处理',
    n4 !== REAL.native && nativeInvariants(n4).length > 0)

  // n5 自愈升级成「启播」（忽略窗口内播放没停过，多余启播 = 误播风险）
  const n5 = REAL.native.replace(
    '  [self schedulePlaybackOutputRestoreWithDelays:@[ @0.1, @0.5 ]];',
    '  [self maybeStartPlaybackLocked];\n  [self schedulePlaybackOutputRestoreWithDelays:@[ @0.1, @0.5 ]];',
  )
  ce('n5 自愈启播', '忽略窗口内播放没停过，多余启播',
    n5 !== REAL.native && nativeInvariants(n5).length > 0)

  // n6 resume 不再撤销待决（用户恢复播放后窗口仍会到点暂停）
  const n6 = REAL.native.replace(
    '      // 【第 31 轮·追加】用户主动恢复播放：撤销短暂系统音窗口里的待决暂停（用户要的音乐优先）\n' +
    '      self.pendingShortInterruptionIgnore = NO;\n',
    '',
  )
  ce('n6 resume 不撤待决', '用户恢复播放后 1.5s 仍被暂停',
    n6 !== REAL.native && nativeInvariants(n6).length > 0)

  // j1 JS 独占分支退回立刻 pause
  const j1 = REAL.service.replace('        scheduleInterruptionPause()\n', '        void pause()\n')
  ce('j1 JS 独占分支退回立刻 pause', '短暂系统音会切一下播放',
    j1 !== REAL.service && serviceInvariants(j1).length > 0)

  // j2 JS 结束分支拆掉窗口内撤销
  const j2 = REAL.service.replace('      if (interruptionPauseTimer != null) {', '      if (false) {')
  ce('j2 JS 结束分支拆掉窗口内撤销', '同一次系统音仍会被 pause 一次',
    j2 !== REAL.service && serviceInvariants(j2).length > 0)

  // j3 cancelResumePending 不再撤销（用户动作后窗口仍到点暂停）
  const j3 = REAL.service.replace(
    '  clearResumeTimer()\n' +
    '  // 【第 31 轮·追加】任何「用户意图 / 播放状态明确」的动作都会走到这里（播放、手动暂停、\n' +
    '  // 切歌、停止、遥控、自然播完）：一并撤销短暂系统音窗口里的待决暂停。\n' +
    '  clearInterruptionPauseTimer()\n' +
    '}',
    '  clearResumeTimer()\n}',
  )
  ce('j3 cancelResumePending 不撤待决', '用户动作后窗口仍会到点暂停',
    j3 !== REAL.service && serviceInvariants(j3).length > 0)

  // j4 窗口值被改大（短暂系统音不再被覆盖）
  const j4 = REAL.service.replace('const SHORT_INTERRUPTION_IGNORE_MS = 1500', 'const SHORT_INTERRUPTION_IGNORE_MS = 20000')
  ce('j4 窗口值被改到 20s', '提示音窗口失效（或反向：改 0 等于没有）',
    j4 !== REAL.service && serviceInvariants(j4).length > 0)

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-short-interruption-ignore ===')
console.log('短暂系统音忽略窗口（两侧同值 1.5s：Began 立即置标记 + 推迟完整处理；窗口内 Ended 整单撤销）（第 31 轮·追加）')
console.log()

const checks = [
  ['原生 AppDelegate.mm（窗口常量 / Began 立即置标记与推迟 / 回调看待决 / 执行体四件套 / Ended 整单撤销 / 轻量自愈 / 用户动作撤待决）', () => nativeInvariants(REAL.native)],
  ['service.ts（窗口常量与计时器工具 / 独占分支推迟暂停 / 结束分支窗口内撤销 / 混音分支不受影响 / cancelResumePending 统一撤销）', () => serviceInvariants(REAL.service)],
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
