#!/usr/bin/env node
/**
 * sim-subpage-title-align.js —— 「我的页二级列表标题」契约（用户第 14 轮第 1 条）
 *
 * 需求原话（2026-10-02）：
 *   「勾选上我的页列表显示，网易歌单、酷狗歌单、QQ歌单、网易关注歌手、网易收藏专辑页面的
 *     顶部标题显示不全，修改位置应该和"我的"标题位置一样，所有列表中的标题都显示在这个位置，
 *     字体大小参考 WebDAV 界面上标题字体大小，网易关注歌手、网易收藏专辑、WebDAV、本地与下载
 *     标题字体位置都按我的标题位置固定且显示完全。」
 *
 * 收敛结果：
 *   一、标题行只有一份实现 —— components/common/DetailPageTitle.tsx，位置/行高/字重与
 *       「我的」标题（Mylist/NewListUI.pageHeader）逐项同源：
 *         paddingHorizontal: designSpacing.lg / marginBottom: pageTitleGap /
 *         lineHeight: pageTitleLineHeight / fontWeight '800'。
 *   二、字号取 DesignTokens.subPageTitleSize（= designTypography.title），它与 Home 共享页头
 *       （Vertical/Header.tsx，也就是 WebDAV / 本地与下载页原来那行标题）**同源**：两处都
 *       引用 designTypography.title，谁改单边都会被本脚本判红。
 *   三、「显示不全」的根因：那三个歌单页此前把 lineHeight 写死在裸 StyleSheet.create 里
 *       （不缩放），字号却来自 Text 的 size（随「字体大小」设置乘 global.lx.fontSize）——
 *       字体调大后字形比行框还高，上下笔画被裁。DetailPageTitle 走 createStyle，字号与行高
 *       同口径缩放，任何字体大小都不裁（见断言 B7 / B8）。
 *   四、七个页面（= core/common.ts 的 LOVE_SUBPAGE_IDS）都接管页头（PAGE_OWNED_HEADER_IDS），
 *       标题紧跟 PageTopInset 渲染，不再与共享页头那一行重复。
 *
 * 本脚本从源码解析结构（不硬编码行号），每条关键断言配一个「改回旧实现就该判不合格」的反例。
 *
 * 运行：node scripts/sim-subpage-title-align.js
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

/** 去掉行注释：断言只看代码，避免中文注释里出现 34 / 42 / 「我的」等字样造成假命中 */
const stripComments = (s) => s.split('\n').map((line) => {
  const at = line.indexOf('//')
  return at < 0 ? line : line.slice(0, at)
}).join('\n')

/** 解析一个 `export const x = ...` 标量的原始表达式 */
const tokenExpr = (src, name) => {
  const m = new RegExp(`export const ${name} = ([^\\n]+)`).exec(src)
  return m ? m[1].trim() : null
}

/** 取一个对象块（`name: {` 起，到同缩进的 `},` 止）——本工程样式块均为平铺键值 */
const block = (src, name) => {
  const m = new RegExp(`(?:^|\\n)\\s+${name}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`).exec(src)
  return m ? m[1] : null
}

/** 某块里某属性是否只由给定 token/表达式提供（有 token、且没有数字字面量） */
const propVia = (src, name, prop, expr) => {
  const b = block(src, name)
  if (!b) return { ok: false, why: `找不到 ${name} 样式块` }
  const code = stripComments(b)
  // 字面量（'row' / '800'）后面不能跟 \b：\b 只对标识符式表达式有意义
  const suffix = /^[\w.]/.test(expr) ? '\\b' : ''
  if (!new RegExp(`${prop}:\\s*${expr.replace(/\./g, '\\.')}${suffix}`).test(code)) {
    return { ok: false, why: `${name}.${prop} 没有引用 ${expr}` }
  }
  if (new RegExp(`${prop}:\\s*[\\d.]+`).test(code)) {
    return { ok: false, why: `${name}.${prop} 同时存在硬编码数字（第二个真值）` }
  }
  return { ok: true, why: `${prop}: ${expr}` }
}

// —— 源码 ——
const tokensSrc = read('src/theme/DesignTokens.ts')
const detailSrc = read('src/components/common/DetailPageTitle.tsx')
const headerSrc = read('src/screens/Home/Vertical/Header.tsx')
const loveIdsSrc = read('src/core/common.ts')
const verticalSetSrc = read('src/screens/Home/Vertical/Content.tsx')
const horizontalSetSrc = read('src/screens/Home/Horizontal/index.tsx')

