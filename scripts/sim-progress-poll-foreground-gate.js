/**
 * sim-progress-poll-foreground-gate.js
 *
 * 「进度轮询的 App 前台门」契约不变量（第 20 轮·耗电契约 ①，2026-10-03）。
 *
 * 背景：src/plugins/player/hook.ts 的 useProgress 每秒做 3 次原生桥往返
 * （TrackPlayer.getPosition / getDuration / getBufferedPosition；nativeFlac 路径
 * 同样是 getNativeFlacPosition / Duration / BufferedPosition 三件套）再 setState，
 * **且原本没有任何前台门** —— 音频后台播放让进程锁屏后常驻，于是锁屏一整夜都在
 * 空转：每秒一次桥往返 + 一次（变化的）React 渲染。同文件的 useBufferProgress 与
 * core/init/player/playProgress.ts 都有前台门（isActive() / AppState 守卫），
 * 唯独这一处漏了。
 *
 * 修复口径（与 useBufferProgress 同一套写法）：
 *   · 「该不该轮询」= 播放状态机（Playing / Buffering 才进 effect 体，原来的早退不变）；
 *   · 「现在能不能轮询」= isActive()（App 在前台）；
 *   · 起表前的补测与 setInterval **只此一处**（syncItv），且都在同一道前台门之内 ——
 *     后台一次桥往返都不发；
 *   · AppState 'change' 订阅：退后台 clearItv()，回前台 syncItv()（补一次实测再起表）；
 *   · effect 清理同时停表与退订（两处订阅各清各的，appStateSubscription.remove() ×2）。
 *
 * 本脚本把这些绑成不变量，并带反例自检（tsc/eslint 对「定时器没停」「门在表后面」
 * 完全无感）。运行：node scripts/sim-progress-poll-foreground-gate.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const HOOK = 'src/plugins/player/hook.ts'
const REAL = read(HOOK)

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 从源码抽出「以 signature 开头、后接大括号体」的函数/箭头函数体（按大括号配平）。 */
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
// 不变量：useProgress 的轮询必须全部落在前台门之内
// ---------------------------------------------------------------------------

