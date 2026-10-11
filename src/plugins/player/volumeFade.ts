import { Platform } from 'react-native'
import TrackPlayer from 'react-native-track-player'
import { getNativeFlacState, isNativeFlacActive, setNativeFlacVolume } from './nativeFlac'
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
 * ---------------------------------------------------------------------------
 * 【第 56 轮·追加】用户原话：「取消勾选"与其他应用同时播放"选项，自动暂停和自动播放增加
 * 渐入渐出效果，目前自动播放很快，声音突然很大，建议加上声音由小变大的渐入效果」。
 *
 * 自动暂停（独占口径）本来就走渐出：service.ts 的延迟暂停落到 player.pause → utils.setPause
 * → fadeOutThenPause，斜坡先降到 0 再真停。听感上之所以还是「像被切一刀」，是因为系统打断
 * 一开始就把我们的会话压住了 —— 那 300ms 渐出是在静音里跑完的，扬声器上听不出「淡出」。
 *
 * 「自动播放很快、声音突然很大」是另外一回事，两处硬切换：
 *  ① 【未预约的 'playing' 直写目标音量】打断结束由**原生先重启引擎并重发 'playing'**，
 *     JS 侧的预约（setPlay → armVolumeFadeIn）跟它是两条互不等待的路径。'playing' 抢先
 *     的那些次序里 applyVolumeOnPlayStart 走的是「未预约」分支，旧实现直写目标音量 —— 而
 *     自动暂停已经把音量压到 0，听感就是「从静音一记跳到满音量」。现在这一支也走
 *     FADE_IN_MS 的斜坡（账本本来就在目标值附近时，斜坡内部按 MIN_RAMP_DELTA 短路成直写，
 *     行为与改动前一致：不会给「根本没停过的播放」凭空加一次淡入）。
 *  ② 【预约反手把在途渐入掐掉】armVolumeFadeIn 旧实现无条件 stopRamp() + silenceBothEngines()：
 *     打断恢复若已经自己渐入到一半，这两句把音量拍回 0，而下一声 'playing' 未必再来 ——
 *     音量要等预约的兜底期限（1.5s）才一记跳回设定值，比不预约还糟。现在只在没有斜坡
 *     在跑时才压 0。
 * 另外在打断结束的分支里先立预约（service.ts 的独占 Ended 分支）：它同时让
 * restoreConfiguredVolume 的 isVolumeFadeActive() 守卫让行，账本 / 引擎不会被一步顶回
 * 设定值 —— 否则斜坡的起点已经不是 0，渐入无从谈起。
 * ---------------------------------------------------------------------------
 * 【第 63 轮第 2 条】用户原话：「渐入渐出的声音变化为渐入（Fade In）：音乐开始播放时，音量
 * 从 0 在指定时长内平滑升至正常音量。渐出（Fade Out）：音乐停止或切换前，音量从当前值在
 * 指定时长内平滑降至 0。默认时长：渐入 2 秒，渐出 3 秒（可在播放设置中配置，位置在将播放的
 * 中文歌词转换为繁体选项下面，调节范围为 0-3 秒）。缓动曲线：默认使用等功率曲线
 * （Equal-Power），避免音量突变；可选线性（Linear）。触发条件：播放开始时自动渐入；暂停、
 * 停止、切歌或播放结束时自动渐出。可中断：渐入渐出过程中若用户手动调节音量或切歌，应能
 * 立即中断当前渐变并按新指令执行。交叉淡化（可选）：切歌时上一首渐出与下一首渐入重叠进行，
 * 重叠时长 1 秒」。
 *
 * 本轮落地（逐条对到代码，偏离的两处写在这里）：
 *  · **时长可配**：`player.fadeInDuration` / `player.fadeOutDuration`（**秒**，0~3、0.5 步进，
 *    默认 2 / 3），读取见 readFadeMs / fadeInMs / fadeOutMs；0 = 关闭渐变（直写）。
 *    UI 在播放设置里，紧跟在「将播放的中文歌词转换为繁体」下面（settings/Player/index.tsx）。
 *  · **曲线可配**：`player.fadeLinearCurve`（false = 缓入缓出，默认），见 easeVolume。
 *  · **可中断**：① 手动调音量 → `syncVolumeFadeState` 口径反转为「掐掉在途斜坡、账本按新值」
 *    （旧口径是让行，见该函数注释）；② 切歌 / 停止 → `setStop` 调 `cancelPendingFadeOut()`。
 *  · **渐出的触发点**：真正落地的是**暂停**（手动 / 自动 / 锁屏 / 打断）——`setPause` →
 *    fadeOutThenPause，一条没变，只是时长改成读设置。
 *  · **偏离一：切歌不做 3 秒渐出。** 需求把「切歌」列在渐出的触发条件里，但本工程切歌是
 *    「旧引擎停 → 取链 → 新引擎起」（`core/player/player.ts` 的 handlePlay → setStop →
 *    debouncePlay），中间那段等待时长由网络决定（几百毫秒到几秒不等）。要让渐出「听得见」，
 *    只能①等斜坡跑完再放下一首（把 3 秒静音塞进每一次切歌）或②两首歌重叠（= 需求里的
 *    「交叉淡化」）。用户在裁定口径时明确「交叉淡化本轮先不做」，①又明显不是想要的
 *    （用户第 61 轮刚因为「点一下晚一拍」把渐出从 700ms 打回 300ms），所以切歌处维持
 *    「旧引擎即时静音（setStop 本来就会掐掉正在出声的流）+ 新歌按设置的渐入时长由小变大」——
 *    可听见的那一半（新歌渐入）是齐的，旧歌那一段没有可听的下坡。**不做交叉淡化**
 *    是用户本轮的明确裁定：「本轮先不做这个开关」（双引擎重叠、时长 1 秒那套整块不做）。
 *  · **偏离二：停止（`player.stop()`）与切歌共用 setStop**，所以也没接斜坡（同一条路：
 *    在 utils.setStop 里加斜坡会把等待带进**每一次切歌**）。UI 入口见
 *    screens/Home/Views/Mylist/MusicList/listAction.ts（清缓存流程里的 stop）。
 *  · **偏离三：播放结束**没有斜坡 —— 音频自然放完时音量已经在 0（无可淡），且引擎的 ended
 *    处理随后就是切歌 / 停止，与上面两条同理。
 *  · **硬件音量键不能打断**：iOS 侧没有系统音量变化的观测（本项目没接 KVO on outputVolume），
 *    所以「手动调节音量」只覆盖**应用内音量条**（PlayDetail 的 SettingVolume.tsx →
 *    utils.setVolume → syncVolumeFadeState）。
 * ---------------------------------------------------------------------------
 * 【第 65 轮第 1 条】用户原话：「渐入渐出时，出声要缓，特别是两头位置，不要出现声音突然出现
 * 或者消失的停顿感，现在渐入开始有停顿感，渐出结束有停顿感，曲线一定要缓」。
 * 第 63 轮那条需求原话点名的是**等功率**（Equal-Power），本轮用户按听感把它否了 —— 原因在
 * 「等功率」这个名字兑现的是**功率**恒定，不是**听感**平滑：它的升支在起点、降支在终点斜率
 * 最大（一头平、一头陡），于是渐入的头一下最猛、渐出的尾一下最狠，正是用户听到的两处
 * 「突然出现 / 突然消失」。默认曲线改为**缓入缓出**（raised cosine，两端导数为 0、中段最陡），
 * 并把 `rising` 参数从 easeVolume 上摘掉（曲线对称，方向由 `target - from` 表达）——
 * 第 64 轮那类「降支掉头」的写法从此在结构上不可能出现。
 * **设置键与线性档都不动**（`player.fadeLinearCurve` 仍是那个开关，只是「不勾选」的含义
 * 从等功率变成缓入缓出，文案已同步）。
 * ---------------------------------------------------------------------------
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

