/**
 * ① 「四页标题共线」契约（第六轮需求 1 的钉子）。
 *
 * 需求原话：推荐页标题下的「酷我音乐 / 酷狗音乐」一栏与歌单页那一栏上下位置不在
 * 同一直线；下面文字按钮之间的间距要一致，不要有的太近有的太远；搜索栏界面、我的
 * 界面也一样，用最合适的间距。
 *
 * 收敛结果（第六轮）：三个 token 成为唯一真值来源 ——
 *   · pageTitleLineHeight = 42      大标题行高（推荐 42 / 我的 36 / 歌单 36 三套值的收敛）
 *   · pageTitleGap = md(16)         标题行 → 下方第一行内容
 *   · controlGap  = sm(12)          同一按钮行内 / 相邻按钮行间距
 *
 * 本脚本从源码解析实际取值（不硬编码任何页面数值），断言：
 *   A. 三个 token 的存在性与取值关系；
 *   B. 四个「大标题页」（推荐 Discovery / 歌单 SongList.HeaderBar / 我的 NewListUI /
 *      设置 PageHeader）都通过 token 取行高与下间距，且**没有**硬编码的数字行高；
 *   C. 42 这个取值本身的两个约束：等于推荐页 42pt 圆钮（它是基准）、≥ 34 × 1.15（不裁笔画）；
 *   D. 三页共用的 PlatformChips 走 controlGap，搜索页各行也走 controlGap；
 *   D2（第 19 轮第 2 条）：搜索页三处「标题 → 自己的内容」间距同源同值 ——
 *      搜索平台（HeaderBar.platformContent.paddingVertical）、热门搜索（HotSearch.title.marginBottom）、
 *      历史搜索（HistorySearch.titleContent.marginBottom）都走 controlGap(12)，各自不得再有硬编码数字；
 *   E. 反例自检：把上述任一消费点改回硬编码数字、或把 token 值改掉，必须被判不合格
 *      （证明断言真的在盯源码，而不是把当前值抄了一遍）。
 *
 * 运行：node scripts/sim-page-title-align.js
 */

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

// --- DesignTokens 解析 ---
const tokensSrc = read('src/theme/DesignTokens.ts')

// designSpacing 单独取块：designRadius 里也有 sm/md/lg/xl 同名键，整份文件一起扫会串值。
const spacingBlock = /designSpacing = \{([^}]*)\}/.exec(tokensSrc)
if (!spacingBlock) throw new Error('DesignTokens.ts 里找不到 designSpacing 块')
const spacing = {}
for (const m of spacingBlock[1].matchAll(/(\w+):\s*(\d+)/g)) spacing[m[1]] = Number(m[2])

const typographyBlock = /designTypography = \{([^}]*)\}/.exec(tokensSrc)
if (!typographyBlock) throw new Error('DesignTokens.ts 里找不到 designTypography 块')
const lineHeightRatio = Number(/lineHeightRatio:\s*([\d.]+)/.exec(typographyBlock[1])[1])

/** 解析一个 `export const x = ...` 标量/表达式 token 的原始文本与数值上下文 */
const tokenExpr = (src, name) => {
  const m = new RegExp(`export const ${name} = ([^\\n]+)`).exec(src)
  return m ? m[1].trim() : null
}

// pageTitleLineHeight 是字面量 42；pageTitleGap / controlGap 是「designSpacing.xx」表达式。
const lineHeightExpr = tokenExpr(tokensSrc, 'pageTitleLineHeight')
const lineHeight = Number(/^(\d+)$/.exec(lineHeightExpr || '')?.[1])
const gapExpr = tokenExpr(tokensSrc, 'pageTitleGap')
const controlGapExpr = tokenExpr(tokensSrc, 'controlGap')

const gapToken = gapExpr && /^designSpacing\.(\w+)$/.exec(gapExpr)
const controlGapToken = controlGapExpr && /^designSpacing\.(\w+)$/.exec(controlGapExpr)
const gapValue = gapToken ? spacing[gapToken[1]] : NaN
const controlGapValue = controlGapToken ? spacing[controlGapToken[1]] : NaN

// --- 源码工具 ---
/** 取 createStyle 里某个样式块的内容（不处理嵌套括号——本工程样式块均为平铺键值） */
const styleBlock = (src, styleName) => {
  const m = new RegExp(`(?:^|\\n)\\s+${styleName}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`).exec(src)
  return m ? m[1] : null
}

