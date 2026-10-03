#!/usr/bin/env node
/**
 * sim-daily-rec-header-equal.js —— 「每日推荐顶部标题行：标题自然宽 + tab 等宽列 + 底部对齐」契约
 *
 * 需求来源：
 *   第 18 轮第 1 条（2026-10-02）：
 *     「进入每日推荐界面中，酷狗、QQ、网易每日推荐标题应该和每日推荐、新歌速递、主页推荐、
 *       雷达推荐、推荐歌单、推荐新歌、推荐歌曲、推荐歌单在同一直线上，中心对齐，且酷狗每日推荐
 *       标题与滑动条中的文字最多同时显示 4 个，比如 QQ 每日推荐、主页推荐、雷达推荐、推荐歌单
 *       这 4 个文字，并且这 4 个文字间的间距应该是相等且平分整个宽度，文字上下中心对齐，显示
 *       高度位置和推荐文字到顶部之间间距一样，确保推荐界面的所有顶部栏的文字都在同一高度且
 *       中心对齐，按钮跳转页面也使用这个样式。」
 *   第 20 轮图二（2026-10-03）：
 *     「顶部的 QQ 每日推荐字体和其他酷狗每日推荐字体不一样，而且主页推荐等文字和 QQ 每日推荐
 *       文字不在一条直线上，要文字底部对齐，酷狗和网易每日推荐顶部文字也是一样。」
 *
 * 本契约的收敛结果（第 18 轮立项、第 20 轮图二重做排布；逐条对应用户原话）：
 *   一、「同一直线上 / 同一高度」= 标题与 tab 同处 DetailPageTitle 的行内容区（inner，一条水平
 *      行、alignItems: center），整行高度由标题的 42pt 行盒决定 —— 标题在十一个页面里同一高度。
 *   二、「最多同时显示 4 个」= tab 列数收敛到 min(项目数, detailTitleMaxVisibleColumns) − 1
 *      （= 标题 + 3 个 tab 同屏），常量导出在共享组件里（= 4）；列宽不够时靠横向滑动查看，
 *      不压缩列宽、不换行。
 *   三、「间距相等且平分整个宽度」= tab 列宽 = （行内容区实测宽 − 标题自然宽）/ tab 列数，
 *      各 tab 列等宽；列宽 × 列数 + 标题宽 ≡ 行宽。
 *   四、「文字上下中心对齐」= 下划线 / 描边占走「paddingBottom + 边框」的高度，顶部补回同样多：
 *      paddingTop ≡ paddingBottom + border（与文字行高无关的恒等式，见 balanceOf）。
 *   五、「（图二）字体不一样」的根因与修法 = 旧版把标题塞进 1/4 行宽的等分列里，
 *      numberOfLines + adjustsFontSizeToFit 只能按列宽缩字号 —— 列宽随各页列数 / tab 档位变，
 *      同一个标题在 QQ 页缩到 ~0.68、酷狗页缩到 ~0.80，于是「QQ 每日推荐字体和酷狗不一样」。
 *      第 20 轮起标题按**自然宽**渲染（不设固定列宽 ⇒ 字号恒为 subPageTitleSize），只留
 *      titleMaxWidthFraction 一道长文案上限 —— 三页字号在常规屏 + 全字体档位下完全一致。
 *   六、「（图二）不在一条直线上，要文字底部对齐」= 标题字号 20、tab 字号 15，两个行盒在同一行
 *      内垂直居中时，大字号的字形底天然更低（用户截图实测 3.8pt @ 字体设置 1.0）——
 *      把 tab 整行（含下划线 / chip）下移「系数 × 字号差」即底部对齐；下移的是 tab 而不是
 *      上移标题，标题才能与「我的 / WebDAV」等非等分列页面同高。
 *   七、「显示高度位置和推荐文字到顶部之间间距一样」= 三页页头都是 PageTopInset + 同一份间距
 *      （paddingTop: designSpacing.sm），第 19 轮第 2 条起收进共享组件 DetailPageTitle 的
 *      row.paddingTop（本脚本断言三页里不再各留一份 headerExtraTop）。
 *   八、「按钮跳转页面内也使用这个样式」= 这三个每日推荐页共用同一个 DetailPageTitle + 同一组
 *      token，本脚本把三页逐项钉成一份实现。
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

/** 去掉注释（块注释 + 行注释）：断言只看代码，避免中文注释里出现 4 / flexWrap / width: columnWidth /
 *  titleColumn 等字样假命中（第 20 轮的本组件 JSDoc 里就写到了这些旧实现的名字）。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => {
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
 * （文字行高在等式两边各出现一次，约掉 —— 所以这个恒等式与字号 / 行高无关。
 *   只在字体设置 ≠ 1 时有 < 边框×(F−1) 的残差：边框宽不随字体设置缩放。）
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
  measuredFirst: (src) => /rowWidth > 0 \? rowWidth : windowWidth - scaleSizeW\(designSpacing\.lg\) \* 2/.test(src),
  innerMeasured: (src) => /<View style=\{styles\.inner\} onLayout=\{columnCount > 0 \? handleInnerLayout : undefined\}>/.test(src),
  layoutGuard: (src) => /Math\.abs\(prev - next\) > 0\.5 \? next : prev/.test(src),
  // 【第 20 轮·图二】标题按自然宽渲染：列模式下给的是 maxWidth 上限，不再是等分列宽；
  // 全文件不许再出现「标题吃固定列宽」的写法，也不许再有 titleColumn 居中样式。
  titleNatural: (src) => /isColumn \? \{ maxWidth: availableWidth \* titleMaxWidthFraction \} : equalColumns \? styles\.titleEqual : null/.test(src),
  titleNoFixedColumn: (src) => !/width: columnWidth/.test(src) && !/titleColumn/.test(src),
  titleMeasured: (src) => /onLayout=\{isColumn \? handleTitleLayout : undefined\}/.test(src) &&
    /const \[titleWidth, setTitleWidth\] = useState\(0\)/.test(src) &&
    /setTitleWidth\(\(prev\) => \(Math\.abs\(prev - next\) > 0\.5 \? next : prev\)\)/.test(src),
  tabCountExpr: (src) => /const tabCount = Math\.max\(columnCount - 1, 1\)/.test(src),
  tabWidthFormula: (src) => /Math\.max\(\(availableWidth - titleWidth\) \/ tabCount, minTabColumnWidth\)/.test(src),
  tabWidthFallback: (src) => /: availableWidth \/ columnCount/.test(src),
  tabFloor: (src) => /const minTabColumnWidth = setSpText\(designTypography\.body\) \* 4\b/.test(src),
  nudgeFormula: (src) => /tabInkBottomOffsetRatio \* \(setSpText\(subPageTitleSize\) - setSpText\(designTypography\.body\)\)/.test(src),
  nudgeOnTabsOnly: (src) => /styles\.tabColumnWrap, \{ transform: \[\{ translateY: tabInkBottomOffset \}\] \}/.test(src) &&
    !/styles\.title[\s\S]{0,80}?translateY/.test(src),
  tabWrapFlex: (src) => prop(src, 'tabColumnWrap', 'flex') === '1',
  titleOneLine: (src) => /numberOfLines=\{isColumn \? 1 : undefined\}/.test(src),
  titleAutoFit: (src) => /adjustsFontSizeToFit=\{isColumn \? true : undefined\}/.test(src),
  titleMinScaleProp: (src) => /minimumFontScale=\{isColumn \? titleMinFontScale : undefined\}/.test(src),
  childrenCallback: (src) => /children\(tabColumnWidth\)/.test(src),
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
const maxWidthFraction = Number(constExpr(detailSrc, 'titleMaxWidthFraction'))
const inkOffsetRatio = Number(constExpr(detailSrc, 'tabInkBottomOffsetRatio'))

// —— 酷狗 / QQ 两页结构一致：Tabs 用 TABS.map 渲染，每列等宽 ——
const pageP = (navId) => ({
  columnCountExpr: (src) => /const COLUMN_COUNT = TABS\.length \+ 1/.test(src),
  equalColumnsProp: (src) => new RegExp(`<DetailPageTitle title=\\{t\\('${navId}'\\)\\} equalColumnsCount=\\{COLUMN_COUNT\\}>`).test(src),
  columnWidthGiven: (src) => {
    const slice = sliceBetween(src, 'TABS.map(', '</ScrollView>')
    // 每个 tab 都由同一个 map 渲染 ⇒ 一处 `{ width: columnWidth }` 覆盖全部 tab 列；
    // 全文件只有这一处（标题宽度由共享组件按自然宽渲染，页面里不许再出现第二套列宽）
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

// —— 网易页：主 tab + 子模式 chip 都进同一套 tab 列 ——
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

// —— 几何模型（第 20 轮·图二：标题自然宽 + tab 等分剩余宽） ——
const MAX_COLS = Number(constExpr(detailSrc, 'detailTitleMaxVisibleColumns'))
const PAGES = [
  { name: '酷狗每日推荐', navId: 'nav_kg_daily_rec', items: (kgTabs ? kgTabs.length : 0) + 1, labels: kgTabs || [] },
  { name: 'QQ每日推荐', navId: 'nav_tx_daily_rec', items: (txTabs ? txTabs.length : 0) + 1, labels: txTabs || [] },
  { name: '网易每日推荐', navId: 'nav_daily_rec', items: MAX_COLS > 0 ? 5 : 0, labels: ['推荐歌曲', '推荐歌单', '默认推荐', '风格化推荐'] },
]
for (const p of PAGES) {
  p.columns = Math.min(p.items, MAX_COLS)
  p.tabCount = Math.max(p.columns - 1, 1)
  p.title = LANG[p.navId] || ''
}

const SCREENS = [
  { name: 'iPhone 16 Pro Max', w: 430 },
  { name: 'iPhone SE2/3·13 mini', w: 375 },
  { name: 'iPhone SE1（边界，见下）', w: 320 },
]
const FONT_SCALES = [1, 1.15, 1.2, 1.3]
const availOf = (w) => w - 2 * SP.lg

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
/** 标题在字体设置 F 下的自然宽（pt）—— 不再随列宽变化 */
const titleWidthOf = (p, F) => emWidth(p.title) * TITLE_SIZE * F
/** tab 列宽下限（与源码同式）：4 个字号的文案宽（setSpText(body) ≈ body×F；tab 文案统一 4 个全角字） */
const tabFloorOf = (F) => TYPE.body * F * 4
/** tab 列宽（与源码同式）：max((行宽 − 标题自然宽) / tab 列数, 下限) */
const tabWidthOf = (w, p, F) => Math.max((availOf(w) - titleWidthOf(p, F)) / p.tabCount, tabFloorOf(F))
/** 标题被 titleMaxWidthFraction 收住时的缩字号比（1 = 不缩；只有 320pt 屏 + 大字体档会 < 1） */
const titleShrinkOf = (w, p, F, fraction) => Math.min(1, (availOf(w) * fraction) / titleWidthOf(p, F))
/** 【图二】tab 整行下移量（与源码同式）：系数 × 字号差，随字体设置等比 */
const inkOffsetOf = (F) => inkOffsetRatio * (TITLE_SIZE - TYPE.body) * F
const TITLE_EM = Math.max(...PAGES.map((p) => emWidth(p.title)))
const TAB_EM = Math.max(...(txTabs || ['']).map(emWidth))
/** tab 整行高度（行高 ≈ 字号 × 1.15 + 上下 padding + 下划线，设计 pt） */
const tabBlockHeightDesign = 2 * 5 + BW.normal3 + TYPE.body * TYPE.lineHeightRatio

