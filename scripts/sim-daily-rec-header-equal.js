#!/usr/bin/env node
/**
 * sim-daily-rec-header-equal.js —— 「每日推荐顶部标题行：等分列 + 同一中线」契约（用户第 18 轮第 1 条）
 *
 * 需求原话（2026-10-02）：
 *   「进入每日推荐界面中，酷狗、QQ、网易每日推荐标题应该和每日推荐、新歌速递、主页推荐、
 *     雷达推荐、推荐歌单、推荐新歌、推荐歌曲、推荐歌单在同一直线上，中心对齐，且酷狗每日推荐
 *     标题与滑动条中的文字最多同时显示 4 个，比如 QQ 每日推荐、主页推荐、雷达推荐、推荐歌单
 *     这 4 个文字，并且这 4 个文字间的间距应该是相等且平分整个宽度，文字上下中心对齐，显示
 *     高度位置和推荐文字到顶部之间间距一样，确保推荐界面的所有顶部栏的文字都在同一高度且
 *     中心对齐，按钮跳转页面内也使用这个样式。」
 *
 * 收敛结果（逐条对应用户原话）：
 *   一、「同一直线上 / 中心对齐」= 标题与 tab 同处 DetailPageTitle 的行内容区（inner，一条
 *      水平行、alignItems: center），每个文字块在自己的列盒里水平居中（textAlign: 'center' /
 *      alignItems: 'center'）——于是各文字块的**中心**落在同一条水平线、同一等高栅格上。
 *   二、「最多同时显示 4 个」= 列数收敛到 min(项目数, detailTitleMaxVisibleColumns)，常量导出
 *      在共享组件里（= 4）。≤4 项全部同时可见；>4 项每列仍 1/4 行宽，多出来的靠横向滑动查看，
 *      不压缩列宽、不换行。
 *   三、「间距相等且平分整个宽度」= 列宽 = 行内容区实测宽 / 列数，标题列与每个 tab 列同宽；
 *      列宽 × 列数 ≡ 行宽，相邻文字块中心差 ≡ 列宽。
 *   四、「文字上下中心对齐」= 下划线 / 描边占走「paddingBottom + 边框」的高度，顶部补回同样多：
 *      paddingTop ≡ paddingBottom + border（与文字行高无关的恒等式，见 balanceOf）。
 *   五、「显示高度位置和推荐文字到顶部之间间距一样」= 三页页头都是 PageTopInset + 同一份间距
 *      （paddingTop: designSpacing.sm）。第 19 轮第 2 条（2026-10-02）起这份间距收进共享组件
 *      DetailPageTitle 的 row.paddingTop：此前只有这三页各写各的 headerExtraTop，七个「我的」
 *      二级列表页没有 ⇒ 标题离顶部差 12pt；现在十个用它的页面一条来源（本脚本改钉共享组件
 *      的 row.paddingTop，并断言三页里不再各留一份 headerExtraTop）。
 *   六、「按钮跳转页面内也使用这个样式」= 这三个每日推荐页（分别由「我的 / 发现」里的按钮进入）
 *      共用同一个 DetailPageTitle + 同一组 token，本脚本把三页逐项钉成一份实现。
 *
 * 本脚本从源码解析结构（不硬编码行号），每条关键断言配一个「改回旧实现就该判不合格」的反例。
 *
 * 运行：node scripts/sim-daily-rec-header-equal.js
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const results = []
let failed = 0
const check = (label, ok, detail) => {
  results.push({ label, ok: !!ok, detail })
  if (!ok) failed++
}

/** 去掉行注释：断言只看代码，避免中文注释里出现 4 / flexWrap / width: columnWidth 等字样假命中 */
const stripComments = (s) => s.split('\n').map((line) => {
  const at = line.indexOf('//')
  return at < 0 ? line : line.slice(0, at)
}).join('\n')

/** 取一个样式块（`name: {` 起，到同缩进的 `},` 止）——本工程样式块均为平铺键值 */
const block = (src, name) => {
  const m = new RegExp(`(?:^|\\n)\\s+${name}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`).exec(stripComments(src))
  return m ? m[1] : null
}

/** 样式块里某属性的右值表达式（去行尾逗号） */
const prop = (src, styleName, name) => {
  const b = block(src, styleName)
  if (b == null) return null
  const m = new RegExp(`(?:^|\\n)\\s*${name}:\\s*([^\\n,]+)`).exec(b)
  return m ? m[1].trim() : null
}

/** `const x = <expr>` / `export const x = <expr>` 的右值表达式 */
const constExpr = (src, name) => {
  const m = new RegExp(`(?:^|\\n)\\s*(?:export )?const ${name} = ([^\\n]+)`).exec(stripComments(src))
  return m ? m[1].trim() : null
}

/** 源码里某个字面量出现的次数 */
const countOf = (src, text) => src.split(text).length - 1

