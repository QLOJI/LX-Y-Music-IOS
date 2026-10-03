#!/usr/bin/env node
/**
 * sim-song-row-style-unify.js —— 「歌曲列表行的样式只有一份」契约（用户第 24 轮追加）。
 *
 * 需求原话（2026-10-03 第 24 轮）：
 *   「又发现一个问题：1、如图，网易列表和QQ列表的歌曲字体粗细不一致，都统一为网易字体。」
 *   「如图，列表中右边的歌曲时间，爱心，三个点的位置都不统一，请把列表栏所有样式都统一下」
 *
 * 修法：新建 src/components/common/songRowStyles.ts 作为**唯一来源**（行内几何 / 字重 / 字号），
 * 三处歌曲行改用它，并删掉各自那份：
 *   - src/components/OnlineList/ListItem.tsx（歌单详情 / 搜索 / 排行榜 / 每日推荐…）
 *   - src/screens/Home/Views/Mylist/MusicList/ListItem.tsx（我的列表 / 试听列表）
 *   - src/screens/Home/Views/WebDAV/index.tsx（WebDAV 歌曲行，本文件内联的那一份）
 * 同时补上「爱心位恒占位」：没有收藏能力的音源此前不留位，时长与 ⋮ 会一起右移一个按钮宽。
 *
 * 为什么必须靠契约脚本：这类回归 tsc/eslint 完全无感 —— 往行组件里再写一份
 * `songName: { fontWeight: '600' }`、把爱心位改成 `: null`、把 ⋮ 按钮改回 `height: '80%'`，
 * 全都能编译、都能跑，只在真机上表现为「两个列表的字体粗细/时间与爱心与 ⋮ 的落点不一样」。
 * 带反例自检：对篡改后的源码跑同一套判断，必须被拦下。
 * 运行：node scripts/sim-song-row-style-unify.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  shared: 'src/components/common/songRowStyles.ts',
  online: 'src/components/OnlineList/ListItem.tsx',
  mylist: 'src/screens/Home/Views/Mylist/MusicList/ListItem.tsx',
  webdav: 'src/screens/Home/Views/WebDAV/index.tsx',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// 行组件里**不许再出现**的样式键（它们已归共享模块：谁写第二份就判红）
const SHARED_KEYS = [
  'listItem', 'listItemLeft', 'sn', 'snIndex', 'albumArt', 'itemInfo',
  'songName', 'songTitle', 'indexText', 'listItemSingle', 'listItemSingleText',
  'interval', 'iconButton', 'likeButton', 'moreButton',
]
const localKeyRe = new RegExp(`^ {2}(${SHARED_KEYS.join('|')}): \\{`, 'm')

// ---------------------------------------------------------------------------
// 不变量 A：共享模块（唯一来源）—— 几何/字重/字号的取值本身
// ---------------------------------------------------------------------------

const sharedInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!code.includes('export const songRowMetrics = {')) {
    reasons.push('songRowStyles.ts 未导出 songRowMetrics（JSX 里的 Icon/Text size 也要取这里的值）')
  }
  if (!code.includes('export const songRowStyles = createStyle({')) {
    reasons.push('songRowStyles.ts 未导出 songRowStyles（createStyle 包裹的样式表）')
  }

  for (const [needle, label] of [
    ['coverBoxWidth: 70', '封面盒宽 70'],
    ['indexBoxWidth: 40', '序号盒宽 40'],
    ['coverSize: 54', '封面 54'],
    ['iconButtonSize: 40', '图标按钮 40（爱心 / ⋮ 的固定热区）'],
    ['iconSize: 17', '图标 17'],
    ['metaTextSize: 12', '副标题与时长字号 12'],
    ['indexTextSize: 14', '序号字号 14'],
    ['intervalMinWidth: 44', '时长列最小宽度 44'],
  ]) {
    if (!code.includes(needle)) reasons.push(`songRowMetrics 缺 ${label}（${needle}）`)
  }

  // 行标题字重：统一为「不覆盖」的常规体（'400'）。'600' 是当初粗的那一侧。
  const nameBlock = /songName: \{([\s\S]*?)\}/.exec(code)
  if (!nameBlock) {
    reasons.push('songRowStyles 缺 songName 样式（行标题字重统一靠它）')
  } else if (!/fontWeight: '400'/.test(nameBlock[1])) {
    reasons.push(`行标题字重不是 '400'（现为 ${nameBlock[1].trim().replace(/\s+/g, ' ')}）：三处列表要统一为细体口径`)
  }

  const singleBlock = /listItemSingle: \{([\s\S]*?)\}/.exec(code)
  if (!singleBlock) {
    reasons.push('songRowStyles 缺 listItemSingle（副标题行）')
  } else if (!/alignItems: 'center'/.test(singleBlock[1])) {
    reasons.push('副标题行未居中（alignItems: center）：徽标与文字会各按自身行框落位，行高参差')
  }

  const intervalBlock = /interval: \{([\s\S]*?)\}/.exec(code)
  if (!intervalBlock) {
    reasons.push('songRowStyles 缺 interval（时长列）')
  } else {
    if (!/minWidth: songRowMetrics\.intervalMinWidth/.test(intervalBlock[1])) {
      reasons.push('时长列没有固定最小宽度：数字宽度一变，位置就自己飘（用户报的「时间位置不统一」）')
    }
    if (!/textAlign: 'right'/.test(intervalBlock[1])) {
      reasons.push('时长列未右对齐：各行时长右缘不在同一条竖线上')
    }
    if (!/marginRight/.test(intervalBlock[1])) {
      reasons.push('时长列与爱心之间没有固定间距（marginRight）')
    }
  }

  for (const [key, extra] of [['likeButton', 'marginHorizontal'], ['moreButton', 'marginRight']]) {
    const block = new RegExp(`${key}: \\{([\\s\\S]*?)\\}`).exec(code)
    if (!block) {
      reasons.push(`songRowStyles 缺 ${key}`)
      continue
    }
    if (!/width: songRowMetrics\.iconButtonSize/.test(block[1]) || !/height: songRowMetrics\.iconButtonSize/.test(block[1])) {
      reasons.push(`${key} 不是固定 40×40（iconButtonSize）：行与行之间会随内容挪位`)
    }
    if (!block[1].includes(extra)) reasons.push(`${key} 缺 ${extra}`)
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：三处歌曲行不再自带第二份（否则「统一」只统一了其中一处）
// ---------------------------------------------------------------------------

const rowComponentInvariants = (name, raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!/import \{ songRowMetrics, songRowStyles/.test(code) && !/import \{ songRowStyles/.test(code)) {
    reasons.push(`${name} 未从 @/components/common/songRowStyles 取行样式（各写各的就会再次分叉）`)
  }
  const hit = localKeyRe.exec(code)
  if (hit) {
    reasons.push(`${name} 里又出现了一份行内样式键 ${hit[1]}：歌曲行的几何/字重只许有一条来源（components/common/songRowStyles.ts）`)
  }
  if (/fontWeight: '600'/.test(code)) {
    reasons.push(`${name} 里还有 '600' 字重（行标题要统一为共享模块的 '400' 细体）`)
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：三处的 JSX 用法同口径（尺寸取 metrics、爱心位恒占位、时长走共享样式）
// ---------------------------------------------------------------------------

/**
 * WebDAV/index.tsx 是整个文件架页（配置 / 歌曲 / 文件夹 + 文件浏览器），同一文件里还有
 * 「文件夹行 / 面包屑 / 搜索栏」等**别的**行型（它们有自己的 size={11} 小字，不归歌曲行管）。
 * 只截取歌曲行的 JSX 区段来判断：从 `songRowStyles.sn` 到 `songRowMetrics.iconSize`（⋮ 图标）。
 */
