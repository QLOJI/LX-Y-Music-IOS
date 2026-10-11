/*
 * sim-discovery-left-baseline.js —— 「推荐页左基准线」契约（第 21 轮·图一）
 *
 * 用户原话：「图一：推荐界面酷我音乐、酷狗音乐、企鹅音乐、网易音乐、咪咕音乐、Gitcode 的
 * 排行榜、推荐歌单字样要和推荐标题左对齐」。
 *
 * 复核结论（静态源码解析 + 对用户 10.jpg 的量测，该图 2.909 px/pt）：**现状已经是左对齐**——
 * 大标题「推荐」、平台胶囊行（酷我/酷狗/企鹅/网易/咪咕/Gitcode）、排行榜区标题、榜单卡片行、
 * 「推荐歌单」网格标题、歌单卡片网格，水平左内边距全部取同一个 token designSpacing.lg
 * （本机型 24pt；截图里各字面左缘同在 73px ≈ 24pt）。本轮因此**没改代码**，改为把这条
 * 左基准钉成契约：以后任何一处单独换成别的 token（或把列宽公式的扣减量改掉），都会被判红。
 *
 * 解析方式（不硬编码数值）：先从 DesignTokens.ts 读 designSpacing 真值表，再从各文件的
 * createStyle 命名块里解析 paddingHorizontal / paddingLeft 用的是哪个 token，断言全部
 * 等于「推荐大标题行 header」那一处的 token。反例里专门有一条「把 token 值改掉，脚本
 * 复算出的期望值必须跟着变」——证明不是把 24 抄成了常量。
 *
 * 本脚本是**静态源码解析**（正则），钉的是「源码结构还在不在」，证明不了真机渲染位置。
 *
 * 运行：node scripts/sim-discovery-left-baseline.js
 * 退出码：全部不变量通过、且每条反例都被拦下 = 0；否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const FILES = {
  tokens: 'src/theme/DesignTokens.ts',
  discovery: 'src/screens/Home/Views/Discovery/index.tsx',
  sectionHeader: 'src/components/common/SectionHeader.tsx',
  playlistGrid: 'src/components/home/PlaylistGrid.tsx',
  platformChips: 'src/components/home/PlatformChips.tsx',
}
const SRC = {}
for (const key of Object.keys(FILES)) SRC[key] = read(FILES[key])

const results = []
let failed = 0
const check = (label, ok, detail) => {
  results.push({ label, ok: !!ok, detail })
  if (!ok) failed++
}
const neg = (label, ok) => {
  results.push({ label, ok: !!ok })
  if (!ok) failed++
}

/** designSpacing 真值表：只取 designSpacing 块（designRadius 里有同名键 sm/md/lg/xl） */
const spacingTokens = (src) => {
  const block = /designSpacing = \{([^}]*)\}/.exec(src)
  if (!block) return null
  const out = {}
  for (const m of block[1].matchAll(/(\w+):\s*(\d+)/g)) out[m[1]] = Number(m[2])
  return out
}
/** createStyle 命名块里某属性引用的 designSpacing token 名（没写 designSpacing 就返回 null） */
const styleToken = (src, styleName, prop) => {
  const block = new RegExp(`(?:^|\\n)\\s*${styleName}:\\s*\\{([^}]*)\\}`).exec(src)
  if (!block) return null
  const m = new RegExp(`(?:^|\\n)\\s*${prop}:\\s*designSpacing\\.(\\w+)`).exec(block[1])
  return m ? m[1] : null
}

/**
 * 复算全部不变量。传变异过的 SRC 进来就是反例自检。
 * base = 「推荐」大标题行用的 token；baseValue = 该 token 在真值表里的数值（证明推导自 token）。
 */
const run = (s) => {
  const tokens = spacingTokens(s.tokens)
  const base = styleToken(s.discovery, 'header', 'paddingHorizontal')
  const baseValue = tokens && base ? tokens[base] : null
  const checks = []
  const push = (label, ok, detail) => checks.push([label, ok, detail])

  push('DesignTokens.designSpacing 真值表解析成功', !!tokens, tokens ? `lg=${tokens.lg}` : '未命中')
  push('推荐页大标题行 header.paddingHorizontal 用的是某个 designSpacing token', !!base, String(base))

  const cases = [
    ['推荐页 日推卡容器 daily', s.discovery, 'daily', 'paddingHorizontal'],
    ['推荐页 平台标题 platformTitle', s.discovery, 'platformTitle', 'paddingHorizontal'],
    ['推荐页 排行榜区标题 sectionTitle', s.discovery, 'sectionTitle', 'paddingHorizontal'],
    ['推荐页 榜单卡片行 boardContent', s.discovery, 'boardContent', 'paddingHorizontal'],
    ['推荐页 宽屏榜单网格 boardGrid', s.discovery, 'boardGrid', 'paddingHorizontal'],
    ['「推荐歌单」区标题 SectionHeader.container', s.sectionHeader, 'container', 'paddingHorizontal'],
    ['「推荐歌单」卡片网格 PlaylistGrid.grid', s.playlistGrid, 'grid', 'paddingHorizontal'],
    ['平台胶囊行 PlatformChips.content', s.platformChips, 'content', 'paddingHorizontal'],
    ['平台胶囊行(无父内边距) PlatformChips.contentBare', s.platformChips, 'contentBare', 'paddingLeft'],
  ]
  for (const [label, src, style, prop] of cases) {
    const t = styleToken(src, style, prop)
    push(`${label}：${prop} 与标题同一条左基准（${base ?? '?'}）`, !!t && t === base, String(t))
  }

  // 列宽公式扣的宽度必须与网格内边距同源 —— 网格用 lg 扣 xl（或反过来）会算错列数与边距
  const padToken = /const PADDING = scaleSizeW\(designSpacing\.(\w+)\)/.exec(s.playlistGrid)
  push(`PlaylistGrid 列宽公式 PADDING 与网格内边距同源（${base ?? '?'}）`,
    !!padToken && padToken[1] === base, padToken ? padToken[1] : '未命中')

  return { checks, failed: checks.filter((c) => !c[1]).length, base, baseValue }
}

