/*
 * 【第 17 轮】搜索联想 / 筛选浮层的锚点：只用窗口坐标（用户截图实锤的 bug）
 *
 * 现象：搜索页输入歌名后，联想浮层从屏幕顶部开始、把搜索框整个盖住。
 *
 * 根因（坐标空间错位）：搜索框行挂在结果列表的 header 里（ListHeaderComponent）。iOS 上
 * react-native-navigation 的全局 swizzle 把列表的 contentInsetAdjustmentBehavior 强制成
 * scrollableAxes —— 列表内容会被系统自动叠加一份安全区顶部插图（能否滚动还会让它出现 /
 * 消失）。第 16 轮把浮层 top 直接设成「header 内部坐标系里量到的搜索框行底边」
 * （nativeEvent.layout.y + height），于是浮层比搜索框在屏幕上的真实位置**高了一个安全区**
 * （iPhone 16 Pro Max 实测：搜索框行屏幕底边 163pt vs 浮层 top 104pt ⇒ 差 59pt = 安全区），
 * 联想到列表顶部起画、正好压住搜索框。
 *
 * 修法（只用窗口坐标，不再依赖任何坐标系假设）：
 *   1) HeaderBar：搜索框行节点加 ref，onLayout / 主动调用时都用 measureInWindow 上报
 *      「搜索框行底边」的**窗口 y**（y + height）——它天然包含安全区插图与列表滚动偏移；
 *      并暴露 measureSearchBar() 供浮层显示前刷新实测值。
 *   2) 搜索页：把 header 上报的窗口 y 减去浮层所在容器（本页根 View，collapsable={false}）
 *      自身的窗口 y，换算成本层坐标后再设 tipList 的 top；点输入框 / 输入内容时各刷新一次
 *      实测（列表能否滚动会让插图出现 / 消失，位置会变），真正 search / show 之前再测一次。
 *   3) 浮层容器与结果列表同层（本页根 View 之下），坐标换算才是同一个坐标系；
 *      KAV 那类合成组件没有 measureInWindow，不能拿它当换算基准。
 *
 * 距离模型（iPhone 14 Pro Max，纯算术）：
 *   搜索框行底边窗口 y = 163pt；安全区顶部插图 = 59pt；浮层定位层窗口 y = 0pt；
 *   旧实现（整块 header 下端锚点）比搜索框底边低 116pt ⇒ top = 279（浮层落在平台行下面，太远）；
 *   上一版（header 内部 layout 坐标）比搜索框底边高 59pt ⇒ top = 104（盖住搜索框，用户截图）；
 *   本版 top = 163 − 0 = 163 = 搜索框底边（贴住下沿）。
 *
 * 源码不变量 9 条 + 距离模型 4 条 + 反例自检 5 条（去掉上报口 / 退回 layout 坐标 /
 * top 换回页头高度 / 不做坐标换算 / 显示前不刷新），反例全部用当前源码变异，
 * 替换未命中同样算失败 —— 断言写成永远为真的空壳在这里就会自己露馅。
 * 第 21 轮（图九）在定时器里加了空输入兜底，refresh 不再紧贴 show/search：本脚本相应把
 * 「显示前刷新」由「紧贴」改成「定时器内第一句 + 位置在 show/search 之前」（每函数 ≥2 次不变）。
 * 本脚本是**静态源码解析**（正则 + 位置比较），钉的是「结构还在不在」，证明不了真机行为。
 *
 * 运行：node scripts/sim-search-tip-anchor.js
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

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

const F = {
  search: 'src/screens/Home/Views/Search/index.tsx',
  headerBar: 'src/screens/Home/Views/Search/HeaderBar/index.tsx',
}
const SRC = { search: read(F.search), headerBar: read(F.headerBar) }

const sliceBy = (code, from, to) => {
  const a = code.indexOf(from)
  if (a < 0) return ''
  const b = code.indexOf(to, a)
  if (b < 0) return ''
  return code.slice(a, b + to.length)
}
/** 去掉行注释：断言只看代码，避免中文说明里提到旧名字（layout 坐标 / headerHeight）造成假命中 */
const stripComments = (s) => s.split('\n').map((line) => {
  const at = line.indexOf('//')
  return at < 0 ? line : line.slice(0, at)
}).join('\n')

