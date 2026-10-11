#!/usr/bin/env node
/**
 * sim-r59-transition-capture-and-resume-fade.js
 *
 * 第 59 轮三条的契约（2026-10-11）。三条都在 tsc / eslint 的盲区里：
 *   · 玻璃闸门写在 Swift（原生不参与 TS 检查）；
 *   · 原生渐入同样是 Swift / ObjC；
 *   · controller.ts 那条 switch 少一个 break 也过得了类型检查。
 *
 * 需求原话（用户第 59 轮）：
 *   ① 「当我点击左上角返回按钮、右滑返回主界面或者从某个界面返回到有底部 tab 栏和迷你
 *      播放器栏的界面时，底部 tab 栏和迷你播放器栏透过的画面还是显示有问题，在滑动过程中
 *      有拉伸、错位和撕裂的情况，……动画延迟也很高，在滑动和返回主界面之前需要知道底层
 *      当前画面，然后再滑动和返回时就要实时显示透过的底层当前画面」
 *   ② 「当我勾选上『与其他应用同时播放』选项，应该立即取消锁屏和灵动岛界面，目前锁屏
 *      界面未完全取消，而且勾选后，播放其他应用音频，他会自动暂停，这个与其他应用同时
 *      播放相违背，需要修复，保证勾选后无论播放什么视频音乐，都不会暂停，除非手动点击
 *      暂停播放」
 *   ③ 「取消勾选后再次播放音乐，当有其他音频播放音乐时，自动暂停和自动播放也要沿用
 *      渐入渐出的效果，和手动暂停和播放一样」
 *
 * ── 第 1 条：转场里的全局采景闸门（LiquidGlassView.requestGlobalCaptureSlot） ──
 *   旧口径是「距上一次**全局**采景不足固定 0.033s 就丢弃，谁先到谁采」。两个毛病在返回 /
 *   滑动转场里同时发作：
 *     ① 固定 0.033s、不看实时档：转场里三块玻璃都进了实时档（承诺 60fps），却全被这道
 *        闸门压回合计 30 次/秒；
 *     ② 先到先得 = 可独占：每 16.7ms 提交一帧的实例每次都满足 33ms，块块抢到名额，另外
 *        两块总被判「刚采过」——三块均分退化成一个饱死、两个饿死，饿死那块拿的是几十毫秒
 *        前位置对应的矩形内容，被 shader 当背景折射出来就是「拉伸 / 错位 / 撕裂」。
 *   本轮的定案（本脚本绑住的东西）：
 *     · 节拍**按实时档选**（实时 16.7ms / 静止 33.3ms），闸门内不许再出现写死的秒数；
 *     · 2ms **抖动余量**：显示链路 60Hz 节拍是 16.667ms，与 16.7ms 只差 0.3ms —— 没有余量
 *       时「恰好 16.67ms 的一拍」会被判成「还没到」而整帧丢弃，实时档实际掉到 30Hz；
 *     · **FIFO 轮转**：没轮到的实例入队等下一格，队首过期（被暂停 / 已移除）即剔除，
 *       不许出现「一个死名字拖住后面所有人」；
 *     · **首帧（无纹理）必放行**且照样**记账**（占用本格名额）—— 那一刻玻璃还没有可画的
 *       背景，放行它是 draw() 不整帧跳过的前提；
 *     · 进入实时档（beginLiveCapture / setRealtimeCapture）、重新入窗口（didMoveToWindow）、
 *       暂停恢复（handleResumeFromPause）四处都要复位闸门 —— 转场第一拍采到的就是当前画面。
 *
 * ── 第 61 轮（2026-10-11）：A7「重新入窗口」切片的结束锚点从 `resumeFromReentryIfPaused`
 *   换成 `scheduleReentryLiveExpiry` —— 第 61 轮第 3 条把原生「重新入窗口自行恢复渲染」
 *   整条通道（pauseRequested / resumedFromReentry / resumeFromReentryIfPaused /
 *   suspendWhileDetached / clearReentryResume）删除了。为什么删：用户原话「当我右滑时，
 *   底部 tab 栏和迷你播放器栏透过的画面是由右向左滑入的，这个方向是反的，需要改」——
 *   那条通道在返回转场里把正在横向滑走的那一页采进了玻璃。本段其余断言（节拍按实时档 /
 *   2ms 余量 / FIFO / 首帧放行记账 / 四处复位计数）全部未动：didMoveToWindow 仍在同一
 *   位置复位全局闸门（转场第一拍就要采到当前画面），只是不再有自恢复。原生侧「五个
 *   标识符不得复活」的反向断言住在 scripts/sim-glass-firstmount-contract.js 的 B9。
 *
 * ── 第 2 条 · 前半：锁屏「空壳卡」（AppDelegate.mm 的 LXApplyNowPlayingInfo） ──
 *   `nowPlayingInfo = nil` 只撤掉**信息字典**；系统的锁屏 / 灵动岛媒体卡片由「信息字典 +
 *   MPNowPlayingInfoCenter.playbackState」共同决定渲染 —— 启停态仍写着 Playing 时，系统按
 *   「有一路正在播、只是元数据暂时为空」渲染，留下用户截图里那张空壳卡（灰封面、无标题、
 *   无进度、只剩四个按钮）。⇒ 同一个判据、同一个赋值点、同一刻把启停态一起收。
 *   完整形态（含两处下发桥当场补发布、JS 侧禁令）由 scripts/sim-play-with-others-card-exit.js
 *   与 scripts/sim-remote-command-lockscreen-tap.js 把住，本脚本只做交叉回归守卫。
 *
 * ── 第 2 条 · 后半：混音态不被系统打断停播（src/plugins/player/controller.ts） ──
 *   现场：勾选状态下另一个应用出声 → 系统打断压住会话 → AVPlayer 自己暂停 → RNTP 发
 *   'paused' → 落到状态漏斗的 'paused' 分支 → `global.app_event.pause()` → isPlay 翻假；
 *   而 service.ts 混音分支的抢回判据**全都以 playerState.isPlay 为前提**，这一翻就让
 *   「别的音频结束后自动把声音抢回来」整条链失效。⇒ 勾选期间把「引擎自报的暂停」当噪声
 *   吞掉，且**只吞 'paused'**（'stopped' / 'idle' 是会话真的结束，照旧落地），
 *   手动暂停（isManualPause）永远优先。
 *
 * ── 第 3 条：自动续播的原生渐入（AppDelegate.mm） ──
 *   这一拍（引擎重启 → 首帧出声）完全由原生决定，JS 的渐入要等它自己的 'playing' 才起步，
 *   两次事件谁先谁后没有保证 —— 原生先出声的次序里首拍就是满音量。⇒ 在「引擎确实被重新
 *   启动」这个唯一收口（ensureAudioEngineRunningLocked 的 !isRunning 分支）先压 0、再按
 *   600ms / 40ms 步进 smoothstep 升到 currentVolume（【第 63 轮第 2 条】起定性为「衔接斜坡」：
 *   JS 侧的主渐入改成 0~3 秒可配的设置项，两边不再同值，只要求这一段短于主渐入且听得出来）；
 *   JS 任一显式写音量（setVolume 桥）
 *   即作废本斜坡 —— 两层不互顶。
 *
 * 反例自检：以上全是「节拍 / 顺序 / 唯一性 / 不许复活的旧写法」，写反了、漏一处复位、
 * 把让行语义去掉，都不会有任何编译或类型报错，只在真机上表现成用户报的那三种现象。
 * 运行：node scripts/sim-r59-transition-capture-and-resume-fade.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const countOf = (src, needle) => src.split(needle).length - 1

const F = {
  swift: 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassView.swift',
  native: 'ios/LxMusicMobile/AppDelegate.mm',
  controller: 'src/plugins/player/controller.ts',
  service: 'src/plugins/player/service.ts',
}
const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

/** 取某段源码（startAnchor → endAnchor 之前）。任一锚点找不到返回 null。 */
const sliceBetween = (code, startAnchor, endAnchor) => {
  const at = code.indexOf(startAnchor)
  if (at < 0) return null
  const end = code.indexOf(endAnchor, at + startAnchor.length)
  if (end < 0) return null
  return code.slice(at, end)
}

