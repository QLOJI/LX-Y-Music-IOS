/**
 * sim-lyric-double-tap-seek.js
 *
 * 「大歌词双击跳转播放」契约（第 55 轮第 1 条）。
 *
 * 用户原话：**「播放详情页，大小歌词区域，取消单击歌词跳转播放功能，要么改为单击右侧三角
 * 按钮实现歌词跳转，要么双击歌词跳转播放。」** 定案（用户二选一后确认）：**双击跳转**，
 * 浮层右侧的播放三角原样保留（两条路都在）；**只改大歌词**（竖屏 / 横屏），
 * 小歌词（MiniLyric）不动 —— 它的单击是「切到歌词页」，要加双击就得给单击加 300ms 延迟。
 *
 * 改动前的行为：`handleLinePress` 里单击任何一行就 `setProgress(line.time)` 跳转播放，
 * 在歌词页上滑一下就误跳，是用户报的痛点。现在单击只记时间戳、直接 return；
 * 只有「同一行 + 间隔 < LYRIC_DOUBLE_TAP_MS(300)」的第二次点击才走跳转。
 *
 * 本脚本钉五件事（前四件是静态判据，第五件是行为模型）：
 *   ① 窗口常量单源：`lyricAnimation.ts` 导出 `LYRIC_DOUBLE_TAP_MS = 300`，
 *      两个大歌词都从该文件 import（与小歌词回位时长同一种「单源」口径）；
 *   ② 双击门本身：单击分支（门体）只写 `lastLineTapRef` + `return`，
 *      **不得**出现 seek / 定位 / 收浮层 —— 否则「单击即跳转」就回来了；
 *   ③ 门的判据必须同时看「同一行」与「窗口」两个条件（只看时间会把「点 A 行、
 *      紧接着点 B 行」误判成双击 B）；
 *   ④ 双击分支保留原行为：seek 恰好 1 处、在门之后；清定位态 / 收浮层的四件套不变；
 *      三角通道（`handlePlayLine` 的 `setProgress(time)`）本轮一字未动；
 *      小歌词里**不得**出现本轮的窗口常量（防「顺手也改了小歌词」）。
 *   ⑤ 行为模型：把门 1:1 复刻成 JS，断言单击 0 次 seek、双击（同一样、窗口内）1 次 seek、
 *      超窗 / 换行不 seek、边界值 300 与 301 的行为与源码的 `>` 一致。
 *
 * 契约强度说明：①②③④ 是文本级静态断言（通过 ≠ 能编译 ≠ 真机手感对）；
 * ⑤ 是行为级模型证明，证明的是**这个判定逻辑**自洽，不含 RN 触摸事件时序
 *（双击靠 TouchableOpacity 的两次 onPress，若某天 iOS 手势系统把第二次点击吞了，
 * 本脚本看不出来）。
 *
 * 运行：node scripts/sim-lyric-double-tap-seek.js
 * 退出码：不变量全过且反例全被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
/** 去注释：否则「把某行注释掉」或注释里出现的关键字会被当成仍然存在 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  anim: 'src/screens/PlayDetail/lyricAnimation.ts',
  vertical: 'src/screens/PlayDetail/Vertical/Lyric.tsx',
  horizontal: 'src/screens/PlayDetail/Horizontal/Lyric.tsx',
  mini: 'src/screens/PlayDetail/components/MiniLyric.tsx',
}
const RAW = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, read(v)]))
const SRC = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, stripComments(v)]))

const DOUBLE_TAP_MS = 300
/** 双击门的判据原文（三处：源码、判据、模型 —— 必须逐字同构） */
const GATE = 'if (lastTap.index !== index || now - lastTap.at > LYRIC_DOUBLE_TAP_MS)'
const TAP_IMPORT = /import\s*\{[^}]*\bLYRIC_DOUBLE_TAP_MS\b[^}]*\}\s*from\s*'@\/screens\/PlayDetail\/lyricAnimation'/

