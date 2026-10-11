/**
 * sim-glass-render-rate.js
 *
 * 「玻璃渲染降频 / 不可见侧停渲染 / 进度轮询前台门」契约不变量
 * （第 20 轮·耗电契约 ②，2026-10-02 提出、2026-10-03 落地）。
 *
 * 背景：常态液态玻璃（theme.liquidGlass 默认 **开**）在 Tab 栏与迷你播放条上常驻，
 * 引擎是「MTKView 连续渲染 + 每帧捕获背景」。逐层核对后有三处净浪费：
 *
 *   ① 常态玻璃按 60fps 连续渲染，而背景捕获有**全局 33ms（≈30Hz）节流**，shader 也
 *      没有任何随时间变化的 uniform —— 60fps 只是把同一张纹理重复画一遍：白白的
 *      GPU 开销 + 每帧唤醒 CPU。降到 30fps 与捕获节流同速，画面无可见差异。
 *   ② Tab 栏同时挂着**两块**玻璃（收起态圆钮 + 展开态整条栏），用透明度交叉淡入淡出。
 *      动画停稳后不可见的那一块仍在 60fps 连续渲染，并且会去抢全局 33ms 捕获配额
 *      （谁先到谁捕获），既耗电又让可见侧拿到更旧/更少的背景纹理。
 *   ③ src/plugins/player/hook.ts 的 useProgress 每秒 3 次原生桥往返 + setState，
 *      且**没有 App 前台门**（同文件的 useBufferProgress 与 playProgress.ts 都有）。
 *
 * 这三处都不会崩、也过得了 tsc/eslint（原生不参与 TS 检查；少一个门控只是"多耗电"），
 * 只能靠契约绑住。修复口径（本脚本绑住的东西）：
 *
 *   · LiquidGlassView.swift 渲染帧率只跟采景档，且**从源码常量算同速**：
 *     idleFramesPerSecond ≈ 1 / captureMinInterval（30fps ↔ 33.3ms）、
 *     liveFramesPerSecond ≈ 1 / liveCaptureMinInterval（60fps ↔ 16.7ms）；
 *   · 全类**唯一**的 preferredFramesPerSecond 赋值点在 syncRenderFrameRate 内，
 *     由 isLiveCaptureActive 在两个档位间选择；整个 Sources 目录不许有第二个文件
 *     碰这个属性（宿主视图绕不过档位模型）；
 *   · 原「背景一变化就升到 120fps、静默 0.4s 降回」的自适应升档**整段删除**：
 *     lastCaptureGrid / lastCaptureChangeAt / motionHoldDuration 不得再出现，
 *     analyzeCapture 内部不得再改渲染帧率；
 *   · 全部会话开关（init / beginLiveCapture / endLiveCapture / setRealtimeCapture /
 *     handleResumeFromPause）都走 syncRenderFrameRate —— 不会出现「标志已落、帧率还挂
 *     在旧档」的中间态；
 *   · shouldThrottleCapture 的采景间隔仍按 isLiveCaptureActive 选档（渲染档跟采景档，
 *     前提是采景档自己没被写死）；
 *   · Tab 栏两块玻璃各在「自己不可见」时 paused（展开态含 collapsed、收起态含
 *     !collapsed，并带 glassHomeCovered / navTransitioning / !appActive 全部门），
 *     迷你播放条玻璃接 glassCovered 等门；
 *     （第 52 轮第 2 条：门名由 homeCovered / screenCovered 换成玻璃专用门
 *      glassHomeCovered / glassCovered —— 账本门的反应晚于用户按下返回，
 *      返回动画期间透出的还是暂停前那一帧。完整链路见
 *      scripts/sim-glass-reveal-window.js，门本体见 scripts/sim-power-drain.js）
 *   · ③ 的前台门本体由 scripts/sim-progress-poll-foreground-gate.js 深查，
 *     本脚本只做交叉回归守卫（门与起表点还在）。
 *
 * 反例自检：通路重复/门被摘掉这类回归 tsc/eslint 完全无感。运行：
 * node scripts/sim-glass-render-rate.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const SWIFT = 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassView.swift'
const SWIFT_SOURCES_DIR = 'ios/Vendor/LiquidGlassKit/Sources'
const TAB_BAR = 'src/components/layout/ModernTabBar.tsx'
const PLAYER_BAR = 'src/components/player/PlayerBar/index.tsx'
const HOOK = 'src/plugins/player/hook.ts'

const REAL_SWIFT = read(SWIFT)
const REAL_TAB = read(TAB_BAR)
const REAL_PLAYER = read(PLAYER_BAR)
const REAL_HOOK = read(HOOK)

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 从源码抽出「以 signature 开头、后接大括号体」的函数体（按大括号配平）。 */
const extractBracedBody = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  const braceStart = src.indexOf('{', start + signature.length)
  if (braceStart < 0) return null
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 不变量 A：渲染帧率 = 采景档（LiquidGlassView.swift）
// ---------------------------------------------------------------------------