/**
 * 【第 63 轮第 2 条】渐入 / 渐出时长改为**可配置**。用户原话：「默认时长：渐入 2 秒，渐出 3 秒
 * （可在播放设置中配置，位置在将播放的中文歌词转换为繁体选项下面，调节范围为 0-3 秒）」。
 *
 * 这两个常量由「唯一取值」退化为**兜底值**：设置键缺省 / 脏值（非数字、NaN、Infinity）时
 * 用它们 —— 也就是需求点名的默认值本身。真正参与运算的是 fadeInMs() / fadeOutMs()。
 *
 * 为什么 0 不等同于兜底：滑块量程 0~3 秒里，0 是用户**明确选出来的一个值**，必须按
 * 「关闭渐变」执行（音量直写，等于第 39 轮之前的行为）；只有**读不到值**才落回默认。
 * 两种情况的处置完全相反（一个关、一个开），任何「把 0 当缺省」的写法都会让用户的 0 失效 ——
 * 这是本条最容易写错的地方。
 *
 * 渐出被加长到默认 3 秒之后，「真暂停跟在斜坡之后」这条老口径的代价由第 62 轮第 3 条兜住：
 * 界面 / 锁屏 / 灵动岛的暂停态**按下即翻**，不再等斜坡（sim-r62-instant-playstate.js 钉着）。
 * 所以这个值现在只决定**声音**什么时候降到 0，不再决定按钮什么时候翻面。
 * 历史取值：渐入 220 → 600（第 51 轮）；渐出 160 → 300（第 51 轮）→ 700（第 60 轮）→ 300
 * （第 61 轮回滚）→ 第 63 轮整体交给设置项，默认 3000。
 */
