#!/usr/bin/env node
/**
 * sim-daily-rec-detail-overlay.js —— 「每日推荐页打开歌单详情后，只显示歌单内容」契约（第 33 轮第 6 条）
 *
 * 需求原话（2026-10-08 第 33 轮第 6 条，附「图一」= 网易云每日推荐点开某个歌单后的截图）：
 *   「如图一：酷狗音乐、企鹅音乐、网易音乐的每日推荐中，有主页推荐、推荐歌单等列表，
 *     但是当我点击列表歌单后，会出现原来的标题和歌单封面和标题重叠的情况，
 *     请改为只显示歌单内容，原每日推荐列表标题将不显示，
 *     网易每日推荐，将推荐歌单标题显示在左，推荐歌曲标题显示在右」
 *
 * 根因（读源码得到，不是猜）：
 *   这两个每日推荐页（网易 src/screens/Home/Views/DailyRec/index.tsx、
 *   QQ   src/screens/Home/Views/DailyRec/TXDailyRec/index.tsx）打开歌单详情走的是**页内浮层**，
 *   不是导航 push：`<View style={[StyleSheet.absoluteFill]}><SonglistDetail … /></View>`。
 *   为了让底下的列表不被点到、也不透出来，页面把 PagerView 那层打了 `opacity: 0` +
 *   `pointerEvents: 'none'` —— 但 `{pageHeader}`（PageTopInset + DetailPageTitle 的 42pt 大标题行
 *   + 一排 tab）当时被渲染在**这一层的外面**，于是：
 *     · 状态栏占位与大标题、tab 文字仍然照常显示在最上层；
 *     · SonglistDetail 自己的封面/标题从 statusBarHeight 起画 —— 正好与那行大标题重叠；
 *   用户看到的就是「原来的标题和歌单封面和标题重叠」。
 *   同仓 MyPlaylist / KgPlaylist / TxPlaylist 的 index 早就把 pageHeader 放在变暗层**里面**
 *   （打开详情 = 整页一起淡出），Discovery / Search 也各自处理（Search 直接 `selectedList ? null`）。
 *   只有这两个每日推荐页是例外 —— 本轮的修法就是把 pageHeader 移进那一层，与其范式对齐。
 *
 * 本轮口径：
 *   一、两个每日推荐页的 `{pageHeader}` 必须渲染在 `selectedPlaylist ? { opacity: 0 } : null` 的
 *       那一层**内部**（且在 `<PagerView` 之前）—— 打开详情时整页淡出，屏幕上只剩歌单内容。
 *   二、那一层必须同时带 `pointerEvents={selectedPlaylist ? 'none' : 'auto'}`（淡出 + 不接收触摸，
 *       少一个都会出现「看得见但点不到」或「点穿了底下的列表」）。
 *   三、`{pageHeader}` 全文只许出现一次（不许为了「主页保留标题」再补渲染一份）。
 *   四、详情浮层本身不变：`{selectedPlaylist && (` + absoluteFill + `<SonglistDetail` 原样保留。
 *   五、网易页主 tab 顺序 = 推荐歌单在左、推荐歌曲在右（用户原话后半句）；且切页映射必须继续
 *       按**语义 id / PagerView 位置**走（`setPage(newTab === 'songs' ? 0 : 1)`、
 *       `initialPage={activeTab === 'songs' ? 0 : 1}`、`position === 0 ? 'songs' : 'playlists'`），
 *       不能改成「按 tab 数组下标」—— 那样这次顺序互换就会把两个 tab 指到对方的页。
 *   六、酷狗每日推荐（KgDailyRec）本就没有歌单列表（只有 每日推荐 / 新歌速递 两个 tab，
 *       全目录无 SonglistDetail / onOpenDetail），本契约留证：它不该长出这套浮层。
 *
 * 为什么必须靠契约脚本：这类问题**布局上完全合法**（能编译、能渲染、不报错），
 * 只有人眼在图一那个位置才看得出来。谁把 `{pageHeader}` 挪回外层、把 opacity/pointerEvents
 * 联动拆掉、把 tab 顺序换回去、或把切页映射改成按下标，脚本立刻红。带反例自检（m1–m7）。
 *
 * 运行：node scripts/sim-daily-rec-detail-overlay.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去块注释与整行 `//` 注释：本脚本要看的锚点里含 `'none'` / `//` 之类的字符，
// 不能用朴素的正则从行中间切断。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  wy: 'src/screens/Home/Views/DailyRec/index.tsx',
  tx: 'src/screens/Home/Views/DailyRec/TXDailyRec/index.tsx',
  kg: 'src/screens/Home/Views/KgDailyRec/index.tsx',
  my: 'src/screens/Home/Views/MyPlaylist/index.tsx',
  kgp: 'src/screens/Home/Views/KgPlaylist/index.tsx',
  txp: 'src/screens/Home/Views/TxPlaylist/index.tsx',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

const countOf = (haystack, needle) => haystack.split(needle).length - 1

// 切一段：from（含）→ to（不含）。任一锚点找不到返回 null，由调用方报 FAIL（锚点漂移必须显式失败）
const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  if (to == null) return src.slice(start)
  const end = src.indexOf(to, start + from.length)
  if (end < 0) return null
  return src.slice(start, end)
}

const DIM_ANCHOR = 'selectedPlaylist ? { opacity: 0 } : null'

/**
 * 一条「页头在变暗层里」的通检（网易 / QQ / 三个兄弟页共用）。
 * 判定 = DIM_ANCHOR 的**那一层**（从锚点起、到 `<PagerView` 或该层闭合前）里出现 `{pageHeader}`。
 * 「同层」的严格性：从锚点往后 400 字符内必须出现 `{pageHeader}` —— 变暗层的开始标签
 * （style + pointerEvents 两行）与首个子节点之间不可能隔更多（见各页实际摆放）。
 */
