#!/usr/bin/env node
/**
 * sim-jsx-import-guard.js —— 「JSX 里用到的组件必须有绑定（导入/声明）」契约不变量
 * （第 20 轮·图一，2026-10-03）。
 *
 * 需求来源（用户原话）：
 *   「当我输入网易云音乐 cookie 后，点击网易云每日推荐后报错，如图，软件再也进不去了」。
 *
 * 根因：src/screens/Home/Views/DailyRec/index.tsx 的 Tabs 里用了 <ScrollView>（横向滑动
 * 的两个主 tab），但 react-native 的具名导入里从来没有它 —— 渲染到 Tabs 就抛
 * ReferenceError: Property 'ScrollView' doesn't exist，整棵组件树直接崩（不是渲染报错兜底，
 * 是进页面即炸）。本工程没有编译/运行环境，验证只有「真解析器扫语法 + 契约脚本」两道；
 * 解析器只管语法对不对（少一个导入语法完全合法），此前的结构脚本也只查 JSX 形状 ——
 * 本脚本把「JSX 标识符的绑定缺口」这一类纳入契约。
 *
 * 覆盖面：src 下所有 .ts/.tsx。对白名单 RN_JSX_NAMES 里的名字，只要在（剥注释、挖字符串后的）
 * 源码里出现 JSX 形态的使用（`<Name` 后跟空白 / `>` / `/` / `.`，含 <Animated.View> 这种
 * 成员表达式），就必须在同一个文件里有绑定，三者其一：
 *   a) 出现在任一 `import … from '…'` 语句里（不限来源：react-native / 本仓组件 / 第三方库都算）；
 *   b) 本地声明（const / let / var / function / class Name）；
 *   c) 解构取值（`{ … Name … } = …` 形态，如 const { Name } = props）。
 * 注释先剥离、字符串先挖空 —— 注释里写 <ScrollView> 不算使用、也不当绑定。
 *
 * 白名单刻意收窄到「react-native 常见 JSX 组件名 + Animated」：
 * 泛型参数（<T,> / <T extends object>）不在名单里，从构造上不会误报；
 * 「扫描器报红但其实是合法代码」会让契约本身失去可信度，宁可窄一点、每条都是真亏。
 * 已知边界（如实声明）：不在白名单里的冷门 RN 导出（如 DrawerLayoutAndroid 之外的新组件）
 * 漏导入时本脚本抓不到 —— 白名单就是本脚本的全部射程。
 *
 * 反例自检（变异真实源码 + 合成片段；替换未命中 = 脚本自身失败）：
 *   m1 把 DailyRec 的 ScrollView 从 react-native 具名导入里删掉 → 必须报（图一本体）
 *   m2 把该导入改成注释 → 必须报（注释不是绑定）
 * 防误报正例（合成片段，必须不报）：
 *   p1 使用只出现在注释里   p2 泛型 <T,> / <P extends object>
 *   p3 字符串里的 '<ScrollView>'   p4 本地声明 const ScrollView = …（无导入）
 *   p5 同片段里 <View> 有导入、<Image> 没有 → 只报 Image，不连坐 View
 *
 * 运行：node scripts/sim-jsx-import-guard.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')

const DAILY_REC = 'src/screens/Home/Views/DailyRec/index.tsx'
const REAL_DAILY_REC = fs.readFileSync(path.join(ROOT, DAILY_REC), 'utf8')

/** JSX 里会用到的 react-native 组件名白名单（+ Animated，对应 <Animated.View> 形态）。 */
const RN_JSX_NAMES = [
  'View',
  'Text',
  'Image',
  'ImageBackground',
  'ScrollView',
  'FlatList',
  'SectionList',
  'VirtualizedList',
  'SafeAreaView',
  'Modal',
  'Switch',
  'Button',
  'TextInput',
  'KeyboardAvoidingView',
  'ActivityIndicator',
  'RefreshControl',
  'StatusBar',
  'Pressable',
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
  'TouchableNativeFeedback',
  'Animated',
]

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 字符串字面量挖空（含模板串）：注释/文案里提到的 <ScrollView> 不参与判定。 */
const blankStrings = (src) =>
  src
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')

/** 目录遍历：本仓脚本跑在浏览器迷你运行器里，readdirSync 不支持 withFileTypes，
 *  一律 readdirSync + statSync 判断目录（见 check-button-opacity-coverage.js 的同一备注）。 */
