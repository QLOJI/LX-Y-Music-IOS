/**
 * sim-elapsed-clamp.js
 *
 * 「已播时间不得超过总时长」契约（需求 3：歌曲实际加载/播放时间不能超过最后进度条时间）。
 *
 * 缺陷链（三处叠加，缺一不可复现）：
 *   ① 4Hz 原生位置快路径发布的是**歌词时钟外推值**：
 *      AppDelegate 的 position = anchorElapsed + (now − anchorSystem) × rate，
 *      原生侧只有 MAX(0, …) 下限，**没有** duration 上限；
 *      缓冲抖动 / 变速 / 歌曲尾部时它会短暂越过总时长。
 *   ② 慢路径（每秒 getPosition 校准）也会把外推值原样 setNowPlayTime。
 *   ③ 显示层：进度条比例有 clamp01 兜底（不会冲出容器），但左侧**时间文字**取的是
 *      未钳制的秒数 → 显示成「04:12 / 04:05」——用户报的就是这个样子。
 *
 * 修法（本批）：
 *   - `setNowPlayTime` 成为唯一收口：`maxPlayTime > 0 && time > maxPlayTime` 时钳到 maxPlayTime；
 *   - `setProgress` 同一条不变量（歌词末行时间本就可能超出元数据时长）；
 *   - 4Hz 快路径补 `if (!position) return`（切歌/重载瞬间外推出 0 会把已播时间打成 0:00）。
 *
 * 本脚本 A 部分 1:1 复刻 formatPlayTime2 / clamp01 / 两条路径的赋值序列，逐条验证显示值；
 * B 部分为源码不变量（含 4Hz 守卫的**顺序**要求：`!position` 必须放在 seek 窗口记账之后，
 * 否则「seek 到 0:00」这条路径的窗口永远清不掉 —— 这是本批自查时真的踩过一次的坑）。
 *
 * 运行：node scripts/sim-elapsed-clamp.js
 * 退出码：不变量全过且反例全被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  action: 'src/store/player/action.ts',
  progress: 'src/core/init/player/playProgress.ts',
}
const REAL = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, read(v)]))

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

// ---------------------------------------------------------------------------
// A. 数值模型：复刻显示链路
// ---------------------------------------------------------------------------

/** 复刻 src/utils/common.ts:47 的 numFix */
const numFix = (n) => (n < 10 ? `0${n}` : String(n))
/** 复刻 src/utils/common.ts:72 的 formatPlayTime2 */
const formatPlayTime2 = (time) => `${numFix(Math.trunc(time / 60))}:${numFix(Math.trunc(time % 60))}`
/** 复刻 src/utils/tools.ts:658 的 clamp01 */
const clamp01 = (v) => (!Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v)

/** 复刻 setNowPlayTime 的赋值序列（clamped = 是否启用本批的钳制） */
const setNowPlayTime = ({ time, maxPlayTime, clamped }) => {
  let t = time
  if (clamped && maxPlayTime > 0 && t > maxPlayTime) t = maxPlayTime
  return {
    nowPlayTime: t,
    nowPlayTimeStr: formatPlayTime2(t),
    progress: maxPlayTime ? clamp01(t / maxPlayTime) : 0,
    maxPlayTimeStr: formatPlayTime2(maxPlayTime),
  }
}

/** 复刻 setProgress 的赋值序列 */
const setProgress = ({ currentTime, totalTime, clamped }) => {
  let t = currentTime
  if (clamped && totalTime > 0 && t > totalTime) t = totalTime
  return { nowPlayTime: t, nowPlayTimeStr: formatPlayTime2(t), progress: totalTime ? clamp01(t / totalTime) : 0 }
}

console.log('sim-elapsed-clamp：已播时间不得超过总时长\n')
console.log('--- A. 数值模型（显示链路） ---')

// 外推时钟越过总时长的真实波形：245s 的歌曲，尾部/抖动时外推越过（原生只有下限没有上限）
const DURATION = 245
const RUNAWAY = [243.7, 244.6, 245.4, 246.9, 245.1, 244.9]

