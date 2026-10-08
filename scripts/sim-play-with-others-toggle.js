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
 * 会话口径（第 24 轮修正；**第 33 轮第 4 条修订**，也是本脚本改名后的核心不变量）：
 *   需求原话（2026-10-08 第 33 轮第 4 条）：
 *     「播放设置中，勾选“与其他应用同时播放”选项后，配置为未勾选时和现在一样，勾选后，
 *       退出灵动岛占用，强化不会暂停播放功能，不论后台什么音频在播，软件音频正常播放」
 *   第 24 轮的两条实锤在本轮各有归宿：
 *   ① mixable 会话失去 Now Playing 主会话资格 ⇒ 卡片 / 灵动岛占用消失：用户第 24 轮当
 *      bug（「我需要始终显示」），第 33 轮当**需求**（「退出灵动岛占用」）—— 于是勾选态
 *     允许混音，但**只在原生流式引擎（无损档）的 prepareAudioSession 里、由
 *      LXPlayWithOthersEnabled 守卫**，并且必须配 AVAudioSessionRouteSharingPolicyDefault；
 *   ② 混音 + LongFormAudio 路由策略互斥 ⇒ setCategory 报 -50（「歌曲在走、没有声音」）：
 *      本轮通过「混音分支不配 LongFormAudio」绕开，且失败要能退回非混音口径 —— 这条第
 *      24 轮的禁区别名（运行期改激活态会话分类）仍然有效：RNTP / AVPlayer 那条路径
 *      （非无损档）的 iosCategoryOptions 依旧是定死的常量空数组，不许随设置抖动。
 *   「不因其它音频暂停自己」在策略层继续成立（service.ts 混音分支 + 原生
 *   LXPlayWithOthersEnabled，见 scripts/sim-audio-interruption-mix.js），
 *   切换到该模式**不重建播放器**（旧 reloadConfig() 就是「勾选即失声」的触发器）。
 *   勾选态的「退出卡片占用」由 JS 侧 nowPlaying 抑制开关落地，验收在
 *   scripts/sim-play-with-others-card-exit.js。
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
const countOf = (src, needle) => src.split(needle).length - 1

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
//   【第 33 轮第 4 条】唯一放行的形态：原生流式引擎 prepareAudioSession 里由
//   LXPlayWithOthersEnabled 守卫、配 RouteSharingPolicyDefault 的那一处混音分类。
//   放行前先把这串**完整**选项名归一化掉，其余任何形态（RNTP 的 iosCategoryOptions、
//   业务代码里的混音开关、裸 mixWithOthers）依旧一律拦下 —— 不放宽任何旧口径。
// ---------------------------------------------------------------------------

/** 原生勾选态混音分类的自洽性：守卫 + 路由策略 + 唯一性 + 失败可退回 */
const nativeMixSessionInvariants = (rawNative) => {
  const reasons = []
  const code = stripComments(rawNative)
  const OPTION = 'AVAudioSessionCategoryOptionMixWithOthers'
  const hits = countOf(code, OPTION)
  if (hits !== 1) {
    reasons.push(`原生源码里 ${OPTION} 出现 ${hits} 次（第 33 轮第 4 条只允许一处：prepareAudioSession 的勾选守卫分支）`)
    if (hits === 0) return reasons
  }
  const at = code.indexOf(OPTION)
  const before = code.slice(Math.max(0, at - 400), at)
  const after = code.slice(at, at + 400)

  if (!before.includes('if (LXPlayWithOthersEnabled) {')) {
    reasons.push('原生混音分类没有由 LXPlayWithOthersEnabled 守卫（未勾选也会是混音会话 ⇒ 卡片 / 灵动岛占用被无条件砍掉，与设置项撒谎）')
  }
  if (!before.includes('AVAudioSessionRouteSharingPolicyDefault')) {
    reasons.push('原生混音分类没有配 AVAudioSessionRouteSharingPolicyDefault（混音 + LongFormAudio 互斥，setCategory 报 -50 = 歌曲在走、没有声音）')
  }
  if (before.includes('AVAudioSessionRouteSharingPolicyLongFormAudio')) {
    reasons.push('原生混音分类仍配着 AVAudioSessionRouteSharingPolicyLongFormAudio（第 24 轮实锤的 -50 死路）')
  }
  if (!after.includes('AVAudioSessionRouteSharingPolicyLongFormAudio')) {
    reasons.push('原生混音分类失败后无可退回分支（-50 / 会话被别家占用时会直接失声，混音只是增强不是唯一出路）')
  }
  return reasons
}