// ==================== A. 源码不变量（窗口坐标上报 / 换算 / 刷新 / 同源高度） ====================
const INVARIANTS = [
  ['headerBar：搜索框行有 ref，且用 measureInWindow 上报「窗口坐标」的 x/y/width/height',
    () => /const searchBarRowRef = useRef<View>\(null\)/.test(SRC.headerBar) &&
      /searchBarRowRef\.current\?\.measureInWindow\(\(x, y, width, height\) => \{\r?\n\s*onSearchBarLayout\?\.\(\{ x, y, width, height \}\)\r?\n\s*\}\)/.test(SRC.headerBar)],
  ['headerBar：不得退回 header 内部 layout 坐标（nativeEvent.layout / containerPaddingTop + y 都不许出现）',
    () => {
      const code = stripComments(SRC.headerBar)
      return !/nativeEvent\.layout/.test(code) && !/containerPaddingTop \+ y/.test(code)
    }],
  ['headerBar：暴露 measureSearchBar 命令（浮层显示前刷新实测的入口）',
    () => /measureSearchBar: \(\) => void/.test(SRC.headerBar) &&
      /measureSearchBar,\r?\n\s*\}\)/.test(SRC.headerBar)],
  ['search：换算函数做「窗口坐标 − 容器窗口坐标」⇒ top = 搜索框底边窗口 y − 容器窗口 y',
    () => {
      const body = sliceBy(stripComments(SRC.search), 'const applyTipListGeometry = useCallback', '}, [syncTipListHeight])')
      return /const top = bar\.y \+ bar\.height - box\.y/.test(body) &&
        /const left = bar\.x - box\.x/.test(body) &&
        /: \{ top, left, width: bar\.width \}/.test(body)
    }],
  ['search：浮层定位所在层（本页根 View）可测量 —— pageRootRef + measureInWindow + collapsable={false}',
    () => /const pageRootRef = useRef<View>\(null\)/.test(SRC.search) &&
      /pageRootRef\.current\?\.measureInWindow\(\(x, y\) => \{\r?\n\s*overlayContainerWindowPosRef\.current = \{ x, y \}/.test(SRC.search) &&
      /ref=\{pageRootRef\}\r?\n\s*collapsable=\{false\}/.test(SRC.search)],
  ['search：浮层容器 top/left/width 用换算值（tipListGeometry），未测量到前给 0 高不铺一屏',
    () => /top: tipListGeometry\.top,/.test(SRC.search) &&
      /left: tipListGeometry\.left,/.test(SRC.search) &&
      /width: tipListGeometry\.width,/.test(SRC.search) &&
      /: \{ top: 0, height: 0, left: 0, right: 0 \}/.test(SRC.search)],
  ['search：显示前刷新实测 —— 点输入框 / 输入内容各一次，且真正 search、show 之前（定时器内）再测一次',
    () => {
      const code = stripComments(SRC.search)
      const refresh = sliceBy(code, 'const refreshTipListAnchor = useCallback', '}, [measureOverlayContainer])')
      const okRefresh = /headerBarRef\.current\?\.measureSearchBar\(\)/.test(refresh) &&
        /measureOverlayContainer\(\)/.test(refresh)
      const show = sliceBy(code, 'const handleShowTipList: HeaderBarProps', '}, 500)')
      const tip = sliceBy(code, 'const handleTipSearch: HeaderBarProps', '}, 500)')
      // 第 21 轮图九在定时器里加了「空输入不弹旧词条」的兜底，refresh 后不再紧贴 show/search：
      // 断言改成保住两件事 —— ①定时器里第一句就是再刷一次实测；②刷新位置在 show/search 之前。
      const timerFirst = (fn) => /setTimeout\(\(\) => \{\r?\n\s*refreshTipListAnchor\(\)\r?\n/.test(fn)
      const refreshBefore = (fn, callee) => {
        const body = fn.slice(fn.indexOf('setTimeout(() => {'))
        const r = body.indexOf('refreshTipListAnchor()')
        const c = body.indexOf(callee)
        return r >= 0 && c > r
      }
      const okShow = timerFirst(show) &&
        (show.match(/refreshTipListAnchor\(\)/g) || []).length >= 2 &&
        refreshBefore(show, 'searchTipListRef.current?.show(layoutHeightRef.current)')
      const okTip = timerFirst(tip) &&
        (tip.match(/refreshTipListAnchor\(\)/g) || []).length >= 2 &&
        refreshBefore(tip, 'searchTipListRef.current?.search(text, layoutHeightRef.current)')
      return okRefresh && okShow && okTip
    }],
  ['search：旧的整块 header 锚点不得复活（headerHeight 不许回到代码里）',
    () => !/headerHeight/i.test(stripComments(SRC.search))],
  ['search：浮层高度与 top 同源（containerHeight − tipListTopRef.current），两处必须一起动',
    () => /layoutHeightRef\.current = Math\.max\(0, containerHeightRef\.current - top\)/.test(SRC.search) &&
      /const top = tipListTopRef\.current\r?\n/.test(SRC.search)],
]

// ==================== B. 距离模型（纯算术，iPhone 14 Pro Max） ====================
const MODEL = {
  device: 'iPhone 14 Pro Max',
  searchBarBottomWindow: 163, // 搜索框行底边的窗口 y（用户实测）
  safeAreaTop: 59, // 该机型安全区顶部插图（= 上一版少的那个量）
  overlayContainerWindowY: 0, // 浮层定位层（本页根 View）的窗口 y
  oldAnchorBelow: 116, // 旧实现（整块 header 下端）比搜索框底边低多少
}
const oldTop = MODEL.searchBarBottomWindow + MODEL.oldAnchorBelow
const prevTop = MODEL.searchBarBottomWindow - MODEL.safeAreaTop
const newTop = MODEL.searchBarBottomWindow - MODEL.overlayContainerWindowY

const MODEL_CHECKS = [
  [`① 搜索框行底边窗口 y = ${MODEL.searchBarBottomWindow}pt（${MODEL.device}）`,
    () => MODEL.searchBarBottomWindow === 163],
  ['② 旧实现（整块 header 下端）top = 279，比搜索框底边低 116pt（浮层落到平台行下面，太远）',
    () => oldTop === 279 && oldTop - MODEL.searchBarBottomWindow === MODEL.oldAnchorBelow],
  ['③ 上一版（header 内部 layout 坐标）top = 104，比搜索框底边高 59pt（正好一个安全区，盖住搜索框）',
    () => prevTop === 104 && MODEL.searchBarBottomWindow - prevTop === MODEL.safeAreaTop],
  ['④ 本版 top = 163 = 搜索框底边（贴住下沿，不多不少）',
    () => newTop === MODEL.searchBarBottomWindow && newTop === 163],
]

const runInvariants = () => INVARIANTS.map(([label, fn]) => ({ label, ok: !!fn() }))
const runModel = () => MODEL_CHECKS.map(([label, fn]) => ({ label, ok: !!fn() }))
const caught = (res) => res.some((r) => !r.ok)

const aRes = runInvariants()
const bRes = runModel()

// —— 反例（全部用当前源码变异，必须被不变量判红；替换未命中算失败）——
const mutated = (key, from, to) => {
  const m = Object.assign({}, SRC)
  m[key] = SRC[key].replace(from, to)
  return { m, changed: m[key] !== SRC[key] }
}
const caughtBy = (m, key) => {
  const saved = SRC[key]
  SRC[key] = m[key]
  const ok = caught(runInvariants())
  SRC[key] = saved
  return ok
}

// m1: 去掉上报口（HeaderBar 量完不往搜索页送）
const m1 = mutated('headerBar',
  'onSearchBarLayout?.({ x, y, width, height })',
  'void 0')
// m2: 退回 layout 坐标（nativeEvent.layout 不含安全区插图 = 上一版的 bug）
const m2 = mutated('headerBar',
  'onLayout={measureSearchBar}',
  'onLayout={({ nativeEvent }) => { onSearchBarLayout?.(nativeEvent.layout) }}')
// m3: top 换回页头高度（写死，不再用换算值）
const m3 = mutated('search',
  'top: tipListGeometry.top,',
  'top: 96,')
// m4: 不做坐标换算（拿搜索框底边窗口 y 直接当本层坐标 = 又高出一个容器 y）
const m4 = mutated('search',
  'const top = bar.y + bar.height - box.y',
  'const top = bar.y + bar.height')
// m5: 显示前不刷新（列表滚动让插图出现 / 消失后，仍用旧位置）—— 拿掉定时器内那次实测
const m5 = mutated('search',
  'setTimeout(() => {\n      refreshTipListAnchor()\n      timeoutRef.current = null',
  'setTimeout(() => {\n      timeoutRef.current = null')

// —— 输出 ——
console.log('='.repeat(92))
console.log('「搜索联想浮层锚点（窗口坐标）」契约模型（摘自源码，静态解析）')
console.log('='.repeat(92))
console.log(`  A 源码不变量 ：${aRes.filter((r) => r.ok).length}/${aRes.length} 通过`)
console.log(`  B 距离模型   ：${bRes.filter((r) => r.ok).length}/${bRes.length} 通过`)
console.log()

console.log('—— A. 源码不变量（窗口坐标上报 / 换算 / 刷新 / 同源高度）——')
for (const r of aRes) check(r.label, r.ok)
console.log('—— B. 距离模型（搜索框底边 163pt：旧实现 279 / 上一版 104 / 本版 163）——')
for (const r of bRes) check(r.label, r.ok)

neg('反例 m1：去掉上报口（HeaderBar 量完不送坐标），被 A 判红', m1.changed && caughtBy(m1.m, 'headerBar'))
neg('反例 m2：退回 header 内部 layout 坐标（不含安全区插图），被 A 判红', m2.changed && caughtBy(m2.m, 'headerBar'))
neg('反例 m3：top 换回写死的页头高度，被 A 判红', m3.changed && caughtBy(m3.m, 'search'))
neg('反例 m4：不做坐标换算（窗口 y 直接当本层坐标），被 A 判红', m4.changed && caughtBy(m4.m, 'search'))
neg('反例 m5：显示前不刷新实测（位置已变仍用旧值），被 A 判红', m5.changed && caughtBy(m5.m, 'search'))

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
