#!/usr/bin/env node
/**
 * sim-audio-interruption-resume.js —— 「其他音频结束后自动续播 + 让出音频会话」契约
 * （用户第 13 轮第 1 条）
 *
 * 需求原话（2026-10-02）：手动暂停时，其他音频播放结束后不会自动开始播放，只有不是
 * 手动暂停时，其他音频播放结束后会自动开始播放，而且其他音频播放时，要卸载占用音频，
 * 保证其他音频可以正常使用，其他音频结束播放时，再马上占用音频，开始自动播放。
 *
 * 收敛结果（ios/LxMusicMobile/AppDelegate.mm，原生 AVAudioEngine 流式 FLAC 路径）：
 *   Began：不再因为「没在出声 / 手动暂停」直接 return。只要拿到了打断通知就
 *     ① 置 interruptedBySystem（打断结束据此自动续播）；
 *     ② 在引擎确实停下后主动 setActive:NO + NotifyOthersOnDeactivation 让出会话。
 *   Ended：只看 interruptedBySystem，不再拿 manualPause / ShouldResume 当门槛；
 *     抢回会话（prepareAudioSession）→ 起引擎 → 清 manualPause → maybeStartPlaybackLocked。
 *     唯二不抢会话的出口：没有可播的流（sourceNode == nil / stopped / idle）。
 *   pause：刻意不清 interruptedBySystem（打断期间手动暂停，结束后仍要续播）。
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

const readSource = () => fs.readFileSync(path.join(ROOT, NATIVE), 'utf8')

/** 去掉行注释：断言只看代码，避免中文说明里提到 manualPause / ShouldResume 造成假命中 */
const stripComments = (s) => s.split('\n').map((line) => {
  const at = line.indexOf('//')
  return at < 0 ? line : line.slice(0, at)
}).join('\n')

