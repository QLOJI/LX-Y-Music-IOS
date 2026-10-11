/**
 * sim-lyric-dash-fade.js
 *
 * 「歌词手动定位虚线的左端淡出」契约（`PlayLine.tsx` 的 DASH_FADE_* 与 getDashColor）。
 *
 * 需求原文：「歌词进度跳转虚线，改为从左端向右边 1/3 的地方开始淡出，也就是颜色能
 * 看得见，三分之一前是透明看不见的。」拆成两条可判定的东西：
 *   ① 左起 1/3 段：每一小段的 alpha **恰好是 0**（不是「很淡」，是看不见）；
 *   ② 跨过 1/3 之后：必须真的看得见 —— 在很短的宽度内淡入到该处的渐变值；
 *      如果把淡入摊到剩下的 2/3 上，1/3 之后的一大半仍然只有 0.0x 的不透明度，
 *      用户看到的还是「看不见」，需求等于没做（这正是本次修掉的行为）。
 *
 * A. 数值模型：从源码解析 DASH_FADE_START_RATIO / DASH_FADE_SPAN_RATIO /
 *    DASH_ALPHA_MIN / DASH_ALPHA_MAX，1:1 复刻 getDashColor 的算式，在多种行宽下
 *    逐段验证 ①②③（含「右端恰好等于渐变上限、全程单调不超上限」），并用**旧算式**
 *    （摊到 1-START）和**把 SPAN 调到 0.6**作为反例，证明断言真的能拦住「假装看得见」。
 * B. 结构不变量：淡出必须作用在**真正被渲染出来的每一小段**上（不是死代码）、段数按
 *    缩放后的段宽推算（字号放大后仍铺满不右空）、不得退回 iOS 渲染不可靠的
 *    borderStyle:'dashed'、也不许把 opacity 打到容器/色块上（那会把「只剩虚线」变成
 *    「虚线也没了」）。
 *
 * 契约强度说明：B 是源码文本级静态断言，通过 ≠ 能编译 ≠ 真机观感；A 是模型级，
 * 证明的是「算式满足需求」，不含 RN 布局与真实屏幕上的视觉阈值判断。
 *
 * 运行：node scripts/sim-lyric-dash-fade.js
 * 退出码：不变量全过且反例全被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
/** 去行注释与块注释：否则「把某行注释掉」的篡改会被当成仍然存在 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const FILE = 'src/screens/PlayDetail/components/PlayLine.tsx'
const SRC = read(FILE)
const CODE = stripComments(SRC)

/** 只允许数字与四则运算的常量求值（源码里写作 1 / 3） */
const evalConst = (src, name) => {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*([^\\n]+)').exec(src)
  if (!m) return null
  const expr = m[1].replace(/;+\s*$/, '').trim()
  if (!/^[\d\s.+\-*/()]+$/.test(expr)) return null
  try {
    const v = Function('"use strict";return (' + expr + ')')()
    return typeof v === 'number' && isFinite(v) ? v : null
  } catch (e) {
    return null
  }
}

const P = {
  start: evalConst(CODE, 'DASH_FADE_START_RATIO'),
  span: evalConst(CODE, 'DASH_FADE_SPAN_RATIO'),
  min: evalConst(CODE, 'DASH_ALPHA_MIN'),
  max: evalConst(CODE, 'DASH_ALPHA_MAX'),
}

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

// ---------------------------------------------------------------------------
// A. 数值模型
// ---------------------------------------------------------------------------

/**
 * 复刻 getDashColor 的 alpha 部分。mode：
 *   'span'    —— 源码现在用的：跨过 1/3 后在 SPAN 宽度内淡入（钳到 1）
 *   'legacy'  —— 本次修掉的旧算式：摊到剩下的 (1 - START) 上
 *   'noclamp' —— 少了上下钳制的写法（会超出渐变上限）
 */
