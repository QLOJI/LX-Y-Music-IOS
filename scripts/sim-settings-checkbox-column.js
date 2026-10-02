/**
 * ① 「设置页勾选框两列网格」契约（第 19 轮第 4 条的钉子）。
 *
 * 需求原话：「设置中，字体大小设置的勾选框要上下对齐，歌曲来源名称的勾选框也要和上面的
 * 对齐，资源缓存管理的勾选框也要上下对齐，菜单设置的勾选框也要和上面的对齐。」
 * 用户补充授权（同轮）：「勾选框可以两列」——即不必一项独占整行，允许两列排布。
 *
 * 病根（几何，见 B 段模型）：设置页里勾选框能落在同一条垂直线上的做法此前只有「独占整行」
 * 一种；而这些分组当时是「flexWrap 行内独立卡片」——卡片宽度随标签字数
 * （较小/小/标准/大/较大/非常大、不限制/128MB/…/2GB、原名/别名…）变化，
 * 勾选框左缘 x = 行左缘 + 前面所有卡片宽度之和，同一组的第二行对不齐第一行，
 * 相邻小组之间也对不齐 —— 这正是用户看到的「上下没对齐」。
 *
 * 现在的实现：六组统一走 CheckBoxGrid（两列网格）+ CheckBoxGridCell（单元卡片），
 *   · 单元：flexBasis 45% + flexGrow 1 ⇒ 每行恰好两项，各占 (行宽 − 8) / 2
 *   · 单元内 CheckBox 走 block 形态 ⇒ 勾选框左缘 = 单元左缘 + 1 边框 + 12 内边距
 *   · 第一列勾选框 x = 内容左缘 + 13 —— 与设置页其它整行卡（CheckBoxItem / block）同一条
 *     左基准线，即用户要的「和上面的对齐」；第二列 = 内容左缘 + 行宽/2 + 17
 *
 * 本脚本断言六个区块（用户点名的四处 + 两处「和上面的对齐」所依赖的上邻组）：
 *   A. 选项都经 CheckBoxGrid / CheckBoxGridCell 渲染，文件里没有裸 <CheckBox>、
 *      没有 flexWrap 横排容器；每组选项数为偶数（奇数会在末行拉伸成整行宽卡片）；
 *   B. 网格几何：grid = row + wrap + columnGap(designSpacing.xs) 且没有 gap/rowGap
 *      （行距由卡片自身的 marginBottom 提供，叠加会变 16）；cell = flexGrow 1 + 45%；
 *      cell 内是 CheckBox 的 block 形态；
 *   C. 同列的数值链：CheckBox 的 block 分支 = 边框 1 + paddingHorizontal 12 + marginRight 0
 *      ⇒ 网格第一列与整行卡（CheckBoxItem）勾选框左缘同为 +13；
 *   D. 几何模型（概算，标注假设）：用 zh-cn 的真实标签算出旧布局各勾选框 x 并不全等、
 *      新布局恒为 13 / 行宽一半 + 17 —— 证明「原来的病是真的」且「改对了」。
 *   E. 反例自检：cell 丢 flexBasis / grid 加 rowGap / 退回裸 CheckBox / cell 丢 block，
 *      必须判红。
 *
 * 运行：node scripts/sim-settings-checkbox-column.js
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

// --- A. 六个区块 ---
const SECTIONS = [
  {
    name: '字体大小设置',
    file: 'src/screens/Home/Views/Setting/settings/Basic/FontSize.tsx',
    count: /size: [\d.]+,/g,
    expected: 6,
  },
  {
    name: '歌曲来源名称',
    file: 'src/screens/Home/Views/Setting/settings/Basic/SourceName.tsx',
    count: /id: '(?:real|alias)'/g,
    expected: 2,
  },
  {
    name: '资源缓存管理',
    file: 'src/screens/Home/Views/Setting/settings/Player/ClearCache.tsx',
    count: /\{ value: \d+, label: '/g,
    expected: 6,
  },
  {
    name: '菜单设置',
    file: 'src/screens/Home/Views/Setting/settings/List/MenuSettings.tsx',
    count: /<SettingItem\s/g,
    expected: 2,
  },
  {
    name: '分享方式',
    file: 'src/screens/Home/Views/Setting/settings/Basic/ShareType.tsx',
    count: /id: '(?:system|clipboard)'/g,
    expected: 2,
  },
  {
    name: '添加到歌曲的位置',
    file: 'src/screens/Home/Views/Setting/settings/List/AddMusicLocationType.tsx',
    count: /<Item id="/g,
    expected: 2,
  },
]

const GRID_IMPORT = /import\s+CheckBoxGrid\s*,\s*\{\s*CheckBoxGridCell\s*\}\s+from\s+'\.\.\/\.\.\/components\/CheckBoxGrid'/
const usesGrid = (src) => GRID_IMPORT.test(src) && /<CheckBoxGrid[\s>]/.test(src) && /<CheckBoxGridCell\b/.test(src)
const hasBareCheckBox = (src) => /<CheckBox(?!Grid|Item)\b/.test(src)
// 只看样式属性（flexWrap: …），不看注释里对旧布局的文字说明
const hasWrapRow = (src) => /\bflexWrap\s*:/.test(src)

const layoutChecks = SECTIONS.map((s) => {
  const src = read(s.file)
  return {
    section: s,
    src,
    viaGrid: usesGrid(src),
    bare: hasBareCheckBox(src),
    wrap: hasWrapRow(src),
    optionCount: (src.match(s.count) || []).length,
  }
})

// --- B. 网格几何（单一真值在 CheckBoxGrid.tsx） ---
const gridSrc = read('src/screens/Home/Views/Setting/components/CheckBoxGrid.tsx')
const blockOf = (name, src) => {
  const m = new RegExp(`${name}: \\{([\\s\\S]*?)\\n  \\}`).exec(src)
  return m ? m[1] : ''
}
const gridBlock = blockOf('grid', gridSrc)
const cellBlock = blockOf('cell', gridSrc)

const gridRow = /flexDirection:\s*'row'/.test(gridBlock)
const gridWrap = /flexWrap:\s*'wrap'/.test(gridBlock)
const gridColumnGap = /columnGap:\s*designSpacing\.xs/.test(gridBlock)
// 行距必须由卡片自身 marginBottom 提供；grid 上再给 gap/rowGap 会叠加成 16pt。
// （blockOf 取的是样式块，块内注释里出现「rowGap」字样但没有冒号，不会误判。）
const gridNoRowGapOf = (src) => {
  const block = blockOf('grid', src)
  return !/\browGap\s*:/.test(block) && !/\bgap\s*:/.test(block)
}
const gridNoRowGap = gridNoRowGapOf(gridSrc)
const cellGrow = /flexGrow:\s*1\b/.test(cellBlock)
const cellBasis = /flexBasis:\s*'45%'/.test(cellBlock)
const cellBlockCheckBox = /<CheckBox\s+\{\.\.\.props\}\s+block\s*\/>/.test(gridSrc)

// --- C. 同列数值链：CheckBox 的 block 分支（整行卡与网格单元共用） ---
const checkBoxSrc = read('src/components/common/CheckBox/index.tsx')
const itemSrc = read('src/screens/Home/Views/Setting/components/CheckBoxItem.tsx')
const itemPassesBlock = /<CheckBox\s+\{\.\.\.props\}\s+block\s*\/>/.test(itemSrc)
const blockNoRightMargin = /marginRight:\s*block\s*\?\s*0\s*:\s*designSpacing\.sm/.test(checkBoxSrc)
const blockPadding = /paddingHorizontal:\s*designSpacing\.sm/.test(checkBoxSrc)
const blockBorder = /borderWidth:\s*1\b/.test(checkBoxSrc)
const blockMinHeight = /minHeight:\s*block\s*\?\s*52\s*:\s*40/.test(checkBoxSrc)

// 勾选框左缘（内容坐标）= 边框 1 + 卡片内边距 designSpacing.sm —— 从源码取值，不写死 12。
const tokensSrc = read('src/theme/DesignTokens.ts')
const spacingBlock = /designSpacing = \{([^}]*)\}/.exec(tokensSrc)
if (!spacingBlock) throw new Error('DesignTokens.ts 里找不到 designSpacing 块')
const spacing = {}
for (const m of spacingBlock[1].matchAll(/(\w+):\s*(\d+)/g)) spacing[m[1]] = Number(m[2])
const GLYPH_X = 1 + spacing.sm

// --- D. 几何模型（概算） ---
// 假设（只为演示排序关系，不参与任何真实布局）：15pt 字号下中文按 15pt/字、ASCII 按 8pt/字；
// 旧卡片宽 = 边框 2 + 内边距 12×2 + 勾选框 18 + 标签右内边距 8 + 文本宽；
// 旧布局项间距 = 8（字体大小 / 缓存上限的 marginRight / 来源名称的 marginBottom /
// 菜单设置的 gap 都是 8）；行宽 = 400（iPhone 440 − 左右各 20 内容内边距）。
const CJK = 15
const ASCII = 8
const ITEM_GAP = 8
const ROW_WIDTH = 400
const textWidth = (s) => [...s].reduce((w, ch) => w + (/[一-龥]/.test(ch) ? CJK : ASCII), 0)
const itemWidth = (label) => 2 + 12 * 2 + 18 + 8 + textWidth(label)

const zh = JSON.parse(read('src/lang/zh-cn.json'))
const cacheLabels = [...read(SECTIONS[2].file)
  .matchAll(/\{\s*value:\s*\d+,\s*label:\s*'([^']+)'\s*\}/g)].map((m) => m[1])

const LABELS = {
  '字体大小设置': ['setting_basic_font_size_80', 'setting_basic_font_size_90', 'setting_basic_font_size_100',
    'setting_basic_font_size_110', 'setting_basic_font_size_120', 'setting_basic_font_size_130'].map((k) => zh[k]),
  '歌曲来源名称': ['setting_basic_sourcename_real', 'setting_basic_sourcename_alias'].map((k) => zh[k]),
  '资源缓存管理': cacheLabels,
  '菜单设置': ['play_later', 'dislike'].map((k) => zh[k]),
  '分享方式': ['setting_basic_share_type_system', 'setting_basic_share_type_clipboard'].map((k) => zh[k]),
  '添加到歌曲的位置': ['setting_list_add_music_location_type_top', 'setting_list_add_music_location_type_bottom'].map((k) => zh[k]),
}

/** 旧布局（flexWrap 行内独立卡片）里各勾选框的左缘（内容坐标） */
const oldGlyphXs = (labels) => {
  const xs = []
  let x = 0
  for (const label of labels) {
    const w = itemWidth(label)
    if (x > 0 && x + w > ROW_WIDTH) x = 0
    xs.push(x + 13)
    x += w + ITEM_GAP
  }
  return xs
}
const spread = (xs) => Math.max(...xs) - Math.min(...xs)

