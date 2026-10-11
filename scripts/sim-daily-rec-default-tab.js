#!/usr/bin/env node
/**
 * sim-daily-rec-default-tab.js —— 「网易每日推荐打开时，默认显示推荐歌单内容」契约（第 40 轮）
 *
 * 需求原话（2026-10-09 第 40 轮，逐字）：
 *   「网易每日推荐打开时，默认显示推荐歌单内容」
 *
 * 背景（读源码得到）：
 *   `src/screens/Home/Views/DailyRec/index.tsx` 的主 tab 是「推荐歌单 / 推荐歌曲」两个 PagerView 页
 *   （page0 = RecSongs、page1 = RecPlaylists；第 33 轮第 6 条把「推荐歌单」摆在左边）。此前
 *   activeTab 的初值是 'songs' —— 这一页一打开落在「推荐歌曲」，用户要的是落在「推荐歌单」。
 *
 * 本轮口径（三条，逐条对应源码里的落点）：
 *   一、**默认落点 = 推荐歌单**：主 tab 的 useState 初值必须是 'playlists'；同时 PagerView 的
 *       `initialPage={activeTab === 'songs' ? 0 : 1}` 必须继续按**语义 id**映射 —— 初值一改，
 *       落点自然跟着变。若有人图省事把 initialPage 写死成 0（或写死成 1 之外的值），初值再对
 *       也落错页。
 *   二、**重新进入回落默认**：本页是 useHomeLazyPage 的「访问过即常驻」页
 *       （`src/screens/Home/Vertical/Main.tsx` 的 `DailyRecPage`）——离开再回来组件**不重挂载**，
 *       只改 useState 初值的话，「打开时默认显示推荐歌单」只在本次会话第一次打开生效。所以
 *       还要订阅 `navActiveIdUpdated`：从别的页面切进本页时把主 tab 拨回默认。
 *         · 判定必须是 `id === 'nav_daily_rec' && prevId !== 'nav_daily_rec'`：forceSyncNavActiveId()
 *           （core/common.ts，**不受同值短路影响**）会重播当前 id，少了 prevId 这道守卫，
 *           用户在页内切到「推荐歌曲」后任何一次重复广播都会把他拨回去。
 *         · 回落动作 = setActiveTab('playlists') + 无动画切页（setPageWithoutAnimation(1)）：
 *           事件到达时本层还被详情宿主盖着（可见性在下一帧的 rAF 里才置位），带动画会先闪一段
 *           从 page0 滑到 page1 的过程。
 *         · 卸载必须注销监听（常驻页会反复挂载 / 卸载：设置页盖住时 useHomeLazyPage 会把本页
 *           整个卸载，收不到注销就是监听泄漏）。
 *   三、**页内动作不受牵连**：切 tab（handleTabChange）、滑动切页（onPageSelected）里都不许出现
 *       「拨回默认」的写入 —— 否则用户在页内选「推荐歌曲」会被自己的滑动/点击立刻弹回去。
 *       同时留证：导航 id 确实是 'nav_daily_rec'（Vertical/Main.tsx 的注册点），id 口径错位
 *       的话整套回落在真机上永远不会触发。
 *
 * 为什么必须靠契约脚本：这类问题编译 / 渲染全合法（初值是任意一个合法 union 成员都跑得起来），
 * 只有打开页面那一眼才看得出来。谁把初值改回 'songs'、把回落监听删掉、把 prevId 守卫拆掉、
 * 把无动画切页换成带动画、或者把导航 id 口径改掉，脚本立刻红。带反例自检（d1–d8）。
 *
 * 运行：node scripts/sim-daily-rec-default-tab.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去块注释与整行 `//` 注释：本脚本的锚点里含 `'playlists'` 之类的字面量，
// 而本轮新增的说明性注释里到处都是这些词（`// ... 默认的「推荐歌单」...`），
// 不剔注释会假命中。不从行中间切断的原因同兄弟脚本：代码行里就有 `//` 之外的引号串。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  wy: 'src/screens/Home/Views/DailyRec/index.tsx',
  verticalMain: 'src/screens/Home/Vertical/Main.tsx',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

/** 切一段：from（含）→ to（不含）。任一锚点找不到返回 null（锚点漂移必须显式失败） */
const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  if (to == null) return src.slice(start)
  const end = src.indexOf(to, start + from.length)
  if (end < 0) return null
  return src.slice(start, end)
}

