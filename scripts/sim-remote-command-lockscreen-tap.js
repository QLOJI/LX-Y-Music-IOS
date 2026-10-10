/**
 * sim-remote-command-lockscreen-tap.js
 *
 * 「锁屏 / 灵动岛的上一首、下一首、播放暂停必须**一次点击就生效**」契约不变量
 * （第 36 轮第 5 条，2026-10-09；本脚本第 35 轮写过一版，方向被用户复现推翻，本版重写）。
 *
 * 用户原话（第 35 轮与第 36 轮各报一次，第二次截图 51.jpg 是 iOS 锁屏界面）：
 *   「锁屏界面和灵动岛界面的上一首、下一首、播放/暂停按钮点击后无法控制，
 *     请参考 lx-music-mobile-ios-adaptation 项目，恢复按钮功能。」
 *
 * 第 35 轮的方向（**错的，已废弃**）：「有歌曲信息时六个命令一律 enabled = YES，
 * 把判据收敛成『信息在不在』」。它既不改变 iOS「只按显示出来的那个按钮投递命令」的规则，
 * 也没能修好点击无反应 —— 用户第 36 轮原样复现。
 *
 * 第 36 轮的真解（1:1 照抄参考工程 lx-music-mobile-ios-adaptation，它的按钮在本机型上好用）：
 *   **显示态与启停态同源** —— 卡片上显示什么按钮（由 MPNowPlayingInfoCenter.playbackState
 *   决定）与命令启不启用（由 MPRemoteCommandCenter.<cmd>.enabled 决定）读的是**同一个变量**
 *   LXNowPlayingState：
 *     播放中：显示 ⏸ + pauseCommand 可用 / playCommand 关；
 *     暂停·停止：显示 ▶ + playCommand 可用 / pauseCommand 关；
 *     togglePlayPauseCommand 一律 NO（参考工程如此：与 play/pause 同时启用时，
 *     iOS 17/18 对合并按钮的投递归属不确定）；上一首 / 下一首 / 拖动进度一律 YES。
 *   只要两端同源，就永远不会出现「按钮在、点了不投递」。
 *
 * 配套（第 36 轮；原配套 ②「1s 重申可用性的看门狗」已在第 43 轮整条删除，理由见下）：
 *   ① **一处都不许再说谎**：全文件只允许一处 `center.playbackState = ...`，
 *      且赋的就是真实态 `LXNowPlayingState`（第 35 轮之前有两处「切到相反值再切回」的
 *      强制重绘 —— 那 60ms/150ms 窗口里显示态与启停态互相矛盾，正是「点两次才生效」的根）。
 *
 * 【第 43 轮】用户原话：「锁屏界面和灵动岛播放器界面，前几次点击播放/暂停和上一首、
 * 下一首还可以操作，用了一段时间后就不行了，而且点击一次后不能点击第二次，
 * 请一比一使用 lx-music-mobile-ios-adaptation 项目中的锁屏界面和灵动岛播放器界面
 * 代码，修复这些问题。」
 * 第 36 轮的配套 ②（1s 重申一次的 LXStartRemoteCommandWatchdog）**本轮已整条删除** ——
 * 它就是同一类症状的另一半成因：它只重写六个 `enabled`，**不**重发
 * nowPlayingInfo / playbackState，显示态一旦落在后面，它就把「卡片显示 ⏸ 而
 * pauseCommand 已被关掉」这类显示态/启停态分叉**钉死**，用户的点击随即被
 * enabled = NO 静默吞掉（= 「点击一次后不能点击第二次」）。
 * 参考工程 lx-music-mobile-ios-adaptation 没有看门狗、没有歌词时钟、也不把
 * nowPlayingInfo 置空，它的模型是「主线程 + 状态变化时写一次」—— 本轮 1:1 回到该模型：
 *   ① `LXApplyNowPlayingInfo`（唯一写 MPNowPlayingInfoCenter / 命令 enabled 的地方）带
 *      **主线程闸门**：非主线程一律 marshal 回主队列再写。用户报的「用一段时间后就不行」
 *      正是它的反面——8.3Hz 歌词时钟跑在专用串行队列上，换行时跨线程改写
 *      MPRemoteCommandCenter.enabled / MPNowPlayingInfoCenter.nowPlayingInfo，
 *      这两个对象主线程亲和，后台线程改写是未定义行为，系统的命令状态机会累积失步；
 *   ② 看门狗整条不许回来（声明 / 安装时的调用 / 定义三处都不能有）；
 *   ③ 会话拆除窗口不许回来：`nowPlayingInfo = nil` 只允许出现在 apply 的
 *      「缓存为空 → 写 nil」这一处形状里（参考工程同款），封面链路不许再置空整条信息；
 *   ④ 遥控「播放 / 合并键」按下时先抢回音频会话：本工程按用户第 16 轮第 9 条
 *      「手动暂停要卸载占用音频」会在 pause 让出会话，而参考工程的会话常驻 ——
 *      让出之后必须在这一按的瞬间夺回（不然起播链路一旦晚一步/失败，卡片就永远停在 ▶）。
 *
 * 【第 44 轮】用户原话＋现场截图：「这是锁屏卡片按钮失灵的样子，然后无论点击什么都没有用」
 * （截图里卡片显示 ▶、那个 ▶ 是**灰的**、进度冻结在 0:10、右侧 -3:16 不再走）。
 * 这张图把分叉的第三根腿钉死了：**卡片上画什么按钮只看 info 里的 PlaybackRate**
 * （0 = 没在播，进度条也按它外推），**命令启不启用只看 LXNowPlayingState**。
 * 速率历史上在三个写者之间流转（播放态发布 / 元数据发布里 JS 的 playerState.isPlay /
 * 歌词步进兜底），只要有一次元数据发布带着「JS 认为没在播」的 0 落进缓存（换歌、起播瞬间
 * 就会发生），就会出现「画着 ▶ 而 playCommand 已被关掉」的灰按钮 —— 点击被静默吞掉，
 * 而且**再也回不来**（没有任何一条链路会去纠正它）。
 *   ⑤ 因此第 44 轮在唯一写入口的**发布前**加一道归一：速率必须与 LXNowPlayingState 同源
 *      （播放中 ⇒ > 0，保留倍速；非播放 ⇒ 0），与下面的 playbackState / 命令 enabled 同刻同真。
 *
 * 【第 45 轮】用户原话（第 1 条）：「还是一样，锁屏和灵动岛界面上一首、下一首、播放/暂停
 * 按钮点击无反应，我记得最早的版本是没有这个问题的，需要修复」。第 43/44 轮已是结构性
 * 修复（唯一写入口 + 主线程闸门 + 速率归一 + 无看门狗 + 无会话拆除窗口），本轮做的是补上
 * **两条自愈路径**——外界写入者（RNTP 按 updateOptions 的 capabilities 配置原生遥控命令 /
 * 系统侧会话仲裁改写、丢弃媒体会话）仍能把卡片拉离正轨，而第 43 轮删掉 1s 看门狗、熄屏时
 * 歌词时钟又停摆之后，没有任何周期性重发去纠正分叉：
 *   ⑥ 按下即对表（不变量 F ②）：每一次被投递到本 App 的按键先 `LXApplyNowPlayingInfo();`
 *      全量重发一次（info / playbackState / 六个 enabled），再 post 通知。上一首 / 下一首在
 *      任何播放态都 enabled = YES，所以任意一次成功投递都是一次自愈；
 *   ⑦ 锁屏那一刻对表（不变量 F ③）：willResignActive 里（有歌曲信息时）同样全量重发 ——
 *      用户面对的第一帧锁屏卡片就与命令同源。
 *   配套：LXApplyNowPlayingInfo 定义在文件后部、调用点在前部，必须有且仅有一处前置声明
 *   （不变量 F ①；缺了就是隐式声明，ARC 下编译不过）。
 *
 * 【第 46 轮】用户原话（第 1 条）：「锁屏和灵动岛界面的按钮点击后没有任何反应，进度时间没有
 * 按秒加载，而是按歌词换行才跳转，右上角的音频可视化也没有正常显示，我怀疑是因为之前做优化
 * 整体代码，去除冗余代码无用代码时，去除过头了，把主要的代码给删掉了，请分析，怎么可以解决
 * 这个问题，确保锁屏和灵动岛界面的所有功能正常刷新显示，按钮，音频可视化，歌词，进度条等，
 * 按照每秒刷新」。
 *   「按歌词换行才跳转」不是「代码被删多了」，而是本文件 LXNowPlayingLyricStep 的既有机制：
 *   卡片进度读 info 里的 ElapsedPlaybackTime + PlaybackRate，而这一对**只在歌词换行时**才被
 *   写回并重发（4Hz 位置事件只在前台发；熄屏时时钟还被 LXIsScreenTrustedOff 停掉）；没有歌词
 *   的歌更是一整首都不动（`LXNowPlayingLyricLines.count == 0` 早退，走不到换行那一段）。
 *   本轮补 ⑧（不变量 G）：沿用既有 0.12s 时钟、按 ~1Hz 节流（9 拍 ≈1.08s，不新建定时器、
 *   不新增唤醒源），把外推位置写回缓存 + 走唯一写入口全量重发，位置与快照戳成对更新；
 *   只在「真在播放」且「没有外推冻结」时跳（ClockHold 期间位置冻结，每秒写回冻结值会让
 *   进度条每秒往回跳一格）。
 *   注意与第 43 轮删掉的「1s 可用性看门狗」的区别：那条只重写六个 enabled、不重发
 *   info / playbackState，会把显示态/启停态的分叉钉死（不变量 C ④ 仍然禁用它）；本心跳写的是
 *   外推位置、走唯一写入口，显示层与启停层在同一次主线程写入里一起对齐。
 *
 * 反例专盯「回归 tsc / eslint 都无感」的部分：原生不参与 TS 检查，把判据改回按播放态单算、
 * 漏一句 beginReceivingRemoteControlEvents、把主线程闸门删掉、让看门狗回来、
 * 或又把 playbackState 翻转加回来，静态检查与单测全都看不见。
 *
 * 运行：node scripts/sim-remote-command-lockscreen-tap.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const APP_DELEGATE = 'ios/LxMusicMobile/AppDelegate.mm'
const REMOTE_COMMAND = 'src/core/init/player/remoteCommand.ts'

const REAL_APPDELEGATE = read(APP_DELEGATE)
const REAL_REMOTE = read(REMOTE_COMMAND)

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 取 from 之后、下一个 to 之前的片段（锚点漂移返回 null，由调用方报 FAIL） */
const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  const end = src.indexOf(to, start + from.length)
  if (end <= start) return null
  return src.slice(start, end)
}

