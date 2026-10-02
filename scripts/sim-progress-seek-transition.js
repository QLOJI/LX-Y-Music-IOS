#!/usr/bin/env node
/**
 * sim-progress-seek-transition.js —— 播放详情页进度条位置驱动守卫
 *
 * 对齐上游 ProgressBar.vue / usePlayProgress 的行为，并按用户第 12 轮第 1 条收窄：
 * - 播放 tick（4Hz timeupdate 等价物）直接落位，无过渡（上游直接改 scaleX，无 transition）
 * - 仅当「用户主动 seek（拖动松手 / 点击进度条 / 点歌词 / 远程命令）造成的 >2s 跳变」时，
 *   对这一次变更挂 200ms 标准曲线（cubic-bezier(.22,1,.36,1)；上游为 --duration-fast: 180ms
 *   × --ease-standard，本工程按统一动效档 designMotion.quick(200ms) 有意偏离）过渡滑到目标
 * - ≤2s 的短跳（含短 seek）上游同样直接落位，不动画
 * - 【2026-10-02 新增】非用户 seek 的大跳（退后台再回前台、重新进入播放详情页、切歌归零）
 *   一律**瞬时落位**：此前这些场景也挂 200ms 过渡，用户看到的就是「切回来时进度条先播一段
 *   进度增长的动画，太慢了，要实时显示当前进度」。判定靠 global.app_event.setProgress
 *   打的一次性标记（实现里的 seekArmedRef）。
 *
 * 注意：本脚本是自建模型、不读源码，`SEEK_MS` 必须与
 * src/components/player/progressCore.tsx 的 SEEK_TRANSITION_MS（= designMotion.quick）
 * 手工保持同步，否则契约与实现会静默脱钩。
 *
 * 区分力反例（每一版都必须留下让「上一版实现」被判不合格的反例）：
 * - x1/x2：2026-10-01 之前的老模型（setProgress 事件 800ms 过渡窗 + 窗外 250ms 线性补间）
 *   在普通 tick 上走 250ms 补间（与断言 1 冲突）、在 ≤2s 短 seek 上也挂 200ms 过渡
 *   （与断言 3 冲突）；
 * - x3：2026-10-01 版模型（任何 >2s 跳变都挂 200ms，不区分是不是用户 seek）在后台恢复 /
 *   切歌归零上也挂过渡（与断言 4 / 断言 6 冲突）——那正是用户第 12 轮第 1 条报的 bug。
 */
'use strict'

let nowMs = 0

const SEEK_JUMP_SEC = 2
const SEEK_MS = 200
const EASE = 'bezier(.22,1,.36,1)'

/** 1:1 复刻新版 progressCore.useSmoothProgressAnim 的动画参数选择（含 seekArmed 标记） */
function createAnim() {
  let prev = null
  let seekArmed = false
  const moves = []
  return {
    moves,
    /** 等价 global.app_event.setProgress：用户 seek 的唯一入口 */
    onSetProgress() { seekArmed = true },
    onProgress(target, durationSec) {
      target = Math.min(1, Math.max(0, target))
      if (prev != null && Math.abs(target - prev) < 0.0001) return
      const deltaSec = prev == null ? 0 : Math.abs(target - prev) * durationSec
      prev = target
      const isJump = deltaSec > SEEK_JUMP_SEC
      // 标记只在「这一次跳变真的用掉它」时消费；跳变之外不动它
      const isSeek = isJump && seekArmed
      if (isJump) seekArmed = false
      moves.push({
        at: nowMs,
        duration: isSeek ? SEEK_MS : 0,
        ease: isSeek ? EASE : 'none',
        kind: isSeek ? 'seek' : (isJump ? 'jump' : 'tick'),
      })
    },
  }
}

/** 上一版（2026-10-01）模型：任何 >2s 跳变都挂 200ms，不区分是不是用户 seek */
function createPriorJumpAnim() {
  let prev = null
  const moves = []
  return {
    moves,
    onProgress(target, durationSec) {
      target = Math.min(1, Math.max(0, target))
      if (prev != null && Math.abs(target - prev) < 0.0001) return
      const deltaSec = prev == null ? 0 : Math.abs(target - prev) * durationSec
      prev = target
      const isJump = deltaSec > SEEK_JUMP_SEC
      moves.push({ at: nowMs, duration: isJump ? SEEK_MS : 0, ease: isJump ? EASE : 'none' })
    },
  }
}