/** 某样式块里某个属性是否**只**由给定 token 提供（存在 token 引用、且不存在数字字面量） */
const propViaToken = (src, styleName, prop, tokenName) => {
  const block = styleBlock(src, styleName)
  if (!block) return { ok: false, why: `找不到 ${styleName} 样式块` }
  const hasToken = new RegExp(`${prop}:\\s*${tokenName}\\b`).test(block)
  const hasNumber = new RegExp(`${prop}:\\s*[\\d.]+`).test(block)
  if (!hasToken) return { ok: false, why: `${styleName}.${prop} 没有引用 ${tokenName}` }
  if (hasNumber) return { ok: false, why: `${styleName}.${prop} 同时存在硬编码数字（第二真值）` }
  return { ok: true, why: `${prop}: ${tokenName}` }
}

// --- B. 四个大标题页 ---
// 每个页面：文件、标题样式块名、行高属性、下间距所在的样式块与属性。
const PAGES = [
  {
    name: '推荐 Discovery',
    file: 'src/screens/Home/Views/Discovery/index.tsx',
    titleStyle: 'title',
    gapStyle: 'header',
    gapProp: 'marginBottom',
  },
  {
    name: '歌单 SongList',
    file: 'src/screens/Home/Views/SongList/HeaderBar/index.tsx',
    titleStyle: 'title',
    gapStyle: 'title',
    gapProp: 'marginBottom',
  },
  {
    name: '我的 Mylist',
    file: 'src/screens/Home/Views/Mylist/NewListUI.tsx',
    titleStyle: 'pageTitle',
    gapStyle: 'pageHeader',
    gapProp: 'marginBottom',
  },
  {
    name: '设置 PageHeader',
    file: 'src/components/common/PageHeader.tsx',
    titleStyle: 'title',
    gapStyle: 'container',
    gapProp: 'paddingBottom',
  },
]

const pageSrc = {}
for (const p of PAGES) pageSrc[p.name] = read(p.file)

const titleChecks = PAGES.map((p) => ({
  page: p,
  line: propViaToken(pageSrc[p.name], p.titleStyle, 'lineHeight', 'pageTitleLineHeight'),
  gap: propViaToken(pageSrc[p.name], p.gapStyle, p.gapProp, 'pageTitleGap'),
}))

// 四页大标题字号 / 字重（共线的另一半：一样宽才不会看着错位）
const titleSizeOk = PAGES.every((p) => /size=\{34\}/.test(pageSrc[p.name]))
const titleWeightOk = PAGES.every((p) => /fontWeight:\s*'800'/.test(styleBlock(pageSrc[p.name], p.titleStyle) || ''))

// --- C. 42 的两个来源约束 ---
// 1) 推荐页标题行里那颗 42pt 圆钮：行高就是被它撑出来的，两者必须相等。
const historyBtn = styleBlock(pageSrc['推荐 Discovery'], 'historyButton')
const historyBtnSize = historyBtn && Number(/width:\s*(\d+)/.exec(historyBtn)?.[1])
// 2) 34 × lineHeightRatio：低于它大标题顶部笔画会被裁。
const minLineHeight = 34 * lineHeightRatio

// --- D. 共享行距 ---
const platformChipsSrc = read('src/components/home/PlatformChips.tsx')
const platformChipsOk = /marginRight:\s*controlGap\b/.test(styleBlock(platformChipsSrc, 'chip') || platformChipsSrc)

const searchHeaderSrc = read('src/screens/Home/Views/Search/HeaderBar/index.tsx')
const searchTypeSrc = read('src/screens/Home/Views/Search/SearchTypeSelector.tsx')
const searchGapHits = (searchHeaderSrc.match(/(?:marginBottom|paddingVertical|marginRight):\s*controlGap\b/g) || []).length
const searchTypeGapOk = /marginRight:\s*controlGap\b/.test(searchTypeSrc)

// --- D2. 搜索页三处「标题 → 自己的内容」间距（第 19 轮第 2 条） ---
// 源码事实：「搜索平台」标题行（platformHeader）自身无下间距，标题→胶囊的间距由
// platformScroll 的 contentContainerStyle paddingVertical 承担（同一值也充当
// 「胶囊行 → 类型按钮行」的间距）。热门/历史搜索的对应位置是标题样式块自身的 marginBottom。
const hotSearchSrc = read('src/screens/Home/Views/Search/BlankView/HotSearch.tsx')
const historySearchSrc = read('src/screens/Home/Views/Search/BlankView/HistorySearch.tsx')