const FADE_IN_FALLBACK_MS = 2_000
const FADE_OUT_FALLBACK_MS = 3_000
/** 渐入 / 渐出滑块的量程上限（秒）：设置里的值超范围时夹到 0~它（见 readFadeMs） */
const FADE_MAX_SECONDS = 3
/**
 * 每档之间的间隔（毫秒）= 斜坡的写入频率（50 次/秒）。默认 2 秒渐入 = 100 档、3 秒渐出 =
 * 150 档 —— 频率与第 51 轮那版（600ms/30 档）**完全一致**，只是档数随可配时长变多，
 * 所以「时长可配」没有引入任何新的桥调用密度（每条一次 setNativeFlacVolume /
 * TrackPlayer.setVolume），第 57 轮的省电口径不受影响。
 */
const FADE_STEP_MS = 20
/**
 * 渐入预约的兜底期限（毫秒）【第 41 轮缺陷④】：预约后这么久还没等到 'playing'
 * （引擎没跨门槛 / 事件丢了 / 该路径没走 controller），无条件把音量恢复成用户设定值 ——
 * 宁可少一次渐入，也绝不留「在播但一点声没有」。用于**恢复播放**（引擎已就绪，很快出声）。
 * 【第 61 轮第 4 条】到点前先看一眼引擎在干什么：还在 loading / buffering 就再等一档
 *（见 beginFadeInArm 的续期与 ARM_RENEW_LIMIT），已出声就补一次渐入而不是一记跳回设定值。
 */
const ARM_TIMEOUT_MS = 1_500
/**
 * 渐入预约的续期次数上限【第 61 轮第 4 条】。到点时引擎仍在 loading / buffering（原生流式
 * 恢复要重设会话 + 重启引擎 + 重新缓冲，常超过一个兜底期限）就按同样的时长再等一档，最多
 * 这么多档 ⇒ 总等待上限 = ARM_TIMEOUT_MS * (1 + ARM_RENEW_LIMIT)。上限是「绝不能永久静音」
 * 这条死规矩的护栏：续完这几档无条件落地，宁可少一次渐入，也绝不留「在播但一点声没有」。
 */
const ARM_RENEW_LIMIT = 3
/**
 * 起播预约的兜底期限（毫秒）【第 51 轮】：换歌 / 点歌要先拿链接、再等缓冲，'playing'
 * 比恢复播放晚得多（几秒是常态）。用 1.5s 那个期限会让预约在出声前就到期 —— 起播渐入
 * 十次有八次白预约。放宽到 6s（同样是**只晚不丢**：到点无条件恢复设定音量）。
 */
const START_ARM_TIMEOUT_MS = 6_000
/** 两次音量写入之间的最小可感知差：差得比它小就直接写终点，不白跑一趟斜坡 */
const MIN_RAMP_DELTA = 0.01
/**
 * 斜坡里「这一拍的值和上一拍几乎一样」的跳过阈值【第 64 轮·降低耗电与发热】。
 * 缓入缓出的两端极平（raised cosine 的导数在两端为 0）：3 秒渐出的头 / 尾各 ~3% 拍、2 秒渐入
 * 同理，相邻两拍差不到 0.002 —— 这点差（-54dB 量级）耳朵听不出来，桥调用却是实打实的
 * （每拍一次 `setNativeFlacVolume` / `TrackPlayer.setVolume`，原生侧还要写一次音量）。
 * 只跳过「差得极小」的拍：跳过后的写入序列仍是完整序列的**子序列**，单调性不变；末拍
 * **无条件写**，终点值永远精确落定。
 * 【第 65 轮第 1 条】换曲线后这条规则的价值更大：两端极平的拍变多（两头都平，不再只有一头），
 * 但**被跳过的拍本来就等于「音量没怎么动」**，所以它既不改形状、也不会造出「停顿感」。
 */
