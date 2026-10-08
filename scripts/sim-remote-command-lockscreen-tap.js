/**
 * sim-remote-command-lockscreen-tap.js
 *
 * 「锁屏 / 灵动岛的上一首、下一首、播放暂停必须**一次点击就生效**」契约不变量
 * （第 35 轮第 1 条，2026-10-08）。
 *
 * 用户原话：锁屏界面和灵动岛界面的上一首、下一首、播放/暂停按钮，点击后无反应或者
 * 点击 2 次才能有反应，请修复，点击按钮后可以一次反应。
 *
 * 根因：**系统看到的播放态**与**命令启停的判据**被做成了两套。
 *   · 系统侧（锁屏卡片 / 灵动岛上按哪个图标、按钮是什么语义）由
 *     MPNowPlayingInfoCenter.playbackState 决定，而本项目为了强制刷新卡片上的封面/歌词，
 *     会**故意**把它短暂切成相反值再切回：LXForceNowPlayingCardRepaint()
 *     （歌词换行即触发，切反 60ms）与 LXApplyNowPlayingArtwork()（封面就绪，
 *     150ms 切反 / 80ms 切回）；
 *   · 命令的 enabled 却读 LXNowPlayingState —— 它**不跟着那次翻转走**，仍是真实播放态。
 * 于是「正在播放」时卡片上显示 ▶、而 playCommand 恰好在那一刻被置 NO：iOS 对
 * enabled = NO 的命令**不投递**，用户那一次点击就此消失；翻转恢复后按钮变回 ⏸
 * （pauseCommand 是启用的），再点一次才生效 —— 正是「无反应 / 点两次」。
 *
 * 修法（两条互补，本脚本分别钉）：
 *   ① 原生：有歌曲信息时六个命令**一律启用**，判据只剩「信息在不在」
 *      （LXSyncRemoteCommandAvailability），动作由 JS 单一通路决定；
 *   ② JS 兜底：remoteCommand.ts 的 'pause' 分支只在「这次 pause 真的会暂停
 *      （playerState.isPlay）」时才落手动暂停闸门 —— 翻转窗口里系统可能按**显示出来的**
 *      状态投递一条与真实播放态相反的 pause，落到一首本来就在暂停的歌上时不能把闸门锁死
 *      （那是第 22 轮「手动暂停后自己又播」那类 bug 的另一种成因）。
 *
 * 反例专盯「回归 tsc/eslint 都无感」的部分：原生不参与 TS 检查，把 enabled 改回按播放态
 * 计算、漏一句 beginReceivingRemoteControlEvents、或把翻转删掉，静态检查与单测全都看不见。
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

/** 从源码抽出「以 signature 开头、后接大括号体」的函数体（按大括号配平）。
 *
 * 注意：AppDelegate.mm 顶部有成批的**前置声明**（`static void F(void);`），它们与定义
 * 签名一字不差 —— 只取 indexOf 的第一处会锚到声明上，再往后找的 `{` 就落进别的函数，
 * 断言随即看到一份「没有 playbackState 的函数体」（本轮实测：flickerInvariants 假红）。
 * 所以按序扫描所有出现，取「后面紧跟 `{`」的那一处（= 定义）。
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
// 不变量 A：原生命令启停只认「有没有歌曲信息」，且启用/停用成对
// ---------------------------------------------------------------------------

const availabilityInvariants = (raw) => {
  const reasons = []
  const body = extractBracedBody(raw, 'static void LXSyncRemoteCommandAvailability(void)')
  if (!body) {
    reasons.push('LXSyncRemoteCommandAvailability 缺失或抽取失败（锚点漂移）')
    return reasons
  }
  const code = stripComments(body)

  // ① 判据必须是「缓存里有没有歌曲信息」——不许再看播放态
  if (!code.includes('BOOL hasInfo = LXNowPlayingInfoCache.count > 0;')) {
    reasons.push('启停判据不再是「有没有歌曲信息」（LXNowPlayingInfoCache.count > 0 缺失 —— 判据一漂移就有可能出现「按钮在、点了不投递」）')
  }
  if (code.includes('LXNowPlayingState')) {
    reasons.push('命令启停不得再依赖播放态（LXSyncRemoteCommandAvailability 里出现了 LXNowPlayingState —— 卡片重绘期间它会被切成相反值，与系统显示不一致 ⇒ 点击被 enabled = NO 静默吞掉）')
  }

  // ② 有信息：六个命令一律启用
  for (const c of COMMANDS) {
    if (!code.includes(`commandCenter.${c}.enabled = YES;`)) {
      reasons.push(`有歌曲信息时 ${c} 未被启用（enabled = YES 缺失 —— 对应按键会「点了没反应」/ 要按两次才生效）`)
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
    reasons.push('「无信息 → 全部停用」分支必须在「有信息 → 全部启用」之前（改成先启用会让空信息也留着可点按钮）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：卡片重绘的 playbackState 翻转仍在（「永远启用」的前提，不能被顺手删）
// ---------------------------------------------------------------------------

const flickerInvariants = (raw) => {
  const reasons = []

  // 封面链路（LXApplyNowPlayingArtwork 内）与歌词链路（LXForceNowPlayingCardRepaint）
  // 各切反一次 —— 两处都要在。删掉任一处，锁屏封面/歌词就不再实时刷新。
  const flips = (raw.match(/center\.playbackState = opposite;/g) || []).length
  if (flips < 2) {
    reasons.push(`playbackState 翻转只剩 ${flips} 处（应为 2：封面就绪 + 歌词换行各一次 —— 少一处锁屏封面/歌词就不再实时刷新；正因为它存在，「命令永远启用」才是必需的解）`)
  }
  const repaint = extractBracedBody(raw, 'static void LXForceNowPlayingCardRepaint(void)')
  if (!repaint) {
    reasons.push('LXForceNowPlayingCardRepaint 缺失或抽取失败（锚点漂移）')
  } else {
    if (!repaint.includes('center.playbackState = opposite;')) {
      reasons.push('歌词换行重绘未切反 playbackState（切到相反值再切回才会触发系统重绘整张卡片）')
    }
    if (!repaint.includes('center.playbackState = current;')) {
      reasons.push('歌词换行重绘未切回真实播放态（卡片会一直停在假的相反态）')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：JS 兜底 —— pause 只在「真的会暂停」时落闸，且六个命令仍有落点
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

  // r1 把 play 的启停改回按播放态计算 → 报「不得再依赖播放态」
  check('r1 命令启停改回按播放态计算', () => availabilityInvariants(tamper(REAL_APPDELEGATE,
    '  commandCenter.playCommand.enabled = YES;',
    '  commandCenter.playCommand.enabled = (LXNowPlayingState != MPNowPlayingPlaybackStatePlaying);')),
  '不得再依赖播放态')

  // r2 有信息时把下一首置灰 → 报「未被启用」
  check('r2 有信息时下一首被置灰', () => availabilityInvariants(tamper(REAL_APPDELEGATE,
    '  commandCenter.nextTrackCommand.enabled = YES;',
    '  commandCenter.nextTrackCommand.enabled = NO;')),
  '未被启用')

  // r3 漏掉「开始接收遥控事件」→ 报「未开始接收遥控事件」
  check('r3 漏掉 beginReceivingRemoteControlEvents', () => availabilityInvariants(tamper(REAL_APPDELEGATE,
    '  LXBeginReceivingRemoteControlEvents();',
    '')),
  '未开始接收遥控事件')

  // r4 判据不再看歌曲信息（恒为 YES）→ 报「不再是「有没有歌曲信息」」
  check('r4 启停判据改成恒 true', () => availabilityInvariants(tamper(REAL_APPDELEGATE,
    '  BOOL hasInfo = LXNowPlayingInfoCache.count > 0;',
    '  BOOL hasInfo = YES;')),
  '有没有歌曲信息')

  // r5 JS 侧无条件落闸（第 35 轮第 1 条要拦的就是这个）→ 报「前置判据」
  check('r5 JS 侧 pause 无条件落闸', () => remoteInvariants(tamper(REAL_REMOTE,
    '        if (playerState.isPlay) markManualPause()',
    '        markManualPause()')),
  '前置判据')

  // r6 pause 分支在暂停态提前 return（暂停键点不动）→ 报「提前 return」
  check('r6 pause 分支在暂停态提前 return', () => remoteInvariants(tamper(REAL_REMOTE,
    '        if (playerState.isPlay) markManualPause()\n',
    '        if (!playerState.isPlay) return\n        markManualPause()\n')),
  '提前 return')

  // r7 卡片重绘的翻转被删（顺手「优化」掉）→ 报「翻转只剩」
  check('r7 歌词换行的 playbackState 翻转被删', () => flickerInvariants(tamper(REAL_APPDELEGATE,
    '  center.playbackState = opposite;\n  dispatch_after',
    '  dispatch_after')),
  '翻转只剩')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-remote-command-lockscreen-tap ===')

const checks = [
  ['原生：有信息就六个命令全启用（判据只剩「信息在不在」）', () => availabilityInvariants(REAL_APPDELEGATE)],
  ['原生：卡片重绘的 playbackState 翻转仍在（「永远启用」的前提）', () => flickerInvariants(REAL_APPDELEGATE)],
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
