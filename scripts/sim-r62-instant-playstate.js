/**
 * sim-r62-instant-playstate.js —— 「播放/暂停按钮按下即翻，只有声音渐入渐出」（第 62 轮第 3 条）
 * 与「暂停时迷你播放器的歌词区不再空白」（第 62 轮·追加）契约。
 *
 * 需求原话（2026-10-11 第 62 轮）：
 *   「3、播放/暂停按钮点击不应该有渐入渐出的动画延迟变化，只是音乐有渐入渐出的效果，
 *     不论是迷你播放器、播放详情页、锁屏和灵动岛界面的播放/暂停按钮的点击动画不应该有延迟，
 *     只是声音会有。」
 *   「暂停时，迷你播放器栏的歌词区域显示空白，改为正常显示当前加载歌词」
 *
 * 根因（按下 → 图标变）：
 *   `togglePlay → setPause()` 里 `fadeOutThenPause(pausePlayingEngines)` 要等 300ms 的
 *   渐出斜坡跑完才真暂停，UI 的播放态却要等引擎发出 'paused' 事件才由
 *   `controller.ts` 的 `global.app_event.pause()` → `setIsPlay(false)` 翻 —— 用户按下
 *   暂停键后，图标/锁屏/灵动岛要慢半拍（≈300ms + 一次事件往返）才变。播放方向同理
 *   （引擎跨过出声门槛才发 'playing'）。
 *
 * 本轮口径（src/plugins/player/utils.ts）：
 *   ① `setPlay`：先取一次快照 `const resuming = !playerState.isPlay`（**必须在翻 UI 之前**，
 *      否则第 58 轮那条「已在播不预约渐入」的闸门会把自己吃掉），`if (resuming) armVolumeFadeIn()`
 *      预约渐入，随后 `setIsPlay(true)` + `playNowPlaying()` 立刻翻转本地与系统播放态，
 *      最后才轮到引擎 `resumeNativeFlacPlayback()` / `TrackPlayer.play()`。
 *      闸门用 resuming（不是 isPlay）：混音重取阶梯进来时 isPlay 恒为 true，不重复发布、
 *      不多做一次元数据桥往返。
 *   ② `setPause`：`const token = ++pauseVerifyToken` 之后、任何渐出动作之前，
 *      `if (playerState.isPlay) { setIsPlay(false); pauseNowPlaying({ playbackRate: 0 }) }`
 *      按下即翻；渐出与真暂停照旧异步跑完（声音才有渐变）。
 *   ③ 第 47 轮那次「暂停后 300ms 复核」的门控**只看 token**，不许再看 `playerState.isPlay`
 *      —— UI 既然按下即翻，那一刻起 isPlay 恒为 false，旧闸门会让复核永远早退。
 *   ④ Status.tsx：`const status = statusText || text`（瞬时状态文案 > 当前歌词行），
 *      且不再订阅 `useIsPlay` —— 旧写法 `statusText || (isPlay ? text : statusText)`
 *      在暂停时落到空串，迷你播放器的歌词区整行空白。
 *
 * 为什么必须靠契约脚本：这些都是「谁先谁后」的顺序与「闸门读哪个变量」，删掉一行翻转、
 * 把 setIsPlay 挪到引擎调用之后、或把旧闸门写回去，tsc/eslint 全绿（本工程根本没有
 * tsc/eslint/Xcode），真机上就是「图标慢半拍」「重取阶梯被自己掐掉渐入」。带反例自检。
 *
 * 运行：node scripts/sim-r62-instant-playstate.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** 去块注释与整行 `//` 注释（保留行尾注释；断言锚点全都不是注释） */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  utils: 'src/plugins/player/utils.ts',
  status: 'src/components/player/PlayerBar/components/Status.tsx',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

/** 取一个 `export const NAME = async() => {` 的函数体（到下一个行首 `\n}` 为止） */
const arrowBody = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  const rest = src.slice(start)
  const end = /\n\}\n/.exec(rest)
  return end ? rest.slice(0, end.index + 3) : null
}