// —— A. 字号参照物：subPageTitleSize ≡ 共享页头标题的字号 ——
const subExpr = tokenExpr(tokensSrc, 'subPageTitleSize')
const typographyBlock = /designTypography = \{([^}]*)\}/.exec(tokensSrc)
const designTitle = typographyBlock ? Number(/title:\s*(\d+)/.exec(typographyBlock[1])?.[1]) : NaN
const spacingBlock = /designSpacing = \{([^}]*)\}/.exec(tokensSrc)
const spacing = {}
if (spacingBlock) for (const m of spacingBlock[1].matchAll(/(\w+):\s*(\d+)/g)) spacing[m[1]] = Number(m[2])
const lineHeightExpr = tokenExpr(tokensSrc, 'pageTitleLineHeight')
const lineHeight = Number(/^(\d+)$/.exec(lineHeightExpr || '')?.[1])
const gapExpr = tokenExpr(tokensSrc, 'pageTitleGap')
const controlRatio = Number(/lineHeightRatio:\s*([\d.]+)/.exec(typographyBlock ? typographyBlock[1] : '')?.[1])

const subViaDesignTitle = subExpr === 'designTypography.title'
const headerViaDesignTitle = /size=\{designTypography\.title\}/.test(stripComments(headerSrc))
const headerHasLiteral20 = /size=\{20\}/.test(stripComments(headerSrc))

