#!/usr/bin/env node
/**
 * sim-above-mini-player-anchor.js —— 「批量管理框未与下方迷你播放器栏紧贴」契约（第 31 轮·图二）。
 *
 * 需求原话（2026-10-03 第 31 轮）：
 *   「图二：下方的批量管理框未与下方迷你播放器栏紧贴，因为在主题设置中修改了 TAB 栏距离，
 *     导致批量管理框未与下方迷你播放器出现间距，需要消除间距。」
 *
 * 根因：底部悬浮层（本地与下载的「批量管理」框、在线列表的多选操作条、下载悬浮球）都把
 * 「迷你播放器顶边」写死成 `160 + safeAreaBottom` —— 160 是「底缝 4 + Tab 栏高 56 +
 * 滑块满程 20 + 播放器高 ≈80」在**标准字体**下的和。用户在主题设置里把「Tab栏距离」调小后
 * 播放器整体下移、Tab 栏高度也随字体缩放变化，这三处却纹丝不动 ⇒ 批量管理框与播放器之间
 * 裂出一条空隙。
 *
 * 本轮口径（src/utils/tabBarCollapse.ts）：
 *   新增 `useAboveMiniPlayerBottom()` —— 迷你播放器**顶边**距屏底的距离，公式与 PlayerBar
 *   的 `bottomExpanded` / `bottomCollapsed` **逐字同式**：
 *     · 展开态底边 = 安全区 + (首页 ? (横屏 ? 76 : 底缝 + scaleSizeH(tabBarBaseHeight) +
 *       floatDistance(滑块)) : 底缝)   —— home / 横屏 / 字体缩放 / 滑块四路输入全带；
 *     · 收起态底边 = collapsedFloatBottom(安全区)（与左下角圆钮共用同一条公式）；
 *     · 顶边 = 底边 + 播放器高（useMiniPlayerHeight 实测值，未测量时 getCollapsedPillSize
 *       的 token 兜底 —— 与圆钮同源）。
 *   三个调用点全部改吃它，不再自报常数。
 *
 * 为什么必须靠契约脚本：「同式」是**跨文件**的关系，tsc/eslint（本工程根本没有）都不会
 * 检查「PlayerBar 改了公式而这处长一样」。把 hook 里的 floatDistance(tabBarDistance) 删掉、
 * 把收起态分支压平、把 deps 数组里的 tabBarDistance 拿掉（滑块动了不重算）、把调用点改回
 * `160 + safeAreaBottom`，全都能全绿通过 —— 真机上就是「上下滑动 Tab 栏距离，批量管理框
 * 纹丝不动」或「收起态/横屏下错位」。本脚本**解析两边的算式文本做归一化比对**，
 * 而不是各自钉死一份拷贝（那样两边一起改错也发现不了）。带反例自检。
 *
 * 运行：node scripts/sim-above-mini-player-anchor.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去块注释与整行 `//` 注释（断言锚点全都不是注释；行尾注释保留）
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  tokens: 'src/utils/tabBarCollapse.ts',
  playerBar: 'src/components/player/PlayerBar/index.tsx',
  localDownload: 'src/screens/Home/Views/LocalDownload/index.tsx',
  multipleModeBar: 'src/components/OnlineList/MultipleModeBar.tsx',
  downloadBall: 'src/components/DownloadBall/index.tsx',
}

const REAL = {
  tokens: read(F.tokens),
  playerBar: read(F.playerBar),
  localDownload: read(F.localDownload),
  multipleModeBar: read(F.multipleModeBar),
  downloadBall: read(F.downloadBall),
}

/** 取函数体（签名 → 第一个顶格 `}` 行），够用且不依赖解析器 */
const bodyOf = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  const rest = src.slice(start)
  const end = /\n\}\n/.exec(rest)
  return end ? rest.slice(0, end.index + 3) : null
}

/** 归一化：空白压成一个空格（比对「同式」时只看记号，不看缩进与换行） */
const norm = (s) => s.replace(/\s+/g, ' ').trim()