const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      if (name !== 'node_modules') walk(full, out)
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 该名字在（已剥注释、但保留字符串内容的）源码里有没有绑定：导入 / 本地声明 / 解构。
 *  注意：判定绑定必须保留字符串 —— import 的模块路径本身就是字符串（'react-native'），
 *  先挖字符串会让 `from '…'` 变成 `from ''`，所有导入都匹配不上（本脚本初版就栽在这）。 */
const isBound = (code, name) => {
  const n = escapeRe(name)
  // a) 任一 import … from '…' 语句里出现该名字（含 type 导入 —— 宽松侧，宁可放过）
  const importSegs = code.match(/import[\s\S]*?from\s*['"][^'"]+['"]/g) ?? []
  if (importSegs.some((seg) => new RegExp('\\b' + n + '\\b').test(seg))) return true
  // b) 本地声明
  if (new RegExp('\\b(?:const|let|var|function|class)\\s+' + n + '\\b').test(code)) return true
  // c) 解构取值（const { A, Name } = … / ({ Name } = props)）
  if (new RegExp('\\{[^}]*\\b' + n + '\\b[^}]*\\}\\s*=').test(code)) return true
  return false
}

/** 分析一份源码：JSX 形态用到的白名单名字 / 其中没有绑定的。
 *  两个视图：used 看「剥注释 + 挖字符串」的（字符串里写标签不算使用）；
 *  bound 看「剥注释、留字符串」的（导入路径是字符串，不能被挖掉）。 */
const analyze = (src) => {
  const commented = stripComments(src)
  const code = blankStrings(commented)
  const used = new Set()
  const re = /<([A-Z][A-Za-z0-9_]*)(?=[\s/>.])/g
  let m
  while ((m = re.exec(code))) {
    if (RN_JSX_NAMES.includes(m[1])) used.add(m[1])
  }
  const unbound = [...used].filter((n) => !isBound(commented, n)).sort()
  return { used: [...used], unbound }
}

/** 全仓扫描：文件数 / JSX 使用次数（扫描确实在工作）/ 违规清单。 */
const scanProject = () => {
  const files = walk(SRC)
  const violations = []
  let usages = 0
  for (const full of files) {
    const { used, unbound } = analyze(fs.readFileSync(full, 'utf8'))
    usages += used.length
    if (unbound.length) {
      violations.push({ file: path.relative(ROOT, full).replace(/\\/g, '/'), names: unbound })
    }
  }
  return { files: files.length, usages, violations }
}

// ---------------------------------------------------------------------------
// 不变量（真实源码）
// ---------------------------------------------------------------------------

const SCAN = scanProject()

