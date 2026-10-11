#!/usr/bin/env node
/**
 * sim-auto-resume-fade.js —— 「取消勾选『与其他应用同时播放』后，自动暂停 / 自动播放要有
 * 渐入渐出」契约（用户 2026-10-11 第 56 轮·追加）。
 *
 * 需求原话（逐字）：
 *   「新增：1、播放设置中，取消勾选“与其他应用同时播放”选项，自动暂停和自动播放增加渐入
 *     渐出效果，目前自动播放很快，声音突然很大，建议加上声音由小变大的渐入效果。」
 *
 * 现状拆开（读源码 + 逐个调用点核对得到）：
 *   自动暂停（独占口径）**本来就有渐出**：service.ts 的忽略窗口（1.5s）到期落到
 *   `void pause()` → core/player/player.ts 的 pause → utils.setPause → fadeOutThenPause，
 *   斜坡 300ms 降到 0 再真停。听感上之所以还是「像被切一刀」，是系统打断一开始就把我们的
 *   会话压住了 —— 那 300ms 渐出是在静音里跑完的。这一半本脚本只钉「链没断」（能不能听见
 *   只能真机验，见脚本尾部的诚实口径）。
 *
 *   「自动播放很快，声音突然很大」是另一条路上的两处硬切换，都落在 volumeFade.ts：
 *     ① 打断结束由**原生先重启引擎并重发 'playing'**（AppDelegate.mm 的 Ended 分支：
 *        ensureAudioEngineRunningLocked → maybeStartPlaybackLocked → emit 'playing'），
 *        而 JS 侧的预约（scheduleAutoResume → play() → setPlay → armVolumeFadeIn）跟它是
 *        两条互不等待的异步路径，谁先到没有保证。'playing' 抢先的那些次序里
 *        applyVolumeOnPlayStart 走的是「未预约」分支 —— 旧实现直写目标音量：自动暂停已经
 *        把音量压到 0（账本 currentVolume = 0），于是自动续播 = 从静音一记跳到满音量。
 *     ② armVolumeFadeIn 旧实现无条件 stopRamp() + silenceBothEngines()：打断恢复若已经
 *        自己渐入到一半，这两句把音量拍回 0，而下一声 'playing' 未必再来（引擎早已跨过
 *        出声门槛，不会为一次音量写入重发）—— 音量要等预约的兜底期限（1.5s）才一记跳回
 *        设定值，比不预约还糟。
 *
 * 本轮口径（三条，每条配一个能拦住回退的反例）：
 *   一、**未预约的 'playing' 也走渐入斜坡**：applyVolumeOnPlayStart 的「未预约」支在 iOS 上
 *       与预约支同样走 FADE_IN_MS 的斜坡；账本本来就在目标值附近时，rampVolume 内部按
 *       MIN_RAMP_DELTA 短路成直写 —— 「根本没停过的播放」（短暂系统音、播放中的重缓冲）
 *       不会被凭空加一次淡入，行为与改动前逐字节一致。Android 不变（仍直通：那边没有
 *       controller.ts 的 'playing' 兜底）。
 *   二、**预约不许掐在途的渐入**：armFadeIn 的非渐出支只在没有斜坡在跑时 stopRamp +
 *       silenceBothEngines。
 *   三、**打断结束的分支先立预约**：service.ts 独占 Ended 分支在 restoreConfiguredVolume()
 *       **之前** `if (!playerState.isPlay) armVolumeFadeIn()` ——
 *         · 预约在 ⇒ restoreConfiguredVolume 的 isVolumeFadeActive() 守卫让行，账本 / 引擎
 *           不会被一步顶回设定值（否则斜坡起点已经不是 0，渐入无从谈起）；
 *         · 只在「此刻确实不在播」时预约：还在播 = 这一单打断没真的停过音频，压 0 会白白
 *           留一个要到兜底期限才跳回去的静音洞；
 *         · **不许**挪进忽略窗口（interruptionPauseTimer != null）的早退里 —— 那里音频
 *           根本没被停过（电源键 / 系统提示音），压 0 就是「每声提示音切一次歌」。
 *
 * 为什么必须靠契约脚本：这三处全是运行期语义（事件次序、Promise 时序），tsc / eslint 全合法，
 * 只有真机上「其它音频结束的那一刻」才听得出来。
 *
 * 运行：node scripts/sim-auto-resume-fade.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 与兄弟脚本 sim-remote-command-volume-fade.js 同款：剔块注释 + 整行 `//`（行内注释不动，
// 目标文件里没有把断言串写进行内注释的地方）
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  fade: 'src/plugins/player/volumeFade.ts',
  service: 'src/plugins/player/service.ts',
  utils: 'src/plugins/player/utils.ts',
  player: 'src/core/player/player.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

const countOf = (src, needle) => src.split(needle).length - 1

/** 切一段：from（含）→ to（不含）。任一锚点找不到返回 null（锚点漂移必须显式失败） */
const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  if (to == null) return src.slice(start)
  const end = src.indexOf(to, start + from.length)
  if (end < 0) return null
  return src.slice(start, end)
}

