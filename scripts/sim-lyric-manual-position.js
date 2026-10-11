/**
 * sim-lyric-manual-position.js
 *
 * 「歌词手动定位跳转播放」（PlayLine 浮层）契约。
 *
 * 背景：浮层由三处挂载——同屏小歌词（MiniLyric，本批之前就有）、竖屏大歌词
 * （Vertical/Lyric.tsx）、横屏大歌词（Horizontal/Lyric.tsx，本批补齐）。浮层本身是
 * 纯展示件（`PlayLine.tsx`），它的正确性**完全**依赖调用方喂进来的三样东西：
 *   ① `updateScrollInfo(滚动事件)`  —— 列表真实偏移 + 视口高度；
 *   ② `updateLayoutInfo({ spaceHeight, lineHeights })` —— 基准线上方的留白 + 逐行行高；
 *   ③ `topPercent` —— 基准线在容器高度上的位置。
 * 三者只要有一个与「高亮行定位」的口径不一致，用户看到的就是「虚线压在 A 行、
 * 点播放三角却跳到 B 行」——而且浮层照样显示、点击照样有反应，属于最难自查的一类。
 *
 * 本脚本做两件事：
 *   A. 数值模型：1:1 复刻 `PlayLine` 的选行循环与 `LyricScrollLayout.getTargetOffsetPrecise`
 *      的居中公式，证明「topPercent = 0.5 且 spaceHeight = 视高/2」时，虚线必然落在
 *      被 `handleScrollToActive` 居中的那一行上（含激活行更高时的鲁棒性）；并给出
 *      topPercent = 0.4（参考工程大歌词的原值）作为反例——它会稳定偏一行。
 *   B. 结构不变量：三处挂载点的渲染门控、几何表达式、seek 收口、以及拖动生命周期
 *      （`dragStartOffsetRef` 的赋值与清空必须成对，因为它是「用户正在拖」的唯一判据）。
 *   B2. 回位时长同速：小歌词（MiniLyric）停手回位与竖屏大歌词的回位滑动必须同值同源
 *      （lyricAnimation.RETURN_TO_ACTIVE_MS）——用户报过「小歌词滑完返回播放进度比大歌词快」。
 *
 * 契约强度说明：B 部分是静态断言（源码文本级），通过 ≠ 能编译 ≠ 真机观感对；
 * A 部分是模型级证明，证明的是**公式之间**自洽，不含 RN 布局/原生事件时序。
 *
 * 运行：node scripts/sim-lyric-manual-position.js
 * 退出码：不变量全过且反例全被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
/** 去行注释与块注释：否则「把某行注释掉」的篡改会被当成仍然存在 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  playLine: 'src/screens/PlayDetail/components/PlayLine.tsx',
  lyricScroll: 'src/utils/lyricScroll.ts',
  mini: 'src/screens/PlayDetail/components/MiniLyric.tsx',
  vertical: 'src/screens/PlayDetail/Vertical/Lyric.tsx',
  horizontal: 'src/screens/PlayDetail/Horizontal/Lyric.tsx',
}
const REAL = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, read(v)]))

// 三处浮层各自的视高来源变量名不同（小歌词 topPadding / 竖屏 pageHeightRef / 横屏 listHeightRef），
// 但**倍率必须都是 0.5**，且必须与各自 handleScrollToActive 的 viewPosition 一致。
const TOP_PERCENT = 0.5

// ---------------------------------------------------------------------------
// A. 数值模型
// ---------------------------------------------------------------------------

/** 复刻 LyricScrollLayout.getTargetOffsetPrecise（spaceHeight=0、useActiveHeight=true、usePlayed=false 路径） */
const targetOffsetPrecise = ({ index, listHeight, heights, viewPosition = 0.5, paddingV = 0 }) => {
  let offset = 0
  for (let i = 0; i < index; i++) offset += heights[i]
  const itemHeight = heights[index]
  return Math.max(0, paddingV + offset + itemHeight * viewPosition - listHeight * viewPosition)
}

