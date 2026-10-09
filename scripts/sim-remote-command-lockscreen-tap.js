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