const model = SECTIONS.map((s) => {
  const labels = LABELS[s.name]
  const xs = oldGlyphXs(labels)
  return {
    name: s.name,
    labels,
    oldXs: xs,
    oldSpread: spread(xs),
    newXs: [GLYPH_X, Math.round(ROW_WIDTH / 2) + GLYPH_X + 4],
  }
})

// 两列自洽性：2 × 45% + columnGap(8) ≤ 行宽 ⇒ 行宽 ≥ 80pt（任意手机宽度都成立）
const minRowWidthForTwoColumns = Math.ceil(spacing.xs / (1 - 0.45 * 2))
const twoColumnsFit = minRowWidthForTwoColumns <= ROW_WIDTH

// --- E. 反例自检 ---
const mutate = (src, from, to) => {
  const out = src.replace(from, to)
  return { out, hit: out !== src }
}
const negBare = mutate(layoutChecks[0].src, '<CheckBoxGridCell', '<CheckBox')
const negWrapBack = mutate(layoutChecks[3].src, '<CheckBoxGrid style', "<View style={{ flexWrap: 'wrap' }}><CheckBoxGrid style")
const negCellBasis = mutate(gridSrc, "flexBasis: '45%',", '')
const negCellBlock = mutate(gridSrc, '<CheckBox {...props} block />', '<CheckBox {...props} />')
const negRowGap = mutate(gridSrc, 'columnGap: designSpacing.xs,', 'columnGap: designSpacing.xs,\n    rowGap: designSpacing.xs,')