// 回落逻辑的五个锚点（少一个都不是「从别的页面进来就落回推荐歌单」）
const RESET_ANCHORS = [
  ["global.state_event.on('navActiveIdUpdated', handleNavActiveIdUpdate)",
    '没有订阅 navActiveIdUpdated：本页常驻不重挂载，离开再回来仍是上次那个 tab，'
    + '「打开时默认显示推荐歌单」只在本次会话第一次打开成立'],
  ["if (id !== 'nav_daily_rec' || prev === 'nav_daily_rec') return",
    '回落的进入判定不完整：必须是「id === nav_daily_rec 且上一个 id 不是它」。'
    + '少了 prevId 这半边，forceSyncNavActiveId() 重播当前 id 时会把用户从「推荐歌曲」拨回默认'],
  ["setActiveTab('playlists')",
    '回落没有把主 tab 置回「推荐歌单」'],
  ['pagerViewRef.current?.setPageWithoutAnimation(1)',
    '回落没有把 PagerView 落到 page1（推荐歌单），或用了带动画的 setPage —— '
    + '事件到达时本层还被详情宿主盖着，带动画会先闪一段从推荐歌曲滑到推荐歌单的过程'],
  ["global.state_event.off('navActiveIdUpdated', handleNavActiveIdUpdate)",
    '卸载没有注销 navActiveIdUpdated 监听（常驻页会被反复卸载/挂载，收不到注销就是监听泄漏）'],
]

/** 一、默认落点：初值 + initialPage 语义映射 */
const defaultLandingInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)
  if (!code.includes("useState<'songs' | 'playlists'>('playlists')")) {
    reasons.push('主 tab 的初始选中不是「推荐歌单」：用户第 40 轮要求「网易每日推荐打开时，'
      + '默认显示推荐歌单内容」，初值必须写成 useState<\'songs\' | \'playlists\'>(\'playlists\')')
  }
  if (!code.includes("initialPage={activeTab === 'songs' ? 0 : 1}")) {
    reasons.push('PagerView 的 initialPage 不再是 `activeTab === \'songs\' ? 0 : 1` 这套语义映射：'
      + '写死页号的话，初值指向的 tab 与实际落点会脱开（打开落在推荐歌曲）')
  }
  return reasons
}

/** 二、重新进入回落默认（五个锚点全在，且都在同一个事件处理器块里） */
const reenterResetInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)
  for (const [anchor, why] of RESET_ANCHORS) {
    if (!code.includes(anchor)) reasons.push(why)
  }
  // 中间三个锚点必须同处 handleNavActiveIdUpdate 的**处理器体**里（散在别处 = 没做）：
  // 从处理器开头切到注销行；注销行被删时（反例 d7）退化为固定窗口，不影响这三条判定。
  const startAt = code.indexOf('const handleNavActiveIdUpdate = (id: string) => {')
  if (startAt < 0) {
    reasons.push('找不到 handleNavActiveIdUpdate 处理器（回落的主体没了）')
    return reasons
  }
  const rest = code.slice(startAt)
  const offAt = rest.indexOf("global.state_event.off('navActiveIdUpdated', handleNavActiveIdUpdate)")
  const body = offAt < 0 ? rest.slice(0, 1200) : rest.slice(0, offAt)
  for (const [anchor] of RESET_ANCHORS.slice(1, 4)) {
    if (!body.includes(anchor)) {
      reasons.push(`回落锚点不在同一个处理器块里（散在别处效果等同没做）：${anchor.slice(0, 46)}`)
    }
  }
  return reasons
}

/** 三-a、页内动作不受牵连：切 tab / 滑动切页里不许有「拨回默认」的写入 */
const inPageUntouchedInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)
  const tabChange = slice(code, 'const handleTabChange = (newTab', 'const onPageSelected')
  if (tabChange == null) {
    reasons.push('找不到 handleTabChange（切 tab 的回调改名了？）')
  } else if (tabChange.includes("setActiveTab('playlists')")) {
    reasons.push('handleTabChange 里出现了「拨回推荐歌单」：用户在页内点「推荐歌曲」会被立刻弹回默认')
  }
  const pageSelected = slice(code, 'const onPageSelected = useCallback', 'const handleOpenDetail')
  if (pageSelected == null) {
    reasons.push('找不到 onPageSelected 的独立段落（滑动切页的回调改名/挪位了？）')
  } else if (pageSelected.includes("setActiveTab('playlists')")) {
    reasons.push('onPageSelected 里出现了「拨回推荐歌单」：用户滑动到推荐歌曲会被立刻弹回默认')
  }
  return reasons
}