const FADE_WRITE_EPSILON = 0.002

let fadeTimer: ReturnType<typeof setInterval> | null = null
/** 在途斜坡的放行句柄【第 41 轮缺陷①】：斜坡被取消 / 完成都从这一处 resolve，绝不留悬挂 */
let fadeResolve: (() => void) | null = null
/** 渐入预约的兜底定时器【缺陷④】 */
let armTimer: ReturnType<typeof setTimeout> | null = null
/** 是否已被 setPlay / 起播预约了「下一次播放开始时渐入」 */
let fadeInArmed = false
/** 本次预约已经续期的档数【第 61 轮第 4 条】，上限见 ARM_RENEW_LIMIT */
let armRenewals = 0
/**
 * 预约代数【第 61 轮第 4 条】：每次新建预约 ++。到点的引擎探针是异步的，回来时只认自己
 * 那一代 —— 否则「探针在途、用户又按了播放」的新预约会被上一代的结果一记写回设定值。
 */
let armGeneration = 0
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
 * 读一个渐入 / 渐出时长设置项（单位：**秒**），返回毫秒【第 63 轮第 2 条】。
 *   · 缺省 / 脏值（非数字、NaN、Infinity）→ 兜底值（= 需求点名的默认值）；
 *   · ≤ 0 → **0**（用户在滑块上选的「关闭渐变」，不是缺省 —— 见常量段的说明）；
 *   · 其它 → 夹到 (0, FADE_MAX_SECONDS * 1000]，防止旧版本残留 / 手工改坏的超范围值
 *     把斜坡拖成分钟级（真暂停跟在斜坡之后，超长斜坡等于「按了暂停半天不停」）。
 * 每次调用现读设置：用户在设置页改完滑块，下一次渐入 / 渐出即生效，无需重启（与
 * 「与其他应用同时播放」那条设置同一口径）。
 */
const readFadeMs = (key: 'player.fadeInDuration' | 'player.fadeOutDuration', fallbackMs: number) => {
  const seconds = settingState.setting[key]
  if (typeof seconds != 'number' || !Number.isFinite(seconds)) return fallbackMs
  if (seconds <= 0) return 0
  return Math.min(seconds, FADE_MAX_SECONDS) * 1000
}

/** 渐入时长（毫秒）：设置项 player.fadeInDuration（秒），默认 2 秒 */
const fadeInMs = () => readFadeMs('player.fadeInDuration', FADE_IN_FALLBACK_MS)

/** 渐出时长（毫秒）：设置项 player.fadeOutDuration（秒），默认 3 秒 */
const fadeOutMs = () => readFadeMs('player.fadeOutDuration', FADE_OUT_FALLBACK_MS)

/** 曲线是不是线性的：设置项 player.fadeLinearCurve（勾选 = 线性），默认关 = 缓入缓出 */
const isLinearCurve = () => settingState.setting['player.fadeLinearCurve'] === true

