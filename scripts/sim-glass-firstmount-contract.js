/**
 * 玻璃「首次挂载 / 重新入层级」提交门契约回归（LiquidGlassView.commitCapturedTexture）。
 *
 * 用户原话（2026-10-01）：
 *   「不论是首次进入软件，还是加载弹出迷你播放器栏和底部 tab 栏，都会显示一瞬间
 *     的黑边阴影，我怀疑是它的加载 bug」
 *
 * 本轮修复关掉 commitCapturedTexture 的两个残留窗口：
 *  ① 沿用上限是**帧数**（maxUniformHoldFrames = 4）：冷启动掉帧时 4 帧可能横跨几百 ms，
 *     与「backdrop 合成需要多久」没有对应关系；合成慢于 4 帧时第 5 帧就把整幅均匀黑
 *     无条件提交。修法：新增**墙钟**沉降窗口（captureSettleStartedAt +
 *     CACurrentMediaTime），窗口内均匀帧继续沿用；窗口本身最迟 captureSettleMaxHold
 *     关闭，但关闭后均匀帧仍走 maxUniformHoldFrames ≤ 4 的统一帧数上限——最坏
 *     ≈0.6s + 4 帧，不是「到点即接受」。
 *  ② 判据只挡「整幅均匀」：**半成品**帧（一半真实背景、一半黑条）是非均匀的
 *     → isUniform=false → 直接提交。修法：窗口内新增近黑格子占比判据
 *     （partialBlackValueThreshold / partialBlackRatioThreshold），深色外观下停用
 *     （isDarkAppearance 逃逸：深色外观下真实背景本来就接近黑，占比判据没有区分度）。
 *     占比阈值标定（2026-10-01 复核）：用户实测形态是「边缘一圈黑、中间正常」，
 *     最外 1 格厚的边环 = 2N+2M-4 格（16×16 ≈ 23.4%；最差实际网格 17×22 ≈ 19.8%），
 *     阈值必须低于该下限才接得住；0.35 会整类漏过 → 已下调为 0.18（A2 钉住上界）。
 *
 * 本脚本钉住：
 *   A1 沉降窗口是**墙钟口径**（不是帧数），且存在墙钟硬上限、上限被强制比较；
 *   A2 半成品判据存在（analyzeCapture 统计 + commitCapturedTexture 采信）、深色逃逸存在、
 *      占比阈值低于 1 格边环占比下限（「边缘一圈黑」的形态可被接住）；
 *   A3 三条窗口锚点齐全（backdrop 插入 / didMoveToWindow / beginLiveCapture），
 *      且 draw() 的「backgroundTexture == nil 则跳过本帧」guard 仍在；
 *   A4 放行出口唯一：非 hold 分支恰一处 backgroundTexture = texture，且不在 shouldHold
 *      分支内（删掉/挪进 hold 分支都必须被拦下——beginLiveCapture 已置 nil，出口缺失
 *      = 玻璃永久透明，正是本轮设计约束禁止的最坏形态）；
 *   A5 开窗点（beginCaptureSettleWindow）恰 4 处调用（三条锚点 + 暂停恢复复位，
 *      2026-10-02 第 16 轮第 1 条补上 handleResumeFromPause）、起点（captureSettleStartedAt）
 *      写入唯一：每帧路径再塞一处开窗/重置必须被拦下（否则窗口永不关闭、永久 hold）；
 *   B  既有事实未被改坏：自适应刷新率三常量（30/120/0.4）、采样基准锁定语义、
 *      均匀沿用修复（previous 非空条件不得再出现）、采景几何与 drawHierarchy 调用方式、
 *      透镜链路（liftUp → beginLiveCapture；「对透镜/收起圆钮同样生效」的前提是
 *      iOS 14~26.1 且 theme.liquidGlass 开（默认），26.2+ JS 已强制磨砂、透镜不渲染）；
 *      B7 采景节流（2026-10-02，用户第 5 条）：每实例最小采景间隔（常驻 30fps /
 *      实时会话 60fps），captureBackdrop 实际接入、首帧放行、按会话分档、回写时刻。
 *      注意这只压「采景」频率，rendering 自适应升/降档（B1）不动；
 *      B8 实时采景会话 + 暂停恢复复位（2026-10-02，用户第 2 条 / 第 9 条与中途追加）：
 *      两路会话标志分开记（liveCaptureRequested / realtimeCaptureRequested，会同时为真）、
 *      isLiveCaptureActive = 两者 OR（降档门控与采景分档的唯一判据）、
 *      setRealtimeCapture 幂等 + 会话起止都放行下一次采景 + 退会话避让透镜会话、
 *      handleResumeFromPause（丢旧纹理 / 清沿用痕迹 / 立刻采一次）与 setPaused 恢复路径；
 *   C  反例自检：任一条修复被拆掉一点，本脚本必须判不合格；替换未命中 = 失败
 *      （防止用例指向的代码被改名后脚本退化成永真）。
 *
 * 运行：node scripts/sim-glass-firstmount-contract.js
 *   （本机没有 node，真跑法用 %TEMP% 下的浏览器版迷你运行器（headless Edge/Chrome +
 *     python，不在仓库里）：
 *     python "C:\Users\Q\AppData\Local\Temp\lx-jsrun\run.py" scripts/sim-glass-firstmount-contract.js --brief）
 * 退出码：0 = 全部断言 + 全部反例通过；1 = 有任一项不合格。
 *
 * 声明：本脚本是**静态断言**（对源码文本做结构检查）。通过只代表源码形态符合约定，
 * 不代表能编译、更不代表真机观感 —— 本机没有 Xcode / Metal 工具链，Swift 侧无法验证。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const GLASS = 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassView.swift'
const LENS = 'ios/Vendor/LiquidGlassKit/Sources/LiquidLensView.swift'
const EFFECT = 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassEffectView.swift'

const REAL = { glass: read(GLASS), lens: read(LENS), effect: read(EFFECT) }

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 取一个函数定义体（签名后首个 `{` 起到配平 `}` 止）。被解析的函数里注释不能含花括号。 */
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

/** 取 Swift 常量数值：`name: Type = 1.5` 或 `name = 4`（Type 允许 UInt8 这类带数字的类型名）。 */
const swiftNumber = (src, name) => {
  const re = new RegExp(name + '(?:\\s*:\\s*[A-Za-z0-9]+)?\\s*=\\s*(-?\\d+(?:\\.\\d+)?)')
  const m = re.exec(src)
  return m ? Number(m[1]) : null
}