/** 从源码抽出「以 signature 开头、后接大括号体」的函数体（按大括号配平）。
 *
 * 注意：AppDelegate.mm 顶部有成批的**前置声明**（`static void F(void);`），它们与定义
 * 签名一字不差 —— 只取 indexOf 的第一处会锚到声明上，再往后找的 `{` 就落进别的函数，
 * 断言随即看到一份「没有 playbackState 的函数体」。所以按序扫描所有出现，
 * 取「后面紧跟 `{`」的那一处（= 定义）。
 */
const extractBracedBody = (src, signature) => {
  let start = src.indexOf(signature)
  while (start >= 0) {
    const after = src.slice(start + signature.length)
    if (/^\s*\{/.test(after)) {
      const braceStart = start + signature.length + after.indexOf('{')
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
    start = src.indexOf(signature, start + 1)
  }
  return null
}

// 六个命令：控制中心那一个合并按钮对应 togglePlayPauseCommand，
// 其余五个是锁屏 / 灵动岛 / 车机 / 耳机的实体键语义。
const COMMANDS = [
  'playCommand',
  'pauseCommand',
  'togglePlayPauseCommand',
  'nextTrackCommand',
  'previousTrackCommand',
  'changePlaybackPositionCommand',
]

// ---------------------------------------------------------------------------
// 不变量 A：命令启停与参考工程 1:1（显示态 / 启停态同源）
// ---------------------------------------------------------------------------

const availabilityInvariants = (raw) => {
  const reasons = []
  const body = extractBracedBody(raw, 'static void LXSyncRemoteCommandAvailability(void)')
  if (!body) {
    reasons.push('LXSyncRemoteCommandAvailability 缺失或抽取失败（锚点漂移）')
    return reasons
  }
  const code = stripComments(body)

  // ① 判据必须是「缓存里有没有歌曲信息」
  if (!code.includes('BOOL hasInfo = LXNowPlayingInfoCache.count > 0;')) {
    reasons.push('启停判据不再是「有没有歌曲信息」（LXNowPlayingInfoCache.count > 0 缺失 —— 空信息时会留着可点却没歌可播的按钮）')
  }

  // ② 参考工程公式：isPlaying 取自 LXNowPlayingState（与卡片显示态同一个变量）
  if (!code.includes('BOOL isPlaying = LXNowPlayingState == MPNowPlayingPlaybackStatePlaying;')) {
    reasons.push('启停判据不再是「显示态同源」公式（缺 `BOOL isPlaying = LXNowPlayingState == MPNowPlayingPlaybackStatePlaying;` —— 显示态与启停态一旦不同源，iOS 对 enabled = NO 的命令不投递，点击会被静默吞掉）')
  }
  if (!code.includes('commandCenter.playCommand.enabled = !isPlaying;')) {
    reasons.push('playCommand 不再按「同源判据取反」启用（`commandCenter.playCommand.enabled = !isPlaying;` 缺失 —— 播放中显示 ⏸ 却启用播放键，等于按钮点亮了不干活）')
  }
  if (!code.includes('commandCenter.pauseCommand.enabled = isPlaying;')) {
    reasons.push('pauseCommand 不再按「同源判据」启用（`commandCenter.pauseCommand.enabled = isPlaying;` 缺失）')
  }
  // 合并按钮必须与参考工程一致：一律 NO（与 play/pause 同时启用时 iOS 投递归属不确定）
  if (!code.includes('  commandCenter.togglePlayPauseCommand.enabled = NO;\n  commandCenter.nextTrackCommand.enabled = YES;')) {
    reasons.push('togglePlayPauseCommand 不再与参考工程一致地置 NO（2 空格缩进的信息分支里 `= NO;` 后紧跟 nextTrackCommand = YES; 这组顺序被改动 —— 合并按钮与 play/pause 同时启用时，iOS 17/18 的投递归属不确定）')
  }
  // 第 35 轮的错方向不许回来：真分支里 play/pause 不许再写成一律 YES
  if (code.includes('commandCenter.playCommand.enabled = YES;')) {
    reasons.push('playCommand 又写成一律 YES（第 35 轮「六个一律 YES」的错方向，已被用户复现推翻 —— 显示态与启停态必须同源）')
  }
  if (code.includes('commandCenter.pauseCommand.enabled = YES;')) {
    reasons.push('pauseCommand 又写成一律 YES（第 35 轮的错方向）')
  }
  // 与播放态无关的三个命令：一律 YES
  for (const c of ['nextTrackCommand', 'previousTrackCommand', 'changePlaybackPositionCommand']) {
    if (!code.includes(`commandCenter.${c}.enabled = YES;`)) {
      reasons.push(`有歌曲信息时 ${c} 未被启用（enabled = YES 缺失 —— 对应按键会「点了没反应」）`)
    }
  }
  // ③ 没信息：六个命令一律停用（没歌可播时不留可点的空按钮）
  for (const c of COMMANDS) {
    if (!code.includes(`commandCenter.${c}.enabled = NO;`)) {
      reasons.push(`无歌曲信息时 ${c} 未停用（enabled = NO 缺失）`)
    }
  }

  // ④ 遥控事件接收的开关要跟着信息走（begin 在信息分支、end 在空分支）
  if (!code.includes('LXBeginReceivingRemoteControlEvents();')) {
    reasons.push('有信息时未开始接收遥控事件（beginReceivingRemoteControlEvents 缺失 —— 锁屏/耳机按键不会送过来）')
  }
  if (!code.includes('LXEndReceivingRemoteControlEvents();')) {
    reasons.push('无信息时未停止接收遥控事件（endReceivingRemoteControlEvents 缺失）')
  }

  // ⑤ 顺序：先装 target 再改 enabled（反过来的话第一次同步会作用在没装 target 的 commands 上）
  const iInstall = code.indexOf('LXInstallRemoteCommandHandlers();')
  const iYes = code.indexOf('.enabled = YES;')
  if (iInstall < 0 || iYes < 0 || iInstall > iYes) {
    reasons.push('安装 target 必须在改 enabled 之前（LXInstallRemoteCommandHandlers 缺失或顺序被换）')
  }
  // ⑥ 空信息分支必须早于启用分支（否则「没歌」也会走到启用）
  const iNo = code.indexOf('.enabled = NO;')
  if (iNo < 0 || iYes < 0 || iNo > iYes) {
    reasons.push('「无信息 → 全部停用」分支必须在「有信息 → 启用」之前（改成先启用会让空信息也留着可点按钮）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：全文件只允许一处 playbackState 赋值，且赋真实态（「同源」的前提）
// ---------------------------------------------------------------------------

const singleSourceInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ① 唯一性：全文件只允许一处 `center.playbackState = ...`
  const assignments = code.match(/center\.playbackState\s*=/g) || []
  if (assignments.length !== 1) {
    reasons.push(`center.playbackState 赋值出现 ${assignments.length} 处（只允许一处，且只能在 LXApplyNowPlayingInfo 里写真实态 —— 多出来的每一处都是「切到相反值再切回」的说谎窗口：那段时间显示态与启停态互相矛盾，点击被 enabled = NO 静默吞掉）`)
  }
  // ② 赋的值必须是真实播放态
  if (!code.includes('center.playbackState = LXNowPlayingState;')) {
    reasons.push('playbackState 赋的不是真实播放态（`center.playbackState = LXNowPlayingState;` 缺失 —— 卡片显示态必须与命令启停态同源，不许写任何别的值）')
  }
  // ③ 那句唯一赋值必须在 LXApplyNowPlayingInfo 里
  const apply = extractBracedBody(raw, 'static void LXApplyNowPlayingInfo(void)')
  if (!apply) {
    reasons.push('LXApplyNowPlayingInfo 缺失或抽取失败（锚点漂移）')
  } else if (!stripComments(apply).includes('center.playbackState = LXNowPlayingState;')) {
    reasons.push('唯一的 playbackState 赋值不在 LXApplyNowPlayingInfo 里（重发链路必须与信息发布同源同真）')
  }
  // ④ 两处「强制重绘」（封面就绪 / 歌词换行）不许再碰 playbackState
  const repaint = extractBracedBody(raw, 'static void LXForceNowPlayingCardRepaint(void)')
  if (!repaint) {
    reasons.push('LXForceNowPlayingCardRepaint 缺失或抽取失败（锚点漂移）')
  } else {
    if (stripComments(repaint).includes('playbackState')) {
      reasons.push('LXForceNowPlayingCardRepaint 里出现 playbackState（歌词换行重绘不许再说谎：显示态一切反，投递窗口就与真实播放态错位）')
    }
    if (!stripComments(repaint).includes('LXApplyNowPlayingInfo();')) {
      reasons.push('LXForceNowPlayingCardRepaint 不再走 LXApplyNowPlayingInfo（重发必须与信息发布同一条路）')
    }
  }
  const artwork = extractBracedBody(raw, 'static void LXApplyNowPlayingArtwork(UIImage *image, NSUInteger requestId)')
  if (!artwork) {
    reasons.push('LXApplyNowPlayingArtwork 缺失或抽取失败（锚点漂移）')
  } else if (stripComments(artwork).includes('playbackState')) {
    reasons.push('LXApplyNowPlayingArtwork 里出现 playbackState（封面就绪重绘不许再说谎 —— 第 35 轮之前的 150ms/80ms 切反窗口就是「点两次才生效」的直接成因）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：写入一律主线程 + 无看门狗 + 无会话拆除 + 播放键先抢会话
//（第 43 轮重写；本来的「1s 可用性看门狗」条款已作废，见文件头说明）
// ---------------------------------------------------------------------------

const mainThreadInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ① LXApplyNowPlayingInfo 必须带主线程闸门（非主线程 marshal 回主队列再写）
  const apply = extractBracedBody(raw, 'static void LXApplyNowPlayingInfo(void)')
  if (!apply) {
    reasons.push('LXApplyNowPlayingInfo 缺失或抽取失败（锚点漂移）')
  } else {
    const body = stripComments(apply)
    const gate = /if \(!\[NSThread isMainThread\]\) \{\s*dispatch_async\(dispatch_get_main_queue\(\), \^\{[\s\S]{0,200}?LXApplyNowPlayingInfo\(\);[\s\S]{0,80}?\}\);\s*return;\s*\}/.exec(body)
    if (gate == null) {
      reasons.push('LXApplyNowPlayingInfo 缺主线程闸门（非主线程必须先 dispatch_async 回主队列再写 MPNowPlayingInfoCenter / MPRemoteCommandCenter —— 8.3Hz 歌词时钟跑在专用串行队列上，跨线程写这两个主线程亲和的对象是未定义行为，系统遥控命令状态机会累积失步：点几次还行、播一会儿就全不灵）')
    }
    if (!body.includes('LXSyncRemoteCommandAvailability();')) {
      reasons.push('LXApplyNowPlayingInfo 不再同步命令可用性（LXSyncRemoteCommandAvailability() 缺失 —— 显示态与启停态会脱钩）')
    }
  }

  // ② 全文件只允许一处 MPNowPlayingInfoCenter 取用，且必须在 apply 里
  const centers = code.match(/\[MPNowPlayingInfoCenter/g) || []
  if (centers.length !== 1) {
    reasons.push(`MPNowPlayingInfoCenter 出现 ${centers.length} 处（只允许 LXApplyNowPlayingInfo 里那一处 —— 多出来的每一处都是绕过主线程闸门的旁路）`)
  } else if (apply && !stripComments(apply).includes('[MPNowPlayingInfoCenter defaultCenter]')) {
    reasons.push('MPNowPlayingInfoCenter 的取用不在 LXApplyNowPlayingInfo 里（写入必须收口到主线程闸门那一条路）')
  }

  // ③ 命令可用性只许被 apply 调用一次（看门狗没了 ⇒ 它天然只在主线程被调用）
  const availCalls = code.match(/LXSyncRemoteCommandAvailability\(\);/g) || []
  if (availCalls.length !== 1) {
    reasons.push(`LXSyncRemoteCommandAvailability() 被调用 ${availCalls.length} 处（只允许 LXApplyNowPlayingInfo 里那一处 —— 多出来的调用点只改 enabled 不改显示态，会把显示态/启停态的分叉钉死：卡片显示 ⏸ 而 pauseCommand 已被关掉，点击被 enabled = NO 静默吞掉）`)
  } else if (!(apply && stripComments(apply).includes('LXSyncRemoteCommandAvailability();'))) {
    reasons.push('LXSyncRemoteCommandAvailability() 的唯一调用点不在 LXApplyNowPlayingInfo 里（可用性必须与显示态同源同刻写出）')
  }

  // ④ 看门狗不许回来（声明 / 调用 / 定义任一形态都不许）
  if (/LXStartRemoteCommandWatchdog/.test(code)) {
    reasons.push('LXStartRemoteCommandWatchdog 又回来了（第 43 轮已整条删除：它只重写 enabled、不重发 nowPlayingInfo / playbackState，显示态落在后面时它把分叉钉死；参考工程没有它；另外它还是 1s 周期的后台唤醒）')
  }

  // ⑤ 会话拆除窗口不许回来
  if (/nowPlayingInfo\s*=\s*nil;/.test(code)) {
    reasons.push('出现 `nowPlayingInfo = nil;`（把整条媒体会话拆掉一瞬间：卡片消失/重现会重走 now-playing 归属仲裁，这段时间投递到本 App 的遥控命令可能丢失；而换封面发生在每次切歌 ⇒ 用一会儿按钮就全失灵。参考工程从不置空，只有 apply 里「缓存为空 → 写 nil」那一种形状）')
  }
  const infoWrites = code.match(/center\.nowPlayingInfo\s*=/g) || []
  if (infoWrites.length !== 1 || !(apply && stripComments(apply).includes('center.nowPlayingInfo ='))) {
    reasons.push(`center.nowPlayingInfo 赋值 ${infoWrites.length} 处（只允许 LXApplyNowPlayingInfo 里那一处，形状必须是「有缓存写 copy、无缓存写 nil」的三元式）`)
  }
  const artwork = extractBracedBody(raw, 'static void LXApplyNowPlayingArtwork(UIImage *image, NSUInteger requestId)')
  if (artwork && /defaultCenter/.test(stripComments(artwork))) {
    reasons.push('LXApplyNowPlayingArtwork 里又直接取用了 MPNowPlayingInfoCenter（封面链路只许走 LXApplyNowPlayingInfo 重发）')
  }

  // ⑥ 遥控「播放 / 合并键」按下时先抢回音频会话
  const handler = extractBracedBody(raw, 'static MPRemoteCommandHandlerStatus LXHandleRemoteCommandEvent(NSString *command)')
  if (!handler) {
    reasons.push('LXHandleRemoteCommandEvent 缺失或抽取失败（锚点漂移）')
  } else {
    const body = stripComments(handler)
    const gate = /isEqualToString:@"play"[\s\S]{0,120}?isEqualToString:@"toggle"/.test(body)
    if (!gate || !body.includes('LXActivateAudioSessionForRemotePlay();')) {
      reasons.push('遥控播放键按下时没有先抢回音频会话（缺 LXActivateAudioSessionForRemotePlay 调用，或 play/toggle 门控被删 —— 本工程 pause 会让出会话（用户第 16 轮第 9 条「应该是没有卸载占用音频」），参考工程会话常驻；不在这里夺回，起播晚一步/失败时卡片会永远停在 ▶，点第二次没反应）')
    }
  }
  const activate = extractBracedBody(raw, 'static void LXActivateAudioSessionForRemotePlay(void)')
  if (!activate) {
    reasons.push('LXActivateAudioSessionForRemotePlay 缺失或抽取失败（锚点漂移）')
  } else {
    const body = stripComments(activate)
    if (!body.includes('setActive:YES error:nil')) {
      reasons.push('LXActivateAudioSessionForRemotePlay 不再激活音频会话（setActive:YES 缺失）')
    }
    if (!body.includes('dispatch_get_main_queue()')) {
      reasons.push('LXActivateAudioSessionForRemotePlay 没有落到主队列（AVAudioSession 的 setActive 必须在主线程调用）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：JS 兜底 —— pause 只在「真的会暂停」时落闸，且六个命令仍有落点
// ---------------------------------------------------------------------------

const remoteInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!code.includes("import playerState from '@/store/player/state'")) {
    reasons.push('remoteCommand.ts 未引入 playerState（pause 分支判不了「这次是不是真的会暂停」）')
  }

  const pauseStart = code.indexOf("case 'pause':")
  const pauseEnd = code.indexOf("case 'toggle':")
  if (pauseStart < 0 || pauseEnd <= pauseStart) {
    reasons.push("case 'pause' 分支缺失或抽取失败（锚点漂移 —— case 'pause' / case 'toggle' 顺序被改动）")
  } else {
    const seg = code.slice(pauseStart, pauseEnd)
    if (!seg.includes('if (playerState.isPlay) markManualPause()')) {
      reasons.push('pause 分支未按「这次 pause 真的会暂停」落闸（缺前置判据：卡片重绘窗口里系统会按显示出来的状态投递反向命令，无条件落闸会把闸门白锁死）')
    }
    if (/if \(!playerState\.isPlay\) return/.test(seg)) {
      reasons.push('pause 分支在暂停态提前 return（pause() 是幂等的，提前返回只会让「暂停键」在暂停态点不动）')
    }
    if (!seg.includes('void pause()')) {
      reasons.push('pause 分支不再调 pause()')
    }
    if (!seg.includes('cancelResumePending()')) {
      reasons.push('pause 分支未作废「被抢占自动续播」标记（第 20 轮口径）')
    }
  }

  // 六个命令仍各有落点（少一个 = 锁屏/车机对应键静默失效）
  for (const cmd of ['play', 'pause', 'toggle', 'next', 'previous', 'seek']) {
    if (!code.includes(`case '${cmd}':`)) {
      reasons.push(`遥控命令覆盖不全（缺 case '${cmd}'）`)
    }
  }
  // 切歌在途去重窗口不得被顺手改动（第 20 轮契约）
  if (!code.includes('const SKIP_DEDUP_WINDOW_MS = 100')) {
    reasons.push('切歌去重窗口被改动（应为 100ms）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 E：发布前速率与播放态同源（第 44 轮）
//
// 卡片上「显示 ▶ 还是 ⏸」由 info 里的 PlaybackRate 决定（iOS 也看 playbackState 属性，
// 但字典里的 PlaybackRate 是进度外推与渲染的直接依据）；命令启不启用由 LXNowPlayingState
// 决定。这两者必须在**同一次发布**里同源，否则就是用户第 44 轮截图里的
// 「▶ 是灰的、点了一点反应都没有」——iOS 对 enabled = NO 的命令不投递。
// ---------------------------------------------------------------------------

const rateStateInvariants = (raw) => {
  const reasons = []
  const apply = extractBracedBody(raw, 'static void LXApplyNowPlayingInfo(void)')
  if (!apply) {
    reasons.push('LXApplyNowPlayingInfo 缺失或抽取失败（锚点漂移）')
    return reasons
  }
  const body = stripComments(apply)

  // ① 归一的三个要素：读缓存速率、读播放态、两个方向各写一次
  if (!body.includes('MPNowPlayingInfoPropertyPlaybackRate')) {
    reasons.push('LXApplyNowPlayingInfo 不再归一出速率（缺 MPNowPlayingInfoPropertyPlaybackRate —— 卡片显示 ▶/⏸ 与进度外推都看这条 info 里的速率，而命令 enabled 看 LXNowPlayingState：三个写者（播放态发布 / 元数据发布里 JS 的 isPlay / 歌词步进兜底）任何一个把 0 写进缓存，就会出现「画着 ▶ 而 playCommand 已关」的灰按钮，点击被静默吞掉且再也回不来）')
  }
  if (!body.includes('LXNowPlayingState == MPNowPlayingPlaybackStatePlaying')) {
    reasons.push('速率归一不再读播放态（缺 `LXNowPlayingState == MPNowPlayingPlaybackStatePlaying` —— 归一必须按 LXNowPlayingState 走，否则仍是「最后写入的那个写者」说了算，显示态与启停态可以分叉）')
  }
  if (!/= @1;/.test(body)) {
    reasons.push('播放中的速率兜底丢了（速率 0 / 缺失时必须补一个正速率，否则播放中卡片画成 ▶，而 playCommand 是关的 ⇒ 灰按钮点不动）')
  }
  if (!/= @0;/.test(body)) {
    reasons.push('非播放的速率清零丢了（非播放态带着正速率 ⇒ 卡片画出 ⏸ 而 pauseCommand 是关的，点了同样没反应）')
  }

  // ② 归一必须在发布**之前**（归一后不重新发布，系统看到的还是脏速率）
  const iRate = body.indexOf('MPNowPlayingInfoPropertyPlaybackRate')
  const iPub = body.indexOf('center.nowPlayingInfo =')
  if (iPub < 0) {
    reasons.push('找不到 center.nowPlayingInfo 发布点（锚点漂移）')
  } else if (iRate < 0 || iRate > iPub) {
    reasons.push('速率归一必须落在 center.nowPlayingInfo 发布之前（归一挪到发布之后等于没归一：系统拿到的仍是那个被写脏的速率）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 F：按下即对表 + 锁屏那一刻对表（第 45 轮）
//
// 用户原话（第 45 轮第 1 条）：「还是一样，锁屏和灵动岛界面上一首、下一首、播放/暂停
// 按钮点击无反应，我记得最早的版本是没有这个问题的，需要修复」。
//
// 第 43/44 轮已把「显示态 = 启停态」收口到唯一写入口 LXApplyNowPlayingInfo 的主线程闸门；
// 但外界仍有两个本工程控制之外的写入者能把卡片拉离正轨（RNTP 按 updateOptions 的
// capabilities 配置原生遥控命令 / 系统侧会话仲裁改写、丢弃媒体会话）。第 43 轮又按参考
// 工程删掉了 1s 可用性看门狗、熄屏时歌词时钟停摆 —— 分叉之后**没有任何周期性重发**去
// 纠正它。两条自愈路径把「对表」挂到两个必然发生的时刻：
//   ① 按下即对表：每一次被投递到本 App 的按键（play/pause/toggle/next/previous）先全量
//      重发一遍 info / playbackState / 六个 enabled，再投递通知（先纠正显示层，再让动作
//      发生）。上一首 / 下一首在任何播放态都 enabled = YES，用户点它们任意一次就能把
//      显示层与启停层拉回同源，所以任意一次成功投递都是自愈点；
//   ② 锁屏那一刻对表：willResignActive（下拉控制中心 / 锁屏）时全量重发一次 ——
//      锁屏后系统只渲染一次快照，且没有任何周期性兜底，第一帧就必须与命令同源。
// 两者都幂等、都不引入周期性开销（第 42 轮省电口径）；都不碰 seek（拖动进度条会以
// 极高频连续投递，逐条全量重发没有意义）。
// ---------------------------------------------------------------------------

const tapResyncInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ① 前置声明：LXHandleRemoteCommandEvent 的定义在文件前部，它要调用定义在更后面的
  //    LXApplyNowPlayingInfo —— 没有声明就是隐式声明（ARC 下 objc 直接编译不过）
  const decls = code.match(/static void LXApplyNowPlayingInfo\(void\);/g) || []
  if (decls.length !== 1) {
    reasons.push(`LXApplyNowPlayingInfo 的前置声明 ${decls.length} 处（应恰好一处 —— 定义在后、调用在前，缺了就是隐式声明）`)
  }
  const iDecl = code.indexOf('static void LXApplyNowPlayingInfo(void);')
  const iHandlerDef = code.indexOf('static MPRemoteCommandHandlerStatus LXHandleRemoteCommandEvent(NSString *command) {')
  if (iDecl < 0) {
    reasons.push('没有 LXApplyNowPlayingInfo 的前置声明（定义在后、调用在前：隐式声明，ARC 下编译不过）')
  } else if (iHandlerDef >= 0 && iDecl > iHandlerDef) {
    reasons.push('前置声明出现在 LXHandleRemoteCommandEvent 定义之后（声明必须先于调用点）')
  }

  // ② 按下即对表：先全量重发（纠正显示层），再投递通知（让动作发生）
  const handler = extractBracedBody(raw, 'static MPRemoteCommandHandlerStatus LXHandleRemoteCommandEvent(NSString *command)')
  if (!handler) {
    reasons.push('LXHandleRemoteCommandEvent 缺失或抽取失败（锚点漂移）')
  } else {
    const body = stripComments(handler)
    const iApply = body.indexOf('LXApplyNowPlayingInfo();')
    const iPost = body.indexOf('LXPostRemoteCommandNotification(command, nil);')
    if (iApply < 0) {
      reasons.push('遥控按键不再「按下即对表」（缺 LXApplyNowPlayingInfo() —— 分叉之后没有任何周期性重发能纠正它：'
        + '看门狗第 43 轮已删、熄屏时歌词时钟停摆，用户点下去的每一下都会被 enabled = NO 静默吞掉，'
        + '正是第 45 轮第 1 条原话「点击无反应」）')
    } else if (iPost >= 0 && iApply > iPost) {
      reasons.push('「按下即对表」落在 LXPostRemoteCommandNotification 之后（动作先生效、显示层后纠正 —— 这一拍里卡片与命令仍互相矛盾）')
    }
  }

  // ③ 锁屏那一刻对表：willResignActive 里全量重发一次（有歌曲信息时）
  const resign = extractBracedBody(raw, '- (void)handleAppWillResignActiveForLyricCard:(NSNotification *)notification')
  if (!resign) {
    reasons.push('handleAppWillResignActiveForLyricCard 缺失或抽取失败（锚点漂移）')
  } else {
    const body = stripComments(resign)
    if (!body.includes('LXNowPlayingInfoCache.count == 0')) {
      reasons.push('锁屏对表没有「无歌曲信息就跳过」的守卫（缓存为空时应直接返回 —— 没有卡片可对）')
    }
    if (!body.includes('LXApplyNowPlayingInfo();')) {
      reasons.push('锁屏 / 下拉那一刻不再对表（缺 LXApplyNowPlayingInfo() —— 锁屏后没有任何周期性重发兜底，'
        + '卡片若已分叉，用户看到的第一帧就是那个点不动的灰按钮）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 G：锁屏 / 灵动岛卡片进度「每秒对表」（第 46 轮第 1 条）
//
// 用户原话（第 46 轮第 1 条）：「锁屏和灵动岛界面的按钮点击后没有任何反应，进度时间没有按秒
// 加载，而是按歌词换行才跳转，右上角的音频可视化也没有正常显示……确保锁屏和灵动岛界面的
// 所有功能正常刷新显示，按钮，音频可视化，歌词，进度条等，按照每秒刷新」。
//
// 机制根因（第 46 轮查明）：卡片左侧已播放时间 / 右侧倒计时读的是 info 里的
// ElapsedPlaybackTime + PlaybackRate。LXNowPlayingLyricStep 此前**只在歌词换行时**才把外推
// 位置写回缓存并重发；4Hz 位置事件只在前台发；熄屏时歌词时钟还会被 LXIsScreenTrustedOff
// 停掉。于是锁屏期间进度基线只随歌词换行前进（= 用户看到的「按歌词换行才跳转」），
// 没有歌词的歌更是一整首都不动（`LXNowPlayingLyricLines.count == 0` 早退，走不到换行那一段）。
//
// 修法：沿用既有 0.12s 时钟、按 ~1Hz 节流（9 拍 ≈1.08s），把外推位置写回缓存、走唯一写入口
// 全量重发（info / playbackState / 六个 enabled 同刻同源），位置与快照戳成对更新；只在
// 「真在播放」且「没有外推冻结」时跳 —— LXNowPlayingClockHold（缓冲 / 停走）期间位置被冻结，
// 每秒把冻结值写回去会让进度条每秒往回跳一格。不新建定时器、不新增唤醒源（第 42 轮省电口径）。
//
// 与第 43 轮删掉的「1s 可用性看门狗」的区别（别混为一谈）：那条**只重写六个 enabled**、
// 不重发 info / playbackState，会把「卡片显示 ⏸ 而 pauseCommand 已被关掉」这类显示态/启停态
// 分叉**钉死**；本心跳写的是外推位置、且走唯一写入口，显示层与启停层在同一次主线程写入里
// 一起对齐 —— 只会让卡片更接近真相，钉不死任何分叉。
// ---------------------------------------------------------------------------

// 被断言的节流判据原文（下面多处复用，改一处即全改）
const HEARTBEAT_THROTTLE = 'elapsedRefreshNowMs - LXNowPlayingElapsedRefreshAtMs >= 1000.0'
// 心跳块的完整原文：反例按「整块删 / 整块搬家」篡改，这里必须与 AppDelegate.mm 逐字一致
// （不一致时 tamper 会抛「锚点未命中」= 响亮失败，不会静默假绿）。
const HEARTBEAT_BLOCK =
  '    if (!paused && !LXNowPlayingClockHold && ' + HEARTBEAT_THROTTLE + ') {\n' +
  '      LXNowPlayingElapsedRefreshAtMs = elapsedRefreshNowMs;\n' +
  '      LXNowPlayingInfoCache[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(positionMs / 1000.0);\n' +
  '      LXNowPlayingElapsedSnapshotAtMs = elapsedRefreshNowMs;\n' +
  '      LXApplyNowPlayingInfo();\n' +
  '    }\n'
// 【第 47 轮】起播空窗的播放态补齐语句原文（反例 g10 按整句删，必须与 AppDelegate.mm
// 逐字一致；不一致时 tamper 抛「锚点未命中」= 响亮失败，不会静默假绿）。
const STOPPED_PROMOTION_BLOCK =
  '      if (LXNowPlayingState == MPNowPlayingPlaybackStateStopped) {\n' +
  '        LXNowPlayingState = MPNowPlayingPlaybackStatePlaying;\n' +
  '      }\n'
// 【第 47 轮】歌词时钟 dispatch_source_set_timer 两个周期实参的**整行原文**（28 空格缩进）：
// 反例按整行篡改，保证只命中时钟、不会误伤封面重发路径里同值的 0.05s dispatch_after
// （String.replace 只换第一处 —— 锚点不唯一 = 改错行、反例假绿「未拦下」）。
// start = 首次开火时刻；interval = 重复间隔（真正决定 tick 频率的那个）。
const TIMER_START_LINE = (period) =>
  '                            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(' + period + ' * NSEC_PER_SEC)),'
const TIMER_INTERVAL_LINE = (period) =>
  '                            (uint64_t)(' + period + ' * NSEC_PER_SEC),'

const elapsedHeartbeatInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)
  const body = extractBracedBody(raw, 'static void LXNowPlayingLyricStep(void)')
  if (!body) {
    reasons.push('LXNowPlayingLyricStep 缺失或抽取失败（锚点漂移）')
    return reasons
  }
  const step = stripComments(body)

  // ① 对表时钟戳只许声明一处（多处 = 有人另起了一条刷新链路）
  const decls = code.match(/static double LXNowPlayingElapsedRefreshAtMs = 0;/g) || []
  if (decls.length !== 1) {
    reasons.push(`LXNowPlayingElapsedRefreshAtMs 声明 ${decls.length} 处（应恰好一处 —— 多出来的每一处都是绕过这条心跳的旁路）`)
  }

  // ② 节流判据：距上次对表 ≥ 1000ms（用户要的就是「按照每秒刷新」）
  if (!step.includes(HEARTBEAT_THROTTLE)) {
    reasons.push(`每秒对表的节流判据丢了（缺 \`${HEARTBEAT_THROTTLE}\` —— 闸门没了这句就会退化成 8.3Hz 每拍全量重发：用户要的「每秒」不成立，第 42 轮的省电口径也当场作废）`)
  }

  // ③ 守卫：暂停 + 外推冻结都不许跳
  const guard = 'if (!paused && !LXNowPlayingClockHold && ' + HEARTBEAT_THROTTLE + ') {'
  if (!step.includes(guard)) {
    reasons.push(`每秒对表的守卫不完整（必须是 \`${guard}\` —— 少了 !paused：暂停期间每秒重发会让卡片进度继续走；少了 !LXNowPlayingClockHold：缓冲 / 停走期间位置被冻结，每秒把冻结值写回去会让进度条每秒往回跳一格）`)
  }

  // ④ 写回的值必须是外推的「现在」
  if (!step.includes('LXNowPlayingInfoCache[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(positionMs / 1000.0);')) {
    reasons.push('每秒对表没有把外推位置写回 ElapsedPlaybackTime（卡片进度读的就是这一条 —— 不写回等于没对表）')
  }
  // ⑤ 位置与快照戳成对更新（歌词锚点读的是这一对，值推进而戳不动会把歌词时钟推超前）
  if (!step.includes('LXNowPlayingElapsedSnapshotAtMs = elapsedRefreshNowMs;')) {
    reasons.push('每秒对表只推了位置、没推快照戳（歌词锚点读的是 (ElapsedPlaybackTime, LXNowPlayingElapsedSnapshotAtMs) 这一对：值推进而戳不动，重锚时会把歌词时钟推超前）')
  }
  // ⑥ 必须走唯一写入口：歌词时钟里不许出现任何 info / 命令对象的直写
  for (const forbidden of [
    'center.nowPlayingInfo',
    'center.playbackState',
    '.enabled',
    '[MPNowPlayingInfoCenter',
    '[MPRemoteCommandCenter',
    'LXSyncRemoteCommandAvailability',
  ]) {
    if (step.includes(forbidden)) {
      reasons.push(`歌词时钟里出现了 ${forbidden}（必须走唯一写入口 LXApplyNowPlayingInfo —— 绕过主线程闸门直写 info / 命令 enabled 正是第 43 轮「用一段时间后就不行」的成因）`)
    }
  }
  // ⑦ 不新建定时器 / 延时（第 46 轮口径：复用既有 0.12s 拍，不新增唤醒源）
  if (/dispatch_source_create|NSTimer|dispatch_after/.test(step)) {
    reasons.push('歌词时钟里出现了新的定时器 / 延时（第 46 轮口径是「复用既有 0.12s 拍」——不新建唤醒源，第 42 轮省电口径）')
  }

  // ⑧ 次序：节流判据 → 写位置 → 推快照戳 → 重发（写必须在闸门里，发必须在戳之后）
  const iThrottle = step.indexOf(HEARTBEAT_THROTTLE)
  const iWrite = step.indexOf('LXNowPlayingInfoCache[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(positionMs / 1000.0);')
  const iStamp = step.indexOf('LXNowPlayingElapsedSnapshotAtMs = elapsedRefreshNowMs;')
  const iApply = iStamp >= 0 ? step.indexOf('LXApplyNowPlayingInfo();', iStamp) : -1
  if (iThrottle >= 0 && iWrite >= 0 && iWrite < iThrottle) {
    reasons.push('整条写回落在节流判据之外（每次 8.3Hz 拍都会全量重发 —— 省电口径回归）')
  }
  if (iStamp >= 0 && (iApply < 0 || iApply < iStamp)) {
    reasons.push('每秒对表没有在「位置 + 快照戳」成对更新之后走 LXApplyNowPlayingInfo 重发（只写缓存不发出去，系统看到的还是旧进度）')
  }

  // ⑨ 位置：必须在「无歌词早退」之前，也不能落进「仅前台」的位置事件分支 ——
  //    否则无歌词的歌整首不刷新 / 锁屏（非前台）时根本跑不到
  const iEarly = step.indexOf('if (LXNowPlayingLyricLines.count == 0) return;')
  if (iThrottle < 0 || iEarly < 0 || iThrottle > iEarly) {
    reasons.push('每秒对表落在「无歌词早退」之后（没有歌词的歌整首都不刷新 —— 用户报的「按歌词换行才跳转」就是这个机制；心跳必须在 `if (LXNowPlayingLyricLines.count == 0) return;` 之前）')
  }
  const iAppGate = step.indexOf('if (!paused && [UIApplication sharedApplication].applicationState == UIApplicationStateActive) {')
  if (iThrottle >= 0 && iAppGate >= 0 && iThrottle > iAppGate) {
    reasons.push('每秒对表落进了「仅前台」的位置事件分支（锁屏 / 后台时根本跑不到 —— 用户要的正是锁屏上按秒刷新）')
  }

  // ⑩ 拍长：1000ms 闸门要真的等于「约每秒」，时钟拍必须 ≤0.5s。
  //    两个实参都抓：m[1] = 首次开火时刻（dispatch_time 那行），m[2] = 重复间隔
  //    （真正决定 tick 频率的那个 —— start 只影响第一拍，间隔改大照样让换行变慢）。
  const m = /dispatch_source_set_timer\(timer,\s*\n\s*dispatch_time\(DISPATCH_TIME_NOW, \(int64_t\)\(([0-9.]+) \* NSEC_PER_SEC\)\),\s*\n\s*\(uint64_t\)\(([0-9.]+) \* NSEC_PER_SEC\),/.exec(code)
  if (m == null) {
    reasons.push('找不到歌词时钟的周期（锚点漂移：dispatch_source_set_timer 的 dispatch_time / 间隔行）')
  } else if (Number(m[1]) > 0.5 || Number(m[2]) > 0.5) {
    reasons.push(`歌词时钟周期被拉长到 ${m[1]}s / ${m[2]}s（1s 节流需要拍长 ≤0.5s，否则最坏要等两个整数拍 ⇒ 刷新间隔超过 1s，用户要的「按照每秒刷新」不成立）`)
  }

  // ⑪ 【第 47 轮】拍长契约值 0.05s（20Hz）。⑩ 只管「不许拉长到破坏 1s 节流」，
  //    这里钉死确切值——用户原话「歌词显示需要更加迅速和提高加载帧率」：
  //    这一拍直接决定歌词换行的最坏延迟（0.12s ⇒ 最坏 120ms，0.05s ⇒ 最坏 50ms），
  //    退回 0.12s ＝ 用户这轮的诉求当场作废。
  if (m != null && Number(m[1]) !== 0.05) {
    reasons.push(`歌词时钟首次开火时刻是 ${m[1]}s，不是第 47 轮的 0.05s 契约值（用户要求「歌词显示更加迅速、提高加载帧率」——这一拍直接决定换行延迟，改大即诉求回归）`)
  }

  // ⑫ 【第 47 轮】重复间隔同样钉死 0.05s：对重复定时器来说 interval 才决定 tick 频率
  //    （start 只管第一拍；只改间隔不改成 start 的「顺手漂移」必须在这里被拦下）。
  if (m != null && Number(m[2]) !== 0.05) {
    reasons.push(`歌词时钟重复间隔是 ${m[2]}s，不是第 47 轮的 0.05s 契约值（interval 决定 tick 频率：改大 ⇒ 歌词换行变慢、帧率回归；改小 ⇒ 唤醒变密，第 42 轮省电口径作废）`)
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 H【第 47 轮 第 3 条】：起播不许留「播放已开始，卡片却空白」的窗口
//
// 用户原话（第 47 轮）：「现在存在播放开始了但是歌词和进度条和时间都没有加载出来的
// 问题，这个问题要修复」。
//
// 机制（与用户描述逐条对上）：队列 reset / 引擎切换会走 LXClearNowPlayingInfo → 把
// LXNowPlayingState 置成 Stopped；而 reset 之后 nativeFlac 驱动不再产生任何 TrackPlayer
// 生命周期事件。若这次起播是「元数据先到、状态发布后到」（或状态发布被
// LXSetNowPlayingPlaybackState 里的 `existingTitle.length == 0` 早退吞掉），Stopped
// 就一直挂着 ⇒
//   ① LXApplyNowPlayingInfo 按播放态把速率归一成 0 ⇒ 进度条冻在 0、时间不走；
//   ② LXSyncNowPlayingLyricTimer 的守卫要求 Playing ⇒ 原生歌词时钟压根不启动 ⇒ 歌词停在上一行。
//
// 修法：JS 只在确实在播时才带正速率发布（playList.ts 的 updateMetaInfo：
// `playbackRate: isPlaying ? 用户速率 : 0`），所以「正速率 = 当前在播」这个断言可信 ——
// LXSetNowPlayingInfo 在正速率分支里把 Stopped **单向**提升成 Playing。
// 必须单向：Paused 是用户按下 ⏸ 的状态，只能由引擎的 'playing' 事件
// （LXSetNowPlayingPlaybackState）翻转，绝不能被一次迟到的元数据发布复活 ——
// 否则「点暂停后卡片自己跳回播放中」这个比空白卡片更坏的 bug 会回来（第 47 轮第 1 条）。
// ---------------------------------------------------------------------------
const startupStateInvariants = (raw) => {
  const reasons = []
  const setInfo = extractBracedBody(raw, 'static void LXSetNowPlayingInfo(NSDictionary *metadata)')
  if (!setInfo) {
    reasons.push('LXSetNowPlayingInfo 缺失或抽取失败（锚点漂移）')
    return reasons
  }
  const body = stripComments(setInfo)

  // ① 正速率分支必须同时解冻时钟 + 补齐播放态（缺一不可：只解冻不补态，歌词时钟的
  //    守卫仍然不通过；只补态不解冻，时钟仍冻在锚点行）
  if (!body.includes('if (playbackRate != nil && playbackRate.doubleValue > 0) {')) {
    reasons.push('找不到「正速率发布」分支（第 47 轮：这一支是起播空窗的补齐点 —— 没了它，元数据先到的起播会把 Stopped 一直挂住）')
  }
  if (!body.includes('LXNowPlayingClockHold = NO;')) {
    reasons.push('正速率发布不再解冻歌词时钟（hold 残留在 YES 时原生时钟永远不跑）')
  }
  if (!body.includes('LXNowPlayingState = MPNowPlayingPlaybackStatePlaying;')) {
    reasons.push('正速率发布的「播放态同源补齐」丢了（Stopped 挂着 ⇒ 速率被归一成 0 + 原生歌词时钟不启动 = 用户报的「播放开始了但歌词/进度条/时间都没加载出来」）')
  }

  // ② **单向**：守卫必须逐字是 `== MPNowPlayingPlaybackStateStopped`，
  //    绝不许写成 `!= …Playing` / 也不许顺手补 Paused —— 那会把用户按下的 ⏸ 复活
  if (!body.includes('if (LXNowPlayingState == MPNowPlayingPlaybackStateStopped) {')) {
    reasons.push('播放态同源补齐的守卫不是「单向 Stopped → Playing」（必须逐字是 `if (LXNowPlayingState == MPNowPlayingPlaybackStateStopped) {`：写成 != Playing 或顺手补 Paused，会把用户按下的 ⏸ 复活成播放中，比空白卡片更坏）')
  }
  if (/LXNowPlayingState\s*!=\s*MPNowPlayingPlaybackStatePlaying/.test(body)) {
    reasons.push('播放态同源补齐全成了双向 / 反向（`!= Playing` 会把 Paused 也拉回 Playing —— 暂停卡片自己跳回播放中）')
  }
  if (body.includes('MPNowPlayingPlaybackStatePaused')) {
    reasons.push("播放态同源补齐碰了 Paused（只允许提升 Stopped；Paused 必须留给引擎的 'playing' 事件翻转，否则第 47 轮第 1 条「点暂停真的暂停」会被迟到的元数据回滚）")
  }

  // ③ 次序：补齐必须在同函数内的 LXSyncNowPlayingLyricTimer() 之前 ——
  //    否则这一拍音钟守卫读到的仍是 Stopped，时钟要到下一次元数据发布才启动（起播仍有空白窗口）
  const iPromo = body.indexOf('if (LXNowPlayingState == MPNowPlayingPlaybackStateStopped) {')
  const iClock = body.indexOf('LXSyncNowPlayingLyricTimer();')
  if (iPromo >= 0 && iClock >= 0 && iPromo > iClock) {
    reasons.push('播放态同源补齐被挪到 LXSyncNowPlayingLyricTimer() 之后（这一拍音钟守卫读到的仍是 Stopped —— 起播仍有「歌词不加载」的空白窗口）')
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

  // r1 又把「六个一律 YES」写回来（第 35 轮的错方向）→ 报「一律 YES / 同源」
  check('r1 play/pause 又写成一律 YES（第 35 轮错方向回归）', () => availabilityInvariants(tamper(REAL_APPDELEGATE,
    '  commandCenter.playCommand.enabled = !isPlaying;\n  commandCenter.pauseCommand.enabled = isPlaying;',
    '  commandCenter.playCommand.enabled = YES;\n  commandCenter.pauseCommand.enabled = YES;')),
  '错方向')

  // r2 isPlaying 不再读显示态（与卡片显示态脱钩）→ 报「同源公式」
  check('r2 isPlaying 改成恒 YES（与显示态脱钩）', () => availabilityInvariants(tamper(REAL_APPDELEGATE,
    '  BOOL isPlaying = LXNowPlayingState == MPNowPlayingPlaybackStatePlaying;',
    '  BOOL isPlaying = YES;')),
  '同源')

  // r3 合并按钮被改成 YES（与 play/pause 同时启用 → 投递归属不确定）→ 报「togglePlayPauseCommand」
  check('r3 togglePlayPauseCommand 被改成 YES', () => availabilityInvariants(tamper(REAL_APPDELEGATE,
    '  commandCenter.togglePlayPauseCommand.enabled = NO;\n  commandCenter.nextTrackCommand.enabled = YES;',
    '  commandCenter.togglePlayPauseCommand.enabled = YES;\n  commandCenter.nextTrackCommand.enabled = YES;')),
  'togglePlayPauseCommand')

  // r4 有信息时把下一首置灰 → 报「未被启用」
  check('r4 有信息时下一首被置灰', () => availabilityInvariants(tamper(REAL_APPDELEGATE,
    '  commandCenter.nextTrackCommand.enabled = YES;',
    '  commandCenter.nextTrackCommand.enabled = NO;')),
  '未被启用')

  // r5 漏掉「开始接收遥控事件」→ 报「未开始接收遥控事件」
  check('r5 漏掉 beginReceivingRemoteControlEvents', () => availabilityInvariants(tamper(REAL_APPDELEGATE,
    '  LXBeginReceivingRemoteControlEvents();',
    '')),
  '未开始接收遥控事件')

  // r6 有人把「切到相反值再切回」的说谎翻转加回来 → 报「只允许一处」
  check('r6 歌词换行的 playbackState 说谎翻转被加回', () => singleSourceInvariants(tamper(REAL_APPDELEGATE,
    '  if (!hasInfo) return;\n  LXApplyNowPlayingInfo();',
    '  if (!hasInfo) return;\n  center.playbackState = MPNowPlayingPlaybackStatePaused;\n  LXApplyNowPlayingInfo();')),
  '只允许一处')

  // r7 唯一那处赋值被写成「相反态」→ 报「赋的不是真实播放态」
  check('r7 唯一赋值改成相反态', () => singleSourceInvariants(tamper(REAL_APPDELEGATE,
    '      center.playbackState = LXNowPlayingState;',
    '      center.playbackState = MPNowPlayingPlaybackStatePaused;')),
  '赋的不是真实播放态')

  // r8 封面就绪重绘又去碰 playbackState → 报「LXApplyNowPlayingArtwork 里出现 playbackState」
  check('r8 封面就绪重绘又碰 playbackState', () => singleSourceInvariants(tamper(REAL_APPDELEGATE,
    '    info[MPMediaItemPropertyArtwork] = artwork;\n',
    '    info[MPMediaItemPropertyArtwork] = artwork;\n    [MPNowPlayingInfoCenter defaultCenter].playbackState = MPNowPlayingPlaybackStatePaused;\n')),
  'LXApplyNowPlayingArtwork 里出现 playbackState')

  // s1 主线程闸门被删（回到「歌词时钟跨线程直写」的老样子）→ 报「缺主线程闸门」
  check('s1 LXApplyNowPlayingInfo 的主线程闸门被删', () => mainThreadInvariants(tamper(REAL_APPDELEGATE,
    '  if (![NSThread isMainThread]) {\n    dispatch_async(dispatch_get_main_queue(), ^{\n      LXApplyNowPlayingInfo();\n    });\n    return;\n  }\n  @synchronized (LXLyricLock()) {',
    '  @synchronized (LXLyricLock()) {')),
  '主线程闸门')

  // s2 台词：歌词时钟（专用串行队列）绕过 apply 直呼可用性同步 → 报「被调用 2 处」
  check('s2 歌词时钟绕过 apply 直呼 LXSyncRemoteCommandAvailability', () => mainThreadInvariants(tamper(REAL_APPDELEGATE,
    '      LXApplyNowPlayingInfo();\n      LXForceNowPlayingCardRepaint();',
    '      LXSyncRemoteCommandAvailability();\n      LXForceNowPlayingCardRepaint();')),
  '被调用 2 处')

  // s3 有人把 1s 重申看门狗加回来 → 报「又回来了」
  check('s3 看门狗被加回来', () => mainThreadInvariants(tamper(REAL_APPDELEGATE,
    '  LXRemoteCommandHandlersInstalled = YES;\n}',
    '  LXRemoteCommandHandlersInstalled = YES;\n  LXStartRemoteCommandWatchdog();\n}')),
  '又回来了')

  // s4 封面链路又把整条信息置空（会话拆除窗口回来）→ 报「nowPlayingInfo = nil」
  check('s4 封面链路又置空 nowPlayingInfo（会话拆除窗口）', () => mainThreadInvariants(tamper(REAL_APPDELEGATE,
    '    info[MPMediaItemPropertyArtwork] = artwork;\n',
    '    info[MPMediaItemPropertyArtwork] = artwork;\n    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = nil;\n')),
  'nowPlayingInfo = nil')

  // s5 歌词时钟自己直接写 MPNowPlayingInfoCenter（绕过唯一写入口）→ 报「出现 2 处」
  check('s5 歌词时钟绕过 apply 直写 MPNowPlayingInfoCenter', () => mainThreadInvariants(tamper(REAL_APPDELEGATE,
    '    LXNowPlayingInfoCache[MPMediaItemPropertyArtist] = text;\n',
    '    LXNowPlayingInfoCache[MPMediaItemPropertyArtist] = text;\n    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = [LXNowPlayingInfoCache copy];\n')),
  '出现 2 处')

  // s6 遥控播放键不再抢回音频会话（本工程 pause 会让出会话）→ 报「没有先抢回音频会话」
  check('s6 遥控播放键不再抢回音频会话', () => mainThreadInvariants(tamper(REAL_APPDELEGATE,
    '  if ([command isEqualToString:@"play"] || [command isEqualToString:@"toggle"]) {\n    LXActivateAudioSessionForRemotePlay();\n  }\n',
    '')),
  '没有先抢回音频会话')

  // s7 发布前的速率归一被废（回到「三个写者谁最后写谁说了算」）→ 报「不再读播放态」
  check('s7 发布前速率归一被废（不再读播放态）', () => rateStateInvariants(tamper(REAL_APPDELEGATE,
    '      if (LXNowPlayingState == MPNowPlayingPlaybackStatePlaying) {\n        if (cachedRate == nil || cachedRate.doubleValue <= 0) {',
    '      if (NO) {\n        if (cachedRate == nil || cachedRate.doubleValue <= 0) {')),
  '不再读播放态')

  // s8 归一被挪到发布之后（等于没归一）→ 报「必须在 center.nowPlayingInfo 发布之前」
  check('s8 速率归一被挪到发布之后', () => rateStateInvariants(tamper(REAL_APPDELEGATE,
    '    if (LXNowPlayingInfoCache.count) {\n      NSNumber *cachedRate',
    '    center.nowPlayingInfo = nil;\n    if (LXNowPlayingInfoCache.count) {\n      NSNumber *cachedRate')),
  '发布之前')

  // s9 非播放方向的清零被删（只留播放中兜底）→ 报「非播放的速率清零丢了」
  check('s9 非播放方向的速率清零被删', () => rateStateInvariants(tamper(REAL_APPDELEGATE,
    '      } else if (cachedRate != nil && cachedRate.doubleValue != 0) {\n        LXNowPlayingInfoCache[MPNowPlayingInfoPropertyPlaybackRate] = @0;\n      }\n',
    '      }\n')),
  '非播放的速率清零丢了')

  // r11 JS 侧无条件落闸（第 35 轮第 1 条要拦的就是这个）→ 报「前置判据」
  check('r11 JS 侧 pause 无条件落闸', () => remoteInvariants(tamper(REAL_REMOTE,
    '        if (playerState.isPlay) markManualPause()',
    '        markManualPause()')),
  '前置判据')

  // r12 pause 分支在暂停态提前 return（暂停键点不动）→ 报「提前 return」
  check('r12 pause 分支在暂停态提前 return', () => remoteInvariants(tamper(REAL_REMOTE,
    '        if (playerState.isPlay) markManualPause()\n',
    '        if (!playerState.isPlay) return\n        markManualPause()\n')),
  '提前 return')

  // u1 【第 45 轮】「按下即对表」被删（分叉后没有任何纠正路径 —— 用户截图里的灰按钮）
  //     锚点带上前一行 apply 调用与后一行 post 调用：两行紧挨着，全文件唯一。
  check('u1 按下即对表被删', () => tapResyncInvariants(tamper(REAL_APPDELEGATE,
    '  LXApplyNowPlayingInfo();\n  LXPostRemoteCommandNotification(command, nil);',
    '  LXPostRemoteCommandNotification(command, nil);')),
  '按下即对表')

  // u2 「按下即对表」被挪到通知之后（动作先生效、显示层后纠正，这一拍仍自相矛盾）→ 报次序
  check('u2 对表被挪到通知之后', () => tapResyncInvariants(tamper(REAL_APPDELEGATE,
    '  LXApplyNowPlayingInfo();\n  LXPostRemoteCommandNotification(command, nil);',
    '  LXPostRemoteCommandNotification(command, nil);\n  LXApplyNowPlayingInfo();')),
  '落在 LXPostRemoteCommandNotification 之后')

  // u3 锁屏那一刻的对表被删（锁屏后没有任何周期性重发兜底）→ 报「不再对表」
  check('u3 锁屏对表被删', () => tapResyncInvariants(tamper(REAL_APPDELEGATE,
    '  if (LXNowPlayingInfoCache.count == 0) return;\n  LXApplyNowPlayingInfo();\n}',
    '}')),
  '不再对表')

  // u4 前置声明被删（定义在后、调用在前 —— 隐式声明，ARC 下编译不过）→ 报「前置声明」
  check('u4 LXApplyNowPlayingInfo 前置声明被删', () => tapResyncInvariants(tamper(REAL_APPDELEGATE,
    'static void LXApplyNowPlayingInfo(void);\n',
    '')),
  '前置声明')

  // ---- 第 46 轮：每秒对表（g1~g8）----
  // g1 整块心跳被删（回到「只在歌词换行时更新进度」）→ 报「每秒对表」
  check('g1 每秒对表被整块删掉', () => elapsedHeartbeatInvariants(tamper(REAL_APPDELEGATE,
    HEARTBEAT_BLOCK, '')),
  '每秒对表')

  // g2 守卫漏掉「外推冻结」（缓冲 / 停走期间每秒把冻结值写回去，进度条每秒往回跳一格）→ 报守卫
  check('g2 守卫漏掉 LXNowPlayingClockHold', () => elapsedHeartbeatInvariants(tamper(REAL_APPDELEGATE,
    'if (!paused && !LXNowPlayingClockHold && ' + HEARTBEAT_THROTTLE,
    'if (!paused && ' + HEARTBEAT_THROTTLE)),
  '守卫不完整')

  // g3 心跳被挪到「无歌词早退」之后（无歌词的歌整首不刷新）→ 报「无歌词早退」
  check('g3 心跳被挪到无歌词早退之后', () => elapsedHeartbeatInvariants(tamper(REAL_APPDELEGATE,
    HEARTBEAT_BLOCK,
    '    if (LXNowPlayingLyricLines.count == 0) return;\n' + HEARTBEAT_BLOCK)),
  '无歌词早退')

  // g4 节流闸门被删（退化成 8.3Hz 每拍全量重发）→ 报「节流判据」
  check('g4 节流闸门被删', () => elapsedHeartbeatInvariants(tamper(REAL_APPDELEGATE,
    '    if (!paused && !LXNowPlayingClockHold && ' + HEARTBEAT_THROTTLE + ') {\n', '')),
  '节流判据')

  // g5 只推位置不推快照戳（歌词锚点重锚时把时钟推超前）→ 报「快照戳」
  check('g5 只推位置不推快照戳', () => elapsedHeartbeatInvariants(tamper(REAL_APPDELEGATE,
    '      LXNowPlayingElapsedSnapshotAtMs = elapsedRefreshNowMs;\n', '')),
  '快照戳')

  // g6 心跳绕过唯一写入口直接写 info（第 43 轮现象的成因写法）→ 报「唯一写入口」
  check('g6 心跳绕过唯一写入口直写 info', () => elapsedHeartbeatInvariants(tamper(REAL_APPDELEGATE,
    '      LXNowPlayingElapsedSnapshotAtMs = elapsedRefreshNowMs;\n      LXApplyNowPlayingInfo();\n',
    '      LXNowPlayingElapsedSnapshotAtMs = elapsedRefreshNowMs;\n      [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = [LXNowPlayingInfoCache copy];\n')),
  '唯一写入口')

  // g7 心跳被塞进「仅前台」分支（锁屏时跑不到 —— 正是用户报的那个场景）→ 报「仅前台」
  check('g7 心跳被塞进仅前台分支', () => elapsedHeartbeatInvariants(tamper(
    tamper(REAL_APPDELEGATE, HEARTBEAT_BLOCK, ''),
    '    if (!paused && [UIApplication sharedApplication].applicationState == UIApplicationStateActive) {\n',
    '    if (!paused && [UIApplication sharedApplication].applicationState == UIApplicationStateActive) {\n' + HEARTBEAT_BLOCK)),
  '仅前台')

  // g8 时钟**首次开火时刻**被拉长到 2s（1s 闸门最坏要等两个整数拍 ⇒ 刷新间隔超过 1s）→ 报「周期被拉长」
  check('g8 时钟拍长被拉长到 2s', () => elapsedHeartbeatInvariants(tamper(REAL_APPDELEGATE,
    TIMER_START_LINE('0.05'), TIMER_START_LINE('2'))),
  '周期被拉长')

  // 【第 47 轮】g9 **重复间隔**退回 0.12s（真正决定 tick 频率的实参；用户要的
  // 「歌词更迅速、帧率更高」当场作废）→ 报「0.05s 契约值」
  check('g9 重复间隔退回 0.12s', () => elapsedHeartbeatInvariants(tamper(REAL_APPDELEGATE,
    TIMER_INTERVAL_LINE('0.05'), TIMER_INTERVAL_LINE('0.12'))),
  '0.05s 契约值')

  // 【第 47 轮】g10 起播空窗的补齐被删（元数据先到、状态后到 ⇒ 进度条冻在 0、
  // 原生歌词时钟不启动 = 用户报的「播放开始了但歌词/进度条/时间都没加载出来」）→ 报「同源补齐」
  check('g10 起播时不再补播放态', () => startupStateInvariants(tamper(REAL_APPDELEGATE,
    STOPPED_PROMOTION_BLOCK, '')),
  '同源补齐')

  // 【第 47 轮】g11 补齐被写成双向（Paused 也会被一次迟到的元数据发布复活成 Playing）
  // → 报「单向」
  check('g11 补齐改成双向（暂停态也被复活）', () => startupStateInvariants(tamper(REAL_APPDELEGATE,
    'if (LXNowPlayingState == MPNowPlayingPlaybackStateStopped) {',
    'if (LXNowPlayingState != MPNowPlayingPlaybackStatePlaying) {')),
  '单向')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-remote-command-lockscreen-tap ===')

const checks = [
  ['原生：命令启停与参考工程 1:1（显示态 / 启停态同源）', () => availabilityInvariants(REAL_APPDELEGATE)],
  ['原生：全文件只允许一处 playbackState 赋值且赋真实态（两处说谎翻转已删）', () => singleSourceInvariants(REAL_APPDELEGATE)],
  ['原生：写入一律主线程 + 无看门狗 + 无会话拆除 + 播放键先抢会话（第 43 轮）', () => mainThreadInvariants(REAL_APPDELEGATE)],
  ['原生：发布前速率与播放态同源（卡片显示 ⟺ 命令启停，第 44 轮）', () => rateStateInvariants(REAL_APPDELEGATE)],
  ['原生：按下即对表 + 锁屏那一刻对表（第 45 轮，含前置声明）', () => tapResyncInvariants(REAL_APPDELEGATE)],
  ['原生：锁屏 / 灵动岛卡片进度每秒对表（第 46 轮第 1 条）', () => elapsedHeartbeatInvariants(REAL_APPDELEGATE)],
  ['原生：起播元数据先到也能补齐播放态（第 47 轮第 3 条：单向 Stopped → Playing）', () => startupStateInvariants(REAL_APPDELEGATE)],
  ['JS：pause 只在真的会暂停时落闸（六命令覆盖 + 去重窗口）', () => remoteInvariants(REAL_REMOTE)],
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
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.ok ? '已拦下' : `未拦下（reasons=${JSON.stringify(r.detail)}）`}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
