#!/usr/bin/env node
/**
 * sim-startup-detail-offload-wiring.js —— 「启动后打开播放详情页」挂载 + 「启用音频卸载」接线契约
 * （第 33 轮第 7 条）
 *
 * 需求原话（2026-10-08 第 33 轮第 7 条）：
 *   「在播放设置中新增"启动后打开播放详情页"选项，放在"返回软件时自动播放"选项下面，
 *     移植 lx-music-mobile-ios-adaptation 项目基本设置中该功能，通过这个项目，
 *     完善"启用音频卸载"选项功能，目前不可用需修复」
 *
 * 两件事，各自的根因（读源码得到）：
 *   ① 「启动后打开播放详情页」：组件本体早就移植过来了
 *      （settings/Basic/IsStartupPushPlayDetailScreen.tsx，key `player.startupPushPlayDetailScreen`
 *      + 标签 `setting_basic_startup_push_play_detail_screen` 与参考工程逐字一致），
 *      但**从来没被任何页面挂载**（全仓无 import）—— 所以设置页上根本看不到这一项。
 *      消费点反而早就写好了：src/screens/Home/index.tsx 的启动 effect 里读同一个键并
 *      调 navigations.pushPlayDetailScreen(componentId)。
 *   ② 「启用音频卸载」：开关在、功能不在 —— src/plugins/player/index.ts 的 initial() 形参写作
 *      `isEnableAudioOffload: _isEnableAudioOffload`（下划线前缀 = 声明了不用），传给
 *      TrackPlayer.setupPlayer 的是硬编码 `audioOffload: false`，勾不勾都一样。
 *      参考工程的写法是 `audioOffload: isEnableAudioOffload`（同一个 fork 的 setupPlayer 选项）。
 *      另外那个开关的 toast 文案错用了「与其他应用同时播放」的 tip（「立即生效，无需重启」），
 *      而 audioOffload 只在播放器初始化时读一次 —— 本设置自带的帮助文案也写着「完全重启应用」。
 *
 * 本轮口径：
 *   一、Player 设置页必须挂载 `<IsStartupPushPlayDetailScreen />`，位置**紧跟**
 *       `<IsAutoPlayOnReturn />`（用户原话「放在返回软件时自动播放选项下面」）；组件只此一份
 *       （旧的 Basic 目录副本必须已删除，否则两份实现会各自漂移）。
 *   二、组件用键 `player.startupPushPlayDetailScreen` + 标签 `setting_basic_startup_push_play_detail_screen`
 *       （与参考工程一字不差），默认值与语言键都在。
 *   三、消费链不许断：Home 启动 effect 读该键并 push 播放详情页；pushPlayDetailScreen 保留
 *       本工程特有的「没有正在播放的歌就不开页」守卫（防止空状态卡死，参考工程没有这一道，
 *       属于本工程的有意增强，不许为了「一比一」删掉）。
 *   四、音频卸载必须真接线：`audioOffload: isEnableAudioOffload`（不许回到硬编码 false）、
 *       形参不带 `_` 前缀、getPlayerConfig() 仍下发该键（设置 → initial 的必经通路）。
 *   五、卸载开关的提示文案与生效时机一致（不许再借用 handle_audio_focus 的「立即生效」文案）；
 *       且不许用 reloadConfig 去「立即生效」—— 第 24 轮定案：播放中重建播放器会让锁屏 /
 *       灵动岛卡片消失、原生引擎有进度没声音。
 *
 * 为什么必须靠契约脚本：这两条都是「开关在那儿但什么都不做」的形态 —— 编译通过、页面正常、
 * 点了也不报错，只有契约能把它钉住。谁把挂载删了、把顺序换了、把 audioOffload 改回常量、
 * 或把 toast 文案借回去，脚本立刻红。带反例自检（m1–m7）。
 *
 * 运行：node scripts/sim-startup-detail-offload-wiring.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const exists = (p) => fs.existsSync(path.join(ROOT, p))

// 只去块注释与整行 `//` 注释（本脚本要看的锚点里含 `'player.…'` 等带点的字符串，安全）
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  playerPage: 'src/screens/Home/Views/Setting/settings/Player/index.tsx',
  detailRow: 'src/screens/Home/Views/Setting/settings/Player/IsStartupPushPlayDetailScreen.tsx',
  basicRow: 'src/screens/Home/Views/Setting/settings/Basic/IsStartupPushPlayDetailScreen.tsx',
  offloadRow: 'src/screens/Home/Views/Setting/settings/Player/IsEnableAudioOffload.tsx',
  home: 'src/screens/Home/index.tsx',
  nav: 'src/navigation/navigation.ts',
  plugin: 'src/plugins/player/index.ts',
  defaults: 'src/config/defaultSetting.ts',
  lang: 'src/lang/zh-cn.json',
}

const REAL = {}
// 注意：F 里的文件**允许缺失**（basicRow 本来就该是被删掉的那个）——存在才读，不存在给空串，
// 由不变量里对应的 `__xxxExists` 标志去判「该在的在、该没的没」。
for (const [key, file] of Object.entries(F)) REAL[key] = exists(file) ? read(file) : ''
REAL.__basicExists = exists(F.basicRow)
REAL.__detailExists = exists(F.detailRow)

const LANG = JSON.parse(REAL.lang)

// ---------------------------------------------------------------------------
// 不变量 A（条一 / 条二）：设置项挂载 + 只此一份 + 位置 + 键与文案
// ---------------------------------------------------------------------------
const mountInvariants = (files) => {
  const reasons = []
  const page = stripComments(files.playerPage)

  if (!page.includes('<IsStartupPushPlayDetailScreen />')) {
    reasons.push('播放设置页没有挂载 <IsStartupPushPlayDetailScreen />：'
      + '选项在界面上根本不存在（组件是孤儿，用户第 33 轮第 7 条要的就是把它打开）')
  }
  const auto = page.indexOf('<IsAutoPlayOnReturn />')
  const start = page.indexOf('<IsStartupPushPlayDetailScreen />')
  if (auto < 0 || start < 0) {
    reasons.push('找不到 <IsAutoPlayOnReturn /> 或 <IsStartupPushPlayDetailScreen />（挂载结构变了）')
  } else if (start < auto) {
    reasons.push('「启动后打开播放详情页」不在「返回软件时自动播放」下面'
      + '（用户原话：「放在"返回软件时自动播放"选项下面」）')
  }

  if (!files.__detailExists) {
    reasons.push(`组件不在 ${F.detailRow}（设置组件跟着所属设置页走，播放设置页用的组件应放在 Player 目录）`)
  }
  if (files.__basicExists) {
    reasons.push(`${F.basicRow} 又出现了：同一个开关两份实现，必然各自漂移（旧的孤儿副本必须删掉）`)
  }

  if (files.__detailExists) {
    const row = stripComments(read(F.detailRow))
    if (!row.includes("useSettingValue('player.startupPushPlayDetailScreen')")) {
      reasons.push('组件没有读 `player.startupPushPlayDetailScreen`（与参考工程同键：老用户的设置才认得）')
    }
    if (!row.includes("updateSetting({ 'player.startupPushPlayDetailScreen': startupPushPlayDetailScreen })")) {
      reasons.push('组件没有写 `player.startupPushPlayDetailScreen`')
    }
    if (!row.includes("t('setting_basic_startup_push_play_detail_screen')")) {
      reasons.push('组件标签没有用 `setting_basic_startup_push_play_detail_screen`（与参考工程同文案键）')
    }
  }

  if (!LANG['setting_basic_startup_push_play_detail_screen']) {
    reasons.push('语言文件缺少 setting_basic_startup_push_play_detail_screen（设置项会显示成键名）')
  }
  if (!/'player\.startupPushPlayDetailScreen'/.test(stripComments(files.defaults))) {
    reasons.push('defaultSetting.ts 缺少 player.startupPushPlayDetailScreen 默认值')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B（条三）：消费链 —— Home 启动 effect + pushPlayDetailScreen 的空状态守卫
// ---------------------------------------------------------------------------
const consumerInvariants = (files) => {
  const reasons = []
  const home = stripComments(files.home)
  const nav = stripComments(files.nav)

  if (!home.includes("settingState.setting['player.startupPushPlayDetailScreen']")) {
    reasons.push('Home 启动 effect 不再读 player.startupPushPlayDetailScreen（选项勾了也不会打开播放详情页）')
  }
  if (!home.includes('navigations.pushPlayDetailScreen(componentId)')) {
    reasons.push('Home 启动 effect 不再调 navigations.pushPlayDetailScreen(componentId)')
  }
  const fn = (() => {
    const at = nav.indexOf('export function pushPlayDetailScreen(')
    return at < 0 ? null : nav.slice(at, at + 900)
  })()
  if (fn == null) {
    reasons.push('navigation.ts 里找不到 pushPlayDetailScreen（锚点漂移）')
  } else {
    if (!fn.includes('if (!playerState.playMusicInfo.musicInfo) {')) {
      reasons.push('pushPlayDetailScreen 丢了「没有正在播放的歌就不开页」守卫：'
        + '空状态打开播放详情页会卡死（本工程特有，不许为了一比一删掉）')
    }
    if (!fn.includes('endPush(COMPONENT_IDS.playDetail)')) {
      reasons.push('pushPlayDetailScreen 的早退分支没有 endPush（push 闩锁会卡住，后续 push 全被拒）')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C（条四 / 条五）：音频卸载真接线 + 提示文案与生效时机一致
// ---------------------------------------------------------------------------
const offloadInvariants = (files) => {
  const reasons = []
  const plugin = stripComments(files.plugin)
  const row = stripComments(files.offloadRow)

  if (plugin.includes('isEnableAudioOffload: _isEnableAudioOffload')) {
    reasons.push('initial() 的形参又写成 `_isEnableAudioOffload`（下划线 = 声明了不用，开关立刻变空开关）')
  }
  if (!plugin.includes('audioOffload: isEnableAudioOffload')) {
    reasons.push('setupPlayer 没有把 audioOffload 接到设置值上（用户第 33 轮第 7 条之前就是硬编码 false，'
      + '勾不勾都一样 = 「目前不可用」）')
  }
  if (/audioOffload: false/.test(plugin)) {
    reasons.push('setupPlayer 的 audioOffload 又变回硬编码 false')
  }
  if (!plugin.includes('isEnableAudioOffload: settingState.setting[\'player.isEnableAudioOffload\']')) {
    reasons.push('getPlayerConfig() 不再下发 player.isEnableAudioOffload（设置 → initial 的通路断了）')
  }

  if (!row.includes("useSettingValue('player.isEnableAudioOffload')")) {
    reasons.push('开关组件没有读 player.isEnableAudioOffload')
  }
  if (!row.includes("updateSetting({ 'player.isEnableAudioOffload': value })")) {
    reasons.push('开关组件没有写 player.isEnableAudioOffload')
  }
  if (row.includes("toast(t('setting_play_handle_audio_focus_tip'))")) {
    reasons.push('卸载开关又借用了「与其他应用同时播放」的提示文案（「立即生效，无需重启」）——'
      + 'audioOffload 只在播放器初始化时读一次，文案与事实相反')
  }
  if (!row.includes("toast(t('setting_play_audio_offload_tip_updated'))")) {
    reasons.push('卸载开关没有用专用提示文案 setting_play_audio_offload_tip_updated')
  }
  if (/\breloadConfig\b/.test(row)) {
    reasons.push('卸载开关调了 reloadConfig：播放中重建播放器会让锁屏 / 灵动岛卡片消失、'
      + '原生引擎有进度没声音（第 24 轮实锤）')
  }

  const tip = LANG['setting_play_audio_offload_tip_updated']
  if (!tip) {
    reasons.push('语言文件缺少 setting_play_audio_offload_tip_updated')
  } else if (!tip.includes('重启')) {
    reasons.push(`卸载开关的提示文案没说清生效时机（现为「${tip}」）：该选项只在播放器初始化时读取`)
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
const tamper = (src, from, to) => {
  if (!src.includes(from)) throw new Error('反例锚点未命中: ' + from.slice(0, 70))
  return src.replace(from, to)
}

const runCounterExamples = () => {
  const results = []
  const check = (name, reasons, expectKeyword) => {
    const hit = reasons.some((r) => r.includes(expectKeyword))
    results.push({ name, ok: hit, detail: hit ? '已拦下' : '未拦下（缺失期望理由：' + expectKeyword + '）' })
  }

  // m1 挂载被删（回到「组件是孤儿、设置页看不见」的原始状态）
  check('m1 播放设置页不再挂载该选项', mountInvariants({
    ...REAL,
    playerPage: tamper(REAL.playerPage, '      <IsStartupPushPlayDetailScreen />\n', ''),
  }), '没有挂载')

  // m2 顺序换到「返回软件时自动播放」上面
  check('m2 选项被挪到「返回软件时自动播放」上面', mountInvariants({
    ...REAL,
    playerPage: REAL.playerPage
      .replace('      <IsStartupPushPlayDetailScreen />\n', '')
      .replace('      <IsAutoPlayOnReturn />\n', '      <IsStartupPushPlayDetailScreen />\n      <IsAutoPlayOnReturn />\n'),
  }), '不在「返回软件时自动播放」下面')

  // m3 旧的 Basic 副本复活（两份实现）
  check('m3 旧的 Basic 副本复活', mountInvariants({ ...REAL, __basicExists: true }), '又出现了')

  // m4 audioOffload 改回硬编码 false
  check('m4 audioOffload 退回硬编码 false', offloadInvariants({
    ...REAL,
    plugin: tamper(REAL.plugin, 'audioOffload: isEnableAudioOffload,', 'audioOffload: false,'),
  }), '没有把 audioOffload 接到设置值上')

  // m5 形参又带下划线前缀（声明了不用）
  check('m5 形参退回 _ 前缀', offloadInvariants({
    ...REAL,
    plugin: tamper(REAL.plugin, 'isEnableAudioOffload }: {', 'isEnableAudioOffload: _isEnableAudioOffload }: {'),
  }), '下划线')

  // m6 卸载开关的 toast 借回「立即生效」文案
  check('m6 卸载开关借回同时播放的 tip', offloadInvariants({
    ...REAL,
    offloadRow: tamper(REAL.offloadRow,
      "toast(t('setting_play_audio_offload_tip_updated'))",
      "toast(t('setting_play_handle_audio_focus_tip'))"),
  }), '借用')

  // m7 Home 启动 effect 的消费分支被删
  check('m7 Home 不再消费该设置', consumerInvariants({
    ...REAL,
    home: tamper(REAL.home,
      "    if (settingState.setting['player.startupPushPlayDetailScreen']) {\n      navigations.pushPlayDetailScreen(componentId)\n    }\n",
      ''),
  }), '不再读 player.startupPushPlayDetailScreen')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-startup-detail-offload-wiring ===')
console.log('「启动后打开播放详情页」挂上播放设置 + 「启用音频卸载」真接线（第 33 轮第 7 条）')
console.log()

const checks = [
  ['播放设置页挂载「启动后打开播放详情页」（紧跟「返回软件时自动播放」）+ 组件只此一份 + 键/文案同参考工程',
    () => mountInvariants(REAL)],
  ['消费链：Home 启动 effect 读该键并 push；pushPlayDetailScreen 保留「无歌曲不开页」守卫',
    () => consumerInvariants(REAL)],
  ['音频卸载接线：audioOffload 取设置值 + getPlayerConfig 下发 + 提示文案与生效时机一致',
    () => offloadInvariants(REAL)],
]

let invOk = true
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
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
console.log()
console.log(`结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length - (invOk ? 0 : 1)}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
