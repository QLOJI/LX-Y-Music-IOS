#!/usr/bin/env node
/**
 * sim-play-with-others-toggle.js —— 播放设置「与其他应用同时播放」改名与勾选极性契约
 * （用户第 23 轮）。
 *
 * 需求原话（2026-10-03）：
 *   「播放设置中，其他应用播放声音时，自动暂停播放改为与其他应用同时播放。功能是：
 *     关闭「与其他应用同时播放」时，车机蓝牙下高德一播报音乐就停、播报结束也不恢复；
 *     不外接蓝牙时只 duck（音量压小）故正常。」
 *
 * 语义与极性（改名必须伴随勾选翻转，否则设置名撒谎）：
 *   存储键 player.isHandleAudioFocus 的语义**不变**：true = 独占处理（其他应用出声
 *   时我们自动暂停）。新名字「与其他应用同时播放」= 不独占 = false：
 *     勾选   = playWithOthers = !isHandleAudioFocus
 *     不勾选 = 独占（第 21 轮修的「高德播报即停、结束不恢复」场景）
 *   老用户偏好映射无缝：旧「勾选（自动暂停）」= 新「不勾选」，真实行为不变。
 *
 * 插件链一致性（plugins/player/index.ts）：handleAudioFocus: isHandleAudioFocus；
 * iosCategoryOptions: isHandleAudioFocus ? [] : ['mixWithOthers'] —— 勾选（同时播放）
 * ⇒ isHandleAudioFocus=false ⇒ mixWithOthers，与文案自洽。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：极性写反完全合法，只在真机上表现为
 * 「关掉同时播放后车机行为反过来」）。
 * 运行：node scripts/sim-play-with-others-toggle.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  ui: 'src/screens/Home/Views/Setting/settings/Player/IsHandleAudioFocus.tsx',
  lang: 'src/lang/zh-cn.json',
  plugin: 'src/plugins/player/index.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// ---------------------------------------------------------------------------
// 不变量 A：设置项 —— 勾选极性翻转 + 存储语义不变 + 生效链路保留
// ---------------------------------------------------------------------------

const uiInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!code.includes('const playWithOthers = !isHandleAudioFocus')) {
    reasons.push('勾选语义未翻转为「与其他应用同时播放 = !isHandleAudioFocus」（勾选仍是独占=自动暂停，设置名撒谎）')
  }
  if (!code.includes('check={playWithOthers}')) {
    reasons.push('CheckBox 的 check 未接翻转后的 playWithOthers')
  }
  if (!code.includes('onChange={setPlayWithOthers}')) {
    reasons.push('onChange 未接翻转后的 setter')
  }
  if (!code.includes("updateSetting({ 'player.isHandleAudioFocus': !playWithOthers })")) {
    reasons.push('setter 未把「同时播放」翻回存储语义（!playWithOthers；存储键语义不可变）')
  }
  if (!/await reloadConfig\(\)\.catch\(\(\) => \{\}\)/.test(code)) {
    reasons.push('切换后未 reloadConfig（mixWithOthers 会话分类不会立即生效）')
  }
  if (!code.includes("toast(t('setting_play_handle_audio_focus_tip'))")) {
    reasons.push('未保留「重启应用后生效」提示 toast')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：文案（zh-cn.json）
// ---------------------------------------------------------------------------

const langInvariants = (rawJson) => {
  const reasons = []
  const lang = JSON.parse(rawJson)
  if (lang['setting_play_handle_audio_focus'] !== '与其他应用同时播放') {
    reasons.push(`设置项文案不是「与其他应用同时播放」（现为「${lang['setting_play_handle_audio_focus']}」）`)
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：插件链一致（勾选=同时播放 ⇒ mixWithOthers）
// ---------------------------------------------------------------------------

const pluginInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)
  if (!code.includes('handleAudioFocus: isHandleAudioFocus')) {
    reasons.push('播放器未把 player.isHandleAudioFocus 传给 handleAudioFocus')
  }
  if (!code.includes("iosCategoryOptions: isHandleAudioFocus ? [] : ['mixWithOthers']")) {
    reasons.push("iOS 会话分类与「同时播放」语义脱钩（勾选=同时播放 ⇒ isHandleAudioFocus=false ⇒ ['mixWithOthers']）")
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

  // c1 文案退回旧写法
  check('c1 文案退回「自动暂停」', () => langInvariants(tamper(REAL.lang,
    '"setting_play_handle_audio_focus": "与其他应用同时播放"',
    '"setting_play_handle_audio_focus": "其他应用播放声音时，自动暂停播放"')),
  '不是「与其他应用同时播放」')

  // c2 极性退回（check 直读 isHandleAudioFocus）
  check('c2 勾选极性退回独占', () => uiInvariants(tamper(REAL.ui,
    'check={playWithOthers}',
    'check={isHandleAudioFocus}')),
  'check 未接翻转后的 playWithOthers')

  // c3 setter 忘记翻回存储语义
  check('c3 setter 未翻回存储语义', () => uiInvariants(tamper(REAL.ui,
    "'player.isHandleAudioFocus': !playWithOthers",
    "'player.isHandleAudioFocus': playWithOthers")),
  'setter 未把「同时播放」翻回存储语义')

  // c4 插件链把 mixWithOthers 反过来
  check('c4 插件链 mixWithOthers 反接', () => pluginInvariants(tamper(REAL.plugin,
    "iosCategoryOptions: isHandleAudioFocus ? [] : ['mixWithOthers']",
    "iosCategoryOptions: isHandleAudioFocus ? ['mixWithOthers'] : []")),
  '脱钩')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-play-with-others-toggle ===')
console.log('「与其他应用同时播放」= 改文案 + 勾选极性翻转 + 存储语义不变（第 23 轮）')
console.log()

const checks = [
  ['设置项（playWithOthers = !isHandleAudioFocus / check / setter 翻回存储语义 / 生效链路）', () => uiInvariants(REAL.ui)],
  ['文案（zh-cn.json：「与其他应用同时播放」）', () => langInvariants(REAL.lang)],
  ['插件链（handleAudioFocus 透传 + 勾选 ⇒ mixWithOthers）', () => pluginInvariants(REAL.plugin)],
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
