import { Platform } from 'react-native'
import TrackPlayer from 'react-native-track-player'
import { isNativeFlacActive, setNativeFlacVolume } from './nativeFlac'
import settingState from '@/store/setting/state'

/**
 * 【第 39 轮第 4 条 + 第 41 轮重大 bug 修复 + 第 51 轮需求落地】播放 / 暂停的声音渐入渐出。
 *
 * 用户原话（第 39 轮）：「播放和暂停音乐时，播放的音乐会出现嘶哑卡顿和噪声，优化播放和
 * 暂停时声音渐入渐出的功能效果」。
 *
 * 现象的病根是两个「硬切换」：
 *   ① 播放（恢复）时，音量从 0 直接跳到用户设定值，同时音频会话被重新激活 —— iOS 上
 *      功放端的幅度突变就是那一声「啪 / 嘶」；缓冲刚回填时还叠一次解码器预热的毛刺；
 *   ② 暂停时，正在出声的音频流被瞬间掐断（AVPlayer pause / 原生流式引擎 pause），
 *      波形在非零点被截断 —— 听感即「嘶哑卡顿和噪声」。
 * 修法是在这两种硬切换中间插一段**音量斜坡**，把幅度突变摊平：播放先压到 0、真正开始
 * 出声后再升上来（渐入）；暂停先降下去、降到 0 再真暂停（渐出）。
 *
 * ---------------------------------------------------------------------------
 * 【第 41 轮】用户复报：「锁屏界面和灵动岛界面的上一首、下一首、播放/暂停按钮点击后还是
 * 无法控制，特别是播放一段时间后，上面的按钮就不管作用了，而且音乐也会出现嘶哑卡顿和噪声」。
 * 逐条对到上面这段斜坡实现，第 39 轮那个版本自己就是元凶（四条已证缺陷）：
 *
 *  ① 【暂停被斜坡吞掉 —— 锁屏/灵动岛的 ⏸ 按了没反应】
 *     旧 `rampVolume` 第一句就是 `stopFadeTimer()`：新斜坡把旧斜坡的 interval 掐掉时，
 *     旧斜坡那个 `resolve()` 永远不会执行 —— 它的 Promise 永久悬挂。
 *     而 `fadeOutThenPause` 的写法是：
 *         await rampVolume(targetVolume(), 0, FADE_OUT_MS)   // ← 挂在这
 *         await Promise.resolve(pause())                      // ← 永远到不了
 *     只要渐出途中来一次 `applyVolumeOnPlayStart()`（'playing' 事件）或 `armVolumeFadeIn()`
 *     （setPlay），真暂停就再也不执行了 —— 用户点 ⏸，界面闪一下、歌照放。
 *     而原生流式引擎**每次缓冲耗尽重填都会重新跨门槛发一次 'playing'**
 *     （scheduleBufferingStateForGeneration → maybeStartPlaybackLocked，10 秒门槛），
 *     播得越久重缓冲越频繁，撞上这个窗口的概率越大 —— 正是用户说的「特别是播放一段时间后」。
 *     同一颗雷还让锁屏的 ⏯ 状态错乱：JS 侧发过 pause 但引擎没停 → 系统以为在播 →
 *     锁屏那个按钮显示成 ⏸ → 用户再点，还是同一个死窗口。症状就是「按钮不管作用了」。
 *
 *  ② 【渐出起点用「设定音量」而不是「当前实际音量」—— 那一声爆音】
 *     旧 `fadeOutThenPause` 从 `targetVolume()` 起步。若此刻音量其实在低处（渐入进行中、
 *     或上一次斜坡被打断停在半途），第一拍就把增益从低值**跳到接近满音量**再往下降 ——
 *     用户听见的「嘶哑卡顿和噪声」就是这么来的。现在所有斜坡都从 `currentVolume`
 *     （本模块记录的上一次真正写出的值）起步，斜坡全程单调。
 *
 *  ③ 【每个 'playing' 事件都掐斜坡 + 直写目标 —— 咔哒/zipper 噪声】
 *     旧 `applyVolumeOnPlayStart` 的未预约分支 `stopFadeTimer(); await writeVolume(target)`：
 *     渐入还在跑的时候又来一个 'playing'，音量被**瞬间**顶到目标值 = 一次阶跃。
 *
 *  ④ 【预约了渐入却没有兜底 —— 永久静音】
 *     旧 `armVolumeFadeIn` 无条件写 0 并置标记，全靠后续 'playing' 事件恢复。该事件不来
 *     （换歌路径没跨门槛、引擎重启、事件丢了）音量就**永久停在 0**：界面显示在播、一点声没有，
 *     用户按什么键都「不管作用」。现在有预约期限（ARM_TIMEOUT_MS），到点无条件恢复设定音量。
 *
 * 第 41 轮的修法（每条都对应一个能拦住回退的契约断言，见 scripts/sim-remote-command-volume-fade.js）：
 *   · 斜坡的取消路径**必须放行**它的 Promise（fadeResolve 统一出口，取消/完成都 resolve）——
 *     杜绝任何形式的永久悬挂；
 *   · 渐出期间置 `fadingOut`：`applyVolumeOnPlayStart` 一律让行，不许把在途的渐出掐掉
 *     或把音量顶回去；
 *   · 暂停动作改成「有界等待 + 无条件执行」：斜坡只为让「停」这件事柔和，绝不允许拦住它 ——
 *     斜坡即使被打断/卡死，到点（FADE_OUT_MS + 两拍余量）也照常执行真暂停；
 *   · 斜坡起点一律取当前实际音量；渐入进行中收到重复 'playing' 直接忽略，不写音量；
 *   · 外部直接写音量（音量条 / 回前台重贴）时用 `syncVolumeFadeState` 同步账本，
 *     防止账本与实际值脱节后下一次斜坡又产生跳变。
 *
 * ---------------------------------------------------------------------------
 * 【第 51 轮】用户原话：「还有一个需求，播放和暂停时增加渐入渐出的效果」。
 *
 * 第 39/41 轮的斜坡**本来就在**（上面两段就是它的现场），用户仍然把这个当成「还没做的
 * 需求」提出来，对着代码逐个调用点核对后，结论是那份实现听得见的只有「半个」：
 *
 *  ① 【时长太短，只够消爆音，不够成「效果」】旧值 渐入 220ms / 渐出 160ms（每档 20ms =
 *     11 档 / 8 档）—— 这是「防爆音」的量级，人耳基本只能察觉到「没有咔哒声」，听不出
 *     渐入渐出。本轮加长到 渐入 600ms / 渐出 300ms，并改用 **smoothstep 感知曲线**
 *     （`p²(3-2p)`：头尾平缓、中段快，线性斜坡那种「一上来就掉一半」的突兀感消失）。
 *     渐出不再更长是刻意的：暂停的**界面反馈**（锁屏进度条停住、按钮变 ▶）跟在真暂停
 *     之后，渐出拖太长会让「按了暂停」显得发闷。
 *
 *  ② 【**起播没有渐入** —— 用户听到的最响的一次硬切换】
 *     旧实现只在 `utils.setPlay()`（播放/恢复键）里预约渐入。换歌 / 点歌走的是
 *     `engine/resourceLoader.ts` → `startNativeFlacPlayback` / `loadTrackPlayerResource`，
 *     一个都没预约 —— 新歌**满音量**直接砸出来。本轮在 resourceLoader 的两条起播落点上
 *     预约（`armVolumeStartFadeIn`），并且：
 *       · 原生流式路径把**起始音量**一起传 0（`openStreamingFlac` 的 volume 参数，
 *         不传的话原生给引擎定的初始增益就是设定值，预约当场被覆盖）；
 *       · AVPlayer 路径的 `applyCurrentVolume()`（起播后重贴音量）**让行**——
 *         见 isVolumeFadeActive() 与 trackPlayerCore 里的守卫，否则它会把音量一步顶回
 *         设定值，渐入同样白预约；
 *       · 起播要等网络 / 缓冲，'playing' 比恢复播放晚得多，预约期限放宽到
 *         START_ARM_TIMEOUT_MS（恢复播放仍是 ARM_TIMEOUT_MS）。
 *
 *  ③ 【渐出途中按播放会被自己的暂停吞掉】旧 `armVolumeFadeIn` 在 `fadingOut` 期间直接
 *     return（对斜坡「让行」）。可它同时也把**用户的播放意图**扔了：渐出跑完，真暂停照常
 *     落地 —— 用户按 ▶ 得到的是「停住不动」。渐出窗口原本只有 160ms、撞上算手快，本轮
 *     加长到 300ms 后这个窗口就不可忽略了。现在：渐出途中收到播放意图 ⇒ `pauseSeq++`
 *     作废那条在途真暂停 + 当场把音量斜坡拉回设定值（从当前值起，不是跳变）。
 *     「暂停无条件执行」这条死规矩只对**用户自己后来按下播放**这一种情况让位。
 *
 *  ④ 【预约期间两台引擎都要压到 0】预约发生在「上一首的引擎还没拆、下一首的引擎还没起」
 *     的窗口里，只压当前激活的那台，另一台会带着旧音量起播 —— 渐入的第一拍之前先来一声
 *     满音量。`silenceBothEngines()` 一起压。
 *
 * 与现有调用点的关系（本文件不引用 plugins/player/utils.ts，避免循环依赖；
 * 因此这里的 writeVolume 自己按同一口径分发两个引擎）：
 *   · natives/流式引擎 → setNativeFlacVolume（非激活态自动 no-op，与 utils.setVolume 一致）；
 *   · AVPlayer(RNTP) → TrackPlayer.setVolume。
 *   · 真正让声音变轻的只有这两条 —— 都是播放器自身的音量，不动系统音量。
 *
 * 「渐入」用一个预约标记（fadeInArmed）串起来：
 *   setPlay（utils.ts）→ armVolumeFadeIn()：此刻是暂停态，把音量压到 0 听不见；
 *   播放真正开始 → controller.ts 的 'playing' 分支 → applyVolumeOnPlayStart()：
 *   标记在就斜坡 0 → 用户设定音量，标记不在就照旧直接写目标音量（原行为）。
 *   这样即便某条恢复路径没走 setPlay（系统打断结束后的自动续播等），'playing' 里的兜底
 *   也会把音量恢复成用户设定值 —— 绝不会出现「恢复播放却没声音」。
 *
 * 只在 iOS 生效：Android 侧的播放器封装没有 controller.ts 里的 'playing' 兜底，
 * 「暂停后音量停在 0、被别的路径恢复播放」会变成没声音，所以那里按老口径直通（不淡）。
 */

