#!/usr/bin/env node
/**
 * sim-buffer-threshold-10s.js —— 「快速启动 + 后台缓冲」10 秒门槛契约（第 33 轮第 5 条）
 *
 * 需求原话（2026-10-08 第 33 轮第 5 条）：
 *   「播放音乐时，会出现音频播放卡顿的情况，请预留一定的缓存时间，再播放音乐，不然就显示
 *     缓存中，采用 "快速启动 + 后台缓冲" 的策略，设定缓存歌曲时间为10秒，加载歌曲10秒缓存后
 *     再播放歌曲，正常情况10秒累加，可以提前全部缓存，如果网络差，歌曲把这个累加10秒缓存
 *     加载完了，立即显示为缓存中，缓存下一个10秒，如果勾选启用音频预加载，将在音频播放
 *     最后10秒开始缓存下一首歌10秒，确保下一首歌不卡顿，下首歌开始播放时显示歌曲加载中，
 *     如果加载完了就开始播放」
 *
 * 口径（逐句落到代码位置，不是概括）：
 *   ① 「设定缓存歌曲时间为 10 秒，加载 10 秒缓存后再播放」→ 起播门槛 10 秒：
 *      无损档 = 原生流式引擎的 _startThresholdSeconds = 10.0（AppDelegate.mm，起播与
 *      「缓冲耗尽后重填」两处都装这个长门槛）；非无损档 = RNTP setupPlayer 的 minBuffer: 10
 *      （AVPlayer 路径，配合 waitForBuffer 缓冲不足时等待而非中断）。
 *   ② 「正常情况 10 秒累加，可以提前全部缓存」→ 攒满 10 秒即出声；若整首（流结束）先到，
 *      不等剩余秒数直接起播（流结束分支）。环形缓冲容量必须 ≥ 门槛 + 2 秒余量（12 秒），
 *      否则攒满门槛之前就撞上容量上限、永远起播不了。
 *   ③ 「网络差……累加 10 秒缓存加载完了，立即显示为缓存中，缓存下一个 10 秒」→ 缓冲耗尽时
 *      原生发 buffering（scheduleBufferingStateForGeneration，重填按 10 秒门槛），
 *      JS 把 buffering 文案统一成「缓存中...」（player__caching）。
 *   ④ 「勾选启用音频预加载，将在音频播放最后 10 秒开始缓存下一首歌」→ core/player/preload.ts
 *      的时间闸（maxPlayTime - nowPlayTime < 10）+ 设置开关 player.isEnableAudioPreload；
 *      统一触发点 core/init/player/preloadNextMusic.ts（duration - nowPlayTime < 10）。
 *   ⑤ 「下首歌开始播放时显示歌曲加载中」→ loading 态文案 player__loading（「歌曲加载中...」），
 *      与 ③ 的「缓存中...」是两个不同时刻的文案，不许合并成一个。
 *   ⑥ 短门槛豁免：手动恢复 / 拖动进度 / 打断结束自动续播走 _resumeThresholdSeconds = 1.5
 *      —— 「点一下继续播」不该被 10 秒门槛拖住；这三处必须装短门槛并清掉装表时刻。
 *   ⑦ 弱网降档：长门槛装上 20 秒还攒不满（queuedSeconds 只有短门槛的量）时降档到短门槛，
 *      避免弱网下永远停在「缓存中」。
 *
 * 为什么必须靠契约脚本：门槛是纯数值 + 调用点位置（装长/装短各几处、短门槛不能被长门槛
 * 覆盖），tsc/eslint 全无感；写反了只在真机上表现为「起播慢 10 秒 / 点继续播卡 10 秒 /
 * 缓存中永远转圈」。带反例自检（b1–b8）。
 *
 * 运行：node scripts/sim-buffer-threshold-10s.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const countOf = (src, needle) => src.split(needle).length - 1
const countRe = (src, re) => (src.match(re) ?? []).length

const F = {
  native: 'ios/LxMusicMobile/AppDelegate.mm',
  plugin: 'src/plugins/player/index.ts',
  controller: 'src/plugins/player/controller.ts',
  lang: 'src/lang/zh-cn.json',
  preload: 'src/core/player/preload.ts',
  preloadNext: 'src/core/init/player/preloadNextMusic.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

const START_THRESHOLD = 10.0
const RESUME_THRESHOLD = 1.5

// ---------------------------------------------------------------------------
// 不变量 A：原生流式引擎（无损档）—— 10 秒长门槛 / 1.5 秒短门槛 / 容量与降档
// ---------------------------------------------------------------------------

const nativeInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ① 门槛数值
  if (!code.includes(`_startThresholdSeconds = ${START_THRESHOLD.toFixed(1)};`)) {
    reasons.push(`原生起播门槛不是 ${START_THRESHOLD} 秒（用户原话「设定缓存歌曲时间为10秒，加载歌曲10秒缓存后再播放歌曲」）`)
  }
  if (!code.includes(`_resumeThresholdSeconds = ${RESUME_THRESHOLD.toFixed(1)};`)) {
    reasons.push(`原生短门槛不是 ${RESUME_THRESHOLD} 秒（手动恢复 / 拖动进度 / 打断结束续播走它，不该被 10 秒拖住）`)
  }
  if (!code.includes('_startThresholdSeconds = 10.0;') || !code.includes('_maxBufferSeconds = 10.0;')) {
    reasons.push('_startThresholdSeconds 与 _maxBufferSeconds 不再同为 10.0（解码前瞻水位必须能填满门槛，两边脱钩就攒不满）')
  }
  if (!code.includes('double startThresholdArmedAt;')) {
    reasons.push('缺 startThresholdArmedAt（长门槛的装上时刻：弱网降档依赖它）')
  }

  // ② 装长门槛 = 起播 + 缓冲耗尽后重填：两处，且都要记时刻
  const longArm = /self\.startThresholdSeconds = self\.maxBufferSeconds;\s*\n\s*self\.startThresholdArmedAt = CACurrentMediaTime\(\);/g
  if (countRe(code, longArm) !== 2) {
    reasons.push(`装 10 秒长门槛的地方是 ${countRe(code, longArm)} 处（应恰好 2：新流起播 + 缓冲耗尽后重填 —— 少任一处就有一类起播不攒缓存直接出声）`)
  }

  // ③ 装短门槛 = 手动恢复 / 拖动进度 / 打断结束自动续播：三处，且都要清掉装表时刻
  const shortArm = /self\.startThresholdSeconds = self\.resumeThresholdSeconds;\s*\n\s*self\.startThresholdArmedAt = 0;/g
  if (countRe(code, shortArm) !== 3) {
    reasons.push(`装 ${RESUME_THRESHOLD} 秒短门槛的地方是 ${countRe(code, shortArm)} 处（应恰好 3：手动恢复 / 拖动进度 / 打断结束自动续播）`)
  }

  // ④ 环形缓冲容量必须装得下门槛 + 2 秒余量
  if (!code.includes('MAX(self.maxBufferSeconds + 2.0, 12.0)')) {
    reasons.push('环形缓冲容量不再是 MAX(maxBufferSeconds + 2.0, 12.0)（10 秒门槛 + 2 秒解码余量 = 12 秒；改小 ⇒ 攒满门槛前撞上容量上限，永远起播不了）')
  }

  // ⑤ 弱网降档：长门槛装上 20 秒仍攒不满 ⇒ 降档到短门槛，别让「缓存中」永远转圈
  if (!code.includes('(CACurrentMediaTime() - self.startThresholdArmedAt) > 20.0')) {
    reasons.push('缺弱网降档（长门槛装上 20 秒仍攒不满时降档到短门槛）：弱网下会永远停在「缓存中」')
  }
  if (!code.includes('startThreshold = self.resumeThresholdSeconds;')) {
    reasons.push('弱网降档没有落成「startThreshold = resumeThresholdSeconds」')
  }

  // ⑥ 缓冲耗尽要能被观察到（JS 才有机会显示「缓存中」）
  if (!/scheduleBufferingStateForGeneration/.test(code)) {
    reasons.push('缺 scheduleBufferingStateForGeneration（缓冲态不上报 ⇒ JS 无从显示「缓存中」）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：JS 侧 —— 非无损档 minBuffer / 两档文案 / 预加载窗口与开关
// ---------------------------------------------------------------------------

const jsInvariants = (srcs) => {
  const reasons = []

  // ① RNTP / AVPlayer 路径：minBuffer 10 秒 + 缓冲不足时等待而非中断
  const plugin = stripComments(srcs.plugin)
  if (!plugin.includes('minBuffer: 10,')) {
    reasons.push('RNTP 路径的 minBuffer 不是 10（非无损档没有 10 秒起播缓冲：AVPlayer 起播即出声，弱网就卡）')
  }
  if (!plugin.includes('waitForBuffer: true,')) {
    reasons.push('RNTP 路径不再 waitForBuffer（缓冲不足时中断播放而不是等待 ⇒ 用户报的卡顿回潮）')
  }

  // ② 两档文案：缓冲中 = 「缓存中...」、起播加载 = 「歌曲加载中...」，不许合并
  const lang = JSON.parse(srcs.lang)
  if (lang['player__caching'] !== '缓存中...') {
    reasons.push(`player__caching 文案不是「缓存中...」（现为「${lang['player__caching']}」）`)
  }
  if (lang['player__loading'] !== '歌曲加载中...') {
    reasons.push(`player__loading 文案不是「歌曲加载中...」（现为「${lang['player__loading']}」）`)
  }
  const controller = stripComments(srcs.controller)
  const bufferingAt = controller.indexOf("case 'buffering':")
  if (bufferingAt < 0) {
    reasons.push('controller 找不到 buffering 分支（缓冲耗尽不会显示「缓存中」）')
  } else {
    const branch = controller.slice(bufferingAt, controller.indexOf("case 'playing':", bufferingAt))
    if (!branch.includes("setStatusText(global.i18n.t('player__caching'))")) {
      reasons.push('buffering 分支没把状态文案设成 player__caching（用户原话「立即显示为缓存中」）')
    }
  }
  const loadingAt = controller.indexOf("case 'loading':")
  if (loadingAt < 0 || !controller.slice(loadingAt, loadingAt + 400).includes("setStatusText(global.i18n.t('player__loading'))")) {
    reasons.push('loading 分支没把状态文案设成 player__loading（用户原话「下首歌开始播放时显示歌曲加载中」）')
  }

  // ③ 预加载：设置开关 + 最后 10 秒窗口（两个入口都要有闸）
  const preload = stripComments(srcs.preload)
  if (!preload.includes("settingState.setting['player.isEnableAudioPreload']")) {
    reasons.push('preload.ts 不看「启用音频预加载」设置（用户原话「如果勾选启用音频预加载」）')
  }
  if (!preload.includes('maxPlayTime > 10 && maxPlayTime - nowPlayTime < 10')) {
    reasons.push('preload.ts 的最后 10 秒时间闸被改（提前取歌会抢当前曲目带宽，反而更卡）')
  }
  const next = stripComments(srcs.preloadNext)
  if (!next.includes('duration > 10 && duration - progress.nowPlayTime < 10')) {
    reasons.push('preloadNextMusic.ts 的统一触发点不再是「最后 10 秒」（用户原话「在音频播放最后10秒开始缓存下一首歌10秒」）')
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

  // b1 起播门槛退回老口径（1 秒）
  check('b1 起播门槛退回 1 秒', () => nativeInvariants(tamper(REAL.native,
    '    _startThresholdSeconds = 10.0;',
    '    _startThresholdSeconds = 1.0;')),
  '起播门槛不是 10')

  // b2 少一处装长门槛（某一类起播不攒缓存）
  check('b2 少一处装长门槛', () => nativeInvariants(tamper(REAL.native,
    '    self.startThresholdSeconds = self.maxBufferSeconds;\n    self.startThresholdArmedAt = CACurrentMediaTime();',
    '    self.startThresholdArmedAt = CACurrentMediaTime();')),
  '装 10 秒长门槛的地方是 1 处')

  // b3 环形缓冲容量没跟上门槛（攒满前撞上限）
  check('b3 环形缓冲容量没跟上', () => nativeInvariants(tamper(REAL.native,
    'MAX(self.maxBufferSeconds + 2.0, 12.0)',
    'MAX(self.maxBufferSeconds + 2.0, 6.0)')),
  '环形缓冲容量')

  // b4 短门槛三处被长门槛覆盖（「点继续播」卡 10 秒）
  check('b4 短门槛被长门槛覆盖', () => nativeInvariants(tamper(REAL.native,
    '        self.startThresholdSeconds = self.resumeThresholdSeconds;\n        self.startThresholdArmedAt = 0;',
    '        self.startThresholdSeconds = self.maxBufferSeconds;\n        self.startThresholdArmedAt = CACurrentMediaTime();')),
  '短门槛的地方是 2 处')

  // b5 弱网降档被删（弱网永远停在「缓存中」）
  check('b5 删掉弱网降档', () => nativeInvariants(tamper(REAL.native,
    '(CACurrentMediaTime() - self.startThresholdArmedAt) > 20.0',
    '(CACurrentMediaTime() - self.startThresholdArmedAt) > 900.0')),
  '弱网降档')

  // b6 非无损档 minBuffer 退回小值
  check('b6 minBuffer 退回小值', () => jsInvariants({ ...REAL,
    plugin: tamper(REAL.plugin, 'minBuffer: 10,', 'minBuffer: 1,') }),
  'minBuffer 不是 10')

  // b7 缓冲中不再显示「缓存中」
  check('b7 缓冲中不显示「缓存中」', () => jsInvariants({ ...REAL,
    controller: tamper(REAL.controller,
      "            setStatusText(global.i18n.t('player__caching'))",
      "            setStatusText('')") }),
  '缓存中')

  // b8 预加载窗口提前（回到「一进歌就抢带宽」）
  check('b8 预加载窗口提前', () => jsInvariants({ ...REAL,
    preloadNext: tamper(REAL.preloadNext,
      'duration > 10 && duration - progress.nowPlayTime < 10',
      'duration > 20 && duration - progress.nowPlayTime < 20') }),
  '最后 10 秒')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-buffer-threshold-10s ===')
console.log('「快速启动 + 后台缓冲」10 秒门槛：起播/重填攒满 10 秒 + 缓冲中显示「缓存中」+ 短门槛豁免 + 预加载最后 10 秒（第 33 轮第 5 条）')
console.log()

const checks = [
  ['原生引擎（10 秒长门槛 2 处 / 1.5 秒短门槛 3 处 / 12 秒容量 / 弱网降档 / 缓冲态上报）', () => nativeInvariants(REAL.native)],
  ['JS 侧（minBuffer 10 + waitForBuffer + 两档文案「缓存中...」/「歌曲加载中...」+ 预加载开关与最后 10 秒窗口）', () => jsInvariants(REAL)],
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