{
  // 断言 1（缺陷复现）：不钳制时，时间文字会超过右侧总时长文字。
  // ⚠️ 判据必须看**显示字符串**的最大值，不能看「第一个越过总时长的样本」：
  // formatPlayTime2 是 Math.trunc，越过 0.4s 时显示仍是 04:05（看不出来），
  // 只有越过 1s 才变成 04:06 —— 用户报的「4:12 / 4:05」正是这种「秒数进位」的样子。
  const over = RUNAWAY.map((p) => setNowPlayTime({ time: p, maxPlayTime: DURATION, clamped: false }))
  const maxStr = over.map((r) => r.nowPlayTimeStr).sort().pop()
  check('旧行为：外推值越过总时长 → 显示文字大于总时长文字（缺陷存在）',
    maxStr > formatPlayTime2(DURATION),
    `最大显示 ${maxStr} / ${formatPlayTime2(DURATION)}（原始秒数 ${Math.max(...RUNAWAY)}）`)
}

{
  // 断言 2（修复验证，断言 1 的反例）：钳制后逐帧都不越过，且比例恰好在 [0,1]
  const fixed = RUNAWAY.map((p) => setNowPlayTime({ time: p, maxPlayTime: DURATION, clamped: true }))
  const ok = fixed.every((r) =>
    r.nowPlayTime <= DURATION &&
    r.nowPlayTimeStr <= formatPlayTime2(DURATION) &&
    r.progress >= 0 && r.progress <= 1)
  const maxStr = fixed.map((r) => r.nowPlayTimeStr).sort().pop()
  check('修复后：逐帧 nowPlayTime ≤ 总时长、文字不超过总时长文字、比例 ∈ [0,1]',
    ok, `最大显示 ${maxStr} / ${formatPlayTime2(DURATION)}`)
}

{
  // 断言 3：钳到恰好 maxPlayTime **不得**破坏播完判定（判定式是 `>= maxPlayTime`，等号仍成立）
  const r = setNowPlayTime({ time: 300, maxPlayTime: DURATION, clamped: true })
  const endReached = r.nowPlayTime >= DURATION
  check('钳到恰好总时长后 `>= 总时长` 仍成立（播完判定不被钳制破坏）',
    r.nowPlayTime === DURATION && endReached, `nowPlayTime=${r.nowPlayTime}, 播完=${endReached}`)
}

{
  // 断言 4：切歌瞬间 maxPlayTime 尚未就绪（0）时**不得**钳制，否则真实位置会被压成 0:00
  const during = setNowPlayTime({ time: 37.2, maxPlayTime: 0, clamped: true })
  check('总时长未就绪（0）时不钳制（否则切歌瞬间已播时间被压成 0:00）',
    during.nowPlayTime === 37.2 && during.progress === 0,
    `nowPlayTime=${during.nowPlayTime}（应为 37.2），比例=${during.progress}`)
}

{
  // 断言 5：歌词末行时间超出元数据时长（LRC 尾部空白行常见）经 setProgress 也要收口
  const r = setProgress({ currentTime: 251.3, totalTime: DURATION, clamped: true })
  const raw = setProgress({ currentTime: 251.3, totalTime: DURATION, clamped: false })
  check('setProgress 同样收口（歌词末行时间可能超出元数据时长）',
    r.nowPlayTime === DURATION && raw.nowPlayTime === 251.3,
    `钳后 ${r.nowPlayTimeStr}=${r.nowPlayTime}s / 未钳 ${raw.nowPlayTimeStr}=${raw.nowPlayTime}s`)
}

{
  // 断言 6：`setProgress(0,0)`（切歌重置）不受影响
  const r = setProgress({ currentTime: 0, totalTime: 0, clamped: true })
  check('setProgress(0, 0)（切歌重置）不被钳制影响', r.nowPlayTime === 0 && r.progress === 0, `nowPlayTime=${r.nowPlayTime}`)
}

// ---------------------------------------------------------------------------
// B. 源码不变量
// ---------------------------------------------------------------------------

/** 取一个对象方法的函数体（从 `\n  name(...` 到第一个列对齐的 `\n  },`） */
const methodBody = (src, name) => {
  const start = src.indexOf(`\n  ${name}(`)
  if (start < 0) return null
  const end = src.indexOf('\n  },', start)
  return end < 0 ? null : src.slice(start, end)
}

/**
 * 全部源码不变量，对 REAL 的**当前内容**求值。
 * 反例把篡改后的源码换进 REAL 再跑同一套函数，因此这里每次都重新 stripComments(REAL.*)。
 */
