#!/usr/bin/env node
/**
 * sim-remote-command-volume-fade.js —— 「锁屏 / 灵动岛按键不许被音量斜坡吞掉」契约（第 41 轮）
 *                                    + 「播放 / 暂停的渐入渐出要真的听得见」契约（第 51 轮）
 *
 * 需求原话（2026-10-09 第 41 轮，逐字）：
 *   「重大bug：锁屏界面和灵动岛界面的上一首、下一首、播放/暂停按钮点击后还是无法控制，
 *     特别是播放一段时间后，上面的按钮就不管作用了，而且音乐也会出现嘶哑卡顿和噪声」
 *
 * 背景（读源码 + 逐个调用点核对得到，全部落在第 39 轮新加的
 * `src/plugins/player/volumeFade.ts` 这个渐入渐出模块上）：
 *   第 39 轮为了消掉「播放/暂停的嘶哑卡顿和噪声」加了音量斜坡，但那份实现有四条缺陷，
 *   每一条都会在真机上变成用户这次报的现象：
 *
 *   ① 【暂停被斜坡吞掉 —— 锁屏/灵动岛 ⏸ 点了没反应】
 *      旧 `rampVolume` 第一句就是 `stopFadeTimer()`：新斜坡把旧斜坡的 interval 掐掉时，
 *      旧斜坡那个 `resolve()` 永不执行 → 它的 Promise 永久悬挂。而 `fadeOutThenPause` 是
 *        `await rampVolume(...)` → `await pause()`，
 *      于是只要渐出途中来一次 'playing'（`applyVolumeOnPlayStart`）或 setPlay
 *      （`armVolumeFadeIn`），真暂停就永远不执行。原生流式引擎**每次缓冲耗尽重填都会重新
 *      跨门槛发一次 'playing'**（scheduleBufferingStateForGeneration → maybeStartPlaybackLocked），
 *      播得越久重缓冲越频繁 → 撞窗口概率越大 —— 正是「特别是播放一段时间后」。
 *   ② 【渐出起点用 targetVolume() 而不是当前实际音量】渐出时第一拍把增益从低处跳到接近
 *      满音量再往下降 —— 就是用户听见的爆音/嘶哑。
 *   ③ 【每个 'playing' 都掐斜坡 + 直写目标】渐入途中音量被瞬间顶到目标值 = 一次阶跃（咔哒）。
 *   ④ 【预约渐入没有兜底】`armVolumeFadeIn` 写 0 后若 'playing' 不来，音量永久停在 0：
 *      界面在播、一点声没有，用户按什么都「不管作用」。
 *
 * 本轮口径（每条对应一个可拦回退的不变量；反例 v1–v10 逐条自检）：
 *   一、**斜坡的取消必须放行它自己的 Promise**：`clearInterval` 全文件只有一处（`stopRamp`），
 *       且取消与正常跑完共用同一出口（消费 `fadeResolve`）。旧形状（只清 interval 不 resolve）
 *       一出现就必须红 —— 这一条直接对应缺陷①的悬挂现场。
 *   二、**锁屏暂停绝不依赖斜坡**：`fadeOutThenPause` 必须用「有界等待」包住斜坡
 *       （`settleWithin`），且紧接着**无条件**执行真正的暂停动作；斜坡首参不再接受起点
 *       （起点一律取模块内记录的当前实际音量 `currentVolume`）—— 缺陷①②。
 *   三、**渐出期间让行**：`fadingOut` 期间 `armVolumeFadeIn` / `applyVolumeOnPlayStart`
 *       一律直接返回，不许把在途渐出掐掉、也不许把音量顶回去 —— 缺陷①③。
 *   四、**重复的 'playing' 不打断在途斜坡**：渐入进行中直接忽略，不写音量 —— 缺陷③。
 *   五、**渐入预约有兜底期限**：`ARM_TIMEOUT_MS` 到点无条件恢复设定音量 —— 缺陷④。
 *   六、**音量账本**：斜坡起点取自 `currentVolume`；所有「外部直写」音量（音量条 / 冷启动 /
 *       换曲重贴 / 打断恢复）都要 `syncVolumeFadeState` 同步账本，否则下一拍又是跳变 —— 缺陷②。
 *   七、**整条链不许断**：锁屏 ⏸ → remoteCommand.ts → player.pause → utils.setPause →
 *       fadeOutThenPause；utils.setPlay 必须先 `armVolumeFadeIn`；controller.ts 的三处
 *       'playing'/换曲落点都走 `applyVolumeOnPlayStart`。
 *   八、**原生侧不许静默丢弃用户的按键**：UtilsModule 的 `handleRemoteCommandNotification:`
 *       里不许再出现「监听者没挂上就 return」，改为暂存（有上限的环形缓冲）并在
 *       `startObserving` 里按序补投。
 *
 * ---------------------------------------------------------------------------
 * 【第 51 轮】用户原话（逐字）：「还有一个需求，播放和暂停时增加渐入渐出的效果」。
 *
 * 第 39/41 轮那套斜坡本来就在（上面一整段就是它的现场），用户仍然把这个当成「还没做的
 * 需求」提出来 —— 对着每个调用点核对后，结论是那份实现听得见的只有「半个」。本轮补六件事：
 *
 *   九、**斜坡要长到听得出来，而且得是感知曲线**：旧值 渐入 220ms / 渐出 160ms（每档 20ms
 *       = 11 档 / 8 档）只够消爆音，人耳基本只察觉到「没有咔哒声」；线性斜坡「一上来就掉
 *       一半、尾巴拖得长」的听感也不像淡入。现在 渐入 600ms / 渐出 300ms + smoothstep
 *       （`easeVolume`：p²(3-2p)，单调不减，第 41 轮定死的「斜坡全程单调」不变）。
 *       渐出刻意不比渐入长：真暂停跟在斜坡之后，界面反馈（锁屏进度条停住、按钮变 ▶）
 *       都在那之后，拖太长会让「按了暂停」显得发闷 —— 反例 v18 / v19 / v20。
 *   十、**起播 / 换歌也要渐入**：旧实现只在 `utils.setPlay()`（播放/恢复键）里预约，
 *       点歌 / 换歌走 `engine/resourceLoader.ts` 的两条起播落点，一个都没预约 ——
 *       新歌满音量直接砸出来，这才是用户听到最响的那次硬切换。两条落点都要
 *       `armVolumeStartFadeIn`，且 nativeFlac 分支必须把**起始增益**一起传 0
 *       （`openStreamingFlac` 那次调用会把音量直接交给原生引擎，不传 0 的话预约当场被覆盖）
 *       —— 反例 v21 / v22。
 *   十一、**在途的渐入不许被「重贴设定音量」顶掉**：起播重贴音量（`applyCurrentVolume`）与
 *       打断恢复的 duck 回填（`restoreConfiguredVolume`）都会写一次设定音量，预约期间写下去
 *       渐入即失效（音量已经落在设定值上，斜坡第一拍只是重复写同一个值）；这两处必须用
 *       `isVolumeFadeActive()` 让行。注意 `syncVolumeFadeState` 的账本守卫**不**加
 *       `fadeInArmed`：账本要跟着真正写出的值走（音量条拖动就是一次真实写入），
 *       拦下来反而会让斜坡从旧值起步（多一次音量塌陷）—— 反例 v23 / v24。
 *   十二、**渐出途中的播放意图赢**：旧 `armVolumeFadeIn` 在 `fadingOut` 期间直接 return，
 *       连用户的 ▶ 一起扔了 —— 渐出跑完，真暂停照常落地，按播放得到的却是「停住不动」。
 *       现在 `armFadeIn` 的 `fadingOut` 分支：`pauseSeq++` 作废在途真暂停 + 斜坡就地掉头
 *       （从当前值平滑升回设定值，不是跳变）+ 重建预约。第 41 轮那条「渐出期间让行」只管
 *       **自动**路径（'playing' 事件 / 音量直写），用户的按键不在让行之列；
 *       `fadeOutThenPause` 也只有在「号没变」时才把暂停落地 —— 反例 v17 / v25 / v26。
 *   十三、**预约时两台引擎一起压 0**：预约卡在「上一首的引擎还没拆、下一首的引擎还没起」
 *       的窗口里，只压当前激活那台，另一台会带着旧音量起播（渐入第一拍之前先来一声满音量）
 *       —— 反例 v27。
 *   十四、**起播预约用自己的兜底期限**（`START_ARM_TIMEOUT_MS` = 6s）：起播要等拿链接 +
 *       缓冲，'playing' 比恢复播放晚得多，1.5s 那个期限会在出声前就到期 ——
 *       起播渐入十次有八次白预约 —— 反例 v28。
 *
 * 为什么必须靠契约脚本：这四条缺陷在编译期、渲染期全合法（Promise 悬挂是运行期语义，
 * 类型检查看不出来），只有「按住锁屏 ⏸ 的那一刻」才炸。谁把斜坡改回「清 interval 不 resolve」、
 * 把渐出起点改回设定音量、把有界等待拆掉、把让行守卫删掉、把兜底期限删掉，脚本立刻红。
 *
 * 运行：node scripts/sim-remote-command-volume-fade.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 剔注释：只去块注释与整行 `//` 注释。
// volumeFade.ts 的文件头大段说明里就写着旧实现的形状（`rampVolume(targetVolume(), ...)` 等），
// 不剔会假命中「旧形状回来了」这类断言 —— 这也正是兄弟脚本 sim-daily-rec-default-tab.js 的做法。
// 不从行中间切断的原因同兄弟脚本：代码行里就有 `//` 之外的引号串。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

// AppDelegate.mm 里 ObjC 注释体量大且含 `/* ... */`，这里只剔整行 `//`（块注释在 .mm 里
// 出现形式不可控，宁可少剔也不误删代码）
const stripLineComments = (src) => src
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  fade: 'src/plugins/player/volumeFade.ts',
  utils: 'src/plugins/player/utils.ts',
  controller: 'src/plugins/player/controller.ts',
  core: 'src/plugins/player/trackPlayerCore.ts',
  service: 'src/plugins/player/service.ts',
  player: 'src/core/player/player.ts',
  remote: 'src/core/init/player/remoteCommand.ts',
  appDelegate: 'ios/LxMusicMobile/AppDelegate.mm',
  // 【第 51 轮】起播 / 换歌的两条落点与引擎起始增益（渐入链的上游）
  resourceLoader: 'src/plugins/player/engine/resourceLoader.ts',
  nativeFlac: 'src/plugins/player/nativeFlac.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

