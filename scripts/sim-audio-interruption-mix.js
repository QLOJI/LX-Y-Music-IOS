#!/usr/bin/env node
/**
 * sim-audio-interruption-mix.js —— 「与其他应用同时播放」的打断策略契约（用户第 24 轮）。
 *
 * 需求原话（2026-10-03 第 24 轮）：
 *   「1、勾选后播放其他音频不会暂停，会同时播放音乐；2、取消勾选后，会正常暂停，
 *     播放完后自动恢复播放（和目前功能一样）」
 *   「勾选后，锁屏界面和灵动岛播放界面消失了，取消就有了，我需要始终显示」
 *
 * 为什么不在音频会话层做（本脚本存在的原因）：
 *   mixWithOthers 是 mixable 会话 ⇒ 失去 Now Playing 主会话资格 ⇒ 锁屏 / 灵动岛播放
 *   卡片消失；且与原生流式引擎的 LongFormAudio 路由策略互斥（setCategory 报 -50），
 *   会话被停用后表现为「有进度没声音」。会话因此**始终非混音**，见
 *   scripts/sim-play-with-others-toggle.js 的会话不变量。
 *
 * 于是「勾选后其它音频不能让我们停下来」落在**策略层**，两处同口径：
 *   JS（service.ts，RemoteDuck 的 iOS 分支）：勾选时单开一段策略分支 ——
 *     打断开始 → 不调 pause()（这是与独占分支唯一的区别）、照记待恢复意图但受手动暂停闸门约束；
 *     打断结束 → 恢复音量 + scheduleAutoResume（原生会重启引擎，两边幂等）；
 *     取消勾选 → 原独占分支一字未改（暂停 + 短暂中断自动续播 = 第 21/22 轮口径）。
 *   原生（AppDelegate.mm，handleAudioSessionInterruption:）：
 *     JS 经 setPlayWithOthers 下发 LXPlayWithOthersEnabled；Began 分支据此
 *     shouldEmitPause = !LXPlayWithOthersEnabled —— 勾选时引擎照旧停摆（音频已被系统压住），
 *     但不 emit paused、不改 currentState：UI / 锁屏 / 灵动岛保持「在播」；Ended 分支
 *     仍照 interruptedBySystem 重启引擎 + schedulePlaybackOutputRestoreWithDelays 恢复输出。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：多一句 pause()、少一句续播、标记写死，全都合法，
 * 只在真机上表现为「勾选了还是被暂停」或「勾选后又没声了」）。
 * 运行：node scripts/sim-audio-interruption-mix.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
// 剥注释后把只剩缩进的空行压成真正的空行：否则拿「跨注释行」的代码做锚点时，
// 注释被删掉留下的 8 个空格会把锚点顶开（第 24 轮踩过，m1 反例锚点未命中）
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/^[ \t]+$/gm, '')

const F = {
  service: 'src/plugins/player/service.ts',
  native: 'ios/LxMusicMobile/AppDelegate.mm',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// ---------------------------------------------------------------------------
// 不变量 A/B：JS 策略层（service.ts）
// ---------------------------------------------------------------------------

const serviceInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  const helper = "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] === false"
  if (!code.includes(helper)) {
    reasons.push('「与其他应用同时播放」判定缺失/被改写（必须是 player.isHandleAudioFocus === false，与设置页极性同源）')
  }

  const iosAt = code.indexOf("Platform.OS == 'ios'")
  const mixAt = code.indexOf('if (isPlayWithOthers()) {')
  if (mixAt < 0) {
    reasons.push('iOS 分支缺少「与其他应用同时播放」策略分支（勾选后会被系统打断成暂停）')
  } else if (iosAt < 0 || mixAt < iosAt) {
    reasons.push('策略分支不在 iOS 分支内（Android 的 audio focus 语义不同，不能套用）')
  }

  const endAt = mixAt < 0 ? -1 : code.indexOf('\n      if (ducking) {', mixAt)
  if (mixAt >= 0 && endAt < 0) {
    reasons.push('策略分支与独占分支的分界丢失（独占分支必须原样保留在其后）')
  } else if (mixAt >= 0) {
    const block = code.slice(mixAt, endAt)
    if (/\bpause\(/.test(block)) {
      reasons.push('混音分支不应调 pause()（勾选 = 不因其它音频暂停自己 —— 第 24 轮需求 1）')
    }
    if (!block.includes('if (!global.lx.isPlayedStop && !isManualPause()) shouldResumeAfterDuck = true')) {
      reasons.push('混音分支丢了手动暂停闸门（用户主动暂停后其它音频一响就自行出声 —— 第 22 轮口径）')
    }
    if (!block.includes('restoreConfiguredVolume()')) {
      reasons.push('混音分支打断结束未恢复音量（duck 后音量停在低压值）')
    }
    if (!block.includes('scheduleAutoResume()')) {
      reasons.push('混音分支打断结束未续播（原生引擎停摆后输出不会自己回来）')
    }
  }

  // 独占分支（取消勾选口径）必须原样保留：第 21/22 轮的暂停 + 短暂中断自动续播
  if (!code.includes('void pause()')) {
    reasons.push('独占分支的 void pause() 丢失（取消勾选后不会正常暂停）')
  }
  if (!code.includes('const wasLongInterruption = interruptedAt > 0 && Date.now() - interruptedAt > SHORT_INTERRUPTION_MAX_MS')) {
    reasons.push('独占分支的长中断判定丢失（长时间抢占会跟导航/通话拉锯）')
  }
  if (!code.includes('if (permanent && wasLongInterruption) return cancelResumePending()')) {
    reasons.push('独占分支的长中断分流丢失（永久抢占仍会抢回音频）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：原生（AppDelegate.mm）—— 策略标记 + 对外不呈现暂停 + 打断结束仍恢复输出
// ---------------------------------------------------------------------------

const nativeInvariants = (raw) => {
  const reasons = []
  if (!raw.includes('static BOOL LXPlayWithOthersEnabled = NO;')) {
    reasons.push('原生缺少 LXPlayWithOthersEnabled 策略标记')
  }
  if (!raw.includes('RCT_REMAP_METHOD(setPlayWithOthers')) {
    reasons.push('原生缺少 setPlayWithOthers 桥方法（JS 下发的策略进不来）')
  }
  if (!raw.includes('LXPlayWithOthersEnabled = enabled;')) {
    reasons.push('setPlayWithOthers 未把策略标记下发（策略标记未下发，勾选无效果）')
  }
  if (!raw.includes('shouldEmitPause = !LXPlayWithOthersEnabled;')) {
    reasons.push('Began 分支 shouldEmitPause 未接策略标记（勾选下打断仍对外呈现暂停 ⇒ 锁屏 / 灵动岛卡片会消失）')
  }
  if (!raw.includes('interruptedBySystem = YES;')) {
    reasons.push('Began 分支未标记 interruptedBySystem（打断结束分支不会恢复输出）')
  }
  if (!raw.includes('ensureAudioEngineRunningLocked') || !raw.includes('schedulePlaybackOutputRestoreWithDelays')) {
    reasons.push('Ended 分支未重启引擎 / 未安排输出恢复（勾选后其它音频结束不会把声音续上）')
  }
  if (!raw.includes('didResumePlaying = self.playbackStarted;')) {
    reasons.push('Ended 分支未真正重启播放（引擎起来但不出声，输出不会回来）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 反例（对篡改后的源码跑同一套判断，必须被拦下）
// ---------------------------------------------------------------------------

const tamper = (src, find, replace) => {
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find.slice(0, 60)}`)
  return src.replace(find, replace)
}
// service.ts 的判断跑在剥离注释后的代码上（断言里不应该被注释正文干扰），
// 反例也要在同口径的文本上做手脚
const tamperService = (find, replace) => tamper(stripComments(REAL.service), find, replace)

const runCounterExamples = () => {
  const results = []
  const check = (name, fn, expectReasonSubstr) => {
    let reasons = []
    try {
      reasons = fn()
    } catch (e) {
      results.push({ name, ok: false, detail: `抛异常: ${e.message}` })
      return
    }
    const hit = reasons.some(r => r.includes(expectReasonSubstr))
    results.push({ name, ok: hit, detail: hit ? '已拦下' : `未拦下（reasons=${JSON.stringify(reasons)}）` })
  }

  // m1 混音分支里塞回 void pause()（勾选后又自我暂停 = 第 24 轮报的 bug 原样复活）
  check('m1 混音分支塞回 pause()', () => serviceInvariants(tamperService(
    '          clearResumeTimer()\n          return\n        }\n\n        interruptedAt = 0',
    '          void pause()\n          clearResumeTimer()\n          return\n        }\n\n        interruptedAt = 0')),
  '不应调 pause()')

  // m2 混音分支去掉自动续播（其它音频播完，输出不回来）
  check('m2 混音分支去掉续播', () => serviceInvariants(tamperService(
    '        restoreConfiguredVolume()\n        scheduleAutoResume()',
    '        restoreConfiguredVolume()')),
  '未续播')

  // m3 判定被写死（策略分支永远不生效）
  check('m3 判定写死 false', () => serviceInvariants(tamperService(
    "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] === false",
    'const isPlayWithOthers = () => false')),
  '判定缺失')

  // m4 混音分支丢掉手动暂停闸门（用户暂停后自行出声）
  check('m4 混音分支丢手动暂停闸门', () => serviceInvariants(tamperService(
    '          if (!global.lx.isPlayedStop && !isManualPause()) shouldResumeAfterDuck = true',
    '          if (!global.lx.isPlayedStop) shouldResumeAfterDuck = true')),
  '手动暂停闸门')

  // m5 原生 shouldEmitPause 退回无条件 NO（勾选后卡片 / 灵动岛又消失）
  check('m5 原生 shouldEmitPause 未接策略', () => nativeInvariants(tamper(REAL.native,
    'shouldEmitPause = !LXPlayWithOthersEnabled;',
    'shouldEmitPause = YES;')),
  'shouldEmitPause')

  // m6 原生 setPlayWithOthers 不再下发标记（勾选无效果）
  check('m6 原生标记未下发', () => nativeInvariants(tamper(REAL.native,
    'LXPlayWithOthersEnabled = enabled;',
    'LXPlayWithOthersEnabled = NO;')),
  '策略标记未下发')

  // m7 打断结束不再真正重启播放（引擎在起、但不出声）
  check('m7 打断结束不重启播放', () => nativeInvariants(tamper(REAL.native,
    '[self maybeStartPlaybackLocked];\n        didResumePlaying = self.playbackStarted;',
    '[self maybeStartPlaybackLocked];\n        didResumePlaying = NO;')),
  '未真正重启播放')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-audio-interruption-mix ===')
console.log('「与其他应用同时播放」= 勾选不自我暂停（策略层，非会话层）+ 打断结束续上输出 + 卡片始终在（第 24 轮）')
console.log()

const checks = [
  ['JS 策略层（service.ts：isPlayWithOthers 判定 / iOS 分支内 / 混音分支无 pause + 手动暂停闸门 + 恢复音量 + 续播 / 独占分支原样）', () => serviceInvariants(REAL.service)],
  ['原生（AppDelegate.mm：LXPlayWithOthersEnabled + setPlayWithOthers + shouldEmitPause 接线 + interruptedBySystem + Ended 恢复输出）', () => nativeInvariants(REAL.native)],
]

let invOk = true
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    console.log(`\n[${name}]\n  PASS`)
  } else {
    invOk = false
    console.log(`\n[${name}]`)
    reasons.forEach(r => console.log('  FAIL ' + r))
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
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
