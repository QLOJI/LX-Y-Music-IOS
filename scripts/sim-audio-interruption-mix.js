#!/usr/bin/env node
/**
 * sim-audio-interruption-mix.js —— 「与其他应用同时播放」的打断策略契约（用户第 24 轮）。
 *
 * 需求原话（2026-10-03 第 24 轮）：
 *   「1、勾选后播放其他音频不会暂停，会同时播放音乐；2、取消勾选后，会正常暂停，
 *     播放完后自动恢复播放（和目前功能一样）」
 *   「勾选后，锁屏界面和灵动岛播放界面消失了，取消就有了，我需要始终显示」
 *
 * 为什么不在音频会话层做（本脚本存在的原因）：
 *   mixWithOthers 是 mixable 会话 ⇒ 失去 Now Playing 主会话资格 ⇒ 锁屏 / 灵动岛播放
 *   卡片消失；且与原生流式引擎的 LongFormAudio 路由策略互斥（setCategory 报 -50），
 *   会话被停用后表现为「有进度没声音」。会话因此**始终非混音**，见
 *   scripts/sim-play-with-others-toggle.js 的会话不变量。
 *
 * 于是「勾选后其它音频不能让我们停下来」落在**策略层**，两处同口径：
 *   JS（service.ts，RemoteDuck 的 iOS 分支）：勾选时单开一段策略分支 ——
 *     打断开始 → 不调 pause()（这是与独占分支唯一的区别）、照记待恢复意图但受手动暂停闸门约束；
 *     打断结束 → 恢复音量 + scheduleAutoResume（原生会重启引擎，两边幂等）；
 *     取消勾选 → 原独占分支一字未改（暂停 + 短暂中断自动续播 = 第 21/22 轮口径）。
 *   原生（AppDelegate.mm，handleAudioSessionInterruption:）：
 *     JS 经 setPlayWithOthers 下发 LXPlayWithOthersEnabled；Began 分支据此
 *     shouldEmitPause = !LXPlayWithOthersEnabled —— 勾选时不 emit paused、不改 currentState：
 *     UI / 锁屏 / 灵动岛保持「在播」；Ended 分支仍照 interruptedBySystem 重启引擎 +
 *     schedulePlaybackOutputRestoreWithDelays 恢复输出。
 *
 * 【第 58 轮第 3 条：混音态 Began 分支改「原地不动」（本脚本第 24 轮口径的反转）】
 *   第 24 轮写的「勾选时引擎照旧停摆（音频已被系统压住），只把 paused 事件吞掉不发」
 *   在真机上表现为**声音不定时中断又自己恢复**：混音口径下 iOS 打断期间本来就已把我们
 *   的输出压住，我们再去 [engine pause] + _sourceRenderingEnabled = NO + setActive:NO
 *   等于自己把引擎拆了；而打断结束/JS 重取阶梯的 play() 进来时 playerState.isPlay 一直是
 *   true（JS 只吞了事件没改状态），引擎已在播不会再发 'playing'，音量渐入的兜底期限
 *   （1.5s）成了唯一的恢复时刻 —— 用户听到的正是这六拍阶梯。
 *   现在的口径：混音态 Began 分支**整段让行** —— 不停引擎、不掐渲染、不交还会话，只记一下
 *   播放位置；打断结束 iOS 自己把会话还回来，全程连续，不经历「拆掉 → 装回来」。
 *   JS 侧配对修正见 src/plugins/player/utils.ts 的 setPlay（已在播时不再预约渐入）。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：多一句 pause()、少一句续播、标记写死，全都合法，
 * 只在真机上表现为「勾选了还是被暂停」或「勾选后又没声了」）。
 * 运行：node scripts/sim-audio-interruption-mix.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
// 剥注释后把只剩缩进的空行压成真正的空行：否则拿「跨注释行」的代码做锚点时，
// 注释被删掉留下的 8 个空格会把锚点顶开（第 24 轮踩过，m1 反例锚点未命中）
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/^[ \t]+$/gm, '')

const F = {
  service: 'src/plugins/player/service.ts',
  utils: 'src/plugins/player/utils.ts',
  native: 'ios/LxMusicMobile/AppDelegate.mm',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// ---------------------------------------------------------------------------
// 不变量 A/B：JS 策略层（service.ts）
// ---------------------------------------------------------------------------

const serviceInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  const helper = "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] === false"
  if (!code.includes(helper)) {
    reasons.push('「与其他应用同时播放」判定缺失/被改写（必须是 player.isHandleAudioFocus === false，与设置页极性同源）')
  }

  const iosAt = code.indexOf("Platform.OS == 'ios'")
  const mixAt = code.indexOf('if (isPlayWithOthers()) {')
  if (mixAt < 0) {
    reasons.push('iOS 分支缺少「与其他应用同时播放」策略分支（勾选后会被系统打断成暂停）')
  } else if (iosAt < 0 || mixAt < iosAt) {
    reasons.push('策略分支不在 iOS 分支内（Android 的 audio focus 语义不同，不能套用）')
  }

  const endAt = mixAt < 0 ? -1 : code.indexOf('\n      if (ducking) {', mixAt)
  if (mixAt >= 0 && endAt < 0) {
    reasons.push('策略分支与独占分支的分界丢失（独占分支必须原样保留在其后）')
  } else if (mixAt >= 0) {
    const block = code.slice(mixAt, endAt)
    if (/\bpause\(/.test(block)) {
      reasons.push('混音分支不应调 pause()（勾选 = 不因其它音频暂停自己 —— 第 24 轮需求 1）')
    }
    if (!block.includes('if (!global.lx.isPlayedStop && !isManualPause()) shouldResumeAfterDuck = true')) {
      reasons.push('混音分支丢了手动暂停闸门（用户主动暂停后其它音频一响就自行出声 —— 第 22 轮口径）')
    }
    if (!block.includes('restoreConfiguredVolume()')) {
      reasons.push('混音分支打断结束未恢复音量（duck 后音量停在低压值）')
    }
    if (!block.includes('scheduleAutoResume()')) {
      reasons.push('混音分支打断结束未续播（原生引擎停摆后输出不会自己回来）')
    }
  }

  // 独占分支（取消勾选口径）必须原样保留：第 21/22 轮的暂停 + 短暂中断自动续播
  if (!code.includes('void pause()')) {
    reasons.push('独占分支的 void pause() 丢失（取消勾选后不会正常暂停）')
  }
  if (!code.includes('const wasLongInterruption = interruptedAt > 0 && Date.now() - interruptedAt > SHORT_INTERRUPTION_MAX_MS')) {
    reasons.push('独占分支的长中断判定丢失（长时间抢占会跟导航/通话拉锯）')
  }
  if (!code.includes('if (permanent && wasLongInterruption) return cancelResumePending()')) {
    reasons.push('独占分支的长中断分流丢失（永久抢占仍会抢回音频）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：JS 渐入侧（utils.ts）—— 已在播时不预约渐入（第 58 轮第 3 条的自伤路径之一）
// ---------------------------------------------------------------------------

// 为什么这条属于本脚本：混音口径下 play() 有**两类**调用者 —— 真·恢复播放，以及
// service.ts 重取输出阶梯（scheduleMixReclaim / 打断结束分支）。后者进来时
// playerState.isPlay 一直是 true、引擎早已跨过出声门槛，而 armFadeIn 的旧写法
// （fadeTimer == null 就 stopRamp + silenceBothEngines）会把音量当场压 0；重取不会再触发
// 'playing' 去放行渐入，音量只能干等 1.5s 兜底期限跳回 —— 就是用户听到的
// 「声音自动不定时中断，然后又自动播放」。这里钉住闸门形态。
const utilsInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)
  const at = code.indexOf('export const setPlay = async() => {')
  if (at < 0) {
    reasons.push('找不到 utils.setPlay（渐入链的起点没了）')
    return reasons
  }
  const end = code.indexOf('\nexport const ', at + 1)
  const body = end < 0 ? code.slice(at) : code.slice(at, end)
  // 【第 62 轮第 3 条】闸门形态由 `if (!playerState.isPlay) armVolumeFadeIn()` 改为
  // 「先取一次快照 `const resuming = !playerState.isPlay`，再 `if (resuming) armVolumeFadeIn()`」——
  // 同一份快照还要喂「按下即翻 UI」的翻转块，所以它必须取**一次**、且是第一读。
  // 判据没变：预约必须挂在「本次真是从暂停转为播放」这个条件上（重取输出阶梯进来时
  // isPlay 恒为 true ⇒ 不预约 ⇒ 不会把音量当场压 0）。
  if (!body.includes('const resuming = !playerState.isPlay')) {
    reasons.push('setPlay 未按播放态取「本次是否真·恢复播放」的快照（const resuming = !playerState.isPlay：无条件预约会在「重取输出」这条调用路径上把音量当场压 0，等 1.5s 兜底才跳回 —— 第 58 轮第 3 条「声音不定时中断又恢复」）')
  }
  if (!body.includes('if (resuming) armVolumeFadeIn()')) {
    reasons.push('setPlay 未按播放态预约渐入（必须是 if (resuming) armVolumeFadeIn()：无条件预约会在「重取输出」这条调用路径上把音量当场压 0，等 1.5s 兜底才跳回 —— 第 58 轮第 3 条「声音不定时中断又恢复」）')
  }
  if (/\n\s+armVolumeFadeIn\(\)\n/.test(body)) {
    reasons.push('setPlay 里又出现无条件的 armVolumeFadeIn()（绕过播放态闸门）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：原生（AppDelegate.mm）—— 策略标记 + 对外不呈现暂停 + 打断结束仍恢复输出
//          + 第 58 轮第 3 条：混音态 Began 分支整段让行
// ---------------------------------------------------------------------------

// 从 performInterruptionBeganHandling 的 renderQueue 块里切出「混音态让行」早退块。
// 返回 null 表示让行块不存在（回归形态：勾选后仍走完拆引擎那两步）。
const mixBeganLetThrough = (raw) => {
  const fn = raw.indexOf('- (void)performInterruptionBeganHandling {')
  if (fn < 0) return null
  const sync = raw.indexOf('dispatch_sync(self.renderQueue, ^{', fn)
  if (sync < 0) return null
  const end = raw.indexOf('\n  });', sync)
  const block = end < 0 ? raw.slice(sync) : raw.slice(sync, end)
  const at = block.indexOf('if (LXPlayWithOthersEnabled) {')
  if (at < 0) return null
  const next = block.indexOf('if (shouldHandle && !self.manualPause) {', at)
  return { block, guard: next < 0 ? block.slice(at) : block.slice(at, next), at, next }
}

const nativeInvariants = (raw) => {
  const reasons = []
  if (!raw.includes('static BOOL LXPlayWithOthersEnabled = NO;')) {
    reasons.push('原生缺少 LXPlayWithOthersEnabled 策略标记')
  }
  if (!raw.includes('RCT_REMAP_METHOD(setPlayWithOthers')) {
    reasons.push('原生缺少 setPlayWithOthers 桥方法（JS 下发的策略进不来）')
  }
  // 标记下发**按桥方法分别查**（2026-10-11 第 56 轮）：`LXPlayWithOthersEnabled = enabled;`
  // 现在有两处（setPlayWithOthers + applyPlayWithOthersNow），文件级 includes 会被另一处
  // 满足而漏放行 —— 必须把每个桥的函数体切出来各查各的。
  const bridgeBody = (name) => {
    const at = raw.indexOf('RCT_REMAP_METHOD(' + name)
    if (at < 0) return null
    const end = raw.indexOf('\n}', at)
    return end < 0 ? raw.slice(at) : raw.slice(at, end)
  }
  const setBody = bridgeBody('setPlayWithOthers')
  if (!setBody || !setBody.includes('LXPlayWithOthersEnabled = enabled;')) {
    reasons.push('setPlayWithOthers 未把策略标记下发（策略标记未下发，勾选无效果）')
  }
  // 【第 56 轮第 3 条 (b)】立即生效桥也必须写同一个标记：它除了重配会话还要保证
  // 「闸门不满足（引擎在跑 / 非无损档 / 桥缺失）时标记已经落地」——那条只写标记的
  // 退化路径全靠它，否则勾选后仍按独占口径对外呈现暂停（卡片 / 灵动岛行为不一致）。
  const nowBody = bridgeBody('applyPlayWithOthersNow')
  if (!nowBody || !nowBody.includes('LXPlayWithOthersEnabled = enabled;')) {
    reasons.push('立即生效桥未下发策略标记（applyPlayWithOthersNow 的标记写入缺失 → 闸门不满足时标记不落地，「与其他应用同时播放」勾了却仍按独占口径对外呈现暂停）')
  }
  if (raw.split('LXPlayWithOthersEnabled = enabled;').length - 1 !== 2) {
    reasons.push('策略标记写入点不是恰 2 处（setPlayWithOthers + applyPlayWithOthersNow 各一处；多一处 = 又多了一条下发路径，口径会漂）')
  }
  if (!raw.includes('shouldEmitPause = !LXPlayWithOthersEnabled;')) {
    reasons.push('Began 分支 shouldEmitPause 未接策略标记（勾选下打断仍对外呈现暂停 ⇒ 锁屏 / 灵动岛卡片会消失）')
  }
  if (!raw.includes('interruptedBySystem = YES;')) {
    reasons.push('Began 分支未标记 interruptedBySystem（打断结束分支不会恢复输出）')
  }
  if (!raw.includes('ensureAudioEngineRunningLocked') || !raw.includes('schedulePlaybackOutputRestoreWithDelays')) {
    reasons.push('Ended 分支未重启引擎 / 未安排输出恢复（勾选后其它音频结束不会把声音续上）')
  }
  if (!raw.includes('didResumePlaying = self.playbackStarted;')) {
    reasons.push('Ended 分支未真正重启播放（引擎起来但不出声，输出不会回来）')
  }
  // 【第 58 轮第 3 条】混音态 Began 分支整段让行：不停引擎、不掐渲染、不交还会话。
  // 第 24 轮那种「照旧拆掉、只把 paused 事件吞掉不发」在混音口径下是自伤：其它应用每次
  // 出声都要经历一轮「拆掉自己 → JS 重取阶梯再装回来」，用户听到的正是声音不定时中断又恢复。
  const lt = mixBeganLetThrough(raw)
  if (!lt) {
    reasons.push('混音态 Began 分支未整段让行（勾选「与其他应用同时播放」时仍会 [engine pause] + 掐渲染 + 交还会话 ⇒ 其它应用每次出声都要把引擎拆一遍再装回来 —— 第 58 轮第 3 条）')
  } else {
    if (!lt.guard.includes('return;')) {
      reasons.push('混音态让行分支没有早退（仍会走完拆引擎 / 交还会话那两步）')
    }
    if (!lt.guard.includes('self.lastKnownPosition = [self currentPlaybackPositionLocked];')) {
      reasons.push('混音态让行分支未记录播放位置（打断结束续播会从旧位置跳）')
    }
    if (/\[self\.engine pause\]|_sourceRenderingEnabled|setActive:NO/.test(lt.guard)) {
      reasons.push('混音态让行分支里仍在拆引擎 / 掐渲染 / 交还会话（让行不彻底，等于没让）')
    }
    if (lt.at > lt.next && lt.next >= 0) {
      reasons.push('混音态让行判定排在执行段之后（先拆了引擎再判让行，白让）')
    }
    // 【第 62 轮第 2 条】让行之外还要**布防一条原生重取阶梯**：对方开麦 / 关麦真正伤害我们的
    // 方式是「把输出 IO 悄悄掐断」（引擎 isRunning 仍为真），系统那一侧不会有第二次通知，
    // 只让行不布防 ⇒ 声音就再也回不来（用户第 62 轮报的「直播软件打开和关闭时短暂的声音消失」）。
    if (!lt.guard.includes('shouldArmMixRecovery = YES;')) {
      reasons.push('混音态让行分支未布防原生重取阶梯（其它应用开麦 / 关麦把输出 IO 掐断后没人重挂 ⇒ 短暂的声音消失）')
    }
  }
  // 布防的**消费点**必须在 `self.interruptedBySystem = YES;` 之前：一旦打断落账，
  // 混音态那条分流门槛（`interruptedBySystem && !LXPlayWithOthersEnabled`）会把自愈挡掉
  // —— 布防等于没布。取「布防之后的第一处落账」做比较（文件里 `interruptedBySystem = YES;`
  // 另有一处、在别的方法里，不能拿全文第一处来比）。
  const armAt = raw.indexOf('if (shouldArmMixRecovery) {')
  if (armAt < 0) {
    reasons.push('找不到混音态重取阶梯的触发点（if (shouldArmMixRecovery) {）—— 布防没有消费点')
  } else {
    const markAt = raw.indexOf('self.interruptedBySystem = YES;', armAt)
    if (markAt < 0) {
      reasons.push('打断落账（self.interruptedBySystem = YES;）在布防之后找不到 —— 触发点后面的收尾链路断了')
    } else if (!raw.slice(armAt, markAt).includes('scheduleStreamingOutputRecoveryWithDelays:@[ @0.4, @1.2, @3.0 ]')) {
      reasons.push('混音态重取阶梯的触发点里没有三拍阶梯（触发点必须真去调度重取）')
    }
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
// service.ts / utils.ts 的判断跑在剥离注释后的代码上（断言里不应该被注释正文干扰），
// 反例也要在同口径的文本上做手脚。第三个参数指目标文件（默认 service）。
const tamperService = (find, replace, which = 'service') =>
  tamper(stripComments(REAL[which]), find, replace)

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

  // m1 混音分支里塞回 void pause()（勾选后又自我暂停 = 第 24 轮报的 bug 原样复活）
  check('m1 混音分支塞回 pause()', () => serviceInvariants(tamperService(
    '          clearResumeTimer()\n          return\n        }\n\n        interruptedAt = 0',
    '          void pause()\n          clearResumeTimer()\n          return\n        }\n\n        interruptedAt = 0')),
  '不应调 pause()')

  // m2 混音分支去掉自动续播（其它音频播完，输出不回来）
  check('m2 混音分支去掉续播', () => serviceInvariants(tamperService(
    '        restoreConfiguredVolume()\n        scheduleAutoResume()',
    '        restoreConfiguredVolume()')),
  '未续播')

  // m3 判定被写死（策略分支永远不生效）
  check('m3 判定写死 false', () => serviceInvariants(tamperService(
    "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] === false",
    'const isPlayWithOthers = () => false')),
  '判定缺失')

  // m4 混音分支丢掉手动暂停闸门（用户暂停后自行出声）
  check('m4 混音分支丢手动暂停闸门', () => serviceInvariants(tamperService(
    '          if (!global.lx.isPlayedStop && !isManualPause()) shouldResumeAfterDuck = true',
    '          if (!global.lx.isPlayedStop) shouldResumeAfterDuck = true')),
  '手动暂停闸门')

  // m5 原生 shouldEmitPause 退回无条件 NO（勾选后卡片 / 灵动岛又消失）
  check('m5 原生 shouldEmitPause 未接策略', () => nativeInvariants(tamper(REAL.native,
    'shouldEmitPause = !LXPlayWithOthersEnabled;',
    'shouldEmitPause = YES;')),
  'shouldEmitPause')

  // m6 原生 setPlayWithOthers 不再下发标记（勾选无效果）
  // 锚点必须带上桥方法签名：2026-10-11 第 56 轮起 `LXPlayWithOthersEnabled = enabled;`
  // 在 AppDelegate.mm 里有**两处**（setPlayWithOthers + applyPlayWithOthersNow），
  // 裸串会被 String.replace 命中第一处以外的语义混淆（旧用例正是因此漏放行）。
  check('m6 原生标记未下发', () => nativeInvariants(tamper(REAL.native,
    'RCT_REMAP_METHOD(setPlayWithOthers, setPlayWithOthers:(BOOL)enabled resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {\n  LXPlayWithOthersEnabled = enabled;',
    'RCT_REMAP_METHOD(setPlayWithOthers, setPlayWithOthers:(BOOL)enabled resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {\n  LXPlayWithOthersEnabled = NO;')),
  '策略标记未下发')

  // m6b 立即生效桥（第 56 轮第 3 条 b）不再写标记（闸门不满足时标记不落地）
  // 锚点必须覆盖到闸门那一行：标记写入前面还压着第 58 轮第 4 条的两行抑制（标记行不再
  // 紧跟桥签名），锚在「签名 + 标记行」上会失配。这段四行连写是全文唯一的形态，
  // 且正是 applyPlayWithOthersNow 的函数头序列。
  check('m6b 立即生效桥未下发标记', () => nativeInvariants(tamper(REAL.native,
    '  LXSuppressNowPlayingCard = enabled;\n  LXApplyNowPlayingInfo();\n  LXPlayWithOthersEnabled = enabled;\n  if (self.sourceNode == nil || self.engine == nil || self.engine.isRunning) {',
    '  LXSuppressNowPlayingCard = enabled;\n  LXApplyNowPlayingInfo();\n  LXPlayWithOthersEnabled = YES;\n  if (self.sourceNode == nil || self.engine == nil || self.engine.isRunning) {')),
  '立即生效桥未下发策略标记')

  // m7 打断结束不再真正重启播放（引擎在起、但不出声）
  check('m7 打断结束不重启播放', () => nativeInvariants(tamper(REAL.native,
    '[self maybeStartPlaybackLocked];\n        didResumePlaying = self.playbackStarted;',
    '[self maybeStartPlaybackLocked];\n        didResumePlaying = NO;')),
  '未真正重启播放')

  // m8 混音态让行块被整段删掉（退回第 24 轮「照旧拆引擎、只吞事件」的老口径）
  // 用下标切片而不是逐字长锚点：让行块里压着第 62 轮那段注释，逐字锚点会随注释一起漂
  // （漂掉的锚点只证明用例坏了，证明不了回归形态被拦下）。切掉的范围 =
  // `if (LXPlayWithOthersEnabled) {` 到它自己的收尾 `return;\n    }`（含）。
  const cutMixLetThrough = (src) => {
    const at = src.indexOf('    if (LXPlayWithOthersEnabled) {')
    if (at < 0) return null
    const tail = '      return;\n    }\n'
    const ret = src.indexOf(tail, at)
    if (ret < 0) return null
    return src.slice(0, at) + src.slice(ret + tail.length)
  }
  check('m8 混音态让行块被删', () => {
    const t = cutMixLetThrough(REAL.native)
    if (t == null) throw new Error('tamper 锚点未命中: 混音态让行块')
    return nativeInvariants(t)
  }, '未整段让行')

  // m8b 让行块保留但不布防重取阶梯（第 62 轮第 2 条：IO 被掐断后没人重挂）
  check('m8b 让行块不布防重取阶梯', () => nativeInvariants(tamper(REAL.native,
    '      shouldArmMixRecovery = YES;\n      return;\n',
    '      shouldArmMixRecovery = NO;\n      return;\n')),
  '未布防原生重取阶梯')

  // m9 让行块里又塞回 [engine pause]（半让行 = 引擎被拆掉，输出还是要等重取）
  check('m9 让行块里塞回 engine pause', () => nativeInvariants(tamper(REAL.native,
    '      shouldArmMixRecovery = YES;\n      return;\n',
    '      if (self.engine != nil && self.engine.isRunning) [self.engine pause];\n      shouldArmMixRecovery = YES;\n      return;\n')),
  '让行不彻底')

  // m10 setPlay 的预约渐入又退回无条件（重取输出那条路径把音量当场压 0 → 1.5s 后才跳回）
  check('m10 setPlay 无条件预约渐入', () => utilsInvariants(tamperService(
    'if (resuming) armVolumeFadeIn()',
    'armVolumeFadeIn()', 'utils')),
  '未按播放态预约渐入')

  // m11 闸门被写死成「永远预约」（第 62 轮把闸门从直读 isPlay 换成一次快照之后，
  //     快照这一行就是闸门的唯一出处；写死它 = 重取阶梯也走进预约，音量被压 0）
  check('m11 闸门写死永远预约', () => utilsInvariants(tamperService(
    '  const resuming = !playerState.isPlay',
    '  const resuming = true', 'utils')),
  '未按播放态取')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-audio-interruption-mix ===')
console.log('「与其他应用同时播放」= 勾选不自我暂停（策略层，非会话层）+ 打断结束续上输出 + 卡片始终在（第 24 轮）')
console.log()

const checks = [
  ['JS 策略层（service.ts：isPlayWithOthers 判定 / iOS 分支内 / 混音分支无 pause + 手动暂停闸门 + 恢复音量 + 续播 / 独占分支原样）', () => serviceInvariants(REAL.service)],
  ['JS 渐入侧（utils.ts：setPlay 按播放态预约渐入 —— 重取输出不再把音量压 0）', () => utilsInvariants(REAL.utils)],
  ['原生（AppDelegate.mm：LXPlayWithOthersEnabled + setPlayWithOthers + shouldEmitPause 接线 + interruptedBySystem + Ended 恢复输出 + 混音态 Began 整段让行）', () => nativeInvariants(REAL.native)],
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