/**
 * 感知曲线【第 63 轮第 2 条 / 第 64 轮第 2 条修正 / 第 65 轮第 1 条换曲线】。
 *
 * 本函数返回的**永远是单调 0→1 的插值参数**（升 / 降两个方向都从 0 开局、到 1 收尾），
 * 方向由调用式 `from + (target - from) * ease` 里 `target - from` 的正负体现（见 rampVolume）
 * —— 所以从任意当前音量起斜坡都成立（渐出被打断到半途后再渐出、音量条拖到一半再暂停……
 * 这些现场起点既不是 0 也不是设定值）。
 *
 *   · **缓入缓出（默认）**：`0.5 - 0.5·cos(π·p)`（raised cosine，音频界也叫 sine ease-in-out）。
 *     **两端导数为 0、中段最陡** —— 这正是第 65 轮第 1 条要的「缓」。
 *   · 线性：两个方向都是 `p`（等幅度变化，中段听起来掉得更快）。
 *
 * 【第 65 轮第 1 条】用户原话：「渐入渐出时，出声要缓，特别是两头位置，不要出现声音突然出现
 * 或者消失的停顿感，现在渐入开始有停顿感，渐出结束有停顿感，曲线一定要缓」。
 * 症结在**两端的斜率**：第 63/64 轮用的等功率曲线 `sin(π/2·p)`（升）/ `1 - cos(π/2·p)`（降）
 * 是「一头平、一头陡」——
 *   · 升支在 p=0 处斜率最大（π/2）：渐入第一拍就把音量推到 1.57%，20ms 冲到 -36dB，
 *     听感是**声音突然出现**；
 *   · 降支在 p=1 处斜率最大：渐出最后一拍直接从 -32dB 掉到 0，听感是**声音突然消失**。
 * 换成 raised cosine 后两端斜率都是 0：渐入第一拍只有 0.025%（-72dB，等于没动），
 * 渐出最后一拍同样从 -72dB 量级落地 —— 两头都是「慢慢起、慢慢落」。副作用是**感知响度**
 * 更接近线性：以响度 ∝ 幅度^0.6 估算，等功率渐出走到 90% 时还有约 32% 的响度（最后一成
 * 时间掉 32% → 0，就是那记「突然消失」），raised cosine 渐出走到 90% 时只剩约 11%
 * （最后一成时间 11% → 0，落得下去）。
 *
 * 顺带把上一轮那类写法的可能性也去掉了：**降支不再需要方向参数**（曲线对称，没有
 * 「升用 sin / 降用 1-cos」这种可以写反的地方）。第 64 轮第 2 条报的「音量降低再变高再至 0」
 * 正是把降支写成 `sin(π/2·(1-p))` = `cos(π/2·p)`（p 0→1 时从 1 掉到 0）造成的 —— 现在
 * `easeVolume` 连 `rising` 参数都没有了，那条错路在结构上不存在。
 */
const easeVolume = (progress: number, linear: boolean) => {
  if (linear) return progress
  const radian = Math.PI * progress
  return 0.5 - 0.5 * Math.cos(radian)
}

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
/**
 * 【第 61 轮第 4 条】引擎此刻到底在干什么（哪一台在驱动就问哪一台）。
 * 给渐入预约的到点复核用：只有 'playing' 才算「已经在出声」，'loading' / 'buffering' 是
 * 「还没起 / 还在重填」——两者的处置完全相反（前者补渐入，后者续期）。
 * 探针失败一律 'unknown' —— 调用方按「不走运就按老口径落地」处理，绝不因此卡住音量。
 * 与 utils.ts 的同名分发同口径（此处不 import 以免成环，理由见文件头）。
 */
const probeEngineState = async(): Promise<string> => {
  if (Platform.OS != 'ios') return 'unknown'
  try {
    if (isNativeFlacActive()) return await getNativeFlacState()
    return await TrackPlayer.getState()
  } catch {
    return 'unknown'
  }
}

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
 * 音量斜坡：从**当前实际音量**（currentVolume）走到 to【缺陷②】，按感知曲线【第 51 轮 /
 * 第 63 轮第 2 条】在 durationMs 内摊开。完成或被 stopRamp 掐掉都会 resolve【缺陷①】。
 * 两种不白跑一趟的情况，都退化成「直接写终点」：
 *   · 起点与终点几乎相同（MIN_RAMP_DELTA）—— 老口径，避免给「根本没停过的播放」凭空加一次淡入；
 *   · **时长为 0**【第 63 轮第 2 条】—— 用户在设置里把渐入 / 渐出调到 0 = 关闭渐变，
 *     必须逐字回到第 39 轮之前的直写行为（不许留下一个「最小档位」的斜坡）。
 *
 * 曲线在**起斜坡时快照**（不在每一拍里现读设置）：拖动曲线开关 / 时长滑块不该改写在途
 * 斜坡的形状 —— 那会让同一次过渡前后两半用两条曲线，听感上是一处折点。
 * 方向不需要单独的快照：`target - from` 这个差值本身就是方向（第 65 轮第 1 条起曲线对称，
 * easeVolume 不再吃 `rising`）。
 */