/** 渐入时长：从 0 升到用户设定音量的总时长（毫秒）【第 51 轮】220 → 600（要听得出来） */
const FADE_IN_MS = 600
/**
 * 渐出时长：从当前音量降到 0 的总时长（毫秒）；暂停跟着它延后这么多。
 * 【第 51 轮】160 → 300。刻意不再长：真暂停跟在斜坡之后，锁屏进度条停住 / 按钮变 ▶
 * 都在那之后，渐出拖太长会让「按了暂停」显得发闷。
 */
const FADE_OUT_MS = 300
/** 每档之间的间隔（毫秒）：20ms 一档 ≈ 30 档渐入 / 15 档渐出，人耳已是连续变化 */
const FADE_STEP_MS = 20
/**
 * 渐入预约的兜底期限（毫秒）【第 41 轮缺陷④】：预约后这么久还没等到 'playing'
 * （引擎没跨门槛 / 事件丢了 / 该路径没走 controller），无条件把音量恢复成用户设定值 ——
 * 宁可少一次渐入，也绝不留「在播但一点声没有」。用于**恢复播放**（引擎已就绪，很快出声）。
 */
const ARM_TIMEOUT_MS = 1_500
/**
 * 起播预约的兜底期限（毫秒）【第 51 轮】：换歌 / 点歌要先拿链接、再等缓冲，'playing'
 * 比恢复播放晚得多（几秒是常态）。用 1.5s 那个期限会让预约在出声前就到期 —— 起播渐入
 * 十次有八次白预约。放宽到 6s（同样是**只晚不丢**：到点无条件恢复设定音量）。
 */