function runSourceInvariants() {
  const action = stripComments(REAL.action)
  const progress = stripComments(REAL.progress)
  const out = []
  const add = (n, ok, detail = '') => out.push({ name: n, ok, detail })

  // 1. setNowPlayTime：钳制必须出现在**写入之前**（写在写入之后等于没钳）
  {
    const body = methodBody(action, 'setNowPlayTime')
    const clampIdx = body == null ? -1 : body.indexOf('time = state.progress.maxPlayTime')
    const guardIdx = body == null ? -1 : body.indexOf('if (state.progress.maxPlayTime > 0 && time > state.progress.maxPlayTime)')
    const writeIdx = body == null ? -1 : body.indexOf('state.progress.nowPlayTime = time')
    const strIdx = body == null ? -1 : body.indexOf('formatPlayTime2(time)')
    add('invariant 1: setNowPlayTime 在写入 nowPlayTime / 时间文字之前钳制',
      body != null && guardIdx >= 0 && clampIdx > guardIdx && writeIdx > clampIdx && strIdx > clampIdx,
      body == null ? '未找到方法体' : `守卫@${guardIdx} 钳制@${clampIdx} 写入@${writeIdx} 文字@${strIdx}`)
  }

  // 2. 比例仍有 clamp01 兜底（除数 maxPlayTime 为 0 时取 0，避免 NaN）
  {
    const body = methodBody(action, 'setNowPlayTime')
    add('invariant 2: setNowPlayTime 的比例仍 clamp01 兜底（÷0 时取 0，不产生 NaN）',
      body != null && /state\.progress\.progress = state\.progress\.maxPlayTime \? clamp01\(time \/ state\.progress\.maxPlayTime\) : 0/.test(body))
  }

  // 3. setProgress 同一条不变量（歌词末行时间可能超出元数据时长），且同样在写入之前
  {
    const body = methodBody(action, 'setProgress')
    const clampIdx = body == null ? -1 : body.indexOf('currentTime = totalTime')
    const writeIdx = body == null ? -1 : body.indexOf('state.progress.nowPlayTime = currentTime')
    add('invariant 3: setProgress 在写入前钳制（totalTime 为 0 时不钳）',
      body != null && /if \(totalTime > 0 && currentTime > totalTime\) currentTime = totalTime/.test(body) &&
      clampIdx >= 0 && writeIdx > clampIdx,
      body == null ? '未找到方法体' : `钳制@${clampIdx} 写入@${writeIdx}`)
  }

  // 4. 4Hz 快路径必须有 `!position` 守卫（切歌瞬间外推出 0 不得发布）
  {
    const i = progress.indexOf('onPlayerPosition((position, rate) =>')
    const fast = i < 0 ? '' : progress.slice(i)
    add('invariant 4: 4Hz 快路径有 `if (!position) return` 守卫', /if \(!position\) return/.test(fast))
  }

  // 5. ⚠️ 顺序要求：`!position` 守卫必须在 seek 窗口记账**之后**。
  //    放在之前会让「seek 到 0:00」这条路径的窗口永远清不掉（唯一清理点在 seek 块的 else 分支，
  //    而慢路径在同样的守卫下也够不到那里）。本批自查时真的这么写错过一次。
  {
    const i = progress.indexOf('onPlayerPosition((position, rate) =>')
    const fast = i < 0 ? '' : progress.slice(i, i + 2000)
    const seekIdx = fast.indexOf('if (seekTargetPosition != null)')
    const guardIdx = fast.indexOf('if (!position) return')
    add('invariant 5: `!position` 守卫位于 seek 窗口记账之后（否则 seek 到 0:00 的窗口清不掉）',
      seekIdx >= 0 && guardIdx > seekIdx, `seek 块@${seekIdx} 守卫@${guardIdx}`)
  }

  // 6. 快路径不自行钳制位置（统一由 setNowPlayTime 收口，避免三条路径各钳一次、口径不一致）
  {
    const i = progress.indexOf('onPlayerPosition((position, rate) =>')
    const seg = i < 0 ? '' : progress.slice(i, i + 2000)
    add('invariant 6: 快路径不自行钳制位置（收口在 setNowPlayTime）',
      !/position = Math\.(min|max)\(/.test(seg) && /setNowPlayTime\(position\)/.test(seg))
  }

  // 7. 时长变化后重算比例（切歌后残留的 nowPlayTime 不得越界）
  {
    const body = methodBody(action, 'setMaxplayTime')
    add('invariant 7: setMaxplayTime 重算比例（时长变了也要重新钳）',
      body != null && /clamp01\(state\.progress\.nowPlayTime \/ time\)/.test(body))
  }

  return out
}

// ---------------------------------------------------------------------------
// C. 反例：篡改后的源码必须被同一套不变量拦下
// ---------------------------------------------------------------------------

const tamper = [
  {
    label: '① 删掉钳制（回到「04:12 / 04:05」）',
    file: 'action',
    mutate: (s) => s.replace(
      '    if (state.progress.maxPlayTime > 0 && time > state.progress.maxPlayTime) {\n      time = state.progress.maxPlayTime\n    }\n', ''),
  },
  {
    label: '② 钳制写到赋值之后（等于没钳）',
    file: 'action',
    mutate: (s) => {
      const body = methodBody(s, 'setNowPlayTime')
      if (body == null) return s
      const clamp = '    if (state.progress.maxPlayTime > 0 && time > state.progress.maxPlayTime) {\n      time = state.progress.maxPlayTime\n    }\n'
      if (!body.includes(clamp)) return s
      return s.replace(body, body.replace(clamp, '') + clamp)
    },
  },
  {
    label: '③ 把 maxPlayTime > 0 守卫去掉（切歌瞬间真实位置被压成 0）',
    file: 'action',
    mutate: (s) => s.replace('if (state.progress.maxPlayTime > 0 && time > state.progress.maxPlayTime)',
      'if (time > state.progress.maxPlayTime)'),
  },
  {
    label: '④ 删掉比例 clamp01 兜底（÷0 → NaN，进度条消失）',
    file: 'action',
    mutate: (s) => s.replace('state.progress.progress = state.progress.maxPlayTime ? clamp01(time / state.progress.maxPlayTime) : 0',
      'state.progress.progress = time / state.progress.maxPlayTime'),
  },
  {
    label: '⑤ 4Hz 的 `!position` 守卫挪到 seek 窗口记账之前（seek 0:00 的窗口清不掉）',
    file: 'progress',
    mutate: (s) => {
      const i = s.indexOf('onPlayerPosition((position, rate) =>')
      if (i < 0) return s
      const seg = s.slice(i)
      const guard = seg.indexOf('if (!position) return\n')
      if (guard < 0) return s
      const withoutGuard = seg.slice(0, guard) + seg.slice(guard + 'if (!position) return\n'.length)
      const at = withoutGuard.indexOf('if (seekTargetPosition != null)')
      if (at < 0) return s
      return s.slice(0, i) + withoutGuard.slice(0, at) + 'if (!position) return\n' + withoutGuard.slice(at)
    },
  },
  {
    label: '⑥ setProgress 的钳制删掉（拖歌词末行 → 时间超总时长）',
    file: 'action',
    mutate: (s) => s.replace('    if (totalTime > 0 && currentTime > totalTime) currentTime = totalTime\n', ''),
  },
]

console.log('\n--- B. 源码不变量 ---')
const results = []
const push = (name, ok, detail = '') => results.push({ name, ok, detail })

for (const r of runSourceInvariants()) push(r.name, r.ok, r.detail)

console.log('\n--- C. 反例自检 ---')
for (const c of tamper) {
  const src = REAL[c.file]
  const patched = c.mutate(src)
  if (patched === src) {
    push(`反例 ${c.label}`, false, '替换未命中：源码已变，反例失效需同步')
    continue
  }
  // 换进 REAL 后用**同一套**不变量判定
  const saved = REAL[c.file]
  REAL[c.file] = patched
  const failed = runSourceInvariants().filter((r) => !r.ok)
  REAL[c.file] = saved
  push(`反例 ${c.label} 被拦下`, failed.length > 0,
    failed.length ? `命中：${failed.map((r) => r.name.split(':')[0]).join('、')}` : '未被任何不变量拦下（守卫无效）')
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

for (const r of results) {
  if (r.ok) {
    pass++
    console.log(`  PASS  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
  }
}

console.log('\n' + '='.repeat(70))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