const rampVolume = (to: number, durationMs: number): Promise<void> => {
  stopRamp()
  const from = currentVolume
  const target = clamp01(to)
  if (durationMs <= 0 || Math.abs(target - from) < MIN_RAMP_DELTA) {
    void writeVolume(target)
    return Promise.resolve()
  }
  const linear = isLinearCurve()
  return new Promise<void>((resolve) => {
    const steps = Math.max(1, Math.round(durationMs / FADE_STEP_MS))
    let step = 0
    let written = from
    fadeResolve = resolve
    fadeTimer = setInterval(() => {
      step++
      const next = from + (target - from) * easeVolume(step / steps, linear)
      // 末拍无条件写（终点必须精确落定）；中间拍与上一拍差得听不出来就不发桥
      //（FADE_WRITE_EPSILON：缓入缓出两端极平，这些拍纯属白耗电）
      if (step < steps && Math.abs(next - written) < FADE_WRITE_EPSILON) return
      written = next
      void writeVolume(next)
      if (step >= steps) stopRamp()
    }, FADE_STEP_MS)
  })
}

/**
 * 预约「下一次播放开始时渐入」的公共体：置标记 + 上兜底期限。
 * 到点还没被 'playing' 消费（`applyVolumeOnPlayStart`）【缺陷④】：
 *   · 引擎还在 loading / buffering → **续期**（最多 ARM_RENEW_LIMIT 档）；
 *   · 引擎已经在出声（'playing' 事件丢了 / 该路径没走 controller）→ 补一次渐入斜坡；
 *   · 其它（idle / paused / stopped / 探针失败）→ 无条件恢复设定音量。
 *
 * 【第 61 轮第 4 条】为什么到点不能直接硬写：用户原话「自动播放没有渐出效果」。自动续播
 * 的对面是**原生先重启引擎并重发 'playing'**（重设会话 + 重启引擎 + 重新缓冲），这条链常
 * 超过一个 1.5s 的兜底期限 —— 旧实现到点无条件写设定音量，于是预约先到期、音量已经回到
 * 设定值，紧随其后的 'playing' 拿一个「账本 ≈ 目标值」的现场做斜坡，被 MIN_RAMP_DELTA 短路
 * 成直写：用户听到的是「一记满音量」，不是由小变大。续期是**只晚不丢**：总等待上限 = 一个
 * 起播预约的期限量级（ARM_TIMEOUT_MS × (1 + ARM_RENEW_LIMIT) = 6s = START_ARM_TIMEOUT_MS），
 * 到顶无条件落地 —— 「绝不留『在播但一点声没有』」这条死规矩一个字不让。
 */