const songRowRegion = (code) => {
  const from = code.indexOf('songRowStyles.sn')
  const to = code.indexOf('songRowMetrics.iconSize')
  if (from < 0 || to < 0) return code
  return code.slice(from, to + 'songRowMetrics.iconSize'.length)
}

const jsxInvariants = (name, raw, { withHeart, withInterval = true, scope = 'file' }) => {
  const reasons = []
  const full = stripComments(raw)
  const code = scope === 'songRow' ? songRowRegion(full) : full

  if (withHeart) {
    // 爱心位恒占位：不可点时渲染等宽空 View（否则时长与 ⋮ 会右移一个按钮宽）
    if (!/\) : <View style=\{styles\.likeButton\} \/>\}/.test(code)) {
      reasons.push(`${name} 的爱心位不是恒占位（无爱心时不留位 ⇒ 时长与 ⋮ 会右移一个按钮宽）`)
    }
  }

  const metaCount = (code.match(/songRowMetrics\.metaTextSize/g) ?? []).length
  if (metaCount < 2) {
    reasons.push(`${name} 里副标题/时长没有全部取 songRowMetrics.metaTextSize（现 ${metaCount} 处）`)
  }
  if (/size=\{11\}/.test(code)) {
    reasons.push(`${name} 里还有写死的 size={11}（副标题/序号字号必须取共享 metrics）`)
  }

  const iconNeed = withHeart ? 2 : 1
  const iconCount = (code.match(/songRowMetrics\.iconSize/g) ?? []).length
  if (iconCount < iconNeed) {
    reasons.push(`${name} 里图标没有全部取 songRowMetrics.iconSize（现 ${iconCount} 处，应 ≥ ${iconNeed}：爱心 + ⋮）`)
  }

  // WebDAV 歌曲行没有时长列（显示的是「文件大小 · 修改时间」，也不是音乐时长），不适用该条
  if (withInterval && !/style=\{styles\.interval\}|style=\{songRowStyles\.interval\}/.test(code)) {
    reasons.push(`${name} 的时长没有走共享 interval 样式（右对齐 + 固定最小宽度）`)
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

  // c1 行标题字重回潮（'400' → '600'）
  check('c1 标题字重回潮 600', () => sharedInvariants(tamper(REAL.shared,
    "  songName: {\n    fontWeight: '400',",
    "  songName: {\n    fontWeight: '600',")),
  "行标题字重不是 '400'")

  // c2 副标题行不再居中（徽标与文字会各按自身行框落位）
  check('c2 副标题行取消居中', () => sharedInvariants(tamper(REAL.shared,
    '    paddingTop: 2,\n    flexDirection: \'row\',\n    alignItems: \'center\',',
    '    paddingTop: 2,\n    flexDirection: \'row\',')),
  '副标题行未居中')

  // c3 时长列丢了右对齐（各行时长右缘不再同一条竖线）
  check('c3 时长列取消右对齐', () => sharedInvariants(tamper(REAL.shared,
    "    textAlign: 'right',",
    "    textAlign: 'left',")),
  '时长列未右对齐')

  // c4 图标按钮尺寸被改（⋮ 与爱心的落点整体挪位）
  check('c4 图标按钮不再 40', () => sharedInvariants(tamper(REAL.shared,
    '  iconButtonSize: 40,',
    '  iconButtonSize: 56,')),
  '图标按钮 40')

  // c5 爱心位不再占位（无爱心行 ⇒ 时长与 ⋮ 右移）
  check('c5 爱心位改回条件渲染', () => jsxInvariants('Mylist', tamper(REAL.mylist,
    '        ) : <View style={styles.likeButton} />}',
    '        ) : null}'), { withHeart: true }),
  '爱心位不是恒占位')

  // c6 OnlineList 又写回自己的一份 songName（'600'）
  check('c6 OnlineList 又自写 songName', () => rowComponentInvariants('OnlineList', tamper(REAL.online,
    'export default (props: ListItemProps) => {',
    "const styles = createStyle({\n  songName: {\n    fontWeight: '600',\n  },\n})\n\nexport default (props: ListItemProps) => {")),
  '又出现了一份行内样式键')

  // c7 Mylist 副标题字号写死回 11
  check('c7 Mylist 写死字号 11', () => jsxInvariants('Mylist', tamper(REAL.mylist,
    'size={songRowMetrics.metaTextSize}',
    'size={11}'), { withHeart: true }),
  'size={11}')

  // c8 WebDAV 的 ⋮ 又退回本文件私有样式
  check('c8 WebDAV ⋮ 退回私有样式', () => rowComponentInvariants('WebDAV', tamper(REAL.webdav,
    '            songRowStyles.moreButton,',
    '            styles.moreButton,') + '\nconst moreButtonExtra = {\n  moreButton: {\n    height: \'80%\',\n  },\n}\n'),
  '又出现了一份行内样式键')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-song-row-style-unify ===')
console.log('歌曲列表行样式唯一来源：共享模块 + 三处歌曲行（歌单详情 / 我的列表 / WebDAV）同口径 + 爱心位恒占位（第 24 轮）')
console.log()

const checks = [
  ['共享模块（metrics 取值 / 标题字重 400 / 副标题行居中 / 时长右对齐且定宽 / 图标按钮 40×40）', () => sharedInvariants(REAL.shared)],
  ['OnlineList/ListItem（歌单详情等）不再自带第二份', () => rowComponentInvariants('OnlineList', REAL.online)],
  ['Mylist/MusicList/ListItem（我的列表）不再自带第二份', () => rowComponentInvariants('Mylist', REAL.mylist)],
  ['WebDAV 歌曲行不再自带第二份', () => rowComponentInvariants('WebDAV', REAL.webdav)],
  ['JSX 同口径（OnlineList：metrics + 爱心位恒占位 + 共享时长）', () => jsxInvariants('OnlineList', REAL.online, { withHeart: true })],
  ['JSX 同口径（Mylist：metrics + 爱心位恒占位 + 共享时长）', () => jsxInvariants('Mylist', REAL.mylist, { withHeart: true })],
  ['JSX 同口径（WebDAV：metrics + 共享 ⋮；无爱心/无时长列，只判歌曲行区段）', () => jsxInvariants('WebDAV', REAL.webdav, { withHeart: false, withInterval: false, scope: 'songRow' })],
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