const titleGapSites = [
  { name: '搜索平台', file: 'Search/HeaderBar', src: searchHeaderSrc, styleName: 'platformContent', prop: 'paddingVertical' },
  { name: '热门搜索', file: 'Search/BlankView/HotSearch', src: hotSearchSrc, styleName: 'title', prop: 'marginBottom' },
  { name: '历史搜索', file: 'Search/BlankView/HistorySearch', src: historySearchSrc, styleName: 'titleContent', prop: 'marginBottom' },
]
/** 某样式块的某属性是否**只**由 controlGap 提供（有 token 引用、且无数字字面量） */
const gapViaControlGap = (site) => {
  const block = styleBlock(site.src, site.styleName)
  if (!block) return { ok: false, why: `找不到 ${site.styleName} 样式块` }
  const hasToken = new RegExp(`${site.prop}:\\s*controlGap\\b`).test(block)
  const hasNumber = new RegExp(`${site.prop}:\\s*[\\d.]+`).test(block)
  if (!hasToken) return { ok: false, why: `${site.styleName}.${site.prop} 没有引用 controlGap` }
  if (hasNumber) return { ok: false, why: `${site.styleName}.${site.prop} 同时存在硬编码数字（第二真值）` }
  return { ok: true, why: `${site.prop}: controlGap` }
}
const titleGapChecks = titleGapSites.map((site) => ({ site, check: gapViaControlGap(site) }))
// 三处是否真的同值：都解析到 controlGap，因此等于同一个 token 的数值（同源 ⇒ 同值）。
const titleGapSameSource = titleGapChecks.every((t) => t.check.ok)
const titleGapValue = titleGapSameSource ? controlGapValue : NaN

// --- E. 反例自检 ---
// 把某个消费点的 token 引用换成硬编码数字，同一套断言必须判不合格。
const breakTitleLineHeight = (src, styleName) => {
  const block = styleBlock(src, styleName)
  if (!block) return src
  return src.replace(block, block.replace(/lineHeight:\s*pageTitleLineHeight/, 'lineHeight: 36'))
}
const negConsumer = breakTitleLineHeight(pageSrc['推荐 Discovery'], 'title')
const negConsumerCheck = propViaToken(negConsumer, 'title', 'lineHeight', 'pageTitleLineHeight')

// token 值本体被改掉：解析必须跟着变（证明读到的是文件，不是抄的当前值）
const negTokenSrc = tokensSrc.replace('export const pageTitleLineHeight = 42', 'export const pageTitleLineHeight = 99')
const negTokenLineHeight = Number(/^(\d+)$/.exec(tokenExpr(negTokenSrc, 'pageTitleLineHeight'))?.[1])
// 值被改小到裁笔画线以下：C 组约束必须能判红
const clippedLineHeight = 34 * lineHeightRatio - 2

// D2 反例：把任一处「标题 → 内容」间距改回硬编码数字（A-4 时期的 4 / 8），同一套断言必须判不合格。
const negHotGapSrc = hotSearchSrc.replace('marginBottom: controlGap', 'marginBottom: 4')
const negHistoryGapSrc = historySearchSrc.replace('marginBottom: controlGap', 'marginBottom: 4')
const negPlatformGapSrc = searchHeaderSrc.replace('paddingVertical: controlGap', 'paddingVertical: 8')
const negHotGapCheck = gapViaControlGap({ ...titleGapSites[1], src: negHotGapSrc })
const negHistoryGapCheck = gapViaControlGap({ ...titleGapSites[2], src: negHistoryGapSrc })
const negPlatformGapCheck = gapViaControlGap({ ...titleGapSites[0], src: negPlatformGapSrc })
// 替换必须真的命中原文，否则上面三条「判红」是空转
const negGapHits = [
  negHotGapSrc !== hotSearchSrc,
  negHistoryGapSrc !== historySearchSrc,
  negPlatformGapSrc !== searchHeaderSrc,
]

console.log('='.repeat(92))
console.log('「四页标题共线」契约模型（摘自源码，单位 pt）')
console.log('='.repeat(92))
console.log(`  designSpacing: ${Object.entries(spacing).map(([k, v]) => `${k}=${v}`).join(' ')}`)
console.log(`  pageTitleLineHeight = ${lineHeightExpr}   → ${lineHeight}`)
console.log(`  pageTitleGap        = ${gapExpr}   → ${gapValue}`)
console.log(`  controlGap          = ${controlGapExpr}   → ${controlGapValue}`)
console.log(`  designTypography.lineHeightRatio = ${lineHeightRatio}（34pt 标题下限 = ${minLineHeight}）`)
console.log()
for (const t of titleChecks) {
  console.log(`  ${t.page.name.padEnd(18)} lineHeight: ${t.line.ok ? '✅' : '❌'} ${t.line.why}   ${t.page.gapProp}: ${t.gap.ok ? '✅' : '❌'} ${t.gap.why}`)
}
console.log(`  共享 PlatformChips.marginRight → controlGap: ${platformChipsOk ? '✅' : '❌'}`)
console.log(`  搜索页 controlGap 引用数（HeaderBar）= ${searchGapHits}，SearchTypeSelector = ${searchTypeGapOk ? '✅' : '❌'}`)
for (const t of titleGapChecks) {
  console.log(`  搜索页「${t.site.name}」标题 → 自己的内容：${t.check.ok ? '✅' : '❌'} ${t.check.why}   [${t.site.file} ${t.site.styleName}]`)
}
console.log(`  三处同源 ⇒ 同值 ${titleGapValue} pt（第 19 轮第 2 条；改 controlGap 一处，三处一起动）`)
console.log(`  推荐页 42pt 圆钮 width = ${historyBtnSize}`)
console.log()