const beginFadeInArm = (timeoutMs: number) => {
  fadeInArmed = true
  armRenewals = 0
  clearArmTimer()
  const generation = ++armGeneration
  const settle = () => {
    armTimer = setTimeout(() => {
      armTimer = null
      if (!fadeInArmed) return
      void (async() => {
        const state = await probeEngineState()
        // 探针在途期间：预约可能已被 'playing' 消费、被暂停撤销，或又被下一次预约取代。
        // 只有「这一代仍是当前那一代」才允许由本回调落地（否则会把新预约的渐入顶掉）。
        if (generation != armGeneration) return
        if (!fadeInArmed) return
        if ((state == 'loading' || state == 'buffering') && armRenewals < ARM_RENEW_LIMIT) {
          armRenewals++
          settle()
          return
        }
        fadeInArmed = false
        armRenewals = 0
        if (state == 'playing') {
          // 已经在出声、只是没等到事件：补一次由小变大（从压住的 0 起），而不是一记跳回设定值
          void rampVolume(targetVolume(), fadeInMs())
          return
        }
        void writeVolume(targetVolume())
      })()
    }, timeoutMs)
  }
  settle()
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
    void rampVolume(targetVolume(), fadeInMs())
    return true
  }
  beginFadeInArm(timeoutMs)
  // 【第 56 轮·追加】渐入斜坡已经在跑（系统打断结束的自动续播先一步把它拉起来了）：
  // 不掐、也不压 0。旧实现无条件 stopRamp() + silenceBothEngines()，会把在途的渐入
  // 拍回静音；这一支的下一声 'playing' 若不来（引擎早已跨过出声门槛，不会为一次音量
  // 写入重发），音量就要等预约的兜底期限（1.5s）才一记跳回设定值 —— 比不预约还糟。
  // 没有斜坡在跑时才做「压 0 等 'playing'」这一套（暂停态预约的常规现场）。
  if (fadeTimer == null) {
    stopRamp()
    silenceBothEngines()
  }
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
  // 【第 63 轮第 2 条】时长按设置现读一次，同一拍里两处斜坡共用（方案与曲线快照同理：
  // 一次渐入不该因为用户正好在拖滑块而被切成两段）
  const duration = fadeInMs()
  if (Platform.OS != 'ios' || !fadeInArmed) {
    if (Platform.OS == 'ios' && fadingOut) return
    if (Platform.OS == 'ios' && fadeTimer != null) return
    // 【第 56 轮·追加】未预约这一支也要走斜坡 —— 系统打断结束的「自动续播」就落在这里。
    // 原生侧重启引擎 / 重发 'playing' 与 JS 侧的预约（setPlay → armVolumeFadeIn）是两条
    // 互不等待的异步路径，谁先到没有保证：'playing' 抢先的那些次序里 fadeInArmed 还是 false。
    // 旧实现这一支是**直写**目标音量 —— 而自动暂停已经把音量压到 0（账本 currentVolume = 0），
    // 于是自动续播听上去就是「从静音一记跳到满音量」：用户这轮报的「自动播放很快，声音突然
    // 很大」。现在这一支同样走渐入斜坡（时长取设置值，默认 2 秒）：
    //   · 账本在低处（真被自动暂停压过）→ 由小变大的渐入；
    //   · 账本已经 ≈ 目标值（音量根本没被压过，例如短暂系统音、播放中的重缓冲）→
    //     rampVolume 内部按 MIN_RAMP_DELTA 短路成直写，与改动前逐字节一致。
    // Android 仍然直通（那边没有 controller 的 'playing' 兜底，见文件头末段）。
    if (Platform.OS == 'ios') {
      await rampVolume(target, duration)
      return
    }
    await writeVolume(target)
    return
  }
  fadeInArmed = false
  clearArmTimer()
  await rampVolume(target, duration)
}

/**
 * 渐出后再暂停：先斜坡降到 0（时长取设置项 player.fadeOutDuration，默认 3 秒），
 * 然后执行真正的暂停动作。
 * @param pause 真正的暂停动作（传函数而不是已调用的 Promise —— 斜坡跑完才允许它执行）
 *
 * 【第 41 轮】这里是「锁屏 / 灵动岛按钮点了没反应」的正凶现场，改法三条：
 *   · 起点取**当前实际音量**（斜坡自己读 currentVolume）【缺陷②】—— 旧实现从设定音量起步，
 *     在低音量处会先跳高再降，就是那声爆音；
 *   · fadingOut 期间 `applyVolumeOnPlayStart` 全让行 —— 在途渐出不会被 'playing' 掐掉；
 *   · 斜坡只负责「柔和」，**暂停动作无条件执行**：斜坡被掐 / 卡死也在有限时间内放行，
 *     正常跑完则立刻放行【缺陷①的后半】—— 用户按下 ⏸ 就一定要停，这是第 41 轮的死规矩。
 *
 * 【第 51 轮】只有**用户自己又按了播放**这一种情况例外：`pauseSeq` 进门领号，放行后先对号，
 * 号变了（armFadeIn 的掉头分支 ++）就跳过真暂停 —— 死规矩让位于更新的用户意图。
 * 自动路径（'playing' 事件、音量直写）不碰这个号，按不下来就是按不下来。
 *
 * 【第 63 轮第 2 条】这个号多了**第二个**递增点：`cancelPendingFadeOut()`（切歌 / 停止，
 * 由 plugins/player/utils.ts 的 setStop 收口）。渐出加长到默认 3 秒之后，这条「渐出跑完
 * 就真暂停」的尾巴会跨过一次切歌 —— setStop 已经停了旧引擎、新歌的引擎随后起来，而那条
 * 在途斜坡到点照样执行 `pausePlayingEngines()`，把**刚起的新歌**按停。旧值 300ms 时这个
 * 窗口太窄撞不上，3 秒之后是常态。语义仍是「更新的用户意图赢」，只是意图从「播放」扩到
 * 「切歌 / 停止」——两者都是「这条暂停已经过期」的同一个意思。用户原话「可中断：渐入渐出
 * 过程中若用户手动调节音量或切歌，应能立即中断当前渐变并按新指令执行」。
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
  // 【第 63 轮第 2 条】时长按设置现读一次：两处（斜坡 + settleWithin 的上限）必须同值 ——
  // 用两次 readFadeMs 的话，用户在斜坡途中把滑块从 3 拖到 0.5 会让上限缩到比斜坡还短，
  // 第二道闸抢在斜坡前面放行（听感上就是渐出被拦腰砍断）。
  const duration = fadeOutMs()
  try {
    // settleWithin 是第二道闸：即便斜坡 Promise 出意外没有放行，到点也照常往下走
    await settleWithin(rampVolume(0, duration), duration + FADE_STEP_MS * 2)
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
 * 作废在途的渐出及其真暂停【第 63 轮第 2 条】。
 * 调用点：`plugins/player/utils.ts` 的 `setStop`（切歌 / 停止 / 错误重载的唯一收口，
 * 见那里的调用点注释）。
 *
 * 为什么必须由切歌路径显式作废：渐出时长现在可配到 3 秒，「渐出跑完就真暂停」这条尾巴
 * 会跨过一次切歌 —— setStop 已经停了旧引擎、新歌的引擎随后起来（debounce + 取链），
 * 而那条在途斜坡到点照样执行 `pausePlayingEngines()`，把**刚起的新歌**按停。旧值 300ms
 * 时这个窗口太窄撞不上，3 秒之后是常态。
 * 两件事一起做：
 *   · `pauseSeq++` —— 那条 fadeOutThenPause 放行后会跳过真暂停（与「渐出途中按播放」
 *     同一个号，见其注释）；
 *   · `stopRamp()` —— 掐掉在途斜坡。**必须掐**：斜坡每一拍都按 `isNativeFlacActive()`
 *     现查当前驱动，切歌之后查到的可能是**新歌的引擎**，那几拍降音会直接写在新歌上，
 *     与它自己的渐入对顶。账本停在当前值不跳变（`stopRamp` 不写音量）。
 * 不碰 `fadeInArmed`：新歌的起播渐入由 resourceLoader 的 armVolumeStartFadeIn 另行立预约。
 */