const swiftInvariants = (rawFile) => {
  const reasons = []
  // 结构化判断跑在去注释源码上：长注释里的 preferredFramesPerSecond / analyzeCapture
  // / 120fps 字样不参与计数（本文件的历史说明很多）。
  const code = stripComments(rawFile)

  // ① 唯一赋值点：整个文件（去注释后）preferredFramesPerSecond 恰好 1 处，且在
  //    syncRenderFrameRate 内、由 isLiveCaptureActive 在 live/idle 间选择。
  const fpsMentions = code.match(/preferredFramesPerSecond/g) ?? []
  if (fpsMentions.length !== 1) {
    reasons.push(`渲染帧率赋值点未收敛（preferredFramesPerSecond 出现 ${fpsMentions.length} 处，应恰好 1 处、在 syncRenderFrameRate 内）`)
  }
  const syncBody = extractBracedBody(code, 'private func syncRenderFrameRate()')
  if (!syncBody) {
    reasons.push('渲染帧率赋值点未收敛（syncRenderFrameRate 不存在）')
  } else {
    const ternary = 'preferredFramesPerSecond = isLiveCaptureActive ? Self.liveFramesPerSecond : Self.idleFramesPerSecond'
    if (!syncBody.includes(ternary)) {
      reasons.push('渲染帧率赋值点未收敛（syncRenderFrameRate 须由 isLiveCaptureActive 在 live/idle 两档间选择）')
    }
  }

  // ② 静止 / 实时档与采景间隔同速 —— 从源码常量算（不写死 30/60，常量改了也自洽）。
  const grab = (re, label) => {
    const m = code.match(re)
    if (!m) {
      reasons.push(`${label}缺失（同速模型的前提，先修脚本锚点）`)
      return null
    }
    return parseFloat(m[1])
  }
  const idleFps = grab(/private static let idleFramesPerSecond = (\d+)/, '静止档帧率常量 idleFramesPerSecond')
  const liveFps = grab(/private static let liveFramesPerSecond = (\d+)/, '实时档帧率常量 liveFramesPerSecond')
  const idleInterval = grab(/private static let captureMinInterval: TimeInterval = ([\d.]+)/, '静止档采景间隔 captureMinInterval')
  const liveInterval = grab(/private static let liveCaptureMinInterval: TimeInterval = ([\d.]+)/, '实时档采景间隔 liveCaptureMinInterval')
  if (idleFps != null && idleInterval != null && Math.abs(idleFps - 1 / idleInterval) > 1) {
    reasons.push(`静止档帧率与采景节流不同速（idle=${idleFps}fps，captureMinInterval=${idleInterval}s ≈ ${(1 / idleInterval).toFixed(1)}Hz）`)
  }
  if (liveFps != null && liveInterval != null && Math.abs(liveFps - 1 / liveInterval) > 1) {
    reasons.push(`实时档帧率与采景间隔不同速（live=${liveFps}fps，liveCaptureMinInterval=${liveInterval}s ≈ ${(1 / liveInterval).toFixed(1)}Hz）`)
  }

  // ③ 自适应升档整段删除
  for (const sym of ['lastCaptureGrid', 'lastCaptureChangeAt', 'motionHoldDuration']) {
    if (code.includes(sym)) {
      reasons.push(`自适应升档残留（${sym} 仍在 —— 背景一变化就升档的路径没删干净）`)
    }
  }
  const analyzeBody = extractBracedBody(
    code,
    'private func analyzeCapture(_ buffer: CVPixelBuffer, now: TimeInterval) -> Bool',
  )
  if (!analyzeBody) {
    reasons.push('自适应升档残留（analyzeCapture 抽取失败，锚点漂移）')
  } else if (analyzeBody.includes('preferredFramesPerSecond')) {
    reasons.push('自适应升档残留（analyzeCapture 内部仍在改渲染帧率）')
  }

  // ④ 全部会话开关都走 syncRenderFrameRate
  const switches = [
    ['init(_ liquidGlass: LiquidGlass)', 'init'],
    ['func beginLiveCapture()', 'beginLiveCapture'],
    ['func endLiveCapture()', 'endLiveCapture'],
    ['func setRealtimeCapture(_ realtime: Bool)', 'setRealtimeCapture'],
    ['func handleResumeFromPause()', 'handleResumeFromPause'],
  ]
  const missing = []
  for (const [sig, label] of switches) {
    const body = extractBracedBody(code, sig)
    if (!body || !body.includes('syncRenderFrameRate()')) missing.push(label)
  }
  if (missing.length > 0) {
    reasons.push(`会话切换未同步渲染档（${missing.join(' / ')} 未调用 syncRenderFrameRate）`)
  }

  // ⑤ 采景间隔仍按实时档选（渲染档跟采景档，前提是采景档自己没被写死）
  const throttleBody = extractBracedBody(code, 'private func shouldThrottleCapture(_ now: TimeInterval) -> Bool')
  if (!throttleBody || !throttleBody.includes('isLiveCaptureActive ? Self.liveCaptureMinInterval : Self.captureMinInterval')) {
    reasons.push('采景节流未按实时档放宽（shouldThrottleCapture 的间隔选择丢失，渲染档与采景档会脱钩）')
  }

  return reasons
}