const START_ARM_TIMEOUT_MS = 6_000
/** 两次音量写入之间的最小可感知差：差得比它小就直接写终点，不白跑一趟斜坡 */
const MIN_RAMP_DELTA = 0.01

let fadeTimer: ReturnType<typeof setInterval> | null = null
/** 在途斜坡的放行句柄【第 41 轮缺陷①】：斜坡被取消 / 完成都从这一处 resolve，绝不留悬挂 */
let fadeResolve: (() => void) | null = null
/** 渐入预约的兜底定时器【缺陷④】 */
let armTimer: ReturnType<typeof setTimeout> | null = null
/** 是否已被 setPlay / 起播预约了「下一次播放开始时渐入」 */
let fadeInArmed = false
/** 渐出进行中【缺陷②③】：期间不许任何「渐入 / 直写」把音量顶回去或掐掉在途斜坡 */
let fadingOut = false
/**
 * 暂停意图的序号【第 51 轮】。`fadeOutThenPause` 进门领一个号，跑完斜坡准备执行真暂停时
 * 再看一眼：号变了（用户中途按了播放，`armFadeIn` 会 ++）就说明这条暂停**已被更新的意图
 * 取代**，不许落地。「暂停无条件执行」这条死规矩只对这一种情况让位 —— 用户自己按的 ▶。
 */
