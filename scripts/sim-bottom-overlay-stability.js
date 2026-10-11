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
 *     转场开始、pop 事件早于转场结束，两头都盖不住。修法（第 61 轮定案）：**push 与
 *     pop 两侧整段按住** —— 两条栏的 paused 经**玻璃专用门** glassHomeCovered /
 *     glassCovered（= 账本门 ∨ useGlassNavHold）消费，live 只有 pagerDragging 一个来源。
 *     用户第 61 轮原话：「当我右滑时，底部 tab 栏和迷你播放器栏透过的画面是由右向左
 *     滑入的，这个方向是反的，需要改」—— 转场期间玻璃背后是正在横向滑走的那一页，
 *     转场中途的任何实时采景/恢复都会把那一页采进胶囊；按住 = 保持转场前那一帧
 *     （对返回就是底层页面自己的画面，它本来就是静止的），转场结束再由原生
 *     handleResumeFromPause 收口（保留旧纹理 → 重采 → 立即画，第 56 轮）。
 *     历史（别改回去）：2026-10-02（用户第 5 条）pop 侧曾被改成「screenPopped 到达即
 *     立即释放」，理由是按住会让 Home 的底栏多显示一截陈旧纹理（用户原话「底部透过的
 *     画面短暂刷新、突然变了一下」）；第 52/56/58 轮又加了一整条「露出门」+ 原生
 *     自恢复，让玻璃在返回转场里实时重采 —— 那正是「方向反了 / 延迟高」的成因。
 *     第 61 轮把露出门与原生自恢复整体删除、pop 侧改回**续期按住**：按住的就是底层
 *     页面自己的画面（它本来就静止），不再有「陈旧」问题。
 *     本节范围（第 61 轮主控口径）只钉**消费点形态**：每块玻璃的 paused 必须走玻璃
 *     专用门（不得直接串 navTransitioning —— 绕开 useGlassNavHold 的 !dragging 让行口；
 *     也不得直接喂账本门），live 只有 pagerDragging 一个来源。「窗口本体与 pop 续期
 *     那一段的完整链路已由 scripts/sim-glass-nav-hold.js 单独钉住（不要在两处重复钉
 *     同一件事）」—— transitionWindow.ts 的时长/续期/唯一关窗出口、startPush 开窗、
 *     utils 三返回入口（pop / popTo / popToRoot）派发前开窗且不让帧、handleScreenPopped
 *     续期全在那里，且是更强版本（带反例自检）；本脚本原第 ② 节的窗口链路断言与反例
 *     随之撤出（搬家 + 加强，不是削弱，也别在本脚本里复活一份）。
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
  glassSwift: 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassView.swift',
  // 第 61 轮（主控口径）：transitionWindow.ts / navigation.ts / utils.ts 的窗口链路
  // 不再由本脚本读取与断言 —— 完整链路见 scripts/sim-glass-nav-hold.js（更强版本 +
  // 反例自检，别在两处重复钉同一件事）。
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
 * 去掉注释：第 61 轮删除的机制（露出门 / 原生自恢复 / 立即关窗）在历史注释里
 * 保留了名字与解释，反向断言一律在去注释后的源码上跑，避免被解释性注释误伤；
 * 正向断言（必须存在的调用）也要求在代码里，注释里的字样不算数。
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

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

