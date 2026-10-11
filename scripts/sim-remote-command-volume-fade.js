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
 *   五、**渐入预约有兜底期限**：`ARM_TIMEOUT_MS` 到点先复核引擎状态再落地（第 61 轮第 4 条
 *       起：loading / buffering 续期 ≤ ARM_RENEW_LIMIT、'playing' 补渐入、其余无条件恢复
 *       设定音量）—— 缺陷④，见下。
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
 *       渐出时长三起三落：160 → 300（第 51 轮「要听得出来」）→ 700（第 60 轮第 4 条
 *       「渐出的时间加长一点」）→ 300（【第 61 轮第 1 条】回滚：用户原话「越改越乱，就连
 *       点击暂停播放按钮显示都有延迟了，需要还原」—— 真暂停与界面状态翻转都排在斜坡之后，
 *       700ms 是能被眼睛看出来的延迟；这条斜坡手动与自动暂停共用，改一处两边一起变）。
 *       本条边界 [240, 400]：下界仍是「听得出来的最底」（< 240 见 v19），上界是「不许再回到
 *       延迟区」（> 400 见 v31）—— 反例 v18 / v19 / v31 / v20。
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
 * ---------------------------------------------------------------------------
 * 【第 61 轮】用户原话（逐字）：「越改越乱，就连点击暂停播放按钮显示都有延迟了，需要还原」
 * +「bug：还有自动播放没有渐出效果」。两项一撤一改：
 *
 *   十五、**渐出时长回滚 700 → 300**（第 61 轮第 1 条）：第 60 轮把 FADE_OUT_MS 从 300
 *       加长到 700（「渐出的时间加长一点」），但这条斜坡后面跟着**真暂停** —— 锁屏 / 灵动岛
 *       进度条停住、按钮变 ▶、界面暂停状态翻转全排在斜坡之后，斜坡多长那一拍就多晚；700ms
 *       是能被眼睛看出来的延迟。取值回到用户认可的 300，断言边界改为 [240, 400]（下界：听得
 *       出来的最底；上界：不许再回到延迟区）。手动与自动暂停共用同一条斜坡，改一处两边一起变。
 *   十六、**预约到点先探引擎状态，再决定怎么落地**（第 61 轮第 4 条）：「自动播放没有渐出
 *       效果」的病根是预约（beginFadeInArm）到点**无条件**硬写设定音量 —— 自动续播的对面是
 *       原生先重设会话 + 重启引擎 + 重新缓冲，常超过一个 1.5s 的兜底期限：预约先到期、账本
 *       回到设定值，紧随的 'playing' 拿「账本 ≈ 目标值」的现场做斜坡，被 MIN_RAMP_DELTA
 *       短路成直写，听感就是一记满音量。现在到点的兜底回调先 probeEngineState()：
 *         · loading / buffering → 按同样时长再等一档，最多 ARM_RENEW_LIMIT（3）档
 *           （总等待上限 = 1.5s × (1 + 3) = 6s = 一个起播预约的期限量级，只晚不丢）；
 *         · 'playing' → 补一次 FADE_IN_MS 的渐入斜坡（从压住的 0 起，由小变大）；
 *         · 其它 / 探针失败 → 无条件恢复设定音量（「绝不留『在播但一点声没有』」一字不让）。
 *       探针是异步的 ⇒ 配 armGeneration 代际守卫：回来时只认自己那一代，否则「探针在途、
 *       用户又按了播放」的新预约会被上一代的结果一记写回设定音量。
 *       —— 反例 v32 / v33 / v34 / v35 / v36。
 *
 * ---------------------------------------------------------------------------
 * 【第 63 轮第 2 条】用户原话（逐字）：「当我取消勾选"与其他应用同时播放"选项，在出现系统
 * 提示音（截图音、按钮音等）和其他的音乐，将不会自动暂停播放；渐入渐出的声音变化为渐入
 * （Fade In）：音乐开始播放时，音量从 0 在指定时长内平滑升至正常音量。渐出（Fade Out）：
 * 音乐停止或切换前，音量从当前值在指定时长内平滑降至 0。默认时长：渐入 2 秒，渐出 3 秒
 * （可在播放设置中配置，位置在将播放的中文歌词转换为繁体选项下面，调节范围为 0-3 秒）。
 * 缓动曲线：默认使用等功率曲线（Equal-Power），避免音量突变；可选线性（Linear）。触发条件：
 * 播放开始时自动渐入；暂停、停止、切歌或播放结束时自动渐出。可中断：渐入渐出过程中若用户
 * 手动调节音量或切歌，应能立即中断当前渐变并按新指令执行。交叉淡化（可选）：切歌时上一首
 * 渐出与下一首渐入重叠进行，重叠时长 1 秒」。
 *
 * 本轮这一条对契约的改动分四块（旧断言与新口径相反的地方必须一起改，否则反例自检会把
 * 「已经改对的形状」当成回退拦下来）：
 *
 *   十七、**时长从常量变成设置项**：`FADE_IN_MS` / `FADE_OUT_MS` 退场，换成
 *       `FADE_IN_FALLBACK_MS = 2_000` / `FADE_OUT_FALLBACK_MS = 3_000`（= 需求点名的默认值，
 *       只在设置键缺省 / 脏值时使用）+ `readFadeMs` 的三分支读取器：
 *         · 非数字 / NaN / Infinity → 兜底值；
 *         · **≤ 0 → 0**（用户明确选出来的「关闭渐变」，不是缺省 —— 把 0 当缺省是本条最容易
 *           写错的地方，所以单独一条断言）；
 *         · 其余 → 夹到 (0, FADE_MAX_SECONDS × 1000]（需求原话「调节范围为 0-3 秒」）。
 *       时长为 0 时斜坡并入既有的直写短路（`durationMs <= 0 ||` 与 MIN_RAMP_DELTA 同一行），
 *       逐字回到第 39 轮之前的直写行为 —— 不许留下一个「最小档位」的斜坡。
 *       —— 反例 v18 / v19 / v31 / v41 / v42 / v43 / v51。
 *
 *   十八、**曲线从 smoothstep 换成等功率（默认）/ 线性（可选）**：需求原话「默认使用等功率
 *       曲线（Equal-Power）……可选线性（Linear）」—— 第 51 轮的 `p²(3-2p)` 不是等功率，本轮
 *       换掉。`easeVolume(progress, linear, rising)`：等功率升 `sin(π/2 · p)` / 降
 *       `sin(π/2 · (1-p))`（= `cos(π/2 · p)`），两者平方和为 1 ⇒ 过渡期间功率恒定；线性升
 *       `p` / 降 `1-p`。方向由「终点比起点大」现算（`const rising = target > from`）而不是由
 *       调用点决定 —— 同一个调用点的当前音量在不同现场下高低不定（渐入被打断后暂停，起点就
 *       在半途），只有从起点 / 终点现算方向才能保住第 41 轮定死的「斜坡全程单调」。
 *       曲线与方向在**起坡时快照**：拖动曲线开关 / 时长滑块不该改写在途斜坡的形状（同一次
 *       过渡前后两半用两条曲线，听感上是一处折点）。
 *       —— 反例 v20 / v40 / v44 / v45。
 *
 *   十九、**可中断（用户原话「若用户手动调节音量或切歌，应能立即中断当前渐变并按新指令
 *       执行」）**，两个方向各一条：
 *         · **手动调音量**（音量条 → utils.setVolume → `syncVolumeFadeState`）：口径**反转**。
 *           第 41 轮是「斜坡 / 渐出在跑时让行、不覆盖账本」（以斜坡为准）；渐入渐出加长到
 *           0~3 秒可配之后这条取舍站不住了 —— 用户在 3 秒的渐出里把音量条从 30% 拖到 80%，
 *           让行的结果是下一秒被斜坡按回 0，听到的是「拖了没用，声音照样掉下去」。现在反过来：
 *           **手动音量优先，掐掉在途斜坡**，账本按新值走。注意掐斜坡 ≠ 取消暂停：`stopRamp`
 *           会放行斜坡的 Promise，等在那一行的 `fadeOutThenPause` 照常走完并落地真暂停
 *           （它自己的号没变）—— 所以 `syncVolumeFadeState` 里**不许**出现 `pauseSeq++`。
 *         · **切歌 / 停止**（`setStop`，切歌 / 停止 / 错误重载的唯一收口）→
 *           `cancelPendingFadeOut()`：`pauseSeq++`（作废「渐出跑完就真暂停」）+ `stopRamp()`
 *           （掐斜坡）。**必须掐**：斜坡每一拍都按 `isNativeFlacActive()` 现查当前驱动，
 *           切歌之后查到的可能是**新歌的引擎**，那几拍降音会直接写在新歌上，与它自己的渐入
 *           对顶。不碰 `fadeInArmed`（新歌的起播渐入由 resourceLoader 的
 *           armVolumeStartFadeIn 另行立预约）、不碰账本（停在哪里就从哪里继续，改掉会让新歌
 *           的渐入从错的起点起坡 = 一次跳变）。同样口径的还有 `setStop` 里的
 *           `pauseVerifyToken++`：一次「按下暂停 → 立刻切歌」的次序里，那条 700ms 复核会排在
 *           **新歌起播之后**并把新歌按停（旧值 300ms 时窗口太窄撞不上，3 秒之后是常态）。
 *       —— 反例 v46 / v47 / v48 / v49。
 *
 *   二十、**设置项本身**（三个键 + 设置页位置 + 文案）：`player.fadeInDuration` = 2、
 *       `player.fadeOutDuration` = 3、`player.fadeLinearCurve` = false（等功率），三者在
 *       defaultSetting / types 里都要有；设置页位置是需求点名的「将播放的中文歌词转换为繁体
 *       选项下面」，顺序即原话顺序（先渐入、再渐出、最后曲线）。—— 反例 v50 / v51 / v52。
 *
 *   本轮**明确不做**的两件事（用户裁定，写在这里防止以后被当成漏做）：
 *     · 短音（系统提示音 / 截图音 / 按钮音）**保持不暂停**（第 31 轮口径的 1500ms 忽略窗口），
 *       本轮只确认短音路径不引入音量跳变，不改回暂停；
 *     · **交叉淡化不做**（用户原话「本轮先不做这个开关」）：切歌维持「旧引擎即时静音 +
 *       新歌按设置的渐入时长由小变大」，双引擎重叠那套整块不做。
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
  // 【第 63 轮第 2 条】渐变时长 / 曲线的设置项：默认值、类型声明、设置页位置、文案
  defaultSetting: 'src/config/defaultSetting.ts',
  types: 'src/types/app_setting.d.ts',
  playerSettings: 'src/screens/Home/Views/Setting/settings/Player/index.tsx',
  lang: 'src/lang/zh-cn.json',
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
  // 【第 63 轮第 2 条】渐出时长从常量变成设置项读取，锚点跟着从 `FADE_OUT_MS` 换成
  // `duration`（`const duration = fadeOutMs()` 就在上面两行）。**两处必须是同一个 `duration`**：
  // 用两次 readFadeMs 的话，用户在斜坡途中把滑块从 3 拖到 0.5，上限会缩到比斜坡还短，
  // 第二道闸抢在斜坡前面放行（听感上就是渐出被拦腰砍断）。
  const at = code.indexOf('await settleWithin(rampVolume(0, duration)')
  if (at < 0) {
    reasons.push('fadeOutThenPause 没有用有界等待包住渐出斜坡（`await settleWithin(rampVolume(0, duration), ...)`）：'
      + '斜坡一旦被掐/卡住，真暂停就跟着永远不执行 —— 锁屏/灵动岛 ⏸ 点了没反应就是这个（第 41 轮缺陷①）')
  } else {
    if (!code.slice(at, at + 160).includes('duration + FADE_STEP_MS * 2')) {
      reasons.push('有界等待的期限不是「渐出时长 + 两拍余量」：期限必须有限，否则等于没有兜底')
    }
    if (!code.slice(Math.max(0, at - 300), at).includes('const duration = fadeOutMs()')) {
      reasons.push('渐出时长没有在起斜坡前现读一次（缺 `const duration = fadeOutMs()`）：'
        + '斜坡与有界等待的期限必须取同一个值（第 63 轮第 2 条）')
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
      if (!abortBody.includes('void rampVolume(targetVolume(), fadeInMs())')) {
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
    // 【第 61 轮第 4 条】到点不再无条件硬写：先 probeEngineState()，按引擎状态三路落地 ——
    //   loading / buffering 且未到续期上限 ⇒ 续期；'playing' ⇒ 补一次 FADE_IN_MS 渐入；
    //   其余（含探针失败 'unknown'）⇒ 无条件写设定音量。「绝不留『在播但一点声没有』」一字不让。
    if (!code.includes('const ARM_RENEW_LIMIT = 3')) {
      reasons.push('找不到 ARM_RENEW_LIMIT = 3（到点复核的续期上限）：上限没了就是无限续期，'
        + '预约永远不落地 ——「绝不留『在播但一点声没有』」失守（第 61 轮第 4 条）')
    }
    if (!code.includes('let armRenewals = 0')) {
      reasons.push('找不到 armRenewals 账本（到点复核已续期的档数记录）：没有它，续期上限无从谈起（第 61 轮第 4 条）')
    }
    if (!body.includes('const generation = ++armGeneration')) {
      reasons.push('beginFadeInArm 没有领代际号（缺 `const generation = ++armGeneration`）：'
        + '探针是异步的，回来时无法判断自己是不是上一代 —— 会把用户新按播放建立的预约一记写回设定音量（第 61 轮第 4 条）')
    }
    if (!body.includes('const state = await probeEngineState()')) {
      reasons.push('beginFadeInArm 到点没有先探引擎状态（probeEngineState）：无条件硬写设定音量正是'
        + '「自动播放没有渐出效果」的病根 —— 自动续播先重设会话 + 重启引擎 + 重新缓冲，常超过一个'
        + '兜底期限，预约先落地，紧随的 \'playing\' 拿「账本 ≈ 目标值」做斜坡被 MIN_RAMP_DELTA 短路成直写（第 61 轮第 4 条）')
    }
    if (!body.includes('if (generation != armGeneration) return')) {
      reasons.push('beginFadeInArm 的探针回来不认代际（缺 `if (generation != armGeneration) return`）：'
        + '探针在途、用户又按了播放 —— 上一代的结果会把新预约一记写回设定音量（第 61 轮第 4 条）')
    }
    if (!body.includes("if ((state == 'loading' || state == 'buffering') && armRenewals < ARM_RENEW_LIMIT) {")) {
      reasons.push('beginFadeInArm 到点复核不再按「加载中」续期：loading / buffering 时落地 = 预约白等，'
        + '紧随的 \'playing\' 只会被短路成一记满音量直写（第 61 轮第 4 条）')
    } else {
      if (!body.includes('armRenewals++')) {
        reasons.push('beginFadeInArm 的续期分支不记账（缺 `armRenewals++`）：续期上限永远到不了 = 无限续期')
      }
      if (!body.includes('settle()')) {
        reasons.push('beginFadeInArm 的续期分支不再等一档（缺 `settle()`）：这一单当场收摊，「再等一档」没发生')
      }
    }
    if (!body.includes("if (state == 'playing') {")) {
      reasons.push("beginFadeInArm 到点探到 'playing' 没有补一次渐入斜坡：引擎已经在出声，"
        + '无条件写设定音量 = 一记满音量直写，渐入效果没了（第 61 轮第 4 条）')
    } else if (!body.includes('void rampVolume(targetVolume(), fadeInMs())')) {
      reasons.push("beginFadeInArm 的 'playing' 分支没走渐入斜坡（应从压住的 0 起由小变大）")
    }
    if (!body.includes('void writeVolume(targetVolume())')) {
      reasons.push('beginFadeInArm 的兜底回调没有恢复用户设定音量（探针失败 / 其余状态的最后出路）')
    }
  }
  // 【第 61 轮第 4 条】探针本体：非 iOS 直接 'unknown'（走无条件落地）；iOS 上优先问原生流式
  // 引擎（无损档缓冲时 RNTP 那侧常是 idle / ended，只探 TrackPlayer.getState() 会把「加载中」
  // 误判成「其余」⇒ 预约白等）；探针抛错一律 'unknown'（无条件落地，绝不留没声）。
  const probeBody = bracedBody(code, 'const probeEngineState = async(): Promise<string> => {')
  if (probeBody == null) {
    reasons.push('找不到 probeEngineState（到点复核的引擎状态探针）：第 61 轮第 4 条的三路落地无从谈起')
  } else {
    if (!probeBody.includes("if (Platform.OS != 'ios') return 'unknown'")) {
      reasons.push("probeEngineState 非 iOS 平台没有直接返回 'unknown'（其余平台的预约照旧无条件落地）")
    }
    if (!probeBody.includes('if (isNativeFlacActive()) return await getNativeFlacState()')) {
      reasons.push('probeEngineState 不探原生流式引擎（缺 isNativeFlacActive 分支）：无损档缓冲时只问'
        + ' TrackPlayer.getState() 会拿到 idle，被当成「其余」无条件落地（第 61 轮第 4 条）')
    }
    if (!probeBody.includes('return await TrackPlayer.getState()')) {
      reasons.push('probeEngineState 不探 RNTP 的播放状态（缺 TrackPlayer.getState()）')
    }
    if (countOf(probeBody, "return 'unknown'") < 2) {
      reasons.push("probeEngineState 的兜底值不足（`return 'unknown'` 少于两处）：非 iOS 与探针抛错"
        + '两条路都该是 \'unknown\'，落错值会走错落地分支')
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
    // 【第 63 轮第 2 条·口径反转】旧口径是「斜坡 / 渐出在跑时让行、不覆盖账本」。渐入渐出
    // 加长到 0~3 秒可配之后这条取舍站不住了：用户在 3 秒的渐出里把音量条从 30% 拖到 80%，
    // 让行的结果是下一秒被斜坡按回 0 —— 听到的是「拖了没用，声音照样掉下去」。用户原话
    //「可中断：渐入渐出过程中若用户手动调节音量或切歌，应能立即中断当前渐变并按新指令执行」。
    // 现在反过来：**手动音量优先，掐掉在途斜坡**，账本按新值走。
    if (body.includes('if (fadeTimer != null || fadingOut) return')) {
      reasons.push('syncVolumeFadeState 又回到「斜坡 / 渐出在跑就让行」的旧口径：用户在渐出途中'
        + '拖动音量条，下一秒会被斜坡按回 0 ——「拖了没用，声音照样掉下去」（第 63 轮第 2 条'
        + '「可中断：手动调节音量应能立即中断当前渐变」）')
    }
    if (!body.includes('stopRamp()')) {
      reasons.push('syncVolumeFadeState 没有掐掉在途斜坡（缺 `stopRamp()`）：手动调音量的指令'
        + '压不住正在跑的渐变（第 63 轮第 2 条「应立即中断当前渐变并按新指令执行」）')
    }
    if (!body.includes('currentVolume = clamp01(volume)')) {
      reasons.push('syncVolumeFadeState 没有把新值记进账本：斜坡起点取自 currentVolume，'
        + '账本与实际值脱节则下一次斜坡的第一拍又是一次跳变（第 41 轮缺陷②）')
    }
    if (body.includes('pauseSeq++')) {
      reasons.push('syncVolumeFadeState 动了 pauseSeq：掐斜坡 ≠ 取消暂停 —— `stopRamp` 会放行'
        + '斜坡的 Promise，等在那一行的 fadeOutThenPause 应照常走完并落地真暂停'
        + '（用户的意图是「音量听我的」，不是「别暂停了」）')
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
// 九（第 51 轮 + 第 63 轮第 2 条）：斜坡的时长与曲线 —— 「渐入渐出」要真的听得出来，且可配
// ---------------------------------------------------------------------------
const fadeShapeInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)

  // ---- 第 51 轮的底线（第 63 轮不撤）：档距与「听得出来」的量级 ----
  if (!code.includes('const FADE_STEP_MS = 20')) {
    reasons.push('找不到 FADE_STEP_MS = 20（斜坡档距）：档距一变大，台阶感（zipper 噪声）就回来了')
  }

  // ---- 第 63 轮第 2 条：时长改由设置项提供，两个兜底常量 = 需求点名的默认值 ----
  // 用户原话：「默认时长：渐入 2 秒，渐出 3 秒（可在播放设置中配置，位置在将播放的中文歌词
  // 转换为繁体选项下面，调节范围为 0-3 秒）」。这两个常量退化为**兜底值**（键缺省 / 脏值时用），
  // 真正参与运算的是 fadeInMs() / fadeOutMs()。
  const fallbackIn = /const FADE_IN_FALLBACK_MS = ([\d_]+)/.exec(code)
  if (fallbackIn == null) {
    reasons.push('找不到 FADE_IN_FALLBACK_MS（渐入的兜底时长）：设置键读不到值时必须回落到'
      + '需求点名的默认 2 秒，写成 0 会变成「默认关闭渐入」')
  } else if (Number(fallbackIn[1].replace(/_/g, '')) !== 2000) {
    reasons.push(`渐入兜底值不是 2000ms（${fallbackIn[1]}）：需求原话「默认时长：渐入 2 秒」`)
  }
  const fallbackOut = /const FADE_OUT_FALLBACK_MS = ([\d_]+)/.exec(code)
  if (fallbackOut == null) {
    reasons.push('找不到 FADE_OUT_FALLBACK_MS（渐出的兜底时长）：设置键读不到值时必须回落到'
      + '需求点名的默认 3 秒')
  } else if (Number(fallbackOut[1].replace(/_/g, '')) !== 3000) {
    reasons.push(`渐出兜底值不是 3000ms（${fallbackOut[1]}）：需求原话「默认时长：……渐出 3 秒」`)
  }
  if (!code.includes('const FADE_MAX_SECONDS = 3')) {
    reasons.push('找不到 FADE_MAX_SECONDS = 3（滑块量程上限）：需求原话「调节范围为 0-3 秒」；'
      + '上限没了，旧版本残留 / 手工改坏的超范围值会把斜坡拖成分钟级（真暂停跟在斜坡之后，'
      + '等于「按了暂停半天不停」）')
  }

  // ---- 读取器：三分支必须都在，且顺序由语义决定（0 不等于缺省，这是本条最容易写错的地方）----
  const readBody = bracedBody(code, 'const readFadeMs = (key:')
  if (readBody == null) {
    reasons.push('找不到 readFadeMs（渐入 / 渐出时长的唯一读取器）')
  } else {
    if (!readBody.includes('if (typeof seconds != \'number\' || !Number.isFinite(seconds)) return fallbackMs')) {
      reasons.push('readFadeMs 缺「缺省 / 脏值 → 兜底值」分支（非数字、NaN、Infinity 都要落回默认）')
    }
    if (!readBody.includes('if (seconds <= 0) return 0')) {
      reasons.push('readFadeMs 缺「≤ 0 → 0」分支：滑块量程 0~3 秒里的 0 是用户**明确选出来的**'
        + '「关闭渐变」，任何「把 0 当缺省」的写法都会让用户的 0 失效（第 63 轮第 2 条）')
    }
    if (!readBody.includes('return Math.min(seconds, FADE_MAX_SECONDS) * 1000')) {
      reasons.push('readFadeMs 没有把超范围的值夹到上限（缺 `Math.min(seconds, FADE_MAX_SECONDS) * 1000`）：'
        + '设置里写坏的大值会把斜坡拖成分钟级（第 63 轮第 2 条）')
    }
  }
  if (!code.includes("const fadeInMs = () => readFadeMs('player.fadeInDuration', FADE_IN_FALLBACK_MS)")) {
    reasons.push('找不到 fadeInMs（渐入时长的消费口）：它必须读 player.fadeInDuration 并带上兜底值')
  }
  if (!code.includes("const fadeOutMs = () => readFadeMs('player.fadeOutDuration', FADE_OUT_FALLBACK_MS)")) {
    reasons.push('找不到 fadeOutMs（渐出时长的消费口）：它必须读 player.fadeOutDuration 并带上兜底值')
  }
  // 时长必须是**现读**（每次调用现查设置），不是模块加载时读一次：用户在设置页改完滑块，
  // 下一次渐入 / 渐出即生效（与「与其他应用同时播放」那条设置同一口径）。
  if (/const\s+fadeInMs\s*=\s*readFadeMs\(|const\s+fadeOutMs\s*=\s*readFadeMs\(/.test(code)) {
    reasons.push('渐变时长被提前算成常量（模块加载时读一次）：用户在设置页改完滑块要重进 App 才生效')
  }

  // ---- 曲线：等功率（默认）/ 线性（可选），方向感知 ----
  // 需求原话：「缓动曲线：默认使用等功率曲线（Equal-Power），避免音量突变；可选线性（Linear）」。
  const easeBody = bracedBody(code, 'const easeVolume = (progress: number, linear: boolean, rising: boolean) => {')
  if (easeBody == null) {
    reasons.push('找不到方向感知的 easeVolume（缺 `(progress, linear, rising)` 三个参数）：'
      + '曲线要可配，且升 / 降必须走同一条曲线的两个方向（第 63 轮第 2 条）')
  } else {
    if (!easeBody.includes('if (linear) return rising ? progress : 1 - progress')) {
      reasons.push('easeVolume 缺线性分支（`if (linear) return rising ? progress : 1 - progress`）：'
        + '需求原话「可选线性（Linear）」')
    }
    if (!easeBody.includes('const radian = (Math.PI / 2) * (rising ? progress : 1 - progress)')
      || !easeBody.includes('return Math.sin(radian)')) {
      reasons.push('easeVolume 缺等功率分支（`sin(π/2 · p)` 升 / `sin(π/2 · (1-p))` 降）：'
        + '需求原话「默认使用等功率曲线（Equal-Power），避免音量突变」—— 升 / 降互为 sin / cos，'
        + '两者平方和为 1，过渡期间功率恒定')
    }
  }
  if (!code.includes('const isLinearCurve = () => settingState.setting[\'player.fadeLinearCurve\'] === true')) {
    reasons.push('找不到 isLinearCurve（曲线设置的消费口）：它必须读 player.fadeLinearCurve，'
      + '且只有严格 true 才算线性（默认等功率，与设置项的默认值一致）')
  }
  // 逐拍调用点：曲线与方向是两个入参
  if (!code.includes('from + (target - from) * easeVolume(step / steps, linear, rising)')) {
    reasons.push('斜坡没有把曲线 / 方向传进 easeVolume（缺 `easeVolume(step / steps, linear, rising)`）：'
      + '音量还是按固定的一条曲线摊开')
  }
  const rampBody = bracedBody(code, 'const rampVolume = (to: number, durationMs: number): Promise<void> => {')
  if (rampBody == null) {
    reasons.push('找不到 rampVolume（斜坡本体）')
  } else {
    // 曲线与方向在**起斜坡时快照**：拖动曲线开关不该改写在途斜坡的形状
    //（同一次过渡前后两半用两条曲线，听感上是一处折点）。
    if (!rampBody.includes('const linear = isLinearCurve()')) {
      reasons.push('斜坡没有在起坡时快照曲线（缺 `const linear = isLinearCurve()`）：每拍现读设置会让'
        + '同一次渐入前后两半用两条曲线（听感上是一处折点）')
    }
    if (!rampBody.includes('const rising = target > from')) {
      reasons.push('斜坡没有按「终点比起点大」判方向（缺 `const rising = target > from`）：'
        + '同一个调用点的当前音量在不同现场下高低不定（渐入被打断后暂停，起点就在半途），'
        + '只有从起点 / 终点现算方向才能全程单调（第 41 轮定死的「斜坡全程单调」）')
    }
    // 【第 63 轮第 2 条】0 = 关闭渐变，必须逐字回到第 39 轮之前的直写行为
    if (!rampBody.includes('if (durationMs <= 0 || Math.abs(target - from) < MIN_RAMP_DELTA) {')) {
      reasons.push('斜坡没有把「时长为 0」并入直写短路（缺 `durationMs <= 0 ||`）：用户在设置里把'
        + '渐入 / 渐出调到 0 = 关闭渐变，不许留下一个「最小档位」的斜坡（第 63 轮第 2 条）')
    } else if (!rampBody.slice(rampBody.indexOf('if (durationMs <= 0')).includes('void writeVolume(target)')) {
      reasons.push('斜坡的 0 时长分支没有直写终点音量：关闭渐变后音量会停在起点（听感上是没声音 / 音量不对）')
    }
    // 曲线快照必须在短路之后、setInterval 之前 —— 写在短路前面的话，0 时长那一支也会去读设置
    //（无害但暴露顺序漂移）；更重要的是快照一旦掉到 setInterval 里面就等于每拍现读。
    if (rampBody.indexOf('const linear = isLinearCurve()') > rampBody.indexOf('setInterval(')) {
      reasons.push('曲线 / 方向快照落在 setInterval 之后或之内：等于每拍现读设置，在途斜坡会被拖滑块的动作用两条曲线切两半')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 九之二（第 63 轮第 2 条）：三个设置键 —— 默认值、类型声明、设置页位置、文案
// ---------------------------------------------------------------------------
const fadeSettingInvariants = (deps) => {
  const reasons = []
  if (deps.defaultSetting == null || deps.types == null || deps.playerSettings == null || deps.lang == null) {
    reasons.push('fadeSettingInvariants 缺依赖（defaultSetting / types / playerSettings / lang）')
    return reasons
  }
  const def = deps.defaultSetting
  const types = deps.types
  const ui = deps.playerSettings
  const lang = deps.lang

  // 默认值 = 需求点名的两个数 + 默认等功率（false）
  if (!/['"]player\.fadeInDuration['"]:\s*2\b/.test(def)) {
    reasons.push("defaultSetting 里没有 'player.fadeInDuration': 2（需求原话「默认时长：渐入 2 秒」）")
  }
  if (!/['"]player\.fadeOutDuration['"]:\s*3\b/.test(def)) {
    reasons.push("defaultSetting 里没有 'player.fadeOutDuration': 3（需求原话「默认时长：……渐出 3 秒」）")
  }
  if (!/['"]player\.fadeLinearCurve['"]:\s*false\b/.test(def)) {
    reasons.push("defaultSetting 里没有 'player.fadeLinearCurve': false（需求原话「默认使用等功率曲线"
      + '（Equal-Power）」—— false = 等功率）')
  }
  for (const key of ['player.fadeInDuration', 'player.fadeOutDuration', 'player.fadeLinearCurve']) {
    if (!types.includes(`'${key}'`)) {
      reasons.push(`types/app_setting.d.ts 里没有声明 '${key}'：设置键没有类型，读写两侧都是 any`)
    }
  }
  // 设置页位置：需求原话「位置在将播放的中文歌词转换为繁体选项下面」
  const atS2T = ui.indexOf('<IsS2T />')
  const atIn = ui.indexOf('<FadeInDuration />')
  const atOut = ui.indexOf('<FadeOutDuration />')
  const atCurve = ui.indexOf('<IsLinearFadeCurve />')
  if (atS2T < 0) {
    reasons.push('播放设置里找不到 <IsS2T />（「将播放的中文歌词转换为繁体」——本条的位置基准）')
  } else if (atIn < 0 || atOut < 0 || atCurve < 0) {
    reasons.push('播放设置里缺渐入 / 渐出 / 曲线三个设置行之一（<FadeInDuration /> / <FadeOutDuration /> /'
      + ' <IsLinearFadeCurve />）')
  } else if (!(atS2T < atIn && atIn < atOut && atOut < atCurve)) {
    reasons.push('三个渐入渐出设置行的顺序不对：必须在「将播放的中文歌词转换为繁体」下面，'
      + '且先渐入、再渐出、最后曲线（第 63 轮第 2 条点名的位置）')
  }
  for (const key of [
    'setting_play_fade_in_duration', 'setting_play_fade_in_duration_desc',
    'setting_play_fade_out_duration', 'setting_play_fade_out_duration_desc',
    'setting_play_fade_linear_curve', 'setting_play_fade_linear_curve_desc',
  ]) {
    if (!lang.includes(`"${key}"`)) {
      reasons.push(`zh-cn.json 里没有 "${key}"：设置行会显示成裸键名`)
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 九之三（第 63 轮第 2 条）：**可中断** —— 「渐入渐出过程中若用户手动调节音量或切歌，
// 应能立即中断当前渐变并按新指令执行」（用户原话）
// ---------------------------------------------------------------------------
const interruptInvariants = (deps) => {
  const reasons = []
  if (deps.fade == null || deps.utils == null) {
    reasons.push('interruptInvariants 缺依赖（fade / utils）')
    return reasons
  }
  const fade = stripComments(deps.fade)
  const utils = stripComments(deps.utils)

  // ① 切歌 / 停止 → setStop 是唯一收口（core/player 的 handlePlay、player.stop()、
  //    错误重载都走它，见 utils.ts 里的调用点注释）。
  const stop = slice(utils, 'export const setStop = async() => {', 'export const setLoop')
  if (stop == null) {
    reasons.push('utils.ts 里找不到 setStop（切歌 / 停止的唯一收口）')
  } else {
    if (!stop.includes('cancelPendingFadeOut()')) {
      reasons.push('setStop 没有作废在途的渐出（缺 `cancelPendingFadeOut()`）：渐出默认 3 秒，'
        + '「渐出跑完就真暂停」这条尾巴会跨过一次切歌 —— setStop 已经停了旧引擎、新歌的引擎随后'
        + '起来，而那条在途斜坡到点照样执行暂停动作，把**刚起的新歌**按停（第 63 轮第 2 条'
        + '「切歌应立即中断当前渐变」）')
    }
    // 位置：必须在平台分支**之前**（nativeFlac 与 RNTP 两条路都要作废；放到某个分支里，
    // 另一条路就漏了）。
    if (!stop.includes('cancelPendingFadeOut()\n  if (Platform.OS == \'ios\' && isNativeFlacActive()) {')) {
      reasons.push('setStop 里的 cancelPendingFadeOut() 不在平台分支之前：它只覆盖了其中一台引擎的路径，'
        + '另一条路上的在途渐出照样会把新歌按停')
    }
    if (!stop.includes('pauseVerifyToken++')) {
      reasons.push('setStop 没有作废在途的暂停复核（缺 `pauseVerifyToken++`）：一次「按下暂停 → 立刻切歌」'
        + '的次序里，那条 700ms 复核会排在**新歌起播之后**并把新歌按停（第 63 轮第 2 条）')
    }
    if (stop.includes('cancelPendingFadeOut()') && stop.indexOf('cancelPendingFadeOut()') > stop.indexOf('await TrackPlayer.stop()')) {
      reasons.push('cancelPendingFadeOut() 落在真正停引擎之后：等到那时新歌的起播路径可能已经把渐入立起来了，'
        + '作废变成了「把新歌的渐入一起掐掉」')
    }
  }

  // ② 作废函数本体：掐斜坡 + 作废真暂停，但要**留账本**（停在哪里就从哪里继续，
  //    否则新歌的渐入会从旧账本起坡 = 一次跳变），且不碰 fadeInArmed（新歌的起播渐入
  //    由 resourceLoader 的 armVolumeStartFadeIn 另行立预约）。
  const cancelAt = fade.indexOf('export const cancelPendingFadeOut = () => {')
  if (cancelAt < 0) {
    reasons.push('volumeFade.ts 里找不到 cancelPendingFadeOut（切歌 / 停止作废在途渐出的唯一出口）')
  } else {
    const body = bracedBody(fade, 'export const cancelPendingFadeOut = () => {')
    if (body == null) {
      reasons.push('cancelPendingFadeOut 的函数体解析失败（花括号不配平）')
    } else {
      if (!body.includes('pauseSeq++')) {
        reasons.push('cancelPendingFadeOut 没有作废在途的真暂停（缺 `pauseSeq++`）：斜坡虽然被掐了，'
          + '那条 fadeOutThenPause 仍会在有界等待放行后执行暂停动作，把新歌按停')
      }
      if (!body.includes('stopRamp()')) {
        reasons.push('cancelPendingFadeOut 没有掐掉在途斜坡（缺 `stopRamp()`）：斜坡每一拍都按'
          + '`isNativeFlacActive()` 现查当前驱动，切歌之后查到的可能是**新歌的引擎**，'
          + '那几拍降音会直接写在新歌上，与它自己的渐入对顶')
      }
      if (body.includes('fadeInArmed = false')) {
        reasons.push('cancelPendingFadeOut 碰了 fadeInArmed：新歌的起播渐入由 resourceLoader 的'
          + 'armVolumeStartFadeIn 另行立预约，在这里清掉等于把新歌的渐入一起作废')
      }
      if (body.includes('currentVolume =')) {
        reasons.push('cancelPendingFadeOut 改了账本：账本要停在当前值（停在哪里就从哪里继续），'
          + '改掉会让新歌的渐入从错的起点起坡 = 一次跳变')
      }
      if (!body.includes("if (Platform.OS != 'ios') return")) {
        reasons.push("cancelPendingFadeOut 非 iOS 平台没有直接返回（其余平台不跑斜坡，这里的调用是空转）")
      }
    }
  }

  // ③ 手动调音量那条路（音量条 → utils.setVolume → syncVolumeFadeState）的「掐斜坡」
  //    已经在上面的 volumeLedgerInvariants 里钉住，这里只补一句「不许顺手把暂停也取消掉」。
  const syncBody = bracedBody(fade, 'export const syncVolumeFadeState = (volume: number) => {')
  if (syncBody != null && !syncBody.includes('stopRamp()')) {
    reasons.push('syncVolumeFadeState 没有掐掉在途斜坡：手动调音量的指令压不住正在跑的渐变（第 63 轮第 2 条）')
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
      // 【第 62 轮第 3 条】复核的门控从「还要看 isPlay」换成「只看令牌」：UI 按下即翻之后
      // isPlay 恒为 false，旧写法会让第 47 轮这条兜底永远早退（「点了暂停声音还在放」没了防线）；
      // 而「复核窗口内又按了播放」这条竞态由令牌挡住（setPlay 的 pauseVerifyToken++）。
      if (!setPause.includes('if (token != pauseVerifyToken) return')) {
        reasons.push('setPause 的复核没有令牌门控（复核窗口内又按下的播放会被 700ms 后的复核按停）')
      }
      if (setPause.includes('!playerState.isPlay) return') && setPause.includes('token != pauseVerifyToken')) {
        reasons.push('setPause 的复核又读回 playerState.isPlay：UI 按下即翻后它恒为 false，兜底永远早退')
      }
      // 【第 62 轮第 3 条】「按下即翻」：锁屏 / 灵动岛 / 迷你播放器三处的暂停图标不许挂在
      // 300ms 渐出之后（旧链路要等斜坡跑完、引擎发出 'paused' 才由 app_event 翻面）。
      if (!/if \(playerState\.isPlay\) \{\n    setIsPlay\(false\)\n    void pauseNowPlaying/.test(setPause)) {
        reasons.push('setPause 没有按下即翻（pauseNowPlaying）：锁屏 / 灵动岛 / 迷你播放器的暂停图标要等渐出跑完 + 一次事件往返才变')
      } else if (setPause.indexOf('setIsPlay(false)') > setPause.indexOf('fadeOutThenPause(pausePlayingEngines)')) {
        // 比较的是**第一处** fadeOutThenPause（非 iOS 那条早退，第 303 行）：翻转块一旦被挪到
        // 它后面，就说明翻面又排到了渐出之后。
        reasons.push('setPause 的按下即翻落在渐出之后：图标仍要等渐出跑完')
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
  // 【第 63 轮第 2 条】三个设置键的落点（默认值 / 类型 / 设置页位置 / 文案）
  const settingDeps = {
    defaultSetting: REAL.defaultSetting, types: REAL.types,
    playerSettings: REAL.playerSettings, lang: REAL.lang,
  }

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
  // 【第 63 轮第 2 条】锚点里的 FADE_OUT_MS 换成 duration（时长改由设置项读取）
  check('v4 拆掉有界等待直接 await 斜坡', pauseNeverBlockedInvariants(
    tamper(fade,
      'await settleWithin(rampVolume(0, duration), duration + FADE_STEP_MS * 2)',
      'await rampVolume(0, duration)'),
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
    tamper(fade, '    }, timeoutMs)', '    }, 0)'),
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
  // 锚点只用**两行连续代码**：第 62 轮在复核体里插了注释，把注释一起写进锚点会一改就漂。
  // 摘掉 `void pausePlayingEngines()` = 复核还在、但不再补刀。
  check('v14 拆掉暂停复核', chainInvariants({
    ...chainDeps,
    utils: tamper(REAL.utils,
      '    if (token != pauseVerifyToken) return\n    void pausePlayingEngines()\n',
      '    if (token != pauseVerifyToken) return\n'),
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

  // 【第 63 轮第 2 条】v18 渐入的**兜底默认值**被改短（设置键读不到值时的兜底必须就是
  //     需求点名的 2 秒；改成 220ms 等于「默认只够消爆音，听不出渐入」）
  check('v18 渐入默认时长被改短', fadeShapeInvariants(
    tamper(fade, 'const FADE_IN_FALLBACK_MS = 2_000', 'const FADE_IN_FALLBACK_MS = 220'),
  ), '渐入兜底值不是 2000ms')

  // 【第 63 轮第 2 条】v19 渐出的兜底默认值被改短（需求原话「默认时长：……渐出 3 秒」）
  check('v19 渐出默认时长被改短', fadeShapeInvariants(
    tamper(fade, 'const FADE_OUT_FALLBACK_MS = 3_000', 'const FADE_OUT_FALLBACK_MS = 160'),
  ), '渐出兜底值不是 3000ms')

  // 【第 63 轮第 2 条】v31 滑块量程上限被拿掉（超范围值不再夹）：旧版本残留 / 手工改坏的
  //     大值会把斜坡拖成分钟级 —— 真暂停跟在斜坡之后，等于「按了暂停半天不停」
  check('v31 量程上限被拿掉', fadeShapeInvariants(
    tamper(fade, 'const FADE_MAX_SECONDS = 3', 'const FADE_MAX_SECONDS = 999'),
  ), 'FADE_MAX_SECONDS')

  // 【第 63 轮第 2 条】v20 曲线开关被架空：调用点不再把曲线 / 方向传进去（音量还是按固定
  //     的一条曲线摊开，设置里的「线性」勾了没用）
  check('v20 曲线开关被架空', fadeShapeInvariants(
    tamper(fade, 'from + (target - from) * easeVolume(step / steps, linear, rising)',
      'from + (target - from) * (step / steps)'),
  ), '没有把曲线')

  // 【第 63 轮第 2 条】v40 等功率分支被摘掉（只剩线性 —— 需求点名的默认曲线没了）
  check('v40 等功率分支被摘掉', fadeShapeInvariants(
    tamper(fade, 'const radian = (Math.PI / 2) * (rising ? progress : 1 - progress)',
      'const radian = progress'),
  ), '等功率分支')

  // 【第 63 轮第 2 条】v41 readFadeMs 缺「≤ 0 → 0」分支（用户的 0 被当成缺省 ⇒ 关不掉渐变）
  check('v41 0 被当成缺省', fadeShapeInvariants(
    tamper(fade, '  if (seconds <= 0) return 0\n', ''),
  ), '≤ 0 → 0')

  // 【第 63 轮第 2 条】v42 超范围的值不再夹到上限
  check('v42 超范围不夹上限', fadeShapeInvariants(
    tamper(fade, 'return Math.min(seconds, FADE_MAX_SECONDS) * 1000', 'return seconds * 1000'),
  ), '夹到上限')

  // 【第 63 轮第 2 条】v43 斜坡不再把「时长为 0」并入直写短路（关闭渐变后音量停在起点）
  check('v43 0 时长不短路', fadeShapeInvariants(
    tamper(fade, 'if (durationMs <= 0 || Math.abs(target - from) < MIN_RAMP_DELTA) {',
      'if (Math.abs(target - from) < MIN_RAMP_DELTA) {'),
  ), '时长为 0')

  // 【第 63 轮第 2 条】v44 曲线不在起坡时快照（改成每拍现读 / 写死）
  check('v44 曲线不快照', fadeShapeInvariants(
    tamper(fade, 'const linear = isLinearCurve()', 'const linear = false'),
  ), '快照曲线')

  // 【第 63 轮第 2 条】v45 方向判据被写死（rising 恒 true ⇒ 渐出变成渐入，音量反向跳）
  check('v45 方向判据被写死', fadeShapeInvariants(
    tamper(fade, 'const rising = target > from', 'const rising = true'),
  ), '判方向')

  // 【第 63 轮第 2 条】v46 手动调音量又变成「让行」（第 41 轮的口径反转被改回去：
  //     用户在 3 秒的渐出里拖音量条，下一秒被斜坡按回 0 ——「拖了没用，声音照样掉下去」）
  check('v46 手动音量又让行', volumeLedgerInvariants(
    tamper(fade, "  if (typeof volume != 'number' || !Number.isFinite(volume)) return\n",
      "  if (fadeTimer != null || fadingOut) return\n  if (typeof volume != 'number' || !Number.isFinite(volume)) return\n"),
    deps,
  ), '又回到')

  // 【第 63 轮第 2 条】v47 setStop 不再作废在途的渐出（「渐出跑完就真暂停」跨过一次切歌，
  //     把刚起的新歌按停）
  check('v47 切歌不作废在途渐出', interruptInvariants({
    fade: REAL.fade,
    utils: tamper(REAL.utils, '  cancelPendingFadeOut()\n', ''),
  }), '没有作废在途的渐出')

  // 【第 63 轮第 2 条】v48 setStop 不作废在途的暂停复核（「按下暂停 → 立刻切歌」的次序里，
  //     那条 700ms 复核会落在新歌起播之后并把新歌按停）
  check('v48 切歌不作废暂停复核', interruptInvariants({
    fade: REAL.fade,
    utils: tamper(REAL.utils, '  pauseVerifyToken++\n  cancelPendingFadeOut()\n', '  cancelPendingFadeOut()\n'),
  }), '暂停复核')

  // 【第 63 轮第 2 条】v49 cancelPendingFadeOut 碰了账本（新歌的渐入从错的起点起坡 = 一次跳变）
  check('v49 作废时改了账本', interruptInvariants({
    fade: tamper(fade, '  pauseSeq++\n  stopRamp()\n', '  pauseSeq++\n  stopRamp()\n  currentVolume = 0\n'),
    utils: REAL.utils,
  }), '改了账本')

  // 【第 63 轮第 2 条】v50 两个渐入渐出设置行的位置违约（插到「将播放的中文歌词转换为繁体」上面）
  check('v50 设置行位置违约', fadeSettingInvariants({
    ...settingDeps,
    playerSettings: tamper(REAL.playerSettings, '      <IsS2T />\n',
      '      <FadeInDuration />\n      <IsS2T />\n'),
  }), '顺序不对')

  // 【第 63 轮第 2 条】v51 默认值被改（渐出默认不再是需求点名的 3 秒）
  check('v51 默认渐出时长被改', fadeSettingInvariants({
    ...settingDeps,
    defaultSetting: tamper(REAL.defaultSetting, "'player.fadeOutDuration': 3,", "'player.fadeOutDuration': 5,"),
  }), 'player.fadeOutDuration')

  // 【第 63 轮第 2 条】v52 默认曲线被改成线性（需求指定默认等功率）
  check('v52 默认曲线被改成线性', fadeSettingInvariants({
    ...settingDeps,
    defaultSetting: tamper(REAL.defaultSetting, "'player.fadeLinearCurve': false,", "'player.fadeLinearCurve': true,"),
  }), 'player.fadeLinearCurve')

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
  // 【第 63 轮第 2 条】锚点里的 FADE_IN_MS 跟着换成 fadeInMs()。仍要带上下文：
  // beginFadeInArm 的 'playing' 分支也有一句同形状的 `void rampVolume(targetVolume(), fadeInMs())`
  //（缩进 10 格）—— 只按裸行匹配会先命中那一句，篡改打不到渐出途中的掉头分支（反例就假绿了）。
  // 锚到「该行 + 紧邻的 return true」。
  check('v26 渐出途中不拉回音量', fadeInGuardInvariants(
    tamper(fade, '    void rampVolume(targetVolume(), fadeInMs())\n    return true\n', '    return true\n'),
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

  // 【第 61 轮第 4 条】v32 到点复核不再按「加载中」续期：自动续播还在 loading / buffering
  // 时预约先落地，紧随的 'playing' 被 MIN_RAMP_DELTA 短路成一记满音量（「自动播放没有
  // 渐出效果」的原现场）
  check('v32 到点复核不再续期', fadeInGuardInvariants(
    tamper(fade, "        if ((state == 'loading' || state == 'buffering') && armRenewals < ARM_RENEW_LIMIT) {", '        if (false) {'),
  ), '不再按「加载中」续期')

  // 【第 61 轮第 4 条】v33 到点探到 'playing' 不补渐入（直接写设定音量 = 一记满音量直写）
  check('v33 到点复核不补渐入', fadeInGuardInvariants(
    tamper(fade, "        if (state == 'playing') {\n", '        if (false) {\n'),
  ), '没有补一次渐入斜坡')

  // 【第 61 轮第 4 条】v34 探针回来不认代际（探针在途、用户又按播放：新预约被上一代的结果写回设定音量）
  check('v34 探针回来不认代际', fadeInGuardInvariants(
    tamper(fade, '        if (generation != armGeneration) return\n', ''),
  ), '不认代际')

  // 【第 61 轮第 4 条】v35 探针不探原生流式引擎（无损档缓冲被当成「其余」⇒ 预约白等）
  check('v35 探针不探原生流式引擎', fadeInGuardInvariants(
    tamper(fade, '    if (isNativeFlacActive()) return await getNativeFlacState()\n', ''),
  ), '不探原生流式引擎')

  // 【第 61 轮第 4 条】v36 续期上限被拿掉（无限续期 = 预约永远不落地，「绝不留没声」失守）
  check('v36 续期上限被拿掉', fadeInGuardInvariants(
    tamper(fade, 'const ARM_RENEW_LIMIT = 3', 'const ARM_RENEW_LIMIT = 99'),
  ), 'ARM_RENEW_LIMIT')

  // 【第 62 轮第 3 条】v37 复核又读回 isPlay（UI 按下即翻后它恒为 false ⇒ 兜底永远早退）
  check('v37 复核又读回 isPlay', chainInvariants({
    ...chainDeps,
    utils: tamper(REAL.utils,
      '    if (token != pauseVerifyToken) return\n',
      '    if (token != pauseVerifyToken || !playerState.isPlay) return\n'),
  }), '又读回 playerState.isPlay')

  // 【第 62 轮第 3 条】v38 暂停的「按下即翻」被摘掉（图标又回去等 300ms 渐出 + 事件往返）
  check('v38 摘掉暂停按下即翻', chainInvariants({
    ...chainDeps,
    utils: tamper(REAL.utils,
      '  if (playerState.isPlay) {\n    setIsPlay(false)\n    void pauseNowPlaying({ playbackRate: 0 }).catch(() => {})\n  }\n',
      ''),
  }), '按下即翻')

  // 【第 62 轮第 3 条】v39 按下即翻挪到渐出之后（翻面仍在，但排在 300ms 斜坡后面 —— 用户投诉原样）
  check('v39 按下即翻挪到渐出之后', chainInvariants({
    ...chainDeps,
    utils: tamper(REAL.utils,
      '  if (playerState.isPlay) {\n    setIsPlay(false)\n    void pauseNowPlaying({ playbackRate: 0 }).catch(() => {})\n  }\n  if (Platform.OS != \'ios\') return fadeOutThenPause(pausePlayingEngines)',
      '  if (Platform.OS != \'ios\') return fadeOutThenPause(pausePlayingEngines)\n  if (playerState.isPlay) {\n    setIsPlay(false)\n    void pauseNowPlaying({ playbackRate: 0 }).catch(() => {})\n  }'),
  }), '落在渐出之后')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-remote-command-volume-fade ===')
console.log('锁屏 / 灵动岛按键不许被音量斜坡吞掉：斜坡取消必放行 + 暂停无条件执行 + 渐出期间让行'
  + ' + 重复 playing 不打断 + 渐入有兜底期限 + 音量账本同步（第 41 轮）')
console.log('播放 / 暂停的渐入渐出要真的听得见：斜坡够长 + 起播也渐入'
  + '（含引擎起始增益）+ 在途渐入不被外部直写顶掉 + 渐出途中用户按 ▶ 赢（第 51 轮）')
console.log('渐出时长回滚 700 → 300（听得见但不拖界面）+ 预约到点先探引擎状态再落地'
  + '（续期 ≤ ARM_RENEW_LIMIT / playing 补渐入 / 代际守卫）（第 61 轮第 1、4 条）')
console.log('时长 / 曲线可配（默认 2s / 3s + 等功率，0~3 秒，位置在「将播放的中文歌词转换为繁体」'
  + '下面）+ 可中断（手动音量掐斜坡、切歌作废在途渐出）（第 63 轮第 2 条）')
console.log()

const checks = [
  ['斜坡取消必须放行 Promise（clearInterval 唯一出口，取消/完成共用 stopRamp）', () => rampCancelInvariants(REAL.fade)],
  ['锁屏暂停绝不依赖斜坡（有界等待 + 无条件执行真暂停 + 起点取当前实际音量）', () => pauseNeverBlockedInvariants(REAL.fade)],
  ['渐入预约统一体（恢复 / 起播两个入口）：渐出途中让位于用户的 ▶ + 预约有兜底期限'
    + ' + 预约时两台引擎一起压 0 + 到点先探引擎状态（第 61 轮第 4 条：续期 ≤ ARM_RENEW_LIMIT /'
    + ' \'playing\' 补渐入 / 代际守卫）', () => fadeInGuardInvariants(REAL.fade)],
  ['音量账本：斜坡起点取 currentVolume，三处外部直写都同步（音量条 / 换曲重贴 / 打断恢复）'
    + '；在途渐入期间自动重贴让行、手动调音量则掐斜坡（第 63 轮第 2 条口径反转）',
    () => volumeLedgerInvariants(REAL.fade, { utils: REAL.utils, core: REAL.core, service: REAL.service })],
  ['第 51 / 63 轮·斜坡时长与曲线：可配（0 = 关闭、缺省 = 默认 2s/3s、超范围夹到 3s）'
    + ' + 等功率（默认）/ 线性可选 + 方向感知 + 曲线与方向起坡快照 + 档距 20ms',
    () => fadeShapeInvariants(REAL.fade)],
  ['第 63 轮第 2 条·三个设置键（默认 2s / 3s / 等功率）在 defaultSetting + 类型声明'
    + ' + 设置页位置（「将播放的中文歌词转换为繁体」下面，先渐入再渐出最后曲线）+ 文案',
    () => fadeSettingInvariants({
      defaultSetting: REAL.defaultSetting, types: REAL.types,
      playerSettings: REAL.playerSettings, lang: REAL.lang,
    })],
  ['第 63 轮第 2 条·可中断：切歌 / 停止（setStop 唯一收口）作废在途渐出 + 暂停复核，'
    + '手动调音量掐斜坡但不取消暂停', () => interruptInvariants({ fade: REAL.fade, utils: REAL.utils })],
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