const invariants = () => {
  const reasons = []

  // ① 全仓零违规：src 下没有任何「JSX 用了、文件里却没绑定」的白名单名字
  if (SCAN.violations.length) {
    for (const v of SCAN.violations) {
      reasons.push(`${v.file} 里 ${v.names.join(' / ')} 以 JSX 形态使用但文件内无绑定（缺导入/声明）`)
    }
  }

  // ② 扫描器确实在工作（防止 walk 坏了返回空表 → 0 违规假绿）
  //    地板取当前实况（706 文件 / 796 处「文件×名字」去重使用）往下留余量：删掉整页也不会踩到，
  //    但 walk 或 usage 正则一坏（掉到 0 附近）立刻翻红。
  if (SCAN.files < 650) reasons.push(`扫描面异常：只扫到 ${SCAN.files} 个文件（应 ≥650）`)
  if (SCAN.usages < 700) reasons.push(`扫描面异常：白名单 JSX 使用只统计到 ${SCAN.usages} 处（应 ≥700）`)

  // ③ 图一的具体回归钉：DailyRec 的 ScrollView 导入与使用都在
  const dailyCode = blankStrings(stripComments(REAL_DAILY_REC))
  const rnImport = REAL_DAILY_REC.match(/import\s*\{[^}]*\}\s*from\s*'react-native'/)
  if (!rnImport || !/\bScrollView\b/.test(rnImport[0])) {
    reasons.push('DailyRec 的 react-native 具名导入里没有 ScrollView（图一会复发）')
  }
  if (!/<ScrollView[\s/>.]/.test(dailyCode)) {
    reasons.push('DailyRec 里已不再以 JSX 形态使用 <ScrollView（锚点漂移，请先核对脚本）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 反例（变异真实源码 / 合成片段）
// ---------------------------------------------------------------------------

const results = []
const check = (name, fn, expected) => {
  let reasons
  try {
    reasons = fn()
  } catch (e) {
    reasons = ['脚本自身异常: ' + (e && e.message ? e.message : String(e))]
  }
  const ok = reasons.length > 0
  results.push({ name, ok, detail: reasons, expected })
  return ok
}

const tamper = (src, oldStr, newStr) => {
  if (!src.includes(oldStr)) {
    throw new Error('替换未命中（脚本锚点漂移）: ' + oldStr.slice(0, 60))
  }
  return src.replace(oldStr, newStr)
}

const runCounterExamples = () => {
  // m1 删掉 DailyRec 的 ScrollView 导入（图一本体）→ 必须报 ScrollView 未绑定
  check('m1 DailyRec 删掉 ScrollView 导入', () => {
    const s = tamper(REAL_DAILY_REC,
      'StyleSheet, ScrollView } from \'react-native\'',
      'StyleSheet } from \'react-native\'')
    const { unbound } = analyze(s)
    return unbound.includes('ScrollView') ? ['已拦下'] : []
  }, 'ScrollView 以 JSX 形态使用但无绑定')

  // m2 把 ScrollView 只留在注释里（名字还在、绑定没了）→ 必须报
  check('m2 ScrollView 只出现在注释里', () => {
    const s = tamper(REAL_DAILY_REC,
      'StyleSheet, ScrollView } from \'react-native\'',
      'StyleSheet } from \'react-native\' // 曾用过 ScrollView')
    const { unbound } = analyze(s)
    return unbound.includes('ScrollView') ? ['已拦下'] : []
  }, '注释不是绑定')

  // m3 合成片段：<Image /> 无导入且不在注释里 → 必须报（且不连坐已导入的 View）
  check('m3 合成片段 Image 漏导入', () => {
    const s = [
      "import { View } from 'react-native'",
      'export const A = () => <View><Image /></View>',
    ].join('\n')
    const { unbound } = analyze(s)
    return unbound.length === 1 && unbound[0] === 'Image' ? ['已拦下'] : []
  }, '只报 Image')

  return results
}

// ---------------------------------------------------------------------------
// 防误报正例（合成片段，必须不报）
// ---------------------------------------------------------------------------

const runFalsePositiveGuards = () => {
  const out = []
  const expectClean = (name, src) => {
    const { unbound } = analyze(src)
    out.push({ name, ok: unbound.length === 0, detail: unbound })
  }

  expectClean('p1 使用只在注释里', 'const x = 1\n// <ScrollView horizontal />\n')
  expectClean('p2 泛型不误报', 'const id = <T,>(x: T) => x\nconst f = <P extends object>(p: P) => p\n')
  expectClean('p3 字符串里的标签', "const s = '<ScrollView />'\nconst t = `<ScrollView>`\n")
  expectClean('p4 本地声明算绑定', 'const ScrollView = (props: any) => props.children\nexport const A = () => <ScrollView />\n')
  expectClean('p5 解构取值算绑定', "const { Animated } = require('react-native')\nexport const A = () => <Animated.View />\n")

  return out
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-jsx-import-guard ===')
console.log(`扫描 src：${SCAN.files} 个文件，白名单 JSX 使用 ${SCAN.usages} 处`)

const invReasons = invariants()
console.log('\n[不变量：JSX 绑定缺口]')
if (invReasons.length === 0) {
  console.log('  PASS 全仓 0 违规 + 扫描面正常（文件数/使用数达标）+ DailyRec 的 ScrollView 导入与使用都在')
} else {
  invReasons.forEach((r) => console.log('  FAIL ' + r))
}

console.log('\n[防误报正例（必须不报）]')
const fpResults = runFalsePositiveGuards()
let fpAllOk = true
for (const r of fpResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? ' —— 未误报' : ` —— 误报：${JSON.stringify(r.detail)}`}`)
  if (!r.ok) fpAllOk = false
}

console.log('\n[反例自检（必须拦下）]')
const ceResults = runCounterExamples()
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.ok ? '已拦下' : `未拦下（reasons=${JSON.stringify(r.detail)}）`}`)
  if (!r.ok) ceAllOk = false
}

const invOk = invReasons.length === 0
const allOk = invOk && fpAllOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${invOk ? '1/1' : '0/1'}；防误报 ${fpResults.filter(r => r.ok).length}/${fpResults.length}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