/** ② 转场闪一下的**消费侧形态**：两条栏每一块玻璃的 paused 都走玻璃专用门、live 只有 pagerDragging。
 *
 * 第 61 轮（2026-10-11）主控口径：转场窗口本体与 pop 续期那一段的**完整链路**
 * （navigation/transitionWindow.ts 的时长/续期/唯一关窗出口、startPush 开窗、
 * utils 三返回入口派发前开窗且不让帧、handleScreenPopped 续期）已由
 * scripts/sim-glass-nav-hold.js 单独钉住（那里的版本更强、且带反例自检）——
 * 本脚本不重复钉同一条链，只认消费点：
 *   · ModernTabBar / PlayerBar 每一块玻璃的 paused 必须经玻璃专用门
 *     glassHomeCovered / glassCovered（= 账本门 ∨ useGlassNavHold）消费；
 *     不许直接串 navTransitioning / navRevealing（绕开 useGlassNavHold 的 !dragging
 *     让行口 = screenPopped 续期窗口内用户立刻横滑 Pager 时玻璃被误按停），
 *     也不许直接喂账本门 useHomeCovered() / useScreenCovered()（账面门只在
 *     screenPopped 到达时才翻、且不含转场按住）。
 *   · live 只有 pagerDragging 一个来源（第 61 轮第 3 条：转场按住门不得并入 live ——
 *     按住期间要的正是「不采景」，并进去 = 转场里玻璃又活过来采正在滑走的那一页；
 *     也不许写死 false —— 真手势会话丢了，滑动时玻璃又回到 30fps 静止档追不上）。
 */
const transitionInvariants = (f) => {
  const reasons = []
  for (const [key, label, gate] of [['tabbar', 'ModernTabBar', 'glassHomeCovered'], ['playerbar', 'PlayerBar', 'glassCovered']]) {
    const src = stripComments(f[key])
    const pausedAll = src.match(/paused=\{[^}]*\}/g) || []
    if (!pausedAll.length) {
      reasons.push(`${label} 找不到 paused= 绑定（玻璃的省电门消费点没了）`)
      continue
    }
    const missing = pausedAll.filter((p) => !new RegExp(gate).test(p))
    if (missing.length) {
      reasons.push(`${label} 有 ${missing.length} 块玻璃的 paused 未接玻璃专用门 ${gate}：${missing.join(' / ')}`)
    }
    const inline = pausedAll.filter((p) => /navTransitioning|navRevealing/.test(p))
    if (inline.length) {
      reasons.push(`${label} 有 paused 直接串了 navTransitioning / navRevealing（第 61 轮第 3 条：必须经 useGlassNavHold 合入门内，绕开 !dragging 让行口 = 横滑时玻璃被误按停）`)
    }
    const fedRaw = pausedAll.filter((p) => /\buse(?:Home|Screen)Covered\(/.test(p))
    if (fedRaw.length) {
      reasons.push(`${label} 有 paused 直接喂了账本门（useHomeCovered / useScreenCovered）：${fedRaw.join(' / ')} —— 必须用玻璃专用门 ${gate}（账本门只在 screenPopped 到达时才翻，且不含转场按住）`)
    }
    const liveAll = src.match(/live=\{[^}]*\}/g) || []
    if (!liveAll.length) {
      reasons.push(`${label} 找不到 live= 绑定（实时采景会话的消费点没了）`)
      continue
    }
    const liveBad = liveAll.filter((l) => l.replace(/\s+/g, '') !== 'live={pagerDragging}')
    if (liveBad.length) {
      reasons.push(`${label} 有 ${liveBad.length} 块玻璃的 live 不是 pagerDragging 唯一来源：${liveBad.join(' / ')}（第 61 轮第 3 条：转场按住门不得并入 live，也不许写死 false 丢掉真手势会话）`)
    }
  }
  return reasons
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
assertions.push(run('② 消费点形态（每块玻璃的 paused 走玻璃专用门 glassHomeCovered / glassCovered、不得直接串 navTransitioning / 不得喂账本门；live 只有 pagerDragging 一个来源；窗口链路本体见 scripts/sim-glass-nav-hold.js）', transitionInvariants))
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
// 第 61 轮（主控口径）：原第 ② 节钉「转场窗口链路」的反例（C5 startPush 拆窗、
// C6 screenPopped 拆续期、C6b 立即释放、C6c 不清在途定时器、C6d 返回入口让帧，
// 以及 C11 系列时长/相对路径）已随断言一起**撤出本脚本** —— 该链路现由
// scripts/sim-glass-nav-hold.js 单独钉住，且是更强版本（含反例自检）。
// 这是「搬家 + 加强」（同一件事只钉一处），不是把反例删没了；
// 本脚本只保留消费点形态的反例（C7 系列）。
counterExamples.push(run('C7 TabBar 玻璃的 paused 丢掉玻璃专用门', transitionInvariants,
  // 反例的替换目标必须跟着当前的完整形态走（2026-10-02 并入前台门 !appActive；
  // 第 61 轮转场按住部分收进玻璃门合成），否则 replace 未命中、反例退化成永真。
  { tabbar: REAL.tabbar.replace('paused={glassHomeCovered || collapsed || !appActive}', 'paused={collapsed || !appActive}') },
  '未接玻璃专用门'))
