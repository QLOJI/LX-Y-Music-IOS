#!/usr/bin/env node
/**
 * sim-localdownload-row-opacity.js —— 「本地与下载」列表行底色必须与按钮同一份透明度口径
 * （用户第 22 轮·图一/图二）。
 *
 * 需求原话（2026-10-03）：
 *   「两首下载歌曲的列表背景颜色没有适配，点击歌曲后才正常显示，这个要和其他按钮背景
 *     透明度一样可以设置。」
 *
 * 根因：SongRow 普通行底色走的是不透明的 theme['c-content-background']，绕过了
 * 「按钮透明度」设置（theme.buttonOpacity）；点进 isPlaying 态才切成跟随透明度的
 * c-primary-background-hover 高亮底 —— 用户看到的「点击后才正常显示」就是这个差。
 *
 * 收敛结果：
 *   一、SongRow 两态底色同一口径 —— 同一个 c-primary-background token +
 *       applyOpacity(…, buttonOpacity)；选中/播放中只是换成更亮一档的变体
 *       （第 46 轮起 = 歌曲行专用 token，见下），token 与按钮（批量管理 / 刷新）**同源**。
 *   二、行自己订阅 theme.buttonOpacity（hook 值进不了 memo 却必须参与重渲染），
 *       改透明度设置时行底色立即跟随，不需要点击行才刷新。
 *   三、行底色不得再用不透明的 c-content-background。
 *
 * 第 23 轮（2026-10-03）补充：用户要求「本地与下载」批量选择浮动条（selectBar）也纳入
 * 「和其他按钮一样（按钮透明度）」范围——它是页面级容器面，但同样跟随：
 * applyOpacity(c-primary-background, buttonOpacity)，与页头按钮同 token 同函数。
 *
 * 第 46 轮（2026-10-10）补充 —— 用户第 3 条原话：
 *   「这个软件所有单选和全选歌曲或者播放歌曲时歌曲列的背景底纹显示有点淡了，
 *     可以通过加深一点的方法解决。」
 * 「选中 / 播放中」那一档不再复用 c-primary-background-hover（20% alpha）。那只 token 同时还
 * 兼着**非行面**的底色（评论输入框 / 发送按钮 / 首页入口行按下态 / 回复条），就地加深会把无关
 * 界面一并染色；因此新起一只歌曲行专用语义 token c-list-item-background-selected =
 * 调色板 c-primary-light-300-alpha-600（40%，既有的一档，不是新造的颜色）。
 * 落点：类型声明（types/theme.d.ts）+ 两张映射表（theme/themes/index.ts 热更新后 /
 * store/theme/state.ts 首帧前，两份必须同值）+ 全工程 5 个歌曲行消费点。
 * 形状不变：仍然包 applyOpacity(…, buttonOpacity) ⇒ 仍受「按钮透明度」控制。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：颜色 token 换成不透明值仍是合法 TS）。
 * 运行：node scripts/sim-localdownload-row-opacity.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const FILE = 'src/screens/Home/Views/LocalDownload/index.tsx'
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// SongRow 组件体：从 `const SongRow = memo(` 到页面组件 `export default memo(() => {` 为止。
// （memo( ({...}) => {...}) 带两层括号，不用大括号配平；用下一个顶层声明做边界。）
const songRowBody = (raw) => {
  const start = raw.indexOf('const SongRow = memo(')
  const end = raw.indexOf('export default memo(() => {')
  if (start < 0 || end <= start) return null
  return raw.slice(start, end)
}

const invariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  const row = songRowBody(code)
  if (!row) {
    reasons.push('SongRow 组件体抽取失败（锚点漂移：const SongRow = memo( / export default memo）')
    return reasons
  }

  // ① 行自己订阅「按钮透明度」：设置一改，行底色立即重渲染（不靠点击行触发）
  if (!row.includes("useSettingValue('theme.buttonOpacity')")) {
    reasons.push('SongRow 未订阅 theme.buttonOpacity（改透明度设置后行底色不会立即跟随，仍要点击一次才刷新）')
  }

  // ② 两态底色 = 同一个 token + applyOpacity，与页头按钮同口径
  //    【第 46 轮】高亮底 token 换成歌曲行专用 c-list-item-background-selected（第 3 条：
  //    选中/播放中的行底纹加深一档）；形状不变 —— 仍然包 applyOpacity(…, buttonOpacity)。
  if (!row.includes("applyOpacity(theme['c-list-item-background-selected'], buttonOpacity)")) {
    reasons.push('播放中/选中行未走 applyOpacity(c-list-item-background-selected, buttonOpacity)（高亮底绕过了按钮透明度，或退回了旧的 c-primary-background-hover）')
  }
  if (!row.includes("applyOpacity(theme['c-primary-background'], buttonOpacity)")) {
    reasons.push('普通行未走 applyOpacity(c-primary-background, buttonOpacity)（用户报的「点击后才正常显示」的根因写法）')
  }
  // ③ 行底色不得回到不透明 c-content-background（那是绕过透明度设置的老写法）
  if (/backgroundColor:[^\n]*c-content-background/.test(row)) {
    reasons.push('行底色又用了不透明的 c-content-background（绕过「按钮透明度」设置）')
  }
  if (!code.includes("import { applyOpacity } from '@/utils/colorOpacity'")) {
    reasons.push('applyOpacity 未引入（透明度口径的工具函数缺失）')
  }

  // ④ 与页头按钮同源：批量管理 / 刷新按钮的底色也是同一 token + applyOpacity
  const btnHits = (code.match(/applyOpacity\(theme\['c-primary-background'\], buttonOpacity\)/g) ?? []).length
  if (btnHits < 4) {
    reasons.push(`行底色未与页头按钮同源（c-primary-background + applyOpacity 全文只出现 ${btnHits} 处，应 ≥4：批量管理 / 刷新 / 普通行 / 选择浮动条）`)
  }

  // ⑤ 选择浮动条（第 23 轮入列）：页面级容器面也跟随「按钮透明度」，不得回潮不透明底色
  const barAt = code.indexOf('styles.selectBar,')
  if (barAt < 0) {
    reasons.push('selectBar 抽取失败（锚点漂移：styles.selectBar,）')
  } else {
    const bar = code.slice(barAt, barAt + 600)
    if (!bar.includes("applyOpacity(theme['c-primary-background'], buttonOpacity)")) {
      reasons.push('选择浮动条未走 applyOpacity(c-primary-background, buttonOpacity)（仍是不透明容器面，未跟随「按钮透明度」）')
    }
    if (/backgroundColor:[^\n]*c-content-background/.test(bar)) {
      reasons.push('选择浮动条底色又用了不透明的 c-content-background（第 23 轮已要求跟随按钮透明度）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 ⑥（第 46 轮第 3 条）：歌曲行「单选 / 全选 / 播放中」的底纹
//   = 歌曲行专用语义 token，且落在「比原先那一档更深」的取值上
// ---------------------------------------------------------------------------

// 全工程的歌曲行消费点。第 46 轮逐个核过：这 5 个文件是仅有的「isPlaying / isSelected 决定
// 整行底色」的歌曲行；OnlineList 那一份同时覆盖歌单详情 / 搜索 / 排行榜 / 每日推荐 /
// 播放历史 / 新建歌单等所有走在线列表的界面。
const R46_CONSUMERS = [
  {
    file: 'src/components/OnlineList/ListItem.tsx',
    label: '在线列表（歌单详情 / 搜索 / 排行榜 / 播放历史…）',
    must: ["applyOpacity(theme['c-list-item-background-selected'], buttonOpacity)"],
    mustNot: ["applyOpacity(theme['c-primary-background-hover'], buttonOpacity)"],
  },
  {
    file: 'src/screens/Home/Views/Mylist/MusicList/ListItem.tsx',
    label: '试听列表',
    must: ["applyOpacity(theme['c-list-item-background-selected'], buttonOpacity)"],
    mustNot: ["applyOpacity(theme['c-primary-background-hover'], buttonOpacity)"],
  },
  {
    file: 'src/screens/Home/Views/LocalDownload/index.tsx',
    label: '本地与下载',
    must: ["applyOpacity(theme['c-list-item-background-selected'], buttonOpacity)"],
    mustNot: ["applyOpacity(theme['c-primary-background-hover'], buttonOpacity)"],
  },
  {
    file: 'src/screens/Home/Views/WebDAV/index.tsx',
    label: 'WebDAV',
    // 这一支是第 25 轮定的「播放中 : 未播放」三行写法：两支包在同一个 applyOpacity 里，
    // 所以锚点只取三元里那一行。旧写法（播放中直接吃 hover）必须不再出现。
    must: ["isPlaying ? theme['c-list-item-background-selected'] : theme['c-content-background'],"],
    mustNot: ["isPlaying ? theme['c-primary-background-hover'] : theme['c-content-background'],"],
  },
  {
    file: 'src/screens/Home/Views/Mylist/MyList/DuplicateMusic.tsx',
    label: '重复歌曲弹窗',
    must: ["applyOpacity(theme['c-list-item-background-selected'], buttonOpacity)"],
    mustNot: ["applyOpacity(theme['c-primary-background-hover'], buttonOpacity)"],
  },
]

// 语义 token 的三处落地：类型声明 + 两张映射表（热更新后的 buildActiveThemeColors、
// 首帧前的初始 state）。少一处就是「首帧 vs 从设置页回来深浅跳一下」。
const R46_TOKEN_SITES = [
  {
    file: 'src/types/theme.d.ts',
    label: '类型声明',
    must: ["'c-list-item-background-selected': string"],
  },
  {
    file: 'src/theme/themes/index.ts',
    label: '映射表 buildActiveThemeColors（主题加载后）',
    must: ["'c-list-item-background-selected': theme.config.themeColors['c-primary-light-300-alpha-600'],"],
  },
  {
    file: 'src/store/theme/state.ts',
    label: '映射表 初始 state（首帧前）',
    must: ["'c-list-item-background-selected': theme['c-primary-light-300-alpha-600'],"],
  },
]

const R46_FILES = []
for (const c of R46_CONSUMERS) R46_FILES.push(c.file)
for (const t of R46_TOKEN_SITES) R46_FILES.push(t.file)

const readR46 = () => {
  const files = {}
  for (const f of R46_FILES) files[f] = read(f)
  return { files }
}
// 只替换指定文件（反例用），其余文件保持真源码
const withFiles = (real, over) => {
  const files = {}
  for (const f of R46_FILES) files[f] = f in over ? over[f] : real.files[f]
  return { files }
}

const songRowHighlightInvariants = (real) => {
  const reasons = []

  for (const c of R46_CONSUMERS) {
    const raw = real.files[c.file]
    if (raw == null) {
      reasons.push(`${c.label} 读取失败（${c.file}）`)
      continue
    }
    const code = stripComments(raw)
    for (const s of c.must) {
      if (!code.includes(s)) {
        reasons.push(`${c.label}（${c.file}）的选中/播放中行底纹没走歌曲行专用 token（缺 ${s}）`)
      }
    }
    for (const s of c.mustNot) {
      if (code.includes(s)) {
        reasons.push(`${c.label}（${c.file}）的行底色又退回 c-primary-background-hover（第 46 轮已换成歌曲行专用 token）`)
      }
    }
  }

  for (const t of R46_TOKEN_SITES) {
    const raw = real.files[t.file]
    if (raw == null) {
      reasons.push(`${t.label} 读取失败（${t.file}）`)
      continue
    }
    const code = stripComments(raw)
    for (const s of t.must) {
      if (!code.includes(s)) {
        reasons.push(`歌曲行底纹 token 未落到「比 c-primary-background-hover 深一档」的取值上（${t.label} 缺 ${s}）`)
      }
    }
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

const runCounterExamples = (REAL, REAL46) => {
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

  // c1 普通行退回不透明 c-content-background（老写法）
  check('c1 普通行退回不透明底色', () => invariants(tamper(REAL,
    ": applyOpacity(theme['c-primary-background'], buttonOpacity),",
    ": theme['c-content-background'],")),
  '普通行未走 applyOpacity(c-primary-background, buttonOpacity)')

  // c2 行不再订阅 theme.buttonOpacity（改为硬编码 1）
  check('c2 行不再订阅按钮透明度', () => invariants(tamper(REAL,
    "    const buttonOpacity = useSettingValue('theme.buttonOpacity')\n    return (",
    "    const buttonOpacity = 1\n    return (")),
  'SongRow 未订阅 theme.buttonOpacity')

  // c3 播放中/选中行退回不透明高亮底（token 名保持第 46 轮的，只改「形状」）
  check('c3 高亮行退回不透明底色', () => invariants(tamper(REAL,
    "? applyOpacity(theme['c-list-item-background-selected'], buttonOpacity)",
    "? theme['c-list-item-background-selected']")),
  '播放中/选中行未走 applyOpacity')

  // c4 选择浮动条退回不透明底色（第 23 轮范围）
  check('c4 浮动条退回不透明底色', () => invariants(tamper(REAL,
    "backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),\n                    // 悬浮在迷你播放器胶囊上方",
    "backgroundColor: theme['c-content-background'],\n                    // 悬浮在迷你播放器胶囊上方")),
  '选择浮动条底色又用了不透明')

  // c5 在线列表行底色退回旧的 hover token（第 46 轮第 3 条的回退方向）
  check('c5 在线列表行底色退回旧 token', () => songRowHighlightInvariants(withFiles(REAL46, {
    'src/components/OnlineList/ListItem.tsx': tamper(REAL46.files['src/components/OnlineList/ListItem.tsx'],
      "applyOpacity(theme['c-list-item-background-selected'], buttonOpacity)",
      "applyOpacity(theme['c-primary-background-hover'], buttonOpacity)"),
  })), '没走歌曲行专用 token')

  // c6 映射值退回更浅的一档（alpha-800 = 旧的 20%，等于第 3 条没修）
  check('c6 映射值退回更浅一档', () => songRowHighlightInvariants(withFiles(REAL46, {
    'src/theme/themes/index.ts': tamper(REAL46.files['src/theme/themes/index.ts'],
      "'c-list-item-background-selected': theme.config.themeColors['c-primary-light-300-alpha-600'],",
      "'c-list-item-background-selected': theme.config.themeColors['c-primary-light-300-alpha-800'],"),
  })), '深一档')

  // c7 只在热更新那张表里加了 token，首帧那张漏了（首帧与从设置页回来深浅跳一下）
  check('c7 首帧映射表漏了 token', () => songRowHighlightInvariants(withFiles(REAL46, {
    'src/store/theme/state.ts': tamper(REAL46.files['src/store/theme/state.ts'],
      "    'c-list-item-background-selected': theme['c-primary-light-300-alpha-600'],\n",
      ''),
  })), '首帧前')

  // c8 重复歌曲弹窗的选中行没包 applyOpacity（token 对了，透明度又脱离设置）
  check('c8 重复弹窗选中行脱离透明度', () => songRowHighlightInvariants(withFiles(REAL46, {
    'src/screens/Home/Views/Mylist/MyList/DuplicateMusic.tsx': tamper(
      REAL46.files['src/screens/Home/Views/Mylist/MyList/DuplicateMusic.tsx'],
      "? applyOpacity(theme['c-list-item-background-selected'], buttonOpacity)",
      "? theme['c-list-item-background-selected']"),
  })), '没走歌曲行专用 token')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-localdownload-row-opacity ===')
console.log('「本地与下载」列表行底色 = 按钮同一份透明度口径（第 22 轮·图一/图二 + 第 23 轮浮动条）')
console.log('歌曲行「单选/全选/播放中」底纹 = 歌曲行专用 token 且深一档（第 46 轮第 3 条）')
console.log()

const REAL = read(FILE)
const REAL46 = readR46()
const reasons = [...invariants(REAL), ...songRowHighlightInvariants(REAL46)]
if (reasons.length === 0) {
  console.log('[不变量] PASS —— 行两态底色同 token + applyOpacity；行订阅 theme.buttonOpacity；选择浮动条同口径；5 个歌曲行消费点 + 3 处 token 落地')
} else {
  console.log('[不变量] FAIL')
  reasons.forEach(r => console.log('  FAIL ' + r))
}

console.log('\n[反例自检]')
const ceResults = runCounterExamples(REAL, REAL46)
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.detail}`)
  if (!r.ok) ceAllOk = false
}

const invOk = reasons.length === 0
const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${invOk ? 2 : 0}/2：行底色口径 + 歌曲行底纹 token；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