/** 从 signature 起按大括号配平抽出整个函数体（signature 找不到返回 null）。 */
const extractBracedBody = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  // 签名自带开括号（ObjC / TS 的 `... {` 写法）时不能跳过它去找下一个 '{'：那会落到第一个
  // 内层块上 —— 切出来要么只剩一个 if（漏掉整个函数体），要么吞掉下一个函数。本脚本对
  // 「切片里有什么 / 没有什么」的断言全靠这一步准确。
  const braceStart = signature.endsWith('{')
    ? start + signature.length - 1
    : src.indexOf('{', start + signature.length)
  if (braceStart < 0 || src[braceStart] !== '{') return null
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
// 不变量 A：转场里的全局采景闸门（Swift）
// ---------------------------------------------------------------------------

const REQUIRED_TERNARY = 'let interval = isLiveCaptureActive ? Self.liveCaptureMinInterval : Self.captureMinInterval'

const glassGateInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // A1 四个成员齐全，且抖动余量必须是 2ms（0 = 实时档掉回 30Hz；放大 = 节拍失准）
  for (const [needle, why] of [
    ['private static let globalCaptureLock = NSLock()', '跨实例锁'],
    ['private static var globalLastCaptureAt: TimeInterval = 0', '上次放行时刻（0 = 闸门刚复位）'],
    ['private static var globalCaptureQueue: [(id: ObjectIdentifier, at: TimeInterval)] = []', 'FIFO 等待队列'],
  ]) {
    if (!code.includes(needle)) reasons.push(`全局采景闸门缺${why}（${needle}）`)
  }
  if (!code.includes('private static let captureGateJitterGuard: TimeInterval = 0.002')) {
    reasons.push('抖动余量不是 2ms：显示链路 60Hz 节拍（16.667ms）与实时档（16.7ms）只差 0.3ms，'
      + '没有余量时「恰好 16.67ms 的一拍」被判成还没到而整帧丢弃，实时档实际掉到 30Hz'
      + '（滑动中「透过的画面延迟很高」的隐身来源）')
  }

  const gateBody = extractBracedBody(code, 'private func requestGlobalCaptureSlot(_ now: TimeInterval) -> Bool')
  if (gateBody == null) {
    reasons.push('找不到 requestGlobalCaptureSlot（全局采景名额的唯一出口）')
  } else {
    // A2 节拍按实时档选（旧口径固定 0.033 不许复活）
    if (!gateBody.includes(REQUIRED_TERNARY)) {
      reasons.push('闸门节拍不按实时档选（必须是 ' + REQUIRED_TERNARY + '）：固定 0.033s 会把转场里'
        + '三块玻璃的实时档（60fps 承诺）压回合计 30 次/秒 —— 用户第 59 轮「延迟很高」的直接来源')
    }
    if (/[^A-Za-z_.]0\.0\d/.test(gateBody)) {
      reasons.push('闸门里又出现了写死的秒数：节拍只能由 liveCaptureMinInterval / captureMinInterval 两个常量选档')
    }
    // A3 FIFO 轮转 + 队首过期剔除
    if (!gateBody.includes('if let head = Self.globalCaptureQueue.first, head.id != me { return false }')) {
      reasons.push('闸门丢了队首判定（回到先到先得 = 可独占）：每 16.7ms 提交一帧的实例每次都满足间隔，'
        + '另外两块玻璃总被判「刚采过」——三块均分退化成一个饱死、两个饿死，饿死那块拿的是几十毫秒前'
        + '位置对应的矩形内容，折射出来就是「拉伸 / 错位 / 撕裂」')
    }
    if (!gateBody.includes('Self.globalCaptureQueue.removeAll { now - $0.at >= interval }')) {
      reasons.push('闸门不剔除过期队首（被暂停 / 已被移除的实例会让队首永远等不到人，后面所有实例被一个'
        + '死名字无辜拖住）')
    }
    if (!gateBody.includes('Self.globalCaptureQueue.append((me, now))')) {
      reasons.push('闸门不把让行的实例入队（没有队伍就谈不上轮转）')
    }
    // A4 首帧必放行、且照样记账
    if (!gateBody.includes('let firstFrame = backgroundTexture == nil')) {
      reasons.push('闸门不再识别首帧')
    } else {
      const firstFrameBlock = 'if firstFrame {\n            Self.globalCaptureQueue.removeAll { $0.id == me }\n'
        + '            Self.globalLastCaptureAt = now\n            return true\n        }'
      if (!gateBody.includes(firstFrameBlock)) {
        reasons.push('首帧不再无条件放行 / 不再记账：挂载后、抬起会话、刚丢纹理那一刻没有首帧放行，'
          + 'draw() 的「无纹理则跳过本帧」会让玻璃一直透明；不记账则同一拍里两块玻璃会一起上主线程')
      }
    }
    // A5 放行就记账（否则闸门形同虚设 = 每帧都采）
    if (countOf(gateBody, 'Self.globalLastCaptureAt = now') < 2) {
      reasons.push('放行后不记账（globalLastCaptureAt 不在每个放行分支里写）：闸门失效，每帧都整树渲染')
    }
  }

  // A6 调用点在 captureRootView 内，且在 noteCaptureGeometry 之前（被跳过的帧不产生采景状态）
  const captureBody = sliceBetween(code, 'func captureRootView()', 'private func requestGlobalCaptureSlot')
  if (captureBody == null) {
    reasons.push('找不到 captureRootView（或它不再与 requestGlobalCaptureSlot 相邻）')
  } else {
    const iGate = captureBody.indexOf('if !requestGlobalCaptureSlot(CACurrentMediaTime()) { return }')
    const iNote = captureBody.indexOf('noteCaptureGeometry(captureSize)')
    if (iGate < 0) {
      reasons.push('captureRootView 不做全局名额申请：跨实例的主线程整树渲染失去上限'
        + '（三块玻璃同一拍一起 hide→render→restore）')
    } else if (iNote >= 0 && iGate > iNote) {
      reasons.push('名额申请被挪到 noteCaptureGeometry 之后：被闸门跳过的帧也会产生采景相关状态，'
        + '与「被跳过的帧不采景」的口径相悖')
    }
  }

  // A7 四处复位：进入实时档两种入口 + 重新入窗口 + 暂停恢复
  const resetCount = countOf(code, 'Self.resetGlobalCaptureGate()')
  if (resetCount !== 4) {
    reasons.push(`Self.resetGlobalCaptureGate() 有 ${resetCount} 处（应为 4：didMoveToWindow / `
      + 'beginLiveCapture / setRealtimeCapture / handleResumeFromPause）—— 少一处，那条路径的第一帧'
      + '就会卡在上一段会话的格子里（最多 16.7ms + 本帧），转场开头露出的那一下已经是旧画面')
  }
  for (const [sig, endAnchor, label] of [
    ['override func didMoveToWindow()', 'private func scheduleReentryLiveExpiry', '重新入窗口（返回转场开始）'],
    ['func beginLiveCapture()', 'func endLiveCapture()', '进入实时档（透镜抬起）'],
    ['func setRealtimeCapture(_ realtime: Bool)', 'func handleResumeFromPause()', '进入实时档（横滑会话）'],
    ['func handleResumeFromPause()', 'func captureRootView()', '暂停恢复'],
  ]) {
    const body = sliceBetween(code, sig, endAnchor)
    if (body == null) {
      reasons.push(`找不到 ${label} 的函数体（${sig}）`)
    } else if (!body.includes('Self.resetGlobalCaptureGate()')) {
      reasons.push(`${label} 不复位全局闸门：那条路径的第一帧要等下一格才采得到，`
        + '转场第一拍透出的就是旧画面')
    }
  }

  // A8 每实例节流（14~26.1 的 backdrop 路径）仍按实时档选档
  const throttleBody = extractBracedBody(code, 'private func shouldThrottleCapture(_ now: TimeInterval) -> Bool')
  if (throttleBody == null) {
    reasons.push('找不到 shouldThrottleCapture（14~26.1 的 backdrop 采景节流）')
  } else if (!throttleBody.includes(REQUIRED_TERNARY)) {
    reasons.push('每实例采景节流不按实时档选档：14~26.1 上横滑 / 抬起期间透过画面仍留在 30fps 档')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：自动续播的原生渐入（Objective-C++）
// ---------------------------------------------------------------------------

const resumeFadeInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // B1 常量：一段**短的衔接斜坡**（不是主渐入），步数落在合理区间。
  // 【第 63 轮第 2 条】JS 侧的渐入时长改成设置项了（默认 2 秒、0~3 秒可配），两边不再是
  // 「同值」关系 —— 原生的这一段是引擎重启后**接上去**用的（JS 任一显式写音量都会让行，
  // 见下面的 B2），主渐入仍由 JS 侧负责（volumeFade.ts 的 fadeInMs()）。所以判据从
  // 「必须 = 600，与 JS 同值」退化成三条：
  //   · 短到不像主渐入（≤ JS 的默认渐入 2000ms）—— 原生斜坡若比主渐入还长，两层叠起来
  //     就是一段听得出来的双折点；
  //   · 长到听得出来（≥ 200ms）—— 太短就只剩「消爆音」，起不到把 JS 接过手之前那一段
  //     补平的作用；
  //   · 步长整除 + 拍数 [4, 40]（台阶感 / 省电口径，与第 57 轮同一把尺子）。
  const msMatch = code.match(/static const int64_t LXResumeFadeInMs = (\d+);/)
  const stepMatch = code.match(/static const int64_t LXResumeFadeStepMs = (\d+);/)
  if (msMatch == null) {
    reasons.push('缺渐入时长常量 LXResumeFadeInMs（或写法被改）：引擎重启后那一段衔接斜坡没了，'
      + 'JS 的主渐入接手之前会有一段硬接')
  } else {
    const total = Number(msMatch[1])
    if (total > 2000) {
      reasons.push(`原生衔接斜坡 ${total}ms 长过了 JS 的默认渐入（2000ms）：主渐入由 JS 侧负责，`
        + '原生这一段只是「接上去」，两层叠起来就是一段听得出来的双折点（第 63 轮第 2 条把 JS 侧'
        + '的时长改成可配设置项之后，两边不再是同值关系）')
    } else if (total < 200) {
      reasons.push(`原生衔接斜坡只有 ${total}ms：太短就只剩「消爆音」，起不到把 JS 接过手之前`
        + '那一段补平的作用')
    }
    if (stepMatch == null) {
      reasons.push('缺渐入步长常量 LXResumeFadeStepMs')
    } else {
      const step = Number(stepMatch[1])
      if (step <= 0 || total % step !== 0) reasons.push(`渐入步长 ${step}ms 不能整除总时长 ${total}ms（最后一拍会落在半途）`)
      else {
        const steps = total / step
        if (steps < 4) reasons.push(`渐入只有 ${steps} 拍：阶梯太粗，听感仍是「突然变大」`)
        if (steps > 40) reasons.push(`渐入有 ${steps} 拍：每拍一次主线程外的定时唤醒，与第 57 轮省电口径冲突`)
      }
    }
  }

  // B2 唯一写出口的让行语义
  const applyBody = extractBracedBody(code, '- (void)applyOutputVolumeLocked:(float)volume explicitWrite:(BOOL)explicitWrite')
  if (applyBody == null) {
    reasons.push('找不到 applyOutputVolumeLocked（写节点输出音量的唯一出口）')
  } else {
    if (!applyBody.includes('if (explicitWrite) {\n    [self cancelOutputVolumeRampLocked];\n  } else if (self.outputVolumeRampActive) {\n    return;\n  }')) {
      reasons.push('写出口丢了让行语义（显式写入取消息斜坡 / 非显式写入在斜坡期让行）：引擎重启与输出'
        + '自愈那几句会把斜坡刚压下去的音量一步顶回设定值 —— 渐入当场作废，听感回到「自动播放一记满音量」')
    }
    if (!applyBody.includes('if (self.soundEffectMixerNode != nil) self.soundEffectMixerNode.outputVolume = volume;')) {
      reasons.push('写出口不再写节点音量（唯一出口名存实亡）')
    }
  }

  // B3 节点音量只允许三处写：出口 / 斜坡起点压 0 / 斜坡逐拍
  const nodeWrites = countOf(code, 'self.soundEffectMixerNode.outputVolume =')
  if (nodeWrites !== 3) {
    reasons.push(`直接写节点音量的地方有 ${nodeWrites} 处（应为 3：唯一出口 + 斜坡起点压 0 + 斜坡逐拍）—— `
      + '多出来的那处会绕过让行语义，把在途渐入顶掉')
  }
  const beginBody = extractBracedBody(code, '- (void)beginResumeFadeInLocked {')
  if (beginBody == null) {
    reasons.push('找不到 beginResumeFadeInLocked（引擎重启时的渐入起点）')
  } else {
    if (!beginBody.includes('self.soundEffectMixerNode.outputVolume = 0.0f;')) {
      reasons.push('渐入起点不把输出压 0：首拍会带着上一次的输出音量出去')
    }
    if (!beginBody.includes('if (self.currentVolume <= 0.001f) return;')) {
      reasons.push('渐入起点不在 currentVolume 已为 0 时早退：那说明 JS 自己会渐入，原生再压一次是多余的静音窗口')
    }
    if (!beginBody.includes('if (self.soundEffectMixerNode == nil) return;')) {
      reasons.push('渐入起点没有建图守卫（图还没建就开斜坡 = 永远写不到节点上）')
    }
  }
  const stepBody = extractBracedBody(code, '- (void)stepResumeFadeInLocked:(int64_t)generation {')
  if (stepBody == null) {
    reasons.push('找不到 stepResumeFadeInLocked（斜坡的一拍）')
  } else {
    if (!stepBody.includes('if (generation != self.outputVolumeRampGeneration || !self.outputVolumeRampActive) return;')) {
      reasons.push('斜坡那一拍不校验代数令牌：被取消的斜坡会在取消之后继续写音量，把后一次渐入 / 用户'
        + '音量拖回中途值')
    }
    if (!stepBody.includes('float eased = progress * progress * (3.0f - 2.0f * progress);')) {
      reasons.push('斜坡不是 smoothstep（progress 线性）：起止处仍有折角，听感上还是能听出「接上去」的那一刻')
    }
    if (!stepBody.includes('if (progress >= 1.0f) {')) {
      reasons.push('斜坡没有终点判定：最后一拍可能停在半途（音量永久低于设定值）')
    }
  }
  const cancelBody = extractBracedBody(code, '- (void)cancelOutputVolumeRampLocked {')
  if (cancelBody == null) {
    reasons.push('找不到 cancelOutputVolumeRampLocked（取消在途斜坡）')
  } else if (cancelBody.includes('soundEffectMixerNode.outputVolume =')) {
    reasons.push('取消斜坡时又去写音量：调用方紧接着要写自己的值（显式写入）或根本没有节点可写（拆图），'
      + '这里再写一拍只会多一次跳变')
  }

  // B4 引擎重启那一拍：先压 0、再启动引擎；放行写入在分支之后
  const ensureBody = extractBracedBody(code, '- (BOOL)ensureAudioEngineRunningLocked:(NSError **)error {')
  if (ensureBody == null) {
    reasons.push('找不到 ensureAudioEngineRunningLocked（所有「引擎被重新启动」路径的唯一收口）')
  } else {
    const iFade = ensureBody.indexOf('[self beginResumeFadeInLocked];')
    const iStart = ensureBody.indexOf('[self.engine startAndReturnError:error]')
    const iWrite = ensureBody.indexOf('[self applyOutputVolumeLocked:self.currentVolume explicitWrite:NO];')
    if (iFade < 0) {
      reasons.push('引擎重启时不开渐入：这一拍（引擎重启 → 首帧出声）完全由原生决定，JS 的渐入要等'
        + '自己的 playing 才起步 —— 原生先出声的次序里首拍就是满音量（用户第 59 轮「自动播放很快、'
        + '声音突然很大」）')
    } else {
      if (!ensureBody.includes('if (self.engine != nil && !self.engine.isRunning) {')) {
        reasons.push('渐入没有挂在「引擎确实被重新启动」这个条件内：混音态打断期间引擎不停，'
          + '无条件开斜坡会凭空多出一次音量塌陷')
      }
      if (iStart >= 0 && iFade > iStart) {
        reasons.push('渐入起点排在启动引擎之后：先压 0 再启动引擎，首拍才是静音；顺序反过来的话'
          + '首拍会带着上一次的输出音量出去')
      }
    }
    if (iWrite >= 0 && iFade >= 0 && iWrite < iFade) {
      reasons.push('收口处的音量写入排在渐入之前：渐入的第一拍立刻被这一句顶回满音量')
    }
  }

  // B5 拆图 / 建图 / JS 桥三处的配合
  const resetBody = extractBracedBody(code, '- (void)resetStreamingState {')
  if (resetBody == null) {
    reasons.push('找不到 resetStreamingState（换歌 / 复位：拆图）')
  } else if (!resetBody.includes('[self cancelOutputVolumeRampLocked];')) {
    reasons.push('换歌 / 复位时不作废在途渐入：图马上就拆，斜坡没有意义，还会在下一段会话里'
      + '凭旧代数写一次音量')
  }
  const bridgeBody = extractBracedBody(code, 'RCT_REMAP_METHOD(setVolume, setStreamVolume:')
  if (bridgeBody == null) {
    reasons.push('找不到 setVolume 桥（JS 写音量的唯一入口）')
  } else if (!bridgeBody.includes('[self applyOutputVolumeLocked:self.currentVolume explicitWrite:YES];')) {
    reasons.push('setVolume 桥不是显式写入：JS 的音量条 / 用户播放意图 / JS 自己的渐入渐出到达时'
      + '作废不了原生斜坡，两层斜坡互顶（声音在设定值与斜坡当前值之间来回跳）')
  }
  const scheduleBody = extractBracedBody(code, '- (void)scheduleResumeFadeInStepLocked:(int64_t)generation {')
  if (scheduleBody == null) {
    reasons.push('找不到 scheduleResumeFadeInStepLocked（斜坡自链）')
  } else {
    if (!scheduleBody.includes('dispatch_after(dispatch_time(DISPATCH_TIME_NOW, LXResumeFadeStepMs * NSEC_PER_MSEC), self.renderQueue, ^{')) {
      reasons.push('斜坡不用 dispatch_after 自链（dispatch_source 的源对象会被自己的 handler 持成环，'
        + '模块释放后仍持续唤醒 CPU，与第 57 轮省电口径冲突）')
    }
    if (/dispatch_source/.test(scheduleBody)) {
      reasons.push('斜坡又用回了 dispatch_source 定时器')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：混音态不被系统打断停播（controller.ts）
// ---------------------------------------------------------------------------

const mixSuppressionInvariants = (rawController, rawService) => {
  const reasons = []
  const code = stripComments(rawController)
  const serviceCode = stripComments(rawService)

  const POLARITY = "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] === false"

  // C1 两份判定必须同口径（controller 不复用 service 的：service 顶部就 import 本文件，
  //    反向引用会成环 —— 同 core/player/manualPause.ts 头部记录的那条理由）
  if (!code.includes(POLARITY)) {
    reasons.push('controller.ts 的「与其他应用同时播放」极性不对（勾选 = player.isHandleAudioFocus '
      + '为 false）：写反的话未勾选时反而吞暂停、勾选时照旧被系统停播')
  }
  if (!serviceCode.includes(POLARITY)) {
    reasons.push('service.ts 的「与其他应用同时播放」极性被改了：controller 与 service 是两份相同判定，'
      + '两份判定必须同口径（一边改一边不改 = 混音策略与暂停抑制对不上）')
  }
  if (!code.includes("import { isManualPause } from '@/core/player/manualPause'")) {
    reasons.push('controller.ts 没有引入 isManualPause：手动暂停（含锁屏 / 遥控）必须永远优先于抑制')
  }
  if (/from '\.\/service'/.test(code)) {
    reasons.push('controller.ts 反向 import 了 service.ts：service.ts 顶部就 import 本文件，'
      + '反向引用会成环（同 core/player/manualPause.ts 头部记录的那条理由）')
  }

  // C2 五条守卫
  const suppBody = extractBracedBody(code, 'const shouldSuppressSystemPause = () => {')
  if (suppBody == null) {
    reasons.push('找不到 shouldSuppressSystemPause（混音态吞掉引擎自报暂停的判据）')
  } else {
    for (const [needle, why] of [
      ["if (Platform.OS != 'ios') return false", 'iOS 守卫（其它平台没有这条 AVPlayer 自停路径）'],
      ['if (!isPlayWithOthers()) return false', '开关守卫（未勾选 = 独占口径，打断暂停照旧落地）'],
      ['if (isManualPause()) return false', '手动暂停守卫（用户按了暂停 / 锁屏按了暂停，绝不能被吞掉）'],
      ['if (global.lx.isPlayedStop) return false', '停止守卫（播放已结束 / 用户点了停止，暂停必须落地）'],
      ['return playerState.isPlay', '「UI 此刻认为在播才吞」守卫（否则会把一次真实的暂停也吞掉，界面卡在播放态）'],
    ]) {
      if (!suppBody.includes(needle)) reasons.push(`抑制判定缺${why}（${needle}）`)
    }
  }

  // C3 只吞 'paused'：'stopped' / 'idle' 是会话真的结束，必须照旧落地
  const suppressLine = 'if (shouldSuppressSystemPause()) break'
  if (countOf(code, suppressLine) !== 1) {
    reasons.push(`「${suppressLine}」出现 ${countOf(code, suppressLine)} 次（应恰好 1 次：只吞 paused）`)
  }
  const funnelShape = /case 'paused':\s*if \(shouldSuppressSystemPause\(\)\) break\s*case 'stopped':\s*case 'idle':/
  if (!funnelShape.test(code)) {
    reasons.push('状态漏斗不是「paused 这一格只吞引擎自报的暂停，stopped / idle 照旧落地」：'
      + '把抑制挪到 stopped / idle 上，播放结束就不收尾（进度不清、不跳下一首）；'
      + '去掉抑制则勾选后仍会被别的应用停播（用户第 59 轮第 2 条原话）')
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
    results.push({ name, ok: true === hit, detail: hit ? '已拦下' : `未拦下（reasons=${JSON.stringify(reasons)}）` })
  }

  const GATE_TERNARY_LINE = '        let interval = isLiveCaptureActive ? Self.liveCaptureMinInterval : Self.captureMinInterval\n        Self.globalCaptureLock.lock()'

  // g1 闸门节拍写死回旧口径 0.033（转场里实时档被压回合计 30 次/秒）
  check('g1 闸门节拍固定回静止档', () => glassGateInvariants(tamper(REAL.swift,
    GATE_TERNARY_LINE,
    '        let interval = Self.captureMinInterval\n        Self.globalCaptureLock.lock()')),
  '闸门节拍不按实时档选')

  // g2 闸门里写死秒数（绕过两个常量）
  check('g2 闸门里写死秒数', () => glassGateInvariants(tamper(REAL.swift,
    GATE_TERNARY_LINE,
    '        let interval: TimeInterval = 0.05\n        Self.globalCaptureLock.lock()')),
  '写死的秒数')

  // g3 抖动余量被清零（恰好 16.67ms 的一拍被判还没到 → 实时档实际掉到 30Hz）
  check('g3 抖动余量被清零', () => glassGateInvariants(tamper(REAL.swift,
    'private static let captureGateJitterGuard: TimeInterval = 0.002',
    'private static let captureGateJitterGuard: TimeInterval = 0')),
  '抖动余量不是 2ms')

  // g4 队首判定被删（回到先到先得 = 可独占：一个饱死、两个饿死）
  check('g4 队首判定被删', () => glassGateInvariants(tamper(REAL.swift,
    '        if let head = Self.globalCaptureQueue.first, head.id != me { return false }\n',
    '')),
  '丢了队首判定')

  // g5 过期队首不剔除（一个死名字拖住后面所有人）
  check('g5 过期队首不剔除', () => glassGateInvariants(tamper(REAL.swift,
    '        Self.globalCaptureQueue.removeAll { now - $0.at >= interval }\n',
    '')),
  '不剔除过期队首')

  // g6 首帧不再无条件放行（挂载 / 抬起 / 刚丢纹理那一刻玻璃一直透明）
  check('g6 首帧不再放行', () => glassGateInvariants(tamper(REAL.swift,
    '        if firstFrame {\n            Self.globalCaptureQueue.removeAll { $0.id == me }\n            Self.globalLastCaptureAt = now\n            return true\n        }\n',
    '')),
  '首帧不再无条件放行')

  // g7 进入实时档不复位闸门（那条路径的第一帧要等下一格才采得到）
  check('g7 进入实时档不复位闸门', () => glassGateInvariants(tamper(REAL.swift,
    '        lastCaptureAt = 0\n        Self.resetGlobalCaptureGate()\n        consecutiveUniformFrames = 0\n',
    '        lastCaptureAt = 0\n        consecutiveUniformFrames = 0\n')),
  '不复位全局闸门')

  // g8 名额申请被挪到采景状态之后（被跳过的帧也产生状态）
  check('g8 名额申请挪到采景状态之后', () => glassGateInvariants(tamper(REAL.swift,
    '        if !requestGlobalCaptureSlot(CACurrentMediaTime()) { return }\n\n', '')),
  'captureRootView 不做全局名额申请')

  // f1 渐入时长被改成 0（等于没有渐入）
  check('f1 渐入时长被改成 0', () => resumeFadeInvariants(tamper(REAL.native,
    'static const int64_t LXResumeFadeInMs = 600;',
    'static const int64_t LXResumeFadeInMs = 0;')),
  '太短就只剩「消爆音」')

  // f1b 【第 63 轮第 2 条】原生衔接斜坡长过 JS 的默认渐入（两层叠起来 = 一段双折点）
  check('f1b 原生斜坡长过主渐入', () => resumeFadeInvariants(tamper(REAL.native,
    'static const int64_t LXResumeFadeInMs = 600;',
    'static const int64_t LXResumeFadeInMs = 4000;')),
  '长过了 JS 的默认渐入')

  // f2 让行语义被删（引擎重启 / 输出自愈那几句把斜坡顶回满音量）
  check('f2 让行语义被删', () => resumeFadeInvariants(tamper(REAL.native,
    '  } else if (self.outputVolumeRampActive) {\n    return;\n  }\n',
    '  }\n')),
  '丢了让行语义')

  // f3 引擎重启不再开渐入（自动续播一记满音量）
  check('f3 引擎重启不再渐入', () => resumeFadeInvariants(tamper(REAL.native,
    '    [self beginResumeFadeInLocked];\n    if (![self.engine startAndReturnError:error]) return NO;',
    '    if (![self.engine startAndReturnError:error]) return NO;')),
  '引擎重启时不开渐入')

  // f4 先启动引擎再压 0（首拍带着上一次的输出音量出去）
  check('f4 先启动引擎再压 0', () => resumeFadeInvariants(tamper(REAL.native,
    '    [self beginResumeFadeInLocked];\n    if (![self.engine startAndReturnError:error]) return NO;',
    '    if (![self.engine startAndReturnError:error]) return NO;\n    [self beginResumeFadeInLocked];')),
  '排在启动引擎之后')

  // f5 渐入起点不压 0（首拍满音量）
  check('f5 渐入起点不压 0', () => resumeFadeInvariants(tamper(REAL.native,
    '  self.soundEffectMixerNode.outputVolume = 0.0f;\n',
    '')),
  '渐入起点不把输出压 0')

  // f6 setVolume 桥不再显式写入（两层斜坡互顶）
  check('f6 setVolume 桥不再显式', () => resumeFadeInvariants(tamper(REAL.native,
    '    [self applyOutputVolumeLocked:self.currentVolume explicitWrite:YES];\n  });',
    '    [self applyOutputVolumeLocked:self.currentVolume explicitWrite:NO];\n  });')),
  '不是显式写入')

  // f7 换歌 / 复位不作废在途渐入
  check('f7 换歌不作废在途渐入', () => resumeFadeInvariants(tamper(REAL.native,
    '  [self cancelOutputVolumeRampLocked];\n}',
    '}')),
  '换歌 / 复位时不作废在途渐入')

  // f8 别处又直写节点音量（绕过唯一出口）
  check('f8 别处直写节点音量', () => resumeFadeInvariants(tamper(REAL.native,
    '    self.soundEffectMixerNode.pan = 0.0f;\n',
    '    self.soundEffectMixerNode.pan = 0.0f;\n    self.soundEffectMixerNode.outputVolume = self.currentVolume;\n')),
  '直接写节点音量')

  // f9 斜坡改用 dispatch_source（源对象成环 → 常驻唤醒）
  check('f9 斜坡改用 dispatch_source', () => resumeFadeInvariants(tamper(REAL.native,
    '    [self stepResumeFadeInLocked:generation];\n  });',
    '    [self stepResumeFadeInLocked:generation];\n  });\n  dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self.renderQueue);')),
  'dispatch_source')

  // c1 抑制被删（勾选后仍被别的应用停播）
  check('c1 抑制被删', () => mixSuppressionInvariants(tamper(REAL.controller,
    '            if (shouldSuppressSystemPause()) break\n', ''),
    REAL.service),
  '只吞引擎自报的暂停')

  // c2 把手动暂停也吞了（用户按暂停停不下来）
  check('c2 手动暂停也被吞', () => mixSuppressionInvariants(tamper(REAL.controller,
    '  if (isManualPause()) return false\n', ''),
    REAL.service),
  '手动暂停守卫')

  // c3 把停止态也吞了（播放结束不收尾）
  check('c3 停止态也被吞', () => mixSuppressionInvariants(tamper(REAL.controller,
    '  if (global.lx.isPlayedStop) return false\n', ''),
    REAL.service),
  '停止守卫')

  // c4 抑制扩到 stopped / idle（会话真的结束也被吞：不跳下一首）
  check('c4 抑制扩到 stopped / idle', () => mixSuppressionInvariants(tamper(REAL.controller,
    "            if (shouldSuppressSystemPause()) break\n          case 'stopped':\n          case 'idle':\n",
    "          case 'stopped':\n          case 'idle':\n            if (shouldSuppressSystemPause()) break\n"),
    REAL.service),
  '状态漏斗不是')

  // c5 controller 的判定极性写反
  check('c5 抑制判定极性写反', () => mixSuppressionInvariants(tamper(REAL.controller,
    "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] === false",
    "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] !== false"),
    REAL.service),
  '极性不对')

  // c6 service 的判定被单独改掉（两份判定不一致）
  check('c6 service 判定被单独改掉', () => mixSuppressionInvariants(REAL.controller, tamper(REAL.service,
    "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] === false",
    "const isPlayWithOthers = () => settingState.setting['player.isHandleAudioFocus'] !== false")),
  'service.ts 的「与其他应用同时播放」极性被改了')

  // c7 反向 import service（成环）
  check('c7 反向 import service', () => mixSuppressionInvariants(tamper(REAL.controller,
    "import { isManualPause } from '@/core/player/manualPause'",
    "import { isManualPause } from '@/core/player/manualPause'\nimport { cancelResumePending } from './service'"),
    REAL.service),
  '反向 import')

  // c8 丢掉「UI 此刻认为在播」守卫（一次真实的暂停也被吞，界面卡在播放态）
  check('c8 丢掉 UI 在播守卫', () => mixSuppressionInvariants(tamper(REAL.controller,
    '  return playerState.isPlay\n}\n', '  return true\n}\n'),
    REAL.service),
  'UI 此刻认为在播才吞')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-r59-transition-capture-and-resume-fade ===')
console.log('第 59 轮：转场采景闸门（实时档节拍 + FIFO 轮转 + 四处复位）/ 混音态不被系统打断停播 / 自动续播的原生渐入')
console.log()

const checks = [
  ['转场采景闸门（节拍按实时档 + 2ms 抖动余量 + FIFO 轮转 + 首帧放行记账 + 四处复位 + 每实例节流同档）',
    () => glassGateInvariants(REAL.swift)],
  ['自动续播的原生渐入（600/40ms smoothstep 衔接斜坡 + 唯一出口让行 + 引擎重启收口 + 拆图/建图/JS 桥三处配合）',
    () => resumeFadeInvariants(REAL.native)],
  ['混音态不被系统打断停播（五条守卫 + 只吞 paused + 两份判定同口径 + 不成环）',
    () => mixSuppressionInvariants(REAL.controller, REAL.service)],
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
