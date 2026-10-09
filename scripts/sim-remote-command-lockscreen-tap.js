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
 * 配套（同一轮，缺一不可）：
 *   ① **一处都不许再说谎**：全文件只允许一处 `center.playbackState = ...`，
 *      且赋的就是真实态 `LXNowPlayingState`（第 35 轮之前有两处「切到相反值再切回」的
 *      强制重绘 —— 那 60ms/150ms 窗口里显示态与启停态互相矛盾，正是「点两次才生效」的根）；
 *   ② **外部改写 1 秒内纠正**：MPRemoteCommandCenter 是双方共管的 ——
 *      react-native-track-player 的 setupPlayer / updateOptions / destroy 会直接关掉同一批
 *      命令且不通知我们。LXStartRemoteCommandWatchdog（1s 周期 dispatch source，主队列）
 *      每秒重申一次可用性，把这类静默改写拉回来。
 *
 * 反例专盯「回归 tsc / eslint 都无感」的部分：原生不参与 TS 检查，把判据改回按播放态单算、
 * 漏一句 beginReceivingRemoteControlEvents、把看门狗删掉、或又把 playbackState 翻转加回来，
 * 静态检查与单测全都看不见。
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
// 不变量 C：可用性重申看门狗（外部改写 1 秒内纠正）
// ---------------------------------------------------------------------------

const watchdogInvariants = (raw) => {
  const reasons = []

  const body = extractBracedBody(raw, 'static void LXStartRemoteCommandWatchdog(void)')
  if (!body) {
    reasons.push('LXStartRemoteCommandWatchdog 缺失或抽取失败（锚点漂移 —— 没有它，react-native-track-player 对 MPRemoteCommandCenter 的静默改写没人纠正，锁屏按钮会「过一会儿就点不动」）')
    return reasons
  }
  const code = stripComments(body)

  if (!code.includes('DISPATCH_SOURCE_TYPE_TIMER')) {
    reasons.push('看门狗不是 dispatch source 定时器（DISPATCH_SOURCE_TYPE_TIMER 缺失）')
  }
  const setTimer = slice(code, 'dispatch_source_set_timer(timer,', ');')
  if (!setTimer) {
    reasons.push('看门狗没设周期（dispatch_source_set_timer(timer, …) 缺失或形状变了）')
  } else {
    // 三个数值（起始延迟 / 周期 / leeway）都要用 NSEC_PER_SEC 换算才算秒级；
    // 周期本身还有上限：3600 * NSEC_PER_SEC 这种「一小时纠正一次」等于没纠正。
    const multipliers = setTimer.match(/[0-9.]+\s*\*\s*NSEC_PER_SEC/g) || []
    if (multipliers.length < 3) {
      reasons.push('看门狗周期不是秒级（dispatch_source_set_timer 的 起始延迟 / 周期 / leeway 三个数值都要用 NSEC_PER_SEC 换算 —— 缺了就等于纠正窗口不可控）')
    }
    const tooBig = multipliers.filter((m) => Number(m.split('*')[0].trim()) > 60)
    if (tooBig.length) {
      reasons.push(`看门狗周期被拉长（${tooBig.join(' / ')} —— 超过 60 秒的纠正窗口等于没纠正，锁屏按钮会「过一会儿就点不动」）`)
    }
  }
  if (!code.includes('dispatch_source_set_event_handler(timer')) {
    reasons.push('看门狗没挂事件处理（dispatch_source_set_event_handler 缺失）')
  }
  if (!code.includes('LXSyncRemoteCommandAvailability();')) {
    reasons.push('看门狗每拍不重申可用性（LXSyncRemoteCommandAvailability() 缺失）')
  }
  if (!code.includes('dispatch_resume(timer);')) {
    reasons.push('看门狗创建后没启动（dispatch_resume(timer) 缺失 —— dispatch source 默认挂起）')
  }
  // 必须在主队列上跑：MPRemoteCommandCenter 的属性只能在主线程改
  if (!code.includes('dispatch_async(dispatch_get_main_queue()') || !code.includes('dispatch_get_main_queue())')) {
    reasons.push('看门狗没落到主队列（dispatch_get_main_queue 缺失 —— MPRemoteCommandCenter 的属性只能在主线程改）')
  }
  // 空转保护：无歌曲信息且不在接收遥控事件时跳过（省电，也避免无播放时的无谓轮询）
  if (!code.includes('LXNowPlayingInfoCache.count == 0 && !LXIsReceivingRemoteControlEvents')) {
    reasons.push('看门狗没有空转保护（缺「无歌曲信息且未在接收遥控事件就跳过」的判据）')
  }

  // 前置声明必须先于使用（C 语言的隐式声明会让编译报错/行为未定义）
  const iDecl = raw.indexOf('static void LXStartRemoteCommandWatchdog(void);')
  const iDef = raw.indexOf('static void LXStartRemoteCommandWatchdog(void) {')
  if (iDecl < 0) {
    reasons.push('看门狗缺前置声明（`static void LXStartRemoteCommandWatchdog(void);`）')
  } else if (iDef > 0 && iDecl > iDef) {
    reasons.push('看门狗的前置声明出现在定义之后（应在文件开头的静态声明区）')
  }

  // 安装完 target 就要点起看门狗（反过来的话：安装前的那段窗口没人兜底）
  if (!/LXRemoteCommandHandlersInstalled = YES;[\s\S]{0,400}?LXStartRemoteCommandWatchdog\(\);/.test(raw)) {
    reasons.push('看门狗没在安装 target 之后立刻启动（LXRemoteCommandHandlersInstalled = YES; 后 400 字符内没有 LXStartRemoteCommandWatchdog();）')
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
    '    center.nowPlayingInfo = nil;\n',
    '    center.nowPlayingInfo = nil;\n    center.playbackState = MPNowPlayingPlaybackStatePaused;\n')),
  'LXApplyNowPlayingArtwork 里出现 playbackState')

  // r9 看门狗被删（顺手「优化」掉）→ 报「LXStartRemoteCommandWatchdog 缺失」
  check('r9 看门狗启动调用被删', () => watchdogInvariants(tamper(REAL_APPDELEGATE,
    '  LXStartRemoteCommandWatchdog();\n',
    '')),
  '没在安装 target 之后立刻启动')

  // r10 整个 set_timer 被换成「一小时一跳、不再用秒换算」的写法 → 报「周期不是秒级」
  check('r10 看门狗周期被拉长到小时级', () => watchdogInvariants(tamper(REAL_APPDELEGATE,
    '  dispatch_source_set_timer(timer,\n                              dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)),\n                              (uint64_t)(1.0 * NSEC_PER_SEC),\n                              (uint64_t)(0.2 * NSEC_PER_SEC));',
    '  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 3600ull * 1000 * 1000 * 1000), 3600ull * 1000 * 1000 * 1000, 0);')),
  '周期不是秒级')

  // r10b 周期还用 NSEC_PER_SEC 写，但换成小时（3600 * NSEC_PER_SEC 也要拦）
  check('r10b 周期写成 3600 * NSEC_PER_SEC', () => watchdogInvariants(tamper(REAL_APPDELEGATE,
    '                              (uint64_t)(1.0 * NSEC_PER_SEC),\n',
    '                              (uint64_t)(3600.0 * NSEC_PER_SEC),\n')),
  '周期被拉长')

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
  ['原生：可用性重申看门狗（外部改写 1 秒内纠正）', () => watchdogInvariants(REAL_APPDELEGATE)],
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
