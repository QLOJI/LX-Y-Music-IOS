#!/usr/bin/env node
/**
 * sim-cut-song-start-position.js —— 「切歌 / 重播一律从头（0:00）播放」契约（第 53 轮第 1 条）
 *
 * 用户原话（2026-10-11）：
 *   「当我一首歌播放到1:00时，然后退出软件或者点击上一首或者下一首歌时，下一首歌不会从头
 *     开始播放，而是从1:00开始播放，需要修复这个问题，上一首或者下一首都是从头播放」
 *
 * 语义（本脚本钉的就是这三条）：
 *   ① 上一首 / 下一首 / 列表点播 / 自然播完跳下一首 / 单曲循环重播 —— 新歌必须从 0 起播；
 *   ② 只有「恢复上次播放」（play()：冷启动恢复、暂停后重新开始该曲）允许从保存进度起播；
 *   ③ 起播位置的每一个来源都必须能证明「这个位置属于这首歌」，否则一律 0。
 *
 * 起播位置在 JS 侧只有三个来源，本脚本逐个钉死：
 *   A. `pendingRestoreSeek`（启动恢复的一次性 seek 意图，core/player/player.ts）
 *      —— 由 handleRestorePlay 写入、setMusicUrl 消费。旧判据只有「歌曲 id 相同」，
 *      挡不住**同一首歌被再次播放**（单曲循环 / 随机连抽同一首 / 手动重播当前曲）：
 *      那些路径 id 全都相等，于是「上次退出时的保存进度」被当成这次的起播位置。
 *      现改为：多一个 `allowRestoreSeek` 开关，只有 play() 传 true；且两侧 id 必须非空
 *      （`null == null` 会退化成相等，裸意图会漏给下一首）。
 *   B. `isRefresh` 分支的 `getPosition()` —— 错误 / 降级 / 25s 加载超时后的重取要沿用
 *      「引擎当前位置」，但引擎此刻可能还装着**上一首**（新歌的流尚未装载），
 *      取到的就是旧歌的位置。现改为必须 `isEngineOnMusic(musicInfo)` 为真才沿用。
 *   C. 出声回拉 / 缓冲兜底 / 快路径门控（core/init/player/playProgress.ts）
 *      —— `restorePlayTime` / `mediaBuffer` / `engineConfirmedPlaying` / seek 窗口
 *      这些「位置意图」在切歌时**不清**：切歌走 setPlayMusicInfo → app_event.musicToggled，
 *      它只发 musicToggled、不发 stop，所以 handleStop 里那套复位根本不执行。
 *      现改为在 handleSetPlayInfo（musicToggled 的唯一消费者）首行整批作废。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：少一个布尔开关、少一行清理完全合法，
 * 只在真机上表现为「切歌后从旧进度开始放」）。
 * 运行：node scripts/sim-cut-song-start-position.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
// 去注释，**字符串感知**：`'nativeflac://'` 这类字面量里的 // 不是注释
//（本脚本要断言的正是这种含 // 的字符串，用朴素的 replace(/\/\/[^\n]*/) 会把断言行自己吃掉）
const stripComments = (src) => {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const two = src.slice(i, i + 2)
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch
      i++
      while (i < src.length) {
        out += src[i]
        if (src[i] === '\\') { i++; out += src[i] ?? ''; i++; continue }
        if (src[i] === ch) break
        i++
      }
      continue
    }
    if (two === '//') { const nl = src.indexOf('\n', i); i = (nl < 0 ? src.length : nl) - 1; continue }
    if (two === '/*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue }
    out += ch
  }
  return out
}
const countOf = (s, needle) => s.split(needle).length - 1

// 取「签名 → 配平的 }」之间的函数体（跳过注释与字符串里的花括号）。
// 比「找行首 }」稳：本文件的函数体里有对象字面量、有的缩进还不一样。
const bodyOf = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  let i = src.indexOf('{', start + signature.length)
  if (i < 0) return null
  const open = i
  let depth = 0
  for (; i < src.length; i++) {
    const two = src.slice(i, i + 2)
    if (two === '//') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue }
    if (two === '/*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue }
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(open + 1, i) }
  }
  return null
}