/** 抽 PlayerBar / hook 里的 `const bottomExpanded = …` 算式（到 `: bottomFloatGap)` 为止） */
const BOTTOM_EXPANDED_HEAD = 'const bottomExpanded = safeAreaBottom + (isHome'
const BOTTOM_EXPANDED_TAIL = ': bottomFloatGap)'
const extractBottomExpanded = (src) => {
  const at = src.indexOf(BOTTOM_EXPANDED_HEAD)
  if (at < 0) return null
  const end = src.indexOf(BOTTOM_EXPANDED_TAIL, at)
  if (end < 0) return null
  return src.slice(at, end + BOTTOM_EXPANDED_TAIL.length)
}

// ---------------------------------------------------------------------------
// 不变量：迷你播放器顶边只有一个来源，且与 PlayerBar 逐字同式
// ---------------------------------------------------------------------------

const aboveMiniPlayerInvariants = (files) => {
  const reasons = []
  const tokens = stripComments(files.tokens)
  const playerBar = stripComments(files.playerBar)

  const HOOK_SIGNATURE = 'export const useAboveMiniPlayerBottom = (): number => {'
  const hook = bodyOf(tokens, HOOK_SIGNATURE)
  if (hook == null) {
    reasons.push('useAboveMiniPlayerBottom 缺失（底部悬浮层又得各自报常数）')
  } else {
    // —— ① 四路输入 + 实测高度齐备 ——
    const inputs = [
      ['useSafeAreaBottom()', '安全区'],
      ['useHomeCovered()', '首页与否（决定播放器下面还有没有 Tab 栏那一层）'],
      ["useSettingValue('theme.tabBarDistance')", '「Tab栏距离」滑块'],
      ['useHorizontalMode()', '横屏分支'],
      ['useTabBarCollapsed()', 'Tab 栏收起态'],
      ['useMiniPlayerHeight()', '播放器实测高度'],
    ]
    for (const [needle, label] of inputs) {
      if (!hook.includes(needle)) reasons.push(`useAboveMiniPlayerBottom 少了 ${label}（${needle}）—— 这条输入被丢掉后落点不再跟着它动`)
    }

    // —— ② 展开态算式与 PlayerBar 逐字同式（归一化空白后比对）——
    const hookExpanded = extractBottomExpanded(hook)
    const playerExpanded = extractBottomExpanded(playerBar)
    if (hookExpanded == null) {
      reasons.push('useAboveMiniPlayerBottom 里找不到展开态算式（const bottomExpanded = safeAreaBottom + (isHome …)）')
    } else if (playerExpanded == null) {
      reasons.push('PlayerBar 里找不到展开态算式（锚点漂移，跨文件同式比对失去参照物）')
    } else if (norm(hookExpanded) !== norm(playerExpanded)) {
      reasons.push('展开态算式与 PlayerBar 不是同式（改了播放器落点却忘了这条，或反过来）'
        + `：hook=${norm(hookExpanded)} / PlayerBar=${norm(playerExpanded)}`)
    }

    // —— ③ 收起态底边与圆钮同源 ——
    if (!hook.includes('const playerBottom = isHome && tabBarCollapsed ? collapsedFloatBottom(safeAreaBottom) : bottomExpanded')) {
      reasons.push('收起态没有换用 collapsedFloatBottom(安全区)（收起时批量管理框会停在展开态位置）')
    }
    if (!tokens.includes('bottom: collapsedFloatBottom(safeAreaBottom),')) {
      reasons.push('useCollapsedRowGeometry 的 bottom 不再是 collapsedFloatBottom(安全区)（收起态两边不再同源）')
    }
    if (!playerBar.includes('const bottomCollapsed = collapsedRow.bottom')) {
      reasons.push('PlayerBar 的收起态底边不再取收起行几何（跨文件同式的另一半被拆）')
    }

    // —— ④ 顶边 = 底边 + 播放器高 ——
    if (!hook.includes('return playerBottom + getCollapsedPillSize(measured)')) {
      reasons.push('顶边没有 = 底边 + 播放器高（getCollapsedPillSize(measured)）—— 悬浮层会压进胶囊里或悬在半空')
    }
    if (!hook.includes('const measured = useMiniPlayerHeight()')) {
      reasons.push('播放器高度没有取实测值（useMiniPlayerHeight）')
    }

    // —— ⑤ deps 齐：滑块/字体/横屏/收起态变了必须重算 ——
    const deps = '[safeAreaBottom, homeCovered, isHorizontalMode, tabBarDistance, tabBarCollapsed, measured]'
    if (!hook.includes(deps)) {
      reasons.push(`useMemo 依赖数组不齐（应为 ${deps}）—— 滑块拖了不重算，落点纹丝不动`)
    }
  }

  // —— ⑥ PlayerBar 侧：同式关系的另一半必须还在 ——
  if (!playerBar.includes("useSettingValue('theme.tabBarDistance')")) {
    reasons.push('PlayerBar 不再读「Tab栏距离」（theme.tabBarDistance）—— 两边同式的输入源没了')
  }
  if (!playerBar.includes('if (effectiveCollapsed) return') ||
      !playerBar.includes('setMiniPlayerHeight(e.nativeEvent.layout.height)')) {
    reasons.push('PlayerBar 只在展开态上报高度这条口径被改了（收起态宽度变窄会把标题挤换行，报上去的高度偏大）')
  }
  if (!playerBar.includes('const effectiveCollapsed = isHome && tabBarCollapsed')) {
    reasons.push('PlayerBar 的 effectiveCollapsed 不再是 isHome && tabBarCollapsed（与 hook 的收起判定不再同义）')
  }

  // —— ⑦ 三个调用点：全部改吃 hook，且不许再自报常数 ——
  const callSites = [
    ['本地与下载「批量管理」框', 'localDownload'],
    ['在线列表多选操作条', 'multipleModeBar'],
    ['下载悬浮球', 'downloadBall'],
  ]
  for (const [label, key] of callSites) {
    const code = stripComments(files[key])
    if (!code.includes("import { useAboveMiniPlayerBottom } from '@/utils/tabBarCollapse'")) {
      reasons.push(`${label} 没有引入 useAboveMiniPlayerBottom`)
    }
    if (!code.includes('const aboveMiniPlayerBottom = useAboveMiniPlayerBottom()')) {
      reasons.push(`${label} 没有取用 useAboveMiniPlayerBottom（又回到写死落点）`)
    }
    if (!code.includes('bottom: aboveMiniPlayerBottom,')) {
      reasons.push(`${label} 的 bottom 不再是 aboveMiniPlayerBottom（贴着播放器这条被改回去了）`)
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检：改回写死值 / 拆掉任一路输入，都必须被拦下
// ---------------------------------------------------------------------------

const runCounterExamples = () => {
  const results = []
  const ce = (name, detail, ok) => results.push({ name, detail, ok: !!ok })

  const withFiles = (patched) => ({ ...REAL, ...patched })

  // a1 本地与下载批量管理框改回写死值（用户这一轮报的现场）
  const a1 = REAL.localDownload.replace('bottom: aboveMiniPlayerBottom,', 'bottom: 160 + safeAreaBottom,')
  ce('a1 批量管理框改回写死落点', '改「Tab栏距离」后与播放器裂出间距',
    a1 !== REAL.localDownload && aboveMiniPlayerInvariants(withFiles({ localDownload: a1 })).some((r) => r.includes('批量管理')))

  // a2 下载悬浮球改回写死值（同类问题不许留第三个常数）
  const a2 = REAL.downloadBall.replace('bottom: aboveMiniPlayerBottom,', 'bottom: 160 + safeAreaBottom,')
  ce('a2 下载悬浮球改回写死落点', '同一份常数散落多处',
    a2 !== REAL.downloadBall && aboveMiniPlayerInvariants(withFiles({ downloadBall: a2 })).some((r) => r.includes('下载悬浮球')))

  // a3 多选操作条不再取用 hook
  const a3 = REAL.multipleModeBar.replace('    const aboveMiniPlayerBottom = useAboveMiniPlayerBottom()\n', '')
  ce('a3 多选操作条不再取用 hook', '底部悬浮层又一次各报各的',
    a3 !== REAL.multipleModeBar && aboveMiniPlayerInvariants(withFiles({ multipleModeBar: a3 })).some((r) => r.includes('多选操作条')))

  // a4 hook 的展开态算式丢掉滑块（异式：改了 PlayerBar 就分家）
  //   锚点用和检查同一个抽取器取出的算式本体 —— 算式跨三行，写死一行原文匹配不上，
  //   反例会「静默不生效」变成假绿（第一版就是这么错的）。
  const hookFormula = extractBottomExpanded(REAL.tokens)
  const a4 = hookFormula == null ? REAL.tokens
    : REAL.tokens.replace(hookFormula, hookFormula.replace('+ floatDistance(tabBarDistance)', ''))
  ce('a4 展开态算式丢掉滑块', '与 PlayerBar 不同式，滑块拖了落点不跟',
    a4 !== REAL.tokens && aboveMiniPlayerInvariants(withFiles({ tokens: a4 })).some((r) => r.includes('不是同式')))

  // a5 PlayerBar（参照物）自己改式 —— 证明「同式」是实时比对而不是抄来的死字符串。
  //   别动 `: bottomFloatGap)`：抽取器的尾巴锚点就是它，动完抽不到算式，
  //   判定会落到「锚点漂移」而不是「不同式」（第一版就是这么误伤的）。
  //   改横屏裸值 76 → 80：结构不动、记号变了，只有实时比对才拦得住。
  const playerFormula = extractBottomExpanded(REAL.playerBar)
  const a5 = playerFormula == null ? REAL.playerBar
    : REAL.playerBar.replace(playerFormula, playerFormula.replace('? 76 :', '? 80 :'))
  ce('a5 参照物 PlayerBar 改式', '同式关系破裂必须跟着判红',
    a5 !== REAL.playerBar && aboveMiniPlayerInvariants(withFiles({ playerBar: a5 })).some((r) => r.includes('不是同式')))

  // a6 收起态分支被压平（收起后落到展开态位置）
  const a6 = REAL.tokens.replace(
    'const playerBottom = isHome && tabBarCollapsed ? collapsedFloatBottom(safeAreaBottom) : bottomExpanded',
    'const playerBottom = bottomExpanded',
  )
  ce('a6 收起态分支被压平', '收起时批量管理框停在展开态位置',
    a6 !== REAL.tokens && aboveMiniPlayerInvariants(withFiles({ tokens: a6 })).some((r) => r.includes('收起态')))

  // a7 顶边不加播放器高（悬浮层压进胶囊里）
  const a7 = REAL.tokens.replace('return playerBottom + getCollapsedPillSize(measured)', 'return playerBottom')
  ce('a7 顶边不加播放器高', '悬浮层与胶囊重叠',
    a7 !== REAL.tokens && aboveMiniPlayerInvariants(withFiles({ tokens: a7 })).some((r) => r.includes('播放器高')))

  // a8 deps 丢掉滑块（滑块拖了不重算）
  const a8 = REAL.tokens.replace(
    '[safeAreaBottom, homeCovered, isHorizontalMode, tabBarDistance, tabBarCollapsed, measured]',
    '[safeAreaBottom, homeCovered, isHorizontalMode, tabBarCollapsed, measured]',
  )
  ce('a8 useMemo 依赖丢掉滑块', '拖滑块不重算，落点纹丝不动',
    a8 !== REAL.tokens && aboveMiniPlayerInvariants(withFiles({ tokens: a8 })).some((r) => r.includes('依赖数组')))

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-above-mini-player-anchor ===')
console.log('迷你播放器顶边单源（useAboveMiniPlayerBottom 与 PlayerBar 逐字同式 + 三处调用点改吃它）（第 31 轮·图二）')
console.log()

const checks = [
  ['图二 悬浮层紧贴播放器（hook 四路输入 / 展开态同式 / 收起态同源 / 顶边加实测高度 / deps 齐 / 三处调用点无写死常数）', () => aboveMiniPlayerInvariants(REAL)],
]

let invOk = true
const passCount = []
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    passCount.push(name)
    console.log(`\n[${name}]\n  PASS`)
  } else {
    invOk = false
    console.log(`\n[${name}]`)
    ;[...new Set(reasons)].forEach((r) => console.log('  FAIL ' + r))
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
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${passCount.length}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