const headerInsideDimLayer = (src) => {
  const reasons = []
  const code = stripComments(src)
  const at = code.indexOf(DIM_ANCHOR)
  if (at < 0) {
    reasons.push(`找不到变暗层锚点 \`${DIM_ANCHOR}\`（打开歌单详情时不再淡出底层页面？）`)
    return reasons
  }
  const after = code.slice(at, at + 400)
  if (!after.includes('{pageHeader}')) {
    reasons.push('pageHeader 不在 `opacity: 0` 的那一层里：打开歌单详情时'
      + '状态栏占位 + 大标题 + tab 仍显示在最上层，与 SonglistDetail 自己的封面/标题重叠'
      + '（用户图一：「原来的标题和歌单封面和标题重叠」）')
  }
  const layer = slice(code, DIM_ANCHOR, '<PagerView')
  if (layer == null) {
    reasons.push('找不到 `<PagerView`（页面结构变了，无法确认页头与列表同处一层）')
  } else if (!layer.includes('{pageHeader}')) {
    reasons.push('pageHeader 不在变暗层与 PagerView 之间（同一条理由的第二次核对：必须是这一层的子节点）')
  }
  if (!code.includes("pointerEvents={selectedPlaylist ? 'none' : 'auto'}")) {
    reasons.push('变暗层没有 `pointerEvents={selectedPlaylist ? \'none\' : \'auto\'}`：'
      + '淡出后底下那层仍能收到触摸（点穿到列表）')
  }
  if (countOf(code, '{pageHeader}') !== 1) {
    reasons.push(`\`{pageHeader}\` 出现 ${countOf(code, '{pageHeader}')} 次（必须恰好 1 次：'
      + '不许为了「主页保留标题」再补渲染一份）`)
  }
  return reasons
}