// 反例篡改：锚点必须**在全文唯一**（String.replace 只换第一处，
// 锚点撞车 = 篡改落在无关代码上，反例变成假通过）。这里的检查是硬失败。
const tamper = (src, find, replace) => {
  const n = countOf(src, find)
  if (n !== 1) throw new Error(`tamper 锚点不唯一（命中 ${n} 处）: ${JSON.stringify(find.slice(0, 70))}`)
  return src.replace(find, replace)
}

// 遍历 src（path.relative(ROOT, abs) 得到 'src/...'，与 F 里的相对路径同口径）。
// 用 statSync 判目录、不用 readdirSync(_, { withFileTypes: true })：本工程的浏览器
// 运行器（C:\Users\Q\AppData\Local\Temp\lx-jsrun\runner.html）里 Dirent.isDirectory()
// 会把普通文件也报成 true，walk 会一头扎进 app.ts 里直接 ENOENT。
// 反例篡改（限定窗口版）：先定位唯一锚点 after，只在它之后的窗口里替换第一处 find。
// 用在「目标文本在全文合法地出现多次、但只有一处属于被测函数」的场合（缩进撞车）。
const tamperAfter = (src, after, find, replace) => {
  const at = src.indexOf(after)
  if (at < 0) throw new Error(`tamperAfter 锚点未命中: ${JSON.stringify(after.slice(0, 60))}`)
  const win = src.slice(at)
  const i = win.indexOf(find)
  if (i < 0) throw new Error(`tamperAfter 目标未命中: ${JSON.stringify(find.slice(0, 60))}`)
  const abs = at + i
  return src.slice(0, abs) + replace + src.slice(abs + find.length)
}

const walk = (dir, acc = []) => {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) acc.push(p)
  }
  return acc
}

// 抓「callee(...)」调用点的实参列表（括号配平）
const findCallSites = (src, callee) => {
  const out = []
  const re = new RegExp(callee + '\\(', 'g')
  let m
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    let depth = 1
    let end = -1
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) continue
    const argsText = src.slice(m.index + m[0].length, end)
    out.push({
      argsText,
      args: argsText.split(',').map(s => s.trim()).filter(Boolean),
      at: m.index,
    })
  }
  return out
}

const F = {
  player: 'src/core/player/player.ts',
  progress: 'src/core/init/player/playProgress.ts',
  putils: 'src/plugins/player/utils.ts',
  pindex: 'src/plugins/player/index.ts',
}
const REAL = {}
for (const [k, f] of Object.entries(F)) REAL[k] = read(f)
REAL.playerCode = stripComments(REAL.player)
REAL.progressCode = stripComments(REAL.progress)
// 全仓扫描的待读文件（setMusicUrl 调用点普查用）
const SRC_FILES = walk(path.join(ROOT, 'src'))

// ---------------------------------------------------------------------------
// A. 恢复意图（pendingRestoreSeek）：唯一开关 + 两侧 id 非空 + 无条件清空
// ---------------------------------------------------------------------------