const progressInvariants = (rawFile) => {
  const reasons = []
  // 结构化判断跑在去注释源码上：注释里出现的 setInterval / getProgress 字样
  // （本文件的长注释很多）不参与计数。
  const code = stripComments(rawFile)

  const body = extractBracedBody(code, 'export function useProgress(updateInterval: number)')
  if (!body) return ['未找到 useProgress 函数体（锚点漂移，先修脚本锚点）']
  const fetchBody = extractBracedBody(code, 'const getProgress = async() =>')
  if (!fetchBody) return ['未找到 getProgress（进度取数体）']

  // ① 「该不该轮询」的判定保留：Playing / Buffering 之外不进 effect 体
  if (!/pollTrackPlayerStates\s*\.includes\(playerState\)/.test(body)) {
    reasons.push('「Playing/Buffering 才轮询」的早退判定被改动（不该轮询的状态也会起表）')
  }

  // ② 起表点收敛：useProgress 里 setInterval 恰好 1 处，且只建 getProgress 的表
  const itvAll = body.match(/setInterval\(/g) ?? []
  const itvIdx = body.search(/setInterval\(getProgress/)
  if (itvAll.length !== 1 || itvIdx < 0) {
    reasons.push(`起表点未收敛（useProgress 里 setInterval 出现 ${itvAll.length} 处，应恰好 1 处、只建 getProgress 的表）`)
  }

  // ③ 前台门存在，且在起表**之前**
  const gateIdx = body.search(/if\s*\(\s*!\s*isActive\(\)\s*\)\s*return/)
  if (gateIdx < 0) {
    reasons.push('进度轮询缺前台门（syncItv 里 !isActive() 早退缺失）')
  } else if (itvIdx >= 0 && gateIdx > itvIdx) {
    reasons.push('进度轮询缺前台门（!isActive() 判定落在起表之后，退后台仍会建表）')
  }

  // ④ 起表前的补测同门：void getProgress() 恰好 1 处，且在门内（后台一次桥往返都不发）
  const fetchAll = body.match(/void getProgress\(\)/g) ?? []
  const fetchIdx = body.search(/void getProgress\(\)/)
  if (fetchAll.length !== 1) {
    reasons.push(`起表前补测未收敛（void getProgress() 出现 ${fetchAll.length} 处，应恰好 1 处、与 setInterval 同一道门）`)
  } else if (gateIdx >= 0 && fetchIdx < gateIdx) {
    reasons.push('起表前补测未收敛（补测在 !isActive() 门之外，退后台会白发一次桥往返）')
  }

  // ⑤ 3 次原生桥往返的口径不变（两条路径都并发取数）
  for (const call of [
    'TrackPlayer.getPosition()',
    'TrackPlayer.getDuration()',
    'TrackPlayer.getBufferedPosition()',
    'getNativeFlacPosition()',
    'getNativeFlacDuration()',
    'getNativeFlacBufferedPosition()',
  ]) {
    if (!fetchBody.includes(call)) {
      reasons.push(`3 次原生桥往返口径被改动：缺 ${call}`)
    }
  }
  if ((fetchBody.match(/Promise\.all\(/g) ?? []).length < 2) {
    reasons.push('3 次原生桥往返口径被改动：两条路径都应 Promise.all 并发取数')
  }

  // ⑥ 停表能力：clearInterval + 置 null（缺一个都会留下悬空句柄）
  if (!/clearInterval\(interval\)/.test(body) || !/interval = null/.test(body)) {
    reasons.push('clearItv 没有真正停表（clearInterval(interval) / interval = null 缺失）')
  }

  // ⑦ 前后台订阅：退后台停表、回前台补测起表
  const subIdx = body.search(/AppState\.addEventListener\(\s*'change'/)
  if (subIdx < 0) {
    reasons.push('进度轮询缺前后台订阅（退后台不停表 / 回前台不补测）')
  } else {
    const subRegion = body.slice(subIdx, subIdx + 400)
    if (!/nextState\s*===\s*'active'\s*\)\s*\{\s*syncItv\(\)/.test(subRegion)) {
      reasons.push('回前台未恢复轮询（active 分支未 syncItv）')
    }
    if (!/else\s*\{\s*clearItv\(\)/.test(subRegion)) {
      reasons.push('退后台未停表（非 active 分支未 clearItv）')
    }
  }

  // ⑧ effect 清理：停表 + 退订
  if (!/return \(\) => \{\s*clearItv\(\)\s*appStateSubscription\.remove\(\)\s*\}/.test(body)) {
    reasons.push('effect 清理不完整（须同时 clearItv() 与 appStateSubscription.remove()）')
  }

  // ⑨ 周期契约：updateInterval || 1000（调用方传 250 之类的自定义周期仍要生效）
  if (!/setInterval\(getProgress,\s*updateInterval \|\| 1000\)/.test(body)) {
    reasons.push('轮询周期契约变化（应保持 updateInterval || 1000）')
  }

  // ⑩ 文件级对称：本 hook 与 useBufferProgress 两处订阅各清各的
  const removes = (code.match(/appStateSubscription\.remove\(\)/g) ?? []).length
  if (removes !== 2) {
    reasons.push(`两处前后台订阅清理不对称（appStateSubscription.remove() 出现 ${removes} 处，应为 2）`)
  }

  // ⑪ 顺带回归守卫：useBufferProgress 的既有前台门不许被这次改动带坏
  if (!/if\s*\(!wantPolling \|\| !isActive\(\)\) return/.test(code)) {
    reasons.push('useBufferProgress 的前台门被顺带改坏（!wantPolling || !isActive() 守卫缺失）')
  }
  const bufItv = (code.match(/setInterval\(updateBuffer/g) ?? []).length
  if (bufItv !== 1) {
    reasons.push(`useBufferProgress 起表点被顺带改坏（setInterval(updateBuffer 出现 ${bufItv} 处，应为 1）`)
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

  // m1 抹掉前台门 → 报「缺前台门」
  check('m1 syncItv 抹掉 !isActive() 早退', () => {
    const s = tamper(REAL,
      'const syncItv = () => {\n      clearItv()\n      if (!isActive()) return',
      'const syncItv = () => {\n      clearItv()')
    return progressInvariants(s)
  }, '缺前台门')

  // m2 把补测移回 effect 体（门外）→ 报「补测未收敛」
  check('m2 补测移出前台门', () => {
    const s = tamper(REAL,
      '\n    syncItv()\n\n    // 前后台订阅',
      '\n    void getProgress()\n    syncItv()\n\n    // 前后台订阅')
    return progressInvariants(s)
  }, '补测未收敛')

  // m3 退后台不停表 → 报「退后台未停表」
  check('m3 非 active 分支不停表', () => {
    const s = tamper(REAL,
      '} else {\n          clearItv()\n        }',
      '} else {\n        }')
    return progressInvariants(s)
  }, '退后台未停表')

  // m4 回前台不恢复轮询 → 报「回前台未恢复轮询」
  check('m4 active 分支不起表', () => {
    const s = tamper(REAL,
      "if (nextState === 'active') {\n          syncItv()\n        }",
      "if (nextState === 'active') {\n        }")
    return progressInvariants(s)
  }, '回前台未恢复轮询')

  // m5 清理不退还订阅 → 报「清理不完整」
  check('m5 清理漏掉 appStateSubscription.remove()', () => {
    const s = tamper(REAL,
      '    return () => {\n      clearItv()\n      appStateSubscription.remove()\n    }\n  }, [playerState, updateInterval])',
      '    return () => {\n      clearItv()\n    }\n  }, [playerState, updateInterval])')
    return progressInvariants(s)
  }, '清理不完整')

  // m6 整个订阅块删掉 → 报「缺前后台订阅」
  check('m6 删掉 AppState 订阅块', () => {
    const s = tamper(REAL,
      "    const appStateSubscription = AppState.addEventListener(\n      'change',\n      (nextState) => {\n        if (nextState === 'active') {\n          syncItv()\n        } else {\n          clearItv()\n        }\n      },\n    )\n",
      '')
    return progressInvariants(s)
  }, '缺前后台订阅')

  // m7 门被写反（isActive() 才 return）→ 报「缺前台门」
  check('m7 前台门写反', () => {
    const s = tamper(REAL,
      '      if (!isActive()) return',
      '      if (isActive()) return')
    return progressInvariants(s)
  }, '缺前台门')

  // m8 少一次桥往返（丢掉缓冲位置）→ 报「3 次原生桥往返口径被改动」
  check('m8 少取一次缓冲位置', () => {
    const s = tamper(REAL,
      '        TrackPlayer.getBufferedPosition(),\n',
      '')
    return progressInvariants(s)
  }, '3 次原生桥往返')

  // m9 周期写死 1000（调用方自定义周期失效）→ 报「周期契约」
  check('m9 周期写死 1000', () => {
    const s = tamper(REAL,
      'setInterval(getProgress, updateInterval || 1000)',
      'setInterval(getProgress, 1000)')
    return progressInvariants(s)
  }, '轮询周期契约')

  // m10 clearItv 不 clearInterval（只置 null，句柄悬空）→ 报「没有真正停表」
  check('m10 clearItv 不 clearInterval', () => {
    const s = tamper(REAL,
      '      if (!interval) return\n      clearInterval(interval)\n      interval = null',
      '      if (!interval) return\n      interval = null')
    return progressInvariants(s)
  }, '没有真正停表')

  // m11 顺带改坏 useBufferProgress 的前台门 → 报回归守卫
  check('m11 带坏 useBufferProgress 前台门', () => {
    const s = tamper(REAL,
      'if (!wantPolling || !isActive()) return',
      'if (!wantPolling) return')
    return progressInvariants(s)
  }, 'useBufferProgress 的前台门被顺带改坏')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-progress-poll-foreground-gate ===')

const realReasons = progressInvariants(REAL)
console.log('\n[useProgress 前台门（src/plugins/player/hook.ts）]')
if (realReasons.length === 0) {
  console.log('  PASS 起表点收敛 + 前台门在起表前 + 补测同门 + 3 次桥往返口径 + 前后台订阅/清理 + 周期契约（useBufferProgress 未被带坏）')
} else {
  realReasons.forEach(r => console.log('  FAIL ' + r))
}

console.log('\n[反例自检]')
const ceResults = runCounterExamples()
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.ok ? '已拦下' : `未拦下（reasons=${JSON.stringify(r.detail)}）`}`)
  if (!r.ok) ceAllOk = false
}

const invOk = realReasons.length === 0
const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${invOk ? '1/1' : '0/1'}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