let pauseSeq = 0
/**
 * 本模块最近一次真正写出的音量【缺陷②】：所有斜坡都从它起步。
 * 只有两条路会写它：本模块的 writeVolume，以及外部直写后的 syncVolumeFadeState。
 */
let currentVolume = 1

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1)

/** 用户设定音量（0~1）：脏值（非数字 / NaN）一律当满音量，绝不让 0 以外的意外值静音 */
const targetVolume = () => {
  const volume = settingState.setting['player.volume']
  if (typeof volume != 'number' || !Number.isFinite(volume)) return 1
  return clamp01(volume)
}

/**
 * 感知曲线（smoothstep）【第 51 轮】：线性斜坡的听感是「一上来就掉一半、尾巴拖得长」，
 * 200ms 级的消爆音够用，600ms 级的渐入渐出就发假。smoothstep 两头慢、中间快，
 * 同样的起止点听上去才像「淡入 / 淡出」。**单调不减**（p ∈ [0,1] 上导数 ≥ 0），
 * 第 41 轮定死的「斜坡全程单调」不变。
 */
const easeVolume = (progress: number) => progress * progress * (3 - 2 * progress)

/** 与 plugins/player/utils.ts 的 setVolume 同口径的两个引擎分发（此处不 import 以免成环） */
const writeVolume = (volume: number): Promise<unknown> => {
  currentVolume = clamp01(volume)
  if (Platform.OS == 'ios' && isNativeFlacActive()) {
    return setNativeFlacVolume(currentVolume).catch(() => {})
  }
  return TrackPlayer.setVolume(currentVolume).catch(() => {})
}

