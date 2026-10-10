#!/usr/bin/env node
/**
 * sim-nowplaying-startup-duration.js
 *
 * 「起播第 0 帧，锁屏 / 灵动岛的进度条与时间就要能显示」契约不变量
 * （第 48 轮第 1 条，2026-10-10）。
 *
 * 用户原话（第 48 轮第 1 条）：
 *   「歌曲刚开始播放时，锁屏界面的歌曲进度、歌词、歌曲时间显示都不显示，要等到第一句歌词
 *     加载时，直接就跳到了0:14位置，请修复这个问题，确保锁屏界面的歌曲进度、歌词、歌曲时间
 *     实时显示没有延迟」。
 *
 * 机制（iOS 系统卡片）：`MPNowPlayingInfoCenter` 的进度条必须**先知道总时长**
 * （`MPMediaItemPropertyPlaybackDuration`）才画得出来 —— 缺省或为 0 时，锁屏 / 控制中心
 * 左右两侧一律渲染 `-:--`，而且整条进度条**不可拖动**（手指位置换算不成时间点，这也是第 48
 * 轮第 2 条「无法拖动进度条调节播放时间」的一半）。
 *
 * 病根：起播首发发布时 `duration` 是 0 / undefined ——
 *   ① `src/plugins/player/engine/resourceLoader.ts` 的 nativeFlac 流式分支拿
 *      `startNativeFlacPlayback` 的返回值，而这条路径的**引擎时长恒为 0**；
 *   ② iOS 的 `buildTracks` 不带 `duration`（引擎时长要等 load/seek 之后才稳定），
 *      AVPlayer 分支首发同样是 undefined；
 *   ③ `src/plugins/player/playList.ts` 的 `updateMetaInfo` 旧写法发 `state.prevDuration || 0`，
 *      而 `prevDuration` 要靠一次 `getTrackDuration() / getNativeFlacDuration()` 桥接往返才
 *      解析出来（`clearTracks` 先置 -1）—— 首次发布时它还是 0。
 * 于是从起播到第一句歌词（用户那首歌是 0:14）那次发布之间，卡片只有一个不动的 `-:--`；
 * 歌词那次发布顺带把已解析好的时长带上去，整块信息「啪」地跳出来 —— 正是用户描述的现象。
 *
 * 本契约把「时长三级兜底」钉成不变量：
 *   A. 起播首发（resourceLoader 两条路径）：引擎正时长优先，否则**元数据 interval**
 *      （纯 JS 数据，起播第 0 帧即知）；
 *   B. 元数据发布（playList）：duration 必须走 `resolveMetadataDuration` 的三级链
 *      （引擎时长 → 进度模块 maxPlayTime → `getTimelineDuration`/interval），不得再发 `|| 0`；
 *   C. 唯一发布漏斗（trackPlayerCore.updateCurrentTrackMetadata，iOS Now Playing 的**唯一**
 *      出口）：非有限正数时用 interval 补齐 —— 上游任一条通路漏了都在这里兜住；
 *   D. 原生守卫（AppDelegate.LXSetNowPlayingInfo）：时长**只进不退** —— 已知的正时长不得被
 *      一次迟到的 0 抹掉（换封面重发 / 逐行歌词重发都可能带着 0 过来）；但**换歌**
 *      （标题变化）与缓存里还没有这个键时必须照写，否则新歌永远学不到自己的时长。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：把兜底换成 `|| 0` 完全合法，只在真机上表现为
 * 「锁屏一直 -:--，到第一句歌词才跳出来」）。
 * 运行：node scripts/sim-nowplaying-startup-duration.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  appdel: 'ios/LxMusicMobile/AppDelegate.mm',
  resourceLoader: 'src/plugins/player/engine/resourceLoader.ts',
  playList: 'src/plugins/player/playList.ts',
  trackPlayerCore: 'src/plugins/player/trackPlayerCore.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// 从源码抽出「以 signature 开头、后接大括号体」的函数体（按大括号配平）。
// AppDelegate.mm 顶部有成批前置声明（签名一字不差），所以只认「后面紧跟 `{`」的那一处。
const braceBodyFrom = (src, braceStart) => {
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(braceStart, i + 1)
    }
  }
  return null
}

const extractBracedBody = (src, signature) => {
  let start = src.indexOf(signature)
  while (start >= 0) {
    const after = src.slice(start + signature.length)
    if (/^\s*\{/.test(after)) {
      return braceBodyFrom(src, start + signature.length + after.indexOf('{'))
    }
    start = src.indexOf(signature, start + 1)
  }
  return null
}

// 参数里本身就是对象类型字面量（`async(metadata: { … }) => { … }`）的箭头函数：
// 只用 extractBracedBody 会先撞上类型字面量的 `{`（抽出来是一段类型声明，不是函数体），
// 所以先锚定 `\n}) => {` 再配平。
const extractAsyncArrowBody = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  const marker = src.indexOf('\n}) => {', start)
  if (marker < 0) return null
  return braceBodyFrom(src, marker + '\n}) => '.length)
}

// ---------------------------------------------------------------------------
// 不变量 A：起播首发两条路径各自带元数据 interval 兜底
// ---------------------------------------------------------------------------

const startupInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!/import \{ getMusicIntervalDuration \} from '@\/core\/player\/timeline'/.test(code)) {
    reasons.push('resourceLoader 未引入 getMusicIntervalDuration（起播首发拿不到元数据 interval 这个纯 JS 时长源）')
  }
  // nativeFlac 流式分支：引擎时长恒为 0，必须退回 interval
  if (!/duration: playbackInfo\.duration > 0 \? playbackInfo\.duration : getMusicIntervalDuration\(musicInfo\),/.test(code)) {
    reasons.push('nativeFlac 起播首发未带时长兜底（该路径引擎时长恒为 0 ⇒ 系统按「总时长未知」渲染：锁屏左右两侧 -:--、进度条不可拖，要等第一句歌词那次发布才整块跳出）')
  }
  // AVPlayer 分支：iOS 的 buildTracks 不带 duration，首发同样是 undefined
  if (!/duration: typeof track\.duration == 'number' && track\.duration > 0 \? track\.duration : getMusicIntervalDuration\(musicInfo\),/.test(code)) {
    reasons.push('AVPlayer 起播首发未带时长兜底（buildTracks 在 iOS 上不带 duration ⇒ 首发 undefined，同样是 -:--）')
  }
  // 反向：不许退回「直接把引擎值发出去」
  if (/duration: playbackInfo\.duration,/.test(code)) {
    reasons.push('nativeFlac 起播首发退回直发引擎时长（流式路径恒为 0 = 用户第 48 轮第 1 条那张 -:-- 卡片）')
  }
  if (/duration: track\.duration,/.test(code)) {
    reasons.push('AVPlayer 起播首发退回直发 track.duration（iOS 上首发通常是 undefined = 用户第 48 轮第 1 条那张 -:-- 卡片）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：元数据发布走 resolveMetadataDuration 三级链，不再发 `|| 0`
// ---------------------------------------------------------------------------

const metaPublishInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!/duration: resolveMetadataDuration\(state\.prevDuration\),/.test(code)) {
    reasons.push('updateMetaInfo 未走 resolveMetadataDuration 发布时长（首次发布时 prevDuration 还是 0 / -1，直接发出去就是「总时长未知」）')
  }
  if (/duration: state\.prevDuration \|\| 0/.test(code)) {
    reasons.push('updateMetaInfo 退回 `state.prevDuration || 0`（首次发布发 0 ⇒ 锁屏 -:--，到第一句歌词才整块跳出来 —— 用户第 48 轮第 1 条原样复现）')
  }
  // 三级链本身：引擎时长 → 进度模块 maxPlayTime → 元数据 interval（getTimelineDuration 的尾巴）
  const chain = extractBracedBody(code, 'const resolveMetadataDuration = (duration: number) =>')
  if (!chain) {
    reasons.push('resolveMetadataDuration 抽取失败（锚点漂移）')
  } else {
    if (!/if \(duration > 0\) return duration/.test(chain)) {
      reasons.push('resolveMetadataDuration 第一级没了（引擎时长优先）')
    }
    if (!/if \(playerState\.progress\.maxPlayTime > 0\) return playerState\.progress\.maxPlayTime/.test(chain)) {
      reasons.push('resolveMetadataDuration 第二级没了（进度模块 maxPlayTime 兜底）')
    }
    if (!/return getTimelineDuration\(playerState\.playMusicInfo\.musicInfo, duration\)/.test(chain)) {
      reasons.push('resolveMetadataDuration 第三级没了（元数据 interval 兜底 —— 它是唯一在起播第 0 帧就已知的时长源，删了这条链就兜不住 nativeFlac 的恒 0 引擎时长）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：唯一发布漏斗（trackPlayerCore.updateCurrentTrackMetadata）兜底
// ---------------------------------------------------------------------------

const funnelInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)
  const body = extractAsyncArrowBody(code, 'export const updateCurrentTrackMetadata = async(metadata: ')
  if (!body) {
    reasons.push('updateCurrentTrackMetadata 抽取失败（锚点漂移）')
    return reasons
  }
  if (!/import playerState from '@\/store\/player\/state'/.test(code) ||
      !/import \{ getMusicIntervalDuration \} from '@\/core\/player\/timeline'/.test(code)) {
    reasons.push('发布漏斗未引入兜底所需模块（playerState / getMusicIntervalDuration）')
  }
  if (!/const currentDuration = typeof nowPlayingMetadata\.duration == 'number' && Number\.isFinite\(nowPlayingMetadata\.duration\)/.test(body)) {
    reasons.push('发布漏斗不再校验 duration 是否为有限正数（fail-open：0 / undefined / NaN 会直接发给系统）')
  }
  if (!/if \(!\(currentDuration > 0\)\) \{\s*const fallbackDuration = getMusicIntervalDuration\(playerState\.playMusicInfo\.musicInfo\)\s*if \(fallbackDuration > 0\) nowPlayingMetadata\.duration = fallbackDuration\s*\}/.test(body)) {
    reasons.push('发布漏斗的时长兜底块没了（updateCurrentTrackMetadata 是 iOS Now Playing 的唯一出口：上游任一条通路漏带时长，这里不补就漏到卡片上 = -:--）')
  }
  if (!/await updateNowPlayingInfo\(nowPlayingMetadata\)/.test(body)) {
    reasons.push('发布漏斗不再调用 updateNowPlayingInfo（iOS Now Playing 唯一写入点被绕过）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：原生「时长只进不退」守卫（含换歌必须重学）
// ---------------------------------------------------------------------------

const nativeGuardInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)
  const body = extractBracedBody(code, 'static void LXSetNowPlayingInfo(NSDictionary *metadata)')
  if (!body) {
    reasons.push('LXSetNowPlayingInfo 抽取失败（锚点漂移）')
    return reasons
  }
  const stamp = body.indexOf('BOOL durationIsUsable')
  if (stamp < 0) {
    reasons.push('原生时长守卫没了（durationIsUsable）：一次迟到的 duration = 0 发布就能把已画出来的进度条打回 -:--')
  } else {
    if (!/duration\.doubleValue > 0/.test(body)) {
      reasons.push('原生时长守卫不再接受正时长（换歌 / 引擎补报都会写不进去）')
    }
    if (!/isNewSong/.test(body.slice(stamp, stamp + 200))) {
      reasons.push('原生时长守卫漏了 isNewSong：**换歌**时新歌的时长学不进来（标题变化必须无条件重学，否则新歌一路 -:--）')
    }
    if (!/info\[MPMediaItemPropertyPlaybackDuration\] == nil/.test(body.slice(stamp, stamp + 200))) {
      reasons.push('原生时长守卫漏了「缓存里还没有这个键」这一支：首帧时长写不进去')
    }
    if (!/if \(durationIsUsable\) info\[MPMediaItemPropertyPlaybackDuration\] = duration;/.test(body)) {
      reasons.push('原生时长守卫没有真正挡在赋值前（赋值必须包在 if (durationIsUsable) 里）')
    }
  }
  if (!/BOOL isNewSong = title != nil && previousTitle != nil && !\[title isEqualToString:previousTitle\];/.test(body)) {
    reasons.push('换歌判定 isNewSong 被改写 / 删除（时长守卫的第一支判据失真）')
  }
  const usableCount = (body.match(/BOOL durationIsUsable/g) ?? []).length
  if (usableCount !== 1) {
    reasons.push(`durationIsUsable 在 LXSetNowPlayingInfo 里出现 ${usableCount} 次（应为 1）`)
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

  // d1 nativeFlac 起播首发退回直发引擎时长（恒 0）
  check('d1 nativeFlac 首发直发引擎时长', () => startupInvariants(tamper(REAL.resourceLoader,
    '          duration: playbackInfo.duration > 0 ? playbackInfo.duration : getMusicIntervalDuration(musicInfo),',
    '          duration: playbackInfo.duration,')),
  'nativeFlac 起播首发未带时长兜底')

  // d2 AVPlayer 起播首发退回 undefined
  check('d2 AVPlayer 首发直发 track.duration', () => startupInvariants(tamper(REAL.resourceLoader,
    '    duration: typeof track.duration == \'number\' && track.duration > 0 ? track.duration : getMusicIntervalDuration(musicInfo),',
    '    duration: track.duration,')),
  'AVPlayer 起播首发未带时长兜底')

  // d3 元数据发布退回 `state.prevDuration || 0`（用户报的 bug 原文）
  check('d3 发布退回 prevDuration || 0', () => metaPublishInvariants(tamper(REAL.playList,
    '    duration: resolveMetadataDuration(state.prevDuration),',
    '    duration: state.prevDuration || 0,')),
  '用户第 48 轮第 1 条原样复现')

  // d4 三级链被砍掉第三级（元数据 interval —— 唯一第 0 帧已知的时长源）
  check('d4 三级链砍掉 interval 兜底', () => metaPublishInvariants(tamper(REAL.playList,
    '  if (playerState.progress.maxPlayTime > 0) return playerState.progress.maxPlayTime\n  return getTimelineDuration(playerState.playMusicInfo.musicInfo, duration)',
    '  if (playerState.progress.maxPlayTime > 0) return playerState.progress.maxPlayTime\n  return duration')),
  '第三级没了')

  // d5 发布漏斗的时长兜底被拆
  check('d5 漏斗兜底被拆', () => funnelInvariants(tamper(REAL.trackPlayerCore,
    '    if (!(currentDuration > 0)) {\n      const fallbackDuration = getMusicIntervalDuration(playerState.playMusicInfo.musicInfo)\n      if (fallbackDuration > 0) nowPlayingMetadata.duration = fallbackDuration\n    }\n',
    '')),
  '发布漏斗的时长兜底块没了')

  // d6 原生守卫被拆（退回无条件写）
  check('d6 原生守卫被拆', () => nativeGuardInvariants(tamper(REAL.appdel,
    '    BOOL durationIsUsable = duration != nil &&\n      (duration.doubleValue > 0 || isNewSong || info[MPMediaItemPropertyPlaybackDuration] == nil);\n    if (durationIsUsable) info[MPMediaItemPropertyPlaybackDuration] = duration;',
    '    if (duration != nil) info[MPMediaItemPropertyPlaybackDuration] = duration;')),
  '原生时长守卫没了')

  // d7 守卫收窄成「只认正时长」（换歌学不到新时长 → 新歌一路 -:--）
  check('d7 守卫漏掉换歌重学', () => nativeGuardInvariants(tamper(REAL.appdel,
    '      (duration.doubleValue > 0 || isNewSong || info[MPMediaItemPropertyPlaybackDuration] == nil);',
    '      (duration.doubleValue > 0);')),
  '漏了 isNewSong')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-nowplaying-startup-duration ===')
console.log('起播第 0 帧的时长可达性：首发两条路径 / 元数据发布三级链 / 发布漏斗 / 原生只进不退（第 48 轮第 1 条）')
console.log()

const checks = [
  ['起播首发（resourceLoader 两条路径各自带 interval 兜底）', () => startupInvariants(REAL.resourceLoader)],
  ['元数据发布（updateMetaInfo 走 resolveMetadataDuration 三级链）', () => metaPublishInvariants(REAL.playList)],
  ['唯一发布漏斗（trackPlayerCore 补齐非正时长）', () => funnelInvariants(REAL.trackPlayerCore)],
  ['原生守卫（LXSetNowPlayingInfo 时长只进不退 + 换歌重学）', () => nativeGuardInvariants(REAL.appdel)],
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