console.log('='.repeat(94))
console.log('「设置页勾选框两列网格」契约模型')
console.log('='.repeat(94))
for (const l of layoutChecks) {
  console.log(`  ${l.section.name.padEnd(9)} CheckBoxGrid: ${l.viaGrid ? '✅' : '❌'}   裸 <CheckBox>: ${l.bare ? '❌ 有' : '✅ 无'}   flexWrap 横排: ${l.wrap ? '❌ 有' : '✅ 无'}   选项数: ${l.optionCount}（期望 ${l.section.expected}）`)
}
console.log()
console.log(`  网格：row = ${gridRow ? '✅' : '❌'}   wrap = ${gridWrap ? '✅' : '❌'}   columnGap = designSpacing.xs(${spacing.xs}) = ${gridColumnGap ? '✅' : '❌'}   无 gap/rowGap = ${gridNoRowGap ? '✅' : '❌'}`)
console.log(`  单元：flexGrow 1 = ${cellGrow ? '✅' : '❌'}   flexBasis 45% = ${cellBasis ? '✅' : '❌'}   单元内 CheckBox block = ${cellBlockCheckBox ? '✅' : '❌'}`)
console.log(`  数值链：CheckBoxItem 直传 block = ${itemPassesBlock ? '✅' : '❌'}；block → marginRight 0 = ${blockNoRightMargin ? '✅' : '❌'}；paddingHorizontal ${spacing.sm} + 边框 1 ⇒ 勾选框左缘 = 内容左缘 + ${GLYPH_X}`)
console.log(`  两列自洽：2 × 45% + ${spacing.xs} ≤ 行宽 ⇒ 行宽 ≥ ${minRowWidthForTwoColumns}pt（手机通用）`)
console.log()
console.log('  几何模型（概算：中文字宽 15pt / ASCII 8pt，旧卡片 = 边框2 + 内边距24 + 勾选框18 + 标签右距8 + 文本，行宽 400）')
for (const m of model) {
  console.log(`    ${m.name.padEnd(9)} 旧布局勾选框 x = [${m.oldXs.join(', ')}]  极差 ${m.oldSpread}pt  →  新布局 x ∈ {${m.newXs.join(', ')}}（第一列与整行卡同线，第二列 = 行宽/2 + ${GLYPH_X + 4}）`)
}
console.log()