const alphaWith = (ratio, p = P, mode = 'span') => {
  let fadeIn
  if (mode === 'legacy') fadeIn = ratio <= p.start ? 0 : (ratio - p.start) / (1 - p.start)
  else if (mode === 'noclamp') fadeIn = (ratio - p.start) / p.span
  else fadeIn = Math.min(Math.max((ratio - p.start) / p.span, 0), 1)
  return (p.min + (p.max - p.min) * ratio) * fadeIn
}

/** 与源码同口径的段序列：ratio = index / (dashCount - 1)，dashCount 由「段宽 + 间距」推算 */
const seriesFor = (dashWidth, dashLen = 3, dashGap = 2) => {
  const count = Math.floor((dashWidth + dashGap) / (dashLen + dashGap))
  return Array.from({ length: count }, (_, i) => (count > 1 ? i / (count - 1) : 1))
}

// 虚线可用宽度实测域：小歌词（iPhone SE 宽 320，虚线 marginLeft 30）到 iPad 横屏
const WIDTHS = [200, 260, 300, 414, 620]
const EPS = 1e-9

/** ① 左 1/3 段每一小段必须恰好不可见，且 1/3 段要真的存在（不是只剩一两个点） */
const leftThirdInvisible = (p = P, mode = 'span') => {
  const bad = []
  let minSegs = Infinity
  for (const w of WIDTHS) {
    const rs = seriesFor(w)
    const inThird = rs.filter((r) => r <= p.start + EPS)
    minSegs = Math.min(minSegs, inThird.length)
    for (const r of inThird) {
      const a = alphaWith(r, p, mode)
      if (a !== 0) bad.push(`宽${w}: ratio=${r.toFixed(4)} alpha=${a.toFixed(4)}`)
    }
  }
  return {
    ok: bad.length === 0 && minSegs >= 3,
    detail: bad.length
      ? `左 1/3 内仍有可见段：${bad.slice(0, 3).join('；')}`
      : `左 1/3 内全为 0（最窄一行也有 ${minSegs} 段落在这一区间）`,
  }
}

/** ② 淡入必须在「过 1/3 之后不远」就完成，而不是快到右端才现形 */
const fadeDoneRatio = (p = P, mode = 'span', dashWidth = 300) => {
  for (const r of seriesFor(dashWidth)) {
    if (r <= p.start + EPS) continue
    const grad = p.min + (p.max - p.min) * r
    if (alphaWith(r, p, mode) >= grad - 1e-6) return r
  }
  return null
}

const visibleAfterThird = (p = P, mode = 'span') => {
  const done = fadeDoneRatio(p, mode)
  const mid = alphaWith(0.5, p, mode)
  const ok = done != null && done <= 0.5 && mid >= 0.25
  return {
    ok,
    detail: `淡入完成于 ${done == null ? '未完成' : done.toFixed(4)}（要求 ≤ 0.5）；中线处 alpha=${mid.toFixed(3)}（要求 ≥ 0.25）`,
  }
}

/** ③ 渐变本身：右端恰好等于上限、全程单调不减、任何一段都不超过上限 */
const gradientIntact = (p = P, mode = 'span') => {
  const alphas = seriesFor(414).map((r) => alphaWith(r, p, mode))
  const last = alphas[alphas.length - 1]
  const over = alphas.filter((a) => a > p.max + EPS).length
  let mono = true
  for (let i = 1; i < alphas.length; i++) if (alphas[i] < alphas[i - 1] - EPS) mono = false
  return {
    ok: Math.abs(last - p.max) < EPS && over === 0 && mono,
    detail: `右端 ${last.toFixed(4)}（上限 ${p.max}）；超上限段 ${over}；单调 ${mono}`,
  }
}

console.log('sim-lyric-dash-fade：歌词定位虚线「左 1/3 透明、其后可见」契约\n')
console.log('--- A. 数值模型（逐段 alpha） ---')

check('常量齐备：START = 1/3、SPAN ∈ (0, 1/4]、0 < MIN < MAX < 1',
  P.start != null && Math.abs(P.start - 1 / 3) < 1e-9 && P.span != null && P.span > 0 && P.span <= 0.25 &&
    P.min != null && P.max != null && P.min > 0 && P.min < P.max && P.max < 1,
  `START=${P.start} SPAN=${P.span} MIN=${P.min} MAX=${P.max}`)

