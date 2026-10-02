/**
 * 底部悬浮层（Tab 栏 / 迷你播放器）「启动抽动 + 切换画面闪黑边」的稳定性回归。
 *
 * 用户原话：
 *   「启动软件时，底部的 tab 栏和迷你播放器栏会出现抽动而且会闪一下很粗的黑边，
 *     我发现是出现迷你播放器一瞬间造成的……我每次切换画面，它和 tab 栏都会短暂
 *     的闪一下。」
 *
 * 三处独立成因，本脚本逐条钉死（每条都配一个反例：把修复拆掉必须判不合格）：
 *
 *  ① 启动抽动 —— safeAreaBottom 首帧恒为 0，真实值（iPhone 34pt）要等原生异步
 *     回调；两条悬浮栏的 bottom 完全由它决定，于是「先用 0 画出来 → 再跳到 34pt」。
 *     修法：store/common 加 safeAreaReady，两条栏在 ready 之前 return null 不下发；
 *     标记必须在 setSafeAreaBottom 的**同值短路之前**打（否则 iPad/SE 安全区为 0
 *     的机型永远不 ready，栏永远不出现）。
 *
 *  ② 每次切换画面闪一下 —— 玻璃每帧采「自己背后那块屏幕」当折射源，而整段 push/pop
 *     转场里那块背景是「旧页正在滑走 + 新页正在盖上来」的中间态。省电门
 *     （useHomeCovered / useScreenCovered）只看账本：push 时新页 setComponentId 晚于
 *     转场开始、pop 事件早于转场结束，两头都盖不住。修法：navigation 里按转场时长留
 *     一段 navTransitioning 窗口，两条栏的 paused 都并入该条件。
 *     2026-10-02（用户第 5 条）按方向拆开：**push 侧照旧**（startPush 起手开窗，
 *     玻璃此时正在被盖住，按住无害）；**pop 侧改为立即关窗**（handleScreenPopped
 *     调 endNavTransitionWindow）——返回时玻璃正在被露出来，续期等于让 Home 的
 *     tab 栏/迷你播放器多显示 420ms 的陈旧纹理（用户原话「底部透过的画面短暂刷新、
 *     突然变了一下」）。断言随之从「pop 必须续期」改成「pop 必须关窗且不得再续期」。
 *
 *  ③ 出现瞬间闪很粗的黑边 —— 原生 LiquidGlassView 的 commitCapturedTexture：冷启动
 *     头几帧 backdrop 还没合成，drawHierarchy 采到的是**整幅均匀色**，原实现写成
 *     `if uniform, let previous`，而第一帧 previous 恰好是 nil → 整幅黑被当成背景提交。
 *     修法：均匀帧一律沿用上一帧（nil 就继续没有纹理，draw() 的 guard 会跳过本帧、
 *     视图保持透明），上限仍是 maxUniformHoldFrames 帧。
 *     （2026-10-01 同步：同日另有墙钟沉降窗口改动——窗口内均匀帧的沿用上限顺延到墙钟
 *     时限 captureSettleDuration（第 19 轮起两条判据合并为这一条时限，不再有
 *     captureSettleMaxHold），帧数上限表达式原样保留。本节断言已逐条核对、未失真；
 *     窗口与半成品判据由 sim-glass-firstmount-contract.js 单独钉住。）
 *
 * 运行：node scripts/sim-bottom-overlay-stability.js
 */

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

const FILES = {
  state: 'src/store/common/state.ts',
  action: 'src/store/common/action.ts',
  hook: 'src/store/common/hook.ts',
  event: 'src/event/stateEvent.ts',
  sizeView: 'src/components/SizeView.tsx',
  tabbar: 'src/components/layout/ModernTabBar.tsx',
  playerbar: 'src/components/player/PlayerBar/index.tsx',
  nav: 'src/navigation/navigation.ts',
  glassSwift: 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassView.swift',
}

const REAL = {}
for (const [k, v] of Object.entries(FILES)) REAL[k] = read(v)

// ---------------------------------------------------------------------------
// 不变量
// ---------------------------------------------------------------------------

/** 取一个函数的定义体（从签名到下一个同缩进的 `}` 之前的第一个空行为止——这里用更稳的括号配平） */
const fnBody = (src, signatureRe) => {
  const m = signatureRe.exec(src)
  if (!m) return null
  const start = m.index + m[0].length
  let depth = 1
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(start, i)
    }
  }
  return null
}

/**
 * ① 启动抽动：safeAreaReady 门。
 * 传入一组被篡改过的文件内容，返回缺陷原因列表（空数组 = 合格）。
 */