/** a 到 b 之间的源码分片（都找不到时返回空串，交给断言判红） */
const sliceBetween = (src, a, b) => {
  const i = src.indexOf(a)
  if (i < 0) return ''
  const j = src.indexOf(b, i + a.length)
  return j < 0 ? src.slice(i) : src.slice(i, j)
}

// —— 设计 token（数值一律从源码解析，不抄当前值） ——
const tokensSrc = read('src/theme/DesignTokens.ts')
const spacingBlock = /designSpacing = \{([^}]*)\}/.exec(tokensSrc)[1]
const SP = {}
for (const m of spacingBlock.matchAll(/(\w+):\s*(\d+)/g)) SP[m[1]] = Number(m[2])
const typographyBlock = /designTypography = \{([^}]*)\}/.exec(tokensSrc)[1]
const TYPE = {}
for (const m of typographyBlock.matchAll(/(\w+):\s*([\d.]+)/g)) TYPE[m[1]] = Number(m[2])
const subTokenExpr = constExpr(tokensSrc, 'subPageTitleSize')
const TITLE_SIZE = TYPE.title

const BW = {}
{
  const b = /export const BorderWidths = \{([\s\S]*?)\n\}/.exec(read('src/theme/Typography.js'))[1]
  for (const m of b.matchAll(/(\w+):\s*([\d.]+)/g)) BW[m[1]] = Number(m[2])
}

/** 把 `5 + BorderWidths.normal3` / `BorderWidths.normal * 2` 这类样式表达式算成数值（不用 eval） */
const numExpr = (expr) => {
  if (expr == null) return NaN
  return expr.split('+').reduce((sum, term) => {
    let v = 1
    for (const p of term.split('*').map((x) => x.trim())) {
      if (/^[\d.]+$/.test(p)) { v *= Number(p); continue }
      const key = p.replace(/^BorderWidths\./, '')
      if (!(key in BW)) return NaN
      v *= BW[key]
    }
    return sum + v
  }, 0)
}

/**
 * 垂直中线配平：文字盒里「文字中心 = 盒中心」⇔ paddingTop ≡ paddingBottom + 边框总高。
 * （文字行高在等式两边各出现一次，约掉 —— 所以这个恒等式与字号 / 行高无关。）
 * borderProp/borderCount：下划线 tab 只有下边框；chip 描边上下各一条。
 */
const balanceOf = (src, styleName, borderProp, borderCount) => {
  const pt = numExpr(prop(src, styleName, 'paddingTop'))
  const pb = numExpr(prop(src, styleName, 'paddingBottom'))
  const border = numExpr(prop(src, styleName, borderProp)) * borderCount
  return { pt, pb, border, residual: pt - pb - border }
}

// —— 源码 ——
const detailSrc = stripComments(read('src/components/common/DetailPageTitle.tsx'))
const kgSrc = stripComments(read('src/screens/Home/Views/KgDailyRec/index.tsx'))
const txSrc = stripComments(read('src/screens/Home/Views/DailyRec/TXDailyRec/index.tsx'))
const wySrc = stripComments(read('src/screens/Home/Views/DailyRec/index.tsx'))
const LANG = JSON.parse(read('src/lang/zh-cn.json'))

// —— 共享组件（DetailPageTitle）的不变量 ——
const D = {
  maxVisible4: (src) => Number(constExpr(src, 'detailTitleMaxVisibleColumns')) === 4,
  clampToMax: (src) => /Math\.min\(equalColumnsCount, detailTitleMaxVisibleColumns\)/.test(src),
  divideByColumns: (src) => /availableWidth \/ columnCount/.test(src),
  measuredFirst: (src) => /rowWidth > 0 \? rowWidth : windowWidth - scaleSizeW\(designSpacing\.lg\) \* 2/.test(src),
  innerMeasured: (src) => /<View style=\{styles\.inner\} onLayout=\{columnCount > 0 \? handleInnerLayout : undefined\}>/.test(src),
  layoutGuard: (src) => /Math\.abs\(prev - next\) > 0\.5 \? next : prev/.test(src),
  titleColumnWidth: (src) => /isColumn \? \{ width: columnWidth \} : equalColumns \? styles\.titleEqual : null/.test(src),
  titleCentered: (src) => prop(src, 'titleColumn', 'textAlign') === "'center'",
  titleOneLine: (src) => /numberOfLines=\{isColumn \? 1 : undefined\}/.test(src),
  titleAutoFit: (src) => /adjustsFontSizeToFit=\{isColumn \? true : undefined\}/.test(src),
  titleMinScaleProp: (src) => /minimumFontScale=\{isColumn \? titleMinFontScale : undefined\}/.test(src),
  childrenCallback: (src) => /\{typeof children === 'function' \? children\(columnWidth\) : children\}/.test(src),
  keepRowPadding: (src) => prop(src, 'row', 'paddingHorizontal') === 'designSpacing.lg' &&
    prop(src, 'row', 'marginBottom') === 'pageTitleGap',
  // 【第 19 轮第 2 条】到顶额外间距 = 共享组件的 row.paddingTop = sm；且调用页不再各留一份
  rowTopPadding: (src) => prop(src, 'row', 'paddingTop') === 'designSpacing.sm',
  // 结构口径：PageTopInset 之后**直接**就是 DetailPageTitle（中间不许再垫一层容器）。
  // 这比「搜 headerExtraTop 字样」狠：换个名字的垫层也拦得住（见反例 m13b）。
  noPerPageExtraTop: (src) => !/headerExtraTop/.test(src) &&
    /<PageTopInset \/>\s*<DetailPageTitle/.test(src),
  innerHasNoPadding: (src) => {
    const b = block(src, 'inner')
    return b != null && !/padding/.test(b)
  },
}
const minFontScale = Number(constExpr(detailSrc, 'titleMinFontScale'))