{
  const r = leftThirdInvisible()
  check('断言 1：左起 1/3 段每一小段的 alpha 恰好为 0（透明看不见）', r.ok, r.detail)
}
{
  const r = visibleAfterThird()
  check('断言 2：跨过 1/3 后不远即完成淡入，且中线处已经明显可见', r.ok, r.detail)
}
{
  const r = gradientIntact()
  check('断言 3：右端等于渐变上限、全程单调不减、无一段超上限', r.ok, r.detail)
}
{
  // 段数与行宽无关地成立：五种行宽下，可见段起点都落在 [1/3, 1/3+SPAN] 内
  const starts = WIDTHS.map((w) => {
    for (const r of seriesFor(w)) {
      if (alphaWith(r) > 0) return r
    }
    return null
  })
  const ok = starts.every((s) => s != null && s > P.start && s <= P.start + P.span + 0.02)
  check('断言 4：200~620pt 五种行宽下，第一段可见点的位置一致（不随行宽漂移）',
    ok, `首可见点 ${starts.map((s) => (s == null ? 'x' : s.toFixed(3))).join(' / ')}`)
}

console.log('\n--- A2. 反例自检（同一套断言必须能拦住「假装看得见」） ---')
{
  const legacy = visibleAfterThird(P, 'legacy')
  const legacyMid = alphaWith(0.5, P, 'legacy')
  check('反例 ①：旧算式（淡入摊到剩下 2/3）→ 断言 2 失败',
    !legacy.ok, `旧算式淡入完成于 ${fadeDoneRatio(P, 'legacy').toFixed(3)}、中线 alpha=${legacyMid.toFixed(3)}（正是本次修掉的「后面还是看不见」）`)
}
{
  const wide = visibleAfterThird({ ...P, span: 0.6 })
  check('反例 ②：SPAN 调到 0.6（换汤不换药的摊开式）→ 断言 2 失败',
    !wide.ok, `淡入完成于 ${fadeDoneRatio({ ...P, span: 0.6 }).toFixed(3)}（> 0.5 即判失败）`)
}
{
  const noClamp = gradientIntact(P, 'noclamp')
  check('反例 ③：去掉上下钳制 → 断言 3 失败（段色会盖过右端上限）',
    !noClamp.ok, noClamp.detail)
}

// ---------------------------------------------------------------------------
// B. 结构不变量
// ---------------------------------------------------------------------------