/** 反例（全部用当前源码变异，替换未命中算失败） */
const mutated = (key, from, to) => {
  const m = Object.assign({}, SRC)
  m[key] = SRC[key].replace(from, to)
  return { m, changed: m[key] !== SRC[key] }
}
const caught = (r) => r.failed > 0

// m1: 排行榜区标题单独换成 xl（「排行榜」三字比「推荐」多缩进 8pt）
const m1 = mutated('discovery',
  '  sectionTitle: {\n    paddingHorizontal: designSpacing.lg,',
  '  sectionTitle: {\n    paddingHorizontal: designSpacing.xl,')
// m2: 「推荐歌单」区标题（共享 SectionHeader）换成 md
const m2 = mutated('sectionHeader',
  '  container: {\n    paddingHorizontal: designSpacing.lg,',
  '  container: {\n    paddingHorizontal: designSpacing.md,')
// m3: 歌单卡片网格换成 xl（卡片比标题多缩进）
const m3 = mutated('playlistGrid',
  '  grid: {\n    flexDirection: \'row\',\n    flexWrap: \'wrap\',\n    paddingHorizontal: designSpacing.lg,',
  '  grid: {\n    flexDirection: \'row\',\n    flexWrap: \'wrap\',\n    paddingHorizontal: designSpacing.xl,')
// m4: 榜单卡片行换成 xl
const m4 = mutated('discovery',
  '  boardContent: {\n    paddingHorizontal: designSpacing.lg,',
  '  boardContent: {\n    paddingHorizontal: designSpacing.xl,')
// m5: 平台胶囊行（无父内边距版）左内边距换成 md（首屏胶囊与标题错位）
const m5 = mutated('platformChips',
  '    paddingLeft: designSpacing.lg,',
  '    paddingLeft: designSpacing.md,')
// m6: 列宽公式的扣减量与网格内边距脱钩
const m6 = mutated('playlistGrid',
  'const PADDING = scaleSizeW(designSpacing.lg)',
  'const PADDING = scaleSizeW(designSpacing.xl)')
// m7: 改 token 真值（不是「被拦下」的反例，而是「推导自 token、没抄常量」的证明）
const m7 = mutated('tokens', 'lg: 24', 'lg: 99')

// —— 输出 ——
console.log('='.repeat(92))
console.log('「推荐页左基准线」契约（第 21 轮·图一；摘自源码静态解析）')
console.log('='.repeat(92))

const initial = run(SRC)
for (const [label, ok, detail] of initial.checks) check(label, ok, detail)
console.log()
console.log(`  基准 token = designSpacing.${initial.base} = ${initial.baseValue}pt（推荐大标题行）`)

neg('反例 m1：排行榜区标题单独换 xl（多缩进 8pt），被拦下', m1.changed && caught(run(m1.m)))
neg('反例 m2：「推荐歌单」区标题换 md，被拦下', m2.changed && caught(run(m2.m)))
neg('反例 m3：歌单卡片网格换 xl，被拦下', m3.changed && caught(run(m3.m)))
neg('反例 m4：榜单卡片行换 xl，被拦下', m4.changed && caught(run(m4.m)))
neg('反例 m5：平台胶囊行左内边距换 md，被拦下', m5.changed && caught(run(m5.m)))
neg('反例 m6：列宽公式扣减量与网格内边距脱钩，被拦下', m6.changed && caught(run(m6.m)))
neg('反例 m7：token 真值 24 → 99，脚本复算的基准值必须跟着变（不是抄的常量）',
  m7.changed && run(SRC).baseValue === 24 && run(m7.m).baseValue === 99)

console.log()
console.log('='.repeat(92))
console.log('断言')
console.log('='.repeat(92))
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