let pass = 0, fail = 0
const results = []
const check = (group, name, ok, detail = '') => {
  results.push({ group, name, ok, detail })
  ok ? pass++ : fail++
}

/** 从 anchor（正则，匹配到「开始大括号之前」）之后取出配平的大括号块体（不含两侧大括号） */
const blockAfter = (src, anchor) => {
  const m = anchor.exec(src)
  if (!m) return null
  const open = src.indexOf('{', m.index + m[0].length)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return null
}

const countOf = (s, needle) => s.split(needle).length - 1

/** 唯一命中才替换：命中数 ≠ 1 直接抛错（String.replace 只换第一处，锚点不唯一会静默假通过） */
const tamper = (src, from, to) => {
  const n = countOf(src, from)
  if (n !== 1) throw new Error(`反例锚点命中 ${n} 次（应为 1 次）：${JSON.stringify(from.slice(0, 60))}`)
  return src.replace(from, to)
}

const LINE_PRESS_ANCHOR = /const handleLinePress = useCallback\(\(index: number\) =>/
const PLAY_LINE_ANCHOR = /const handlePlayLine = useCallback\(\(time: number\) =>/

// ---------------------------------------------------------------------------
// 单个大歌词文件的不变量（竖屏 / 横屏跑同一套；反例对篡改后的源码跑同一套）
// ---------------------------------------------------------------------------
function fileInvariants(label, src) {
  const out = []
  const add = (n, ok, detail = '') => out.push({ name: `${label} · ${n}`, ok, detail })

  const pressDecl = countOf(src, 'const handleLinePress = useCallback(')
  const body = blockAfter(src, LINE_PRESS_ANCHOR)
  add('handleLinePress 唯一且函数体可配平提取',
    pressDecl === 1 && body != null,
    `声明 ${pressDecl} 处${body ? ` / 函数体 ${body.split('\n').length} 行` : ' / 函数体未提取到'}`)
  if (body == null) return out

  // ① 单击分支（双击门体）：只记录 + return
  const gate = blockAfter(body, /if \(lastTap\.index !== index \|\| now - lastTap\.at > LYRIC_DOUBLE_TAP_MS\)/)
  if (gate == null) {
    add('双击门存在（同一行 + 窗口两个条件）', false, '未找到门的 if 块')
  } else {
    const records = /lastLineTapRef\.current = \{ index, at: now \}/.test(gate)
    const returns = /(^|\n)\s*return\b/.test(gate)
    const leaks = ['global.app_event', 'setProgress(', 'handleScrollToActive(', 'setVisible(', 'setForceScroll(']
      .filter((k) => gate.includes(k))
    add('双击门存在（同一行 + 窗口两个条件）', true, '门体 ' + gate.trim().split('\n').length + ' 行')
    add('单击分支只记时间戳（lastLineTapRef = { index, at: now }）并立即 return',
      records && returns, `记录=${records} 早退=${returns}`)
    add('单击分支不得 seek / 定位 / 收浮层（否则「单击即跳转」回归）',
      leaks.length === 0, leaks.length ? `混入：${leaks.join('、')}` : '无越界语句')
  }

  // ② 门只看时间不行：必须同时比对行号
  add('门的判据含「同一行」比对（lastTap.index !== index）',
    body.includes('lastTap.index !== index'), GATE)

  // ③ seek 在门之后，且恰好 1 处
  const seekIdx = body.indexOf('global.app_event.setProgress(')
  const gateIdx = body.indexOf('LYRIC_DOUBLE_TAP_MS')
  add('跳转 seek 恰好 1 处，且位置在双击门之后',
    countOf(body, 'global.app_event.setProgress(') === 1 && seekIdx > gateIdx && gateIdx >= 0,
    `seek ${countOf(body, 'global.app_event.setProgress(')} 处 / 函数体内偏移：门 @${gateIdx}、seek @${seekIdx}`)

  // ④ 双击分支的清理四件套（原行为不能丢）
  const clean = ['isPauseScrollRef.current = false', 'dragStartOffsetRef.current = null',
    'isOverlayShownRef.current = false', 'playLineRef.current?.setVisible(false)']
    .filter((k) => body.includes(k))
  add('双击分支仍清定位态 / 收浮层（四件套一字未丢）',
    clean.length === 4, `命中 ${clean.length}/4：${clean.length === 4 ? '齐' : clean.join('、')}`)

  // ⑤ 窗口常量来自单源
  const tapRef = /const lastLineTapRef = useRef<\{ index: number, at: number \}>\(\{ index: -1, at: 0 \}\)/
  add('lastLineTapRef 用 ref（单击不触发重渲染）且初值 index=-1 / at=0',
    tapRef.test(src), tapRef.test(src) ? '声明在位' : '未找到声明')
  add('窗口常量从 lyricAnimation 单源引入（不在本文件另写字面量）',
    TAP_IMPORT.test(src) && !/const LYRIC_DOUBLE_TAP_MS = \d+/.test(src),
    `导入=${TAP_IMPORT.test(src)} 本地字面量=${/const LYRIC_DOUBLE_TAP_MS = \d+/.test(src)}`)

  // ⑥ 三角通道本轮未动
  const playBody = blockAfter(src, PLAY_LINE_ANCHOR)
  add('浮层播放三角通道仍在（handlePlayLine 内 setProgress(time)）',
    playBody != null && playBody.includes('global.app_event.setProgress(time)'),
    playBody ? `setProgress(time) ${countOf(playBody, 'global.app_event.setProgress(time)')} 处` : 'handlePlayLine 未提取到')

  return out
}

console.log('sim-lyric-double-tap-seek：大歌词双击跳转播放契约\n')
console.log('='.repeat(92))

// ---------------------------------------------------------------------------
// A. 窗口常量单源 + 只改大歌词的边界（小歌词不动是用户二选一的定案）
// ---------------------------------------------------------------------------
{
  const declared = new RegExp(`export const LYRIC_DOUBLE_TAP_MS = (\\d+)`).exec(SRC.anim)
  check('A 窗口常量', `lyricAnimation 导出 LYRIC_DOUBLE_TAP_MS = ${DOUBLE_TAP_MS}`,
    declared != null && Number(declared[1]) === DOUBLE_TAP_MS,
    declared ? `= ${declared[1]}` : '未找到导出')

  const miniTouched = SRC.mini.includes('LYRIC_DOUBLE_TAP_MS')
  const miniPress = /const handlePress = useCallback\(\(\) => \{\s*onPress\?\.\(\)\s*\}, \[onPress\]\)/.test(SRC.mini)
  check('A 只改大歌词', '小歌词（MiniLyric）未被本轮波及：无窗口常量、单击仍是「切到歌词页」',
    !miniTouched && miniPress,
    `出现窗口常量=${miniTouched} 单击透传 onPress?.()=${miniPress}`)
}

// ---------------------------------------------------------------------------
// B. 两个大歌词的结构不变量
// ---------------------------------------------------------------------------
for (const [key, label] of [['vertical', '竖屏大歌词'], ['horizontal', '横屏大歌词']]) {
  for (const r of fileInvariants(label, SRC[key])) {
    check('B 结构不变量', r.name, r.ok, r.detail)
  }
}

// ---------------------------------------------------------------------------
// C. 行为模型：1:1 复刻双击门
// ---------------------------------------------------------------------------
{
  // 复刻源码门的语义（与 GATE 逐字同构）：同一行 + 间隔 ≤ 窗口 ⇒ 双击
  const makeHandler = () => {
    const state = { index: -1, at: 0 }
    const seeks = []
    return {
      seeks,
      press: (index, now) => {
        const lastTap = state
        if (lastTap.index !== index || now - lastTap.at > DOUBLE_TAP_MS) {
          state.index = index
          state.at = now
          return
        }
        state.index = -1
        state.at = 0
        seeks.push(index)
      },
    }
  }
  const run = (presses) => {
    const h = makeHandler()
    for (const [index, at] of presses) h.press(index, at)
    return h.seeks
  }

  const cases = [
    ['单击一次不跳转', [[3, 0]], []],
    ['双击同一行（间隔 120ms）跳转一次，行号正确', [[3, 0], [3, 120]], [3]],
    ['双击间隔超窗（400ms）按两次单击处理，不跳转', [[3, 0], [3, 400]], []],
    ['点 A 行后紧接着点 B 行（间隔 100ms）不算双击（不能误跳）', [[3, 0], [4, 100]], []],
    ['A→A→B（0/100/200ms）：A 被判双击跳一次，B 只是新的第一次', [[3, 0], [3, 100], [4, 200]], [3]],
    ['边界：间隔恰为窗口值 300ms 仍算双击（源码用 >，不是 >=）', [[3, 0], [3, 300]], [3]],
    ['边界：间隔 301ms 不算双击', [[3, 0], [3, 301]], []],
    ['三连击（A→A→A，0/100/200ms）只跳一次：命中后状态立即复位', [[3, 0], [3, 100], [3, 200]], [3]],
  ]
  for (const [name, presses, want] of cases) {
    const got = run(presses)
    check('C 行为模型', `模型：${name}`,
      JSON.stringify(got) === JSON.stringify(want),
      `按下 ${JSON.stringify(presses)} → seek ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`)
  }

  // 模型必须与源码逐字同构，否则模型证明的不是源码
  const modelSame = SRC.vertical.includes(GATE) && SRC.horizontal.includes(GATE)
  check('C 行为模型', '模型用的判据与两个大歌词源码逐字同构',
    modelSame, modelSame ? GATE : '源码里的门与模型不一致')
}

// ---------------------------------------------------------------------------
// D. 反例：每条改动都必须被某个不变量拦下
// ---------------------------------------------------------------------------
const tamperCases = [
  {
    label: '竖屏：删掉单击分支的 return（单击又直接往下走）',
    file: 'vertical',
    mutate: (s) => tamper(s,
      '      lastLineTapRef.current = { index, at: now }\n      return\n',
      '      lastLineTapRef.current = { index, at: now }\n'),
  },
  {
    label: '竖屏：单击分支里掺一句 seek（凭「点一下也跳」）',
    file: 'vertical',
    mutate: (s) => tamper(s,
      '      lastLineTapRef.current = { index, at: now }\n      return\n',
      '      lastLineTapRef.current = { index, at: now }\n      global.app_event.setProgress(0)\n      return\n'),
  },
  {
    label: '竖屏：门里的记录写成 { index: -1, at: 0 }（永远凑不成双击）',
    file: 'vertical',
    mutate: (s) => tamper(s,
      'lastLineTapRef.current = { index, at: now }',
      'lastLineTapRef.current = { index: -1, at: 0 }'),
  },
  {
    label: '竖屏：门丢掉「同一行」比对，只看时间（点 A 再点 B 会被误判双击）',
    file: 'vertical',
    mutate: (s) => tamper(s, 'lastTap.index !== index || ', ''),
  },
  {
    label: '竖屏：窗口比较改成恒真（>= 0），双击永远不成立',
    file: 'vertical',
    mutate: (s) => tamper(s, 'now - lastTap.at > LYRIC_DOUBLE_TAP_MS', 'now - lastTap.at >= 0'),
  },
  {
    label: '竖屏：import 里去掉窗口常量（改为本地字面量）',
    file: 'vertical',
    mutate: (s) => tamper(s, 'LINE_CHANGE_HOLD_MS, LYRIC_DOUBLE_TAP_MS, OVERLAY_FADE_MS',
      'LINE_CHANGE_HOLD_MS, OVERLAY_FADE_MS')
      .replace('const handleLinePress = useCallback((index: number) => {',
        'const LYRIC_DOUBLE_TAP_MS = 300\n  const handleLinePress = useCallback((index: number) => {'),
  },
  {
    label: '竖屏：双击分支里丢掉「收浮层」（点完行浮层还挂着）',
    file: 'vertical',
    mutate: (s) => tamper(s, '    playLineRef.current?.setVisible(false)\n    const line = lyricLines[index]', '    const line = lyricLines[index]'),
  },
  {
    label: '竖屏：双击分支里的 seek 被删掉（双击什么都不做）',
    file: 'vertical',
    mutate: (s) => tamper(s,
      '      global.app_event.setProgress(line.time / 1000)\n',
      ''),
  },
  {
    label: '竖屏：三角通道的 seek 被删掉（只剩双击一条路）',
    file: 'vertical',
    mutate: (s) => tamper(s, '    global.app_event.setProgress(time)\n  }, [])\n\n  useEffect(() => {', '  }, [])\n\n  useEffect(() => {'),
  },
  {
    label: '横屏：删掉单击分支的 return（单击又直接往下走）',
    file: 'horizontal',
    mutate: (s) => tamper(s,
      '      lastLineTapRef.current = { index, at: now }\n      return\n',
      '      lastLineTapRef.current = { index, at: now }\n'),
  },
  {
    label: '横屏：门丢掉「同一行」比对，只看时间',
    file: 'horizontal',
    mutate: (s) => tamper(s, 'lastTap.index !== index || ', ''),
  },
  {
    label: 'anim：窗口常量被改成 0（双击不可能成立）',
    file: 'anim',
    mutate: (s) => tamper(s, 'export const LYRIC_DOUBLE_TAP_MS = 300', 'export const LYRIC_DOUBLE_TAP_MS = 0'),
  },
  {
    label: 'mini：顺手给小歌词也加双击（用户明确说不动它）',
    file: 'mini',
    mutate: (s) => tamper(s,
      '  const handlePress = useCallback(() => {\n    onPress?.()\n  }, [onPress])',
      '  const handlePress = useCallback(() => {\n    if (Date.now() - 0 > LYRIC_DOUBLE_TAP_MS) return\n    onPress?.()\n  }, [onPress])'),
  },
]

for (const c of tamperCases) {
  let patched = null
  try {
    patched = c.mutate(SRC[c.file])
  } catch (e) {
    check('D 反例', `反例 ${c.label} 的锚点仍唯一命中`, false, String(e.message || e))
    continue
  }
  if (patched === SRC[c.file]) {
    check('D 反例', `反例 ${c.label} 被拦下`, false, '替换未命中：源码已变，反例失效需同步')
    continue
  }
  // 与真跑同一套口径：竖屏/横屏跑文件不变量，另两个文件跑 A 组的全局判据
  let failed
  if (c.file === 'vertical' || c.file === 'horizontal') {
    failed = fileInvariants(c.file === 'vertical' ? '竖屏大歌词' : '横屏大歌词', patched).filter((r) => !r.ok)
  } else if (c.file === 'anim') {
    const m = /export const LYRIC_DOUBLE_TAP_MS = (\d+)/.exec(patched)
    failed = (m != null && Number(m[1]) === DOUBLE_TAP_MS) ? [] : [{ name: '常量值' }]
  } else {
    const m = !patched.includes('LYRIC_DOUBLE_TAP_MS') &&
      /const handlePress = useCallback\(\(\) => \{\s*onPress\?\.\(\)\s*\}, \[onPress\]\)/.test(patched)
    failed = m ? [] : [{ name: '小歌词边界' }]
  }
  check('D 反例', `反例 ${c.label} 被拦下`, failed.length > 0,
    failed.length ? `命中：${failed.map((r) => r.name.split('· ').pop()).join('、')}` : '未被任何不变量拦下（守卫无效）')
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
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  if (r.detail) console.log(`        ${r.detail}`)
}

console.log('\n' + '='.repeat(92))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(92))
process.exit(fail ? 1 : 0)
