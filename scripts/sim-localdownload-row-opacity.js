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
 *       applyOpacity(…, buttonOpacity)；选中/播放中只是换成 -hover 变体，
 *       token 与按钮（批量管理 / 刷新）**同源**。
 *   二、行自己订阅 theme.buttonOpacity（hook 值进不了 memo 却必须参与重渲染），
 *       改透明度设置时行底色立即跟随，不需要点击行才刷新。
 *   三、行底色不得再用不透明的 c-content-background。
 *
 * 第 23 轮（2026-10-03）补充：用户要求「本地与下载」批量选择浮动条（selectBar）也纳入
 * 「和其他按钮一样（按钮透明度）」范围——它是页面级容器面，但同样跟随：
 * applyOpacity(c-primary-background, buttonOpacity)，与页头按钮同 token 同函数。
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
  if (!row.includes("applyOpacity(theme['c-primary-background-hover'], buttonOpacity)")) {
    reasons.push('播放中/选中行未走 applyOpacity(c-primary-background-hover, buttonOpacity)（高亮底绕过了按钮透明度）')
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
// 反例（对篡改后的源码跑同一套判断，必须被拦下）
// ---------------------------------------------------------------------------

const tamper = (src, find, replace) => {
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find.slice(0, 60)}`)
  return src.replace(find, replace)
}

const runCounterExamples = (REAL) => {
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

  // c3 播放中/选中行退回不透明高亮底
  check('c3 高亮行退回不透明底色', () => invariants(tamper(REAL,
    "? applyOpacity(theme['c-primary-background-hover'], buttonOpacity)",
    "? theme['c-primary-background-hover']")),
  '播放中/选中行未走 applyOpacity')

  // c4 选择浮动条退回不透明底色（第 23 轮范围）
  check('c4 浮动条退回不透明底色', () => invariants(tamper(REAL,
    "backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),\n                    // 悬浮在迷你播放器胶囊上方",
    "backgroundColor: theme['c-content-background'],\n                    // 悬浮在迷你播放器胶囊上方")),
  '选择浮动条底色又用了不透明')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-localdownload-row-opacity ===')
console.log('「本地与下载」列表行底色 = 按钮同一份透明度口径（第 22 轮·图一/图二 + 第 23 轮浮动条）')
console.log()

const REAL = read(FILE)
const reasons = invariants(REAL)
if (reasons.length === 0) {
  console.log('[不变量] PASS —— 行两态底色同 token + applyOpacity；行订阅 theme.buttonOpacity；选择浮动条同口径')
} else {
  console.log('[不变量] FAIL')
  reasons.forEach(r => console.log('  FAIL ' + r))
}

console.log('\n[反例自检]')
const ceResults = runCounterExamples(REAL)
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.detail}`)
  if (!r.ok) ceAllOk = false
}

const invOk = reasons.length === 0
const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${invOk ? 1 : 0}/1；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