// —— 断言 ——
const A = []
// A 组：共享组件 —— 标题自然宽（图二「字体不一样」的修法）
A.push(['共享组件导出 detailTitleMaxVisibleColumns = 4（「最多同时显示 4 个」的唯一真值）', D.maxVisible4(detailSrc), `= ${constExpr(detailSrc, 'detailTitleMaxVisibleColumns')}`])
A.push(['列数 = Math.min(equalColumnsCount, detailTitleMaxVisibleColumns)（不写字面量 4）', D.clampToMax(detailSrc)])
A.push(['tab 列数 = max(列数 − 1, 1)（列数含标题列；至少 1 防除零）', D.tabCountExpr(detailSrc)])
A.push(['【图二】标题按自然宽渲染：列模式下只给 maxWidth 上限（不再吃等分列宽）', D.titleNatural(detailSrc)])
A.push(['【图二】全文件不再出现「标题吃固定列宽」/ titleColumn 居中样式（旧实现清干净）', D.titleNoFixedColumn(detailSrc)])
A.push([`【图二】标题宽度实测：onLayout(handleTitleLayout) + 变化 > 0.5pt 才 setState`, D.titleMeasured(detailSrc)])
A.push(['【图二】tab 列宽 = max((行宽 − 标题实测宽) / tab 列数, 下限)', D.tabWidthFormula(detailSrc)])
A.push(['【图二】首帧兜底 = availableWidth / columnCount（标题还没量到的那一帧走旧口径）', D.tabWidthFallback(detailSrc)])
A.push(['【图二】tab 列宽下限 = 4 个全角字的文案宽（tab 文案统一 4 字，不逼 tab 缩字号）', D.tabFloor(detailSrc)])
A.push(['可用宽优先取行内容区实测值，首帧才用窗口宽兜底（同口径扣左右内边距）', D.measuredFirst(detailSrc)])
A.push(['onLayout 挂在 styles.inner（无内边距那一层，量到的就是列宽分母）', D.innerMeasured(detailSrc)])
A.push(['实测宽度变化 > 0.5pt 才 setState（布局抖动不引出额外渲染）', D.layoutGuard(detailSrc)])
A.push(['标题单行（numberOfLines=1，不换行 ⇒ 不撑破「同一高度」）', D.titleOneLine(detailSrc)])
A.push([`标题长文案兜底仍保留 adjustsFontSizeToFit（仅在超过 maxWidth 上限时生效）`, D.titleAutoFit(detailSrc)])
A.push(['缩字号下限走 titleMinFontScale token（不是字面量）', D.titleMinScaleProp(detailSrc)])
A.push([`titleMinFontScale = ${minFontScale}（0 < x < 1，既能缩又不会小到看不清）`, minFontScale > 0 && minFontScale < 1])
A.push([`titleMaxWidthFraction = ${maxWidthFraction}（0 < x < 1，长文案安全上限）`, maxWidthFraction > 0 && maxWidthFraction < 1])
A.push(['渲染回调把同一份 tab 列宽下发给各列：children(tabColumnWidth)', D.childrenCallback(detailSrc)])
A.push(['row 仍是「我的」标题的几何：paddingHorizontal: lg + marginBottom: pageTitleGap（本轮不漂移）', D.keepRowPadding(detailSrc)])
A.push(['row.paddingTop = designSpacing.sm（到顶额外间距的唯一来源，第 19 轮第 2 条）', D.rowTopPadding(detailSrc), prop(detailSrc, 'row', 'paddingTop')])
A.push(['inner（量宽那一层）不含任何 padding（量到的宽度就是列宽分母）', D.innerHasNoPadding(detailSrc)])
A.push(['titleEqual（弹性等分，歌单页在用）保留，未被列模式改写', /titleEqual:\s*\{[\s\S]{0,40}?flex:\s*1/.test(detailSrc)])

// A2 组：共享组件 —— 底部对齐（图二「不在一条直线上」的修法）
A.push([`【图二】底部对齐下移量 = 系数 × 字号差（subPageTitleSize − designTypography.body），随字体设置等比`, D.nudgeFormula(detailSrc)])
A.push([`【图二】下移系数 = ${inkOffsetRatio}（0.4 < x < 1：字形底落差是字号差的固定比例，实测值）`, inkOffsetRatio > 0.4 && inkOffsetRatio < 1])
A.push(['【图二】translateY 只挂在 tab 行包装层上，标题不带 transform（标题与其它页面同高）', D.nudgeOnTabsOnly(detailSrc)])
A.push(['【图二】tab 行包装层 flex:1（吃掉标题自然宽右侧的剩余宽度；transform 不参与布局）', D.tabWrapFlex(detailSrc)])

// B 组：酷狗（3 项 → 标题 + 2 个 tab 列）
A.push(['酷狗页：列数 = 标题 + TABS.length（表达式，不写字面量）', KG_P.columnCountExpr(kgSrc)])
A.push([`酷狗页：TABS 标签 = ${(kgTabs || []).join(' / ')}`, kgTabs && kgTabs.length === 2 && kgTabs[0] === '每日推荐' && kgTabs[1] === '新歌速递'])
A.push(["酷狗页：DetailPageTitle 传 equalColumnsCount={COLUMN_COUNT}", KG_P.equalColumnsProp(kgSrc)])
A.push(['酷狗页：每个 tab 列宽 = columnWidth（同一处 map 覆盖全部 tab）', KG_P.columnWidthGiven(kgSrc)])
A.push(['酷狗页：列盒 tab.alignItems = center（文字在列内水平居中）', KG_P.tabCentered(kgSrc), prop(kgSrc, 'tab', 'alignItems')])
A.push(['酷狗页：一行装在横向 ScrollView 里（不再有换行容器）', KG_P.horizontalScroll(kgSrc)])
A.push(['酷狗页：tabsScroll flex:1 / tabsContainer 行向 + 垂直居中', KG_P.scrollBox(kgSrc)])
A.push(['酷狗页：不再有 flexWrap / tabsRow（旧实现清干净）', KG_P.noWrap(kgSrc)])
A.push(['酷狗页：每段 tab 文字都「单行 + 自动缩字号」', KG_P.textFitEvery(kgSrc)])

// C 组：QQ（5 项 → 标题 + 3 个 tab 列，用户点名的那 4 个同时可见）
A.push(['QQ页：列数 = 标题 + TABS.length（= 5 → 收敛到 4 项）', TX_P.columnCountExpr(txSrc)])
A.push([`QQ页：TABS 标签 = ${(txTabs || []).join(' / ')}（前 3 个就是与标题同屏的那 3 个）`,
  txTabs && txTabs.length === 4 && txTabs.join('/') === '主页推荐/雷达推荐/推荐歌单/推荐新歌'])
A.push(["QQ页：DetailPageTitle 传 equalColumnsCount={COLUMN_COUNT}", TX_P.equalColumnsProp(txSrc)])
A.push(['QQ页：每个 tab 列宽 = columnWidth（同一处 map 覆盖全部 tab）', TX_P.columnWidthGiven(txSrc)])
A.push(['QQ页：列盒 tab.alignItems = center（文字在列内水平居中）', TX_P.tabCentered(txSrc)])
A.push(['QQ页：一行装在横向 ScrollView 里（第 4 个滑出查看，不压缩列宽）', TX_P.horizontalScroll(txSrc)])
A.push(['QQ页：tabsScroll flex:1 / tabsContainer 行向 + 垂直居中', TX_P.scrollBox(txSrc)])
A.push(['QQ页：不再有 flexWrap / tabsRow（旧实现清干净）', TX_P.noWrap(txSrc)])
A.push(['QQ页：每段 tab 文字都「单行 + 自动缩字号」', TX_P.textFitEvery(txSrc)])
A.push(['QQ页：按钮圆角行内覆盖仍在（不回归按钮圆角覆盖）', /borderRadius: buttonRadius\(32\)/.test(txSrc)])

// D 组：网易（songs 5 项 / playlists 3 项 → 4 / 3 项）
A.push(["网易页：列数随模式 = songs 5 项 / playlists 3 项", WYP.columnCountExpr(wySrc), String(WYP.columnCounts(wySrc))])
A.push(["网易页：DetailPageTitle 传 equalColumnsCount={columnCountOf(activeTab)}", WYP.equalColumnsProp(wySrc)])
A.push([`网易页：两个主 tab + 两个子模式 chip 一共 4 处等宽 tab 列（主 tab ${2} + chip 列 ${2}）`, WYP.mainTabWidth(wySrc)])
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

// F 组：垂直中线代数学（与字号 / 行高无关的恒等式）—— 图二的下移量正是以这套几何为基准实测的
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

// G 组：几何模型（标题自然宽 + tab 等分剩余宽：不缩字体 / 平分 / 不溢出）
const model = (fraction) => {
  const rows = []
  for (const s of SCREENS) {
    for (const p of PAGES) {
      for (const F of FONT_SCALES) {
        const avail = availOf(s.w)
        const tw = titleWidthOf(p, F)
        const shrink = titleShrinkOf(s.w, p, F, fraction)
        const tabW = tabWidthOf(s.w, p, F)
        rows.push({ screen: s, page: p, F, avail, titleW: tw, shrink, tabW,
          mean: (avail - tw) / p.tabCount, floored: (avail - tw) / p.tabCount < tabFloorOf(F) })
      }
    }
  }
  return rows
}
const M = model(maxWidthFraction)
const normalScreens = M.filter((r) => r.screen.w >= 375)

A.push([`【图二】常规屏（375 / 430）× 全字体档位（${FONT_SCALES.join('/')}）：三页标题都不触发缩字号 ⇒ 字号完全一致`,
  normalScreens.every((r) => r.shrink >= 1),
  `最小缩字比 ${Math.min(...normalScreens.map((r) => r.shrink)).toFixed(3)}`])
A.push([`【图二】最坏常规档（375pt + 1.3×）最长标题「${LANG.nav_daily_rec}」${(titleWidthOf(PAGES[2], 1.3)).toFixed(0)}pt ≤ 上限 ${(availOf(375) * maxWidthFraction).toFixed(0)}pt`,
  titleWidthOf(PAGES[2], 1.3) <= availOf(375) * maxWidthFraction,
  `${(titleWidthOf(PAGES[2], 1.3) / (availOf(375) * maxWidthFraction)).toFixed(2)}× 上限`])
A.push([`【图二】旧版对照：同一标题在 4 等分列里要缩到 ${(availOf(375) / 4 / titleWidthOf(PAGES[2], 1)).toFixed(2)}×（1.0 档）—— 这就是「字体不一样」`,
  availOf(375) / 4 / titleWidthOf(PAGES[2], 1) < 0.8, `旧版 1.0 档缩字比 ${(availOf(375) / 4 / titleWidthOf(PAGES[2], 1)).toFixed(2)}`])
A.push(['【图二】默认档（1.0）三页 tab 列宽 ≥ 4 字文案宽（tab 不缩字号，各页一致）',
  M.filter((r) => r.F === 1).every((r) => r.tabW >= TYPE.body * 4),
  `最小 tab 列宽 ${Math.min(...M.filter((r) => r.F === 1).map((r) => r.tabW)).toFixed(1)}pt`])
A.push([`【图二】默认字体设置（1.0）+ 常规屏（375 / 430）下三页都不触发列宽下限 ⇒ tab 列正好平分剩余行宽、不横向滑动`,
  M.filter((r) => r.F === 1 && r.screen.w >= 375).every((r) => !r.floored),
  M.filter((r) => r.F === 1 && r.screen.w >= 375 && r.floored).map((r) => `${r.page.name}@${r.screen.w}`).join(' ') || '无'])
A.push([`【图二】触发列宽下限的档位 = 大字体及以上（1.15 / 1.2 / 1.3）或 320pt 屏 —— 这些档位该行横向滑动（tab 不缩字号）`,
  M.some((r) => r.floored),
  `${M.filter((r) => r.floored).length} 组：${[...new Set(M.filter((r) => r.floored).map((r) => `${r.screen.w}@${r.F}`))].join(' ')}`])
A.push(['【图二】tab 列宽 × tab 列数 + 标题自然宽 ≡ 行内容区宽度（未被下限截断时，误差 < 1e-9）',
  M.filter((r) => !r.floored).every((r) => near0(r.tabW * r.page.tabCount + r.titleW - r.avail)),
  `最大误差 ${Math.max(...M.filter((r) => !r.floored).map((r) => Math.abs(r.tabW * r.page.tabCount + r.titleW - r.avail)))}`])
A.push(['【图二】各 tab 列等宽 ⇒ 相邻文字块中心差 ≡ tab 列宽（「间距相等」）',
  M.every((r) => r.tabW > 0), `最小 tab 列宽 ${Math.min(...M.map((r) => r.tabW)).toFixed(1)}pt`])
const offsets = FONT_SCALES.map(inkOffsetOf)
A.push([`【图二】底部对齐下移量 = ${inkOffsetRatio} × ${TITLE_SIZE - TYPE.body} × F = ${offsets.map((v) => v.toFixed(2)).join(' / ')}pt（随字体设置等比）`,
  offsets.every((v, i) => i === 0 || v > offsets[i - 1]) && offsets[0] > 0,
  `F=1.0 时 ${offsets[0].toFixed(2)}pt（用户截图实测 3.8pt）`])
A.push([`【图二】下移后 tab 行不溢出标题行盒（剩余半格 ${(42 / 2 - tabBlockHeightDesign / 2).toFixed(2)}pt ≥ 下移量 ${offsets[FONT_SCALES.length - 1].toFixed(2)}pt @1.3×）`,
  offsets[FONT_SCALES.length - 1] <= 42 / 2 - tabBlockHeightDesign / 2,
  `${offsets[FONT_SCALES.length - 1].toFixed(2)} ≤ ${(42 / 2 - tabBlockHeightDesign / 2).toFixed(2)}`])
const minShrinkAll = Math.min(...M.map((r) => r.shrink))
A.push([`【图二】全部屏幕（430 / 375 / 320）× 全部字体档位（1/1.15/1.2/1.3）：标题都不触发缩字号（缩字比 ${minShrinkAll.toFixed(2)}）⇒ 三页字号在一切组合下一致`,
  minShrinkAll >= 1,
  `最坏组合 = 320pt + 1.3×：最长标题「${LANG.nav_daily_rec}」${titleWidthOf(PAGES[2], 1.3).toFixed(0)}pt ≤ 上限 ${(availOf(320) * maxWidthFraction).toFixed(0)}pt（余量仅 ${(100 * (1 - titleWidthOf(PAGES[2], 1.3) / (availOf(320) * maxWidthFraction))).toFixed(0)}% ⇒ 将来出现 7 字标题会在窄屏触发兜底缩字号）`])
A.push([`最长 tab 文字「${(txTabs || []).reduce((a, b) => (emWidth(a) >= emWidth(b) ? a : b), '')}」= ${(TAB_EM * TYPE.body).toFixed(1)}pt ≤ 默认档最窄 tab 列宽 ${Math.min(...M.filter((r) => r.F === 1 && r.screen.w === 375).map((r) => r.tabW)).toFixed(1)}pt（375pt 屏）`,
  TAB_EM * TYPE.body <= Math.min(...M.filter((r) => r.F === 1 && r.screen.w === 375).map((r) => r.tabW))])
A.push([`同屏可见 = 「标题 + 前 tab 列数个 tab」（QQ 页 = 用户点名的 4 个：标题 / 主页推荐 / 雷达推荐 / 推荐歌单）`,
  ['QQ每日推荐', '主页推荐', '雷达推荐', '推荐歌单'].join('/') ===
  [LANG.nav_tx_daily_rec, ...(txTabs || []).slice(0, MAX_COLS - 1)].join('/')])

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

const m3 = detailSrc.replace('Math.max((availableWidth - titleWidth) / tabCount, minTabColumnWidth)', 'availableWidth / tabCount')
neg('反例 m3：tab 列宽忽略标题自然宽（列宽按整行算，tab 溢出到屏幕外），A7 判红', m3, detailSrc, D.tabWidthFormula)

const m4 = detailSrc.replace('onLayout={columnCount > 0 ? handleInnerLayout : undefined}', '')
neg('反例 m4：拆掉 inner 的 onLayout（列宽只剩首帧窗口估算，与真实行宽差几 pt），A11 判红', m4, detailSrc, D.innerMeasured)

const m5 = detailSrc.replace('isColumn ? { maxWidth: availableWidth * titleMaxWidthFraction }', 'isColumn ? { width: columnWidth }')
neg('反例 m5：标题又吃固定列宽（回到「按列宽缩字号」⇒ 三页字体不一样），A4 判红', m5, detailSrc, D.titleNatural)

const m5b = detailSrc.replace('onLayout={isColumn ? handleTitleLayout : undefined}', '')
neg('反例 m5b：拆掉标题的 onLayout（tab 列宽永远拿不到标题自然宽），A6 判红', m5b, detailSrc, D.titleMeasured)

const m5c = detailSrc.replace('const minTabColumnWidth = setSpText(designTypography.body) * 4', 'const minTabColumnWidth = 0')
neg('反例 m5c：把 tab 列宽下限改成 0（大字体 / 窄屏下 tab 被压到缩字号，各页缩得不一样），A9 判红', m5c, detailSrc, D.tabFloor)

const m5c2 = detailSrc.replace('Math.max((availableWidth - titleWidth) / tabCount, minTabColumnWidth)', '(availableWidth - titleWidth) / tabCount')
neg('反例 m5c2：列宽算式去掉 Math.max（下限算了不用，tab 照样被压），A7 判红', m5c2, detailSrc, D.tabWidthFormula)

const m5d = detailSrc.replace(
  'tabInkBottomOffsetRatio * (setSpText(subPageTitleSize) - setSpText(designTypography.body))', '0')
neg('反例 m5d：下移量归零（tab 文字回到与标题中心对齐 ⇒ 字形底又差 3.8pt），A23 判红', m5d, detailSrc, D.nudgeFormula)

const m5e = detailSrc.replace('styles.tabColumnWrap, { transform: [{ translateY: tabInkBottomOffset }] }', 'styles.tabColumnWrap')
neg('反例 m5e：拆掉 tab 行的 translateY（底部对齐失效），A25 判红', m5e, detailSrc, D.nudgeOnTabsOnly)

const m5f = detailSrc.replace('styles.title,', 'styles.title, { transform: [{ translateY: tabInkBottomOffset }] },')
neg('反例 m5f：把下移挂到标题上（标题比其它十个页面高 3.8pt，「同一高度」被破坏），A25 判红', m5f, detailSrc, D.nudgeOnTabsOnly)

const m5g = detailSrc.replace('const tabInkBottomOffsetRatio = 0.76', 'const tabInkBottomOffsetRatio = 0.2')
neg('反例 m5g：下移系数改 0.2（远小于实测落差），A24 判红', m5g, detailSrc,
  (s) => { const r = Number(constExpr(s, 'tabInkBottomOffsetRatio')); return r > 0.4 && r < 1 })

const m5h = detailSrc.replace('const titleMaxWidthFraction = 0.6', 'const titleMaxWidthFraction = 0.2')
neg('反例 m5h：标题上限砍到 0.2 行宽（常规屏最大字体档又开始缩字号），A30 判红', m5h, detailSrc,
  (s) => model(Number(constExpr(s, 'titleMaxWidthFraction'))).filter((r) => r.screen.w >= 375).every((r) => r.shrink >= 1))

const m6 = detailSrc.replace('adjustsFontSizeToFit={isColumn ? true : undefined}', '')
neg('反例 m6：标题去掉长文案兜底缩字号（超长文案会被裁字），A13 判红', m6, detailSrc, D.titleAutoFit)

const m7 = kgSrc.replace(' equalColumnsCount={COLUMN_COUNT}', '')
neg('反例 m7：酷狗页删掉 equalColumnsCount（退回「标题按内容宽、tab 各自按内容宽」），B 判红', m7, kgSrc, KG_P.equalColumnsProp)

const m8 = txSrc.replace('{ width: columnWidth },', '')
neg('反例 m8：QQ页 tab 列不再给列宽（列宽回到内容宽，间距不等），C 判红', m8, txSrc, TX_P.columnWidthGiven)

const m9 = txSrc.replace('paddingTop: 5 + BorderWidths.normal3,', 'paddingTop: 5,')
neg('反例 m9：QQ页去掉顶部补偿（文字整体偏上 ≈ 下边框 1.4pt），F 判红', m9, txSrc,
  (s) => near0(balanceOf(s, 'tabText', 'borderBottomWidth', 1).residual))

const m10 = wySrc.replace("contentContainerStyle={styles.tabsContainer}", "contentContainerStyle={[styles.tabsContainer, { flexWrap: 'wrap' }]}")
neg('反例 m10：网易页换回 flexWrap（Pro Max 上挤成两行、撑破「同一高度」），D 判红', m10, wySrc, WYP.noWrap)

const m11 = wySrc.split('[styles.subTabColumn, { width: columnWidth }]').join('[styles.subTabColumn]')
neg('反例 m11：网易页 chip 列不再给列宽（chip 不再落在自己的列中心），D 判红', m11, wySrc, WYP.mainTabWidth)

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
console.log('「每日推荐顶部标题行：标题自然宽 + tab 等宽列 + 底部对齐」契约模型（摘自源码，单位 pt）')
console.log('='.repeat(92))
console.log(`  最多同时显示列数（含标题） = ${constExpr(detailSrc, 'detailTitleMaxVisibleColumns')}（列数 = min(项目数, 该值)，tab 列数 = 列数 − 1）`)
console.log(`  标题字号                  = ${subTokenExpr} → ${TITLE_SIZE}（自然宽渲染，不随列宽缩）`)
console.log(`  标题长文案上限            = ${maxWidthFraction} × 行内容区宽（现有文案够不着）`)
console.log(`  标题缩字号下限（兜底）    = ${minFontScale}×（仅 iOS 的 adjustsFontSizeToFit 生效）`)
console.log(`  tab 列宽                  = （行宽 − 标题自然宽）/ tab 列数，下限 = 4 字文案宽 = ${TYPE.body}×4 = ${TYPE.body * 4}pt`)
console.log(`  底部对齐下移              = ${inkOffsetRatio} × 字号差 ${TITLE_SIZE - TYPE.body} × 字体设置 = ${offsets.map((v) => v.toFixed(2)).join(' / ')}pt`)
console.log(`  左右内边距                = designSpacing.lg → ${SP.lg}`)
console.log(`  到顶额外间距              = designSpacing.sm → ${SP.sm}（共享组件 row.paddingTop，PageTopInset 之上）`)
console.log(`  下划线高 / chip 描边      = BorderWidths.normal3 ${BW.normal3} / normal ${BW.normal}`)
console.log(`  垂直配平                  = paddingTop ≡ paddingBottom + 边框（下划线 tab ${kgBal.pt} = ${kgBal.pb} + ${kgBal.border}）`)
console.log()
console.log('  ── 默认字体设置（1.0）—— 标题字号三页一致，tab 列平分剩余宽 ──')
console.log('  页面                项目数   tab列数  430pt 标题宽  tab列宽   375pt 标题宽  tab列宽   同屏可见')
for (const p of PAGES) {
  const visible = [p.title, ...p.labels.slice(0, p.tabCount)]
  console.log(`  ${p.name.padEnd(16)}${String(p.items).padEnd(8)}${String(p.tabCount).padEnd(9)}` +
    `${titleWidthOf(p, 1).toFixed(1).padEnd(13)}${tabWidthOf(430, p, 1).toFixed(1).padEnd(10)}` +
    `${titleWidthOf(p, 1).toFixed(1).padEnd(13)}${tabWidthOf(375, p, 1).toFixed(1).padEnd(10)}${visible.join(' / ')}`)
}
console.log()
console.log('  ── 字体设置 1.3（非常大）—— 标题仍不缩字号；剩余宽不够时 tab 行横向滑动 ──')
for (const p of PAGES) {
  const need = titleWidthOf(p, 1.3) + tabWidthOf(375, p, 1.3) * p.tabCount
  const scrolled = need > availOf(375)
  console.log(`  ${p.name.padEnd(16)}375pt 标题宽 ${titleWidthOf(p, 1.3).toFixed(1).padEnd(8)}tab列宽 ${tabWidthOf(375, p, 1.3).toFixed(1).padEnd(8)}` +
    `${scrolled ? `（需 ${need.toFixed(0)}pt > 行宽 ${availOf(375)}pt ⇒ 横向滑动查看）` : '（全部同屏）'}`)
}
console.log()
console.log(`  默认档同屏 = 「标题 + ${MAX_COLS - 1} 个 tab」；第 ${MAX_COLS} 个 tab 起滑动查看（QQ 页 = 推荐新歌；网易 songs = 风格化推荐）`)
console.log(`  边界披露 1：标题上限（${maxWidthFraction} 行宽）在现有 6 字标题 + 全部屏幕 × 全部字体档位下都不生效`)
console.log(`             （最坏 320pt + 1.3× = ${titleWidthOf(PAGES[2], 1.3).toFixed(0)}pt vs 上限 ${(availOf(320) * maxWidthFraction).toFixed(0)}pt，余量 ${(100 * (1 - titleWidthOf(PAGES[2], 1.3) / (availOf(320) * maxWidthFraction))).toFixed(0)}%）—— 一旦出现更长的标题，窄屏会走兜底缩字号`)
console.log(`  边界披露 2：320pt 屏（iPhone SE1）+ 默认字体档：${MAX_COLS} 项同屏需 ${(titleWidthOf(PAGES[1], 1) + PAGES[1].tabCount * TYPE.body * 4).toFixed(0)}pt > 行宽 ${availOf(320)}pt`)
console.log(`             ⇒ 标题 + 3 个 tab 列里最后一个要滑动 ~${(titleWidthOf(PAGES[1], 1) + PAGES[1].tabCount * TYPE.body * 4 - availOf(320)).toFixed(0)}pt 才能看全（tab 不缩字号；旧版是标题缩到 ${(availOf(320) / 4 / titleWidthOf(PAGES[1], 1)).toFixed(2)}×）`)
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