/** 复刻 PlayLine 的选行循环（PlayLine.tsx:138-147 逐句对应） */
const pickLine = ({ contentOffsetY, layoutMeasurementHeight, topPercent, spaceHeight, lineHeights }) => {
  const offset = contentOffsetY + layoutMeasurementHeight * topPercent
  let lineOffset = spaceHeight
  for (let line = 0; line < lineHeights.length; line++) {
    lineOffset += lineHeights[line]
    if (lineOffset < offset) continue
    return line
  }
  return lineHeights.length - 1
}

// 一屏高 700、54 行歌词：其中每 7 行有一行长句（行高 ≈ 2 倍，实测约 71/108）
const H = 700
const heights = Array.from({ length: 54 }, (_, i) => (i % 7 === 3 ? 108 : i % 5 === 2 ? 71 : 54))
const SPACE = H * 0.5

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

console.log('sim-lyric-manual-position：歌词手动定位浮层契约\n')
console.log('--- A. 数值模型（虚线落点 vs 居中行） ---')

/** 返回全部 54 行的「虚线指向行 - 居中行」偏差列表 */
const offsetsFor = ({ topPercent, spaceHeight, paddingV = H * 0.5, viewPosition = 0.5, hs = heights }) => {
  const out = []
  for (let i = 0; i < hs.length; i++) {
    const T = targetOffsetPrecise({ index: i, listHeight: H, heights: hs, viewPosition, paddingV })
    const picked = pickLine({
      contentOffsetY: T,
      layoutMeasurementHeight: H,
      topPercent,
      spaceHeight,
      lineHeights: hs,
    })
    out.push(picked - i)
  }
  return out
}

{
  // 断言 1：本批的参数（topPercent=0.5、spaceHeight=H/2、paddingV=H/2、viewPosition=0.5）
  // → 虚线与居中行**逐行相等**（偏差全 0），即点播放三角永远跳到你看到的那一行。
  const d = offsetsFor({ topPercent: TOP_PERCENT, spaceHeight: SPACE })
  const worst = Math.max(...d.map(Math.abs))
  check('topPercent=0.5 且 spaceHeight=视高/2 → 54 行逐行零偏差（虚线 = 居中行）',
    worst === 0, `最大偏差 ${worst} 行（全 0 才对）`)
}

{
  // 断言 2（鲁棒性）：激活行因换行被挤成 2 倍高（useActiveHeight 用的就是这份高度，
  // 而喂给浮层的是非激活高度）时，落点是否仍落在同一行。
  // 数学：选行条件为 cum(i)+space ≥ offset > cum(i)+space-... 只要求 h_i^normal ≥ h_i^active/2，
  // 长句最多挤到 2 倍，故恒成立——这条断言把这个不等式钉住。
  const hs = heights.slice()
  const doubled = hs.map((_, i) => i)
  const out = []
  for (const i of doubled) {
    const active = hs.slice()
    active[i] = hs[i] * 2 // 激活行高度翻倍
    const T = targetOffsetPrecise({ index: i, listHeight: H, heights: active, viewPosition: 0.5, paddingV: H * 0.5 })
    const picked = pickLine({
      contentOffsetY: T,
      layoutMeasurementHeight: H,
      topPercent: TOP_PERCENT,
      spaceHeight: SPACE,
      lineHeights: hs, // 浮层拿到的是非激活高度
    })
    out.push(picked - i)
  }
  const worst = Math.max(...out.map(Math.abs))
  check('激活行高度翻倍时落点仍不偏（选行只需 h_normal ≥ h_active/2）',
    worst === 0, `最大偏差 ${worst} 行`)
}

{
  // 断言 3（反例）：topPercent 沿用参考工程大歌词的 0.4 → 虚线恒定偏一行。
  // 这是本工程**刻意**不照抄参考值的地方：参考工程把高亮行钉在 40%，本工程钉在正中，
  // 浮层若照抄 0.4 就会「看到一行、跳到上一行」。
  const d = offsetsFor({ topPercent: 0.4, spaceHeight: SPACE })
  const off = d.filter((x) => x !== 0).length
  check('反例：topPercent=0.4（参考工程原值）→ 大量行偏一行（证明必须随定位口径改 0.5）',
    off > heights.length / 2, `${off}/${heights.length} 行落点偏离`)
}