/**
 * 取一个「以 `{` 结尾的声明行」的函数体（花括号配平到与之匹配的收尾 `}`）。
 * 与兄弟脚本同款：固定长度窗口会把断言吃进下一个函数（假满足）。
 * 传入的必须是 **stripComments 之后**的副本。
 */
const bracedBody = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  let i = src.indexOf('{', start)
  if (i < 0) return null
  let depth = 0
  let quote = null
  for (; i < src.length; i++) {
    const ch = src[i]
    if (quote != null) {
      if (ch == '\\') { i++; continue }
      if (ch == quote) quote = null
      continue
    }
    if (ch == "'" || ch == '"' || ch == '`') { quote = ch; continue }
    if (ch == '/' && src[i + 1] == '/') {
      const nl = src.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (ch == '{') depth++
    else if (ch == '}') {
      depth--
      if (depth == 0) return src.slice(start, i + 1)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 一、自动暂停仍走渐出链（service 的延迟暂停 → player.pause → utils.setPause → 渐出斜坡）
// ---------------------------------------------------------------------------
const autoPauseChainInvariants = (deps) => {
  const reasons = []
  const service = stripComments(deps.service)
  const player = stripComments(deps.player)
  const utils = stripComments(deps.utils)

  const delayBody = bracedBody(service, 'const scheduleInterruptionPause = () => {')
  if (delayBody == null) {
    reasons.push('service.ts 里找不到 scheduleInterruptionPause（独占口径的「推迟暂停」入口）')
  } else if (!delayBody.includes('void pause()')) {
    reasons.push('自动暂停不再走 core/player 的 pause()：绕开 utils.setPause 就等于绕开渐出收口'
      + '（自动暂停重新变成硬切，用户这轮要的「自动暂停渐出」当场没了）')
  }
  const pauseBody = bracedBody(player, 'export const pause = async() => {')
  if (pauseBody == null) {
    reasons.push('core/player/player.ts 里找不到 pause（自动暂停的 JS 入口）')
  } else if (!pauseBody.includes('await setPause()')) {
    reasons.push('player.pause 没有走 utils.setPause：自动暂停的渐出收口被绕过')
  }
  const setPauseBody = slice(utils, 'export const setPause = async() => {', 'export const setCurrentTime')
  if (setPauseBody == null) {
    reasons.push('utils.ts 里找不到 setPause')
  } else if (!setPauseBody.includes('await fadeOutThenPause(pausePlayingEngines)')) {
    reasons.push('utils.setPause 没有把真正的暂停包进 fadeOutThenPause（iOS 主路径）：'
      + '自动暂停 / 手动暂停都失去渐出（第 39/41/47 轮的口径被回退）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 二、自动续播的渐入（volumeFade.ts 两处 + service.ts 独占 Ended 一处）
// ---------------------------------------------------------------------------
const autoResumeFadeInvariants = (deps) => {
  const reasons = []
  const fade = stripComments(deps.fade)
  const service = stripComments(deps.service)

  // ① 未预约的 'playing' 也要走斜坡
  const applyBody = bracedBody(fade, 'export const applyVolumeOnPlayStart = async() => {')
  if (applyBody == null) {
    reasons.push('volumeFade.ts 里找不到 applyVolumeOnPlayStart')
  } else {
    if (countOf(applyBody, 'await rampVolume(target, FADE_IN_MS)') !== 2) {
      reasons.push('applyVolumeOnPlayStart 的**未预约**支没有走渐入斜坡（两处 rampVolume 应当'
        + '一处是预约支、一处是未预约支）：系统打断结束时原生先重启引擎并重发 \'playing\'，'
        + 'JS 的预约（setPlay）跟它是两条互不等待的路径 —— 未预约支直写目标音量 = 自动续播'
        + '从静音一记跳到满音量，正是用户这轮报的「自动播放很快，声音突然很大」'
        + '（第 56 轮·追加第 1 条）')
    }
    if (!applyBody.includes('await writeVolume(target)')) {
      reasons.push('applyVolumeOnPlayStart 的 Android 直通支被一并改掉了：那边没有 controller.ts'
        + ' 的 \'playing\' 兜底，非 iOS 平台必须保持「直接写目标音量」的旧行为')
    }
    const iosRampAt = applyBody.indexOf("if (Platform.OS == 'ios') {")
    const androidWriteAt = applyBody.indexOf('await writeVolume(target)')
    if (iosRampAt < 0 || androidWriteAt < 0 || iosRampAt > androidWriteAt) {
      reasons.push('非 iOS 平台被挡在渐入斜坡之前（或分支次序倒了）：Android 会走进 iOS 的斜坡分支')
    }
  }

  // ② 预约不许掐在途的渐入
  const armBody = bracedBody(fade, 'const armFadeIn = (timeoutMs: number): boolean => {')
  if (armBody == null) {
    reasons.push('volumeFade.ts 里找不到 armFadeIn（渐入预约的统一体）')
  } else {
    const guardAt = armBody.indexOf('if (fadeTimer == null) {')
    if (guardAt < 0) {
      reasons.push('armFadeIn 的非渐出支又变成无条件压 0（缺 `if (fadeTimer == null) {` 守卫）：'
        + '打断恢复自己已经渐入到一半时，这里把音量拍回 0，而下一声 \'playing\' 未必再来 —— '
        + '音量要等预约的兜底期限（1.5s）才一记跳回设定值，比不预约还糟（第 56 轮·追加第 2 条）')
    } else {
      if (!armBody.includes('silenceBothEngines()')) {
        reasons.push('armFadeIn 不再把两台引擎一起压 0（暂停态预约的常规现场失效）')
      } else if (guardAt > armBody.indexOf('silenceBothEngines()')) {
        reasons.push('armFadeIn 的压 0 / 掐斜坡跑在守卫之前：守卫等于没有')
      }
      if (guardAt > armBody.indexOf('stopRamp()')) {
        reasons.push('armFadeIn 的 stopRamp() 跑在守卫之前：在途的渐入斜坡还是会被掐掉')
      }
    }
  }

  // ③ 独占 Ended 分支先立预约（且不许挪进忽略窗口的早退里）
  const armCall = 'if (!playerState.isPlay) armVolumeFadeIn()'
  if (!service.includes(armCall)) {
    reasons.push('独占分支（取消勾选口径）的打断结束没有先立渐入预约：'
      + 'restoreConfiguredVolume() 会把账本 / 引擎一步顶回设定值（渐入的起点不再是 0），'
      + '自动续播的「由小变大」整条落空（第 56 轮·追加第 3 条）')
  } else {
    // 注意锚点必须带 6 格缩进：`if (interruptionPauseTimer != null) {` 在 clearInterruptionPauseTimer
    // 的定义里还有一份（2 格缩进），裸串会切到定义那段去（切片跑飞 = 假失败）
    const ignoreRegion = slice(service,
      '      if (interruptionPauseTimer != null) {', '        return scheduleAutoResume()')
    if (ignoreRegion == null) {
      reasons.push('独占分支的忽略窗口早退不见了（interruptionPauseTimer 判定到它的 '
        + 'scheduleAutoResume 收尾这一段）：电源键 / 系统提示音这类短暂系统音会重新落进'
        + '「先暂停再恢复」的老路（第 31 轮口径回归）；渐入预约也绝不允许补在那里（静音洞）')
    } else if (ignoreRegion.includes('armVolumeFadeIn()')) {
      reasons.push('渐入预约被挪进了忽略窗口的早退里：那条路音频根本没被停过（电源键 / 系统'
        + '提示音），压 0 会留一个要到兜底期限才跳回去的静音洞 —— 每声提示音切一次歌')
    }
    const endedRegion = slice(service,
      'if (permanent && wasLongInterruption) return cancelResumePending()', 'scheduleAutoResume()')
    if (endedRegion == null) {
      reasons.push('独占 Ended 分支的形状变了（找不到「长中断分流 → scheduleAutoResume」这一段）')
    } else {
      const armAt = endedRegion.indexOf(armCall)
      const restoreAt = endedRegion.indexOf('restoreConfiguredVolume()')
      if (armAt < 0) {
        reasons.push('独占 Ended 分支里的渐入预约不在长中断分流之后（或不在这一支里）')
      } else if (restoreAt < 0 || armAt > restoreAt) {
        reasons.push('渐入预约没有排在 restoreConfiguredVolume() 之前：那一步直写设定音量'
          + '会先把账本 / 引擎顶回去，之后的斜坡起点已不是 0（渐入白预约）')
      }
    }
    if (countOf(service, 'armVolumeFadeIn()') !== 1) {
      reasons.push('service.ts 里的 armVolumeFadeIn() 调用不是恰一处：多出来的那一处'
        + '会在音频根本没停过的路径上压 0（静音洞）')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 反例（对篡改后的源码跑同一套判断，必须被拦下）
// ---------------------------------------------------------------------------
const tamperFade = (find, replace) => {
  const src = stripComments(REAL.fade)
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find.slice(0, 60)}`)
  return src.replace(find, replace)
}
const tamperService = (find, replace) => {
  const src = stripComments(REAL.service)
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find.slice(0, 60)}`)
  return src.replace(find, replace)
}

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

  // r1 未预约的 'playing' 退回直写（自动续播从静音一记跳到满音量）
  check('r1 未预约的 playing 退回直写目标音量', () => autoResumeFadeInvariants({
    ...REAL,
    fade: tamperFade(
      "    if (Platform.OS == 'ios') {\n      await rampVolume(target, FADE_IN_MS)\n      return\n    }\n    await writeVolume(target)",
      '    await writeVolume(target)'),
  }),
  '未预约')

  // r2 预约又去掐在途的渐入（守卫被拆）
  check('r2 armFadeIn 的 fadeTimer != null 守卫被拆', () => autoResumeFadeInvariants({
    ...REAL,
    fade: tamperFade(
      '  if (fadeTimer == null) {\n    stopRamp()\n    silenceBothEngines()\n  }',
      '  stopRamp()\n  silenceBothEngines()'),
  }),
  '无条件压 0')

  // r3 独占 Ended 的预约被删（restoreConfiguredVolume 先把账本顶回设定值）
  check('r3 独占 Ended 的渐入预约被删', () => autoResumeFadeInvariants({
    ...REAL,
    service: tamperService('      if (!playerState.isPlay) armVolumeFadeIn()\n', ''),
  }),
  '没有先立渐入预约')

  // r4 忽略窗口的早退里被「补」上一份预约（每声系统提示音切一次歌 = 静音洞）。
  //    注意这里是**复制**而不是搬迁：搬迁会先把 ③ 的「没有先立渐入预约」撞出来，
  //    拦下的就不是静音洞这条口径了（第 56 轮·追加，r4 第一次写错踩过）。
  check('r4 忽略窗口早退里多出一份预约', () => {
    const src = stripComments(REAL.service)
    const intoIgnore = '        clearInterruptionPauseTimer()\n        interruptedAt = 0\n        return scheduleAutoResume()'
    if (!src.includes(intoIgnore)) throw new Error('r4 锚点未命中')
    return autoResumeFadeInvariants({
      ...REAL,
      service: src.replace(intoIgnore, '        armVolumeFadeIn()\n' + intoIgnore),
    })
  },
  '静音洞')

  // r5 自动暂停绕开渐出收口（setPause 直接掐引擎，不再先渐出）
  check('r5 暂停不再先走 fadeOutThenPause', () => autoPauseChainInvariants({
    ...REAL,
    utils: stripComments(REAL.utils).replace(
      '  await fadeOutThenPause(pausePlayingEngines)',
      '  await pausePlayingEngines()'),
  }),
  'fadeOutThenPause')

  // r5b 自动暂停不再走 core/player 的 pause()（绕开渐出链的入口）。
  //    setTimeout 回调体是 **4 格**缩进（外层还有一层箭头函数），锚点写 8 格会未命中；
  //    带上前一行是因为 `if (global.lx.isPlayedStop) return` 在 resume 的 attempt() 里
  //    还有一份（那边续的是 cancelResumePending()，两行连起来才唯一）。
  check('r5b 自动暂停不再走 pause()', () => autoPauseChainInvariants({
    ...REAL,
    service: tamperService(
      '    if (global.lx.isPlayedStop) return\n    void pause()',
      '    if (global.lx.isPlayedStop) return'),
  }),
  '绕开 utils.setPause')

  // r6 忽略窗口的早退被拆（短暂系统音照样进暂停链 —— 第 31 轮口径回归，
  //    且预约若补进这一支就是一个静音洞）
  check('r6 忽略窗口早退被拆', () => autoResumeFadeInvariants({
    ...REAL,
    service: tamperService(
      '      if (interruptionPauseTimer != null) {\n        clearInterruptionPauseTimer()',
      '      if (false) {\n        clearInterruptionPauseTimer()'),
  }),
  '忽略窗口早退不见了')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-auto-resume-fade ===')
console.log('取消勾选「与其他应用同时播放」：自动暂停走渐出收口 + 自动续播由小变大（第 56 轮·追加）')
console.log()

const checks = [
  ['自动暂停的渐出链（service.scheduleInterruptionPause → player.pause → utils.setPause → fadeOutThenPause）', () => autoPauseChainInvariants(REAL)],
  ['自动续播的渐入（未预约支走斜坡 + 预约不掐在途渐入 + 独占 Ended 先立预约）', () => autoResumeFadeInvariants(REAL)],
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