const countOf = (text, needle) => text.split(needle).length - 1

const COMMIT_RE = /private func commitCapturedTexture\([^)]*\)\s*\{/

// ---------------------------------------------------------------------------
// A1 沉降窗口：墙钟口径 + 墙钟硬上限（不是帧数）
// ---------------------------------------------------------------------------
const settleWindowInvariants = (f) => {
  const reasons = []
  const glass = f.glass

  if (!/captureSettleStartedAt\s*:\s*TimeInterval\s*=\s*0/.test(glass)) {
    reasons.push('缺 captureSettleStartedAt: TimeInterval 声明（沉降窗口没有墙钟起点）')
  }
  const dur = swiftNumber(glass, 'captureSettleDuration')
  const cap = swiftNumber(glass, 'captureSettleMaxHold')
  if (dur === null) {
    reasons.push('缺 captureSettleDuration 常量（半成品判据没有有效期）')
  } else if (!(dur > 0 && dur <= 1.0)) {
    reasons.push('captureSettleDuration=' + dur + ' 不在 (0, 1s] 内')
  }
  if (cap === null) {
    reasons.push('缺 captureSettleMaxHold 常量（沿用没有墙钟硬上限 → 可能永久透明/留住上一页）')
  } else {
    if (!(cap > 0)) reasons.push('captureSettleMaxHold=' + cap + ' ≤ 0，墙钟硬上限形同虚设')
    if (dur !== null && !(cap > dur)) reasons.push('captureSettleMaxHold ≤ captureSettleDuration，形态判据有效期失去意义')
    if (cap > 3.0) reasons.push('captureSettleMaxHold=' + cap + ' > 3s，玻璃可能长时间不出画面')
  }

  const beginBody = fnBody(glass, /private func beginCaptureSettleWindow\(\)\s*\{/)
  if (!beginBody || !/captureSettleStartedAt\s*=\s*CACurrentMediaTime\(\)/.test(beginBody)) {
    reasons.push('beginCaptureSettleWindow 未用 CACurrentMediaTime 记录开启时刻（墙钟口径缺失）')
  }

  const winBody = fnBody(glass, /private func isInsideCaptureSettleWindow\(_ now: TimeInterval, extended: Bool\) -> Bool\s*\{/)
  if (!winBody) {
    reasons.push('缺 isInsideCaptureSettleWindow（commit 无法按时间判定）')
  } else {
    if (!/now\s*-\s*captureSettleStartedAt\s*<\s*limit/.test(winBody)) {
      reasons.push('窗口判定没有用「当前墙钟 - 开启时刻 < limit」比较（帧数口径回来了？）')
    }
    if (!/extended \? Self\.captureSettleMaxHold : Self\.captureSettleDuration/.test(winBody)) {
      reasons.push('窗口判定没有区分「硬上限 / 形态判据有效期」两条时限（相当于没有上限）')
    }
    if (/consecutiveUniformFrames|maxUniformHoldFrames/.test(winBody)) {
      reasons.push('窗口判定里出现帧计数（沉降窗口必须是墙钟口径，不是帧数）')
    }
  }

  const commit = fnBody(glass, COMMIT_RE)
  if (!commit) {
    reasons.push('缺 commitCapturedTexture')
  } else {
    if (!/isInsideCaptureSettleWindow\(now, extended: true\)/.test(commit)) {
      reasons.push('均匀帧沿用没有并入墙钟沉降窗口（帧数上限漏掉的那几帧没有被接住）')
    }
    if (!/CACurrentMediaTime\(\)/.test(commit)) {
      reasons.push('commitCapturedTexture 未取当前墙钟（now 来源不明）')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// A2 半成品判据（近黑占比）+ 深色逃逸
// ---------------------------------------------------------------------------
const partialFrameInvariants = (f) => {
  const reasons = []
  const glass = f.glass

  const val = swiftNumber(glass, 'partialBlackValueThreshold')
  if (val === null) reasons.push('缺 partialBlackValueThreshold（「近黑」的像素阈值不存在）')
  else if (!(val > 0 && val < 64)) reasons.push('partialBlackValueThreshold=' + val + ' 超出 (0, 64)，判据会失去意义')
  const ratio = swiftNumber(glass, 'partialBlackRatioThreshold')
  if (ratio === null) reasons.push('缺 partialBlackRatioThreshold（近黑占比阈值不存在）')
  else if (!(ratio > 0 && ratio < 1)) reasons.push('partialBlackRatioThreshold=' + ratio + ' 不在 (0, 1) 内')
  // 占比阈值必须低到能接住「最外 1 格厚的边环」（用户实测形态：边缘一圈黑、中间正常）：
  // 边环格数 = NM-(N-2)(M-2) = 2N+2M-4，网格两轴格数 = ceil(dim/floor(dim/16))（sampleCapture），
  // 实际每轴 16~17，2x 机短条可到 22 行。最差实际网格 17×22 → 74/374 ≈ 0.1979；
  // 阈值 ≥ 该下限时「74 格 ≥ 阈值×374 格」为假 → 「一圈黑边」整类漏过（原 0.35 即如此）。
  const RING_FLOOR = 0.197
  if (ratio !== null && !(ratio < RING_FLOOR)) {
    reasons.push('partialBlackRatioThreshold=' + ratio + ' ≥ 1 格边环占比下限 ' + RING_FLOOR + '（「边缘一圈黑」的形态会被漏掉）')
  }

  const analyze = fnBody(glass, /private func analyzeCapture\(_ buffer: CVPixelBuffer, now: TimeInterval\) -> Bool\s*\{/)
  if (!analyze) {
    reasons.push('缺 analyzeCapture')
  } else {
    if (!/nearBlackCount/.test(analyze) || !/partialBlackValueThreshold/.test(analyze)) {
      reasons.push('analyzeCapture 未统计近黑格子数（半成品判据没有数据源）')
    }
    if (!/lastCaptureHadPartialBlack = Double\(nearBlackCount\) \/ Double\(grid\.count\) >= Self\.partialBlackRatioThreshold/.test(analyze)) {
      reasons.push('analyzeCapture 未按「近黑占比 ≥ partialBlackRatioThreshold」写入 lastCaptureHadPartialBlack')
    }
    // 帧间变化检测（自适应刷新率）必须仍在同一次扫描里，不许被顺手拆掉
    if (!/lastCaptureChangeAt = now/.test(analyze) || !/motionHoldDuration/.test(analyze)) {
      reasons.push('analyzeCapture 的帧间变化检测/降档逻辑被改坏（自适应刷新率依赖它）')
    }
  }

  const commit = fnBody(glass, COMMIT_RE)
  if (!commit) {
    reasons.push('缺 commitCapturedTexture')
  } else {
    if (!/if lastCaptureHadPartialBlack,/.test(commit)) {
      reasons.push('commitCapturedTexture 未采信半成品判据（半张没合成的黑条仍会被直接提交）')
    }
    if (!/isInsideCaptureSettleWindow\(now, extended: false\)/.test(commit)) {
      reasons.push('半成品判据没有限定在沉降窗口有效期内（窗外的暗色内容会被误挡）')
    }
    if (!/!isDarkAppearance/.test(commit)) {
      reasons.push('半成品判据没有深色逃逸（深色外观下真实暗背景会被误判成未就绪）')
    }
  }

  const dark = fnBody(glass, /private var isDarkAppearance: Bool\s*\{/)
  if (!dark || !/traitCollection\.userInterfaceStyle == \.dark/.test(dark)) {
    reasons.push('isDarkAppearance 未按 traitCollection.userInterfaceStyle == .dark 判定')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// A3 三条窗口锚点 + draw() 无纹理 guard
// ---------------------------------------------------------------------------
const anchorInvariants = (f) => {
  const reasons = []
  const glass = f.glass

  // 锚点①：backdropView 插入层级（14~26.1 合成源刚建立）
  if (!/superview\.insertSubview\(backdropView, belowSubview: self\)[\s\S]{0,400}?beginCaptureSettleWindow\(\)/.test(glass)) {
    reasons.push('captureBackdrop 的 backdropView 插入点未开沉降窗口（合成源刚建立的最初几帧没人挡）')
  }
  // 锚点②：进入窗口（26.2+ 根视图捕获路径唯一锚点）
  const didMove = fnBody(glass, /override func didMoveToWindow\(\)\s*\{/)
  if (!didMove || !/window != nil/.test(didMove) || !/beginCaptureSettleWindow\(\)/.test(didMove)) {
    reasons.push('didMoveToWindow 未在进入窗口时开沉降窗口（26.2+ 路径首帧没有保护）')
  }
  // 锚点③：抬起会话（透镜 / 收起圆钮）
  const liveBody = fnBody(glass, /func beginLiveCapture\(\)\s*\{/)
  if (!liveBody || !/beginCaptureSettleWindow\(\)/.test(liveBody)) {
    reasons.push('beginLiveCapture 未重开沉降窗口（透镜抬起/收起圆钮首帧没有保护）')
  }
  // draw()：无纹理则跳过本帧（沿用 nil ≠ 画黑）
  if (!/guard backgroundTexture != nil else \{ return \}/.test(glass)) {
    reasons.push('draw() 缺「无背景纹理则跳过本帧」的 guard（沿用 nil 会画成黑）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// A4 放行出口：非 hold 分支必须恰好一处把「当前帧」写入 backgroundTexture
// ---------------------------------------------------------------------------
// 为什么这是红线：beginLiveCapture 已把 backgroundTexture 置 nil，draw() 又对 nil
// 直接 return。如果非 hold 分支的放行赋值缺失，玻璃永远拿不到纹理 = 永久透明——
// 恰是本轮设计约束明令禁止的最坏形态（比黑边还糟）。此出口此前无任何断言覆盖，
// 删掉它 A/B/C1~C11 全绿，所以必须单独钉住，并配「删掉」「挪进 hold 分支」两个反例。
const releaseExitInvariants = (f) => {
  const reasons = []
  const commit = fnBody(f.glass, COMMIT_RE)
  if (!commit) {
    reasons.push('缺 commitCapturedTexture')
  } else {
    const holdAt = commit.indexOf('if shouldHold {')
    if (holdAt < 0) {
      reasons.push('commitCapturedTexture 缺 shouldHold 分支（沿用/放行两态无法区分）')
    } else {
      // 取 `if shouldHold { ... }` 块（配平花括号），把 hold 分支与非 hold 区段切开
      const openIdx = commit.indexOf('{', holdAt)
      let span = null
      let depth = 0
      for (let i = openIdx; i < commit.length; i++) {
        if (commit[i] === '{') depth++
        else if (commit[i] === '}') {
          depth--
          if (depth === 0) { span = { start: openIdx, end: i }; break }
        }
      }
      if (!span) {
        reasons.push('shouldHold 分支花括号不配平（放行出口位置无法确定）')
      } else {
        const holdBlock = commit.slice(span.start, span.end + 1)
        const nonHold = commit.slice(0, span.start) + commit.slice(span.end + 1)
        if (countOf(holdBlock, 'backgroundTexture = texture') !== 0) {
          reasons.push('commitCapturedTexture 的 shouldHold 分支内出现 backgroundTexture = texture（放行赋值被挪进 hold 分支 → 未就绪帧会被当成背景画出去）')
        }
        if (countOf(nonHold, 'backgroundTexture = texture') !== 1) {
          reasons.push('commitCapturedTexture 非 hold 分支的 backgroundTexture = texture 不是恰一处（放行出口缺失/重复 → beginLiveCapture 已置 nil、draw() guard 会跳过，玻璃可能永远拿不到纹理）')
        }
      }
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// A5 开窗点计数（恰 4 处调用）与起点写入唯一（只在 beginCaptureSettleWindow 内）
// ---------------------------------------------------------------------------
// 为什么：A3 只断言「三个锚点函数体里含 beginCaptureSettleWindow()」，不查调用总数。
// 若在 captureBackground / commitCapturedTexture / draw 等每帧路径里多加一处，
// 窗口就每帧重开、永不到点 → 均匀帧永远被 hold（永久挡住），而旧断言照样通过。
// 起点写入同理：只有 beginCaptureSettleWindow 能写 captureSettleStartedAt。
// 4 处的构成（缺一处都必须是失败）：
//   ① captureBackdrop 的 backdropView 插入点；② didMoveToWindow；③ beginLiveCapture；
//   ④ handleResumeFromPause（2026-10-02 第 16 轮第 1 条：暂停恢复 = 合成源刚建立，
//      漏开窗时 captureSettleStartedAt 还是上一次早已过期的值 → 半成品判据与墙钟沿用全失效，
//      切回底部栏的瞬间黑边就是这么漏出来的）。
const settleReopenInvariants = (f) => {
  const reasons = []
  const glass = f.glass

  // 定义行本身含 `beginCaptureSettleWindow()`，计数时先剔除（否则 4 次调用被数成 5）
  const defs = countOf(glass, 'func beginCaptureSettleWindow()')
  if (defs !== 1) {
    reasons.push('beginCaptureSettleWindow 定义不是恰一处（实际 ' + defs + '）')
  }
  const calls = countOf(glass, 'beginCaptureSettleWindow()') - defs
  if (calls !== 4) {
    reasons.push('beginCaptureSettleWindow() 调用不是恰 4 处（实际 ' + calls + '）——多一处（尤其每帧路径）= 窗口反复重开永不到点、均匀帧被永久挡住；少一处 = 某条路径首帧没人保护')
  }

  // 第 4 处必须在暂停恢复复位里（本轮修复本体）：只数总数会被「把某处的调用挪到别处」
  // 蒙混过去——总数不变，但恢复路径重新变成没人保护。
  const resumeBody = fnBody(glass, /func handleResumeFromPause\(\)\s*\{/)
  if (!resumeBody) {
    reasons.push('缺 handleResumeFromPause 函数体（暂停恢复复位的开窗点无法确定）')
  } else if (!/beginCaptureSettleWindow\(\)/.test(resumeBody)) {
    reasons.push('handleResumeFromPause 未开沉降窗口（暂停恢复 = 合成源刚建立，漏开窗时半成品判据与墙钟沿用全失效 → 切回底部栏瞬间闪黑边）')
  }

  const beginBody = fnBody(glass, /private func beginCaptureSettleWindow\(\)\s*\{/)
  if (!beginBody) {
    reasons.push('缺 beginCaptureSettleWindow 函数体')
  } else {
    const writesAll = countOf(glass, 'captureSettleStartedAt =')
    const writesInFn = countOf(beginBody, 'captureSettleStartedAt =')
    if (writesAll !== 1 || writesInFn !== 1) {
      reasons.push('captureSettleStartedAt 的写入点不唯一（全文件 ' + writesAll + ' 处、函数体内 ' + writesInFn + ' 处）——只允许在 beginCaptureSettleWindow 内写一次；写入点扩散 = 窗口可被任意路径（含每帧路径）随意重置')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// B 既有结构性事实（本轮改动不得改坏）
// ---------------------------------------------------------------------------
const existingStructureInvariants = (f) => {
  const reasons = []
  const glass = f.glass
  const lens = f.lens
  const effect = f.effect

  // B1 自适应刷新率三常量与升降档逻辑
  const idle = swiftNumber(glass, 'idleFramesPerSecond')
  const live = swiftNumber(glass, 'liveFramesPerSecond')
  const hold = swiftNumber(glass, 'motionHoldDuration')
  if (idle !== 30) reasons.push('idleFramesPerSecond 不再是 30（实际 ' + idle + '）')
  if (live !== 120) reasons.push('liveFramesPerSecond 不再是 120（实际 ' + live + '）')
  if (hold !== 0.4) reasons.push('motionHoldDuration 不再是 0.4（实际 ' + hold + '）')
  // liveCaptureRequested 不能只查「标识符是否出现」——它在声明/赋值/门控处共出现 4 次，
  // 随便留一处就能骗过裸检查（无区分力）。改钉三处载荷点：降档 guard 实际读该会话标志、
  // 以及抬起/落下两个赋值点。
  // 2026-10-02（用户第 9 条）：降档 guard 的判据从 liveCaptureRequested 扩成
  // isLiveCaptureActive（= 透镜会话 OR RN live 会话，见 B8）——横滑期间同样不许降档。
  if (!/preferredFramesPerSecond != Self\.liveFramesPerSecond/.test(glass) ||
      !/now - lastCaptureChangeAt > Self\.motionHoldDuration/.test(glass) ||
      !/if !isLiveCaptureActive,/.test(glass) ||
      !/liveCaptureRequested = true/.test(glass) ||
      !/liveCaptureRequested = false/.test(glass)) {
    reasons.push('自适应升降档逻辑被改坏（提档/降档/liveCaptureRequested 赋值/实时会话门控缺一）')
  }

  // B2 采样基准锁定语义（captureReferenceSize / captureBaseSize）
  if (!/var captureReferenceSize: CGSize\?/.test(glass)) reasons.push('缺 captureReferenceSize 属性')
  if (!/if let reference = captureReferenceSize, reference\.width > 1, reference\.height > 1/.test(glass)) {
    reasons.push('captureBaseSize 不再以 captureReferenceSize 为基准（透镜锁定语义被改坏）')
  }
  if (!/liquidGlassView\.captureReferenceSize = bounds\.size/.test(lens)) {
    reasons.push('透镜不再把 captureReferenceSize 锁成静止药丸尺寸')
  }

  // B3 均匀沿用修复未回退（previous 非空条件不得再出现；沿用赋值恰一处）
  const commit = fnBody(glass, COMMIT_RE)
  if (!commit) {
    reasons.push('缺 commitCapturedTexture')
  } else {
    if (countOf(commit, 'backgroundTexture = previous') !== 1) {
      reasons.push('commitCapturedTexture 里 backgroundTexture = previous 不是恰一处（多/少都会破坏沿用语义）')
    }
    if (!/if consecutiveUniformFrames <= Self\.maxUniformHoldFrames \{/.test(commit)) {
      reasons.push('均匀帧沿用的帧数上限保留条件缺失（真实均匀背景可能永远不显形）')
    }
    if (/if\s+let\s+previous\b/.test(commit) || /maxUniformHoldFrames[^\n]*,\s*let previous/.test(commit)) {
      reasons.push('均匀帧沿用又加回了 previous 非空条件（冷启动第一帧 previous 恒为 nil，等于没修）')
    }
  }
  const maxHold = swiftNumber(glass, 'maxUniformHoldFrames')
  if (maxHold !== 4) reasons.push('maxUniformHoldFrames 不再是 4（实际 ' + maxHold + '）')

  // B4 采景几何 / drawHierarchy 调用方式 / 缓冲同源 / 圆角钳制
  if (!/backdropView\.drawHierarchy\(in: backdropView\.bounds, afterScreenUpdates: false\)/.test(glass)) {
    reasons.push('captureBackdrop 的 drawHierarchy 调用方式被改动')
  }
  if (!/zeroCopyBridge\.setupBuffer\(width: width, height: height\)/.test(glass)) {
    reasons.push('layoutSubviews 的零拷贝缓冲尺寸设置被改动')
  }
  if (!/Float\(min\(layer\.cornerRadius, CGFloat\(maxGlassRadius\)\)\)/.test(glass)) {
    reasons.push('updateUniforms 的圆角钳制被改动')
  }
  // B6 原样保留的既有守卫：draw() 的无纹理 guard（沿用 nil 之所以安全的根据）
  if (!/guard backgroundTexture != nil else \{ return \}/.test(glass)) {
    reasons.push('draw() 缺「无背景纹理则跳过本帧」的 guard（既有守卫被拆掉）')
  }

  // B5 透镜链路：liftUp → beginLiveCapture（「本修复对透镜/收起圆钮同样生效」只成立于
  // iOS 14~26.1 且 theme.liquidGlass 开（默认）；26.2+ JS 已强制磨砂、透镜不渲染，
  // 该链路不会被触发——不要把它当成 26.2+ 路径的修复证据）
  if (!/addSubview\(liquidGlassView\)/.test(lens) || !/liquidGlassView\.beginLiveCapture\(\)/.test(lens)) {
    reasons.push('透镜抬起链路被改动（liftUp 不再 addSubview + beginLiveCapture）')
  }
  const liveBody = fnBody(glass, /func beginLiveCapture\(\)\s*\{/)
  if (!liveBody || !/liveCaptureRequested = true/.test(liveBody) || !/backgroundTexture = nil/.test(liveBody)) {
    reasons.push('beginLiveCapture 不再丢弃上一次会话的纹理/开启显式高刷')
  }

  // B7 采景节流（2026-10-02，用户第 5 条）：滑动时三块玻璃一起被 analyzeCapture 提到
  // 120fps，主线程同步的 drawHierarchy 合计 360 次/秒，与 pager 动画抢主线程。
  // 钉住：两个间隔常量存在且 live 档更高；captureBackdrop 真的接了节流；节流里
  // 首帧放行（backgroundTexture 为 nil 时不得拦）、按实时会话（isLiveCaptureActive，
  // 2026-10-02 起：透镜抬起 OR RN live）分档、且确实回写 lastCaptureAt
  //（不回写 = 第一帧后永远拦，玻璃冻结）。
  const capMin = swiftNumber(glass, 'captureMinInterval')
  const liveMin = swiftNumber(glass, 'liveCaptureMinInterval')
  if (capMin === null) {
    reasons.push('缺 captureMinInterval（滑动时三块玻璃各自逐帧采景，主线程被采满）')
  } else if (!(capMin > 0 && capMin <= 0.1)) {
    reasons.push('captureMinInterval=' + capMin + ' 不在 (0, 0.1s] 内（静止态基线档位异常）')
  }
  if (liveMin === null) {
    reasons.push('缺 liveCaptureMinInterval（透镜抬起/跟手的采景上限）')
  } else if (!(liveMin > 0 && liveMin <= 0.1)) {
    reasons.push('liveCaptureMinInterval=' + liveMin + ' 不在 (0, 0.1s] 内（显式高刷会话档位异常）')
  }
  if (capMin !== null && liveMin !== null && !(liveMin < capMin)) {
    reasons.push('liveCaptureMinInterval ≥ captureMinInterval（抬起/跟手会话应比常驻玻璃更跟手）')
  }
  if (!/if shouldThrottleCapture\(CACurrentMediaTime\(\)\) \{ return \}/.test(glass)) {
    reasons.push('captureBackdrop 未接采景节流（14~26.1 路径仍是逐帧采景，滑动掉帧会复发）')
  }
  const throttleBody = fnBody(glass, /private func shouldThrottleCapture\(_ now: TimeInterval\) -> Bool\s*\{/)
  if (!throttleBody) {
    reasons.push('缺 shouldThrottleCapture（采景节流只剩常量，没有判定）')
  } else {
    if (!/guard backgroundTexture != nil else \{ return false \}/.test(throttleBody)) {
      reasons.push('采景节流拦住了首帧（backgroundTexture 为 nil 时应放行，否则玻璃一直透明）')
    }
    if (!/isLiveCaptureActive \? Self\.liveCaptureMinInterval : Self\.captureMinInterval/.test(throttleBody)) {
      reasons.push('采景节流未按实时会话区分间隔（透镜抬起/横滑跟手被压到常驻档）')
    }
    if (!/lastCaptureAt = now/.test(throttleBody)) {
      reasons.push('采景节流未记录本次采景时刻（首帧之后永远拦，玻璃画面冻结）')
    }
  }

  // B8 RN 实时采景会话 + 暂停恢复复位（2026-10-02 用户第 2 条 / 第 9 条与中途追加）
  //
  // ① 两个会话标志必须分开记：横滑（RN `live` prop → realtimeCaptureRequested）与透镜
  //    抬起（liveCaptureRequested）**会同时为真**，合并成一个标志会让先结束的一方
  //    把另一方也关掉（横滑收尾把仍抬起的透镜压回 30fps：透镜跟手又变回一卡一卡）。
  // ② isLiveCaptureActive 是两者 OR —— 降档门控（B1 guard）与采景分档（B7）都只读它，
  //    收成单路就会漏掉另一路会话。
  // ③ 会话开始/结束都 lastCaptureAt = 0：开始那一刻若正卡在 30fps 节流窗口里，本次
  //    会话的第一帧真实内容要再等最多 33ms —— 那正是「滑动刚开始玻璃里还是旧位置的
  //    画面、然后猛地跳一下」（用户第 9 条「延迟很高」的起点）。
  // ④ 退会话只在「透镜也没抬起」时交回 idle（else if !liveCaptureRequested）。
  // ⑤ 暂停恢复复位（handleResumeFromPause）：暂停只是停 draw，CAMetalLayer 上仍留着
  //    暂停前那帧；不复位就会先把旧画面画出去（用户第 2 条「返回主界面时先闪一帧旧
  //    画面」）。复位 = 丢旧纹理 + 清沿用痕迹 + 立刻同步采一次 + 提档。
  if (!/private var realtimeCaptureRequested = false/.test(glass)) {
    reasons.push('缺 realtime 会话的独立开关（与透镜会话合并成一个标志会互相覆盖）')
  }
  if (!/private var isLiveCaptureActive: Bool \{ liveCaptureRequested \|\| realtimeCaptureRequested \}/.test(glass)) {
    reasons.push('isLiveCaptureActive 不再是两路会话的 OR（降档门控/采景分档会漏掉一路会话）')
  }
  const realtimeBody = fnBody(glass, /func setRealtimeCapture\(_ realtime: Bool\)\s*\{/)
  if (!realtimeBody) {
    reasons.push('缺 setRealtimeCapture（RN live prop 没有落点，横滑期间采景仍锁在常驻档）')
  } else {
    if (!/guard realtimeCaptureRequested != realtime else \{ return \}/.test(realtimeBody)) {
      reasons.push('setRealtimeCapture 没有幂等 guard（重复 set 会反复重置采景时刻与帧率）')
    }
    if (!/lastCaptureAt = 0/.test(realtimeBody)) {
      reasons.push('setRealtimeCapture 未放行下一次采景（会话首帧仍等满上一档节流窗口 → 滑动开头还是旧画面）')
    }
    if (!/preferredFramesPerSecond = Self\.liveFramesPerSecond/.test(realtimeBody)) {
      reasons.push('setRealtimeCapture 进会话时未提渲染帧率（玻璃跟不上手）')
    }
    if (!/else if !liveCaptureRequested \{/.test(realtimeBody)) {
      reasons.push('setRealtimeCapture 退会话时未避让透镜会话（横滑收尾会把仍抬起的透镜压回低刷）')
    }
  }
  const resumeBody = fnBody(glass, /func handleResumeFromPause\(\)\s*\{/)
  if (!resumeBody) {
    reasons.push('缺 handleResumeFromPause（暂停恢复后会把暂停前那一帧旧画面先画出去）')
  } else {
    if (!/backgroundTexture = nil/.test(resumeBody)) {
      reasons.push('handleResumeFromPause 未丢弃暂停前的旧纹理')
    }
    if (!/consecutiveUniformFrames = 0/.test(resumeBody) || !/lastCaptureGrid = nil/.test(resumeBody)) {
      reasons.push('handleResumeFromPause 未清沿用痕迹（均匀帧计数/变化检测基准）')
    }
    if (!/lastCaptureAt = 0/.test(resumeBody) || !/captureBackground\(\)/.test(resumeBody)) {
      reasons.push('handleResumeFromPause 未立刻同步采一次（恢复后第一帧仍是旧画面）')
    }
  }
  if (!/if !paused, liquidGlassView\?\.isPaused == true \{/.test(effect) ||
      !/liquidGlassView\?\.handleResumeFromPause\(\)/.test(effect)) {
    reasons.push('setPaused 恢复路径未接复位（暂停恢复时不会丢旧纹理/立刻采一次）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

const assertions = [
  { name: 'A1 沉降窗口：墙钟口径 + 墙钟硬上限（不是帧数）', hits: settleWindowInvariants(REAL) },
  { name: 'A2 半成品判据（近黑占比）+ 深色外观逃逸', hits: partialFrameInvariants(REAL) },
  { name: 'A3 三条窗口锚点 + draw() 无纹理 guard', hits: anchorInvariants(REAL) },
  { name: 'A4 放行出口：非 hold 分支恰一处 backgroundTexture = texture（不在 shouldHold 内）', hits: releaseExitInvariants(REAL) },
  { name: 'A5 开窗点恰 4 处调用（含暂停恢复）+ 起点写入唯一（beginCaptureSettleWindow 内）', hits: settleReopenInvariants(REAL) },
  { name: 'B 既有结构未改坏（刷新率/采样基准/均匀沿用/采景几何/透镜链路/采景节流/实时会话/暂停复位）', hits: existingStructureInvariants(REAL) },
]

// ---------------------------------------------------------------------------
// C 反例自检：每条修复拆掉一点都必须被拦下；替换未命中 = 失败
// ---------------------------------------------------------------------------

const tamperGlass = (from, to) => {
  const out = REAL.glass.replace(from, to)
  return { file: 'glass', text: out, miss: out === REAL.glass }
}
const tamperLens = (from, to) => {
  const out = REAL.lens.replace(from, to)
  return { file: 'lens', text: out, miss: out === REAL.lens }
}
const tamperEffect = (from, to) => {
  const out = REAL.effect.replace(from, to)
  return { file: 'effect', text: out, miss: out === REAL.effect }
}

const counterExamples = []
const CE = (name, invariantFn, mutation, expectSubstr) => {
  if (mutation.miss) {
    counterExamples.push({ name, ok: false, detail: '替换未命中（用例已失效，脚本本身要修）' })
    return
  }
  const files = { glass: REAL.glass, lens: REAL.lens, effect: REAL.effect }
  if (mutation.file === 'lens') files.lens = mutation.text
  else if (mutation.file === 'effect') files.effect = mutation.text
  else files.glass = mutation.text
  const reasons = invariantFn(files)
  const ok = reasons.some((r) => r.indexOf(expectSubstr) >= 0)
  counterExamples.push({ name, ok: !!ok, detail: reasons.join('；') || '（没有命中任何理由）' })
}

CE('C1 沉降窗口判定退回帧数口径', settleWindowInvariants, tamperGlass(
  'return now - captureSettleStartedAt < limit',
  'return consecutiveUniformFrames <= Self.maxUniformHoldFrames'
), '墙钟')

CE('C2 墙钟硬上限改成 0（等于没有上限）', settleWindowInvariants, tamperGlass(
  'captureSettleMaxHold: TimeInterval = 0.6',
  'captureSettleMaxHold: TimeInterval = 0'
), '硬上限')

CE('C3 判定不再区分两条时限（extended 失效）', settleWindowInvariants, tamperGlass(
  'let limit = extended ? Self.captureSettleMaxHold : Self.captureSettleDuration',
  'let limit = Self.captureSettleDuration'
), '两条时限')

CE('C4 analyzeCapture 不再统计近黑占比（半成品判据失去数据源）', partialFrameInvariants, tamperGlass(
  'lastCaptureHadPartialBlack = Double(nearBlackCount) / Double(grid.count) >= Self.partialBlackRatioThreshold',
  'lastCaptureHadPartialBlack = false'
), '近黑占比')

CE('C4b 占比阈值被调回「半张黑条」口径（「边缘一圈黑」的形态又会被漏掉）', partialFrameInvariants, tamperGlass(
  'partialBlackRatioThreshold: Double = 0.18',
  'partialBlackRatioThreshold: Double = 0.35'
), '边环占比下限')

CE('C5 commit 不再采信半成品判据', partialFrameInvariants, tamperGlass(
  'if lastCaptureHadPartialBlack,',
  'if false,'
), '半成品判据')

CE('C6 深色逃逸被拆掉（深色外观下暗背景会被误挡）', partialFrameInvariants, tamperGlass(
  '!isDarkAppearance {',
  'true {'
), '深色逃逸')

CE('C7 draw() 的无纹理 guard 被拆掉', anchorInvariants, tamperGlass(
  'guard backgroundTexture != nil else { return }',
  ''
), 'guard')

CE('C8 均匀沿用又加回 previous 非空条件（旧实现）', existingStructureInvariants, tamperGlass(
  'if consecutiveUniformFrames <= Self.maxUniformHoldFrames {',
  'if consecutiveUniformFrames <= Self.maxUniformHoldFrames, let previous {'
), 'previous 非空条件')

CE('C9 didMoveToWindow 锚点被拆掉（26.2+ 首帧没有保护）', anchorInvariants, tamperGlass(
  'super.didMoveToWindow()\n        if window != nil {\n            beginCaptureSettleWindow()\n        }',
  'super.didMoveToWindow()'
), 'didMoveToWindow')

CE('C10 透镜抬起链路不再接 beginLiveCapture', existingStructureInvariants, tamperLens(
  'liquidGlassView.beginLiveCapture()',
  'liquidGlassView.endLiveCapture()'
), '透镜抬起链路')

CE('C11 实时会话不再门控降档（透镜抬起/横滑跟手期间会被降回低刷）', existingStructureInvariants, tamperGlass(
  'if !isLiveCaptureActive,',
  'if true,'
), 'liveCaptureRequested')

// —— 2026-10-01 契约加固：放行出口 / 开窗计数 / 锚点①②③全覆盖（C12~C17）——

CE('C12 captureBackdrop 的锚点①被拆掉（backdrop 合成源刚建立的最初几帧没人挡）', anchorInvariants, tamperGlass(
  '            superview.insertSubview(backdropView, belowSubview: self)\n' +
  '            // 2026-10-01：backdrop 源刚进层级，render server 尚未合成它——重开墙钟\n' +
  '            // 沉降窗口（见 captureSettleDuration 与 commitCapturedTexture）。\n' +
  '            // 下面注释记录的「冷启动最初若干帧采到整幅均匀黑」就发生在这一刻之后。\n' +
  '            beginCaptureSettleWindow()',
  '            superview.insertSubview(backdropView, belowSubview: self)\n' +
  '            // 2026-10-01：backdrop 源刚进层级，render server 尚未合成它——重开墙钟\n' +
  '            // 沉降窗口（见 captureSettleDuration 与 commitCapturedTexture）。\n' +
  '            // 下面注释记录的「冷启动最初若干帧采到整幅均匀黑」就发生在这一刻之后。'
), '插入点')

CE('C13 beginLiveCapture 的锚点③被拆掉（透镜抬起/收起圆钮首帧没有保护）', anchorInvariants, tamperGlass(
  '        // 2026-10-01：抬起 = 新的采景会话（纹理已丢，重新开始）。重开沉降窗口：\n' +
  '        // 透镜/收起圆钮的上一帧（previous）此时恒为 nil，窗口内沿用 = 继续透明，\n' +
  '        // 等的是本次会话的第一帧可信背景，不会把上一次抬起/上一页的内容带进来\n' +
  '        //（旧内容已在上一行被丢弃）。\n' +
  '        beginCaptureSettleWindow()',
  '        // 2026-10-01：抬起 = 新的采景会话（纹理已丢，重新开始）。重开沉降窗口：\n' +
  '        // 透镜/收起圆钮的上一帧（previous）此时恒为 nil，窗口内沿用 = 继续透明，\n' +
  '        // 等的是本次会话的第一帧可信背景，不会把上一次抬起/上一页的内容带进来\n' +
  '        //（旧内容已在上一行被丢弃）。'
), 'beginLiveCapture 未重开')

CE('C14 非 hold 分支的放行赋值被删（beginLiveCapture 已置 nil → 玻璃永远拿不到纹理）', releaseExitInvariants, tamperGlass(
  '        if shouldHold {\n' +
  '            backgroundTexture = previous\n' +
  '            return\n' +
  '        }\n' +
  '        backgroundTexture = texture',
  '        if shouldHold {\n' +
  '            backgroundTexture = previous\n' +
  '            return\n' +
  '        }'
), '非 hold 分支')

CE('C15 放行赋值被挪进 shouldHold 分支（未就绪帧会被当成背景画出去）', releaseExitInvariants, tamperGlass(
  '        if shouldHold {\n' +
  '            backgroundTexture = previous\n' +
  '            return\n' +
  '        }\n' +
  '        backgroundTexture = texture',
  '        if shouldHold {\n' +
  '            backgroundTexture = previous\n' +
  '            backgroundTexture = texture\n' +
  '            return\n' +
  '        }'
), 'shouldHold 分支内')

CE('C16 每帧路径（captureBackground）里多加一处开窗（窗口每帧重开、永不关闭）', settleReopenInvariants, tamperGlass(
  '    func captureBackground() {',
  '    func captureBackground() {\n        beginCaptureSettleWindow()'
), '恰 4 处')

CE('C17 每帧路径（commitCapturedTexture）里多加一处起点写入（窗口每帧重置）', settleReopenInvariants, tamperGlass(
  '        let now = CACurrentMediaTime()\n        var shouldHold = false',
  '        captureSettleStartedAt = CACurrentMediaTime()\n        let now = CACurrentMediaTime()\n        var shouldHold = false'
), '写入点不唯一')

// —— 2026-10-02 契约加固：采景节流（C18~C18c）——

CE('C18 captureBackdrop 的采景节流被拆掉（滑动时每帧三块玻璃齐采、主线程被占满）', existingStructureInvariants, tamperGlass(
  '        if shouldThrottleCapture(CACurrentMediaTime()) { return }\n\n        let sizeCoefficient',
  '        let sizeCoefficient'
), '未接采景节流')

CE('C18b 采景节流不再区分实时会话（透镜抬起/横滑跟手被压到常驻档）', existingStructureInvariants, tamperGlass(
  '        let interval = isLiveCaptureActive ? Self.liveCaptureMinInterval : Self.captureMinInterval',
  '        let interval = Self.captureMinInterval'
), '未按实时会话区分间隔')

CE('C18c 采景节流不再回写时刻（首帧之后永远拦，玻璃画面冻结）', existingStructureInvariants, tamperGlass(
  '        if now - lastCaptureAt < interval { return true }\n        lastCaptureAt = now',
  '        if now - lastCaptureAt < interval { return true }'
), '未记录本次采景时刻')

// —— 2026-10-02 契约加固：RN 实时采景会话 + 暂停恢复复位（C19~C23）——

CE('C19 两路会话被合并成一个标志（isLiveCaptureActive 只看透镜会话，横滑不再进实时档）', existingStructureInvariants, tamperGlass(
  'private var isLiveCaptureActive: Bool { liveCaptureRequested || realtimeCaptureRequested }',
  'private var isLiveCaptureActive: Bool { liveCaptureRequested }'
), '两路会话的 OR')

CE('C20 会话开始不放行下一次采景（滑动开头玻璃里仍是旧位置的画面）', existingStructureInvariants, tamperGlass(
  '        lastCaptureAt = 0\n        consecutiveUniformFrames = 0\n        if realtime {',
  '        consecutiveUniformFrames = 0\n        if realtime {'
), '未放行下一次采景')

CE('C21 退会话不再避让透镜会话（横滑收尾把仍抬起的透镜压回低刷）', existingStructureInvariants, tamperGlass(
  '        } else if !liveCaptureRequested {',
  '        } else {'
), '未避让透镜会话')

CE('C22 暂停恢复不再复位（返回主界面时先把暂停前那帧旧画面画出去）', existingStructureInvariants, tamperEffect(
  '        if !paused, liquidGlassView?.isPaused == true {\n            liquidGlassView?.handleResumeFromPause()\n        }',
  '        if false {\n            liquidGlassView?.handleResumeFromPause()\n        }'
), 'setPaused 恢复路径未接复位')

CE('C23 恢复复位不再丢旧纹理（沿用分支仍能把暂停前那一帧画出来）', existingStructureInvariants, tamperGlass(
  '    func handleResumeFromPause() {\n        backgroundTexture = nil',
  '    func handleResumeFromPause() {\n        consecutiveUniformFrames = 0'
), '未丢弃暂停前的旧纹理')

// —— 2026-10-02 契约加固：第 16 轮第 1 条（暂停恢复补开窗，C24 / C24b）——

CE('C24 恢复路径的开窗被删（切回底部栏时半成品判据与墙钟沿用全失效 → 边缘闪黑边复发）', settleReopenInvariants, tamperGlass(
  '        beginCaptureSettleWindow()\n        captureBackground()',
  '        captureBackground()'
), 'handleResumeFromPause 未开沉降窗口')

{
  // 比 C24 更苛刻：把恢复路径的调用「挪」到别处，调用总数仍是 4 ——
  // 只数总数的旧断言会放行，新增的「第 4 处必须在 handleResumeFromPause 内」必须拦下。
  const dropped = REAL.glass.replace(
    '        beginCaptureSettleWindow()\n        captureBackground()',
    '        captureBackground()'
  )
  const moved = dropped.replace(
    '    func endLiveCapture() {',
    '    func endLiveCapture() {\n        beginCaptureSettleWindow()'
  )
  CE('C24b 恢复路径的开窗被挪到别处（总数仍是 4，恢复路径重新没人保护）', settleReopenInvariants,
    { file: 'glass', text: moved, miss: moved === REAL.glass || moved === dropped },
    'handleResumeFromPause 未开沉降窗口')
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

let failed = 0

console.log('='.repeat(92))
console.log('玻璃首次挂载/重新入层级提交门（LiquidGlassView.commitCapturedTexture，2026-10-01）')
console.log('='.repeat(92))
console.log('  A1 沉降窗口 = 墙钟口径（不是帧数）+ 墙钟硬上限（窗口关闭后均匀帧仍走 ≤4 帧的统一帧数上限，非到点即接受）')
console.log('  A2 半成品（近黑格子占比）判据 + 深色外观逃逸（阈值须低于 1 格边环下限）')
console.log('  A3 三条窗口锚点（backdrop 插入 / didMoveToWindow / beginLiveCapture）+ draw guard')
console.log('  A4 放行出口唯一：非 hold 分支恰一处 backgroundTexture = texture（缺 = 玻璃永久透明）')
console.log('  A5 开窗点恰 4 处（三条锚点 + 暂停恢复复位）+ 起点写入唯一（每帧路径不得开窗/重置）')
console.log('  B  既有事实未改坏（刷新率 30/120/0.4、采样基准锁定、均匀沿用修复、采景几何、透镜链路、实时会话、暂停复位）')
console.log('  B7 采景节流：每实例最小采景间隔（常驻 30fps / 实时 60fps），首帧放行、按会话分档（2026-10-02）')
console.log('  B8 实时采景会话（两路标志分开 + OR 判据 + 会话起止放行采景 + 退会话避让）+ 暂停恢复复位（2026-10-02）')
console.log('  C  反例自检：任一条修复拆掉一点都必须拦下（替换未命中 = 失败）')
console.log()
console.log('='.repeat(92))
console.log('断言')
console.log('='.repeat(92))
for (const a of assertions) {
  const ok = a.hits.length === 0
  if (!ok) failed++
  console.log('  ' + (ok ? '✅' : '❌') + '  ' + a.name)
  for (const h of a.hits) console.log('        ' + h)
}
console.log()
console.log('='.repeat(92))
console.log('反例自检（修复被拆掉时必须拦下）')
console.log('='.repeat(92))
for (const c of counterExamples) {
  if (!c.ok) failed++
  console.log('  ' + (c.ok ? '✅' : '❌') + '  ' + c.name + (c.ok ? ' —— 已拦下' : '   ← 没拦住：' + c.detail))
}

const passed = assertions.filter((a) => a.hits.length === 0).length
const caught = counterExamples.filter((c) => c.ok).length
console.log()
console.log('结果：断言 ' + passed + '/' + assertions.length + ' 通过；反例 ' + caught + '/' + counterExamples.length + ' 拦下')
process.exit(failed ? 1 : 0)
