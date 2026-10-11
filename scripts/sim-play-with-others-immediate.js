#!/usr/bin/env node
/**
 * sim-play-with-others-immediate.js —— 「与其他应用同时播放」勾选 / 取消勾选**立即生效**
 * 契约（用户 2026-10-11 第 56 轮第 3 条）。
 *
 * 需求原话（逐字）：
 *   「……而且当我勾选上"与其他应用同时播放"选项不会立即配置好，而是需要下首歌才执行，
 *     应改为勾选上就立即执行设置，取消灵动岛占用，取消勾选就立即占用灵动岛，取消和勾选
 *     会自动暂停播放歌曲。」
 *
 * 拆成四件事，本脚本各钉一条：
 *   (a) 静态策略标记照旧下发（第 24 轮口径，不能因为改成立即生效就把它删了 —— 标记是
 *       打断分支 shouldEmitPause 的唯一依据，丢了就是「勾选后卡片 / 灵动岛又被摘掉」）。
 *   (b) 立即执行：不再等「下一首 / 下一次 prepareAudioSession」，当场调
 *       applyPlayWithOthersNow 重配音频会话（原生侧带安全闸门，见下）。
 *   (c) 占用 / 退出占用：会话口径（混音 ⇄ 独占 + LongFormAudio）就是系统据以决定
 *       锁屏卡片与灵动岛占用的状态，切换当场落下；「只关灵动岛、保留锁屏」这种粒度
 *       iOS 没有公开 API（第 34 轮定案），代码不硬做系统 UI。
 *   (d) 切换即暂停：**值真的变了**才停（冷启动 initial 的首次下发、任何幂等重复下发都不算），
 *       且停在最后一步（先把会话口径与卡片对齐，再走 utils 的 setPause = 先渐出再停，
 *       第 39/47 轮口径）—— 用户原话「取消和勾选会自动暂停播放歌曲」。
 *
 * 为什么必须靠契约脚本：这四条全是运行期语义（谁先谁后、幂等、闸门），tsc / eslint 全合法。
 * 曾经踩过的形状：把 `lastAppliedPlayWithOthers = enabled` 写在 `switched` 计算之前（恒 false，
 * 勾选永不暂停）、把暂停块挪到元数据重发布之前（卡片带着旧口径发出去）、设置页顺手
 * reloadConfig()（第 24 轮实锤：激活态会话重设分类 ⇒ 卡片消失 / 有进度没声音）。三条都有反例。
 *
 * 原生的安全闸门（本脚本只查形状，理由写在 AppDelegate.mm 那段注释里）：
 *   只有「本机流式引擎持有音源（sourceNode != nil）且引擎已经不在跑」时才真的重配会话。
 *   引擎还在跑 ⇒ 只写标记、resolve NO —— 在激活态会话上重设分类正是第 24 轮实锤的 -50
 *   失声禁区，宁可不生效也不走那条路。
 *
 * 运行：node scripts/sim-play-with-others-immediate.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 剔块注释 + 整行 `//`（行内注释不动）。
// 注意与兄弟脚本的差别：这里把注释行**整行删掉**（不是置空），否则「两行代码之间夹一段注释」
// 在剥离后会留一个空行，跨这两行的锚点（改动清单里那种逐行贴着的 mutation）就会全部落空 ——
// 第 56 轮改 index.ts 的 setPause/applyPlayWithOthersNow 之间补注释时踩过。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n')

const F = {
  player: 'src/plugins/player/index.ts',
  nativeFlac: 'src/plugins/player/nativeFlac.ts',
  streamingFlac: 'src/utils/nativeModules/streamingFlac.ts',
  settings: 'src/screens/Home/Views/Setting/settings/Player/IsHandleAudioFocus.tsx',
  native: 'ios/LxMusicMobile/AppDelegate.mm',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

const countOf = (src, needle) => src.split(needle).length - 1

/** 切一段：from（含）→ to（不含）。任一锚点找不到返回 null（锚点漂移必须显式失败） */
const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  if (to == null) return src.slice(start)
  const end = src.indexOf(to, start + from.length)
  if (end < 0) return null
  return src.slice(start, end)
}