/** 切一段：from（含）→ to（不含）。任一锚点找不到返回 null（锚点漂移必须显式失败） */
const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  if (to == null) return src.slice(start)
  const end = src.indexOf(to, start + from.length)
  if (end < 0) return null
  return src.slice(start, end)
}

const countOf = (src, needle) => src.split(needle).length - 1

/**
 * 取一个「以 `{` 结尾的声明行」的函数体（花括号配平到与之匹配的收尾 `}`）。
 * 【第 51 轮】固定长度窗口（slice(at, at + 900)）在这个文件里不够用：volumeFade.ts 的
 * 函数都很短，窗口会伸进下一个函数 —— 「分支不见了」这类断言会被后一个函数里同名形状
 * 假满足（反例就变成「未拦下」）。传入的必须是 **stripComments 之后**的副本
 * （块注释已去，整行 // 已去；剩下的行内 // 由扫描器跳过）。
 */
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

// ---------------------------------------------------------------------------
// 一、斜坡取消必须放行（缺陷①的悬挂现场）
// ---------------------------------------------------------------------------
const rampCancelInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)

  // clearInterval 全文件只允许一处，且必须在 stopRamp 里 —— 只要有人在别处再掐一次 interval，
  // 就意味着「又出现了一条不会 resolve 的取消路径」
  if (countOf(code, 'clearInterval(') !== 1) {
    reasons.push('volumeFade.ts 里的 clearInterval 不止一处：斜坡的取消必须只发生在 stopRamp 里'
      + '（别处再掐一次 = 又造出一条不放行 Promise 的取消路径，await 它的调用方会永久停住）')
  }
  const stopRampAt = code.indexOf('const stopRamp = () => {')
  if (stopRampAt < 0) {
    reasons.push('找不到 stopRamp（斜坡的统一取消出口没了）')
  } else {
    const body = code.slice(stopRampAt, stopRampAt + 400)
    if (!body.includes('clearInterval(fadeTimer)')) reasons.push('stopRamp 没有清掉斜坡 interval')
    if (!body.includes('const resolve = fadeResolve')) {
      reasons.push('stopRamp 没有取走在途斜坡的 resolve 句柄：取消路径不放行 Promise，'
        + 'await 它的 fadeOutThenPause 会永久停住，后面的真暂停永远不执行（第 41 轮缺陷①）')
    }
    if (!body.includes('fadeResolve = null')) reasons.push('stopRamp 没有清空 fadeResolve（句柄泄漏）')
    if (!body.includes('if (resolve != null) resolve()')) {
      reasons.push('stopRamp 没有真正放行在途 Promise：取消/完成必须共用同一出口（第 41 轮缺陷①）')
    }
  }
  // 斜坡本体：句柄登记 + 完成走同一个 stopRamp
  if (!code.includes('const rampVolume = (to: number, durationMs: number): Promise<void> => {')) {
    reasons.push('rampVolume 的签名变了：它必须只收「目标值 + 时长」，起点一律取模块内的当前实际音量'
      + '（旧签名收 from，调用方传设定音量就是那声爆音的来源，第 41 轮缺陷②）')
  }
  if (!code.includes('fadeResolve = resolve')) reasons.push('斜坡没有登记自己的 resolve 句柄')
  if (!code.includes('if (step >= steps) stopRamp()')) {
    reasons.push('斜坡跑完没有走 stopRamp（完成与取消必须是同一出口）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 二、锁屏暂停绝不依赖斜坡（有界等待 + 无条件执行 + 起点是当前实际音量）
// ---------------------------------------------------------------------------
const pauseNeverBlockedInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)

  if (!code.includes('const settleWithin = (promise: Promise<void>, ms: number): Promise<void> => {')) {
    reasons.push('找不到 settleWithin（有界等待）：斜坡只是让「停」柔和，绝不允许拦住暂停动作')
  }
  const at = code.indexOf('await settleWithin(rampVolume(0, FADE_OUT_MS)')
  if (at < 0) {
    reasons.push('fadeOutThenPause 没有用有界等待包住渐出斜坡（`await settleWithin(rampVolume(0, FADE_OUT_MS), ...)`）：'
      + '斜坡一旦被掐/卡住，真暂停就跟着永远不执行 —— 锁屏/灵动岛 ⏸ 点了没反应就是这个（第 41 轮缺陷①）')
  } else {
    if (!code.slice(at, at + 160).includes('FADE_OUT_MS + FADE_STEP_MS * 2')) {
      reasons.push('有界等待的期限不是「渐出时长 + 两拍余量」：期限必须有限，否则等于没有兜底')
    }
    const after = code.slice(at, at + 400)
    if (!after.includes('await Promise.resolve(pause()).catch(() => {})')) {
      reasons.push('渐出斜坡之后没有**无条件**执行真正的暂停动作：暂停动作必须在有界等待放行的下一条，'
        + '不许挂在斜坡的成功路径上（第 41 轮缺陷①）')
    }
  }
  // 【第 51 轮】「无条件执行」只有一条例外：**用户自己后来按下的播放**。`fadeOutThenPause`
  // 进门领号、放行后对号，号变了就说明这条暂停已被更新的用户意图取代（`armFadeIn` 的掉头
  // 分支 ++），不落地。少了这一步，渐出途中按 ▶ 得到的是「停住不动」。
  const seqAt = code.indexOf('const seq = ++pauseSeq')
  if (seqAt < 0) {
    reasons.push('fadeOutThenPause 没有给这次暂停领号（缺 `const seq = ++pauseSeq`）：'
      + '渐出途中用户按下播放时无法判断这条暂停是否已被取代（第 51 轮第 12 条）')
  } else if (!code.slice(seqAt, seqAt + 400).includes('if (seq != pauseSeq) return')) {
    reasons.push('fadeOutThenPause 放行后没有对号（缺 `if (seq != pauseSeq) return`）：'
      + '渐出途中按下播放，暂停还是会落地 —— 用户按 ▶ 得到「停住不动」（第 51 轮第 12 条）')
  }
  // 反例形状：文件里不许出现「直接 await 斜坡来暂停」的旧写法
  if (code.includes('await rampVolume(targetVolume()')) {
    reasons.push('出现了旧写法 `await rampVolume(targetVolume(), ...)`：渐出起点又用回设定音量'
      + '（低音量处会先跳高再降 = 爆音），且斜坡直接拦在暂停前面（第 41 轮缺陷①②）')
  }
  // 渐出重入守卫：连点两次暂停时，第二次也要真的执行暂停（只是不再叠一层斜坡）
  const fadeOutAt = code.indexOf('export const fadeOutThenPause = async(')
  if (fadeOutAt < 0) {
    reasons.push('找不到 fadeOutThenPause（暂停的唯一收口没了）')
  } else {
    const body = code.slice(fadeOutAt, fadeOutAt + 1200)
    if (!body.includes('fadingOut = true')) reasons.push('fadeOutThenPause 没有置「渐出中」标记（让行守卫的前提没了）')
    if (!body.includes('fadingOut = false')) reasons.push('fadeOutThenPause 没有在结尾清掉「渐出中」标记（会永久让行，音量再也不会恢复）')
    if (!body.includes('if (fadingOut) {')) {
      reasons.push('fadeOutThenPause 没有重入守卫：连点两次暂停会叠第二层斜坡（第二次的暂停动作必须照常执行）')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 三、渐出期间让行 + 四、重复 'playing' 不打断在途斜坡 + 五、渐入兜底期限
// ---------------------------------------------------------------------------
const fadeInGuardInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)

  // 三、渐入预约：两个入口（恢复 / 起播）都必须走同一条预约体；渐出途中不许把用户的 ▶ 一起扔掉
  const armAt = code.indexOf('export const armVolumeFadeIn = () => {')
  if (armAt < 0) {
    reasons.push('找不到 armVolumeFadeIn')
  } else if (!code.slice(armAt, armAt + 200).includes('armFadeIn(ARM_TIMEOUT_MS)')) {
    reasons.push('armVolumeFadeIn 没有走统一的预约体 armFadeIn：渐出途中的掉头守卫 / 兜底期限会缺')
  }
  // 【第 51 轮】起播 / 换歌的预约入口：同一个预约体，但要用自己的（更长的）兜底期限
  const startArmAt = code.indexOf('export const armVolumeStartFadeIn = () => {')
  if (startArmAt < 0) {
    reasons.push('找不到 armVolumeStartFadeIn（第 51 轮起播 / 换歌的渐入预约入口）：'
      + '点歌 / 换歌那条路的新歌还是满音量直接砸出来')
  } else if (!code.slice(startArmAt, startArmAt + 200).includes('armFadeIn(START_ARM_TIMEOUT_MS)')) {
    reasons.push('armVolumeStartFadeIn 没有走统一的预约体，或没用自己的兜底期限：'
      + '起播要等拿链接 + 缓冲，1.5s 期限会在出声前就到期（起播渐入白预约，第 51 轮第 14 条）')
  }
  const body = bracedBody(code, 'const armFadeIn = (timeoutMs: number): boolean => {')
  if (body == null) {
    reasons.push('找不到 armFadeIn（渐入预约的统一体）')
  } else {
    const abortAt = body.indexOf('if (fadingOut) {')
    if (abortAt < 0) {
      reasons.push('armFadeIn 没有处理「渐出途中又按播放」：旧实现一让了之，用户的 ▶ 被自己的渐出吞掉'
        + ' —— 渐出跑完真暂停照常落地，按播放得到的是「停住不动」（第 51 轮第 12 条）')
    } else {
      const abortBody = body.slice(abortAt, abortAt + 500)
      if (!abortBody.includes('pauseSeq++')) {
        reasons.push('armFadeIn 的渐出途中分支没有作废在途的真暂停（缺 `pauseSeq++`）：'
          + '用户的播放意图被自己的暂停吞掉（第 51 轮第 12 条）')
      }
      if (!abortBody.includes('void rampVolume(targetVolume(), FADE_IN_MS)')) {
        reasons.push('armFadeIn 的渐出途中分支没有把音量斜坡拉回设定值：应从当前值平滑升回'
          + '（不是跳变），否则用户听见的是一次爆音（第 51 轮第 12 条）')
      }
      if (!abortBody.includes('beginFadeInArm(')) {
        reasons.push('armFadeIn 的渐出途中分支没有重建预约：掉头之后若没有 \'playing\' 事件，'
          + '音量会停在半路（兜底期限也没了）')
      }
    }
    if (!body.includes('beginFadeInArm(timeoutMs)')) {
      reasons.push('armFadeIn 没有走统一的预约体 beginFadeInArm：兜底期限会缺（第 41 轮缺陷④）')
    }
    if (!body.includes('silenceBothEngines()')) {
      reasons.push('armFadeIn 没有把两台引擎一起压到 0：预约卡在「上一首的引擎还没拆、下一首的引擎'
        + '还没起」的窗口里，只压当前激活那台，另一台会带着旧音量起播（第 51 轮第 13 条）')
    }
  }
  const silenceBody = bracedBody(code, 'const silenceBothEngines = () => {')
  if (silenceBody == null) {
    reasons.push('找不到 silenceBothEngines（预约时把两台引擎一起压 0 的唯一出口）')
  } else {
    const body = silenceBody
    if (!body.includes('void writeVolume(0)')) {
      reasons.push('silenceBothEngines 没有压当前激活的那台引擎')
    }
    if (!body.includes('TrackPlayer.setVolume(0)')) {
      reasons.push('silenceBothEngines 没有压**另一台**（AVPlayer）：跨引擎切换的中间态里它会带着旧音量起播')
    }
  }
  // 五、渐入兜底期限（两个入口共用 beginFadeInArm）
  const beginBody = bracedBody(code, 'const beginFadeInArm = (timeoutMs: number) => {')
  if (beginBody == null) {
    reasons.push('找不到 beginFadeInArm（渐入预约的统一体）')
  } else {
    const body = beginBody
    if (!code.includes('const ARM_TIMEOUT_MS')) {
      reasons.push('找不到 ARM_TIMEOUT_MS（渐入预约的兜底期限）：预约后没等到 \'playing\' 就永久停在 0 音量，'
        + '表现为「在播但一点声没有、按什么都没反应」（第 41 轮缺陷④）')
    }
    if (!code.includes('const START_ARM_TIMEOUT_MS')) {
      reasons.push('找不到 START_ARM_TIMEOUT_MS（起播预约的兜底期限）：起播要等拿链接 + 缓冲，'
        + '用 1.5s 的期限会在出声前就到期 —— 起播渐入白预约（第 51 轮第 14 条）')
    }
    if (!body.includes('}, timeoutMs)')) {
      reasons.push('beginFadeInArm 没有设兜底定时器：预约写 0 之后必须有个到期无条件恢复设定音量的后手'
        + '（第 41 轮缺陷④）')
    }
    if (!body.includes('if (!fadeInArmed) return')) {
      reasons.push('beginFadeInArm 的兜底回调没有「预约已被消费就跳过」的判定（会把渐入播到一半的音量顶到目标值）')
    }
    if (!body.includes('void writeVolume(targetVolume())')) {
      reasons.push('beginFadeInArm 的兜底回调没有恢复用户设定音量')
    }
  }

  const applyAt = code.indexOf('export const applyVolumeOnPlayStart = async() => {')
  if (applyAt < 0) {
    reasons.push('找不到 applyVolumeOnPlayStart')
  } else {
    const body = code.slice(applyAt, applyAt + 700)
    // 三、渐出期间不许把音量顶回去
    if (!body.includes("if (Platform.OS == 'ios' && fadingOut) return")) {
      reasons.push("applyVolumeOnPlayStart 没有在渐出期间让行：'playing' 事件会把正在渐出的音量顶回去"
        + '（用户按了暂停反而听见一声涨回来，第 41 轮缺陷①）')
    }
    // 四、重复 'playing' 不打断在途斜坡
    if (!body.includes("if (Platform.OS == 'ios' && fadeTimer != null) return")) {
      reasons.push("applyVolumeOnPlayStart 没有忽略「渐入进行中的重复 'playing'」："
        + '旧实现每次都掐斜坡再直写目标 = 一次音量阶跃（咔哒/噪声，第 41 轮缺陷③）')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 六、音量账本 + 外部直写同步
// ---------------------------------------------------------------------------
const volumeLedgerInvariants = (src, deps) => {
  const reasons = []
  const code = stripComments(src)

  const writeAt = code.indexOf('const writeVolume = (volume: number): Promise<unknown> => {')
  if (writeAt < 0) {
    reasons.push('找不到 writeVolume')
  } else {
    const body = code.slice(writeAt, writeAt + 400)
    const assignAt = body.indexOf('currentVolume = clamp01(volume)')
    const dispatchAt = body.indexOf('return setNativeFlacVolume(currentVolume)')
    if (assignAt < 0) {
      reasons.push('writeVolume 没有把写出的值记进 currentVolume：斜坡起点取自这个账本，'
        + '账本不更新则下一次斜坡的起点是错的（第 41 轮缺陷②）')
    } else if (dispatchAt >= 0 && assignAt > dispatchAt) {
      reasons.push('writeVolume 里账本赋值在引擎分发之后：写失败/分发异常时账本与实值脱节')
    }
  }
  if (!code.includes('const from = currentVolume')) {
    reasons.push('斜坡的起点不是当前实际音量（currentVolume）：起点取设定音量就会在低音量处'
      + '先跳高再降 —— 那一声爆音（第 41 轮缺陷②）')
  }
  const syncAt = code.indexOf('export const syncVolumeFadeState = (volume: number) => {')
  if (syncAt < 0) {
    reasons.push('找不到 syncVolumeFadeState（外部直写音量时同步账本的唯一入口）')
  } else {
    const body = code.slice(syncAt, syncAt + 500)
    if (!body.includes('if (fadeTimer != null || fadingOut) return')) {
      reasons.push('syncVolumeFadeState 在斜坡/渐出进行中也会覆盖账本：会把在途斜坡的起点改错（应让行）')
    }
  }

  // 三个外部直写点都必须同步账本（缺一处，那条路径之后的第一次斜坡起点就是错的）
  const utilVolume = slice(stripComments(deps.utils), 'export const setVolume = async(num: number) => {', 'export const setPlaybackRate')
  if (utilVolume == null) {
    reasons.push('utils.ts 里找不到 setVolume')
  } else if (!utilVolume.includes('syncVolumeFadeState(num)')) {
    reasons.push('utils.setVolume（音量条 / 冷启动 / 回前台重贴音量）没有同步账本')
  }
  const applyVolume = slice(stripComments(deps.core), 'export const applyCurrentVolume = async() => {', 'export const getTrackDuration')
  if (applyVolume == null) {
    reasons.push('trackPlayerCore.ts 里找不到 applyCurrentVolume')
  } else if (!applyVolume.includes("syncVolumeFadeState(settingState.setting['player.volume'])")) {
    reasons.push('applyCurrentVolume（起播 / 恢复曲重贴音量）没有同步账本：紧接着的渐入会从 0 起步'
      + '（先瘪下去再升上来，多一次音量抖动）')
  } else if (!applyVolume.includes('isVolumeFadeActive()')) {
    // 【第 51 轮】起播渐入在途时这里必须整个让行：它写一次用户设定音量，预约好的渐入当场作废
    reasons.push('applyCurrentVolume（起播重贴音量）没有给在途的渐入让行：预约把两台引擎压到 0 之后'
      + '这里又写一次用户设定音量，音量落在设定值上，之后的「渐入」斜坡等于重复写同一个值'
      + '（听感上还是新歌硬起播）—— 第 51 轮第 11 条')
  }
  const restoreVolume = slice(stripComments(deps.service), 'const restoreConfiguredVolume = () => {', 'const registerPlaybackService')
  if (restoreVolume == null) {
    reasons.push('service.ts 里找不到 restoreConfiguredVolume')
  } else if (!restoreVolume.includes("syncVolumeFadeState(settingState.setting['player.volume'])")) {
    reasons.push('打断恢复（duck 回填）的直写没有同步账本：账本脱节会让下一次渐入/渐出的第一拍变成跳变')
  } else if (!restoreVolume.includes('isVolumeFadeActive()')) {
    // 【第 51 轮】同一个道理：打断恢复的 duck 回填也会写一次设定音量，预约期间写下去渐入即失效
    reasons.push('打断恢复（duck 回填）的直写没有给在途的渐入让行：预约把音量压到 0 之后这里又写回'
      + '用户设定音量，渐入当场作废（第 51 轮第 11 条）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 九（第 51 轮）：斜坡的时长与曲线 —— 「渐入渐出」要真的听得出来
// ---------------------------------------------------------------------------
const fadeShapeInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)

  const fadeIn = /const FADE_IN_MS = (\d+)/.exec(code)
  if (fadeIn == null) {
    reasons.push('找不到 FADE_IN_MS（渐入时长）')
  } else if (Number(fadeIn[1]) < 400) {
    reasons.push(`渐入时长太短（${fadeIn[1]}ms）：220ms 级的斜坡只够消爆音，人耳基本只能察觉到`
      + '「没有咔哒声」，听不出「渐入」—— 用户第 51 轮要的是听得见的效果（第 51 轮第 9 条）')
  }
  const fadeOut = /const FADE_OUT_MS = (\d+)/.exec(code)
  if (fadeOut == null) {
    reasons.push('找不到 FADE_OUT_MS（渐出时长）')
  } else if (Number(fadeOut[1]) < 240) {
    reasons.push(`渐出时长太短（${fadeOut[1]}ms）：160ms 级的斜坡听不出「渐出」（第 51 轮第 9 条）`)
  }
  if (!code.includes('const easeVolume = (progress: number) => progress * progress * (3 - 2 * progress)')) {
    reasons.push('找不到 smoothstep 感知曲线 easeVolume：线性斜坡「一上来就掉一半、尾巴拖得长」，'
      + '600ms 级的渐入渐出听上去发假（第 51 轮第 9 条）')
  }
  if (!code.includes('from + (target - from) * easeVolume(step / steps)')) {
    reasons.push('斜坡没有走感知曲线（smoothstep）：音量还是线性摊开')
  }
  if (!code.includes('const FADE_STEP_MS = 20')) {
    reasons.push('找不到 FADE_STEP_MS = 20（斜坡档距）：档距一变大，台阶感（zipper 噪声）就回来了')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 十（第 51 轮）：起播 / 换歌的渐入链（resourceLoader 两条落点 → 引擎起始增益）
// ---------------------------------------------------------------------------
const startFadeChainInvariants = (deps) => {
  const reasons = []
  if (deps.resourceLoader == null || deps.nativeFlac == null) {
    reasons.push('startFadeChainInvariants 缺依赖（resourceLoader / nativeFlac）')
    return reasons
  }
  const loader = stripComments(deps.resourceLoader)
  const flac = stripComments(deps.nativeFlac)

  if (countOf(loader, 'armVolumeStartFadeIn()') < 2) {
    reasons.push('resourceLoader 的两条起播落点没有都预约起播渐入（`armVolumeStartFadeIn()` 少于两处）：'
      + '漏哪条，那条路上的新歌就是满音量硬起播（第 51 轮第 10 条）')
  }
  if (!loader.includes('const startFadeArmed = shouldAutoStart && armVolumeStartFadeIn()')) {
    reasons.push('起播渐入预约没有挂在 shouldAutoStart 上：恢复曲「起播位置但保持暂停」也会被压 0 六秒')
  }
  if (!loader.includes('startFadeArmed ? 0 : undefined')) {
    reasons.push('nativeFlac 起播没有把**起始增益**传 0：openStreamingFlac 会把用户设定音量直接交给'
      + '原生引擎，预约的渐入当场被覆盖（音量本来就在设定值上，斜坡第一拍等于重复写同一个值）'
      + '—— 第 51 轮第 10 条')
  }
  if (!flac.includes('startVolume?: number')) {
    reasons.push('startNativeFlacPlayback 的签名里没有 startVolume 参数（引擎起始增益传不进去）')
  }
  if (!flac.includes("startVolume ?? settingState.setting['player.volume']")) {
    reasons.push('startNativeFlacPlayback 没有把 startVolume 交给引擎（缺省必须回退用户设定音量，'
      + '否则非渐入起播会没声音）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 七、整条链不许断（锁屏按键 → 真暂停 / 真播放）
// ---------------------------------------------------------------------------
const chainInvariants = (deps) => {
  const reasons = []
  const strip = (k) => stripComments(deps[k])

  // 锁屏 ⏸ → player.pause → utils.setPause → fadeOutThenPause（暂停的唯一收口）
  const pauseFn = slice(strip('player'), 'export const pause = async() => {', '}')
  if (pauseFn == null) {
    reasons.push('core/player/player.ts 里找不到 pause（锁屏暂停的 JS 入口）')
  } else if (!pauseFn.includes('await setPause()')) {
    reasons.push('player.pause 没有走 utils.setPause：锁屏 ⏸ 就绕开了「有界渐出 + 无条件暂停」的收口')
  }
  const playFn = slice(strip('player'), 'export const play = () => {', '\n}')
  if (playFn == null) {
    reasons.push('core/player/player.ts 里找不到 play（锁屏播放的 JS 入口）')
  } else if (!playFn.includes('void setPlay()')) {
    reasons.push('player.play 没有走 utils.setPlay：渐入预约不会建立（锁屏 ▶ 之后没有渐入，'
      + '但更要紧的是这条链的收口口径被绕开了）')
  }
  const utils = strip('utils')
  const setPlay = slice(utils, 'export const setPlay = async() => {', 'export const setStop')
  if (setPlay == null) {
    reasons.push('utils.ts 里找不到 setPlay')
  } else if (!setPlay.includes('armVolumeFadeIn()')) {
    reasons.push('utils.setPlay 没有预约渐入（armVolumeFadeIn）：渐入链的起点没了')
  }
  // 结尾锚点必须用**剔注释之后**还在的代码行（`// export const skipToNext` 那行是注释）
  // 【第 47 轮】暂停收口从「按引擎二选一的 fadeOutThenPause(...)」升级成
  // pausePlayingEngines（双引擎）+ 有界复核，整块都在 setPause 之前，所以切片起点
  // 前移到第 47 轮的复核窗口常量（它一旦消失，说明这份契约要重写，必须显式失败）。
  const pauseClosure = slice(utils, 'const PAUSE_VERIFY_MS = 700', 'export const setCurrentTime')
  if (pauseClosure == null) {
    reasons.push('utils.ts 里找不到第 47 轮的暂停收口区块（缺 `const PAUSE_VERIFY_MS = 700`）')
  } else {
    const setPause = slice(pauseClosure, 'export const setPause = async() => {', '\n}')
    if (setPause == null) {
      reasons.push('utils.ts 里找不到 setPause')
    } else {
      if (!setPause.includes('await fadeOutThenPause(pausePlayingEngines)')) {
        reasons.push('setPause 的 iOS 分支没有走 fadeOutThenPause：暂停绕开了「无条件执行」的收口')
      }
      if (!setPause.includes('const token = ++pauseVerifyToken')) {
        reasons.push('setPause 没有给复核上令牌：连点暂停时先发的复核会作废后发的暂停')
      }
      if (!setPause.includes('}, PAUSE_VERIFY_MS)') || !setPause.includes('void pausePlayingEngines()')) {
        reasons.push('setPause 缺「暂停发出后有界复核」：引擎没停 / 状态事件丢了时没人补刀，'
          + '用户就会看到「进度条停了、歌词还在走、声音还在放」')
      }
      if (!setPause.includes('if (!playerState.isPlay) return')) {
        reasons.push('setPause 的复核不再看 playerState.isPlay：停稳了也照发（或反过来放过真没停的）')
      }
    }
    // 【第 47 轮】双引擎收口：暂停不许再按 isNativeFlacActive() 二选一 ——
    // 只停「当前驱动」那一台，跨引擎切换的中间态里出声的那台照放。
    if (!pauseClosure.includes('const pausePlayingEngines = async() => {')) {
      reasons.push('第 47 轮的双引擎暂停收口 pausePlayingEngines 不见了：暂停又退回「按 isNativeFlacActive() 二选一」')
    } else {
      const engines = slice(pauseClosure, 'const pausePlayingEngines = async() => {', '\n}')
      if (engines == null || !engines.includes('await pauseNativeFlacPlayback()')) {
        reasons.push('pausePlayingEngines 没有把暂停发给原生流式引擎：nativeFlac 那台可能照旧出声')
      }
      if (engines == null || !engines.includes('await TrackPlayer.pause()')) {
        reasons.push('pausePlayingEngines 没有把暂停发给 AVPlayer：RNTP 那台可能照旧出声')
      }
      if (engines == null || !engines.includes('rntpMayHoldTrack()')) {
        reasons.push('pausePlayingEngines 不再判断 `rntpMayHoldTrack()`（RNTP 是否还可能持有曲目）：跨引擎切换的中间态会漏掉出声的那台')
      }
      // 【第 47 轮】判据本身：空 id（reset / ended 之后「连最后驱动是谁都不知道」的窗口）
      // 也必须算「可能持有」—— 收窄成「只认上一次驱动是 RNTP」就会让
      // 「谁的 id 都没了、但 RNTP 那台还在出声」漏网，那正是用户听到的「声音继续播放」。
      const hold = slice(pauseClosure, 'const rntpMayHoldTrack = () => {', '\n}')
      if (hold == null || !hold.includes('!id ||')) {
        reasons.push('rntpMayHoldTrack 的判据被收窄：空 id（连最后驱动都不知道的窗口）不再算「RNTP 可能持有」，残留出声的那台会漏发暂停')
      }
    }
  }
  // 【第 47 轮】用户的播放意图必须作废在途的暂停复核（否则复核窗口内按下的 ▶ 会被按停）
  if (setPlay != null && !setPlay.includes('pauseVerifyToken++')) {
    reasons.push('utils.setPlay 没有作废在途的暂停复核：复核会跟用户抢（刚按下的播放被 700ms 后的复核按停）')
  }
  // 【第 47 轮】原生 pause 不许把「停不停引擎」押在 engine.isRunning 前置上：
  // 引擎恰好处于「已 prepare 未 start / 刚被系统停掉待重建」的窗口时整句被跳过，
  // 只剩渲染开关生效 —— 声音继续、卡片却是暂停态。
  if (deps.appDelegate == null) {
    reasons.push('chainInvariants 缺 appDelegate 依赖（原生 pause 的判据查不了）')
  } else {
    // 判据必须跑在**剔掉整行注释**的副本上：第 47 轮的修法注释里逐字引用了旧写法
    // （`if (self.engine != nil && self.engine.isRunning) [self.engine pause];`），
    // 不剔注释的话「isRunning 前置回来了」会被自己的注释假命中 —— 断言永久红、
    // 反例 v16 也会假绿（未真篡改代码却照样「已拦下」）。
    const pauseBody = slice(stripLineComments(deps.appDelegate),
      'RCT_REMAP_METHOD(pause, pauseStreamWithResolver:', 'RCT_REMAP_METHOD(stop, stopStreamWithResolver:')
    if (pauseBody == null) {
      reasons.push('AppDelegate.mm 里找不到原生 pause 方法体（锚点漂移）')
    } else {
      if (!pauseBody.includes('if (self.engine != nil) [self.engine pause];')) {
        reasons.push('原生 pause 不再无条件停引擎（缺 `if (self.engine != nil) [self.engine pause];`）')
      }
      if (pauseBody.includes('self.engine.isRunning) [self.engine pause]')) {
        reasons.push('原生 pause 又把暂停押在 engine.isRunning 前置上（引擎未运行的窗口里整句被跳过，声音继续）')
      }
    }
  }
  // controller.ts：三处 'playing' / 换曲落点都走 applyVolumeOnPlayStart
  const controller = strip('controller')
  if (countOf(controller, 'void applyVolumeOnPlayStart()') < 3) {
    reasons.push("controller.ts 的 'playing' / 换曲落点不足三处走 applyVolumeOnPlayStart："
      + '少哪一处，那条路径上的音量兜底（含渐出期间让行、缺陷④的恢复）就全没了')
  }
  // 【第 49 轮】命令语义在 service.ts 的唯一漏斗里（两条原生通路汇合处）：
  // remoteCommand.ts 只负责把命令转手，锁屏 pause 的落点在漏斗的 pause 分支。
  const remote = strip('remote')
  if (!remote.includes('dispatchRemoteCommand(event.command, event.position)')) {
    reasons.push('remoteCommand.ts 未把遥控命令交给唯一漏斗（锁屏/灵动岛按键的 JS 落点断了）')
  }
  const remoteService = strip('service')
  const funnel = slice(remoteService, 'export const dispatchRemoteCommand = (', '\n}')
  if (funnel == null) {
    reasons.push('service.ts 里找不到第 49 轮的遥控命令漏斗 dispatchRemoteCommand（锁屏 ⏸ 的 JS 落点断了）')
  } else if (!funnel.includes('void pause()')) {
    reasons.push('漏斗的 pause 分支没有走 core/player 的 pause（锁屏 ⏸ 的 JS 落点断了）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 八、原生侧不许静默丢弃用户的按键
// ---------------------------------------------------------------------------
const nativeNoDropInvariants = (src) => {
  const reasons = []
  const code = stripLineComments(src)

  // 暂存区必须是**有上限**的环形缓冲（挂载瞬间连投十几下才是灾难）
  const enqueueAt = code.indexOf('static void LXEnqueuePendingRemoteCommandBody(NSDictionary *body) {')
  if (enqueueAt < 0) {
    reasons.push('找不到 LXEnqueuePendingRemoteCommandBody：监听者不在时遥控命令没有暂存区，'
      + '用户的锁屏/灵动岛按键会被静默丢弃')
  } else {
    const body = code.slice(enqueueAt, enqueueAt + 600)
    if (!body.includes('LXPendingRemoteCommandLimit')) {
      reasons.push('遥控命令暂存区没有上限（补投只对刚发生的那几下有意义，无上限就是挂载瞬间连放十几下）')
    }
    if (!body.includes('removeObjectAtIndex:0')) {
      reasons.push('遥控命令暂存区没有做环形淘汰（超过上限没有丢弃最旧的一条）')
    }
  }

  // 处理器里不许再有「监听者没挂上就 return」：切成暂存
  const handlerStart = code.indexOf('- (void)handleRemoteCommandNotification:(NSNotification *)notification {')
  if (handlerStart < 0) {
    reasons.push('找不到 handleRemoteCommandNotification:')
  } else {
    const end = code.indexOf('\nRCT_EXPORT_METHOD', handlerStart)
    const body = code.slice(handlerStart, end < 0 ? handlerStart + 1200 : end)
    if (body.includes('if (!self.hasListeners) return;')) {
      reasons.push('handleRemoteCommandNotification: 里又出现了「监听者没挂上就 return」：'
        + '用户的每一次按键都不许凭空消失（旧实现正是这样把锁屏/灵动岛的按键吞掉的）')
    }
    if (!body.includes('LXEnqueuePendingRemoteCommandBody(body)')) {
      reasons.push('handleRemoteCommandNotification: 在监听者不在时没有把命令交给暂存区')
    }
  }

  // startObserving 必须把暂存的命令按序补投
  const flushAt = code.indexOf('if (LXPendingRemoteCommandBodies.count == 0) return;')
  if (flushAt < 0) {
    reasons.push('UtilsModule 的 startObserving 没有补投暂存的遥控命令：暂存了不补投等于还是丢')
  } else {
    const before = code.slice(Math.max(0, flushAt - 600), flushAt)
    if (!before.includes('- (void)startObserving {')) {
      reasons.push('遥控命令的补投不在 UtilsModule 的 startObserving 里（挂载时机不对，补投没有意义）')
    }
    const after = code.slice(flushAt, flushAt + 500)
    if (!after.includes('for (NSDictionary *body in pending) {')) {
      reasons.push('补投没有遍历暂存的命令（只取了快照没有发出去）')
    }
    if (!after.includes('[self sendEventWithName:@"remote-command" body:body];')) {
      reasons.push('补投没有真的把 remote-command 事件发出去')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检：逐条把本轮修好的形状改回旧实现（或改坏），断言必然红
// ---------------------------------------------------------------------------
const tamper = (src, from, to) => {
  if (!src.includes(from)) throw new Error('反例锚点未命中: ' + from.slice(0, 70))
  return src.replace(from, to)
}

const runCounterExamples = () => {
  const results = []
  const check = (name, reasons, expectKeyword) => {
    const hit = reasons.some((r) => r.includes(expectKeyword))
    results.push({ name, ok: hit, detail: hit ? '已拦下' : '未拦下（缺失期望理由：' + expectKeyword + '）' })
  }

  const fade = REAL.fade
  const deps = {
    utils: REAL.utils, core: REAL.core, service: REAL.service,
  }
  const chainDeps = {
    player: REAL.player, utils: REAL.utils, controller: REAL.controller, remote: REAL.remote,
    // 【第 47 轮】整条链的落点延伸到原生 pause（暂停必须无条件落到引擎）
    appDelegate: REAL.appDelegate,
    // 【第 49 轮】命令语义移到 service.ts 的唯一漏斗，链上多这一环
    service: REAL.service,
  }
  // 【第 51 轮】起播 / 换歌渐入链的两个上游文件
  const startDeps = { resourceLoader: REAL.resourceLoader, nativeFlac: REAL.nativeFlac }

  // v1 斜坡的取消又不放行 Promise（第 39 轮那颗雷原样回归）
  check('v1 斜坡取消不放行 Promise', rampCancelInvariants(
    tamper(fade, '  if (resolve != null) resolve()', '  void resolve'),
  ), '缺陷①')

  // v2 clearInterval 又出现第二处（= 又造了一条不放行的取消路径）
  check('v2 别处再掐一次斜坡 interval', rampCancelInvariants(
    tamper(fade, 'const armVolumeFadeIn = () => {', 'const armVolumeFadeIn = () => {\n  if (fadeTimer) clearInterval(fadeTimer)'),
  ), '不止一处')

  // v3 渐出起点改回设定音量（爆音来源）—— 「起点取当前实际音量」这条判在账本组里
  check('v3 渐出起点改回设定音量', volumeLedgerInvariants(
    tamper(fade, 'const from = currentVolume', 'const from = targetVolume()'), deps,
  ), '缺陷②')

  // v4 拆掉有界等待，直接 await 斜坡再暂停（缺陷①的原始形状）
  check('v4 拆掉有界等待直接 await 斜坡', pauseNeverBlockedInvariants(
    tamper(fade,
      'await settleWithin(rampVolume(0, FADE_OUT_MS), FADE_OUT_MS + FADE_STEP_MS * 2)',
      'await rampVolume(0, FADE_OUT_MS)'),
  ), '有界等待')

  // v5 渐出途中一让了之（用户的 ▶ 被自己的渐出吞掉 —— 旧形状原样回归）
  check('v5 渐出途中一让了之', fadeInGuardInvariants(
    tamper(fade, '  if (fadingOut) {\n    // 【第 51 轮】渐出途中收到播放意图',
      '  if (false) {\n    // 【第 51 轮】渐出途中收到播放意图'),
  ), '没有处理「渐出途中又按播放」')

  // v6 'playing' 又把在途渐入掐掉直写目标（咔哒噪声）
  check("v6 重复 'playing' 打断在途斜坡", fadeInGuardInvariants(
    tamper(fade, "    if (Platform.OS == 'ios' && fadeTimer != null) return\n", ''),
  ), '渐入进行中的重复')

  // v7 删掉渐入的兜底期限（预约后没等到 'playing' 就永久静音）
  check('v7 删掉渐入兜底期限', fadeInGuardInvariants(
    tamper(fade, '  }, timeoutMs)', '  }, 0)'),
  ), '兜底定时器')

  // v8 账本不记录（斜坡起点永远是错的）
  check('v8 writeVolume 不记账本', volumeLedgerInvariants(
    tamper(fade, '  currentVolume = clamp01(volume)\n', ''), deps,
  ), '账本')

  // v9 外部直写不同步账本（音量条改完音量，下一次渐出的第一拍就是跳变）
  check('v9 setVolume 不同步账本', volumeLedgerInvariants(REAL.fade, {
    ...deps,
    utils: tamper(REAL.utils, '  syncVolumeFadeState(num)\n', ''),
  }), 'setVolume')

  // v9b 换曲重贴音量（applyCurrentVolume）不同步账本
  check('v9b applyCurrentVolume 不同步账本', volumeLedgerInvariants(REAL.fade, {
    ...deps,
    core: tamper(REAL.core, "  syncVolumeFadeState(settingState.setting['player.volume'])\n", ''),
  }), 'applyCurrentVolume')

  // v10 锁屏暂停绕开收口（setPause 不走 fadeOutThenPause）
  check('v10 setPause 绕开 fadeOutThenPause', chainInvariants({
    ...chainDeps,
    utils: tamper(REAL.utils, '  await fadeOutThenPause(pausePlayingEngines)', '  await pausePlayingEngines()'),
  }), 'fadeOutThenPause')

  // v11 原生侧回到「监听者没挂上就 return」（用户的按键被静默丢弃）
  check('v11 原生又静默丢弃按键', nativeNoDropInvariants(
    tamper(REAL.appDelegate,
      '  if (!self.hasListeners) {\n    LXEnqueuePendingRemoteCommandBody(body);\n    return;\n  }',
      '  if (!self.hasListeners) return;'),
  ), '不许凭空消失')

  // v12 startObserving 不再补投（暂存了也白暂存）
  check('v12 暂存但不补投', nativeNoDropInvariants(
    tamper(REAL.appDelegate,
      '  for (NSDictionary *body in pending) {\n    [self sendEventWithName:@"remote-command" body:body];\n  }',
      '  for (NSDictionary *body in pending) {\n    (void)body;\n  }'),
  ), '没有真的把 remote-command')

  // 【第 47 轮】v13 双引擎收口退化成「只停当前驱动」（跨引擎切换的中间态漏掉出声的那台）
  check('v13 暂停只发当前驱动', chainInvariants({
    ...chainDeps,
    utils: tamper(REAL.utils,
      '    if (rntpMayHoldTrack()) await TrackPlayer.pause().catch(() => {})\n', ''),
  }), 'rntpMayHoldTrack')

  // 【第 47 轮】v14 拆掉暂停后复核（引擎没停 / 事件丢了也没人补刀）
  check('v14 拆掉暂停复核', chainInvariants({
    ...chainDeps,
    utils: tamper(REAL.utils,
      '  setTimeout(() => {\n    if (token != pauseVerifyToken) return\n    if (!playerState.isPlay) return\n'
      + '    void pausePlayingEngines()\n  }, PAUSE_VERIFY_MS)\n', ''),
  }), '有界复核')

  // 【第 47 轮】v15 用户的播放意图不再作废复核（复核跟用户抢：刚按下的播放被按停）
  check('v15 播放不作废复核', chainInvariants({
    ...chainDeps,
    utils: tamper(REAL.utils,
      '  pauseVerifyToken++\n  // 【第 39 轮第 4 条】预约', '  // 【第 39 轮第 4 条】预约'),
  }), '作废在途的暂停复核')

  // 【第 47 轮】v16 原生 pause 退回 isRunning 前置（引擎未运行的窗口整句被跳过，声音继续）
  check('v16 原生暂停押在 isRunning 上', chainInvariants({
    ...chainDeps,
    appDelegate: tamper(REAL.appDelegate,
      '    if (self.engine != nil) [self.engine pause];',
      '    if (self.engine != nil && self.engine.isRunning) [self.engine pause];'),
  }), 'isRunning 前置')

  // 【第 47 轮】v17 「RNTP 可能持有」的判据被收窄成「只认上一次驱动是 RNTP」
  // （空 id 的窗口 —— reset / ended 之后、起播事件还没到 —— 漏发暂停，残留引擎继续出声）
  check('v17 判据收窄漏掉空 id 窗口', chainInvariants({
    ...chainDeps,
    utils: tamper(REAL.utils,
      '  return !id || !id.startsWith(\'nativeflac://\')',
      '  return !!id && !id.startsWith(\'nativeflac://\')'),
  }), '空 id')

  // 【第 51 轮】v18 渐入时长改回 220ms（只够消爆音，听不出「渐入」）
  check('v18 渐入时长改回 220ms', fadeShapeInvariants(
    tamper(fade, 'const FADE_IN_MS = 600', 'const FADE_IN_MS = 220'),
  ), '渐入时长太短')

  // 【第 51 轮】v19 渐出时长改回 160ms（听不出「渐出」）
  check('v19 渐出时长改回 160ms', fadeShapeInvariants(
    tamper(fade, 'const FADE_OUT_MS = 300', 'const FADE_OUT_MS = 160'),
  ), '渐出时长太短')

  // 【第 51 轮】v20 斜坡退回线性（smoothstep 被拿掉）
  check('v20 斜坡退回线性', fadeShapeInvariants(
    tamper(fade, 'from + (target - from) * easeVolume(step / steps)',
      'from + (target - from) * (step / steps)'),
  ), '感知曲线')

  // 【第 51 轮】v21 起播不再预约渐入（点歌 / 换歌又是满音量砸出来）
  check('v21 起播不预约渐入', startFadeChainInvariants({
    ...startDeps,
    resourceLoader: tamper(REAL.resourceLoader,
      'const startFadeArmed = shouldAutoStart && armVolumeStartFadeIn()', 'const startFadeArmed = false'),
  }), '没有都预约起播渐入')

  // 【第 51 轮】v22 起播不把起始增益传 0（预约被 openStreamingFlac 顶掉）
  check('v22 起播不传起始增益 0', startFadeChainInvariants({
    ...startDeps,
    resourceLoader: tamper(REAL.resourceLoader, 'startFadeArmed ? 0 : undefined', 'undefined'),
  }), '起始增益')

  // 【第 51 轮】v23 起播重贴音量不让行（预约好的渐入当场作废）
  check('v23 起播重贴音量不让行', volumeLedgerInvariants(REAL.fade, {
    ...deps,
    core: tamper(REAL.core, "  if (Platform.OS == 'ios' && isVolumeFadeActive()) return\n", ''),
  }), '没有给在途的渐入让行')

  // 【第 51 轮】v24 打断恢复的 duck 回填不让行（预约压到 0 之后又写回设定音量）
  check('v24 打断恢复不留让行', volumeLedgerInvariants(REAL.fade, {
    ...deps,
    service: tamper(REAL.service, '    if (isVolumeFadeActive()) return\n', ''),
  }), '没有给在途的渐入让行')

  // 【第 51 轮】v25 渐出途中分支不作废真暂停（用户的 ▶ 被吞）
  check('v25 渐出途中不作废真暂停', fadeInGuardInvariants(
    tamper(fade, '    pauseSeq++\n', ''),
  ), '没有作废在途的真暂停')

  // 【第 51 轮】v26 渐出途中分支不把斜坡拉回去（掉头没了，音量停在半路）
  check('v26 渐出途中不拉回音量', fadeInGuardInvariants(
    tamper(fade, '    void rampVolume(targetVolume(), FADE_IN_MS)\n', ''),
  ), '没有把音量斜坡拉回设定值')

  // 【第 51 轮】v27 预约只压一台引擎（另一台带着旧音量起播）
  check('v27 预约只压一台引擎', fadeInGuardInvariants(
    tamper(fade, "  if (Platform.OS == 'ios' && isNativeFlacActive()) void TrackPlayer.setVolume(0).catch(() => {})\n", ''),
  ), '另一台')

  // 【第 51 轮】v28 起播预约沿用恢复播放的 1.5s 期限（出声前就到期 = 白预约）
  check('v28 起播沿用恢复播放的期限', fadeInGuardInvariants(
    tamper(fade, 'return armFadeIn(START_ARM_TIMEOUT_MS)', 'return armFadeIn(ARM_TIMEOUT_MS)'),
  ), '没有走统一的预约体，或没用自己的兜底期限')

  // 【第 51 轮】v29 起播预约不再挂在 shouldAutoStart 上（恢复曲「起播但保持暂停」也被压 0）
  check('v29 起播预约不再看 shouldAutoStart', startFadeChainInvariants({
    ...startDeps,
    resourceLoader: tamper(REAL.resourceLoader,
      'const startFadeArmed = shouldAutoStart && armVolumeStartFadeIn()',
      'const startFadeArmed = armVolumeStartFadeIn()'),
  }), '没有挂在 shouldAutoStart 上')

  // 【第 51 轮】v30 引擎起始增益没接上（预约到不了原生引擎）
  check('v30 引擎没接 startVolume', startFadeChainInvariants({
    ...startDeps,
    nativeFlac: tamper(REAL.nativeFlac,
      "startVolume ?? settingState.setting['player.volume']", "settingState.setting['player.volume']"),
  }), '没有把 startVolume 交给引擎')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-remote-command-volume-fade ===')
console.log('锁屏 / 灵动岛按键不许被音量斜坡吞掉：斜坡取消必放行 + 暂停无条件执行 + 渐出期间让行'
  + ' + 重复 playing 不打断 + 渐入有兜底期限 + 音量账本同步（第 41 轮）')
console.log('播放 / 暂停的渐入渐出要真的听得见：斜坡够长 + smoothstep 曲线 + 起播也渐入'
  + '（含引擎起始增益）+ 在途渐入不被外部直写顶掉 + 渐出途中用户按 ▶ 赢（第 51 轮）')
console.log()

const checks = [
  ['斜坡取消必须放行 Promise（clearInterval 唯一出口，取消/完成共用 stopRamp）', () => rampCancelInvariants(REAL.fade)],
  ['锁屏暂停绝不依赖斜坡（有界等待 + 无条件执行真暂停 + 起点取当前实际音量）', () => pauseNeverBlockedInvariants(REAL.fade)],
  ['渐入预约统一体（恢复 / 起播两个入口）：渐出途中让位于用户的 ▶ + 预约有兜底期限'
    + ' + 预约时两台引擎一起压 0', () => fadeInGuardInvariants(REAL.fade)],
  ['音量账本：斜坡起点取 currentVolume，三处外部直写都同步（音量条 / 换曲重贴 / 打断恢复）'
    + '且在途渐入期间一律让行', () => volumeLedgerInvariants(REAL.fade, { utils: REAL.utils, core: REAL.core, service: REAL.service })],
  ['第 51 轮·斜坡时长与感知曲线（渐入 600ms / 渐出 300ms + smoothstep，档距 20ms）',
    () => fadeShapeInvariants(REAL.fade)],
  ['第 51 轮·起播 / 换歌的渐入链（resourceLoader 两条落点 + 引擎起始增益 startVolume）',
    () => startFadeChainInvariants({ resourceLoader: REAL.resourceLoader, nativeFlac: REAL.nativeFlac })],
  ['整条链不许断：锁屏 ⏸/▶ → player → utils → 渐入渐出（controller 三处落点）',
    () => chainInvariants({
      player: REAL.player, utils: REAL.utils, controller: REAL.controller, remote: REAL.remote,
      appDelegate: REAL.appDelegate,
      // 【第 49 轮】命令语义移至 service.ts 的漏斗
      service: REAL.service,
    })],
  ['原生不许静默丢弃按键：暂存（有上限）+ startObserving 按序补投',
    () => nativeNoDropInvariants(REAL.appDelegate)],
]

let invOk = true
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    console.log(`\n[${name}]\n  PASS`)
  } else {
    invOk = false
    console.log(`\n[${name}]`)
    ;[...new Set(reasons)].forEach((r) => console.log('  FAIL ' + r))
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
console.log()
console.log(`结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length - (invOk ? 0 : 1)}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
