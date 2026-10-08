#!/usr/bin/env node
/**
 * sim-manual-pause-gate.js —— 「用户手动暂停后，任何条件都不许自动开始播放」闸门契约
 * （用户第 22 轮追加 bug）。
 *
 * 需求原话（2026-10-03）：
 *   「还发现一个bug，手动暂停后，播放其他音频结束，返回软件时也会自动开始播放，
 *     改为手动暂停后所有条件都不会播放的。」
 *
 * 根因：「被抢占后自动续播」的意图标记（service.ts 的 shouldResumeAfterDuck）有两条会在
 * 用户手动暂停之后**重新**立起来的途径 —— ① 打断开始（RemoteDuck {paused:true}）只要不是
 * 显式停止就无条件记「待恢复」；② 退后台 / 音量闪避的 wasPlayingRecently() 3s 时间窗，
 * 手动暂停后 lastPlayingAt 仍在窗口内。于是「手动暂停 → 去别的 App 放音频 → 回来/音频结束」
 * 就被自动拉起。只在个别置位点补一次 cancelResumePending 治不了根（标记会被重新置位），
 * 所以引入独立的布尔闸门（core/player/manualPause.ts）：
 *
 *   置位（用户主动暂停）：应用内播放/暂停按钮（togglePlay 暂停分支）、遥控 'pause' 命令、
 *     deeplink 'pause'。系统自动暂停（缓冲 / 打断 / 拔耳机 / 播放结束）**不**置位。
 *   消费（任何自动续播入口，为 true 一律不出声）：service.ts 的
 *     scheduleAutoResume 兜底 / iOS 打断开始 / 退后台预置 / iOS 音量闪避 / Android 恢复。
 *   复位（唯一）：播放真正开始（app_event 'play'）—— 用户重新播放后抢占-恢复流程照旧。
 *
 * 模块单独成文件是为了避免 import 环：消费方 service.ts 已 import 设置方 player.ts，
 * 反过来再 import 会成环；这个小模块谁都不依赖。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：少一道布尔判断完全合法，只在真机上表现为
 * 「手动暂停后又被自动拉起」）。
 * 运行：node scripts/sim-manual-pause-gate.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  gate: 'src/core/player/manualPause.ts',
  player: 'src/core/player/player.ts',
  remote: 'src/core/init/player/remoteCommand.ts',
  deeplink: 'src/core/init/deeplink/playerAction.ts',
  service: 'src/plugins/player/service.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// 取一个函数体：签名命中处起，到第一个位于行首的 `}` 为止（同名脚本的既有做法）
const methodBody = (s, signature) => {
  const start = s.indexOf(signature)
  if (start < 0) return null
  const rest = s.slice(start)
  const end = /\n\}\n/.exec(rest)
  return end ? rest.slice(0, end.index) : null
}

// ---------------------------------------------------------------------------
// 不变量 A：闸门模块本体（自洽、无依赖 = 不成环）
// ---------------------------------------------------------------------------

const gateInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)
  if (/^import /m.test(code)) {
    reasons.push('manualPause.ts 引入了别的模块（消费方 service.ts ↔ 设置方 player.ts 会成环，模块必须自洽）')
  }
  if (!/let manualPaused = false/.test(code)) {
    reasons.push('闸门初值缺失（应为 let manualPaused = false：应用启动时未手动暂停）')
  }
  if (!/export const markManualPause = \(\) => \{\s*\n\s*manualPaused = true\s*\n\}/.test(code)) {
    reasons.push('markManualPause 未落闸（manualPaused = true）')
  }
  if (!/export const clearManualPause = \(\) => \{\s*\n\s*manualPaused = false\s*\n\}/.test(code)) {
    reasons.push('clearManualPause 未抬闸（manualPaused = false）')
  }
  if (!/export const isManualPause = \(\) => manualPaused/.test(code)) {
    reasons.push('isManualPause 未返回闸门状态（return manualPaused）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：置位口 —— 只认用户主动暂停，且各处都落闸
// ---------------------------------------------------------------------------

const setterInvariants = (player, remote, deeplink) => {
  const reasons = []

  // ① 应用内播放/暂停按钮：togglePlay 暂停分支落闸（play 分支不落，用户要播）
  const toggleBody = methodBody(player, 'export const togglePlay = () => {')
  if (!toggleBody) {
    reasons.push('togglePlay 抽取失败（锚点漂移）')
  } else {
    const pauseBranch = toggleBody.slice(toggleBody.indexOf('if (playerState.isPlay) {'), toggleBody.indexOf('} else {') + 1)
    if (!pauseBranch.includes('markManualPause()')) {
      reasons.push('togglePlay 的暂停分支未落手动暂停闸门（应用内按暂停后仍会被自动续播拉起）')
    }
  }
  if (!player.includes("import { markManualPause } from './manualPause'")) {
    reasons.push('player.ts 未引入 markManualPause')
  }
  // 闸门只该出现在 togglePlay 一处：core 层 pause() 同样被系统路径调用（缓冲 / 打断 / 拔耳机），
  // 在那里落闸会把「系统自动暂停」误判成「用户手动暂停」，中断结束就再也不续播了
  const markCalls = (stripComments(player).match(/markManualPause\(\)/g) ?? []).length
  if (markCalls !== 1) {
    reasons.push(`player.ts 里 markManualPause 出现 ${markCalls} 处（应恰好 1：只有 togglePlay 暂停分支；core pause() 被系统路径共用，不能落闸）`)
  }

  // ② 遥控 'pause'（车机 / 控制中心 / 锁屏）：pause 分支落闸
  const remoteCode = stripComments(remote)
  if (!remoteCode.includes("import { markManualPause } from '@/core/player/manualPause'")) {
    reasons.push('remoteCommand.ts 未引入 markManualPause')
  }
  const pauseStart = remoteCode.indexOf("case 'pause':")
  const pauseEnd = remoteCode.indexOf("case 'toggle':")
  if (pauseStart < 0 || pauseEnd <= pauseStart) {
    reasons.push("remoteCommand.ts 的 case 'pause' 抽取失败（锚点漂移）")
  } else if (!remoteCode.slice(pauseStart, pauseEnd).includes('markManualPause()')) {
    reasons.push('遥控 pause 分支未落闸（锁屏/车机暂停后仍会被自动续播拉起）')
  }

  // ③ deeplink 'pause'（系统级捷径 / 外部控制）：pause 分支落闸
  const deeplinkCode = stripComments(deeplink)
  if (!deeplinkCode.includes("import { markManualPause } from '@/core/player/manualPause'")) {
    reasons.push('deeplink playerAction.ts 未引入 markManualPause')
  }
  const dStart = deeplinkCode.indexOf("case 'pause':")
  const dEnd = deeplinkCode.indexOf("case 'skipNext':")
  if (dStart < 0 || dEnd <= dStart) {
    reasons.push("deeplink 的 case 'pause' 抽取失败（锚点漂移）")
  } else if (!deeplinkCode.slice(dStart, dEnd).includes('markManualPause()')) {
    reasons.push('deeplink pause 分支未落闸')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：消费口 —— service.ts 的每个自动续播入口先过闸门 + play 事件复位
// ---------------------------------------------------------------------------

const serviceInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!code.includes("import { clearManualPause, isManualPause } from '@/core/player/manualPause'")) {
    reasons.push('service.ts 未引入闸门（isManualPause / clearManualPause）')
  }
  for (const [needle, label] of [
    ['if (isManualPause()) return cancelResumePending()', 'scheduleAutoResume 兜底'],
    ['if (wasBackgroundPlaying && !global.lx.isPlayedStop && !isManualPause()) shouldResumeAfterDuck = true', '退后台预置恢复意图'],
    ['shouldResumeAfterDuck ||= !isManualPause() && wasPlayingRecently()', 'iOS 音量闪避记恢复意图'],
    ['if (!isManualPause()) play()', 'Android 恢复分支'],
  ]) {
    if (!code.includes(needle)) reasons.push(`自动续播入口未过手动暂停闸门（${label}：缺 ${needle}）`)
  }
  // 【第 24 轮】这句话在 service.ts 里出现了两次：独占分支（8 空格）与新增的「与其他应用同时
  // 播放」策略分支（10 空格）。只用 includes 的话，篡改独占分支那句会被混音分支那句满足 ——
  // t8 反例（用户报的 bug 原文）就拦不下来（本轮实测）。闸门是「取消勾选后正常暂停」的
  // 前置条件，必须按行首缩进锁定独占分支。
  if (!/^        if \(!global\.lx\.isPlayedStop && !isManualPause\(\)\) shouldResumeAfterDuck = true/m.test(code)) {
    reasons.push('自动续播入口未过手动暂停闸门（iOS 打断开始置恢复意图：独占分支那句不见了/被改写）')
  }
  if (!/app_event\.on\('play', \(\) => \{[\s\S]{0,400}?clearManualPause\(\)/.test(code)) {
    reasons.push("app_event 'play' 未复位闸门（用户重新播放后自动续播仍被永久否决）")
  }
  // 复位口唯一：clearManualPause 只该在 play 事件里出现一次
  const clearCalls = (code.match(/clearManualPause\(\)/g) ?? []).length
  if (clearCalls !== 1) {
    reasons.push(`clearManualPause 出现 ${clearCalls} 处（应恰好 1：play 事件唯一复位口）`)
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

  // t1 应用内暂停不再落闸（togglePlay 拆掉 markManualPause）
  check('t1 togglePlay 暂停分支拆闸', () => setterInvariants(tamper(REAL.player,
    '    markManualPause()\n    void pause()',
    '    void pause()'), REAL.remote, REAL.deeplink),
  'togglePlay 的暂停分支未落手动暂停闸门')

  // t2 核心 pause() 也落闸（系统自动暂停被误判成用户手动暂停）
  check('t2 core pause() 误落闸', () => setterInvariants(tamper(REAL.player,
    'export const pause = async() => {',
    'export const pause = async() => {\n  markManualPause()'), REAL.remote, REAL.deeplink),
  'core pause() 被系统路径共用')

  // t3 遥控暂停拆闸
  // 【第 35 轮第 1 条】落闸加了「这次 pause 真的会暂停（playerState.isPlay）」前置判据
  // —— 锚点随之更新；拆闸反例拆的仍是「这条分支到底还落不落闸」，语义不变。
  check('t3 遥控 pause 拆闸', () => setterInvariants(REAL.player, tamper(REAL.remote,
    '        if (playerState.isPlay) markManualPause()\n        cancelResumePending()',
    '        cancelResumePending()'), REAL.deeplink),
  '遥控 pause 分支未落闸')

  // t4 deeplink 暂停拆闸
  check('t4 deeplink pause 拆闸', () => setterInvariants(REAL.player, REAL.remote, tamper(REAL.deeplink,
    '      markManualPause()\n      void pause()',
    '      void pause()')),
  'deeplink pause 分支未落闸')

  // t5 闸门模块失去记忆（isManualPause 恒 false）
  check('t5 闸门恒为 false', () => gateInvariants(tamper(REAL.gate,
    'export const isManualPause = () => manualPaused',
    'export const isManualPause = () => false')),
  'isManualPause 未返回闸门状态')

  // t6 scheduleAutoResume 兜底拆闸
  check('t6 兜底续播拆闸', () => serviceInvariants(tamper(REAL.service,
    '  if (isManualPause()) return cancelResumePending()\n',
    '')),
  '自动续播入口未过手动暂停闸门')

  // t7 play 事件不再复位（手动暂停后永远不出声）
  check('t7 play 不再复位闸门', () => serviceInvariants(tamper(REAL.service,
    '    clearManualPause()\n',
    '')),
  "app_event 'play' 未复位闸门")

  // t8 打断开始退回无条件置位（用户报的 bug 原文）
  // 【第 24 轮】同样按行首 8 空格锚定独占分支：纯字符串锚点会先命中混音分支那句（10 空格，
  // 从第 2 列开始就是目标子串），篡改落到无关分支上，反例失去拦截意义。
  check('t8 打断开始退回无条件置位', () => serviceInvariants(REAL.service.replace(
    /^        if \(!global\.lx\.isPlayedStop && !isManualPause\(\)\) shouldResumeAfterDuck = true/m,
    '        if (!global.lx.isPlayedStop) shouldResumeAfterDuck = true')),
  'iOS 打断开始置恢复意图')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-manual-pause-gate ===')
console.log('手动暂停闸门：三个置位口 / 五个消费口 / 一个复位口（第 22 轮追加 bug）')
console.log()

const checks = [
  ['闸门模块（自洽、无 import，不成环）', () => gateInvariants(REAL.gate)],
  ['置位口（togglePlay 暂停分支 / 遥控 pause / deeplink pause）', () => setterInvariants(REAL.player, REAL.remote, REAL.deeplink)],
  ['消费口 + 复位口（service.ts 五处入口 + play 事件）', () => serviceInvariants(REAL.service)],
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
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.detail}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