// ---------------------------------------------------------------------------
// 不变量 A：setPlay 按下即翻（且闸门先于翻转求值）
// ---------------------------------------------------------------------------

const setPlayInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  if (!code.includes("import { setIsPlay } from '@/core/player/playStatus'")) {
    reasons.push('utils.ts 没引入 setIsPlay（UI 播放态翻不了）')
  }
  if (!code.includes("import { pauseNowPlaying, playNowPlaying } from '@/utils/nativeModules/nowPlaying'")) {
    reasons.push('utils.ts 没引入 playNowPlaying / pauseNowPlaying（锁屏与灵动岛不能同刻发布）')
  }

  const body = arrowBody(code, 'export const setPlay = async() => {')
  if (body == null) {
    reasons.push('setPlay 缺失（找不到函数体）')
    return reasons
  }

  if (!body.includes('pauseVerifyToken++')) {
    reasons.push('setPlay 没有作废在途的暂停复核（pauseVerifyToken++，第 47 轮口径）')
  }

  const gateAt = body.indexOf('const resuming = !playerState.isPlay')
  if (gateAt < 0) {
    reasons.push('setPlay 没有取「是否真·恢复播放」的一次快照（const resuming = !playerState.isPlay）')
  }
  const armAt = body.indexOf('if (resuming) armVolumeFadeIn()')
  if (armAt < 0) {
    reasons.push('setPlay 没有预约渐入（if (resuming) armVolumeFadeIn()）')
  }
  const flipBlock = '  if (resuming) {\n    setIsPlay(true)\n    void playNowPlaying().catch(() => {})\n  }'
  if (!body.includes(flipBlock)) {
    reasons.push('setPlay 没有「按下即翻」块（setIsPlay(true) + playNowPlaying()，且闸门必须是 resuming）')
  }
  // 顺序判定取**第一次** setIsPlay(true) 的位置：翻转块挪到别处（哪怕还留着同样形状的一份）
  // 也算「翻早了 / 翻晚了」。
  const flipAt = body.indexOf('setIsPlay(true)')
  // 引擎调用点用 `resumeNativeFlacPlayback()` 定位（不绑具体的 if 形状）：
  // 顺序判定要的是「谁先谁后」，分支怎么写不该影响结论。
  const engineAt = body.indexOf('resumeNativeFlacPlayback()')
  if (engineAt < 0 || !body.includes('return resumeNativeFlacPlayback()')) {
    reasons.push('setPlay 丢失 nativeFlac 恢复分支（resumeNativeFlacPlayback）')
  }
  // 早退形态也要绑：只有「先翻 UI、再直接 return 引擎」才保证两条路径（iOS 原生流 /
  // TrackPlayer）都在**同一个时刻**翻过 UI。把它改写成「进分支里再翻」就漏了另一条路径。
  if (!body.includes("if (Platform.OS == 'ios' && isNativeFlacActive()) return resumeNativeFlacPlayback()")) {
    reasons.push('setPlay 的 nativeFlac 分支不再是「先翻 UI、再早退」的形态（另一条路径会漏翻）')
  }
  const trackAt = body.indexOf('return TrackPlayer.play()')
  if (trackAt < 0) {
    reasons.push('setPlay 丢失 TrackPlayer.play() 分支（非 nativeFlac 路径没人放）')
  }
  if (flipAt >= 0 && engineAt >= 0 && flipAt > engineAt) {
    reasons.push('setPlay 的翻转块落在引擎调用之后（图标又慢半拍，正是第 62 轮投诉）')
  }
  if (flipAt >= 0 && trackAt >= 0 && flipAt > trackAt) {
    reasons.push('setPlay 的翻转块落在 TrackPlayer.play() 之后（非原生流路径图标慢半拍）')
  }
  if (gateAt >= 0 && flipAt >= 0 && gateAt > flipAt) {
    reasons.push('setPlay 的快照落在翻转之后（翻完再读 isPlay 恒为 true ⇒ 渐入预约被自己吃掉，第 58 轮回归）')
  }
  if (gateAt >= 0 && armAt >= 0 && gateAt > armAt) {
    reasons.push('setPlay 的渐入预约先于快照求值（快照必须是第一读）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：setPause 按下即翻 + 复核只认 token
// ---------------------------------------------------------------------------

const setPauseInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  const body = arrowBody(code, 'export const setPause = async() => {')
  if (body == null) {
    reasons.push('setPause 缺失（找不到函数体）')
    return reasons
  }

  if (!body.includes('const token = ++pauseVerifyToken')) {
    reasons.push('setPause 没有登记复核令牌（const token = ++pauseVerifyToken）')
  }
  const flipBlock = '  if (playerState.isPlay) {\n    setIsPlay(false)\n    void pauseNowPlaying({ playbackRate: 0 }).catch(() => {})\n  }'
  const flipAt = body.indexOf(flipBlock)
  if (flipAt < 0) {
    reasons.push('setPause 没有「按下即翻」块（setIsPlay(false) + pauseNowPlaying({ playbackRate: 0 })）')
  }
  const fadeAt = body.indexOf('fadeOutThenPause(pausePlayingEngines)')
  if (fadeAt < 0) {
    reasons.push('setPause 没有走 fadeOutThenPause(pausePlayingEngines)（声音会硬切出爆音）')
  } else if (flipAt >= 0 && flipAt > fadeAt) {
    reasons.push('setPause 的翻转块落在渐出之后（图标要等 300ms，正是第 62 轮投诉）')
  }
  if (!body.includes('if (token != pauseVerifyToken) return')) {
    reasons.push('setPause 的复核没有 token 门控（窗口内又按播放会把刚起来的播放按停）')
  }
  if (body.includes('if (token != pauseVerifyToken || !playerState.isPlay) return')) {
    reasons.push('setPause 的复核又读回 playerState.isPlay（UI 按下即翻后恒为 false ⇒ 第 47 轮兜底永远早退）')
  }
  if (!body.includes('void pausePlayingEngines()')) {
    reasons.push('setPause 的复核没做真·暂停兜底（pausePlayingEngines）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：迷你播放器歌词区与播放态解耦
// ---------------------------------------------------------------------------

const statusInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  if (!code.includes('const status = statusText || text')) {
    reasons.push('Status.tsx 的文案不是 `statusText || text`（暂停时歌词区会空）')
  }
  if (code.includes('useIsPlay')) {
    reasons.push('Status.tsx 又在订阅播放态（useIsPlay）—— 歌词文案与播放态无关，多一次重渲染')
  }
  if (code.includes('isPlay ? text : statusText')) {
    reasons.push('Status.tsx 又用回 `isPlay ? text : statusText`（暂停时整行空白，第 62 轮原样回归）')
  }
  if (!code.includes('const { text } = useLrcPlay(autoUpdate)')) {
    reasons.push('Status.tsx 没接歌词行（useLrcPlay）')
  }
  if (!code.includes('const statusText = useStatusText()')) {
    reasons.push('Status.tsx 没接瞬时状态文案（useStatusText）—— 「缓存中…」这类提示会丢')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------

const runCounterExamples = () => {
  const results = []
  const ce = (name, detail, ok) => results.push({ name, detail, ok: !!ok })
  const utils = REAL.utils
  const status = REAL.status

  // a1 迷你播放器退回旧的三元（暂停即空白）
  const a1 = status.replace('const status = statusText || text', 'const status = statusText || (isPlay ? text : statusText)')
  ce('a1 歌词区退回 isPlay 三元', '暂停时歌词区空白',
    a1 !== status && statusInvariants(a1).some((r) => r.includes('isPlay ? text : statusText')))

  // a2 setPlay 摘掉「按下即翻」
  const a2 = utils.replace(
    '  if (resuming) {\n    setIsPlay(true)\n    void playNowPlaying().catch(() => {})\n  }\n',
    '',
  )
  ce('a2 setPlay 摘掉按下即翻', '点了播放键图标慢半拍',
    a2 !== utils && setPlayInvariants(a2).some((r) => r.includes('按下即翻')))

  // a3 setPlay 把翻转挪到引擎调用之后（顺序反了 —— 图标仍要等出声门槛）
  const a3 = utils.replace(
    "  if (resuming) {\n    setIsPlay(true)\n    void playNowPlaying().catch(() => {})\n  }\n  if (Platform.OS == 'ios' && isNativeFlacActive()) return resumeNativeFlacPlayback()",
    "  if (Platform.OS == 'ios' && isNativeFlacActive()) {\n    const played = await resumeNativeFlacPlayback()\n    if (resuming) {\n      setIsPlay(true)\n      void playNowPlaying().catch(() => {})\n    }\n    return played\n  }\n  if (resuming) {\n    setIsPlay(true)\n    void playNowPlaying().catch(() => {})\n  }",
  )
  const a3Reasons = a3 === utils ? ['（tamper 没打上）'] : setPlayInvariants(a3)
  ce('a3 setPlay 翻转挪到引擎之后', `图标仍要等出声门槛；reasons=${JSON.stringify(a3Reasons)}`,
    a3 !== utils && a3Reasons.some((r) => r.includes('落在引擎调用之后')))

  // a4 setPlay 先把 UI 翻掉、快照落在后面（第 58 轮渐入预约被自己吃掉）
  const a4 = utils.replace(
    'export const setPlay = async() => {\n  // 【第 47 轮】用户的播放意图作废在途的暂停复核（PAUSE_VERIFY_MS 窗口内按下的播放\n  // 优先，复核绝不允许把刚起来的播放又按停）。\n  pauseVerifyToken++',
    'export const setPlay = async() => {\n  pauseVerifyToken++\n  if (!playerState.isPlay) {\n    setIsPlay(true)\n    void playNowPlaying().catch(() => {})\n  }',
  )
  ce('a4 setPlay 快照挪到翻转之后', '重取阶梯被自己掐掉渐入（第 58 轮回归）',
    a4 !== utils && setPlayInvariants(a4).some((r) => r.includes('快照落在翻转之后')))

  // a5 setPause 摘掉「按下即翻」
  const a5 = utils.replace(
    '  if (playerState.isPlay) {\n    setIsPlay(false)\n    void pauseNowPlaying({ playbackRate: 0 }).catch(() => {})\n  }\n',
    '',
  )
  ce('a5 setPause 摘掉按下即翻', '暂停图标要等 300ms 渐出',
    a5 !== utils && setPauseInvariants(a5).some((r) => r.includes('按下即翻')))

  // a6 setPause 复核读回 isPlay（第 47 轮兜底永远早退）
  const a6 = utils.replace('if (token != pauseVerifyToken) return', 'if (token != pauseVerifyToken || !playerState.isPlay) return')
  ce('a6 复核读回 isPlay', '点了暂停声音还在放时没人兜底',
    a6 !== utils && setPauseInvariants(a6).some((r) => r.includes('复核又读回 playerState.isPlay')))

  // a7 翻转块挪到渐出之后
  const a7 = utils.replace(
    '  if (playerState.isPlay) {\n    setIsPlay(false)\n    void pauseNowPlaying({ playbackRate: 0 }).catch(() => {})\n  }\n  if (Platform.OS != \'ios\') return fadeOutThenPause(pausePlayingEngines)',
    '  if (Platform.OS != \'ios\') return fadeOutThenPause(pausePlayingEngines)\n  if (playerState.isPlay) {\n    setIsPlay(false)\n    void pauseNowPlaying({ playbackRate: 0 }).catch(() => {})\n  }',
  )
  ce('a7 setPause 翻转挪到渐出之后', '暂停图标慢半拍',
    a7 !== utils && setPauseInvariants(a7).some((r) => r.includes('落在渐出之后')))

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-r62-instant-playstate ===')

const checks = [
  ['setPlay 按下即翻（utils.ts）', () => setPlayInvariants(REAL.utils)],
  ['setPause 按下即翻 + 复核只认 token（utils.ts）', () => setPauseInvariants(REAL.utils)],
  ['迷你播放器歌词区与播放态解耦（Status.tsx）', () => statusInvariants(REAL.status)],
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
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.ok ? '已拦下' : `未拦下（reasons=${JSON.stringify(r.detail)}）`}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