/** 更早的模型：setProgress 事件标记 800ms 过渡窗，窗内 200ms ease-out、窗外 250ms 线性 */
function createLegacyAnim() {
  let windowUntil = 0
  const moves = []
  return {
    moves,
    onSetProgress() { windowUntil = nowMs + 800 },
    onProgress(target) {
      void target
      const inWindow = nowMs < windowUntil
      moves.push({ at: nowMs, duration: inWindow ? 200 : 250, ease: inWindow ? 'out-cubic' : 'linear' })
    },
  }
}

let passCount = 0
let failCount = 0
function check(name, fn) {
  try {
    fn()
    passCount++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failCount++
    console.log(`  FAIL  ${name}\n        ${err.message}`)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

const DUR = 300 // 歌曲时长 300s（进度 0.01 = 3s）

console.log('sim-progress-seek-transition：进度条位置驱动（tick 直接落位 + 仅用户 seek 的 >2s 跳变挂 200ms 过渡）\n')

// -- 新模型行为 --
const a1 = createAnim()
nowMs = 0; a1.onProgress(0.10, DUR) // 起始锚定
nowMs = 250; a1.onProgress(0.1008, DUR) // 播放 tick：Δ≈0.24s
nowMs = 500; a1.onProgress(0.1016, DUR)
nowMs = 750; a1.onProgress(0.1024, DUR)

check('1 播放 tick（Δ<2s）直接落位（duration 0、无过渡）', () => {
  const ticks = a1.moves.filter(m => m.at >= 250)
  assert(ticks.length === 3, `tick 数=${ticks.length} 应=3`)
  for (const m of ticks) {
    assert(m.duration === 0, `t=${m.at} duration=${m.duration} 应=0`)
    assert(m.ease === 'none', `t=${m.at} ease=${m.ease}`)
  }
})

const a2 = createAnim()
nowMs = 1000; a2.onProgress(0.10, DUR)
nowMs = 1250; a2.onSetProgress() // 用户拖动松手 seek
nowMs = 1300; a2.onProgress(0.44, DUR) // Δprogress 0.34 × 300s ≈ 102s > 2s
check('2 用户 seek 的 >2s 跳变挂 200ms 标准曲线过渡', () => {
  const m = a2.moves[a2.moves.length - 1]
  assert(m.duration === 200, `duration=${m.duration} 应=200（designMotion.quick；上游 --duration-fast 为 180）`)
  assert(m.ease === EASE, `ease=${m.ease} 应=${EASE}（上游 --ease-standard）`)
})

const a3 = createAnim()
nowMs = 2000; a3.onProgress(0.20, DUR)
nowMs = 2250; a3.onSetProgress(); a3.onProgress(0.1967, DUR) // 短快退 1s：Δ≈1s ≤ 2s
nowMs = 2500; a3.onProgress(0.2, DUR) // 短快进回原位
check('3 短跳 ≤2s（含短 seek）直接落位，不动画（对齐上游 watch 阈值）', () => {
  const shorts = a3.moves.filter(m => m.at >= 2250)
  for (const m of shorts) {
    assert(m.duration === 0, `t=${m.at} duration=${m.duration} 应=0`)
  }
})

const a4 = createAnim()
nowMs = 3000; a4.onProgress(0.30, DUR)
nowMs = 30000; a4.onProgress(0.40, DUR) // 后台恢复：位置已前进 30s > 2s（用户第 12 轮第 1 条）
check('4 后台恢复大跳瞬时落位（不再挂 200ms 过渡，用户第 12 轮第 1 条）', () => {
  const m = a4.moves[a4.moves.length - 1]
  assert(m.duration === 0 && m.ease === 'none', `应瞬时落位，实际 ${JSON.stringify(m)}`)
  assert(m.kind === 'jump', `应被识别为非 seek 的跳变，实际 kind=${m.kind}`)
})

const a5 = createAnim()
nowMs = 4000; a5.onProgress(0.10, 0) // duration 未就绪
nowMs = 4250; a5.onProgress(0.90, 0) // 即使 progress 大变
check('5 时长未就绪（duration=0）永不过渡，一律直接落位', () => {
  for (const m of a5.moves) {
    assert(m.duration === 0, `t=${m.at} duration=${m.duration} 应=0`)
  }
})

const a6 = createAnim()
nowMs = 5000; a6.onProgress(0.50, DUR)
nowMs = 5250; a6.onProgress(0.001, DUR) // 切歌归零：Δ≈150s > 2s
check('6 切歌归零瞬时落位（不再挂 200ms 过渡，用户第 12 轮第 1 条）', () => {
  const m = a6.moves[a6.moves.length - 1]
  assert(m.duration === 0 && m.ease === 'none', `应瞬时落位，实际 ${JSON.stringify(m)}`)
})

const a7 = createAnim()
nowMs = 6000; a7.onProgress(0.20, DUR)
nowMs = 6250; a7.onProgress(0.20, DUR) // 重渲染但值未变
nowMs = 6500; a7.onProgress(0.20, DUR)
check('7 相同 progress 的重渲染不重启动画（无桥往返）', () => {
  assert(a7.moves.length === 1, `moves=${a7.moves.length} 应=1（只有首次锚定）`)
})

const a8 = createAnim()
nowMs = 7000; a8.onProgress(0.10, DUR)
nowMs = 7250; a8.onSetProgress() // 用户 seek
nowMs = 7300; a8.onProgress(0.1016, DUR) // 引擎真正落位前先来了一个普通 tick
nowMs = 7400; a8.onProgress(0.60, DUR) // seek 真正落地：Δ≈150s > 2s
check('8 seek 标记不被中间普通 tick 吃掉：真正的落位仍走 200ms 过渡', () => {
  const mid = a8.moves.find(m => m.at === 7300)
  const landing = a8.moves[a8.moves.length - 1]
  assert(mid && mid.duration === 0, `中间 tick 应直接落位，实际 ${JSON.stringify(mid)}`)
  assert(landing.duration === 200 && landing.ease === EASE, `落位应挂过渡，实际 ${JSON.stringify(landing)}`)
})

console.log('\n[反例] 旧模型的区分力')

const prior = createLegacyAnim()
nowMs = 0; prior.onProgress(0.10, DUR)
nowMs = 250; prior.onProgress(0.1008, DUR) // 普通播放 tick
check('x1 老模型普通 tick 走 250ms 线性补间（与断言 1 冲突，证明脚本可捕获回归）', () => {
  const m = prior.moves[prior.moves.length - 1]
  assert(m.duration === 250 && m.ease === 'linear', `老模型 ${JSON.stringify(m)}（若不等则脚本无区分力）`)
})
const prior2 = createLegacyAnim()
nowMs = 1000; prior2.onProgress(0.20, DUR)
nowMs = 1100; prior2.onSetProgress() // 1s 短 seek（≤2s，上游不动画）
nowMs = 1200; prior2.onProgress(0.1967, DUR)
check('x2 老模型对 ≤2s 短 seek 也挂 200ms 过渡（与断言 3 冲突，超上游语义）', () => {
  const m = prior2.moves[prior2.moves.length - 1]
  assert(m.duration === 200 && m.ease === 'out-cubic', `老模型 ${JSON.stringify(m)}（若不等则脚本无区分力）`)
})

const priorJump = createPriorJumpAnim()
nowMs = 1300; priorJump.onProgress(0.30, DUR)
nowMs = 13300; priorJump.onProgress(0.40, DUR) // 后台恢复大跳（非用户 seek）
check('x3 上一版模型对后台恢复大跳也挂 200ms 过渡（与断言 4 冲突 = 用户第 12 轮第 1 条报的 bug）', () => {
  const m = priorJump.moves[priorJump.moves.length - 1]
  assert(m.duration === 200 && m.ease === EASE, `上一版模型 ${JSON.stringify(m)}（若不等则脚本无区分力）`)
})
const priorJump2 = createPriorJumpAnim()
nowMs = 14000; priorJump2.onProgress(0.50, DUR)
nowMs = 14250; priorJump2.onProgress(0.001, DUR) // 切歌归零（非用户 seek）
check('x4 上一版模型对切歌归零也挂 200ms 过渡（与断言 6 冲突 = 用户第 12 轮第 1 条报的 bug）', () => {
  const m = priorJump2.moves[priorJump2.moves.length - 1]
  assert(m.duration === 200 && m.ease === EASE, `上一版模型 ${JSON.stringify(m)}（若不等则脚本无区分力）`)
})

console.log(`\n结果：${passCount} 过 / ${failCount} 败`)
process.exit(failCount ? 1 : 0)