const restoreIntentInvariants = (code) => {
  const reasons = []

  // A1 签名：第四参 allowRestoreSeek 默认 false（= 默认拒绝非 0 起播，调用方必须显式申请）
  if (!/export const setMusicUrl = \(musicInfo: [^)]*, allowRestoreSeek = false\) => \{/.test(code)) {
    reasons.push('setMusicUrl 缺少 allowRestoreSeek 形参（默认必须为 false：非 0 起播要调用方显式申请）')
  }

  const body = bodyOf(code, 'export const setMusicUrl = (musicInfo')
  if (!body) {
    reasons.push('setMusicUrl 函数体抽取失败（锚点漂移）')
    return reasons
  }

  // A2 消费条件：开关 + 非刷新 + 两侧 id 非空 + id 相等，五个判据一个都不能少
  const cond = /const canConsumeRestoreSeek = ([\s\S]{0,400}?)pendingRestoreSeek = null/.exec(body)
  if (!cond) {
    reasons.push('canConsumeRestoreSeek 判据抽取失败（锚点漂移）')
  } else {
    const expr = cond[1]
    for (const [needle, label] of [
      ['allowRestoreSeek', '开关 allowRestoreSeek（否则同一首歌的再次播放会误吃恢复意图）'],
      ['!isRefresh', '非刷新（刷新重取不是恢复起播）'],
      ['pendingRestoreSeek != null', '意图存在'],
      ['pendingRestoreSeek.id != null', '意图侧 id 非空（null == null 会退化成相等）'],
      ['musicInfo.id != null', '曲目侧 id 非空'],
      ['pendingRestoreSeek.id === musicInfo.id', 'id 相等'],
    ]) {
      if (!expr.includes(needle)) reasons.push(`恢复意图消费条件缺少「${label}」`)
    }
  }

  // A3 restoreTime 只能来自 canConsumeRestoreSeek，否则 0
  if (!/const restoreTime = canConsumeRestoreSeek && pendingRestoreSeek \? pendingRestoreSeek\.time : 0/.test(body)) {
    reasons.push('restoreTime 未完全由 canConsumeRestoreSeek 决定（可能出现无条件取意图时间的分支）')
  }

  // A4 无条件清空，且必须在任何 await / 取链之前（中断分支同样丢弃，防跨歌泄漏）
  const idxClear = body.indexOf('pendingRestoreSeek = null')
  const idxFetch = body.indexOf('getMusicPlayUrl(musicInfo, isRefresh, false, quality)')
  if (idxClear < 0) reasons.push('恢复意图未被无条件清空（一次性意图残留会污染后续歌曲）')
  else if (idxFetch < 0) reasons.push('setMusicUrl 里的取链调用抽取失败（锚点漂移）')
  else if (idxClear > idxFetch) reasons.push('恢复意图的清空点在取链之后（中断分支会把意图留给下一首歌）')

  // A5 写入点唯一：只有 handleRestorePlay 能写意图
  const writes = countOf(code, 'pendingRestoreSeek = {')
  if (writes !== 1) reasons.push(`pendingRestoreSeek 写入点 ${writes} 处（应恰好 1：handleRestorePlay）`)
  const restoreBody = bodyOf(code, 'const handleRestorePlay = async(restorePlayInfo')
  if (!restoreBody) reasons.push('handleRestorePlay 抽取失败（锚点漂移）')
  else if (!/pendingRestoreSeek = \{ id: musicInfo\.id, time: Math\.max\(0, restoreTime\) \}/.test(restoreBody)) {
    reasons.push('handleRestorePlay 未夹紧恢复位置（Math.max(0, restoreTime)）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// B. 全仓调用点：只有 play() 允许「非 0 起播」
// ---------------------------------------------------------------------------

const callSiteInvariants = (files, override = {}) => {
  const reasons = []
  const all = []
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/')
    const raw = override[rel] ?? fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
    const code = stripComments(raw)
    for (const site of findCallSites(code, 'setMusicUrl')) all.push({ rel, ...site })
  }
  // 判定必须建立在**当前这份（可能被篡改的）player.ts** 上，否则反例改了调用点、判定还看原文
  const playerCode = stripComments(override[F.player] ?? REAL.player)

  const withFourth = all.filter(s => s.args.length >= 4)
  const enabled = all.filter(s => s.args.length >= 4 && s.args[3] === 'true')

  // B1 全仓只有一个调用点开启恢复起播
  if (enabled.length !== 1) {
    reasons.push(`第 4 参为 true 的 setMusicUrl 调用点有 ${enabled.length} 处（应恰好 1：只有 play() 的恢复起播）`)
  }
  // B2 它必须在 play() 体内
  const playBody = bodyOf(playerCode, 'export const play = () =>')
  if (!playBody) {
    reasons.push('play() 函数体抽取失败（锚点漂移）')
  } else {
    const playSites = findCallSites(playBody, 'setMusicUrl')
    if (playSites.length !== 1) {
      reasons.push(`play() 里的 setMusicUrl 调用点有 ${playSites.length} 处（应恰好 1）`)
    } else if (playSites[0].args[3] !== 'true') {
      reasons.push('play() 未开启恢复起播（第 4 参不是 true）：恢复上次播放会退化成从头播放')
    }
  }
  // B3 其余调用点一律三参以内（默认 false = 从 0 起播）。
  // 命中判据必须带上被调函数名整串：`musicInfo, false, undefined, true` 是
  // `playerState.playMusicInfo.musicInfo, false, undefined, true` 的子串，
  // 只用实参文本比会把「切歌链也开了恢复」误判成 play() 那一处。
  for (const s of withFourth) {
    const callText = `setMusicUrl(${s.argsText})`
    const isPlay = s.rel === F.player && !!playBody && playBody.includes(callText)
    if (!isPlay) {
      reasons.push(`${s.rel} 的 ${callText} 显式传了第 4 参（只有 play() 允许）`)
    } else if (s.args[3] !== 'true') {
      reasons.push(`play() 的第 4 参是 ${s.args[3]}（恢复起播必须为 true）`)
    }
  }
  // B4 切歌主链（debouncePlay 的 setMusicUrl）必须是「1 参 = 默认 0 起播」
  const debounceBody = bodyOf(playerCode, 'const debouncePlay = debounceBackgroundTimer')
  if (!debounceBody) reasons.push('debouncePlay 抽取失败（锚点漂移）')
  else {
    const sites = findCallSites(debounceBody, 'setMusicUrl')
    if (sites.length !== 1 || sites[0].args.length !== 1) {
      reasons.push(`debouncePlay（切歌 / 点播的唯一装载入口）的 setMusicUrl 不是单参调用：${
        sites.map(s => `(${s.argsText})`).join(' ')}`)
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// C. 刷新分支：引擎没在放这首歌就不许沿用引擎位置
// ---------------------------------------------------------------------------

const refreshGateInvariants = (code) => {
  const reasons = []
  const body = bodyOf(code, 'export const setMusicUrl = (musicInfo')
  if (!body) return ['setMusicUrl 函数体抽取失败（锚点漂移）']

  if (!/const currentTimePromise = isRefresh && isEngineOnMusic\(musicInfo\)\s*\n?\s*\? getPosition\(\)\.catch\(\(\) => playerState\.progress\.nowPlayTime\)/.test(body)) {
    reasons.push('刷新分支的位置未过 isEngineOnMusic 门控（引擎还装着上一首时会把旧歌位置当起播位置）')
  }
  if (!/: Promise\.resolve\(isRefresh \? 0 : restoreTime\)/.test(body)) {
    reasons.push('非恢复路径的兜底不是 0（刷新但引擎不在本曲时必须 0 起播）')
  }
  return reasons
}

const engineGateInvariants = (putils, pindex) => {
  const reasons = []
  const code = stripComments(putils)
  const body = bodyOf(code, 'export const isEngineOnMusic = (musicInfo')
  if (!body) {
    reasons.push('isEngineOnMusic 抽取失败（锚点漂移）')
    return reasons
  }
  if (!/'progress' in musicInfo\s*\n?\s*\? \[musicInfo\.id, musicInfo\.metadata\.musicInfo\.id\]/.test(body)) {
    reasons.push('isEngineOnMusic 未同时比对下载条目的内外层 id（nativeFlac 拼的是内层 id）')
  }
  const trackIdOf = /const trackId = Platform\.OS == 'ios' && isNativeFlacActive\(\) \? getNativeFlacTrackId\(\) : global\.lx\.playerTrackId/.exec(body)
  if (!trackIdOf) reasons.push('isEngineOnMusic 取的不是「引擎自己的曲目 id」（取 playerState 分不出引擎跟没跟上）')
  if (!/if \(!trackId\) return false/.test(body)) {
    reasons.push('isEngineOnMusic 未处理空曲目 id（空 = 引擎没装载任何东西，必须判为不在本曲）')
  }
  if (!/const isNative = trackId\.startsWith\('nativeflac:\/\/'\)/.test(body)) {
    reasons.push("isEngineOnMusic 缺少 const isNative 判据（两种引擎曲目 id 形态必须分流）")
  }
  if (!/trackId == `nativeflac:\/\/\$\{id\}`/.test(body)) {
    reasons.push('isEngineOnMusic 未按 nativeflac://<id> 精确比对无损路径')
  }
  if (!/trackId\.startsWith\(`\$\{id\}__\/\/`\)/.test(body)) {
    reasons.push('isEngineOnMusic 未按 <id>__// 前缀比对 AVPlayer 路径')
  }
  // 导出走 index.ts 末尾的 `export { ... } from './utils'` 再导出块，不是 export const
  if (!/^\s*isEngineOnMusic,\s*$/m.test(stripComments(pindex))) {
    reasons.push('plugins/player/index.ts 未再导出 isEngineOnMusic（core 层拿不到门控，只能直连 utils 模块）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// D. 切歌即整批作废位置意图（playProgress）
// ---------------------------------------------------------------------------

const progressInvariants = (code) => {
  const reasons = []

  const resetBody = bodyOf(code, 'const resetTrackPositionIntents = () =>')
  if (!resetBody) {
    reasons.push('resetTrackPositionIntents 抽取失败（锚点漂移）')
  } else {
    for (const [needle, label] of [
      ['seekTargetPosition = null', 'seek 落点窗口'],
      ['seekHoldUntil = 0', 'seek 窗口时限'],
      ['seekGen++', 'seek 代际（在途的 setCurrentTime resolve / 位置快照必须作废）'],
      ['clearBufferTimeout()', '缓冲看门狗 / mediaBuffer 快照'],
      ['restorePlayTime = null', '出声回拉意图位置'],
      ['restorePlayTimeTrack = null', '出声回拉意图绑定的歌曲'],
      ['lastSeekIntentAt = 0', '回拉新鲜度基准'],
      ['pullBackCount = 0', '回拉预算'],
      ['engineConfirmedPlaying = false', '4Hz 位置快路径门控'],
      ['isBufferingHold = false', '缓冲保持门控'],
    ]) {
      if (!resetBody.includes(needle)) reasons.push(`切歌复位缺少「${label}」（${needle}）`)
    }
  }

  const setBody = bodyOf(code, 'const handleSetPlayInfo = () =>')
  if (!setBody) {
    reasons.push('handleSetPlayInfo 抽取失败（锚点漂移）')
  } else {
    const idxPause = setBody.indexOf('handlePause()')
    const idxReset = setBody.indexOf('resetTrackPositionIntents()')
    const idxRestore = setBody.indexOf('isRestoringCurrentMusic()')
    if (idxReset < 0) reasons.push('handleSetPlayInfo 未调用 resetTrackPositionIntents（切歌后位置意图残留）')
    else if (idxPause < 0 || idxPause > idxReset) reasons.push('handleSetPlayInfo 未先停 ticker 再清意图（清理期间旧时钟还在外推）')
    if (idxReset >= 0 && idxRestore >= 0 && idxReset > idxRestore) {
      reasons.push('resetTrackPositionIntents 在 isRestoringCurrentMusic 早退之后（启动恢复路径漏清）')
    }
  }

  // 复位口唯一：只该在 handleSetPlayInfo 里被调用一次（定义 + 调用 = 2 处）
  const calls = countOf(code, 'resetTrackPositionIntents')
  if (calls !== 2) {
    reasons.push(`resetTrackPositionIntents 出现 ${calls} 处（应恰好 2：定义 1 + 调用 1；多一处 = 有别的路径也在清，少一处 = 切歌漏清）`)
  }

  // 切歌事件（musicToggled）的唯一消费者仍是 handleSetPlayInfo
  if (!/global\.app_event\.on\('musicToggled', handleSetPlayInfo\)/.test(code)) {
    reasons.push('musicToggled 未绑到 handleSetPlayInfo（切歌复位点断了）')
  }

  // D5 seek 落点回填要确认「还是同一首歌」
  const seekBody = bodyOf(code, 'const setProgress = (time: number')
  if (!seekBody) reasons.push('setProgress 抽取失败（锚点漂移）')
  else {
    const thenIdx = seekBody.indexOf('setCurrentTime(time).then(')
    if (thenIdx < 0) reasons.push('setProgress 的 setCurrentTime 回调抽取失败（锚点漂移）')
    else {
      // 必须比「谁在前」而不是「有没有」：`playerState.musicInfo.id != musicId` 在嵌套的
      // getPlaybackEngineState 回调里还有一份（条件里带 || seekGen != genAtSeek），
      // 只测存在性的话反例把真正那道守卫删掉也照样命中。
      const head = seekBody.slice(thenIdx, thenIdx + 400)
      const guardIdx = head.indexOf('playerState.musicInfo.id != musicId')
      const branchIdx = head.indexOf('if (targetPosition > 0) {')
      if (guardIdx < 0 || branchIdx < 0 || guardIdx > branchIdx) {
        reasons.push('setProgress 的落点回填缺少 id 守卫（快 seek 后立刻切歌会把旧歌落点写进新歌进度）')
      }
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 反例（对篡改后的源码跑同一套判断，必须被拦下）
// ---------------------------------------------------------------------------

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

  // t1 第四参默认值退回不加开关（切歌路径重新能吃恢复意图）
  check('t1 allowRestoreSeek 默认值缺失', () => restoreIntentInvariants(stripComments(tamper(REAL.player,
    ', allowRestoreSeek = false) => {', ') => {'))),
  'setMusicUrl 缺少 allowRestoreSeek 形参')

  // t2 消费条件退回「只比 id」（用户报的 bug 原文：同一首歌重播吃旧进度）
  check('t2 消费条件退回只比 id', () => restoreIntentInvariants(stripComments(tamper(REAL.player,
    '  const canConsumeRestoreSeek = allowRestoreSeek && !isRefresh &&',
    '  const canConsumeRestoreSeek = !isRefresh &&'))),
  '开关 allowRestoreSeek')

  // t3 只比 id 相等、不比两侧非空（null == null 退化）
  check('t3 id 非空判据缺失', () => restoreIntentInvariants(stripComments(tamper(REAL.player,
    '    pendingRestoreSeek != null && pendingRestoreSeek.id != null && musicInfo.id != null &&\n',
    '    pendingRestoreSeek != null &&\n'))),
  'id 非空')

  // t4 清空点退回到取链之后（中断分支把意图留给下一首）
  check('t4 清空点在取链之后', () => restoreIntentInvariants(stripComments(tamper(REAL.player,
    '  const restoreTime = canConsumeRestoreSeek && pendingRestoreSeek ? pendingRestoreSeek.time : 0\n  pendingRestoreSeek = null\n',
    '  const restoreTime = canConsumeRestoreSeek && pendingRestoreSeek ? pendingRestoreSeek.time : 0\n'))),
  '无条件清空')

  // t5 play() 不再申请恢复起播（「记住播放进度」整条失效）
  check('t5 play() 未申请恢复起播', () => callSiteInvariants(SRC_FILES, {
    [F.player]: tamper(REAL.player, 'false, undefined, true)', 'false)'),
  }),
  'play() 未开启恢复起播')

  // t5b 别的调用点也申请非 0 起播（切歌主链重新吃旧进度）
  check('t5b 切歌链也申请非 0 起播', () => callSiteInvariants(SRC_FILES, {
    [F.player]: tamper(REAL.player,
      'const debouncePlay = debounceBackgroundTimer((musicInfo: LX.Player.PlayMusic) => {\n  setMusicUrl(musicInfo)',
      'const debouncePlay = debounceBackgroundTimer((musicInfo: LX.Player.PlayMusic) => {\n  setMusicUrl(musicInfo, false, undefined, true)'),
  }),
  '只有 play() 允许')

  // t6 切歌不再复位位置意图（用户报的 bug 原文）
  check('t6 切歌未作废位置意图', () => progressInvariants(stripComments(tamper(REAL.progress,
    '    handlePause()\n    resetTrackPositionIntents()\n',
    '    handlePause()\n'))),
  'handleSetPlayInfo 未调用 resetTrackPositionIntents')

  // t7 复位点挪到早退之后（启动恢复那条路漏清；调用还在，只是位置不对）
  check('t7 复位点在早退之后', () => progressInvariants(stripComments(tamper(tamper(REAL.progress,
    '    handlePause()\n    resetTrackPositionIntents()\n',
    '    handlePause()\n'),
  '    if (isRestoringCurrentMusic()) return\n',
  '    if (isRestoringCurrentMusic()) return\n    resetTrackPositionIntents()\n'))),
  'resetTrackPositionIntents 在 isRestoringCurrentMusic 早退之后')

  // t8 复位集合缺了出声回拉意图（同 id 重播时恢复旧进度）
  check('t8 复位缺出声回拉意图', () => progressInvariants(stripComments(tamper(REAL.progress,
    '    restorePlayTime = null\n    restorePlayTimeTrack = null\n    lastSeekIntentAt = 0\n    pullBackCount = 0\n    engineConfirmedPlaying = false\n    isBufferingHold = false\n',
    '    lastSeekIntentAt = 0\n    pullBackCount = 0\n    engineConfirmedPlaying = false\n    isBufferingHold = false\n'))),
  '出声回拉意图')

  // t9 复位集合缺了 seek 代际（在途 resolve 回来后写旧落点）
  //    锚点带上签名：`seekHoldUntil = 0\n    seekGen++` 在 handleStop 里也有一份（缩进同为 4）
  check('t9 复位缺 seek 代际', () => progressInvariants(stripComments(tamper(REAL.progress,
    'const resetTrackPositionIntents = () => {\n    seekTargetPosition = null\n    seekHoldUntil = 0\n    seekGen++\n',
    'const resetTrackPositionIntents = () => {\n    seekTargetPosition = null\n    seekHoldUntil = 0\n'))),
  'seek 代际')

  // t10 刷新分支退回无条件取引擎位置（错误 / 超时路径把旧歌位置当起播位置）
  check('t10 刷新未过引擎门控', () => refreshGateInvariants(stripComments(tamper(REAL.player,
    'const currentTimePromise = isRefresh && isEngineOnMusic(musicInfo)',
    'const currentTimePromise = isRefresh'))),
  'isEngineOnMusic 门控')

  // t11 引擎判据退回「只看 id 前缀」（两种曲目 id 形态不再分流）
  check('t11 引擎判据缺 nativeflac 分支', () => engineGateInvariants(tamper(REAL.putils,
    'const isNative = trackId.startsWith(\'nativeflac://\')\n',
    ''), REAL.pindex),
  '缺少 const isNative 判据')

  // t12 setProgress 落点回填缺 id 守卫（同一行守卫在别处也有，用 tamperAfter 限定窗口）
  check('t12 落点回填缺 id 守卫', () => progressInvariants(stripComments(tamperAfter(REAL.progress,
    'void setCurrentTime(time).then((targetPosition) => {',
    '      if (playerState.musicInfo.id != musicId) return\n',
    ''))),
  '落点回填缺少 id 守卫')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-cut-song-start-position ===')
console.log('切歌 / 重播一律从头播放：恢复意图开关 + 引擎门控 + 切歌整批复位（第 53 轮第 1 条）')
console.log()

const checks = [
  ['恢复意图（唯一开关 / 两侧 id 非空 / 无条件清空）', () => restoreIntentInvariants(REAL.playerCode)],
  ['全仓调用点（只有 play() 允许非 0 起播）', () => callSiteInvariants(SRC_FILES)],
  ['刷新分支（引擎不在本曲就不沿用位置）', () => refreshGateInvariants(REAL.playerCode)],
  ['引擎判据（isEngineOnMusic：按引擎曲目 id 精确比对）', () => engineGateInvariants(REAL.putils, REAL.pindex)],
  ['切歌整批复位（playProgress：意图 / 窗口 / 快路径门控）', () => progressInvariants(REAL.progressCode)],
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