export const cancelPendingFadeOut = () => {
  if (Platform.OS != 'ios') return
  pauseSeq++
  stopRamp()
}

/**
 * 外部直写音量后同步本模块的账本（utils.setVolume 在音量条写音量时调用）。
 * 【第 41 轮缺陷②】斜坡起点取自 currentVolume：账本一旦和实际值脱节，
 * 下一次渐入/渐出的第一拍就是一次跳变（用户听见的爆音）。
 *
 * 【第 63 轮第 2 条·口径反转】旧写法是「斜坡 / 渐出在跑时让行、不覆盖账本」（第 41 轮
 * 的取舍：以斜坡为准）。渐入渐出加长到 0~3 秒可配之后这条取舍站不住了：用户在 3 秒的
 * 渐出里把音量条从 30% 拖到 80%，让行的结果是下一秒被斜坡按回 0 —— 听到的是「拖了没用，
 * 声音照样掉下去」。用户原话「可中断：渐入渐出过程中若用户手动调节音量或切歌，应能立即
 * 中断当前渐变并按新指令执行」，所以现在反过来：**手动音量优先，掐掉在途斜坡**。
 *
 * 掐斜坡不等于取消暂停：`stopRamp` 会放行斜坡的 Promise，等在那一行的 `fadeOutThenPause`
 * 照常走完并落地真暂停（它自己的号没变）—— 用户的意图是「音量听我的」，不是「别暂停了」。
 *
 * 这个函数只在「外部真的写了音量」时才被调用，而唯一能在斜坡途中调用它的路径是音量条
 *（`utils.setVolume`）；两处「重贴设定音量」的自动路径（trackPlayerCore.applyCurrentVolume /
 * service.restoreConfiguredVolume）各自带着 `isVolumeFadeActive()` 前置让行，斜坡在途时
 * 根本走不到这里 —— 所以「自动重贴」不会误伤渐入（见文件头与那两处的注释）。
 */
export const syncVolumeFadeState = (volume: number) => {
  if (Platform.OS != 'ios') return
  if (typeof volume != 'number' || !Number.isFinite(volume)) return
  stopRamp()
  currentVolume = clamp01(volume)
}