// —— 酷狗 / QQ 两页结构一致：Tabs 用 TABS.map 渲染，每列等宽 ——
const pageP = (navId) => ({
  columnCountExpr: (src) => /const COLUMN_COUNT = TABS\.length \+ 1/.test(src),
  equalColumnsProp: (src) => new RegExp(`<DetailPageTitle title=\\{t\\('${navId}'\\)\\} equalColumnsCount=\\{COLUMN_COUNT\\}>`).test(src),
  columnWidthGiven: (src) => {
    const slice = sliceBetween(src, 'TABS.map(', '</ScrollView>')
    // 每个 tab 都由同一个 map 渲染 ⇒ 一处 `{ width: columnWidth }` 覆盖全部 tab 列；
    // 全文件只有这一处（标题列宽度在共享组件里给，页面里不许再出现第二套列宽）
    return countOf(slice, '{ width: columnWidth }') === 1 && countOf(src, '{ width: columnWidth }') === 1
  },
  tabCentered: (src) => prop(src, 'tab', 'alignItems') === "'center'",
  horizontalScroll: (src) => /<ScrollView[\s\S]{0,240}?style=\{styles\.tabsScroll\}[\s\S]{0,240}?horizontal[\s\S]{0,240}?contentContainerStyle=\{styles\.tabsContainer\}/.test(src),
  scrollBox: (src) => prop(src, 'tabsScroll', 'flex') === '1' &&
    prop(src, 'tabsContainer', 'flexDirection') === "'row'" &&
    prop(src, 'tabsContainer', 'alignItems') === "'center'",
  noWrap: (src) => !/flexWrap/.test(src) && !/tabsRow/.test(src),
  textFitEvery: (src) => countOf(src, 'adjustsFontSizeToFit') === countOf(src, 'numberOfLines={1}') &&
    countOf(src, 'adjustsFontSizeToFit') >= 1,
})

const KG_P = pageP('nav_kg_daily_rec')
const TX_P = pageP('nav_tx_daily_rec')

// —— 网易页：主 tab + 子模式 chip 都进同一套等分列 ——
const WYP = {
  columnCountExpr: (src) => /columnCountOf = \(activeTab: 'songs' \| 'playlists'\) => activeTab === 'songs' \? (\d+) : (\d+)/.test(src),
  columnCounts: (src) => {
    const m = /activeTab === 'songs' \? (\d+) : (\d+)/.exec(src)
    return m ? [Number(m[1]), Number(m[2])] : null
  },
  equalColumnsProp: (src) => /<DetailPageTitle title=\{t\('nav_daily_rec'\)\} equalColumnsCount=\{columnCountOf\(activeTab\)\}>/.test(src),
  tabsScroll: (src) => /<ScrollView[\s\S]{0,240}?style=\{styles\.tabsScroll\}[\s\S]{0,240}?horizontal[\s\S]{0,240}?contentContainerStyle=\{styles\.tabsContainer\}/.test(src),
  scrollBox: (src) => prop(src, 'tabsScroll', 'flex') === '1' && prop(src, 'tabsContainer', 'flexDirection') === "'row'",
  noWrap: (src) => !/flexWrap/.test(src) && !/tabsRow/.test(src),
  mainTabWidth: (src) => countOf(src, '{ width: columnWidth }') === 4 && countOf(src, '[styles.subTabColumn, { width: columnWidth }]') === 2,
  chipColumnCentered: (src) => prop(src, 'subTabColumn', 'alignItems') === "'center'",
  chipFit: (src) => prop(src, 'subTab', 'paddingHorizontal') === '6' && countOf(src, 'adjustsFontSizeToFit') === 4,
}

// —— 三页共用的页头间距 / 文字列（「同一高度」） ——
// 到顶间距自第 19 轮第 2 条起在共享组件的 row.paddingTop（见 D.rowTopPadding），
// 页面里不再有 headerExtraTop —— 所以这里只剩下面这组三页逐字一致的文字列。
const tabTextTrio = (src) => [
  prop(src, 'tabText', 'paddingTop'),
  prop(src, 'tabText', 'paddingBottom'),
  prop(src, 'tabText', 'borderBottomWidth'),
]