/**
 * 把**两台引擎**一起压到 0【第 51 轮】。预约（setPlay / 起播）发生在「上一首的引擎还没拆、
 * 下一首的引擎还没起」的窗口里，`writeVolume` 只会写当前激活的那一台；另一台若带着旧音量
 * 起播，渐入的第一拍之前就先有一声满音量。幂等、各自吞错：空闲那台写 0 不做声（RNTP 未
 * setup 时 promise 直接 reject，也被吞掉）。
 */
const silenceBothEngines = () => {
  void writeVolume(0)
  if (Platform.OS == 'ios' && isNativeFlacActive()) void TrackPlayer.setVolume(0).catch(() => {})
}

/**
 * 掐掉在途斜坡。**被掐掉的那个 Promise 必须放行**（第 41 轮缺陷①）：
 * 只清 interval 不 resolve 会让 await 它的调用方（fadeOutThenPause）永久停在这一行，
 * 后面的「真暂停」就永远不执行 —— 锁屏/灵动岛 ⏸ 点了没反应就是这么来的。
 * 取消与正常跑完共用这一个出口。
 */
const stopRamp = () => {
  if (fadeTimer != null) {
    clearInterval(fadeTimer)
    fadeTimer = null
  }
  const resolve = fadeResolve
  fadeResolve = null
  if (resolve != null) resolve()
}

const clearArmTimer = () => {
  if (armTimer != null) {
    clearTimeout(armTimer)
    armTimer = null
  }
}

/** 给斜坡上保险：斜坡本身就该跑完，这只是「即便它出意外也不拦暂停」的第二道闸 */
const settleWithin = (promise: Promise<void>, ms: number): Promise<void> => {
  return new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      if (settled) return
      settled = true
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
      resolve()
    }
    timer = setTimeout(finish, ms)
    void promise.then(finish, finish)
  })
}

/**
 * 音量斜坡：从**当前实际音量**（currentVolume）走到 to【缺陷②】，按 smoothstep 感知曲线
 * 【第 51 轮】摊开。完成或被 stopRamp 掐掉都会 resolve【缺陷①】；起点与终点几乎相同就不
 * 白跑一趟。
 */
const rampVolume = (to: number, durationMs: number): Promise<void> => {
  stopRamp()
  const from = currentVolume
  const target = clamp01(to)
  if (Math.abs(target - from) < MIN_RAMP_DELTA) {
    void writeVolume(target)
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const steps = Math.max(1, Math.round(durationMs / FADE_STEP_MS))
    let step = 0
    fadeResolve = resolve
    fadeTimer = setInterval(() => {
      step++
      void writeVolume(from + (target - from) * easeVolume(step / steps))
      if (step >= steps) stopRamp()
    }, FADE_STEP_MS)
  })
}

/**
 * 预约「下一次播放开始时渐入」的公共体：置标记 + 上兜底期限。
 * 到点还没被 'playing' 消费（`applyVolumeOnPlayStart`）就无条件恢复设定音量【缺陷④】。
 */
const beginFadeInArm = (timeoutMs: number) => {
  fadeInArmed = true
  clearArmTimer()
  armTimer = setTimeout(() => {
    armTimer = null
    if (!fadeInArmed) return
    fadeInArmed = false
    void writeVolume(targetVolume())
  }, timeoutMs)
}

/**
 * 预约渐入（内部）。两种时机：
 *   · 停在暂停态（播放 / 恢复键、起播前的准备）：把音量压到 0 不会有任何声音变化；
 *   · 渐出途中用户又按了播放【第 51 轮】：作废在途的真暂停，当场把音量拉回设定值。
 * @returns 是否已建立预约（起播路径据此把引擎的**起始音量**也传 0）
 */