// —— B. DetailPageTitle 的几何 ——
const rowDir = propVia(detailSrc, 'row', 'flexDirection', "'row'")
const rowAlign = propVia(detailSrc, 'row', 'alignItems', "'center'")
const rowJustify = propVia(detailSrc, 'row', 'justifyContent', "'space-between'")
const rowLeft = propVia(detailSrc, 'row', 'paddingHorizontal', 'designSpacing.lg')
const rowGap = propVia(detailSrc, 'row', 'marginBottom', 'pageTitleGap')
const titleWeight = propVia(detailSrc, 'title', 'fontWeight', "'800'")
const titleLine = propVia(detailSrc, 'title', 'lineHeight', 'pageTitleLineHeight')
const titleSize = /size=\{subPageTitleSize\}/.test(stripComments(detailSrc))
const titleSizeIsLiteral = /size=\{\d+\}/.test(stripComments(detailSrc))
const scaledPipeline = /createStyle\(/.test(stripComments(detailSrc))
const rawPipeline = /StyleSheet\.create\(/.test(stripComments(detailSrc))
const noClip = lineHeight >= designTitle * controlRatio

// —— C. 七个页面都消费同一份实现 ——
// 顺序 = core/common.ts LOVE_SUBPAGE_IDS 的顺序
const PAGES = [
  { name: '网易歌单', file: 'src/screens/Home/Views/MyPlaylist/index.tsx', navId: 'nav_my_playlist' },
  { name: '酷狗歌单', file: 'src/screens/Home/Views/KgPlaylist/index.tsx', navId: 'nav_kg_playlist' },
  { name: 'QQ歌单', file: 'src/screens/Home/Views/TxPlaylist/index.tsx', navId: 'nav_tx_playlist' },
  { name: '网易关注歌手', file: 'src/screens/Home/Views/FollowedArtists/index.tsx', navId: 'nav_followed_artists' },
  { name: '网易收藏专辑', file: 'src/screens/Home/Views/SubscribedAlbums/index.tsx', navId: 'nav_subscribed_albums' },
  { name: 'WebDAV', file: 'src/screens/Home/Views/WebDAV/index.tsx', navId: 'nav_webdav' },
  { name: '本地与下载', file: 'src/screens/Home/Views/LocalDownload/index.tsx', navId: 'nav_local_download' },
]

const pageSrc = {}
const pageChecks = PAGES.map((p) => {
  const src = read(p.file)
  const code = stripComments(src)
  pageSrc[p.navId] = src
  return {
    page: p,
    imports: /import DetailPageTitle from '@\/components\/common\/DetailPageTitle'/.test(code),
    renders: new RegExp(`<DetailPageTitle title=\\{t\\('${p.navId}'\\)\\}`).test(code),
    inset: /<PageTopInset \/>/.test(code),
    // 旧实现的三件套必须一件不剩：写死的 34pt 标题、不缩放的标题行高、各自的 titleRow 样式
    noLegacySize: !/size=\{34\}/.test(code),
    noLegacyLineHeight: !/pageTitleLineHeight/.test(code),
    noLegacyStyles: !/styles\.titleRow|styles\.titleText|titleText:\s*\{/.test(code),
  }
})

// —— D. 页头接管 + 需求名单一致 ——
const idList = (src) => {
  const m = /LOVE_SUBPAGE_IDS[^=]*=\s*\[([\s\S]*?)\]/.exec(src)
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : null
}
const loveIds = idList(loveIdsSrc)
const setHasAll = (src) => PAGES.every(p => new RegExp(`'${p.navId}'`).test(src))
const verticalAll = setHasAll(verticalSetSrc)
const horizontalAll = setHasAll(horizontalSetSrc)
const loveIdsMatch = !!loveIds && loveIds.length === PAGES.length && PAGES.every(p => loveIds.includes(p.navId))

// —— E. 反例自检：每条修复改回旧实现 / 拆掉接线，都必须被拦下 ——
const neg = (label, ok) => {
  results.push({ label, ok: !!ok })
  if (!ok) failed++
}

// m1 token 值被改成 34：解析必须跟着变（证明读到的是文件，不是抄的当前值）
const m1 = tokensSrc.replace('export const subPageTitleSize = designTypography.title', 'export const subPageTitleSize = 34')
const m1Changed = tokenExpr(m1, 'subPageTitleSize') === '34'

// m2 共享页头改回字面量 20（两个真值）被拦下
const m2 = headerSrc.replace('size={designTypography.title}', 'size={20}')
const m2Caught = m2 !== headerSrc && !/size=\{designTypography\.title\}/.test(m2)

// m3 DetailPageTitle 退回裸 StyleSheet.create（不缩放 → 字体调大即裁）被拦下
const m3 = detailSrc.replace('const styles = createStyle({', 'const styles = StyleSheet.create({')
const m3Caught = m3 !== detailSrc && /StyleSheet\.create\(/.test(m3) && !/createStyle\(/.test(m3)

// m4 标题行高改回硬编码 42 被拦下
const m4 = detailSrc.replace('lineHeight: pageTitleLineHeight,', 'lineHeight: 42,')
const m4Caught = m4 !== detailSrc && !propVia(m4, 'title', 'lineHeight', 'pageTitleLineHeight').ok

// m5 行高降到 20（< 20 × 1.15 = 23，同字体大小下就裁）被拦下
const m5LineHeight = 20
const m5Caught = !(m5LineHeight >= designTitle * controlRatio)

// m6 某个页面从页头接管名单里去掉（会和共享页头重复一行标题 / 或落回旧位置）被拦下
const m6 = verticalSetSrc.replace("  'nav_webdav',\n", '')
const m6Caught = m6 !== verticalSetSrc && !setHasAll(m6)

// m7 页面里塞回旧的 34pt 标题被拦下
const m7 = pageSrc['nav_my_playlist'].replace(
  '<DetailPageTitle title={t(\'nav_my_playlist\')} />',
  '<Text style={styles.titleText} size={34} color={theme[\'c-font\']}>{t(\'nav_my_playlist\')}</Text>',
)
const m7Caught = m7 !== pageSrc['nav_my_playlist'] && /size=\{34\}/.test(m7)

// m8 标题前面拆掉 PageTopInset（位置不再是「我的」标题那个位置）被拦下
const m8 = pageSrc['nav_followed_artists'].replace('<PageTopInset />', '')
const m8Caught = m8 !== pageSrc['nav_followed_artists'] && !/<PageTopInset \/>/.test(m8)

// —— 输出 ——
console.log('='.repeat(92))
console.log('「我的页二级列表标题位置 / 字号」契约模型（摘自源码，单位 pt）')
console.log('='.repeat(92))
console.log(`  subPageTitleSize        = ${subExpr}   → ${designTitle}`)
console.log(`  designTypography.title  = ${designTitle}（共享页头 Vertical/Header.tsx 的字号，也是 WebDAV 页标题的字号）`)
console.log(`  pageTitleLineHeight     = ${lineHeightExpr}   → ${lineHeight}`)
console.log(`  pageTitleGap            = ${gapExpr}   → ${spacing.md}`)
console.log(`  paddingHorizontal       = designSpacing.lg   → ${spacing.lg}`)
console.log(`  不裁笔画下限            = ${designTitle} × ${controlRatio} = ${designTitle * controlRatio}`)
console.log()
for (const c of pageChecks) {
  const flags = [
    c.imports ? '引入✅' : '引入❌',
    c.renders ? '标题✅' : '标题❌',
    c.inset ? 'PageTopInset✅' : 'PageTopInset❌',
    c.noLegacySize ? '无旧34✅' : '无旧34❌',
    c.noLegacyLineHeight ? '无旧行高✅' : '无旧行高❌',
    c.noLegacyStyles ? '无旧样式✅' : '无旧样式❌',
  ].join(' ')
  console.log(`  ${c.page.name.padEnd(14)} ${c.page.navId.padEnd(24)} ${flags}`)
}
console.log()
console.log(`  LOVE_SUBPAGE_IDS（需求名单）= ${(loveIds || []).join(' / ')}`)
console.log()

console.log('='.repeat(92))
console.log('断言')
console.log('='.repeat(92))

// A
check('subPageTitleSize 的取值表达式 = designTypography.title（与共享页头同源）', subViaDesignTitle, subExpr)
check(`解析到 designTypography.title = ${designTitle}`, Number.isFinite(designTitle), `${designTitle}`)
check('共享页头 Vertical/Header.tsx 的标题字号同样引用 designTypography.title', headerViaDesignTitle, headerViaDesignTitle ? '' : '要求 size={designTypography.title}')
check('共享页头不再出现 size={20} 字面量（否则就是第二个真值）', !headerHasLiteral20, headerHasLiteral20 ? '仍有 size={20}' : '')

// B
check('DetailPageTitle.row：flexDirection: row', rowDir.ok, rowDir.why)
check('DetailPageTitle.row：alignItems: center', rowAlign.ok, rowAlign.why)
check('DetailPageTitle.row：justifyContent: space-between', rowJustify.ok, rowJustify.why)
check(`DetailPageTitle.row：左缩进走 designSpacing.lg(${spacing.lg})，与「我的」标题同一条竖线`, rowLeft.ok, rowLeft.why)
check('DetailPageTitle.row：下间距走 pageTitleGap，与「我的」标题一致', rowGap.ok, rowGap.why)
check('DetailPageTitle.title：fontWeight 800（与「我的」标题一致）', titleWeight.ok, titleWeight.why)
check('DetailPageTitle.title：行高走 pageTitleLineHeight（与「我的」标题同一行高）', titleLine.ok, titleLine.why)
check('DetailPageTitle 的标题字号走 subPageTitleSize token', titleSize, titleSize ? '' : '要求 size={subPageTitleSize}')
check('DetailPageTitle 里没有字面量字号', !titleSizeIsLiteral, titleSizeIsLiteral ? '出现 size={数字}' : '')
check('DetailPageTitle 用 createStyle（字号与行高同口径缩放 = 「显示完全」）', scaledPipeline, scaledPipeline ? '' : '必须走 createStyle')
check('DetailPageTitle 不出现裸 StyleSheet.create（不缩放的写法）', !rawPipeline, rawPipeline ? '仍有 StyleSheet.create' : '')
check(`行高 ${lineHeight} ≥ ${designTitle} × ${controlRatio} = ${designTitle * controlRatio}（同字号下不裁笔画）`, noClip, `${lineHeight} ≥ ${(designTitle * controlRatio).toFixed(2)}`)

// C
for (const c of pageChecks) {
  check(`${c.page.name}：引入共用的 DetailPageTitle 组件`, c.imports)
  check(`${c.page.name}：渲染 <DetailPageTitle title={t('${c.page.navId}')}`, c.renders)
  check(`${c.page.name}：标题前有 PageTopInset（位置锚点，与「我的」一致）`, c.inset)
  check(`${c.page.name}：不再有写死的 34pt 标题`, c.noLegacySize)
  check(`${c.page.name}：不再自己写 pageTitleLineHeight（旧的不缩放行高）`, c.noLegacyLineHeight)
  check(`${c.page.name}：不再保留自己的 titleRow / titleText 样式`, c.noLegacyStyles)
}

// D
check('竖屏 Content.tsx 的 PAGE_OWNED_HEADER_IDS 含全部 7 个二级页（共享页头不再重复一行）', verticalAll)
check('横屏 index.tsx 的 PAGE_OWNED_HEADER_IDS 含全部 7 个二级页（口径一致）', horizontalAll)
check(`7 个页面 = core/common.ts 的 LOVE_SUBPAGE_IDS 名单（${(loveIds || []).length} 个）`, loveIdsMatch)

// E
neg('反例 m1：subPageTitleSize 改成 34，解析结果跟着变（不是抄的当前值）', m1Changed)
neg('反例 m2：共享页头改回 size={20} 字面量，被 A 组判红', m2Caught)
neg('反例 m3：DetailPageTitle 退回裸 StyleSheet.create（字体调大即裁），被 B7 判红', m3Caught)
neg('反例 m4：标题行高改回硬编码 42，被 B6 判红', m4Caught)
neg(`反例 m5：行高若降到 ${m5LineHeight}（< ${designTitle} × ${controlRatio}），不裁断言判红`, m5Caught)
neg('反例 m6：从竖屏接管名单里去掉 nav_webdav，被 D 组判红', m6Caught)
neg('反例 m7：页面里塞回旧的 34pt 标题，被 C 组判红', m7Caught)
neg('反例 m8：标题前拆掉 PageTopInset，被 C 组判红', m8Caught)

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