/** 取「以 `{` 结尾的声明行」的函数体（花括号配平）。传 stripComments 之后的副本 */
const bracedBody = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  let i = src.indexOf('{', start)
  if (i < 0) return null
  let depth = 0
  let quote = null
  for (; i < src.length; i++) {
    const ch = src[i]
    if (quote != null) {
      if (ch == '\\') { i++; continue }
      if (ch == quote) quote = null
      continue
    }
    if (ch == "'" || ch == '"' || ch == '`') { quote = ch; continue }
    if (ch == '/' && src[i + 1] == '/') {
      const nl = src.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (ch == '{') depth++
    else if (ch == '}') {
      depth--
      if (depth == 0) return src.slice(start, i + 1)
    }
  }
  return null
}

// 同 sim-audio-interruption-mix.js：桥方法体按名字切（`LXPlayWithOthersEnabled = enabled;`
// 在 AppDelegate.mm 里有两处，文件级 includes 会被另一处满足而漏放行）
const bridgeBody = (raw, name) => {
  const at = raw.indexOf('RCT_REMAP_METHOD(' + name)
  if (at < 0) return null
  const end = raw.indexOf('\n}', at)
  return end < 0 ? raw.slice(at) : raw.slice(at, end)
}

// ---------------------------------------------------------------------------
// 一、JS 下发链（src/plugins/player/index.ts 的 syncPlayWithOthersEnabled）
// ---------------------------------------------------------------------------
const JS_ORDER = [
  ['policy', 'await setNativePlayWithOthersPolicy(enabled)'],
  ['early', 'if (!playerState.musicInfo.id) return'],
  ['now', 'await applyNativePlayWithOthersNow(enabled)'],
  ['meta', 'void updateMetaData('],
  ['resp', 'if (playerState.isPlay) await playNowPlaying().catch(() => {})'],
]