const startupInvariants = (f) => {
  const reasons = []

  // state: 字段声明 + 初值
  if (!/safeAreaReady:\s*boolean/.test(f.state)) reasons.push('state 缺 safeAreaReady 字段声明')
  if (!/safeAreaReady:\s*false\s*,/.test(f.state)) reasons.push('state 未把 safeAreaReady 初始化为 false')

  // event: 事件通道
  if (!/safeAreaReadyUpdated/.test(f.event)) reasons.push('stateEvent 缺 safeAreaReadyUpdated 事件')

  // action: 标记必须早于「同值短路」
  const setSafeArea = fnBody(f.action, /setSafeAreaBottom\(size: number\)\s*\{/)
  if (!setSafeArea) {
    reasons.push('action 里找不到 setSafeAreaBottom')
  } else {
    const markAt = setSafeArea.indexOf('safeAreaReadyUpdated(true)')
    const earlyReturnAt = setSafeArea.indexOf('if (state.safeAreaBottom == size) return')
    if (markAt < 0) reasons.push('setSafeAreaBottom 未点亮 safeAreaReady（底部栏永不下发）')
    else if (earlyReturnAt >= 0 && markAt > earlyReturnAt) {
      reasons.push('safeAreaReady 标记落在同值短路之后（安全区为 0 的机型永远不 ready）')
    }
  }

  // hook: 订阅 + 退订
  if (!/export const useSafeAreaReady\s*=/.test(f.hook)) {
    reasons.push('common/hook 缺 useSafeAreaReady')
  } else {
    const body = fnBody(f.hook, /export const useSafeAreaReady\s*=\s*\(\)\s*=>\s*\{/)
    if (!body || !/state_event\.on\('safeAreaReadyUpdated'/.test(body) || !/state_event\.off\('safeAreaReadyUpdated'/.test(body)) {
      reasons.push('useSafeAreaReady 未订阅/未退订 safeAreaReadyUpdated')
    }
  }

  // SizeView: 原生不回调时的兜底放行 + 清理
  const sizeEffect = fnBody(f.sizeView, /useEffect\(\(\)\s*=>\s*\{/)
  if (!/setTimeout\([\s\S]{0,200}?setSafeAreaBottom\(commonState\.safeAreaBottom\)[\s\S]{0,200}?\}\s*,\s*250\)/.test(f.sizeView)) {
    reasons.push('SizeView 缺「原生不回调则 250ms 后放行」的兜底定时器（底部栏可能永远不出现）')
  }
  if (!/return \(\) => \{[\s\S]*?clearTimeout\(safeAreaFallbackRef\.current\)/.test(f.sizeView)) {
    reasons.push('SizeView 未在卸载时清理兜底定时器')
  }
  void sizeEffect

  // 消费点：两条栏都必须门控，且门控语句在所有 hook 之后
  const gateAfterHooks = (src, gateRe, label) => {
    const at = src.search(gateRe)
    if (at < 0) {
      reasons.push(`${label} 缺 safeAreaReady 门控（会先用 0 画再跳到真实安全区）`)
      return
    }
    const hookRe = /\buse[A-Z]\w*\(|\buseRef\(|\buseState\(/g
    let last = -1
    let m
    while ((m = hookRe.exec(src)) !== null) {
      if (m.index < at) last = m.index
      else break
    }
    // 门控之后不允许再出现 hook 调用（否则 hook 数在两次渲染间不一致 → 崩溃）
    hookRe.lastIndex = at
    const after = hookRe.exec(src)
    if (after) {
      reasons.push(`${label} 的 safeAreaReady 门控写在了 hook(${after[0]}) 之前（条件 hook → 崩溃）`)
    }
    void last
  }
  gateAfterHooks(f.tabbar, /if \(!safeAreaReady\) return null/, 'ModernTabBar')
  // 迷你播放器只在 Home 实例上等安全区（其它页面实例的 bottom 不含安全区）
  gateAfterHooks(f.playerbar, /if \(isHome && !safeAreaReady\) return null/, 'PlayerBar')

  // 等待期间必须以「不下发」的方式消失：不能是 opacity 0 之类仍占位的实现
  if (!/useSafeAreaReady\(\)/.test(f.tabbar) || !/useSafeAreaReady\(\)/.test(f.playerbar)) {
    reasons.push('消费点未调用 useSafeAreaReady')
  }
  return reasons
}

/** ② 转场闪一下：navTransitioning 窗口 */
const transitionInvariants = (f) => {
  const reasons = []

  if (!/navTransitioning:\s*boolean/.test(f.state) || !/navTransitioning:\s*false\s*,/.test(f.state)) {
    reasons.push('state 缺 navTransitioning 字段或其初值不为 false')
  }
  if (!/setNavTransitioning\(transitioning: boolean\)\s*\{/.test(f.action)) {
    reasons.push('action 缺 setNavTransitioning')
  } else if (!/navTransitioningUpdated/.test(f.event)) {
    reasons.push('stateEvent 缺 navTransitioningUpdated 事件')
  }
  const hookBody = fnBody(f.hook, /export const useNavTransitioning\s*=\s*\(\)\s*=>\s*\{/)
  if (!hookBody || !/state_event\.on\('navTransitioningUpdated'/.test(hookBody) || !/state_event\.off\('navTransitioningUpdated'/.test(hookBody)) {
    reasons.push('useNavTransitioning 未订阅/未退订 navTransitioningUpdated')
  }

  // 窗口本体：开 → 定时关，且时长常量存在（低于 RNN 转场时长就不够罩住）
  const winBody = fnBody(f.nav, /function beginNavTransitionWindow\(\)\s*\{/)
  if (!winBody) {
    reasons.push('navigation 缺 beginNavTransitionWindow')
  } else {
    if (!/setNavTransitioning\(true\)/.test(winBody)) reasons.push('转场窗口未开启 navTransitioning')
    if (!/setTimeout\([\s\S]*?setNavTransitioning\(false\)/.test(winBody)) issues_push(f, reasons)
  }
  const settle = /const NAV_TRANSITION_SETTLE_MS = (\d+)/.exec(f.nav)
  if (!settle) {
    reasons.push('navigation 缺 NAV_TRANSITION_SETTLE_MS 常量')
  } else if (Number(settle[1]) < 350) {
    reasons.push(`NAV_TRANSITION_SETTLE_MS=${settle[1]} 短于 iOS 默认 push 转场 0.35s，罩不住整段转场`)
  }

  // 两个端点方向相反：push 起手**开窗**，pop 事件**立即关窗**（2026-10-02 用户第 5 条）
  const startPushBody = fnBody(f.nav, /const startPush = [\s\S]{0,120}?=>\s*\{/)
  if (!startPushBody || !/beginNavTransitionWindow\(\)/.test(startPushBody)) {
    reasons.push('startPush 未开转场窗口（push 全过程仍会采到中间态）')
  }
  const poppedBody = fnBody(f.nav, /export const handleScreenPopped = [\s\S]{0,120}?=>\s*\{/)
  if (!poppedBody || !/endNavTransitionWindow\(\)/.test(poppedBody)) {
    reasons.push('handleScreenPopped 未立即关窗（返回后底部玻璃要等窗口到点才恢复，露出的是 push 之前的陈旧画面）')
  }
  if (poppedBody && /beginNavTransitionWindow\(\)/.test(poppedBody)) {
    reasons.push('handleScreenPopped 又改回续期窗口（返回时玻璃正在被露出来，续期 = 多显示一截陈旧画面）')
  }
  // 关窗函数本体：清在途定时器 + 置 false。只清定时器不置 false = 窗口一直开着、
  // 玻璃再也不恢复渲染（比续期更糟）；只置 false 不清定时器 = 定时器到点再关一次，
  // 本身无害，但会掩盖「定时器管理」这层语义，故一并要求。
  const endBody = fnBody(f.nav, /function endNavTransitionWindow\(\)\s*\{/)
  if (!endBody) {
    reasons.push('navigation 缺 endNavTransitionWindow（pop 无法提前释放转场窗口）')
  } else {
    if (!/clearTimeout\(navTransitionTimer\)/.test(endBody)) {
      reasons.push('endNavTransitionWindow 未清在途定时器')
    }
    if (!/setNavTransitioning\(false\)/.test(endBody)) {
      reasons.push('endNavTransitionWindow 未关闭 navTransitioning（玻璃不再恢复渲染）')
    }
  }

  // 消费点：两条栏的每一块玻璃的 paused 都要并入 navTransitioning
  for (const [key, label] of [['tabbar', 'ModernTabBar'], ['playerbar', 'PlayerBar']]) {
    const src = f[key]
    const pausedAll = src.match(/paused=\{[^}]*\}/g) || []
    if (!pausedAll.length) {
      reasons.push(`${label} 找不到 paused= 绑定`)
      continue
    }
    const missing = pausedAll.filter((p) => !/navTransitioning/.test(p))
    if (missing.length) {
      reasons.push(`${label} 有 ${missing.length} 块玻璃的 paused 未并入 navTransitioning：${missing.join(' / ')}`)
    }
  }
  return reasons
}

// 占位：push 分支里缺少关窗定时器时给一条（拆出来避免上面表达式过长）
function issues_push(f, reasons) {
  reasons.push('转场窗口未在超时后关闭（玻璃会永久暂停渲染）')
}

/** ③ 冷启动黑边：原生均匀帧沿用不再要求 previous 非空 */
const captureInvariants = (f) => {
  const reasons = []
  const body = fnBody(f.glassSwift, /private func commitCapturedTexture\([^)]*\)\s*\{/)
  if (!body) {
    reasons.push('LiquidGlassView 缺 commitCapturedTexture')
    return reasons
  }
  // 修复后的形态：均匀帧直接沿用 previous（previous 为 nil = 继续没有纹理）
  if (!/backgroundTexture = previous/.test(body)) {
    reasons.push('均匀帧未沿用上一帧纹理（整幅均匀黑会被当背景提交 → 出现瞬间闪黑边）')
  }
  // 反例守卫：不能再要求 previous 非空
  if (/maxUniformHoldFrames[^\n]*,\s*let previous/.test(body) || /if\s+let\s+previous\b/.test(body)) {
    reasons.push('均匀帧沿用又加回了 previous 非空条件（冷启动第一帧 previous 恒为 nil，等于没修）')
  }
  // 上限必须保留：真实均匀背景（纯色底 / 暗色主题）不能被永久挡住
  if (!/consecutiveUniformFrames <= Self\.maxUniformHoldFrames/.test(body)) {
    reasons.push('均匀帧沿用缺 maxUniformHoldFrames 上限（纯色背景永远不显形）')
  }
  // 沿用之所以安全的根据：draw() 在无纹理时跳过本帧、视图保持透明
  if (!/guard backgroundTexture != nil else \{ return \}/.test(f.glassSwift)) {
    reasons.push('draw() 缺「无背景纹理则跳过本帧」的 guard（沿用 nil 会画成黑）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

const run = (name, fn, tamper, expectSubstr) => {
  const files = { ...REAL, ...tamper }
  const hits = fn(files)
  const ok = expectSubstr === undefined ? hits.length === 0 : hits.some((r) => r.includes(expectSubstr))
  return { name, ok, detail: hits.join('；') }
}

const assertions = []
assertions.push(run('① safeAreaReady 启动门链路贯通（state/event/action/hook/SizeView/两消费点）', startupInvariants))
assertions.push(run('② 转场窗口链路贯通（state/action/event/hook/navigation：push 开窗 / pop 关窗 / 两消费点）', transitionInvariants))
assertions.push(run('③ 原生均匀帧沿用不再要求 previous 非空、且上限仍在', captureInvariants))

// --- 反例自检（每条修复拆掉一点点，必须被判不合格）---
const counterExamples = []
counterExamples.push(run('C1 TabBar 拆掉 safeAreaReady 门控', startupInvariants,
  { tabbar: REAL.tabbar.replace('if (!safeAreaReady) return null', '') },
  '缺 safeAreaReady 门控'))
counterExamples.push(run('C2 PlayerBar 门控丢掉 isHome 前缀（专辑页也会被藏起来）', startupInvariants,
  { playerbar: REAL.playerbar.replace('if (isHome && !safeAreaReady) return null', 'if (!safeAreaReady) return null') },
  '缺 safeAreaReady 门控'))
counterExamples.push(run('C3 safeAreaReady 标记挪到同值短路之后', startupInvariants,
  { action: REAL.action.replace('setSafeAreaBottom(size: number) {', 'setSafeAreaBottom(size: number) {\n    if (state.safeAreaBottom == size) return') },
  '标记落在同值短路之后'))
counterExamples.push(run('C4 SizeView 拆掉兜底定时器（原生卡住则底部栏永不出现）', startupInvariants,
  { sizeView: REAL.sizeView.replace(/\}, 250\)/, '}, 99999999)') },
  '缺「原生不回调则 250ms'))
counterExamples.push(run('C5 startPush 拆掉转场窗口', transitionInvariants,
  { nav: REAL.nav.replace(/const startPush = ([\s\S]*?)\n\}/, (m) => m.replace('beginNavTransitionWindow()', '')) },
  'startPush 未开转场窗口'))
counterExamples.push(run('C6 handleScreenPopped 拆掉关窗（返回不再释放窗口）', transitionInvariants,
  { nav: REAL.nav.replace(/export const handleScreenPopped = ([\s\S]*?)\n\}/, (m) => m.replace('endNavTransitionWindow()', '')) },
  '未立即关窗'))
counterExamples.push(run('C6b handleScreenPopped 又改回续期（返回后多显示 420ms 陈旧画面）', transitionInvariants,
  { nav: REAL.nav.replace(/export const handleScreenPopped = ([\s\S]*?)\n\}/, (m) => m.replace('  endNavTransitionWindow()', '  beginNavTransitionWindow()')) },
  '又改回续期'))
counterExamples.push(run('C6c endNavTransitionWindow 只清定时器不关标志（玻璃再也不恢复渲染）', transitionInvariants,
  { nav: REAL.nav.replace('  if (navTransitionTimer) {\n    clearTimeout(navTransitionTimer)\n    navTransitionTimer = null\n  }\n  commonActions.setNavTransitioning(false)',
    '  if (navTransitionTimer) {\n    clearTimeout(navTransitionTimer)\n    navTransitionTimer = null\n  }') },
  '未关闭 navTransitioning'))
counterExamples.push(run('C7 TabBar 玻璃的 paused 丢掉 navTransitioning', transitionInvariants,
  // 2026-10-02：该绑定后来又并入了前台门（!appActive，用户第 8 条）与实时采景（live=），
  // 反例的替换目标必须跟着当前的完整形态走，否则 replace 未命中、反例退化成永真。
  { tabbar: REAL.tabbar.replace(/paused=\{homeCovered \|\| collapsed \|\| navTransitioning \|\| !appActive\}/, 'paused={homeCovered || collapsed || !appActive}') },
  '未并入 navTransitioning'))
counterExamples.push(run('C8 均匀帧沿用又加回 previous 非空条件（旧实现）', captureInvariants,
  { glassSwift: REAL.glassSwift.replace('if consecutiveUniformFrames <= Self.maxUniformHoldFrames {', 'if consecutiveUniformFrames <= Self.maxUniformHoldFrames, let previous {') },
  '又加回了 previous 非空条件'))
counterExamples.push(run('C9 均匀帧不再沿用、直接把均匀帧当背景提交', captureInvariants,
  { glassSwift: REAL.glassSwift.replace('backgroundTexture = previous', 'backgroundTexture = texture') },
  '未沿用上一帧纹理'))
counterExamples.push(run('C10 拆掉 draw() 的无纹理 guard', captureInvariants,
  { glassSwift: REAL.glassSwift.replace('guard backgroundTexture != nil else { return }', '') },
  'draw() 缺'))
counterExamples.push(run('C11 转场窗口时长缩到 200ms（罩不住 0.35s 转场）', transitionInvariants,
  { nav: REAL.nav.replace('const NAV_TRANSITION_SETTLE_MS = 420', 'const NAV_TRANSITION_SETTLE_MS = 200') },
  '短于 iOS 默认 push 转场'))

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

console.log('='.repeat(92))
console.log('底部悬浮层启动/转场稳定性（Tab 栏 + 迷你播放器）')
console.log('='.repeat(92))
console.log('  ① 启动抽动      → safeAreaReady 门（两条栏 ready 之前不下发）')
console.log('  ② 切换画面闪一下 → navTransitioning 转场窗口（startPush 开窗、handleScreenPopped 立即关窗）')
console.log('  ③ 出现瞬间黑边   → 原生均匀帧沿用（不再要求 previous 非空）')
console.log()
console.log('='.repeat(92))
console.log('断言')
console.log('='.repeat(92))
for (const a of assertions) {
  console.log(`  ${a.ok ? '✅' : '❌'}  ${a.name}${a.detail ? '   [' + a.detail + ']' : ''}`)
}
console.log()
console.log('='.repeat(92))
console.log('反例自检（修复被拆掉时必须拦下）')
console.log('='.repeat(92))
for (const c of counterExamples) {
  console.log(`  ${c.ok ? '✅' : '❌'}  ${c.name}${c.ok ? ' —— 已拦下' : '   ← 没拦住：' + c.detail}`)
}

const hardFail = assertions.filter((a) => !a.ok).length + counterExamples.filter((c) => !c.ok).length
console.log()
console.log(`结果：断言 ${assertions.length - assertions.filter((a) => !a.ok).length}/${assertions.length} 通过；反例 ${counterExamples.length - counterExamples.filter((c) => !c.ok).length}/${counterExamples.length} 拦下`)
process.exit(hardFail ? 1 : 0)