{
  // 断言 4（反例）：spaceHeight 与定位用的 paddingV 不一致（浮层留白取 0）→ 落点整体偏移。
  const d = offsetsFor({ topPercent: TOP_PERCENT, spaceHeight: 0 })
  const off = d.filter((x) => x !== 0).length
  check('反例：spaceHeight 未与定位留白同源（取 0）→ 落点整体偏移',
    off > heights.length / 2, `${off}/${heights.length} 行落点偏离`)
}

{
  // 断言 5（反例）：viewPosition 与 topPercent 不一致（定位改 0.4、浮层留 0.5）同样偏。
  const d = offsetsFor({ topPercent: TOP_PERCENT, spaceHeight: SPACE, viewPosition: 0.4 })
  const off = d.filter((x) => x !== 0).length
  check('反例：定位 viewPosition 改了而浮层 topPercent 没跟着改 → 落点偏离',
    off > heights.length / 2, `${off}/${heights.length} 行落点偏离`)
}

{
  // 断言 6：浮层选出的行 → 时间标签取的就是该行时间（`lyricLines[targetLineNum].time`），
  // 并收口到 maxPlayTime 之前 0.5s。模型：末尾行时间恰等于总时长时，seek 目标必须 < 总时长，
  // 否则会被播完判定当成「已到结尾」直接切下一首。
  const maxPlayTime = 245
  const lineTimes = [0, 12.5, 30, 60, 120, 180, 245]
  const seekTargets = lineTimes.map((t) => (maxPlayTime > 0 && t >= maxPlayTime ? Math.max(maxPlayTime - 0.5, 0) : t))
  const allUnder = seekTargets.every((t) => t < maxPlayTime)
  const lastIsClamped = seekTargets[seekTargets.length - 1] === 244.5
  check('末行时间 = 总时长时 seek 目标收口到 总时长-0.5（不会被当成播完而切歌）',
    allUnder && lastIsClamped, `末行目标 ${seekTargets[seekTargets.length - 1]}s / 总时长 ${maxPlayTime}s`)
}

// ---------------------------------------------------------------------------
// B. 结构不变量（三处挂载点）
// ---------------------------------------------------------------------------

/**
 * 单个挂载点的不变量。`src` = 组件源码（已去注释），`label` = 显示名。
 * 拆成函数是为了反例能对**篡改后的源码**跑同一套判断。
 */
