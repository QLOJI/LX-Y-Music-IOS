#!/usr/bin/env node
/**
 * sim-url-cache-reuse.js —— 「已取过的链接只要还能用就沿用缓存、不再取链」契约（第 53 轮第 2 条）
 *
 * 用户原话（2026-10-11）：
 *   「播放已获取过歌曲链接的歌曲，如果链接可用，将不再获取歌曲链接，沿用缓存重新播放，
 *     减少获取频次，为接口减轻负担」
 *
 * 这条链的判据只有一个：**非刷新的取链必须先读缓存，命中就一个网络请求都不发**。
 * 本脚本钉三处（漏掉任何一处都会退化成「每次重播都白搭请求」）：
 *
 *   A. 缓存判据前移（src/core/music/online.ts 的 getMusicUrlInfo）
 *      —— 旧顺序是「先 wy 音质详情（fetchAndApplyDetailedQuality，一次真实请求）→ 再查缓存」，
 *      已取过链接的歌每次重播都白搭一次详情请求。现在缓存块排在**所有**网络动作之前
 *      （wy 详情 / 自定义 API / cookie 取流）。等价性：targetQuality 取固定天梯首档
 *      （getPlayQuality 忽略 meta._qualitys），详情回填也不改 id（musicDetail.js 只换 meta），
 *      所以「先算请求档、先查缓存」与旧顺序同解。
 *   B. 坏链必须作废（src/core/music/utils.ts 的 removeMusicUrlAll）
 *      —— 读缓存是两段式：**先按请求档直连，未命中才走「请求档→达成档」映射回退**。
 *      坏链若躺在请求档那个键上会永远首选命中，重取到的好链按达成档另存一条，
 *      于是每次重播都「命中坏链 → 失败 → 再请求一次」。作废必须整首清（含映射键）。
 *      三个作废点：① setMusicUrl 的刷新分支（错误 / 降级 / 25s 超时）；② 预取暖链失败后重取前；
 *      ③ 缓存键前缀必须带尾下划线（`<id>_`），否则同前缀的另一首（abc / abc123）会被误删。
 *   C. 顺序不可颠倒：作废必须 await 完再取链（取链成功会写回缓存，先清后写才成立）。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：清缓存的位置/顺序、缓存块的顺序都不影响类型）。
 * 运行：node scripts/sim-url-cache-reuse.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
// 去注释（字符串感知：`'nativeflac://'` 这类字面量里的 // 不是注释）
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

// 取「marker 之后第一个 { 起、括号配平的一段」，返回 { text, start, end }
const braceSpan = (src, from, openIdx) => {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
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
    else if (ch === '}') { depth--; if (depth === 0) return { text: src.slice(from, i + 1), start: from, end: i } }
  }
  return null
}
const blockFrom = (src, marker) => {
  const at = src.indexOf(marker)
  if (at < 0) return null
  const open = src.indexOf('{', at)
  if (open < 0) return null
  return braceSpan(src, at, open)
}
const bodyOf = (src, signature) => {
  const at = src.indexOf(signature)
  if (at < 0) return null
  const open = src.indexOf('{', at + signature.length)
  if (open < 0) return null
  const span = braceSpan(src, open + 1, open)
  return span ? span.text.slice(1, -1) : null
}
// 【getMusicUrlInfo 的窗口】起点到下一个 `export const`（getMusicUrl 包装）之间：
// 只在这段窗口里做「唯一性」判定与篡改，否则同文件的 getLyricInfo 也有 if (!isRefresh) { 会撞锚点
const ONLINE_FN_START = 'export const getMusicUrlInfo = async('
const ONLINE_FN_END = 'export const getMusicUrl = async(args'
const sliceBetween = (src, startMarker, endMarker) => {
  const a = src.indexOf(startMarker)
  const b = src.indexOf(endMarker)
  if (a < 0 || b < 0 || b <= a) return null
  return src.slice(a, b)
}
const onlineFnWindow = (code) => sliceBetween(code, ONLINE_FN_START, ONLINE_FN_END)

// 反例篡改：锚点必须在全文唯一（String.replace 只换第一处，撞车 = 篡改落在无关代码上）
const tamper = (src, find, replace) => {
  const n = countOf(src, find)
  if (n !== 1) throw new Error(`tamper 锚点不唯一（命中 ${n} 处）: ${JSON.stringify(find.slice(0, 70))}`)
  return src.replace(find, replace)
}

const F = {
  online: 'src/core/music/online.ts',
  putils: 'src/core/music/utils.ts',
  player: 'src/core/player/player.ts',
  preload: 'src/core/init/player/preloadNextMusic.ts',
}
const REAL = {}
for (const [k, f] of Object.entries(F)) REAL[k] = read(f)
for (const k of Object.keys(F)) REAL[k + 'Code'] = stripComments(REAL[k])

// ---------------------------------------------------------------------------
// A. 缓存判据前移：非刷新必须先读缓存，命中即返回
// ---------------------------------------------------------------------------

const cacheFirstInvariants = (code) => {
  const fn = onlineFnWindow(code)
  if (!fn) return ['getMusicUrlInfo 抽取失败（锚点漂移）']
  return cacheFirstChecks(fn)
}

// 传入的必须是 getMusicUrlInfo 的窗口本体（反例直接在窗口上篡改，故与上面分开）
const cacheFirstChecks = (fn) => {
  const reasons = []

  // A1 只允许一个缓存块（重复块 = 旧块没删干净，两处判据会各自漂移）
  const cacheBlocks = countOf(fn.slice(0, fn.indexOf('const highQualityLevels')), 'if (!isRefresh) {')
  if (cacheBlocks !== 1) reasons.push(`缓存块出现 ${cacheBlocks} 处（应恰好 1）`)

  const idxCache = fn.indexOf('if (!isRefresh) {')
  const idxWy = fn.indexOf('fetchAndApplyDetailedQuality(')
  const idxApi = fn.indexOf('handleGetOnlineMusicUrl(')
  const idxCookie = fn.indexOf('wySdk.cookie.getMusicUrl(')
  if (idxCache < 0) {
    reasons.push('非刷新的缓存判据整块消失（每次播放都会重新取链）')
  } else {
    for (const [idx, label] of [
      [idxWy, 'wy 音质详情（fetchAndApplyDetailedQuality）'],
      [idxApi, '自定义 API 取链（handleGetOnlineMusicUrl）'],
      [idxCookie, 'cookie 取链（wySdk.cookie.getMusicUrl）'],
    ]) {
      if (idx >= 0 && idxCache > idx) {
        reasons.push(`缓存判据排在「${label}」之后：缓存命中也白搭一次请求（用户要的是省请求）`)
      }
    }
  }

  // A2 请求档必须能在没有音质详情的情况下算出来（否则前移不成立）
  const idxTarget = fn.indexOf('const targetQuality = quality ?? getPlayQuality(preferredQuality, currentMusicInfo)')
  if (idxTarget < 0) reasons.push('targetQuality 未按「显式档 ?? 固定天梯首档」计算（锚点漂移）')
  else if (idxCache >= 0 && idxTarget > idxCache) {
    reasons.push('targetQuality 在缓存判据之后才算：前移会读到未定义/旧值（等价性不成立）')
  }

  // A3 天梯模式走「直连 + 映射回退」两段式，显式档只直连
  if (!/const cached = quality == null\s*\n\s*\? await getStoreMusicUrlResolved\(currentMusicInfo, targetQuality\)\s*\n\s*: await getStoreMusicUrl\(currentMusicInfo, targetQuality\)\.then\(url => url \? \{ url, quality: targetQuality \} : null\)/.test(fn)) {
    reasons.push('缓存读取不是「天梯=直连+映射回退 / 显式档=只直连」的两段式（显式档可能命中低档缓存，或天梯档键不匹配永远穿透）')
  }

  // A4 命中即返回，且必须带出达成档（供 setLastTryQuality / 音质标用）
  const cb = blockFrom(fn, 'if (!isRefresh) {')
  if (!cb) {
    reasons.push('缓存块抽取失败（锚点漂移）')
  } else {
    if (!/if \(cached\) \{[\s\S]{0,400}?return \{ url: cached\.url, quality: cached\.quality \}/.test(cb.text)) {
      reasons.push('缓存命中未直接返回（带达成档）：命中了还往下走去取链 = 没省到请求')
    }
    if (!/setLastTryQuality\(currentMusicInfo\.id, cached\.quality\)/.test(cb.text)) {
      reasons.push('缓存命中未回填 lastTryQuality（失败降级会从错误档位起跳）')
    }
  }

  // A5 刷新必须穿透缓存
  if (!/if \(!isRefresh\) \{/.test(fn)) reasons.push('缓存判据未按 !isRefresh 门控（刷新重取会命中同一条坏链）')

  return reasons
}

// ---------------------------------------------------------------------------
// B. 坏链作废：整首清（含映射键）+ 三个作废点 + 顺序（await 完再取链）
// ---------------------------------------------------------------------------

const purgeInvariants = (putils, player, preload) => {
  const reasons = []
  const code = stripComments(putils)

  const body = bodyOf(code, 'export const removeMusicUrlAll = async(musicInfo')
  if (!body) {
    reasons.push('removeMusicUrlAll 抽取失败（锚点漂移）')
  } else {
    // B1 两个前缀都要带尾下划线：`<id>_` 保证 id 前缀相同的另一首不会被误删
    for (const [needle, label] of [
      ['`${storageDataPrefix.musicUrl}${musicInfo.id}_`', '直连键前缀（musicUrl + <id>_）'],
      ['`${storageDataPrefix.musicUrl}request_quality__${musicInfo.id}_`', '请求档映射键前缀（request_quality__ + <id>_）'],
    ]) {
      if (!body.includes(needle)) reasons.push(`removeMusicUrlAll 缺少${label}（${needle}）`)
    }
    if (!/startsWith\(prefix\)/.test(body) || !/getAllKeys\(\)/.test(body)) {
      reasons.push('removeMusicUrlAll 未按前缀遍历全部缓存键（只清一条 = 坏链仍会被首选命中）')
    }
    if (!/if \(keys\.length\) await removeDataMultiple\(keys\)/.test(body)) {
      reasons.push('removeMusicUrlAll 未在批量删除前判空（空数组调 remove 的语义由实现决定，先判空更稳）')
    }
  }

  // B2 取链方的作废点 ①：setMusicUrl 的刷新分支
  const playerCode = stripComments(player)
  const pbody = bodyOf(playerCode, 'const invalidateUrlCacheOnRefresh = async(musicInfo')
  if (!pbody) {
    reasons.push('invalidateUrlCacheOnRefresh 抽取失败（锚点漂移）')
  } else {
    if (!/removeMusicUrlAll\(musicInfo\)/.test(pbody)) reasons.push('刷新作废未清本曲缓存')
    if (!/toggleMusicInfo \? removeMusicUrlAll\(toggleMusicInfo\)/.test(pbody)) {
      reasons.push('刷新作废未清「换源目标曲」（getMusicPlayUrl 优先按 meta.toggleMusicInfo 取链，坏链可能挂在那首 id 下）')
    }
  }
  const setBody = bodyOf(playerCode, 'export const setMusicUrl = (musicInfo')
  if (!setBody) reasons.push('setMusicUrl 抽取失败（锚点漂移）')
  else {
    const iPurge = setBody.indexOf('if (isRefresh) await invalidateUrlCacheOnRefresh(musicInfo)')
    const iFetch = setBody.indexOf('getMusicPlayUrl(musicInfo, isRefresh, false, quality)')
    if (iPurge < 0) {
      if (setBody.includes('invalidateUrlCacheOnRefresh(musicInfo)')) {
        reasons.push('刷新分支的作废不是「if (isRefresh) await …」形态（守卫或 await 缺失：不 await 会与随后的 saveMusicUrl 写回竞态，新链接可能被一起删掉）')
      } else {
        reasons.push('刷新分支未作废坏链缓存（下次重播仍首选命中它）')
      }
    } else if (iFetch < 0) reasons.push('刷新分支取链调用抽取失败（锚点漂移）')
    else if (iPurge > iFetch) reasons.push('作废在取链之后（顺序颠倒：先清后写才成立）')
  }

  // B3 取链方的作废点 ②：预取暖链失败后重取前
  const preCode = stripComments(preload)
  const iPrePurge = preCode.indexOf('await removeMusicUrlAll(info.musicInfo)')
  const iPreFetch = preCode.indexOf('const refreshedUrlInfo = await getMusicUrlInfo({ musicInfo: info.musicInfo, isRefresh: true })')
  if (iPrePurge < 0) reasons.push('预取暖链失败后未作废坏链（重取的链接会与坏链键并存）')
  else if (iPreFetch < 0) reasons.push('预取重取调用抽取失败（锚点漂移）')
  else if (iPrePurge > iPreFetch) reasons.push('预取作废在重取之后（顺序颠倒）')

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

  // 篡改只在 getMusicUrlInfo 的窗口里做（窗口外同文件还有 getLyricInfo 的 if (!isRefresh) {）
  const win = onlineFnWindow(REAL.onlineCode)
  if (!win) throw new Error('getMusicUrlInfo 窗口抽取失败（online.ts 结构变了？）')
  const cacheBlock = blockFrom(win, 'if (!isRefresh) {')
  if (!cacheBlock) throw new Error('缓存块锚点未命中（online.ts 结构变了？）')
  const HQ_ANCHOR = '  const highQualityLevels: LX.Quality[]'
  const TQ_LINE = '  const targetQuality = quality ?? getPlayQuality(preferredQuality, currentMusicInfo)\n'
  // 缓存块整段搬到 wy 详情之后（= 第 53 轮修之前的形状）
  const movedBack = tamper(tamper(win, cacheBlock.text, ''), HQ_ANCHOR, cacheBlock.text + '\n' + HQ_ANCHOR)
  const droppedBlock = tamper(win, cacheBlock.text, '')

  // t1 缓存判据退到 wy 详情之后（用户报的 bug 原文：已取过链接的歌每次重播白搭一次请求）
  check('t1 缓存判据退到详情之后', () => cacheFirstChecks(movedBack), '缓存判据排在')

  // t2 缓存块整块消失（每次都重新取链）
  check('t2 缓存判据整块消失', () => cacheFirstChecks(droppedBlock), '缓存判据整块消失')

  // t3 命中后不返回（还往下走）
  check('t3 缓存命中未返回', () => cacheFirstChecks(tamper(win,
    'if (cached) {\n', 'if (cached && false) {\n')), '缓存命中未直接返回')

  // t4 刷新也读缓存（刷新重取会命中同一条坏链）
  check('t4 刷新也读缓存', () => cacheFirstChecks(tamper(win,
    'if (!isRefresh) {\n', 'if (true) {\n')), '未按 !isRefresh 门控')

  // t5 显式档也走带映射的读取（下载指定 flac 会命中 128k 缓存）
  check('t5 显式档也走映射回退', () => cacheFirstChecks(tamper(win,
    '    const cached = quality == null\n      ? await getStoreMusicUrlResolved(currentMusicInfo, targetQuality)\n      : await getStoreMusicUrl(currentMusicInfo, targetQuality).then(url => url ? { url, quality: targetQuality } : null)\n',
    '    const cached = await getStoreMusicUrlResolved(currentMusicInfo, targetQuality).then(url => url ? { url, quality: targetQuality } : null)\n')), '两段式')

  // t6 请求档在缓存判据之后才算（前移读不到目标档）
  check('t6 targetQuality 后算', () => cacheFirstChecks(tamper(tamper(win, TQ_LINE, ''), HQ_ANCHOR, TQ_LINE + HQ_ANCHOR)),
    'targetQuality 在缓存判据之后')

  // t7 作废前缀丢尾下划线（同前缀的另一首被误删）
  check('t7 作废前缀丢尾下划线', () => purgeInvariants(tamper(REAL.putils,
    '`${storageDataPrefix.musicUrl}${musicInfo.id}_`,\n',
    '`${storageDataPrefix.musicUrl}${musicInfo.id}`,\n'), REAL.player, REAL.preload),
    '直连键前缀')

  // t8 只清一条（removeMusicUrlAll 退回 removeMusicUrl 的单键语义）
  check('t8 作废未整首清', () => purgeInvariants(tamper(REAL.putils,
    '`${storageDataPrefix.musicUrl}request_quality__${musicInfo.id}_`,\n',
    ''), REAL.player, REAL.preload),
    '请求档映射键前缀')

  // t9 刷新分支不再作废（用户报的 bug 原文）
  check('t9 刷新未作废坏链', () => purgeInvariants(REAL.putils, tamper(REAL.player,
    'if (isRefresh) await invalidateUrlCacheOnRefresh(musicInfo)',
    'if (false) await invalidateUrlCacheOnRefresh(musicInfo)'), REAL.preload),
    '守卫或 await 缺失')

  // t10 作废与取链顺序颠倒（先取链后清缓存 = 刚拿到的好链被删掉）
  check('t10 作废在取链之后', () => purgeInvariants(REAL.putils, tamper(REAL.player,
    '    if (isRefresh) await invalidateUrlCacheOnRefresh(musicInfo)\n    return getMusicPlayUrl(musicInfo, isRefresh, false, quality)\n',
    '    const _r = await getMusicPlayUrl(musicInfo, isRefresh, false, quality)\n    if (isRefresh) await invalidateUrlCacheOnRefresh(musicInfo)\n    return _r\n'), REAL.preload),
    '作废在取链之后')

  // t13 作废不 await（与随后的 saveMusicUrl 写回竞态）
  check('t13 作废不 await', () => purgeInvariants(REAL.putils, tamper(REAL.player,
    'if (isRefresh) await invalidateUrlCacheOnRefresh(musicInfo)',
    'if (isRefresh) void invalidateUrlCacheOnRefresh(musicInfo)'), REAL.preload),
    '守卫或 await 缺失')

  // t11 作废只清本曲不清换源目标曲
  check('t11 作废漏换源目标曲', () => purgeInvariants(REAL.putils, tamper(REAL.player,
    '    toggleMusicInfo ? removeMusicUrlAll(toggleMusicInfo).catch(() => {}) : Promise.resolve(),\n',
    ''), REAL.preload),
    '换源目标曲')

  // t12 预取暖链失败不清坏链
  check('t12 预取失败未作废坏链', () => purgeInvariants(REAL.putils, REAL.player, tamper(REAL.preload,
    '      await removeMusicUrlAll(info.musicInfo).catch(() => {})\n',
    '')), '预取暖链失败后未作废坏链')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-url-cache-reuse ===')
console.log('链接可沿用则不再取链：缓存判据前移 + 坏链整首作废 + 先清后取（第 53 轮第 2 条）')
console.log()

const checks = [
  ['缓存判据前移（非刷新先读缓存、命中即返回）', () => cacheFirstInvariants(REAL.onlineCode)],
  ['坏链作废（整首清 + 三个作废点 + 顺序）', () => purgeInvariants(REAL.putils, REAL.player, REAL.preload)],
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