const syncInvariants = (deps) => {
  const reasons = []
  const code = stripComments(deps.player)

  // (a) 账本：null = 本进程还没下发过（冷启动的那次下发不算「用户勾/取消」）
  if (!code.includes('let lastAppliedPlayWithOthers: boolean | null = null')) {
    reasons.push('上次下发口径的账本声明缺失/被改写（必须以 null 起步：null 代表「本进程还没下发过」，'
      + '冷启动 initial 的首次下发不能算用户勾选，见 (d)）')
  }
  // (a) 切换判定：值真的变了才算
  const switchedDecl = 'const switched = lastAppliedPlayWithOthers != null && lastAppliedPlayWithOthers != enabled'
  if (!code.includes(switchedDecl)) {
    reasons.push('「值真的变了」的切换判定缺失/被改写（第 56 轮第 3 条 (d) 的闸门）：'
      + '判定恒真 = 冷启动 / 幂等重复下发也把用户正在听的歌暂停掉；'
      + '判定恒假 = 用户勾/取消勾选反而不暂停，两条都不是用户要的')
  }

  const body = bracedBody(code, 'const syncPlayWithOthersEnabled = async() => {')
  if (body == null) {
    reasons.push('index.ts 里找不到 syncPlayWithOthersEnabled（设置切换的唯一入口）')
    return reasons
  }

  const writeAt = body.indexOf('  lastAppliedPlayWithOthers = enabled')
  const switchedAt = body.indexOf('const switched =')
  if (writeAt < 0) {
    reasons.push('账本没有被写入：switched 永远拿不到「上一次的口径」')
  } else if (switchedAt < 0) {
    reasons.push('syncPlayWithOthersEnabled 里没有切换判定')
  } else if (writeAt < switchedAt) {
    reasons.push('账本写入排在切换判定之前：switched 恒为 false（写完再比，永远「没变」）——'
      + '用户勾选/取消勾选都不会自动暂停，第 56 轮第 3 条 (d) 当场落空')
  }

  // (a)(b) 下发顺序：标记 → 无曲目早退 → 立即生效 → 重发布 → 状态重对齐 → 切换即暂停
  const pos = {}
  for (const [key, needle] of JS_ORDER) pos[key] = body.indexOf(needle)
  if (pos.policy < 0) {
    reasons.push('静态策略标记的下发不见了：第 24 轮口径（Began 分支 shouldEmitPause 的唯一依据）'
      + '被删 ⇒ 勾选后打断仍对外呈现暂停，锁屏 / 灵动岛卡片会消失')
  }
  if (pos.early < 0) {
    reasons.push('无曲目早退（if (!playerState.musicInfo.id) return）不见了：'
      + '没有当前曲目时也会往下走，重发布与状态重对齐会拿空曲目去发元数据')
  }
  if (pos.now < 0) {
    reasons.push('少了立即生效的下发（applyNativePlayWithOthersNow）：'
      + '又回到「要等下一首 / 下一次 prepareAudioSession 才生效」——正是用户这轮报的'
      + '「不会立即配置好，而是需要下首歌才执行」（第 56 轮第 3 条 (b)）')
  }
  // (b) 下发**必须两处**：原生闸门要「引擎已停」，而「正在播放时切换」这条主用例里
  // 引擎是在 setPause 之后才停的 —— 只留本体内那一处 = 最常见的用例上等于没生效。
  const nowCalls = countOf(body, 'await applyNativePlayWithOthersNow(enabled)')
  if (nowCalls < 2) {
    reasons.push('立即生效的下发不是两处（本体内一处管「切换时已经暂停」、setPause 之后一处管'
      + '「正在播放时切换」）：少了后面那处，用户最常见的「播着歌去切换」场景里会话口径仍停在'
      + '旧值 —— 立即生效等于没生效（第 56 轮第 3 条 (b)）')
  }
  if (pos.meta < 0) {
    reasons.push('重新发布元数据不见了（锁屏播放器与当前播放状态会脱节）')
  }
  if (pos.resp < 0) {
    reasons.push('状态重对齐不见了（原生位置 / 歌词时钟只在 Playing 时运行，'
      + '它是前台 4Hz 位置事件的枢纽 = 进度条唯一驱动源）')
  }
  const seq = [['policy', pos.policy], ['early', pos.early], ['now', pos.now], ['meta', pos.meta], ['resp', pos.resp]]
  for (let i = 1; i < seq.length; i++) {
    const [prevKey, prevAt] = seq[i - 1]
    const [key, at] = seq[i]
    if (prevAt >= 0 && at >= 0 && at < prevAt) {
      reasons.push(`下发顺序倒了（${key} 排在 ${prevKey} 之前）：口径要先落地（标记 / 会话重配），`
        + '卡片与系统播放态再按新口径对齐')
    }
  }

  // (d) 切换即暂停：守卫 + 位置 + 走 setPause（渐出收口）
  const tailAt = body.indexOf('if (switched && playerState.isPlay) {')
  if (tailAt < 0) {
    reasons.push('末尾的「切换即暂停」块不见了，或它的守卫被拆（必须是 if (switched && playerState.isPlay)：'
      + '裸的 playerState.isPlay 会让冷启动 / 幂等重复下发也把用户正在听的歌停掉）')
  } else {
    const tail = body.slice(tailAt)
    const tailSetPauseAt = tail.indexOf('await setPause()')
    const tailNowAt = tail.indexOf('await applyNativePlayWithOthersNow(enabled)')
    if (tailSetPauseAt < 0) {
      reasons.push('切换即暂停没有走 plugins/player/utils 的 setPause：暂停失去渐出收口'
        + '（第 39/47 轮口径：先渐出再停），自动暂停又变硬切')
    }
    if (tailNowAt < 0) {
      reasons.push('「正在播放时切换」这条主用例上没有第二次下发（setPause 之后引擎才停下、'
        + '闸门此刻才满足）：少了它，会话口径仍停在旧值，勾选 / 取消勾选都要等下一首')
    } else if (tailSetPauseAt >= 0 && tailNowAt < tailSetPauseAt) {
      reasons.push('第二次下发排在了 setPause 之前：那一刻引擎还在跑，闸门照样挡回'
        + '（只写标记、resolve NO），等于没下发 —— 必须等停下之后再重配会话')
    }
    if (pos.meta >= 0 && tailAt < pos.meta) {
      reasons.push('「切换即暂停」没有排在最后：先停再重发布，卡片 / 服务态会带着暂停前的旧口径'
        + '发出去（顺序错误）')
    }
    if (pos.resp >= 0 && tailAt < pos.resp) {
      reasons.push('「切换即暂停」排在了状态重对齐之前（顺序错误）：'
        + 'playNowPlaying/pauseNowPlaying 会按停之前的状态再对齐一次')
    }
  }
  if (body.includes('pausePlayingEngines') || body.includes('TrackPlayer.pause(')) {
    reasons.push('切换即暂停绕过 utils.setPause 直接掐引擎：硬切，失去渐出（第 39/47 轮口径回退）')
  }

  // 冷启动照旧下发（重启后口径不丢），且这只是「首次下发」，不算切换
  const initialRegion = slice(code, 'const initial = async({', 'const isInitialized = ()')
  if (initialRegion == null || !initialRegion.includes('await syncPlayWithOthersEnabled()')) {
    reasons.push('播放器初始化里不再下发「与其他应用同时播放」策略：重启后口径丢失，'
      + '且首播时原生打断分支按默认独占口径走（卡片行为与设置不一致）')
  }
  if (!code.includes('  syncPlayWithOthersEnabled,\n')) {
    reasons.push('syncPlayWithOthersEnabled 不再对外导出（设置页拿不到入口，切换无人响应）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 二、包装层（nativeFlac.ts）+ 桥声明（streamingFlac.ts）
// ---------------------------------------------------------------------------
const bridgeInvariants = (deps) => {
  const reasons = []
  const flac = stripComments(deps.nativeFlac)
  const stream = stripComments(deps.streamingFlac)

  const policyBody = bracedBody(flac, 'export const setNativePlayWithOthersPolicy = async(enabled: boolean) => {')
  if (policyBody == null) {
    reasons.push('nativeFlac.ts 里找不到 setNativePlayWithOthersPolicy（第 24 轮的静态标记下发）')
  } else if (!policyBody.includes('await setStreamingFlacPlayWithOthers(enabled).catch(() => {})')) {
    reasons.push('静态策略下发不再吞掉桥错误：非 iOS / 旧包上设置切换会变成报错')
  }
  const nowBody = bracedBody(flac, 'export const applyNativePlayWithOthersNow = async(enabled: boolean): Promise<boolean> => {')
  if (nowBody == null) {
    reasons.push('nativeFlac.ts 里找不到 applyNativePlayWithOthersNow（立即生效的包装）')
  } else {
    if (!nowBody.includes('if (!isNativeFlacPlayerAvailable()) return false')) {
      reasons.push('立即生效包装丢了平台 / 桥可用性早退：非 iOS 上会照走桥调用')
    }
    if (!nowBody.includes('applyStreamingFlacPlayWithOthersNow(enabled).catch(() => false)')) {
      reasons.push('立即生效包装不再吞错返回 false：桥失败会抛进设置切换路径'
        + '（该路径只该「不生效」，绝不该报错或重试 —— 重试等于在激活态会话上反复重设分类）')
    }
  }
  if (!stream.includes('applyPlayWithOthersNow?: (enabled: boolean) => Promise<boolean>')) {
    reasons.push('streamingFlac.ts 的桥声明丢了 applyPlayWithOthersNow（立即生效下发不到原生）')
  }
  if (!stream.includes("export const applyStreamingFlacPlayWithOthersNow = async(enabled: boolean) => assertSupported('applyPlayWithOthersNow')(enabled)")) {
    reasons.push('streamingFlac.ts 的桥包装丢了 / 换了方法名（立即生效下发不到原生）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 三、原生闸门（AppDelegate.mm）
// ---------------------------------------------------------------------------
const nativeInvariants = (raw) => {
  const reasons = []
  const body = bridgeBody(raw, 'applyPlayWithOthersNow')
  if (body == null) {
    reasons.push('原生缺少 applyPlayWithOthersNow 桥（立即生效进不来）')
    return reasons
  }
  const markerAt = body.indexOf('LXPlayWithOthersEnabled = enabled;')
  const gateAt = body.indexOf('if (self.sourceNode == nil || self.engine == nil || self.engine.isRunning) {')
  if (markerAt < 0) {
    reasons.push('立即生效桥没有下发策略标记（闸门不满足时标记也不落地 ⇒ 勾选后仍按独占口径'
      + '对外呈现暂停，卡片 / 灵动岛行为不一致）')
  } else if (gateAt >= 0 && markerAt > gateAt) {
    reasons.push('立即生效桥把标记写入排在了闸门之后：闸门不满足（引擎还在跑 / 非无损档 / 桥缺失）'
      + '时标记没落地，第 24 轮口径跟着丢')
  }
  if (gateAt < 0) {
    reasons.push('立即生效桥缺少安全闸门（引擎还在跑 / 非无损档也照重配会话 = 第 24 轮实锤的 -50 失声禁区）')
  } else {
    const gate = body.slice(gateAt)
    if (!gate.includes('resolve(@(NO));') || !gate.includes('return;')) {
      reasons.push('立即生效桥的闸门不满足时没有「只写标记 + resolve NO」地返回：'
        + '闸门等于没有（或把「没重配」当错误来回重试）')
    }
    if (!gate.includes('BOOL ok = [self prepareAudioSession:&error];') || !gate.includes('resolve(@(ok));')) {
      reasons.push('立即生效桥没有复用 prepareAudioSession 的口径（会话分类必须只有那一处真源）')
    }
  }
  // 会话分类字面量仍恰一处（立即生效桥复用 prepareAudioSession，不许自己再写一份）
  if (countOf(raw, 'AVAudioSessionCategoryOptionMixWithOthers') !== 1) {
    reasons.push('混音选项字面量不是恰一处：立即生效桥自己又写了一份会话分类'
      + '（第 24 轮定案：口径只有一个真源 = prepareAudioSession）')
  }
  if (!raw.includes('shouldEmitPause = !LXPlayWithOthersEnabled;')) {
    reasons.push('Began 分支 shouldEmitPause 未接策略标记（勾选下打断仍对外呈现暂停）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 四、设置页（勾选动作只走下发布链，不许重建播放器）
// ---------------------------------------------------------------------------
const settingsInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)
  const writeAt = code.indexOf("updateSetting({ 'player.isHandleAudioFocus': !playWithOthers })")
  const syncAt = code.indexOf('await syncPlayWithOthersEnabled().catch(() => {})')
  if (writeAt < 0) {
    reasons.push('设置页不再写回存储语义（勾选 = 同时播放 = isHandleAudioFocus 为 false）')
  }
  if (syncAt < 0) {
    reasons.push('设置页切换后不再下发策略（勾选动作没人响应）')
  } else if (writeAt >= 0 && syncAt < writeAt) {
    reasons.push('设置页先下发再写库：下发链读的是 settingState，拿到的是旧值（切换后反着生效一次）')
  }
  if (code.includes('reloadConfig')) {
    reasons.push('设置切换又回去重建播放器（reloadConfig / destroy + setupPlayer）：'
      + '在会话激活态重设分类是第 24 轮实锤的失声路径（卡片消失 / 有进度没声音）')
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
const tamperPlayer = (find, replace) => tamper(stripComments(REAL.player), find, replace)
const tamperSettings = (find, replace) => tamper(stripComments(REAL.settings), find, replace)

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

  // n1 切换判定被拆（恒假：勾选/取消勾选都不暂停）
  check('n1 切换判定被拆成恒假', () => syncInvariants({
    ...REAL,
    player: tamperPlayer(
      'const switched = lastAppliedPlayWithOthers != null && lastAppliedPlayWithOthers != enabled',
      'const switched = false'),
  }),
  '切换判定缺失')

  // n1b 账本写入排到判定之前（switched 恒 false —— 写错了但语法完全合法）
  check('n1b 账本写入排到判定之前', () => syncInvariants({
    ...REAL,
    player: tamperPlayer(
      '  const switched = lastAppliedPlayWithOthers != null && lastAppliedPlayWithOthers != enabled\n  lastAppliedPlayWithOthers = enabled',
      '  lastAppliedPlayWithOthers = enabled\n  const switched = lastAppliedPlayWithOthers != null && lastAppliedPlayWithOthers != enabled'),
  }),
  '账本写入排在切换判定之前')

  // n2 立即生效被删（又回到「要等下一首」）
  check('n2 立即生效下发被删', () => syncInvariants({
    ...REAL,
    player: tamperPlayer('  await applyNativePlayWithOthersNow(enabled)\n', ''),
  }),
  '立即生效')

  // n3 切换即暂停的守卫被拆（冷启动 / 幂等重复下发也停歌）
  check('n3 切换即暂停的守卫被拆', () => syncInvariants({
    ...REAL,
    player: tamperPlayer(
      'if (switched && playerState.isPlay) {',
      'if (playerState.isPlay) {'),
  }),
  '冷启动')

  // n4 切换即暂停绕过 setPause（硬切，渐出没了）
  check('n4 切换即暂停绕过 setPause', () => syncInvariants({
    ...REAL,
    player: tamperPlayer(
      '    await setPause()\n    await applyNativePlayWithOthersNow(enabled)\n    await pauseNowPlaying().catch(() => {})',
      '    await pausePlayingEngines()\n    await applyNativePlayWithOthersNow(enabled)\n    await pauseNowPlaying().catch(() => {})'),
  }),
  '渐出')

  // n5 切换即暂停挪到重发布之前（卡片带着旧口径发出去）
  check('n5 切换即暂停挪到重发布之前', () => syncInvariants({
    ...REAL,
    player: (() => {
      const src = stripComments(REAL.player)
      const block = '  if (switched && playerState.isPlay) {\n    await setPause()\n    await applyNativePlayWithOthersNow(enabled)\n    await pauseNowPlaying().catch(() => {})\n  }\n'
      const metaAt = '  void updateMetaData(playerState.musicInfo, playerState.isPlay, playerState.lastLyric, true)\n'
      if (!src.includes(block) || !src.includes(metaAt)) throw new Error('n5 锚点未命中')
      return src.replace(block, '').replace(metaAt, block + metaAt)
    })(),
  }),
  '排在最后')

  // n9 「正在播放时切换」的第二次下发被删（回合口径停在旧值，要等下一首）
  check('n9 停下来的那一刻不再下发', () => syncInvariants({
    ...REAL,
    player: tamperPlayer('    await applyNativePlayWithOthersNow(enabled)\n', ''),
  }),
  '第二次下发')

  // n10 第二次下发挪到 setPause 之前（引擎还在跑，闸门照样挡回）
  check('n10 第二次下发挪到暂停之前', () => syncInvariants({
    ...REAL,
    player: tamperPlayer(
      '    await setPause()\n    await applyNativePlayWithOthersNow(enabled)',
      '    await applyNativePlayWithOthersNow(enabled)\n    await setPause()'),
  }),
  'setPause 之前')

  // n6 原生闸门被拆（引擎还在跑也照重配会话 = -50 失声禁区）
  check('n6 原生立即生效闸门被拆', () => nativeInvariants(tamper(REAL.native,
    'if (self.sourceNode == nil || self.engine == nil || self.engine.isRunning) {',
    'if (false) {')),
  '安全闸门')

  // n7 标记写入挪到闸门之后（闸门不满足时标记不落地）。
  //   注意是**搬**不是删：只把标记那一行删掉会被「没有下发策略标记」这条先拦下，
  //   验的就不是「顺序」这条口径了（第 56 轮写 n7 时踩过）。
  check('n7 原生标记写入挪到闸门之后', () => nativeInvariants(tamper(REAL.native,
    '  LXPlayWithOthersEnabled = enabled;\n  if (self.sourceNode == nil || self.engine == nil || self.engine.isRunning) {\n    resolve(@(NO));\n    return;\n  }',
    '  if (self.sourceNode == nil || self.engine == nil || self.engine.isRunning) {\n    resolve(@(NO));\n    return;\n  }\n  LXPlayWithOthersEnabled = enabled;')),
  '闸门之后')

  // n8 设置页又回去重建播放器（第 24 轮实锤的失声路径）
  check('n8 设置页又重建播放器', () => settingsInvariants(tamperSettings(
    '    await syncPlayWithOthersEnabled().catch(() => {})',
    '    await syncPlayWithOthersEnabled().catch(() => {})\n    void reloadConfig()')),
  '重建播放器')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-play-with-others-immediate ===')
console.log('「与其他应用同时播放」勾选 / 取消勾选立即生效 + 切换即暂停（第 56 轮第 3 条 (b)(c)(d)）')
console.log()

const checks = [
  ['JS 下发链（账本 / 切换判定 / 标记→立即生效→重发布→状态重对齐 的顺序 / 末尾切换即暂停走 setPause / 冷启动仍下发）', () => syncInvariants(REAL)],
  ['包装层与桥（nativeFlac 两个包装的吞错语义 + streamingFlac 的桥声明与包装）', () => bridgeInvariants(REAL)],
  ['原生闸门（applyPlayWithOthersNow：标记先落地 + 只在已停的流式引擎上重配会话 + 复用 prepareAudioSession 唯一真源）', () => nativeInvariants(REAL.native)],
  ['设置页（写库 → 下发，且不许重建播放器）', () => settingsInvariants(REAL.settings)],
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