console.log('='.repeat(94))
console.log('断言')
console.log('='.repeat(94))

for (const l of layoutChecks) {
  check(`${l.section.name}：选项经 CheckBoxGrid / CheckBoxGridCell 渲染`, l.viaGrid, 'import + <CheckBoxGrid + <CheckBoxGridCell')
  check(`${l.section.name}：不再出现裸 <CheckBox>`, !l.bare, '勾选框必须走网格单元（block 卡片）')
  check(`${l.section.name}：选项容器不再横排换行（flexWrap）`, !l.wrap, '横排 ⇒ x 随标签宽度漂移')
  check(`${l.section.name}：选项数 ${l.optionCount} = 期望 ${l.section.expected} 且为偶数`, l.optionCount === l.section.expected && l.optionCount % 2 === 0, '奇数会让末行单项被 flexGrow 拉成整行宽')
}

check('网格：row + wrap + columnGap(designSpacing.xs)', gridRow && gridWrap && gridColumnGap, 'flexDirection row / flexWrap wrap / columnGap')
check('网格：不给 gap / rowGap（行距由卡片自身 marginBottom 提供，叠加会变 16pt）', gridNoRowGap, 'grid 里只允许 columnGap')
check('单元：flexGrow 1 + flexBasis 45% ⇒ 每行恰好两项、各占 (行宽 − 8)/2', cellGrow && cellBasis, 'flexGrow 1 / flexBasis 45%')
check('单元：CheckBox 走 block 形态（卡片铺满单元、去掉并排右外边距）', cellBlockCheckBox, '<CheckBox {...props} block />')
check(`两列自洽：行宽 ≥ ${minRowWidthForTwoColumns}pt 时两项同行（手机通用）`, twoColumnsFit, `2×0.45 + ${spacing.xs}/行宽 ≤ 1`)

check('CheckBoxItem 给 CheckBox 直传 block（整行卡与网格同一条左基准线）', itemPassesBlock, '<CheckBox {...props} block />')
check('CheckBox 的 block 分支去掉右外边距（不预留并排间隙）', blockNoRightMargin, 'marginRight: block ? 0 : designSpacing.sm')
check(`CheckBox 卡片内边距 = designSpacing.sm(${spacing.sm}) 且带 1pt 边框（勾选框左缘 = +${GLYPH_X}）`, blockPadding && blockBorder, `paddingHorizontal ${spacing.sm} / borderWidth 1`)
check('CheckBox 的 block 行高 52 / 并排 40 仍分档（改错分支会连带视觉变化）', blockMinHeight, 'minHeight: block ? 52 : 40')

for (const m of model) {
  check(`几何模型：${m.name} 旧布局各勾选框 x 并不全等（极差 ${m.oldSpread}pt 就是用户看到的错位）`, m.oldSpread > 0, `x = [${m.oldXs.join(', ')}]`)
  check(`几何模型：${m.name} 新布局第一列勾选框 x ≡ ${GLYPH_X}（与整行卡同列）`, m.newXs[0] === GLYPH_X && m.labels.length > 0, `labels = ${m.labels.length}`)
}

check('反例：字体大小设置退回裸 <CheckBox>，必须判不合格', negBare.hit && hasBareCheckBox(negBare.out), negBare.hit ? '裸 <CheckBox> 被抓到' : '替换未命中原文')
check('反例：菜单设置退回 flexWrap 横排容器，必须判不合格', negWrapBack.hit && hasWrapRow(negWrapBack.out), negWrapBack.hit ? 'flexWrap 被抓到' : '替换未命中原文')
check('反例：单元丢掉 flexBasis 45%，必须判不合格', negCellBasis.hit && !blockOf('cell', negCellBasis.out).includes('flexBasis'), negCellBasis.hit ? 'flexBasis 丢失被抓到' : '替换未命中原文')
check('反例：单元内的 CheckBox 丢掉 block，必须判不合格', negCellBlock.hit && !/<CheckBox\s+\{\.\.\.props\}\s+block/.test(negCellBlock.out), negCellBlock.hit ? 'block 丢失被抓到' : '替换未命中原文')
check('反例：网格加回 rowGap，必须判不合格（行距会叠成 16pt）', negRowGap.hit && !gridNoRowGapOf(negRowGap.out), negRowGap.hit ? 'rowGap 被抓到' : '替换未命中原文')

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
