#!/usr/bin/env node
/**
 * sim-sync-button-grid.js —— 数据同步页六个动作按钮两列网格对齐契约（用户第 23 轮）。
 *
 * 需求原话（2026-10-03）：
 *   「中间这些按钮也要对齐，现在太乱了。」（附数据同步页截图：测试连接 / 立即同步歌单 /
 *     上传设置与音源 / 下载设置与音源 / 上传歌单 / 下载歌单 六按钮右列参差）
 *
 * 根因：三个 btnRow 里按钮是内容宽（文字长度不同 → 左按钮宽度不同 → 右按钮起点
 * 跟着飘），两行之间也对不齐。修法：每个按钮包进 btnCell 单元
 * （flexGrow: 1 + flexBasis: '45%'，与设置页两列勾选网格 CheckBoxGrid 的单元格
 * 同几何）——行宽扣除 gap 后两格等分，六按钮左右缘全部对齐；设置页 Button 新增
 * 可选 block（网格内去掉并排预留的 marginRight: 10，两列右缘与单元齐平）。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：少包一层 View 完全合法，只在视觉上参差）。
 * 运行：node scripts/sim-sync-button-grid.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  sync: 'src/screens/Home/Views/Setting/settings/Sync/index.tsx',
  button: 'src/screens/Home/Views/Setting/components/Button.tsx',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// ---------------------------------------------------------------------------
// 不变量 A：Sync 页 —— 六个按钮都被 btnCell 单元包住，单元几何 = 两列网格
// ---------------------------------------------------------------------------

const syncInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ① 六个按钮各有一个 btnCell 单元（测试连接 / 立即同步歌单 / 上传设置与音源 /
  //    下载设置与音源 / 上传歌单 / 下载歌单）
  const cells = (code.match(/<View style=\{styles\.btnCell\}>/g) ?? []).length
  if (cells !== 6) {
    reasons.push(`btnCell 单元 ${cells} 个（应为 6：六个动作按钮各占一格，少一格就有按钮回到内容宽）`)
  }

  // ② 结构：单元先于按钮（btnCell → <Button block），六对全部命中
  const pairs = (code.match(/<View style=\{styles\.btnCell\}>[\s\S]{0,240}?<Button block /g) ?? []).length
  if (pairs < 6) {
    reasons.push(`btnCell→Button 结构命中 ${pairs}/6（有按钮没被单元包住 = 宽度仍由文字撑开、右列参差）`)
  }

  // ③ 单元格几何与设置页两列勾选网格同源：flexGrow 1 + flexBasis 45%
  const cellStyle = /btnCell:\s*\{([\s\S]*?)\}/.exec(code)
  if (!cellStyle) {
    reasons.push('缺 styles.btnCell（网格单元样式）')
  } else {
    if (!/flexGrow:\s*1/.test(cellStyle[1])) {
      reasons.push('btnCell 缺 flexGrow: 1（两格不能均分行宽剩余，靠近的两格宽度会不等）')
    }
    if (!/flexBasis:\s*'45%'/.test(cellStyle[1])) {
      reasons.push("btnCell 缺 flexBasis: '45%'（每行恰好两格的分格依据，与 CheckBoxGrid 单元格同几何）")
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：Button 组件 —— 可选 block（网格内去掉并排右外边距）
// ---------------------------------------------------------------------------

const buttonInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!/\bblock\?:\s*boolean/.test(code)) {
    reasons.push('Button 未提供 block 可选 prop（网格单元内无法去掉并排右外边距，两列右缘不齐）')
  }
  if (!code.includes('block && styles.buttonBlock')) {
    reasons.push('Button 未把 block 接进样式数组')
  }
  const blk = /buttonBlock:\s*\{([\s\S]*?)\}/.exec(code)
  if (!blk) {
    reasons.push('缺 styles.buttonBlock')
  } else if (!/marginRight:\s*0/.test(blk[1])) {
    reasons.push('buttonBlock 未把 marginRight 归零（按钮右缘仍比单元短 10pt）')
  }
  // 非网格调用（其余 10 个设置页）不受影响：基础并排间距必须保留
  if (!/marginRight:\s*10/.test(code)) {
    reasons.push('基础 marginRight: 10 被误删（非网格页面的并排按钮间距丢失）')
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

  // e1 一个按钮的单元被拆掉（该按钮回到内容宽）
  check('e1 拆掉一个 btnCell 单元', () => syncInvariants(tamper(REAL.sync,
    '<View style={styles.btnCell}>',
    '<View>')),
  'btnCell 单元 5 个')

  // e2 单元丢掉 flexBasis（两格不再等宽）
  check('e2 单元丢掉 flexBasis', () => syncInvariants(tamper(REAL.sync,
    "    flexBasis: '45%',\n",
    '')),
  "btnCell 缺 flexBasis: '45%'")

  // e3 Button 未接 block（右缘留 10pt 空心）
  check('e3 Button 未接 block', () => buttonInvariants(tamper(REAL.button,
    '        block && styles.buttonBlock,\n',
    '')),
  'Button 未把 block 接进样式数组')

  // e4 buttonBlock 不再归零右外边距
  check('e4 buttonBlock 不归零', () => buttonInvariants(tamper(REAL.button,
    '    marginRight: 0,',
    '    marginRight: 10,')),
  'buttonBlock 未把 marginRight 归零')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-sync-button-grid ===')
console.log('数据同步页六按钮两列网格对齐（第 23 轮：btnCell = 45% + flexGrow；Button.block）')
console.log()

const checks = [
  ['Sync 页（六按钮 × btnCell 单元 + 单元几何 = 两列网格）', () => syncInvariants(REAL.sync)],
  ['Button 组件（可选 block：网格内右外边距归零，非网格调用不受影响）', () => buttonInvariants(REAL.button)],
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