counterExamples.push(run('C7b TabBar paused 又直接串 navTransitioning（绕开 !dragging 让行口）', transitionInvariants,
  { tabbar: REAL.tabbar.replace('paused={glassHomeCovered || collapsed || !appActive}', 'paused={glassHomeCovered || collapsed || navTransitioning || !appActive}') },
  '直接串了 navTransitioning'))
counterExamples.push(run('C7c TabBar paused 直接喂账本门（丢掉转场按住）', transitionInvariants,
  { tabbar: REAL.tabbar.replace('paused={glassHomeCovered || collapsed || !appActive}', 'paused={useHomeCovered() || collapsed || !appActive}') },
  '直接喂了账本门'))
counterExamples.push(run('C7d TabBar live 又并入 navTransitioning（按住期间又在采景）', transitionInvariants,
  // 锚点用「paused 绑定 + live 绑定」整段：tabbar 里 live={pagerDragging} 有两处，
  // 单用它不唯一；带上 collapsed 变体那份 paused 后唯一命中 line 799 那块玻璃
  //（另一块是 !collapsed 变体，锚不中）。
  { tabbar: REAL.tabbar.replace('paused={glassHomeCovered || collapsed || !appActive} live={pagerDragging}', 'paused={glassHomeCovered || collapsed || !appActive} live={pagerDragging || navTransitioning}') },
  '不是 pagerDragging 唯一来源'))
counterExamples.push(run('C7e TabBar live 写死 false（真手势会话被丢掉）', transitionInvariants,
  { tabbar: REAL.tabbar.replace('paused={glassHomeCovered || collapsed || !appActive} live={pagerDragging}', 'paused={glassHomeCovered || collapsed || !appActive} live={false}') },
  '不是 pagerDragging 唯一来源'))
counterExamples.push(run('C8 均匀帧沿用又加回 previous 非空条件（旧实现）', captureInvariants,
  { glassSwift: REAL.glassSwift.replace('if consecutiveUniformFrames <= Self.maxUniformHoldFrames {', 'if consecutiveUniformFrames <= Self.maxUniformHoldFrames, let previous {') },
  '又加回了 previous 非空条件'))
counterExamples.push(run('C9 均匀帧不再沿用、直接把均匀帧当背景提交', captureInvariants,
  { glassSwift: REAL.glassSwift.replace('backgroundTexture = previous', 'backgroundTexture = texture') },
  '未沿用上一帧纹理'))
counterExamples.push(run('C10 拆掉 draw() 的无纹理 guard', captureInvariants,
  { glassSwift: REAL.glassSwift.replace('guard backgroundTexture != nil else { return }', '') },
  'draw() 缺'))

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

console.log('='.repeat(92))
console.log('底部悬浮层启动/转场稳定性（Tab 栏 + 迷你播放器）')
console.log('='.repeat(92))
console.log('  ① 启动抽动      → safeAreaReady 门（两条栏 ready 之前不下发）')
console.log('  ② 切换画面闪一下 → 转场按住（消费侧形态：paused 走玻璃专用门 glassHomeCovered / glassCovered；live 只有 pagerDragging；窗口链路本体由 scripts/sim-glass-nav-hold.js 钉住）')
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
