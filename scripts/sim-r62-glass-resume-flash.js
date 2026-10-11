/**
 * sim-r62-glass-resume-flash.js
 *
 * 「返回动画收尾时底部玻璃闪一下（像在刷新画面）」契约不变量
 * （第 62 轮第 1 条，2026-10-11）。
 *
 * 需求原话：
 *   「1、底部tab栏和迷你播放器栏透过的画面固定了，但是在点击左上角返回按钮、右滑返回主界面的
 *     最后一瞬间，会出现短暂的闪一下（应该是在刷新画面），只会出现一次，然后移动位置后，
 *     又会出现一次，请改为不要闪。」
 *
 * 根因（LiquidGlassView.swift）：
 *   第 61 轮把转场整段按住（paused）之后，转场期间**没有任何一次采景被接受**——
 *   `lastCommitAcceptedAt`（上一次「被接受」的采景时刻）还停在 push 之前写下的值。
 *   转场收尾恢复时：
 *     · 沿用手上的画面需要「不算太旧」，阈值是 maxStaleHoldAge = 0.15s；
 *     · `now - lastCommitAcceptedAt` 早已远超 0.15s ⇒ 沿用门刚开就被陈旧度门当场翻掉；
 *     · 于是恢复第一帧的**可疑采景**（合成源刚建立那一下：分类为均匀 / 带近黑条带）被直接
 *       画出去 —— 用户看到的「闪一下」，随后真实内容到达又换一次（「然后移动位置后，
 *       又会出现一次」）。
 *
 * 本轮口径：
 *   ① `handleResumeFromPause()` 里**重新锚定** lastCommitAcceptedAt 到恢复时刻
 *      （此刻手上挂着的画面内容就是当下这一页，语义上没有说谎），再叠一个
 *      `resumeQuietUntil = resumeNow + resumeQuietDuration`；
 *   ② `commitCapturedTexture()` 里加一条**不看启发式**的静默窗：窗内（120ms）一律不换画面
 *      （`!shouldHold, !geometryGrew, now < resumeQuietUntil, backgroundTexture != nil,
 *      previous != nil` ⇒ shouldHold = true），放在陈旧度门**之前**求值；
 *   ③ 数值关系：resumeQuietDuration(0.12) < maxStaleHoldAge(0.15) —— 静默窗不能长过陈旧度门，
 *      否则「不闪」会变成「旧画面挂太久」；
 *   ④ 采景矩形刚变大（geometryGrew）时不参与静默窗：那条路径手上是旧尺寸纹理，多挂一帧
 *      都是让新长出来的区域拉旧图（第 56 轮那条结构性沿用只挂一帧）；
 *   ⑤ 冷启动（previous == nil）语义逐字不变：沿用等于保持透明，静默窗也要求 previous != nil。
 *
 * 为什么必须靠契约脚本：这几处全是「顺序 + 阈值关系 + 一个不变量条件」，删掉静默窗、
 * 把重锚定挪走、把窗口调长、把 stale 门删掉，Swift 侧没有任何单元测试会红
 * （本工程没有 Xcode），真机上就是「还是闪」或「旧画面挂住不走」。带反例自检。
 *
 * 运行：node scripts/sim-r62-glass-resume-flash.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const SWIFT = 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassView.swift'
const REAL_SWIFT = read(SWIFT)

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

const numConst = (code, name) => {
  const m = new RegExp(`${name}\\s*:\\s*TimeInterval\\s*=\\s*([0-9.]+)`).exec(code)
  return m ? Number(m[1]) : null
}

// ---------------------------------------------------------------------------
// 不变量：恢复静默窗 + 重锚定 + 陈旧度门次序
// ---------------------------------------------------------------------------

const resumeFlashInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // —— ① 两个成员必须存在，且窗口时长只在声明处出现 ——
  if (!code.includes('private var resumeQuietUntil: TimeInterval = 0')) {
    reasons.push('缺 resumeQuietUntil 成员（恢复静默窗没有账本）')
  }
  const quietWrites = (code.match(/resumeQuietUntil =/g) ?? []).length
  if (quietWrites !== 1) {
    reasons.push(`resumeQuietUntil 的赋值点没有收敛（出现 ${quietWrites} 处，应恰好 1 处、在 handleResumeFromPause 内）`)
  }
  const quietDuration = numConst(code, 'resumeQuietDuration')
  const maxStale = numConst(code, 'maxStaleHoldAge')
  if (quietDuration == null) {
    reasons.push('缺 resumeQuietDuration 常量（静默窗长度没有唯一出处）')
  }
  if (maxStale == null) {
    reasons.push('maxStaleHoldAge 常量缺失（陈旧度门的上限没了）')
  }
  if (quietDuration != null && quietDuration <= 0) {
    reasons.push('resumeQuietDuration 不是正数（静默窗等于没有）')
  }
  if (quietDuration != null && maxStale != null && quietDuration >= maxStale) {
    reasons.push(`resumeQuietDuration(${quietDuration}) 不小于 maxStaleHoldAge(${maxStale}) —— 静默窗不得长过陈旧度门，否则「不闪」变成「旧画面挂太久」`)
  }

  // —— ② 恢复路径：重锚定 + 开窗，且都在首次采景之前 ——
  const resumeBody = extractBracedBody(code, 'func handleResumeFromPause()')
  if (resumeBody == null) {
    reasons.push('handleResumeFromPause 缺失（恢复路径没有入口）')
  } else {
    if (!resumeBody.includes('lastCommitAcceptedAt = resumeNow')) {
      reasons.push('恢复时没有重新锚定 lastCommitAcceptedAt（陈旧度门会把沿用当场翻掉 ⇒ 可疑采景被画出去 = 闪一下）')
    }
    if (!resumeBody.includes('resumeQuietUntil = resumeNow + Self.resumeQuietDuration')) {
      reasons.push('恢复时没有开静默窗（resumeQuietUntil = resumeNow + Self.resumeQuietDuration）')
    }
    const anchorAt = resumeBody.indexOf('let resumeNow = CACurrentMediaTime()')
    const reanchorAt = resumeBody.indexOf('lastCommitAcceptedAt = resumeNow')
    const armAt = resumeBody.indexOf('resumeQuietUntil = resumeNow + Self.resumeQuietDuration')
    const settleAt = resumeBody.indexOf('beginCaptureSettleWindow()')
    const captureAt = resumeBody.indexOf('captureBackground()')
    if (anchorAt < 0) {
      reasons.push('恢复路径没有取恢复时刻（let resumeNow = CACurrentMediaTime()）')
    }
    if (anchorAt >= 0 && reanchorAt >= 0 && anchorAt > reanchorAt) {
      reasons.push('重锚定先于取时刻（拿不到 resumeNow）')
    }
    if (reanchorAt >= 0 && armAt >= 0 && reanchorAt > armAt) {
      reasons.push('静默窗先于重锚定（语义应相同，但顺序要固定：先锚点再开窗）')
    }
    if (armAt >= 0 && settleAt >= 0 && armAt > settleAt) {
      reasons.push('静默窗开在沉降窗口之后（首次采景已经出去了，窗口盖不住那一下）')
    }
    if (settleAt >= 0 && captureAt >= 0 && settleAt > captureAt) {
      reasons.push('沉降窗口开在 captureBackground 之后（这一帧采景不在窗口覆盖内）')
    }
  }

  // —— ③ 提交路径：静默窗在陈旧度门之前，且没有旁路陈旧度门 ——
  const commitBody = extractBracedBody(code, 'private func commitCapturedTexture(_ texture: MTLTexture?, previous: MTLTexture?, isUniform: Bool)')
  if (commitBody == null) {
    reasons.push('commitCapturedTexture 缺失（采景提交点没了）')
  } else {
    const quietAt = commitBody.indexOf('now < resumeQuietUntil')
    if (quietAt < 0) {
      reasons.push('提交路径没有第 62 轮的静默窗（now < resumeQuietUntil）')
    } else if (!/if !shouldHold, !geometryGrew, now < resumeQuietUntil, backgroundTexture != nil, previous != nil \{/.test(commitBody)) {
      // 五项缺一不可：!shouldHold（别重复走） / !geometryGrew（尺寸刚变大不参与） /
      // now < resumeQuietUntil（窗内） / backgroundTexture != nil & previous != nil
      //（手上已有纹理 —— 冷启动那种「沿用 = 保持透明」不受影响，第 16/19 轮语义）
      reasons.push('静默窗条件不完整（!shouldHold / !geometryGrew / now < resumeQuietUntil / backgroundTexture != nil / previous != nil 五项缺一不可）')
    }
    const staleAt = commitBody.indexOf('now - lastCommitAcceptedAt > Self.maxStaleHoldAge')
    if (staleAt < 0) {
      reasons.push('陈旧度门缺失（沿用的画面可以无限旧，第 56 轮回归）')
    } else if (!commitBody.includes('shouldHold = false')) {
      reasons.push('陈旧度门没有把沿用翻掉（shouldHold = false）')
    }
    if (quietAt >= 0 && staleAt >= 0 && quietAt > staleAt) {
      reasons.push('静默窗落在陈旧度门之后（陈旧度门仍有最终否决权的口径被改写）')
    }
    if (staleAt >= 0 && !/now - lastCommitAcceptedAt > Self\.maxStaleHoldAge \{\s*\n\s*shouldHold = false/.test(commitBody)) {
      reasons.push('陈旧度门后面不是「把沿用翻掉」（否决权失效）')
    }
    if (!commitBody.includes('backgroundTexture = texture\n        lastCommitAcceptedAt = now')) {
      reasons.push('接受路径没有更新 lastCommitAcceptedAt（下一次比较的基准永远停在旧值）')
    }
    if (!commitBody.includes('backgroundTexture = previous')) {
      reasons.push('沿用路径没有把上一帧挂回背景（沿用等于没做）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------

const runCounterExamples = () => {
  const results = []
  const ce = (name, detail, ok, reasons) => results.push({
    name,
    detail: ok ? detail : `${detail}；reasons=${JSON.stringify(reasons ?? [])}`,
    ok: !!ok,
  })
  const src = REAL_SWIFT

  // c1 恢复时不重新锚定（本 bug 的第 62 轮形态）
  const c1 = src.replace('        lastCommitAcceptedAt = resumeNow\n', '')
  ce('c1 恢复时不重锚定', '陈旧度门当场翻掉沿用 → 可疑采景画出去',
    c1 !== src && resumeFlashInvariants(c1).some((r) => r.includes('重新锚定')))

  // c2 摘掉静默窗
  const c2 = src.replace(
    '        if !shouldHold, !geometryGrew, now < resumeQuietUntil, backgroundTexture != nil, previous != nil {\n            shouldHold = true\n        }\n',
    '',
  )
  {
    const rs = c2 === src ? ['（tamper 没打上）'] : resumeFlashInvariants(c2)
    ce('c2 摘掉静默窗', '恢复瞬间的可疑采景照样画出去', c2 !== src && rs.some((r) => r.includes('静默窗')), rs)
  }

  // c3 静默窗挪到陈旧度门之后（陈旧度门失去最终否决权）
  const c3 = src.replace(
    '        if !shouldHold, !geometryGrew, now < resumeQuietUntil, backgroundTexture != nil, previous != nil {\n            shouldHold = true\n        }\n',
    '',
  ).replace(
    '        if shouldHold, backgroundTexture != nil, now - lastCommitAcceptedAt > Self.maxStaleHoldAge {\n            shouldHold = false\n        }\n',
    '        if shouldHold, backgroundTexture != nil, now - lastCommitAcceptedAt > Self.maxStaleHoldAge {\n            shouldHold = false\n        }\n        if !shouldHold, !geometryGrew, now < resumeQuietUntil, backgroundTexture != nil, previous != nil {\n            shouldHold = true\n        }\n',
  )
  {
    const rs = c3 === src ? ['（tamper 没打上）'] : resumeFlashInvariants(c3)
    ce('c3 静默窗挪到陈旧度门之后', '陈旧度门失去最终否决权',
      c3 !== src && rs.some((r) => r.includes('陈旧度门之后')), rs)
  }

  // c4 静默窗不看 geometryGrew（尺寸刚变大时多拉 120ms 旧图）
  const c4 = src.replace(
    'if !shouldHold, !geometryGrew, now < resumeQuietUntil, backgroundTexture != nil, previous != nil {',
    'if !shouldHold, now < resumeQuietUntil, backgroundTexture != nil, previous != nil {',
  )
  {
    const rs = c4 === src ? ['（tamper 没打上）'] : resumeFlashInvariants(c4)
    ce('c4 静默窗不看 geometryGrew', '新长出来的区域多拉 120ms 旧图',
      c4 !== src && rs.some((r) => r.includes('静默窗')), rs)
  }

  // c5 静默窗长过陈旧度门（0.12 → 0.30）
  const c5 = src.replace('private static let resumeQuietDuration: TimeInterval = 0.12', 'private static let resumeQuietDuration: TimeInterval = 0.30')
  ce('c5 静默窗长过陈旧度门', '旧画面挂太久，「不闪」变成「不动」',
    c5 !== src && resumeFlashInvariants(c5).some((r) => r.includes('不小于 maxStaleHoldAge')))

  // c6 恢复时只重锚定、不开窗
  const c6 = src.replace('        resumeQuietUntil = resumeNow + Self.resumeQuietDuration\n', '')
  ce('c6 恢复时不开静默窗', '启发式猜漏一次用户就看到一次闪',
    c6 !== src && resumeFlashInvariants(c6).some((r) => r.includes('没有开静默窗')))

  // c7 陈旧度门删掉（沿用的画面可以无限旧）
  const c7 = src.replace(
    '        if shouldHold, backgroundTexture != nil, now - lastCommitAcceptedAt > Self.maxStaleHoldAge {\n            shouldHold = false\n        }\n',
    '',
  )
  ce('c7 删掉陈旧度门', '旧页面内容会整段留在玻璃里（第 56 轮回归）',
    c7 !== src && resumeFlashInvariants(c7).some((r) => r.includes('陈旧度门缺失')))

  // c8 静默窗丢条件（冷启动保持透明的语义被改写）
  const c8 = src.replace(
    'now < resumeQuietUntil, backgroundTexture != nil, previous != nil {',
    'now < resumeQuietUntil {',
  )
  {
    const rs = c8 === src ? ['（tamper 没打上）'] : resumeFlashInvariants(c8)
    ce('c8 静默窗丢「手上已有纹理」条件', '冷启动那一下被挂住（第 16/19 轮语义被改写）',
      c8 !== src && rs.some((r) => r.includes('条件不完整')), rs)
  }

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-r62-glass-resume-flash ===')

const checks = [
  ['恢复重锚定 + 静默窗 + 陈旧度门次序（LiquidGlassView.swift）', () => resumeFlashInvariants(REAL_SWIFT)],
]

let invOk = true
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    console.log(`\n[${name}]\n  PASS`)
  } else {
    invOk = false
    console.log(`\n[${name}]`)
    reasons.forEach((r) => console.log('  FAIL ' + r))
  }
}

console.log('\n[反例自检]')
const ceResults = runCounterExamples()
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.ok ? '已拦下' : `未拦下（${r.detail}）`}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