/** 全部断言都从这里取结构；反例把 src 换掉再跑一遍 */
const evaluate = (src) => {
  const handler = methodBody(src, '- (void)handleAudioSessionInterruption:(NSNotification *)notification {')
  const began = handler && caseBody(handler, 'case AVAudioSessionInterruptionTypeBegan: {', 'case AVAudioSessionInterruptionTypeEnded:')
  const ended = handler && caseBody(handler, 'case AVAudioSessionInterruptionTypeEnded: {', 'default:')
  const pause = methodBody(src, 'RCT_REMAP_METHOD(pause, pauseStreamWithResolver:')
  const stop = methodBody(src, 'RCT_REMAP_METHOD(stop, stopStreamWithResolver:')
  const beganCode = began ? stripComments(began) : null
  const endedCode = ended ? stripComments(ended) : null
  const pauseCode = pause ? stripComments(pause) : null
  const stopCode = stop ? stripComments(stop) : null

  const atMarker = beganCode ? beganCode.indexOf('self.interruptedBySystem = YES;') : -1
  const atEarlyReturn = beganCode ? beganCode.indexOf('if (!shouldEmitPause) return;') : -1

  return {
    // —— Began：无条件置标记 + 让出会话 ——
    began_noLegacyReturn: !!beganCode && !beganCode.includes('if (!shouldHandle || self.manualPause) return;'),
    began_markerBeforeReturn: atMarker >= 0 && atEarlyReturn >= 0 && atMarker < atEarlyReturn,
    began_releasesSession: !!beganCode && beganCode.includes('setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation'),
    began_releaseGuarded: !!beganCode && /if \(canReleaseSession\) \{/.test(beganCode),
    began_releaseNeedsEngineStopped: !!beganCode && /canReleaseSession = self\.sourceNode != nil && \(self\.engine == nil \|\| !self\.engine\.isRunning\);/.test(beganCode),

    // —— Ended：不拿 manualPause / ShouldResume 当门槛，抢回会话 + 起播 ——
    ended_guardIsMarkerOnly: !!endedCode && endedCode.includes('if (!self.interruptedBySystem) return;'),
    ended_noShouldResume: !!endedCode && !endedCode.includes('shouldResume'),
    ended_manualPauseOnlyCleared: !!endedCode && (endedCode.match(/manualPause/g) || []).length === 1 && endedCode.includes('self.manualPause = NO;'),
    ended_skipsWhenNothingToPlay: !!endedCode && /if \(self\.sourceNode == nil \|\| \[self\.currentState isEqualToString:@"stopped"\] \|\| \[self\.currentState isEqualToString:@"idle"\]\) return;/.test(endedCode),
    ended_reacquiresAndPlays: !!endedCode && endedCode.includes('[self prepareAudioSession:&sessionError]') && endedCode.includes('[self maybeStartPlaybackLocked]'),

    // —— pause：不取消待续播标记；stop 才是取消出口 ——
    pause_keepsInterruptionMarker: !!pauseCode && !/self\.interruptedBySystem = NO;/.test(pauseCode),
    stop_cancelsResume: !!stopCode && /self\.interruptedBySystem = NO;/.test(stopCode),
  }
}

const LABELS = {
  began_noLegacyReturn: 'Began 不再因「未出声 / 手动暂停」提前 return（旧写法会让 Ended 整单作废）',
  began_markerBeforeReturn: 'Began 的 interruptedBySystem = YES 在 shouldEmitPause 早退之前（无条件置位）',
  began_releasesSession: 'Began 主动让出音频会话 setActive:NO + NotifyOthersOnDeactivation',
  began_releaseGuarded: '让出会话由 canReleaseSession 守着（不是无条件调用）',
  began_releaseNeedsEngineStopped: 'canReleaseSession 要求引擎已停下（否则掐断 IO，恢复后无声）',
  ended_guardIsMarkerOnly: 'Ended 门槛只认 interruptedBySystem',
  ended_noShouldResume: 'Ended 不再依赖 ShouldResume（其他音频结束就续播）',
  ended_manualPauseOnlyCleared: 'Ended 里 manualPause 只被清零、不作门槛',
  ended_skipsWhenNothingToPlay: 'Ended 对「无流 / stopped / idle」不抢会话（避免误播）',
  ended_reacquiresAndPlays: 'Ended 抢回会话并起播（prepareAudioSession + maybeStartPlaybackLocked）',
  pause_keepsInterruptionMarker: 'pause 不清 interruptedBySystem（打断期间手动暂停，结束后仍续播）',
  stop_cancelsResume: 'stop 仍会取消待续播（用户明确结束播放的唯一出口）',
}

console.log('='.repeat(92))
console.log('「其他音频结束后自动续播 + 让出音频会话」契约模型（摘自 ' + NATIVE + '）')
console.log('='.repeat(92))

const src = readSource()
const real = evaluate(src)

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
const m1 = src.replace(
  '      self.interruptedBySystem = YES;\n      if (canReleaseSession) {',
  '      if (!shouldEmitPause) return;\n      self.interruptedBySystem = YES;\n      if (canReleaseSession) {',
)
const m1r = evaluate(m1)
neg('反例 m1：early-return 早于标记（旧 Began 语义）被拦下',
  m1 !== src && !m1r.began_markerBeforeReturn)

// m2 旧 Began：不让出会话
const m2 = src.replace(/\n *\[\[AVAudioSession sharedInstance\] setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil\];/, '')
const m2r = evaluate(m2)
neg('反例 m2：拆掉让出会话（其他音频被占着）被拦下',
  m2 !== src && !m2r.began_releasesSession)

// m3 旧 Ended 门槛：manualPause / ShouldResume 重新挡路
const m3 = src.replace(
  '      if (!self.interruptedBySystem) return;\n      self.interruptedBySystem = NO;',
  '      BOOL shouldResume = ([userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue] & AVAudioSessionInterruptionOptionShouldResume) != 0;\n      if (!self.interruptedBySystem || self.manualPause || !shouldResume) { self.interruptedBySystem = NO; return; }\n      self.interruptedBySystem = NO;',
)
const m3r = evaluate(m3)
neg('反例 m3：Ended 重新被 manualPause / ShouldResume 挡住（用户报的 bug）被拦下',
  m3 !== src && !m3r.ended_guardIsMarkerOnly && !m3r.ended_noShouldResume && !m3r.ended_manualPauseOnlyCleared)

// m4 旧 pause：清掉待续播标记
const m4 = src.replace(
  '    self.manualPause = YES;\n    // 【用户第 13 轮第 1 条】',
  '    self.manualPause = YES;\n    self.interruptedBySystem = NO;\n    // 【用户第 13 轮第 1 条】',
)
const m4r = evaluate(m4)
neg('反例 m4：pause 清掉待续播标记（打断期间暂停即失效）被拦下',
  m4 !== src && !m4r.pause_keepsInterruptionMarker)

const negFailed = negResults.filter(ok => !ok).length

console.log()
console.log('='.repeat(92))
console.log(`结果：断言 ${assertCount - failed}/${assertCount} 通过；反例 ${negResults.length - negFailed}/${negResults.length} 拦下`)
console.log()

process.exit(failed || negFailed ? 1 : 0)