const armFadeIn = (timeoutMs: number): boolean => {
  if (Platform.OS != 'ios') return false
  if (fadingOut) {
    // 【第 51 轮】渐出途中收到播放意图：**用户的最后一次按键赢**。
    // `pauseSeq++` 让在途那条 fadeOutThenPause 在斜坡结束后跳过真暂停；
    // 斜坡就地掉头（从当前值平滑升回设定值，不是跳变）—— 用户听到的是「刚按暂停又按
    // 播放，声音回落一半又被拉回来」，而不是「按了播放它却停住」。第 41 轮定下的
    // 「渐出期间让行」只对**自动**的 'playing' / 音量直写生效（见 applyVolumeOnPlayStart），
    // 用户的显式播放意图不在让行之列。
    pauseSeq++
    beginFadeInArm(timeoutMs)
    void rampVolume(targetVolume(), FADE_IN_MS)
    return true
  }
  beginFadeInArm(timeoutMs)
  stopRamp()
  silenceBothEngines()
  return true
}

/**
 * 「下一次播放开始时渐入」预约 + 立刻把两台引擎的音量都压到 0。
 * 调用时机：setPlay（播放 / 恢复）—— 此刻处于暂停态，写 0 不会有任何声音变化。
 * 只在 iOS 生效（见文件头说明）。
 *
 * 【第 41 轮】预约必须带兜底期限【缺陷④】：到点还没等到 'playing' 就无条件恢复设定音量。
 * 【第 51 轮】渐出途中不再「一让了之」—— 见 armFadeIn 的 fadingOut 分支。
 */
export const armVolumeFadeIn = () => {
  armFadeIn(ARM_TIMEOUT_MS)
}

/**
 * 起播（换歌 / 点歌 / 下一首 / 上一首）前的渐入预约【第 51 轮】。
 * 与 armVolumeFadeIn 同一条路，只有兜底期限不同：起播要等拿链接 + 缓冲，'playing' 来得晚。
 * 调用点：engine/resourceLoader.ts 两条起播落点（nativeFlac / AVPlayer），且只在
 * shouldAutoStart 时调用（恢复曲起播位置而保持暂停的那种不预约，否则会白白压 0 六秒）。
 * @returns 是否已建立预约 —— true 时调用方要把引擎的**起始音量**一起传 0
 */
export const armVolumeStartFadeIn = () => {
  return armFadeIn(START_ARM_TIMEOUT_MS)
}

/**
 * 播放真正开始（controller.ts 的 'playing' 分支 / 换曲分支）时调用：
 *   · 有渐入预约 → 从当前音量斜坡升到用户设定音量（渐入）；
 *   · 没有 → 直接写用户设定音量（与改动前完全一致的那句 setVolume）。
 *
 * 【第 41 轮】把两件事钉死：
 *   · 渐出进行中不做任何音量写入 —— 'playing' 事件不许把暂停中的音量顶回去（缺陷①）；
 *   · 渐入斜坡在跑时，重复到达的 'playing' 直接忽略【缺陷③】——
 *     旧实现每次都掐斜坡再直写目标，那一记阶跃就是用户听的「咔哒 / 噪声」。
 * 【第 51 轮】用户的播放意图若在渐出途中到达（armFadeIn 的 fadingOut 分支），那里已经把
 * 预约置回来了：'playing' 走的就是上面的「有预约」分支，接上那条掉头的斜坡。
 */
export const applyVolumeOnPlayStart = async() => {
  const target = targetVolume()
  if (Platform.OS != 'ios' || !fadeInArmed) {
    if (Platform.OS == 'ios' && fadingOut) return
    if (Platform.OS == 'ios' && fadeTimer != null) return
    await writeVolume(target)
    return
  }
  fadeInArmed = false
  clearArmTimer()
  await rampVolume(target, FADE_IN_MS)
}

