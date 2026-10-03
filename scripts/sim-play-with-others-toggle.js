#!/usr/bin/env node
/**
 * sim-play-with-others-toggle.js —— 播放设置「与其他应用同时播放」改名 / 勾选极性 / 无感切换契约
 * （用户第 23 轮改名，第 24 轮按实机反馈改口径）。
 *
 * 需求原话（2026-10-03 第 23 轮）：
 *   「播放设置中，其他应用播放声音时，自动暂停播放改为与其他应用同时播放。功能是：
 *     关闭「与其他应用同时播放」时，车机蓝牙下高德一播报音乐就停、播报结束也不恢复；
 *     不外接蓝牙时只 duck（音量压小）故正常。」
 *
 * 实机反馈（2026-10-03 第 24 轮）：
 *   「勾选后，播放的声音就消失了，但是歌曲还在继续播放，暂停重新播放后就有声音了，
 *     改为无感勾选或取消，播放声音不会消失……而且勾选后，锁屏界面和灵动岛播放界面
 *     消失了，取消就有了，我需要始终显示」
 *
 * 语义与极性（改名必须伴随勾选翻转，否则设置名撒谎）：
 *   存储键 player.isHandleAudioFocus 的语义**不变**：true = 独占处理（其他应用出声
 *   时我们自动暂停）。新名字「与其他应用同时播放」= 不独占 = false：
 *     勾选   = playWithOthers = !isHandleAudioFocus
 *     不勾选 = 独占（第 21 轮修的「高德播报即停、结束不恢复」场景）
 *   老用户偏好映射无缝：旧「勾选（自动暂停）」= 新「不勾选」，真实行为不变。
 *
 * 会话口径（第 24 轮修正，也是本脚本改名后的核心不变量）：
 *   音频会话**始终**非混音（iosCategoryOptions: []）。mixWithOthers 是死路：
 *   ① mixable 会话失去 Now Playing 主会话资格 ⇒ 锁屏 / 灵动岛播放卡片消失
 *      （用户实锤「勾选后卡片消失、取消就有了」）；
 *   ② 与原生流式引擎的 LongFormAudio 路由策略互斥 ⇒ setCategory 报 -50，
 *      会话被停用后表现为「歌曲在走、没有声音」（用户实锤「声音消失、进度还在走」）。
 *   「不因其它音频暂停自己」因此落在**策略层**（service.ts 混音分支 + 原生
 *   LXPlayWithOthersEnabled，见 scripts/sim-audio-interruption-mix.js），
 *   切换到该模式**不重建播放器**（旧 reloadConfig() 就是「勾选即失声」的触发器）。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：极性写反、会话回潮完全合法，只在真机上表现为
 * 「勾选后卡片消失 / 没声音」或「关掉同时播放后车机行为反过来」）。
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
  service: 'src/plugins/player/service.ts',
  native: 'ios/LxMusicMobile/AppDelegate.mm',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// ---------------------------------------------------------------------------
// 不变量 A：设置项 —— 勾选极性翻转 + 存储语义不变 + 切换无感（不重建播放器）
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
  if (!/await syncPlayWithOthersEnabled\(\)\.catch\(\(\) => \{\}\)/.test(code)) {
    reasons.push('切换后未把策略标记下发给原生（syncPlayWithOthersEnabled）')
  }
  if (/\breloadConfig\b/.test(code)) {
    reasons.push('切换仍重建播放器（reloadConfig）：会话激活态重设分类 ⇒ 勾选即失声 / 锁屏与灵动岛卡片消失（第 24 轮实锤，必须改为无感）')
  }
  if (!code.includes("toast(t('setting_play_handle_audio_focus_tip'))")) {
    reasons.push('未保留生效提示 toast')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：文案（zh-cn.json）—— 名称 + tip 必须是「立即生效」口径
// ---------------------------------------------------------------------------

const langInvariants = (rawJson) => {
  const reasons = []
  const lang = JSON.parse(rawJson)
  if (lang['setting_play_handle_audio_focus'] !== '与其他应用同时播放') {
    reasons.push(`设置项文案不是「与其他应用同时播放」（现为「${lang['setting_play_handle_audio_focus']}」）`)
  }
  const tip = lang['setting_play_handle_audio_focus_tip'] || ''
  if (tip.includes('重启应用')) {
    reasons.push(`tip 仍说「重启应用后生效」（现为「${tip}」）：第 24 轮起切换即时生效，不需要重启`)
  }
  if (!tip.includes('立即生效')) {
    reasons.push(`tip 未说明「立即生效」（现为「${tip}」）`)
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：会话分类不再随设置抖动 + 源码里不许再有 mixWithOthers
//   （dependencies-patch.js 的 RNTP 构建期补丁故意容忍 mixWithOthers，不在扫描范围）
// ---------------------------------------------------------------------------

const sessionInvariants = (srcs) => {
  const reasons = []
  const plugin = stripComments(srcs.plugin)

  if (!plugin.includes('handleAudioFocus: isHandleAudioFocus')) {
    reasons.push('播放器未把 player.isHandleAudioFocus 传给 handleAudioFocus')
  }
  if (!plugin.includes('iosCategoryOptions: [],')) {
    reasons.push('iosCategoryOptions 不是常量空数组（会话分类又随设置抖动：勾选会换分类 ⇒ 卡片消失 / 无声）')
  }

  for (const [name, raw] of Object.entries(srcs)) {
    if (name == 'lang') continue
    const code = stripComments(raw)
    if (code.includes('mixWithOthers')) {
      reasons.push(`${name} 的代码里出现 mixWithOthers（第 24 轮已定案：混音会话与「卡片始终显示」/ 原生 LongFormAudio 互斥，不许回潮）`)
    }
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

  const session = (over) => sessionInvariants({ ...REAL, ...over })

  // c1 文案退回旧写法
  check('c1 文案退回「自动暂停」', () => langInvariants(tamper(REAL.lang,
    '"setting_play_handle_audio_focus": "与其他应用同时播放"',
    '"setting_play_handle_audio_focus": "其他应用播放声音时，自动暂停播放"')),
  '不是「与其他应用同时播放」')

  // c2 tip 退回「重启应用后生效」
  check('c2 tip 退回重启口径', () => langInvariants(tamper(REAL.lang,
    '"setting_play_handle_audio_focus_tip": "立即生效，无需重启"',
    '"setting_play_handle_audio_focus_tip": "重启应用后生效"')),
  '重启')

  // c3 极性退回（check 直读 isHandleAudioFocus）
  check('c3 勾选极性退回独占', () => uiInvariants(tamper(REAL.ui,
    'check={playWithOthers}',
    'check={isHandleAudioFocus}')),
  'check 未接翻转后的 playWithOthers')

  // c4 setter 忘记翻回存储语义
  check('c4 setter 未翻回存储语义', () => uiInvariants(tamper(REAL.ui,
    "'player.isHandleAudioFocus': !playWithOthers",
    "'player.isHandleAudioFocus': playWithOthers")),
  'setter 未把「同时播放」翻回存储语义')

  // c5 切换又回去重建播放器（勾选即失声 / 卡片消失的触发器）
  check('c5 切换重回 reloadConfig', () => uiInvariants(tamper(REAL.ui,
    'await syncPlayWithOthersEnabled().catch(() => {})',
    'await reloadConfig().catch(() => {})')),
  '切换仍重建播放器')

  // c6 会话分类回潮 mixWithOthers
  check('c6 会话分类回潮 mixWithOthers', () => session({ plugin: tamper(REAL.plugin,
    'iosCategoryOptions: [],',
    "iosCategoryOptions: ['mixWithOthers'],") }),
  'mixWithOthers')

  // c7 悄悄把 mixWithOthers 塞回业务源码（不是注释里，是真代码）
  check('c7 业务源码塞回 mixWithOthers', () => session({ service: tamper(REAL.service,
    "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] === false",
    "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] === false\nconst LXLegacyMixOptions = ['mixWithOthers']") }),
  'mixWithOthers')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-play-with-others-toggle ===')
console.log('「与其他应用同时播放」= 改名 + 极性翻转 + 存储语义不变 + 切换无感（不重建播放器）+ 会话不许混音（第 23/24 轮）')
console.log()

const checks = [
  ['设置项（playWithOthers / check / setter 翻回存储语义 / 无感下发 syncPlayWithOthersEnabled / 无 reloadConfig / toast）', () => uiInvariants(REAL.ui)],
  ['文案（zh-cn.json：名称「与其他应用同时播放」+ tip「立即生效」）', () => langInvariants(REAL.lang)],
  ['会话（iosCategoryOptions 常量空数组 + 5 个源码文件剥离注释后无 mixWithOthers）', () => sessionInvariants(REAL)],
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