console.log('='.repeat(92))
console.log('断言')
console.log('='.repeat(92))

check('解析到 pageTitleLineHeight 字面量', Number.isFinite(lineHeight), lineHeightExpr)
check('解析到 pageTitleGap = designSpacing.xx', !!gapToken, gapExpr)
check('解析到 controlGap = designSpacing.xx', !!controlGapToken, controlGapExpr)

check(`pageTitleGap 取的是 designSpacing.md(${spacing.md})`, gapValue === spacing.md, `${gapExpr} → ${gapValue}`)
check(`controlGap 取的是 designSpacing.sm(${spacing.sm})`, controlGapValue === spacing.sm, `${controlGapExpr} → ${controlGapValue}`)

for (const t of titleChecks) {
  check(`${t.page.name}：大标题行高走 pageTitleLineHeight`, t.line.ok, t.line.why)
  check(`${t.page.name}：标题行 → 内容间距走 pageTitleGap`, t.gap.ok, t.gap.why)
}

check('四页大标题字号一致（size 34）', titleSizeOk, PAGES.map((p) => p.name).join(' / '))
check('四页大标题字重一致（800）', titleWeightOk, '800')

check(`行高 42 与推荐页 42pt 圆钮同值（它就是 42 的来源）`,
  historyBtnSize === lineHeight, `圆钮=${historyBtnSize} 行高=${lineHeight}`)
check(`行高 ≥ 34 × ${lineHeightRatio} = ${minLineHeight}（大标题顶部笔画不被裁）`,
  lineHeight >= minLineHeight, `${lineHeight} ≥ ${minLineHeight}`)

check('PlatformChips（推荐/歌单/搜索三页共用）行距走 controlGap', platformChipsOk, 'marginRight: controlGap')
check('搜索页 HeaderBar 的相邻行间距走 controlGap', searchGapHits >= 3, `命中 ${searchGapHits} 处`)
check('搜索页类型按钮行距走 controlGap', searchTypeGapOk, 'marginRight: controlGap')

// D2（第 19 轮第 2 条）：三处「标题 → 自己的内容」间距同源（⇒ 同值 controlGap）
for (const t of titleGapChecks) {
  check(`搜索页「${t.site.name}」标题 → 内容间距走 controlGap = ${controlGapValue}`, t.check.ok, t.check.why)
}
check(`三处同源 ⇒ 同值（搜索平台 = 热门搜索 = 历史搜索 = ${titleGapValue}）`, titleGapSameSource, `controlGap = ${controlGapValue}`)

check('反例：热门搜索标题下间距改回硬编码 4，必须判不合格',
  negGapHits[0] && !negHotGapCheck.ok, negGapHits[0] ? negHotGapCheck.why : '替换未命中原文')
check('反例：历史搜索标题下间距改回硬编码 4，必须判不合格',
  negGapHits[1] && !negHistoryGapCheck.ok, negGapHits[1] ? negHistoryGapCheck.why : '替换未命中原文')
check('反例：搜索平台标题→胶囊间距改成硬编码 8，必须判不合格',
  negGapHits[2] && !negPlatformGapCheck.ok, negGapHits[2] ? negPlatformGapCheck.why : '替换未命中原文')

// E. 反例自检
check('反例：把推荐页标题改回硬编码 lineHeight: 36，必须判不合格',
  !negConsumerCheck.ok, negConsumerCheck.why)
check('反例：把 token 值改成 99，解析结果必须跟着变（证明不是抄的当前值）',
  negTokenLineHeight === 99, `${negTokenLineHeight}`)
check(`反例：行高若降到 ${clippedLineHeight}（< 34 × ${lineHeightRatio}），裁笔画断言必须判不合格`,
  clippedLineHeight < minLineHeight, `${clippedLineHeight} < ${minLineHeight}`)

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