/** 详情浮层（absoluteFill + SonglistDetail）必须原样保留 —— 本轮只动页头的位置 */
const overlayInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)
  const overlay = slice(code, '{selectedPlaylist && (', null)
  if (overlay == null) {
    reasons.push('找不到 `{selectedPlaylist && (` 浮层（歌单详情不显示了？）')
    return reasons
  }
  if (!overlay.includes('<View style={[StyleSheet.absoluteFill]}>')) {
    reasons.push('浮动层不再铺满整屏（StyleSheet.absoluteFill 丢了：歌单内容会被挤在页头下面一条）')
  }
  if (!overlay.includes('<SonglistDetail')) {
    reasons.push('浮动层里不再渲染 SonglistDetail')
  }
  return reasons
}

/** 网易页：主 tab 顺序（歌单在左、歌曲在右）+ 切页映射与顺序解耦 */
const wyTabOrderInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)
  const playlistsAt = code.indexOf("onTabChange('playlists')")
  const songsAt = code.indexOf("onTabChange('songs')")
  if (playlistsAt < 0 || songsAt < 0) {
    reasons.push('找不到两个主 tab 的 onTabChange（切页回调改名了？）')
  } else if (playlistsAt > songsAt) {
    reasons.push('主 tab 顺序不对：必须先渲染「推荐歌单」再渲染「推荐歌曲」'
      + '（用户第 33 轮第 6 条：「将推荐歌单标题显示在左，推荐歌曲标题显示在右」）')
  }
  const labelList = code.indexOf('推荐歌单')
  const labelSongs = code.indexOf('推荐歌曲')
  if (labelList < 0 || labelSongs < 0 || labelList > labelSongs) {
    reasons.push('两个主 tab 的文字顺序不对（推荐歌单必须在推荐歌曲左侧）')
  }
  // 切页仍按语义 id → PagerView 页位（page0 = 推荐歌曲 / page1 = 推荐歌单），不跟着渲染顺序走
  if (!code.includes("pagerViewRef.current?.setPage(newTab === 'songs' ? 0 : 1)")) {
    reasons.push('handleTabChange 的 setPage 映射不是 `newTab === \'songs\' ? 0 : 1`：'
      + '改用下标的话，这次顺序互换会把两个 tab 指到对方的页')
  }
  if (!code.includes("initialPage={activeTab === 'songs' ? 0 : 1}")) {
    reasons.push('PagerView 的 initialPage 映射不是 `activeTab === \'songs\' ? 0 : 1`（同上：与渲染顺序解耦）')
  }
  if (!code.includes("event.nativeEvent.position === 0 ? 'songs' : 'playlists'")) {
    reasons.push('onPageSelected 不再按 PagerView 位置映射回来（滑动切页会与 tab 高亮脱节）')
  }
  return reasons
}

/** 兄弟页范式留证：这三页的 pageHeader 早就在变暗层里（本轮的修法就是与它们对齐） */
const siblingInvariants = (files) => {
  const reasons = []
  for (const key of ['my', 'kgp', 'txp']) {
    const code = stripComments(files[key])
    const at = code.indexOf(DIM_ANCHOR)
    if (at < 0) {
      reasons.push(`${F[key]} 找不到变暗层锚点（兄弟页范式被改掉了，本轮的「对齐」失去参照）`)
      continue
    }
    if (!code.slice(at, at + 400).includes('{pageHeader}')) {
      reasons.push(`${F[key]} 的 pageHeader 跑到变暗层外面了（同图一的缺陷会出现在「我的-歌单」页）`)
    }
  }
  return reasons
}