/** 三-b、导航 id 口径留证：本页注册的导航 id 就是回落判定用的 'nav_daily_rec' */
const navIdWiringInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)
  if (!code.includes("useHomeLazyPage('nav_daily_rec', () => <DailyRec />)")) {
    reasons.push("Vertical/Main.tsx 里找不到 `useHomeLazyPage('nav_daily_rec', () => <DailyRec />)`："
      + '导航 id 口径变了，回落判定的字符串在真机上永远不会命中（等于没做回落）')
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

  const wy = REAL.wy

  // d1 初值改回「推荐歌曲」（本轮的原始缺陷）
  check('d1 初值改回 songs', defaultLandingInvariants(
    tamper(wy, "useState<'songs' | 'playlists'>('playlists')", "useState<'songs' | 'playlists'>('songs')"),
  ), '初始选中不是「推荐歌单」')

  // d2 initialPage 写死 0（初值还对，落点照样错）
  check('d2 initialPage 写死 0', defaultLandingInvariants(
    tamper(wy, "initialPage={activeTab === 'songs' ? 0 : 1}", 'initialPage={0}'),
  ), 'initialPage')

  // d3 删掉监听注册（改成只留一句注释占位，模拟「忘了订阅」）
  check('d3 删掉 navActiveIdUpdated 订阅', reenterResetInvariants(
    tamper(wy, "global.state_event.on('navActiveIdUpdated', handleNavActiveIdUpdate)", 'void handleNavActiveIdUpdate'),
  ), '没有订阅')

  // d4 拆掉 prevId 守卫（只剩「id 是这一页就回落」）
  check('d4 拆掉 prevId 守卫', reenterResetInvariants(
    tamper(wy, "if (id !== 'nav_daily_rec' || prev === 'nav_daily_rec') return", "if (id !== 'nav_daily_rec') return"),
  ), 'prevId')

  // d5 只改 state、不切页
  check('d5 回落不切 PagerView', reenterResetInvariants(
    tamper(wy, 'pagerViewRef.current?.setPageWithoutAnimation(1)', 'void 0'),
  ), '落到 page1')

  // d6 切页保留动画（进页面时先闪一段滑动）
  check('d6 回落用带动画的 setPage', reenterResetInvariants(
    tamper(wy, 'pagerViewRef.current?.setPageWithoutAnimation(1)', 'pagerViewRef.current?.setPage(1)'),
  ), '带动画')

  // d7 卸载不注销
  check('d7 卸载不注销监听', reenterResetInvariants(
    tamper(wy, "    return () => { global.state_event.off('navActiveIdUpdated', handleNavActiveIdUpdate) }",
      '    return () => {}'),
  ), '注销')

  // d8 导航 id 口径错位（回落判定的字符串永远不命中）
  check('d8 导航 id 口径错位', navIdWiringInvariants(
    tamper(REAL.verticalMain, "useHomeLazyPage('nav_daily_rec', () => <DailyRec />)",
      "useHomeLazyPage('nav_daily_rec_x', () => <DailyRec />)"),
  ), '导航 id 口径')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-daily-rec-default-tab ===')
console.log('网易每日推荐打开即落在「推荐歌单」：初值 + initialPage 语义映射 + 重新进入回落'
  + '（第 40 轮；页内切 tab / 滑动切页不受牵连）')
console.log()

const checks = [
  ['网易每日推荐：默认落点 = 推荐歌单（初值 playlists + initialPage 语义映射）', () => defaultLandingInvariants(REAL.wy)],
  ['网易每日推荐：重新进入回落默认（订阅 + prevId 守卫 + setActiveTab + 无动画切页 + 注销，五个锚点同块）', () => reenterResetInvariants(REAL.wy)],
  ['网易每日推荐：页内动作不受牵连（handleTabChange / onPageSelected 里没有「拨回默认」）', () => inPageUntouchedInvariants(REAL.wy)],
  ['导航 id 口径留证：Vertical/Main.tsx 注册的就是 nav_daily_rec → DailyRec', () => navIdWiringInvariants(REAL.verticalMain)],
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