const sessionInvariants = (srcs) => {
  const reasons = []
  const plugin = stripComments(srcs.plugin)

  if (!plugin.includes('handleAudioFocus: isHandleAudioFocus')) {
    reasons.push('播放器未把 player.isHandleAudioFocus 传给 handleAudioFocus')
  }
  if (!plugin.includes('iosCategoryOptions: [],')) {
    reasons.push('RNTP 路径的 iosCategoryOptions 不是常量空数组（第 24 轮 -50 禁区：运行期改激活态会话分类 ⇒ 勾选即失声 / 卡片被无条件砍掉）')
  }

  reasons.push(...nativeMixSessionInvariants(srcs.native))

  for (const [name, raw] of Object.entries(srcs)) {
    if (name == 'lang') continue
    // 原生那一处放行形态由 nativeMixSessionInvariants 单独验（守卫 + 路由策略 + 唯一性）；
    // 其余文件里出现任何大小写形态的 mixWithOthers 一律拦下 —— 归一化只发生在这里，别处没有豁免。
    if (name == 'native') continue
    if (/mixwithothers/i.test(stripComments(raw))) {
      reasons.push(`${name} 的代码里出现 mixWithOthers（第 24 轮已定案：RNTP / 业务层的混音会话与「卡片可选显示」/ 原生 LongFormAudio 互斥，不许回潮；第 33 轮第 4 条只放行原生 prepareAudioSession 的勾选守卫分支）`)
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

  // c8 原生混音分类丢掉勾选守卫（未勾选也走混音 ⇒ 卡片 / 灵动岛占用被无条件砍掉）
  check('c8 原生混音分类丢掉勾选守卫', () => session({ native: tamper(REAL.native,
    '    if (LXPlayWithOthersEnabled) {\n',
    '') }),
  '没有由 LXPlayWithOthersEnabled 守卫')

  // c9 混音配 LongFormAudio（第 24 轮实锤的 -50 死路）
  check('c9 原生混音配 LongFormAudio（-50 死路）', () => session({ native: tamper(REAL.native,
    '          routeSharingPolicy:AVAudioSessionRouteSharingPolicyDefault\n                     options:AVAudioSessionCategoryOptionMixWithOthers',
    '          routeSharingPolicy:AVAudioSessionRouteSharingPolicyLongFormAudio\n                     options:AVAudioSessionCategoryOptionMixWithOthers') }),
  '-50')

  // c10 混音失败后没有可退回的非混音口径（会话被别家独占时直接失声）
  check('c10 原生混音失败后无可退回口径', () => session({ native: tamper(REAL.native,
    'AVAudioSessionRouteSharingPolicyLongFormAudio',
    'AVAudioSessionRouteSharingPolicyDefault') }),
  '无可退回分支')

  // c11 混音分类写到第二处（放行形态的唯一性被破坏）
  check('c11 原生混音分类写到第二处', () => session({ native: tamper(REAL.native,
    'AVAudioSessionRouteSharingPolicyLongFormAudio',
    'AVAudioSessionRouteSharingPolicyLongFormAudio\n                   options:AVAudioSessionCategoryOptionMixWithOthers') }),
  '只允许一处')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-play-with-others-toggle ===')
console.log('「与其他应用同时播放」= 改名 + 极性翻转 + 存储语义不变 + 切换无感（不重建播放器）+ 会话混音只许出现在原生勾选守卫分支（第 23/24 轮，第 33 轮第 4 条修订）')
console.log()

const checks = [
  ['设置项（playWithOthers / check / setter 翻回存储语义 / 无感下发 syncPlayWithOthersEnabled / 无 reloadConfig / toast）', () => uiInvariants(REAL.ui)],
  ['文案（zh-cn.json：名称「与其他应用同时播放」+ tip「立即生效」）', () => langInvariants(REAL.lang)],
  ['会话（RNTP 路径 iosCategoryOptions 常量空数组 + 非原生文件无任何大小写形态 mixWithOthers + 原生放行形态由勾选守卫 / Default 路由策略 / 唯一性 / 可退回四项把住）', () => sessionInvariants(REAL)],
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