/** 单条不变量集合。拆成函数是为了反例能对**篡改后的源码**跑同一套判断。 */
const structural = (code) => {
  const out = []
  const add = (n, ok, d = '') => out.push({ name: n, ok, detail: d })

  {
    const wired = /dashCount > 0[\s\S]{0,240}?Array\.from\(\{\s*length:\s*dashCount\s*\}[\s\S]{0,320}?backgroundColor:\s*getDashColor\(index\)/.test(code)
    add('invariant 1: 每一小段的底色都来自 getDashColor(index)（淡出不是死代码）', wired,
      wired ? '已接线' : '渲染里找不到逐段上色的调用')
  }

  {
    const step = /const\s+dashStep\s*=\s*scaleSizeW\(DASH_LEN\)\s*\+\s*scaleSizeW\(DASH_GAP\)/.test(code)
    const count = /const\s+dashCount\s*=\s*dashWidth\s*>\s*0\s*&&\s*dashStep\s*>\s*0\s*\?\s*Math\.floor\(\(dashWidth\s*\+\s*scaleSizeW\(DASH_GAP\)\)\s*\/\s*dashStep\)\s*:\s*0/.test(code)
    add('invariant 2: 段数按缩放后的段宽/间距推算（字号放大后仍铺满、不留右侧空白）', step && count,
      `dashStep 缩放=${step} dashCount 算式=${count}`)
  }

  {
    const dashed = /borderStyle\s*:\s*['"]dashed['"]/.test(code)
    add("invariant 3: 未使用 borderStyle:'dashed'（iOS 上 1px 虚线边框不可见）", !dashed,
      dashed ? '出现了 dashed 边框写法' : '仍是自绘色块')
  }

  {
    const opacityOnParts = /(?:^|\n)\s*(?:dash|line)\s*:\s*\{[^}]*\bopacity\b/.test(code)
    add('invariant 4: 淡出只用颜色 alpha（dash/line 样式里不挂 opacity）', !opacityOnParts,
      opacityOnParts ? '样式里出现了 opacity' : '未出现')
  }

  {
    const spanShape = /\(ratio\s*-\s*DASH_FADE_START_RATIO\)\s*\/\s*DASH_FADE_SPAN_RATIO/.test(code)
    const legacyShape = /1\s*-\s*DASH_FADE_START_RATIO/.test(code)
    add('invariant 5: 淡入宽度取 DASH_FADE_SPAN_RATIO，且没有退回 (1 - START) 的摊开式',
      spanShape && !legacyShape, `取 SPAN=${spanShape} 旧算式残留=${legacyShape}`)
  }

  {
    const height = /const\s+DASH_HEIGHT\s*=\s*1/.test(code)
    const used = /height:\s*DASH_HEIGHT/.test(code)
    const len = /const\s+DASH_LEN\s*=\s*3/.test(code) && /const\s+DASH_GAP\s*=\s*2/.test(code)
    add('invariant 6: 虚线仍是 1px 高的小色块拼出来的（DASH_LEN/GAP/HEIGHT 齐备）',
      height && used && len, `高=${height && used} 段长/间距=${len}`)
  }

  return out
}

console.log('\n--- B. 结构不变量（PlayLine.tsx） ---')
const results = []
for (const r of structural(CODE)) results.push({ group: '不变量', ...r })

console.log('\n--- C. 反例自检（篡改后的源码必须被同一套不变量拦下） ---')
const tamper = [
  {
    label: '① 逐段上色改回单色（淡出形同不存在）',
    mutate: (s) => s.replace('backgroundColor: getDashColor(index)', 'backgroundColor: rgb'),
  },
  {
    label: '② 段数写死（字号放大后虚线铺不满）',
    mutate: (s) => s.replace(/const\s+dashCount\s*=[\s\S]{0,120}?:\s*0/, 'const dashCount = 40'),
  },
  {
    label: '③ 淡入退回摊开式（1/3 之后仍看不见）',
    mutate: (s) => s.replace('(ratio - DASH_FADE_START_RATIO) / DASH_FADE_SPAN_RATIO', '(ratio - DASH_FADE_START_RATIO) / (1 - DASH_FADE_START_RATIO)'),
  },
  {
    label: '④ 用 opacity 做淡出（会把色块本身也吃掉）',
    mutate: (s) => s.replace(/dash:\s*\{/, 'dash: {\n    opacity: 0.5,'),
  },
]
for (const c of tamper) {
  const patched = c.mutate(CODE)
  if (patched === CODE) {
    results.push({ group: '反例', name: `反例 ${c.label}`, ok: false, detail: '替换未命中：源码已变，反例失效需同步' })
    continue
  }
  const failed = structural(patched).filter((r) => !r.ok)
  results.push({
    group: '反例',
    name: `反例 ${c.label} 被拦下`,
    ok: failed.length > 0,
    detail: failed.length
      ? `命中：${failed.map((r) => r.name.split(':')[0]).join('、')}`
      : '未被任何不变量拦下（守卫无效）',
  })
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

let lastGroup = ''
for (const r of results) {
  if (r.group !== lastGroup) {
    console.log(`\n--- ${r.group} ---`)
    lastGroup = r.group
  }
  if (r.ok) {
    pass++
    console.log(`  PASS  ${r.name}`)
  } else {
    fail++
    console.log(`  FAIL  ${r.name}`)
  }
  if (r.detail) console.log(`        ${r.detail}`)
}

console.log('\n' + '='.repeat(70))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