// —— 标签：从 TABS / JSX 文本节点解析（不抄字面量） ——
const labelsOf = (src) => {
  const m = /const TABS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(src)
  return m ? [...m[1].matchAll(/label:\s*'([^']+)'/g)].map((x) => x[1]) : null
}
const kgTabs = labelsOf(kgSrc)
const txTabs = labelsOf(txSrc)
const wyTextNodes = [...wySrc.matchAll(/>\s*([^<>{}]+?)\s*<\/Text>/g)].map((m) => m[1])

// —— 几何模型 ——
const MAX_COLS = Number(constExpr(detailSrc, 'detailTitleMaxVisibleColumns'))
const PAGES = [
  { name: '酷狗每日推荐', navId: 'nav_kg_daily_rec', items: (kgTabs ? kgTabs.length : 0) + 1, labels: kgTabs || [] },
  { name: 'QQ每日推荐', navId: 'nav_tx_daily_rec', items: (txTabs ? txTabs.length : 0) + 1, labels: txTabs || [] },
  { name: '网易每日推荐', navId: 'nav_daily_rec', items: MAX_COLS > 0 ? 5 : 0, labels: ['推荐歌曲', '推荐歌单', '默认推荐', '风格化推荐'] },
]
for (const p of PAGES) {
  p.columns = Math.min(p.items, MAX_COLS)
  p.title = LANG[p.navId] || ''
}

const SCREENS = [
  { name: 'iPhone 16 Pro Max', w: 430 },
  { name: 'iPhone SE2/3·13 mini', w: 375 },
  { name: 'iPhone SE1（边界，见下）', w: 320 },
]
const availOf = (w) => w - 2 * SP.lg
const colWidthOf = (w, columns) => availOf(w) / columns
const centersOf = (w, columns) => {
  const cw = colWidthOf(w, columns)
  return Array.from({ length: columns }, (_, i) => cw * i + cw / 2)
}

/** 文字宽度近似（em）：CJK 一个字 ≈ 一个字号，拉丁字母 / 数字 ≈ 0.6 个字号 */
const emWidth = (s) => {
  let em = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (/\s/.test(ch)) em += 0.3
    else if (cp >= 0x2e80) em += 1
    else em += 0.6
  }
  return em
}
const TITLE_EM = Math.max(...PAGES.map((p) => emWidth(p.title)))
const TAB_EM = Math.max(...(txTabs || ['']).map(emWidth))