function surfaceInvariants(label, src) {
  const out = []
  const add = (n, ok, detail = '') => out.push({ name: `${label} · ${n}`, ok, detail })

  // 1. 浮层渲染：必须挂 ref / topPercent / onPlayLine 三件套，且由设置位门控
  {
    const render = new RegExp(
      `<PlayLine\\s+ref=\\{playLineRef\\}\\s+topPercent=\\{${String(TOP_PERCENT).replace('.', '\\.')}\\}\\s+onPlayLine=\\{handlePlayLine\\}\\s*/>`,
    ).test(src)
    const gated = /isShowLyricProgress\s*\?\s*\([\s\S]{0,400}?<PlayLine[\s\S]{0,400}?\)\s*:\s*null/.test(src)
    const setting = /const\s+isShowLyricProgress\s*=\s*useSettingValue\(['"]playDetail\.isShowLyricProgressSetting['"]\)/.test(src)
    add('invariant 1: <PlayLine topPercent={0.5} onPlayLine> 由 isShowLyricProgress 门控',
      render && gated && setting,
      `渲染=${render} 门控=${gated} 读设置=${setting}`)
  }

  // 2. 几何同源：喂浮层的 spaceHeight 必须是「视高 × 0.5」，倍率与定位口径一致
  {
    const m = /spaceHeight:\s*([A-Za-z0-9_.]+)\s*\*\s*(0?\.\d+|\d+)/.exec(src)
    const ok = m != null && Number(m[2]) === TOP_PERCENT
    add(`invariant 2: spaceHeight = 视高 × ${TOP_PERCENT}（与 topPercent 同倍率）`,
      ok, m ? `取到 ${m[1]} * ${m[2]}` : '未找到 spaceHeight 表达式')
  }

  // 3. 定位口径：居中定位（viewPosition 0.5）与上下留白必须同时存在
  {
    const centered = /getTargetOffsetPrecise\([\s\S]{0,200}?,\s*0\.5\s*,/.test(src)
    // 上下留白：竖屏/横屏写在 contentContainerStyle（或 listPadding），值 = 视高 × 0.5
    const padding = /(?:paddingTop|paddingV)[\s\S]{0,120}?\*\s*0\.5/.test(src)
    add('invariant 3: 定位 viewPosition=0.5 且上下留白 = 视高 × 0.5（与浮层同源）',
      centered && padding, `居中定位=${centered} 留白×0.5=${padding}`)
  }

  // 4. 浮层几何在进入拖动时快照，且行高取自 LyricScrollLayout（与定位同一份缓存）
  {
    const snapshot = /playLineRef\.current\?\.updateLayoutInfo\(/.test(src)
    const heights = /lyricScrollLayoutRef\.current\.getLineHeights\(lyricLines\.length\)/.test(src)
    add('invariant 4: updateLayoutInfo 用 LyricScrollLayout.getLineHeights（与定位同一份行高）',
      snapshot && heights, `喂几何=${snapshot} 行高来源=${heights}`)
  }

  // 5. seek 收口：末行时间等于总时长时收回到总长之前（否则被当成播完而切歌），
  //    且只 seek、不提前滚列表（避免「先滚回旧行再滑向新行」的二次动画）
  {
    const clamp = /const\s+maxTime\s*=\s*playerState\.progress\.maxPlayTime/.test(src) &&
      /time\s*=\s*Math\.max\(maxTime\s*-\s*0\.5,\s*0\)/.test(src)
    const seek = /global\.app_event\.setProgress\(time\)/.test(src)
    const body = /\n\s*const handlePlayLine = useCallback\(\(time: number\) => \{([\s\S]*?)\n\s*\}, \[\]\)/.exec(src)
    const noDoubleAnim = body != null && !/handleScrollToActive\(/.test(body[1])
    add('invariant 5: handlePlayLine 收口到 总时长-0.5 后只 seek（不提前滚列表）',
      clamp && seek && noDoubleAnim, `收口=${clamp} seek=${seek} 无二次滚动=${noDoubleAnim}`)
  }

  // 6. 拖动生命周期：dragStartOffsetRef 是「用户正在拖」的唯一判据，
  //    它必须在 handleScroll 里被用作门控，且**每一个**收起浮层的调用点所在的代码块里
  //    都要清空它。漏一条的症状：浮层在自动回位/自动跟随时被重新弹出来，虚线乱扫。
  //    ⚠️ 判据必须锚在「同一个代码块」上，不能用「前后 400 字符内出现过清空」：
  //    onScrollEndDrag 的早退分支（只清不收起）离超时分支（收起）只有约 200 字符，
  //    用窗口判据时前者的清空会把后者补齐 —— 恰好漏掉真正危险的那一条（本批修的就是它）。
  {
    const gate = /if\s*\(dragStartOffsetRef\.current == null\)\s*return/.test(src)
    const hides = [...src.matchAll(/playLineRef\.current\?\.setVisible\(false\)/g)]
    // 从调用点向前扫到「包含它的那个 { 」：即最近的未闭合块起点
    const blockStart = (s, idx) => {
      let depth = 0
      for (let i = idx - 1; i >= 0; i--) {
        if (s[i] === '}') depth++
        else if (s[i] === '{') {
          if (depth === 0) return i
          depth--
        }
      }
      return 0
    }
    const uncovered = hides.filter((m) => {
      const seg = src.slice(blockStart(src, m.index), m.index)
      return !/dragStartOffsetRef\.current = null/.test(seg)
    }).length
    const clears = (src.match(/dragStartOffsetRef\.current = null/g) ?? []).length
    add('invariant 6: handleScroll 以 dragStartOffsetRef 非空为门控，且每个收起浮层的代码块内都清空了它',
      gate && hides.length > 0 && uncovered === 0,
      `门控=${gate} 收起浮层 ${hides.length} 处，其中所在块内未清空 ${uncovered} 处；清空语句共 ${clears} 处`)
  }

  // 7. 「是否真的动过」的阈值必须与小歌词同值（三处观感一致）
  {
    const m = /const\s+OVERLAY_SHOW_MOVE\s*=\s*(\d+)/.exec(src)
    add('invariant 7: OVERLAY_SHOW_MOVE 常量存在（拖动超过阈值才显示浮层）',
      m != null && Number(m[1]) > 0, m ? `= ${m[1]}pt` : '未找到')
  }

  return out
}

console.log('\n--- B. 结构不变量（三处挂载点） ---')
const SURFACES = [
  ['竖屏大歌词', 'vertical'],
  ['横屏大歌词', 'horizontal'],
]
const results = []
for (const [label, key] of SURFACES) {
  for (const r of surfaceInvariants(label, stripComments(REAL[key]))) {
    results.push({ group: '不变量', ...r })
  }
}

// 小歌词（本批未改，作为另外两处的样板）：只钉「三处观感一致」的那几条，
// 不套用 invariant 6 的严格清空规则——它有自己成对的显示/隐藏生命周期（含重新显示路径），
// 且是用户已在真机上确认可用的实现，本批不对它做任何改动。
for (const r of surfaceInvariants('小歌词', stripComments(REAL.mini))) {
  if (r.name.includes('invariant 1') || r.name.includes('invariant 7')) {
    results.push({ group: '不变量', ...r })
  }
}

// 三处 topPercent 必须完全一致（否则三处浮层的基准线含义不同）
{
  const percents = [REAL.mini, REAL.vertical, REAL.horizontal].map((src) => {
    const m = /<PlayLine[\s\S]{0,120}?topPercent=\{([\d.]+)\}/.exec(src)
    return m ? Number(m[1]) : null
  })
  results.push({
    group: '不变量',
    name: '三处挂载点的 topPercent 完全一致（小歌词 / 竖屏 / 横屏）',
    ok: percents.every((p) => p === TOP_PERCENT),
    detail: `取到 ${percents.join(' / ')}`,
  })
}

// 浮层的默认值仍是参考工程的 0.4（不许偷偷把默认值改成 0.5 来「让调用点少写一个 prop」：
// 默认值是「参考工程大歌词在 40% 处」这一语义的记录，改掉会让默认值失去参照意义）
{
  const m = /const\s+DEFAULT_TOP_PERCENT\s*=\s*([\d.]+)/.exec(stripComments(REAL.playLine))
  results.push({
    group: '不变量',
    name: 'PlayLine 默认 topPercent 仍为 0.4（参考工程语义），调用点必须显式传值',
    ok: m != null && Number(m[1]) === 0.4,
    detail: m ? `DEFAULT_TOP_PERCENT = ${m[1]}` : '未找到',
  })
}

// ---------------------------------------------------------------------------
// B2. 回位时长同速（用户报的 bug：小歌词滑完返回播放进度时比大歌词快）
// ---------------------------------------------------------------------------
//
// 竖屏大歌词的回位不是另起一套动画：停手后它往连续滚动循环里排一个 glide 任务，
// 走自己的换行滑动轨迹（固定时长 + easeInOutQuad）。小歌词此前按距离取
// getReturnDuration（[120,300]），同一屏对比就是「小歌词更快」——用户报的 bug。
// 现在两边共同引用 lyricAnimation 的 RETURN_TO_ACTIVE_MS，只钉四件事：
//   ① 共享常量存在且值为对齐参考工程的 600；② 大歌词侧不再写死字面量；
//   ③ 小歌词侧不再出现按距离取值的旧路；④ 两侧曲线同为 easeInOutQuad
//（时长相同 + 曲线相同才谈得上「同速」）。

const ANIM_FILE = 'src/screens/PlayDetail/lyricAnimation.ts'

/** 对 { anim, mini, vertical }（均已去注释）求值；反例可对篡改后的快照跑同一套判断。 */
function returnDurationInvariants(srcs) {
  const out = []
  const add = (n, ok, detail = '') => out.push({ group: '不变量', name: n, ok, detail })
  const { anim, mini, vertical } = srcs
  const importsShared = (src) =>
    /import\s*\{[^}]*RETURN_TO_ACTIVE_MS[^}]*\}\s*from\s*'@\/screens\/PlayDetail\/lyricAnimation'/.test(src)

  const declared = /export const RETURN_TO_ACTIVE_MS = (\d+)/.exec(anim)
  add('invariant 8: lyricAnimation 导出 RETURN_TO_ACTIVE_MS = 600（= 大歌词对齐参考工程的滑动时长）',
    declared != null && Number(declared[1]) === 600,
    declared ? `= ${declared[1]}` : '未找到')

  const verticalShared = /LINE_CHANGE_GLIDE_REF_MS = RETURN_TO_ACTIVE_MS/.test(vertical)
  add('invariant 9: 竖屏大歌词滑动时长 = RETURN_TO_ACTIVE_MS（不再各写一份字面量）',
    importsShared(vertical) && verticalShared,
    `导入=${importsShared(vertical)} 赋值同源=${verticalShared}`)

  const miniShared = /duration \?\? RETURN_TO_ACTIVE_MS/.test(mini)
  const miniNoDistance = !/getReturnDuration/.test(mini)
  add('invariant 10: 小歌词回位 = RETURN_TO_ACTIVE_MS，且不再引用 getReturnDuration（按距离取值正是快慢不一致的来源）',
    importsShared(mini) && miniShared && miniNoDistance,
    `导入=${importsShared(mini)} 回位同源=${miniShared} 无按距离取值=${miniNoDistance}`)

  const miniCurve = /eased = t < 0\.5 \? 2 \* t \* t/.test(mini)
  const verticalCurve = /eased = p < 0\.5 \? 2 \* p \* p/.test(vertical)
  add('invariant 11: 两侧回位曲线同为 easeInOutQuad（时长相同 + 曲线相同 = 完全同速）',
    miniCurve && verticalCurve, `小歌词=${miniCurve} 大歌词=${verticalCurve}`)

  return out
}

{
  const srcs = {
    anim: stripComments(read(ANIM_FILE)),
    mini: stripComments(REAL.mini),
    vertical: stripComments(REAL.vertical),
  }
  results.push(...returnDurationInvariants(srcs))

  const tamperReturn = [
    {
      label: '⑧ 小歌词回位退回按距离取 getReturnDuration（复现用户报的「小歌词更快」）',
      key: 'mini',
      mutate: (s) => s
        .replace(
          'import { IDLE_RETURN_MS, LINE_CHANGE_GLIDE_MS, RETURN_TO_ACTIVE_MS }',
          'import { getReturnDuration, IDLE_RETURN_MS, LINE_CHANGE_GLIDE_MS }',
        )
        .replace('duration ?? RETURN_TO_ACTIVE_MS', 'duration ?? getReturnDuration(distance)'),
    },
    {
      label: '⑨ 大歌词把 600 写死回本地（两边各持一份，改一处不再同步）',
      key: 'vertical',
      mutate: (s) => s.replace('const LINE_CHANGE_GLIDE_REF_MS = RETURN_TO_ACTIVE_MS', 'const LINE_CHANGE_GLIDE_REF_MS = 600'),
    },
    {
      label: '⑩ 共享常量被改成 designMotion.quick 的 200（回位整体变快、与参考工程定案脱钩）',
      key: 'anim',
      mutate: (s) => s.replace('export const RETURN_TO_ACTIVE_MS = 600', 'export const RETURN_TO_ACTIVE_MS = 200'),
    },
  ]
  for (const c of tamperReturn) {
    const patched = { ...srcs, [c.key]: c.mutate(srcs[c.key]) }
    if (patched[c.key] === srcs[c.key]) {
      results.push({ group: '反例', name: `反例 ${c.label}`, ok: false, detail: '替换未命中：源码已变，反例失效需同步' })
      continue
    }
    const failed = returnDurationInvariants(patched).filter((r) => !r.ok)
    results.push({
      group: '反例',
      name: `反例 ${c.label} 被拦下`,
      ok: failed.length > 0,
      detail: failed.length
        ? `命中：${failed.map((r) => r.name.split(':')[0]).join('、')}`
        : '未被任何不变量拦下（守卫无效）',
    })
  }
}

// ---------------------------------------------------------------------------
// C. 反例：篡改后的源码必须被同一套不变量拦下
// ---------------------------------------------------------------------------

console.log('\n--- C. 反例自检 ---')

const verticalSrc = REAL.vertical
const tamper = [
  {
    label: '① 去掉设置位门控（浮层永远显示，关掉设置也关不掉）',
    mutate: (s) => s.replace(/isShowLyricProgress \? \(\s*<PlayLine ref=\{playLineRef\} topPercent=\{0\.5\} onPlayLine=\{handlePlayLine\} \/>\s*\) : null/,
      '<PlayLine ref={playLineRef} topPercent={0.5} onPlayLine={handlePlayLine} />'),
  },
  {
    label: '② topPercent 改回参考工程的 0.4（虚线偏一行）',
    mutate: (s) => s.replace('<PlayLine ref={playLineRef} topPercent={0.5}', '<PlayLine ref={playLineRef} topPercent={0.4}'),
  },
  {
    label: '③ spaceHeight 倍率改错（与 topPercent 不同源）',
    mutate: (s) => s.replace(/spaceHeight: (listHeight|pageHeightRef\.current > 0 \? pageHeightRef\.current : pagerHeight) \* 0\.5/,
      (m) => m.replace('* 0.5', '* 0.4')),
  },
  {
    label: '④ 删掉末行 seek 收口（点到末行会被当成播完而切歌）',
    mutate: (s) => s.replace('    if (maxTime > 0 && time >= maxTime) time = Math.max(maxTime - 0.5, 0)\n', ''),
  },
  {
    label: '⑤ 删掉拖动起点的清空（浮层在自动回位时被重新弹出）',
    mutate: (s) => s.replace(/\n\s*dragStartOffsetRef\.current = null\n\s*isOverlayShownRef\.current = false\n\s*playLineRef\.current\?\.setVisible\(false\)\n\s*\/\/ 到时即回位/,
      '\n      isOverlayShownRef.current = false\n      playLineRef.current?.setVisible(false)\n      // 到时即回位'),
  },
  {
    label: '⑥ handleScroll 去掉「正在拖」门控（自动跟随每帧都喂浮层）',
    mutate: (s) => s.replace('if (dragStartOffsetRef.current == null) return', 'if (false) return'),
  },
  {
    label: '⑦ 把 <PlayLine /> 注释掉（去注释后必须失效）',
    mutate: (s) => s.replace('<PlayLine ref={playLineRef} topPercent={0.5} onPlayLine={handlePlayLine} />',
      '// <PlayLine ref={playLineRef} topPercent={0.5} onPlayLine={handlePlayLine} />'),
  },
]

for (const c of tamper) {
  const patched = c.mutate(verticalSrc)
  if (patched === verticalSrc) {
    results.push({ group: '反例', name: `反例 ${c.label}`, ok: false, detail: '替换未命中：源码已变，反例失效需同步' })
    continue
  }
  const failed = surfaceInvariants('竖屏大歌词', stripComments(patched)).filter((r) => !r.ok)
  results.push({
    group: '反例',
    name: `反例 ${c.label} 被拦下`,
    ok: failed.length > 0,
    detail: failed.length
      ? `命中：${failed.map((r) => r.name.split('· ')[1].split(':')[0]).join('、')}`
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