/**
 * 渐出后再暂停：先斜坡降到 0（FADE_OUT_MS），然后执行真正的暂停动作。
 * @param pause 真正的暂停动作（传函数而不是已调用的 Promise —— 斜坡跑完才允许它执行）
 *
 * 【第 41 轮】这里是「锁屏 / 灵动岛按钮点了没反应」的正凶现场，改法三条：
 *   · 起点取**当前实际音量**（斜坡自己读 currentVolume）【缺陷②】—— 旧实现从设定音量起步，
 *     在低音量处会先跳高再降，就是那声爆音；
 *   · fadingOut 期间 `applyVolumeOnPlayStart` 全让行 —— 在途渐出不会被 'playing' 掐掉；
 *   · 斜坡只负责「柔和」，**暂停动作无条件执行**：斜坡被掐 / 卡死也在有限时间内放行，
 *     正常跑完则立刻放行【缺陷①的后半】—— 用户按下 ⏸ 就一定要停，这是第 41 轮的死规矩。
 *
 * 【第 51 轮】唯一的例外是**用户自己又按了播放**：`pauseSeq` 进门领号，放行后先对号，
 * 号变了（armFadeIn 的掉头分支 ++）就跳过真暂停 —— 死规矩让位于更新的用户意图。
 * 自动路径（'playing' 事件、音量直写）不碰这个号，按不下来就是按不下来。
 */
export const fadeOutThenPause = async(pause: () => Promise<unknown> | unknown) => {
  // 渐出优先于任何还没跑完的渐入预约：用户要的是「停」，不是接着升音量
  fadeInArmed = false
  clearArmTimer()
  if (Platform.OS != 'ios') {
    stopRamp()
    await Promise.resolve(pause()).catch(() => {})
    return
  }
  if (fadingOut) {
    // 上一次渐出还没走完（连点两次暂停）：不叠第二层斜坡，但暂停动作必须执行
    await Promise.resolve(pause()).catch(() => {})
    return
  }
  const seq = ++pauseSeq
  fadingOut = true
  try {
    // settleWithin 是第二道闸：即便斜坡 Promise 出意外没有放行，到点也照常往下走
    await settleWithin(rampVolume(0, FADE_OUT_MS), FADE_OUT_MS + FADE_STEP_MS * 2)
    // 号变了 = 渐出途中用户按了播放（armFadeIn 的掉头分支）—— 这条暂停已被取代，不落地
    if (seq != pauseSeq) return
    await Promise.resolve(pause()).catch(() => {})
  } finally {
    fadingOut = false
  }
}

/**
 * 是否有预约 / 斜坡 / 渐出在途【第 51 轮】。
 * 给「外部直写音量」的调用方用（trackPlayerCore.applyCurrentVolume）：起播路径是
 * 「先起引擎、再重贴音量」，那次重贴会把音量一步顶回设定值 —— 预约的渐入当场作废
 * （音量已经在设定值上，斜坡第一拍就变成直写）。
 */
export const isVolumeFadeActive = () => fadeInArmed || fadeTimer != null || fadingOut

/**
 * 外部直写音量后同步本模块的账本（utils.setVolume 在音量条写音量时调用）。
 * 【第 41 轮缺陷②】斜坡起点取自 currentVolume：账本一旦和实际值脱节，
 * 下一次渐入/渐出的第一拍就是一次跳变（用户听见的爆音）。斜坡/渐出在跑时以斜坡为准，不覆盖。
 * 【第 51 轮】**预约期间不拦**（刻意）：账本必须跟着真正写出的值走 —— 音量条拖动就是一次
 * 真实写入（引擎立刻变成新音量、setSetting 同步更新设定值），这时若把账本按在 0 上，
 * 紧接着的渐入会从 0 起步（先掉下去再升上来 = 一次多余的音量塌陷）。保护预约靠的是
 * 「重贴设定音量」那两处调用点的让行（trackPlayerCore.applyCurrentVolume /
 * service.restoreConfiguredVolume 的 isVolumeFadeActive() 守卫），它们在预约期间根本不会写。
 */
export const syncVolumeFadeState = (volume: number) => {
  if (Platform.OS != 'ios') return
  if (typeof volume != 'number' || !Number.isFinite(volume)) return
  if (fadeTimer != null || fadingOut) return
  currentVolume = clamp01(volume)
}