// —— 断言 ——
const A = []
// A 组：共享组件
A.push(['共享组件导出 detailTitleMaxVisibleColumns = 4（「最多同时显示 4 个」的唯一真值）', D.maxVisible4(detailSrc), `= ${constExpr(detailSrc, 'detailTitleMaxVisibleColumns')}`])
A.push(['列数 = Math.min(equalColumnsCount, detailTitleMaxVisibleColumns)（不写字面量 4）', D.clampToMax(detailSrc)])
A.push(['列宽 = 可用宽 / 列数（availableWidth / columnCount）', D.divideByColumns(detailSrc)])
A.push(['可用宽优先取行内容区实测值，首帧才用窗口宽兜底（同口径扣左右内边距）', D.measuredFirst(detailSrc)])
A.push(['onLayout 挂在 styles.inner（无内边距那一层，量到的就是列宽分母）', D.innerMeasured(detailSrc)])
A.push(['实测宽度变化 > 0.5pt 才 setState（布局抖动不引出额外渲染）', D.layoutGuard(detailSrc)])
A.push(['标题列宽行内给：{ width: columnWidth }（与每个 tab 列同宽）', D.titleColumnWidth(detailSrc)])
A.push(['标题列文字水平居中：titleColumn.textAlign = center', D.titleCentered(detailSrc), prop(detailSrc, 'titleColumn', 'textAlign')])
A.push(['标题单行（numberOfLines=1，不换行 ⇒ 不撑破「同一高度」）', D.titleOneLine(detailSrc)])
A.push(['标题放不下自动缩字号（adjustsFontSizeToFit，仅列模式开启）', D.titleAutoFit(detailSrc)])
A.push(['缩字号下限走 titleMinFontScale token（不是字面量）', D.titleMinScaleProp(detailSrc)])
A.push([`titleMinFontScale = ${minFontScale}（0 < x < 1，既能缩又不会小到看不清）`, minFontScale > 0 && minFontScale < 1])
A.push(['渲染回调把同一个列宽下发给 tab：children(columnWidth)', D.childrenCallback(detailSrc)])
A.push(['row 仍是「我的」标题的几何：paddingHorizontal: lg + marginBottom: pageTitleGap（本轮不漂移）', D.keepRowPadding(detailSrc)])
A.push(['row.paddingTop = designSpacing.sm（到顶额外间距的唯一来源，第 19 轮第 2 条）', D.rowTopPadding(detailSrc), prop(detailSrc, 'row', 'paddingTop')])
A.push(['inner（量宽那一层）不含任何 padding（量到的宽度就是列宽分母）', D.innerHasNoPadding(detailSrc)])
A.push(['titleEqual（弹性等分，歌单页在用）保留，未被列模式改写', /titleEqual:\s*\{[\s\S]{0,40}?flex:\s*1/.test(detailSrc)])

// B 组：酷狗（3 列 ≤ 4，全部同时可见）
A.push(['酷狗页：列数 = 标题 + TABS.length（表达式，不写字面量）', KG_P.columnCountExpr(kgSrc)])
A.push([`酷狗页：TABS 标签 = ${(kgTabs || []).join(' / ')}`, kgTabs && kgTabs.length === 2 && kgTabs[0] === '每日推荐' && kgTabs[1] === '新歌速递'])
A.push(["酷狗页：DetailPageTitle 传 equalColumnsCount={COLUMN_COUNT}", KG_P.equalColumnsProp(kgSrc)])
A.push(['酷狗页：每个 tab 列宽 = columnWidth（同一处 map 覆盖全部 tab）', KG_P.columnWidthGiven(kgSrc)])
A.push(['酷狗页：列盒 tab.alignItems = center（文字在列内水平居中）', KG_P.tabCentered(kgSrc), prop(kgSrc, 'tab', 'alignItems')])
A.push(['酷狗页：一行装在横向 ScrollView 里（不再有换行容器）', KG_P.horizontalScroll(kgSrc)])
A.push(['酷狗页：tabsScroll flex:1 / tabsContainer 行向 + 垂直居中', KG_P.scrollBox(kgSrc)])
A.push(['酷狗页：不再有 flexWrap / tabsRow（旧实现清干净）', KG_P.noWrap(kgSrc)])
A.push(['酷狗页：每段 tab 文字都「单行 + 自动缩字号」', KG_P.textFitEvery(kgSrc)])

// C 组：QQ（5 项 → 4 列，用户点名的那 4 个同时可见）
A.push(['QQ页：列数 = 标题 + TABS.length（= 5 → 收敛到 4 列）', TX_P.columnCountExpr(txSrc)])
A.push([`QQ页：TABS 标签 = ${(txTabs || []).join(' / ')}（前 3 个就是 4 列时与标题同屏的那 3 个）`,
  txTabs && txTabs.length === 4 && txTabs.join('/') === '主页推荐/雷达推荐/推荐歌单/推荐新歌'])
A.push(["QQ页：DetailPageTitle 传 equalColumnsCount={COLUMN_COUNT}", TX_P.equalColumnsProp(txSrc)])
A.push(['QQ页：每个 tab 列宽 = columnWidth（同一处 map 覆盖全部 tab）', TX_P.columnWidthGiven(txSrc)])
A.push(['QQ页：列盒 tab.alignItems = center（文字在列内水平居中）', TX_P.tabCentered(txSrc)])
A.push(['QQ页：一行装在横向 ScrollView 里（第 5 个滑出查看，不压缩列宽）', TX_P.horizontalScroll(txSrc)])
A.push(['QQ页：tabsScroll flex:1 / tabsContainer 行向 + 垂直居中', TX_P.scrollBox(txSrc)])
A.push(['QQ页：不再有 flexWrap / tabsRow（旧实现清干净）', TX_P.noWrap(txSrc)])
A.push(['QQ页：每段 tab 文字都「单行 + 自动缩字号」', TX_P.textFitEvery(txSrc)])
A.push(['QQ页：按钮圆角行内覆盖仍在（不回归按钮圆角覆盖）', /borderRadius: buttonRadius\(32\)/.test(txSrc)])

// D 组：网易（songs 5 项 / playlists 3 项 → 4 / 3 列）
A.push(["网易页：列数随模式 = songs 5 项 / playlists 3 项", WYP.columnCountExpr(wySrc), String(WYP.columnCounts(wySrc))])
A.push(["网易页：DetailPageTitle 传 equalColumnsCount={columnCountOf(activeTab)}", WYP.equalColumnsProp(wySrc)])
A.push([`网易页：两个主 tab + 两个子模式 chip 一共 4 处等宽列（主 tab ${2} + chip 列 ${2}）`, WYP.mainTabWidth(wySrc)])
A.push(['网易页：chip 所在列 subTabColumn.alignItems = center（chip 在列内居中）', WYP.chipColumnCentered(wySrc), prop(wySrc, 'subTabColumn', 'alignItems')])
A.push(['网易页：chip 自身宽度贴合文字（paddingHorizontal 6），描边不拉满整列', WYP.chipFit(wySrc)])
A.push(['网易页：flexWrap 换成横向 ScrollView（Pro Max 上不再被挤成两行）', WYP.tabsScroll(wySrc)])
A.push(['网易页：tabsScroll flex:1 / tabsContainer 行向', WYP.scrollBox(wySrc)])
A.push(['网易页：不再有 flexWrap / tabsRow（旧实现清干净）', WYP.noWrap(wySrc)])

// E 组：三页同一高度 / 同一中线 / 同一到顶间距
const kgTrio = tabTextTrio(kgSrc)
const txTrio = tabTextTrio(txSrc)
const wyTrio = tabTextTrio(wySrc)
const trioEqual = (a, b) => a[0] != null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
A.push([`三页 tabText 的三条垂直配平表达式逐字一致（${kgTrio.join(' | ')}）`, trioEqual(kgTrio, txTrio) && trioEqual(kgTrio, wyTrio)])
A.push(['三页到顶间距一致：由共享组件 row.paddingTop = designSpacing.sm 提供（无字面量）',
  D.rowTopPadding(detailSrc), prop(detailSrc, 'row', 'paddingTop')])
A.push(['三页都不再各留一份 headerExtraTop（间距只有一条来源，第 19 轮第 2 条）',
  [kgSrc, txSrc, wySrc].every((s) => D.noPerPageExtraTop(s)),
  [kgSrc, txSrc, wySrc].map((s) => (D.noPerPageExtraTop(s) ? '无' : '有')).join(' / ')])
A.push(['三页都紧跟 PageTopInset 渲染页头（位置锚点同源）', [kgSrc, txSrc, wySrc].every((s) => /<PageTopInset \/>/.test(s))])
A.push(['三页页头都在 PagerView 之外（第 16 轮的「标题固定」不回归）',
  [kgSrc, txSrc, wySrc].every((s) => {
    const h = s.indexOf('const pageHeader = (')
    // 注意用 '<PagerView\n'：useRef<PagerView> 这种泛型引用出现在前面，会假命中
    const p = s.indexOf('<PagerView\n')
    return h >= 0 && p > h
  })])
A.push(['歌单页（弹性三等分那一套）没有误传 equalColumnsCount —— 两套口径互不干扰',
  ['src/screens/Home/Views/KgPlaylist/index.tsx', 'src/screens/Home/Views/TxPlaylist/index.tsx', 'src/screens/Home/Views/MyPlaylist/index.tsx']
    .every((f) => !/equalColumnsCount/.test(read(f)))])

// F 组：垂直中线代数学（与字号 / 行高无关的恒等式）
const kgBal = balanceOf(kgSrc, 'tabText', 'borderBottomWidth', 1)
const txBal = balanceOf(txSrc, 'tabText', 'borderBottomWidth', 1)
const wyBal = balanceOf(wySrc, 'tabText', 'borderBottomWidth', 1)
const chipBal = balanceOf(wySrc, 'subTab', 'borderWidth', 2)
const near0 = (v) => Math.abs(v) < 1e-9
A.push([`下划线 tab 配平：paddingTop(${kgBal.pt}) = paddingBottom(${kgBal.pb}) + 下边框(${kgBal.border})，残差 0pt`,
  near0(kgBal.residual) && near0(txBal.residual) && near0(wyBal.residual), `残差 ${kgBal.residual}/${txBal.residual}/${wyBal.residual}`])
A.push([`网易 chip 配平：paddingTop(${chipBal.pt}) = paddingBottom(${chipBal.pb}) + 上下边框(${chipBal.border})，残差 0pt`,
  near0(chipBal.residual), `残差 ${chipBal.residual}`])
A.push(['不配平时（paddingTop 只留 5）文字整体偏上 = 下边框高，人眼可辨 —— 上面两条会把它拦下',
  Math.abs((5 - 5 - kgBal.border)) > 0.5, `偏移量 = ${Math.abs(5 - 5 - kgBal.border)}pt`])

// G 组：几何模型（平分整宽 / 间距相等 / 不裁字）
const divs = []
const gaps = []
for (const s of SCREENS.slice(0, 2)) {
  for (const p of PAGES) {
    const cw = colWidthOf(s.w, p.columns)
    divs.push(Math.abs(cw * p.columns - availOf(s.w)))
    const c = centersOf(s.w, p.columns)
    for (let i = 1; i < c.length; i++) gaps.push(Math.abs((c[i] - c[i - 1]) - cw))
  }
}
A.push([`列宽 × 列数 ≡ 行内容区宽度（${SCREENS[0].w}/${SCREENS[1].w} 屏 × 三页，误差 < 1e-9）——「平分整个宽度」`,
  divs.every(near0), `最大误差 ${Math.max(...divs)}`])
A.push(['相邻文字块中心差 ≡ 列宽（误差 < 1e-9）——「间距相等」', gaps.every(near0), `最大误差 ${Math.max(...gaps)}`])

const txOn430 = colWidthOf(430, MAX_COLS)
const txOn375 = colWidthOf(375, MAX_COLS)
const longest = PAGES.reduce((a, b) => (emWidth(a.title) >= emWidth(b.title) ? a : b))
const titleWidth = TITLE_EM * TITLE_SIZE
/** 系统为了让文字塞进列里需要的缩放比（= 列宽 / 文字宽）：≥ minimumFontScale 才不会裁字 */
const needOn430 = txOn430 / titleWidth
const needOn375 = txOn375 / titleWidth
const needOn375Max = (txOn375 / (titleWidth * 1.3)).toFixed(3) // 字体大小设置最大档 1.3×
A.push([`最长标题「${longest.title}」= ${TITLE_EM.toFixed(2)}em × ${TITLE_SIZE}pt ≈ ${titleWidth.toFixed(1)}pt，在 ${MAX_COLS} 列里缩到 ${needOn430.toFixed(2)}× / ${needOn375.toFixed(2)}×（≥ 下限 ${minFontScale}）⇒ 不裁字、不换行`,
  needOn430 >= minFontScale && needOn375 >= minFontScale, `${needOn430.toFixed(3)} / ${needOn375.toFixed(3)}`])
A.push([`自动缩字号是「真起作用」的：${MAX_COLS} 列里最长标题放不下（需要缩到 ${needOn430.toFixed(2)}× < 1，否则本可原样显示）`, needOn430 < 1 && needOn375 < 1])
A.push([`最坏一档（375pt 屏 + 字体大小设置 1.3×）仍需 ${needOn375Max}× ≥ 下限 ${minFontScale} ⇒ 这一档也不裁字`,
  Number(needOn375Max) >= minFontScale, needOn375Max])
A.push([`最长 tab 文字「${(txTabs || []).reduce((a, b) => (emWidth(a) >= emWidth(b) ? a : b), '')}」= ${(TAB_EM * 15).toFixed(1)}pt，缩到下限 0.75× 仍 ≤ ${MAX_COLS} 列宽 ${txOn375.toFixed(1)}pt`,
  TAB_EM * 15 * 0.75 <= txOn375, `${(TAB_EM * 15).toFixed(1)} × 0.75 = ${(TAB_EM * 15 * 0.75).toFixed(1)} ≤ ${txOn375.toFixed(1)}`])
A.push([`4 列时与标题同屏的是「标题 + 前 ${MAX_COLS - 1} 个 tab」（QQ 页 = 用户点名的 4 个，第 5 个滑出）`,
  (txTabs || []).slice(0, MAX_COLS - 1).join('/') === '主页推荐/雷达推荐/推荐歌单'])

for (const [label, ok, detail] of A) check(label, ok, detail)

// —— 反例自检：每条修复改回旧实现 / 拆掉接线，都必须被拦下 ——
const neg = (label, mut, orig, pred) => {
  results.push({ label, ok: mut !== orig && !pred(mut) })
  if (!(mut !== orig && !pred(mut))) failed++
}

const m1 = detailSrc.replace('export const detailTitleMaxVisibleColumns = 4', 'export const detailTitleMaxVisibleColumns = 5')
neg('反例 m1：把「最多 4 个」改成 5，A1 判红', m1, detailSrc, D.maxVisible4)

const m2 = detailSrc.replace('Math.min(equalColumnsCount, detailTitleMaxVisibleColumns)', 'equalColumnsCount')
neg('反例 m2：列数不再收敛到上限（直接等于项目数），A2 判红', m2, detailSrc, D.clampToMax)

const m3 = detailSrc.replace('availableWidth / columnCount', 'availableWidth')
neg('反例 m3：列宽不再除以列数（列宽 = 整行宽，装不下、不平分），A3 判红', m3, detailSrc, D.divideByColumns)

const m4 = detailSrc.replace('onLayout={columnCount > 0 ? handleInnerLayout : undefined}', '')
neg('反例 m4：拆掉 inner 的 onLayout（列宽只剩首帧窗口估算，与真实行宽差几 pt），A5 判红', m4, detailSrc, D.innerMeasured)

const m5 = detailSrc.replace("textAlign: 'center',", '')
neg('反例 m5：标题列去掉 textAlign center（标题不再居中于自己那一列），A8 判红', m5, detailSrc, D.titleCentered)

const m6 = detailSrc.replace('adjustsFontSizeToFit={isColumn ? true : undefined}', '')
neg('反例 m6：标题去掉自动缩字号（「QQ每日推荐」在 4 列里被裁成「QQ每日推…」），A10 判红', m6, detailSrc, D.titleAutoFit)

const m7 = kgSrc.replace(' equalColumnsCount={COLUMN_COUNT}', '')
neg('反例 m7：酷狗页删掉 equalColumnsCount（退回「标题按内容宽、tab 各自按内容宽」），B 判红', m7, kgSrc, KG_P.equalColumnsProp)

const m8 = txSrc.replace('{ width: columnWidth },', '')
neg('反例 m8：QQ页 tab 列不再给等分列宽（列宽回到内容宽，间距不等），C 判红', m8, txSrc, TX_P.columnWidthGiven)

const m9 = txSrc.replace('paddingTop: 5 + BorderWidths.normal3,', 'paddingTop: 5,')
neg('反例 m9：QQ页去掉顶部补偿（文字整体偏上 ≈ 下边框 1.4pt），F 判红', m9, txSrc,
  (s) => near0(balanceOf(s, 'tabText', 'borderBottomWidth', 1).residual))

const m10 = wySrc.replace("contentContainerStyle={styles.tabsContainer}", "contentContainerStyle={[styles.tabsContainer, { flexWrap: 'wrap' }]}")
neg('反例 m10：网易页换回 flexWrap（Pro Max 上挤成两行、撑破「同一高度」），D 判红', m10, wySrc, WYP.noWrap)

const m11 = wySrc.split('[styles.subTabColumn, { width: columnWidth }]').join('[styles.subTabColumn]')
neg('反例 m11：网易页 chip 列不再给等分列宽（chip 不再落在自己的列中心），D 判红', m11, wySrc, WYP.mainTabWidth)

const m12 = wySrc.replace("activeTab === 'songs' ? 5 : 3", "activeTab === 'songs' ? 4 : 3")
neg('反例 m12：网易页 songs 列数改 4（chip 不计入列，与主 tab 不同列），D 判红', m12, wySrc,
  (s) => String(WYP.columnCounts(s)) === '5,3')

const m13 = detailSrc.replace('paddingTop: designSpacing.sm,', 'paddingTop: designSpacing.md,')
neg('反例 m13：共享组件把到顶间距改成 md（十个页面「到顶间距一样」被破坏），E 判红', m13, detailSrc,
  D.rowTopPadding)

const m13b = kgSrc.replace('      <PageTopInset />', '      <PageTopInset />\n      <View style={{ paddingTop: 12 }} />')
neg('反例 m13b：酷狗页又加回一份自己的顶部垫层（间距两条来源、比别的页低 12pt），E 判红', m13b, kgSrc,
  D.noPerPageExtraTop)

const m14 = kgSrc.replace("alignItems: 'center',\n  },\n  tabText:", "alignItems: 'flex-start',\n  },\n  tabText:")
neg('反例 m14：酷狗页列盒不再水平居中（文字靠列左，中心不等距），B 判红', m14, kgSrc, KG_P.tabCentered)

// —— 输出 ——
console.log('='.repeat(92))
console.log('「每日推荐顶部标题行：等分列 + 同一中线」契约模型（摘自源码，单位 pt）')
console.log('='.repeat(92))
console.log(`  最多同时显示列数        = ${constExpr(detailSrc, 'detailTitleMaxVisibleColumns')}（列数 = min(项目数, 该值)）`)
console.log(`  标题字号                = ${subTokenExpr} → ${TITLE_SIZE}`)
console.log(`  标题缩字号下限          = ${minFontScale}×（仅 iOS 的 adjustsFontSizeToFit 生效）`)
console.log(`  左右内边距              = designSpacing.lg → ${SP.lg}`)
console.log(`  到顶额外间距            = designSpacing.sm → ${SP.sm}（共享组件 row.paddingTop，PageTopInset 之上）`)
console.log(`  下划线高 / chip 描边    = BorderWidths.normal3 ${BW.normal3} / normal ${BW.normal}`)
console.log(`  垂直配平                = paddingTop ≡ paddingBottom + 边框（下划线 tab ${kgBal.pt} = ${kgBal.pb} + ${kgBal.border}）`)
console.log()
console.log('  页面                项目数   列数   430pt 列宽   375pt 列宽   同屏可见')
for (const p of PAGES) {
  const visible = [p.title, ...p.labels.slice(0, p.columns - 1)]
  console.log(`  ${p.name.padEnd(16)}${String(p.items).padEnd(9)}${String(p.columns).padEnd(7)}` +
    `${colWidthOf(430, p.columns).toFixed(2).padEnd(13)}${colWidthOf(375, p.columns).toFixed(2).padEnd(13)}${visible.join(' / ')}`)
}
console.log()
console.log(`  4 列时第 ${MAX_COLS + 1} 个起滑动查看（QQ 页 = 推荐新歌；网易 songs = 风格化推荐）`)
console.log(`  边界披露：${SCREENS[2].w}pt 屏（iPhone SE1）${MAX_COLS} 列宽仅 ${colWidthOf(SCREENS[2].w, MAX_COLS).toFixed(2)}pt，`)
console.log(`            「${LANG.nav_daily_rec}」${(emWidth(LANG.nav_daily_rec) * TITLE_SIZE).toFixed(0)}pt 需缩到 ` +
  `${(colWidthOf(SCREENS[2].w, MAX_COLS) / (emWidth(LANG.nav_daily_rec) * TITLE_SIZE)).toFixed(2)}×（< 下限 ${minFontScale}）⇒ 缩到下限后截断`)
console.log()

console.log('='.repeat(92))
console.log('断言')
console.log('='.repeat(92))

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