/** 酷狗每日推荐留证：它没有歌单列表，本轮的浮层问题不该出现在这里 */
const kgScopeInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)
  if (/SonglistDetail|onOpenDetail|absoluteFill/.test(code)) {
    reasons.push('酷狗每日推荐页长出了歌单浮层（范围变了：本轮修的是网易/QQ 两页的浮层遮挡）')
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

  // m1 网易页：把 pageHeader 挪回变暗层外面（本轮的原始缺陷）
  const realWy = REAL.wy
  const wyHeaderLine = '        {pageHeader}\n'
  check('m1 网易页 pageHeader 挪回外层', headerInsideDimLayer(
    tamper(realWy, wyHeaderLine, '').replace(
      '    <View style={{ flex: 1 }}>\n',
      '    <View style={{ flex: 1 }}>\n      {pageHeader}\n'),
  ), 'pageHeader 不在')

  // m2 网易页：主 tab 顺序换回去（歌曲在左）——把两个 onTabChange 与两段文字一起换回来
  const m2 = tamper(realWy, "onPress={() => { onTabChange('playlists') }}", "__TAB_A__")
    .replace("onPress={() => { onTabChange('songs') }}", "onPress={() => { onTabChange('playlists') }}")
    .replace('__TAB_A__', "onPress={() => { onTabChange('songs') }}")
  check('m2 网易页 tab 顺序退回「歌曲在左」', wyTabOrderInvariants(m2), '主 tab 顺序不对')

  // m3 网易页：变暗层的 pointerEvents 联动被删
  check('m3 网易页 pointerEvents 联动被删', headerInsideDimLayer(
    tamper(realWy, " pointerEvents={selectedPlaylist ? 'none' : 'auto'}", ''),
  ), 'pointerEvents')

  // m4 QQ 页：pageHeader 挪回外层
  check('m4 QQ页 pageHeader 挪回外层', headerInsideDimLayer(
    tamper(REAL.tx, '        {pageHeader}\n', '').replace(
      '    <View style={{ flex: 1 }}>\n',
      '    <View style={{ flex: 1 }}>\n      {pageHeader}\n'),
  ), 'pageHeader 不在')

  // m5 QQ 页：详情浮层不再铺满（absoluteFill 丢）
  check('m5 QQ页 浮层不铺满整屏', overlayInvariants(
    tamper(REAL.tx, '<View style={[StyleSheet.absoluteFill]}>', '<View style={{ flex: 1 }}>'),
  ), 'absoluteFill')

  // m6 网易页：切页映射改成按下标（顺序互换后会指到对方的页）
  check('m6 网易页 setPage 改成按下标', wyTabOrderInvariants(
    tamper(realWy, "pagerViewRef.current?.setPage(newTab === 'songs' ? 0 : 1)", 'pagerViewRef.current?.setPage(activeTab === newTab ? 0 : 1)'),
  ), 'setPage 映射')

  // m7 兄弟页范式被改：MyPlaylist 的 pageHeader 挪出去
  check('m7 兄弟页 MyPlaylist 范式被改', siblingInvariants({
    ...REAL,
    my: tamper(REAL.my, '      {pageHeader}\n', '').replace(
      '    <View style={{ flex: 1 }}>\n',
      '    <View style={{ flex: 1 }}>\n      {pageHeader}\n'),
  }), 'pageHeader 跑到变暗层外面')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-daily-rec-detail-overlay ===')
console.log('每日推荐点开歌单后只显示歌单内容：pageHeader 必须与列表同处一个「淡出 + 不吃触摸」的层'
  + '（第 33 轮第 6 条，网易 / QQ 两页）')
console.log()

const checks = [
  ['网易云每日推荐：pageHeader 在变暗层内 + pointerEvents 联动 + 页头只渲染一次', () => headerInsideDimLayer(REAL.wy)],
  ['网易云每日推荐：详情浮层（absoluteFill + SonglistDetail）原样保留', () => overlayInvariants(REAL.wy)],
  ['网易云每日推荐：主 tab 顺序（歌单在左 / 歌曲在右）+ 切页映射与渲染顺序解耦', () => wyTabOrderInvariants(REAL.wy)],
  ['QQ 每日推荐：pageHeader 在变暗层内 + pointerEvents 联动 + 页头只渲染一次', () => headerInsideDimLayer(REAL.tx)],
  ['QQ 每日推荐：详情浮层（absoluteFill + SonglistDetail）原样保留', () => overlayInvariants(REAL.tx)],
  ['兄弟页范式留证：MyPlaylist / KgPlaylist / TxPlaylist 的 pageHeader 同样在变暗层内', () => siblingInvariants(REAL)],
  ['范围留证：酷狗每日推荐没有歌单浮层（本轮不涉及该页）', () => kgScopeInvariants(REAL.kg)],
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