/** 目录级：Sources 里除 LiquidGlassView.swift 外，不许第二个文件碰 preferredFramesPerSecond。 */
// 注意：本仓脚本跑在浏览器迷你运行器里，readdirSync(dir, { withFileTypes: true }) 的
// entry.isDirectory() 有闭包缺陷（全部沿用最后一次迭代的值，实测会把文件当目录去
// scandir → `ENOENT: scandir '/src/app.ts'`）。一律 readdirSync + statSync 判断目录
// （同 scripts/sim-tap-lock-responder.js 的处理）。
const listSwiftFiles = (relDir) => {
  const out = []
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(ROOT, rel))) {
      const childRel = `${rel}/${name}`
      if (name.endsWith('.swift')) {
        out.push(childRel)
      } else if (fs.statSync(path.join(ROOT, childRel)).isDirectory()) {
        walk(childRel)
      }
    }
  }
  walk(relDir)
  return out
}

const swiftDirInvariants = () => {
  const reasons = []
  for (const file of listSwiftFiles(SWIFT_SOURCES_DIR)) {
    if (file.endsWith('LiquidGlassView.swift')) continue
    if (stripComments(read(file)).includes('preferredFramesPerSecond')) {
      reasons.push(`渲染帧率赋值点未收敛（${file} 也碰 preferredFramesPerSecond —— 宿主视图绕过了档位模型）`)
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B/C：不可见侧停渲染（Tab 栏两块玻璃 / 迷你播放条一块）
// ---------------------------------------------------------------------------

const tabBarInvariants = (src) => {
  const reasons = []
  // 展开态玻璃：收起时（collapsed）不可见；收起态玻璃：展开时（!collapsed）不可见。
  // 两条 paused 串都必须整串在场（含 glassHomeCovered / navTransitioning / !appActive）。
  // 第 52 轮第 2 条起门名是 glassHomeCovered（= useHomeCovered ∧ 不在返回露出窗口内）：
  // 账面门要等 screenPopped 才翻，返回动画期间玻璃还在暂停态、透过的还是暂停前那一帧。
  const expandedPaused = 'paused={glassHomeCovered || collapsed || navTransitioning || !appActive}'
  const pillPaused = 'paused={glassHomeCovered || !collapsed || navTransitioning || !appActive}'
  if (!src.includes(expandedPaused) || !src.includes(pillPaused)) {
    reasons.push('不可见侧未停渲染（Tab 栏两块玻璃的 paused 门缺失：展开态须含 collapsed、收起态须含 !collapsed，并带 glassHomeCovered / navTransitioning / !appActive）')
  }
  const liveCount = (src.match(/live=\{pagerDragging\}/g) ?? []).length
  if (liveCount !== 2) {
    reasons.push(`横滑实时档未接（live={pagerDragging} 出现 ${liveCount} 处，两块玻璃都应接）`)
  }
  return reasons
}

const playerBarInvariants = (src) => {
  const reasons = []
  if (!src.includes('paused={glassCovered || navTransitioning || !appActive}')) {
    reasons.push('迷你播放条玻璃未接省电门（paused 须含 glassCovered / navTransitioning / !appActive）')
  }
  if (!src.includes('live={pagerDragging}')) {
    reasons.push('迷你播放条玻璃未接横滑实时档（live={pagerDragging}）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：③ 的交叉回归守卫（前台门本体见 sim-progress-poll-foreground-gate）
// ---------------------------------------------------------------------------

const hookInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)
  if (!code.includes('if (!isActive()) return')) {
    reasons.push('进度轮询前台门缺失（useProgress 的 !isActive() 守卫被摘掉）')
  }
  const itv = (code.match(/setInterval\(getProgress/g) ?? []).length
  if (itv !== 1) {
    reasons.push(`进度轮询起表点未收敛（setInterval(getProgress 出现 ${itv} 处，应为 1）`)
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

  // s1 静止档抬回 60fps（与 33ms 采景节流脱钩）→ 报「不同速」
  check('s1 静止档抬回 60fps', () => swiftInvariants(tamper(REAL_SWIFT,
    'private static let idleFramesPerSecond = 30',
    'private static let idleFramesPerSecond = 60')), '静止档帧率与采景节流不同速')

  // s2 实时档抬回 120fps → 报「不同速」
  check('s2 实时档抬回 120fps', () => swiftInvariants(tamper(REAL_SWIFT,
    'private static let liveFramesPerSecond = 60',
    'private static let liveFramesPerSecond = 120')), '实时档帧率与采景间隔不同速')

  // s3 在 analyzeCapture 里重新升档（旧的「背景一变化就升档」回归）→ 报「赋值点未收敛」
  check('s3 analyzeCapture 里重新升档', () => swiftInvariants(tamper(REAL_SWIFT,
    '        reanchorCaptureSettleWindowIfNeeded(now)\n        let (grid, columns) = Self.sampleCapture(buffer)',
    '        reanchorCaptureSettleWindowIfNeeded(now)\n        preferredFramesPerSecond = Self.liveFramesPerSecond\n        let (grid, columns) = Self.sampleCapture(buffer)')),
  '渲染帧率赋值点未收敛')

  // s4 透镜落下不同步档位（帧率挂在 60fps 档不放）→ 报「会话切换未同步渲染档」
  check('s4 endLiveCapture 落下不同步档位', () => swiftInvariants(tamper(REAL_SWIFT,
    '        liveCaptureRequested = false\n        syncRenderFrameRate()',
    '        liveCaptureRequested = false')), '会话切换未同步渲染档')

  // s5 变化检测基准残留 → 报「自适应升档残留」
  check('s5 变化检测基准残留', () => swiftInvariants(tamper(REAL_SWIFT,
    '        reanchorCaptureSettleWindowIfNeeded(now)',
    '        reanchorCaptureSettleWindowIfNeeded(now)\n        lastCaptureGrid = []')), '自适应升档残留')

  // s6 采景节流写死静止档（渲染档与采景档脱钩）→ 报「采景节流未按实时档放宽」
  check('s6 采景节流写死静止档', () => swiftInvariants(tamper(REAL_SWIFT,
    'let interval = isLiveCaptureActive ? Self.liveCaptureMinInterval : Self.captureMinInterval',
    'let interval = Self.captureMinInterval')), '采景节流未按实时档放宽')

  // t1 展开态玻璃摘掉 collapsed 门 → 报「不可见侧未停渲染」
  check('t1 展开态玻璃摘掉 collapsed 门', () => tabBarInvariants(tamper(REAL_TAB,
    'paused={glassHomeCovered || collapsed || navTransitioning || !appActive}',
    'paused={glassHomeCovered || navTransitioning || !appActive}')), '不可见侧未停渲染')

  // t2 收起态玻璃摘掉 !collapsed 门 → 报「不可见侧未停渲染」
  check('t2 收起态玻璃摘掉 !collapsed 门', () => tabBarInvariants(tamper(REAL_TAB,
    'paused={glassHomeCovered || !collapsed || navTransitioning || !appActive}',
    'paused={glassHomeCovered || navTransitioning || !appActive}')), '不可见侧未停渲染')

  // t3 迷你播放条玻璃摘掉省电门 → 报「未接省电门」
  check('t3 迷你播放条玻璃摘掉省电门', () => playerBarInvariants(tamper(REAL_PLAYER,
    'paused={glassCovered || navTransitioning || !appActive}',
    'paused={false}')), '迷你播放条玻璃未接省电门')

  // h1 进度轮询前台门被摘（交叉回归）→ 报「进度轮询前台门缺失」
  check('h1 进度轮询前台门被摘', () => hookInvariants(tamper(REAL_HOOK,
    'if (!isActive()) return',
    'if (false) return')), '进度轮询前台门缺失')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-glass-render-rate ===')

const checks = [
  ['渲染帧率 = 采景档（LiquidGlassView.swift）', () => swiftInvariants(REAL_SWIFT)],
  ['赋值点唯一（Sources 目录无第二个文件碰帧率）', () => swiftDirInvariants()],
  ['不可见侧停渲染（Tab 栏两块玻璃）', () => tabBarInvariants(REAL_TAB)],
  ['不可见侧停渲染（迷你播放条）', () => playerBarInvariants(REAL_PLAYER)],
  ['进度轮询前台门（交叉回归）', () => hookInvariants(REAL_HOOK)],
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
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.ok ? '已拦下' : `未拦下（reasons=${JSON.stringify(r.detail)}）`}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
