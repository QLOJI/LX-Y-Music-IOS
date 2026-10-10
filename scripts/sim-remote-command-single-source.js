/**
 * sim-remote-command-single-source.js
 *
 * 「锁屏 / 灵动岛 / 车机 / 控制中心的遥控命令：**两条**原生通路 → **一个** JS 漏斗」
 * 契约不变量（第 49 轮整篇重写，2026-10-10）。
 *
 * 用户原话（第 49 轮）：
 *   「重大bug：1、锁屏界面和灵动岛界面的功能无法使用，点击按钮和拖拽进度条都没有用，
 *     需要修复，我是IOS18.4系统，手机是iPhone 16 Pro max」
 *（第 43~48 轮同族症状的第七次报告；第 48 轮的授权「如果还是不行就一比一复制它的」
 *  在本轮生效 —— 参考工程 lx-music-mobile-ios-adaptation 的锁屏一切正常。）
 *
 * 本脚本的口径随第 49 轮修法整体反转（旧口径的「单通路」被用户连续六轮复现推翻）：
 *   旧口径（第 20~48 轮）：service.ts 必须**删掉** RNTP 的五段遥控监听
 *     （RemotePlay / RemotePause / RemoteNext / RemotePrevious / RemoteSeek），
 *     只留 remoteCommand.ts 一条通路 —— 当时的理由是「一次按键跳两首」。
 *   新口径（第 49 轮）：两条通路**都必须活着**（参考工程能点、能拖进度条，正是靠 RNTP
 *     那条：它的 service.ts 挂着 RemoteSeek 监听；只留本工程原生那条时它一旦失效就毫无
 *     兜底 —— 用户连续六轮复现的「前几次能点、用一段时间后按键彻底没反应」正是这种形状），
 *     重复投递改由**唯一 JS 漏斗** src/plugins/player/service.ts 的 dispatchRemoteCommand
 *     的窗口去重兜住（iOS 会把同一条命令投递给**所有** target），
 *     而 remoteCommand.ts 瘦身为纯适配器（不许再自分支 —— 历史上这里的分支与 service.ts
 *     的 RNTP 监听是两份会各自漂移的实现，那正是第 20 轮删掉一边的原因，本轮改成
 *     「两条通路 + 一份逻辑」）。
 *   原生侧另加「幂等自愈安装」（不变量 C）：一次性守卫（装上就永不再装）换成
 *     「每次同步都只摘自己上一轮的 token 再重挂」—— RNTP 的 SwiftAudioEx 重配共享命令
 *     target 时把本工程那份清掉后，通路会在 ≤1s 内自愈回位，而不是永久死亡。
 *     **绝不许 removeTarget:nil**（那会连 RNTP 的 target 一起清掉，等于亲手打死另一条通路）。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：多一条/少一条监听、绕开漏斗直呼、把去重拆了、
 * 把一次性守卫换回来，全都编译得过，只表现为真机上「一次按键跳两首 / 按键没反应 /
 * 进度条拖不动」）。
 * 运行：node scripts/sim-remote-command-single-source.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const SERVICE = 'src/plugins/player/service.ts'
const REMOTE_COMMAND = 'src/core/init/player/remoteCommand.ts'
const APP_DELEGATE = 'ios/LxMusicMobile/AppDelegate.mm'

const REAL_SERVICE = read(SERVICE)
const REAL_REMOTE = read(REMOTE_COMMAND)
const REAL_APPDELEGATE = read(APP_DELEGATE)

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 从源码抽出「以 signature 开头、后接大括号体」的函数体（按大括号配平）。 */
const extractBracedBody = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  const braceStart = src.indexOf('{', start + signature.length)
  if (braceStart < 0) return null
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

/** 取一条 RNTP 监听的回调体（从 addEventListener 起、到该块收尾的 `  })` 止）。 */
const listenerBody = (code, name) => {
  const start = code.indexOf(`TrackPlayer.addEventListener(TPEvent.${name}, `)
  if (start < 0) return null
  const end = code.indexOf('\n  })', start)
  return end < 0 ? null : code.slice(start, end + 5)
}

// ---------------------------------------------------------------------------
// 不变量 A：service.ts ＝ RNTP 通路（五段遥控监听）＋ 唯一 JS 漏斗
// ---------------------------------------------------------------------------

const serviceInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // ① 五段 RNTP 遥控监听必须在，且每条只把命令名交给唯一漏斗
  //（参考工程锁屏/灵动岛可用的承载者；第 20 轮删掉它们，第 49 轮按用户授权恢复）
  for (const [name, cmd] of [
    ['RemotePlay', 'play'],
    ['RemotePause', 'pause'],
    ['RemoteNext', 'next'],
    ['RemotePrevious', 'previous'],
  ]) {
    const body = listenerBody(code, name)
    if (body == null) {
      reasons.push(`RNTP 遥控监听缺失（${name}）：参考工程锁屏/灵动岛可用的承载者就是它，删掉本工程就只剩单点（用户第 43~49 轮连续复现的「用一段时间后按键没反应」）`)
      continue
    }
    if (!body.includes(`dispatchRemoteCommand('${cmd}')`)) {
      reasons.push(`RNTP 监听 ${name} 没有把命令交给唯一漏斗（锁屏按键的处理逻辑必须只有一份，散开就会各自漂移）`)
    }
  }
  // 拖进度条：RemoteSeek 单独查（要带 position —— 参考工程能拖进度条正是靠它）
  const seekBody = listenerBody(code, 'RemoteSeek')
  if (seekBody == null) {
    reasons.push('RNTP RemoteSeek 监听缺失（参考工程能拖进度条正是靠它；缺了这个则锁屏进度条拖不动）')
  } else if (!seekBody.includes("dispatchRemoteCommand('seek', position as number)")) {
    reasons.push('RNTP RemoteSeek 监听没有把位置交给唯一漏斗（缺 `dispatchRemoteCommand(\'seek\', position as number)`）')
  }

  // ② RNTP 监听集合收敛：五段遥控 + RemoteStop + RemoteDuck，恰好 7 条
  const tokens = code.match(/TPEvent\.(Remote\w+)/g) ?? []
  const names = tokens.map(t => t.replace('TPEvent.', ''))
  const want = ['RemotePlay', 'RemotePause', 'RemoteNext', 'RemotePrevious', 'RemoteSeek', 'RemoteStop', 'RemoteDuck']
  const unexpected = names.filter(n => !want.includes(n))
  if (unexpected.length) {
    reasons.push(`service.ts 出现计划外的 RNTP 监听：${unexpected.join(' / ')}（遥控通路的集合必须收敛：五段遥控 + RemoteStop + RemoteDuck）`)
  }
  if (names.length !== 7) {
    reasons.push(`service.ts 的 RNTP 监听未收敛到 7 条（实测 ${names.length} 条：${names.join(' / ') || '（无）'}）`)
  }

  // ③ RemoteDuck 语义（自动续播 / 音量恢复的兜底，不能随监听恢复一起被动到）
  const duckBody = extractBracedBody(code, 'TrackPlayer.addEventListener(TPEvent.RemoteDuck, ({ permanent, paused, ducking }) =>')
  if (!duckBody) {
    reasons.push('RemoteDuck 处理体缺失或抽取失败（锚点漂移）')
  } else {
    for (const [needle, label] of [
      ['shouldResumeAfterDuck ||= !isManualPause() && wasPlayingRecently()', 'iOS 音量闪避的待恢复记录（最近 3s 在播时间窗 + 手动暂停闸门）'],
      ['clearResumeTimer()', '打断开始清掉续播补试表'],
      ['restoreConfiguredVolume()', '打断结束恢复配置音量'],
      ['scheduleAutoResume()', '打断结束按需自动续播'],
    ]) {
      if (!duckBody.includes(needle)) reasons.push(`RemoteDuck 语义被改动（缺 ${label}）`)
    }
  }

  // ④ RemoteStop 语义
  const stopBody = extractBracedBody(code, 'TrackPlayer.addEventListener(TPEvent.RemoteStop, () =>')
  if (!stopBody) {
    reasons.push('RemoteStop 处理体缺失或抽取失败（锚点漂移）')
  } else {
    for (const [needle, label] of [
      ['clearDuckRecoveryTimeouts()', '清音量恢复定时器'],
      ["exitApp('Remote Stop')", '停止退出'],
    ]) {
      if (!stopBody.includes(needle)) reasons.push(`RemoteStop 语义被改动（缺 ${label}）`)
    }
  }

  // ⑤ cancelResumePending 必须导出（漏斗在用它），且语义完整
  if (!code.includes('export const cancelResumePending = () =>')) {
    reasons.push('cancelResumePending 未导出（漏斗拿不到它 —— 用户手动暂停后会被「被抢占自动续播」兜底逻辑误拉起）')
  }
  const cancelBody = extractBracedBody(code, 'cancelResumePending = () =>')
  if (!cancelBody) {
    reasons.push('cancelResumePending 缺失或抽取失败（锚点漂移）')
  } else {
    for (const needle of ['shouldResumeAfterDuck = false', 'resumeRetryCount = 0', 'clearResumeTimer()']) {
      if (!cancelBody.includes(needle)) reasons.push(`cancelResumePending 语义被改动（缺 ${needle}）`)
    }
  }

  // ⑥ 唯一漏斗本体：六命令全覆盖 + 每支都有去重守卫 + pause 的落闸判据 + 交互续期
  const funnel = extractBracedBody(code, 'export const dispatchRemoteCommand = (command: string')
  if (!funnel) {
    reasons.push('唯一漏斗 dispatchRemoteCommand 缺失或抽取失败（锁屏/灵动岛的命令没有 JS 落点）')
    return reasons
  }
  for (const cmd of ['play', 'pause', 'toggle', 'next', 'previous', 'seek']) {
    if (!funnel.includes(`case '${cmd}':`)) {
      reasons.push(`漏斗覆盖不全（缺 case '${cmd}'）`)
    }
  }
  const guards = (funnel.match(/if \(shouldSuppress\w+\(/g) ?? []).length
  if (guards !== 6) {
    reasons.push(`漏斗的去重守卫不是 6 处（实测 ${guards}）：两条通路可能对同一次按键各投递一份命令，少一处就是一次操作执行两遍（「一次按键跳两首」的老病根）`)
  }
  const pauseStart = funnel.indexOf("case 'pause':")
  const pauseEnd = funnel.indexOf("case 'toggle':")
  if (pauseStart < 0 || pauseEnd <= pauseStart) {
    reasons.push("漏斗 case 'pause' 抽取失败（锚点漂移 —— case 'pause' / case 'toggle' 顺序被改动）")
  } else {
    const seg = funnel.slice(pauseStart, pauseEnd)
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
  const seekSeg = funnel.slice(funnel.indexOf("case 'seek':"))
  if (!seekSeg.includes("if (typeof position != 'number') break")) {
    reasons.push('seek 分支不再校验位置类型（事件里没带字段时会把 undefined 当进度写进去）')
  }
  if (!seekSeg.includes('global.app_event.setProgress(position)')) {
    reasons.push('seek 分支没有把位置写进全局进度事件（拖进度条不生效）')
  }
  if (!funnel.includes('markTimeoutExitInteraction()')) {
    reasons.push('遥控命令未调 markTimeoutExitInteraction（超时退出可能在遥控操作中途触发）')
  }

  // ⑦ 去重窗口与实现（先判定、后写戳：被丢弃的重复项不得刷新窗口）
  if (!code.includes('const SKIP_DEDUP_WINDOW_MS = 100')) {
    reasons.push('切歌去重窗口被改动（应为 100ms —— 真实连按间隔 ≥100ms，窗口内判为重复投递）')
  }
  if (!code.includes('const ACTION_DEDUP_WINDOW_MS = 150')) {
    reasons.push('播放/暂停去重窗口被改动（应为 150ms：两条通路对同一次按键的投递只在极短窗口内会重复，放大窗口会误吞真实连按）')
  }
  if (!code.includes('const SEEK_DEDUP_WINDOW_MS = 100')) {
    reasons.push('seek 去重窗口被改动（应为 100ms）')
  }
  const supBody = extractBracedBody(code, 'const shouldSuppressSkipCommand = (command:')
  if (!supBody) {
    reasons.push('切歌去重函数缺失或抽取失败（锚点漂移）')
  } else {
    const checkIdx = supBody.indexOf('if (now - lastSkipCommandAt[command] < SKIP_DEDUP_WINDOW_MS) return true')
    const stampIdx = supBody.indexOf('lastSkipCommandAt[command] = now')
    if (checkIdx < 0 || stampIdx < 0) {
      reasons.push('切歌去重判定被改动（窗口判定与写戳缺一）')
    } else if (stampIdx < checkIdx) {
      reasons.push('切歌去重先写戳后判定（被丢弃的重复项也刷新窗口，会把窗口之后的正常连按一并吞掉）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：remoteCommand.ts 是**纯适配器**（逻辑只在漏斗里，一份）
// ---------------------------------------------------------------------------

const remoteCommandInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // ① 订阅恰好一处
  const subs = (code.match(/onRemoteCommand\(\(event\)/g) ?? []).length
  if (subs !== 1) {
    reasons.push(`适配器订阅未收敛（onRemoteCommand 订阅出现 ${subs} 处，应恰好 1 处）`)
  }
  // ② 原样转手给唯一漏斗
  if (!code.includes('dispatchRemoteCommand(event.command, event.position)')) {
    reasons.push('remoteCommand.ts 未把命令原样交给唯一漏斗（锁屏/灵动岛的按键落不到处理链）')
  }
  if (!code.includes("import { dispatchRemoteCommand } from '@/plugins/player/service'")) {
    reasons.push('remoteCommand.ts 未从 service.ts 引入漏斗（导入方向断了）')
  }
  // ③ 处理逻辑不许外溢回适配器（第 20 轮「两份实现各自漂移」的病根就是从这儿长出来的）
  for (const [needle, label] of [
    ["case '", '命令分支（switch/case）'],
    ['playNext(', '切歌直呼'],
    ['playPrev(', '切歌直呼'],
    ['markManualPause(', '手动暂停闸门'],
    ['shouldSuppress', '去重逻辑'],
    ['SKIP_DEDUP_WINDOW_MS', '去重窗口'],
    ['void pause()', '暂停直呼'],
  ]) {
    if (code.includes(needle)) {
      reasons.push(`适配器里又长出了处理逻辑（${label}）：两条通路共用同一个漏斗，逻辑只能有一份（各自漂移会重现第 20 轮那次「一次按键跳两首」）`)
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：原生侧 —— 六个处理器 + 幂等自愈安装（第 49 轮）
// ---------------------------------------------------------------------------

const appDelegateInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  for (const cmd of [
    'playCommand',
    'pauseCommand',
    'togglePlayPauseCommand',
    'nextTrackCommand',
    'previousTrackCommand',
    'changePlaybackPositionCommand',
  ]) {
    if (!code.includes(`[commandCenter.${cmd} addTargetWithHandler:`)) {
      reasons.push(`AppDelegate 遥控处理器缺失（${cmd} 未安装 target，锁屏/控制中心该键会静默失效）`)
    }
  }
  // 幂等自愈：记住 token、只摘自己上一轮的、重挂
  if (!code.includes('static id LXRemoteCommandTargetTokens[6] = { nil, nil, nil, nil, nil, nil };')) {
    reasons.push('原生侧没有记住自己的 target token（没有 token 就只能用 removeTarget:nil 清空，而那会连 RNTP 的 target 一起打死）')
  }
  const removals = (code.match(/removeTarget:LXRemoteCommandTargetTokens\[/g) ?? []).length
  if (removals !== 6) {
    reasons.push(`原生侧「摘掉自己上一轮 token」的次数不是 6（实测 ${removals}）：每次同步都要先精确摘掉自己那一份再重挂，否则 target 越积越多（一次按键多条通知）`)
  }
  if (/removeTarget\s*:\s*nil\s*\]/.test(code)) {
    reasons.push('出现 removeTarget:nil —— 那会把 RNTP 的 target 一起清掉（另一条通路当场死亡，锁屏按键全灭）')
  }
  if (!code.includes('if (LXInsideRemoteCommandHandler) return;')) {
    reasons.push('原生侧缺「handler 执行期间不重装」的守卫（removeTarget 掉此刻正在跑的 target 是未定义行为）')
  }
  // 注意行首锚定：静态声明那句是 `static BOOL LXInsideRemoteCommandHandler = NO;`，
  // 裸子串计数会把它也算成一次「复位」（实测 2 YES / 3 NO 的假失败就是这么来的）
  const setOn = (code.match(/\n\s*LXInsideRemoteCommandHandler = YES;/g) ?? []).length
  const setOff = (code.match(/\n\s*LXInsideRemoteCommandHandler = NO;/g) ?? []).length
  if (setOn < 2 || setOff !== setOn) {
    reasons.push(`handler 的 in-handler 守卫置位/复位不成对（YES ${setOn} 处 / NO ${setOff} 处）：漏复位会让重装永久停摆，漏置位会在 handler 里摘掉自己`)
  }
  if (code.includes('LXRemoteCommandHandlersInstalled')) {
    reasons.push('一次性守卫 LXRemoteCommandHandlersInstalled 又回来了（装上就再也不管：RNTP 清掉本工程 target 后通路永久死亡，正是第 43~49 轮那个「用一段时间后按键没反应」）')
  }
  if (!code.includes('sendEventWithName:@"remote-command"')) {
    reasons.push('原生未把命令转发给 JS（sendEventWithName:@"remote-command" 缺失）')
  }
  if (!code.includes('@"headphones-disconnected", @"remote-command"')) {
    reasons.push('remote-command 未在 supportedEvents 声明（RN 会丢弃该事件）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：全 src 扫描 —— 遥控事件名只许出现在 service.ts（RNTP 通路 → 漏斗）
// ---------------------------------------------------------------------------

const srcScanInvariants = (entries) => {
  const reasons = []
  const pattern = /\bRemote(Play|Pause|Next|Previous|Seek)\b/
  for (const { file, content } of entries) {
    if (file === SERVICE) continue
    const m = stripComments(content).match(pattern)
    if (m) {
      reasons.push(`遥控事件名出现在 service.ts 之外（${file} 里仍有 ${m[0]}）：RNTP 遥控监听只许集中在本文件，四处散开就会各自漂移`)
    }
  }
  return reasons
}

// 注意：本仓脚本跑在浏览器迷你运行器里，readdirSync(dir, { withFileTypes: true }) 的
// entry.isDirectory() 有闭包缺陷（全部沿用最后一次迭代的值，实测会把文件当目录去
// scandir → `ENOENT: scandir '/src/app.ts'`）。一律 readdirSync + statSync 判断目录
// （同 scripts/sim-tap-lock-responder.js 的处理）。
const listSrcEntries = () => {
  const out = []
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(ROOT, rel))) {
      const childRel = `${rel}/${name}`
      if (/\.(ts|tsx)$/.test(name)) {
        out.push({ file: childRel, content: read(childRel) })
      } else if (fs.statSync(path.join(ROOT, childRel)).isDirectory()) {
        walk(childRel)
      }
    }
  }
  walk('src')
  return out
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

  // r1 RNTP 监听绕开漏斗直呼（两条通路的语义又分叉）→ 报「没有把命令交给唯一漏斗」
  check('r1 RNTP 监听绕开漏斗', () => serviceInvariants(tamper(REAL_SERVICE,
    "  TrackPlayer.addEventListener(TPEvent.RemoteNext, () => {\n    dispatchRemoteCommand('next')\n  })\n",
    "  TrackPlayer.addEventListener(TPEvent.RemoteNext, () => {\n    void playNext()\n  })\n")),
  '没有把命令交给唯一漏斗')

  // r2 删掉 RemoteSeek 监听（锁屏进度条拖不动）→ 报「RemoteSeek 监听缺失」
  check('r2 RemoteSeek 监听被删', () => serviceInvariants(tamper(REAL_SERVICE,
    "  TrackPlayer.addEventListener(TPEvent.RemoteSeek, ({ position }) => {\n    dispatchRemoteCommand('seek', position as number)\n  })\n\n",
    '')),
  'RemoteSeek 监听缺失')

  // r3 漏斗 pause 丢前置判据（第 35 轮第 1 条要拦的就是这个）→ 报「前置判据」
  check('r3 pause 无条件落闸', () => serviceInvariants(tamper(REAL_SERVICE,
    '      if (playerState.isPlay) markManualPause()\n      cancelResumePending()\n      void pause()',
    '      markManualPause()\n      cancelResumePending()\n      void pause()')),
  '前置判据')

  // r4 漏斗 pause 在暂停态提前 return（暂停键点不动）→ 报「提前 return」
  check('r4 pause 分支提前 return', () => serviceInvariants(tamper(REAL_SERVICE,
    '      if (playerState.isPlay) markManualPause()\n',
    '      if (!playerState.isPlay) return\n      markManualPause()\n')),
  '提前 return')

  // r5 漏斗 pause 不再落到 core/player 的 pause → 报「pause 分支不再调 pause()」
  check('r5 pause 分支丢 void pause()', () => serviceInvariants(tamper(REAL_SERVICE,
    '      cancelResumePending()\n      void pause()',
    '      cancelResumePending()')),
  'pause 分支不再调 pause()')

  // r6 去重窗口清零（两条通路的重复投递不再被吞 = 一次按键跳两首）→ 报「切歌去重窗口被改动」
  check('r6 去重窗口清零', () => serviceInvariants(tamper(REAL_SERVICE,
    'const SKIP_DEDUP_WINDOW_MS = 100',
    'const SKIP_DEDUP_WINDOW_MS = 0')),
  '切歌去重窗口被改动')

  // r7 先写戳后判定（被丢弃项也刷新窗口）→ 报「先写戳后判定」
  check('r7 去重先写戳后判定', () => serviceInvariants(tamper(REAL_SERVICE,
    '  if (now - lastSkipCommandAt[command] < SKIP_DEDUP_WINDOW_MS) return true\n  lastSkipCommandAt[command] = now',
    '  lastSkipCommandAt[command] = now\n  if (now - lastSkipCommandAt[command] < SKIP_DEDUP_WINDOW_MS) return true')),
  '先写戳后判定')

  // r8 摘掉一支去重守卫（两条通路各跑一遍）→ 报「去重守卫不是 6 处」
  check('r8 摘掉 previous 去重守卫', () => serviceInvariants(tamper(REAL_SERVICE,
    "      if (shouldSuppressSkipCommand('previous')) break\n",
    '')),
  '去重守卫不是 6 处')

  // r9 seek 分支丢掉位置校验 → 报「不再校验位置类型」
  check('r9 seek 丢位置校验', () => serviceInvariants(tamper(REAL_SERVICE,
    "      if (typeof position != 'number') break\n",
    '')),
  '不再校验位置类型')

  // r10 漏斗不再续期交互时间 → 报「未调 markTimeoutExitInteraction」
  check('r10 漏斗丢 markTimeoutExitInteraction', () => serviceInvariants(tamper(REAL_SERVICE,
    'export const dispatchRemoteCommand = (command: string, position?: number) => {\n  markTimeoutExitInteraction()\n',
    'export const dispatchRemoteCommand = (command: string, position?: number) => {\n')),
  '未调 markTimeoutExitInteraction')

  // r11 适配器里又长出分支（两份实现各自漂移的老路）→ 报「又长出了处理逻辑」
  check('r11 适配器又长出分支', () => remoteCommandInvariants(tamper(REAL_REMOTE,
    'export default () => {\n  onRemoteCommand((event) => {',
    "export default () => {\n  const legacy = (command: string) => {\n    switch (command) {\n      case 'play':\n        break\n    }\n  }\n  void legacy\n  onRemoteCommand((event) => {")),
  '又长出了处理逻辑')

  // r12 适配器不再转手给漏斗 → 报「未把命令原样交给唯一漏斗」
  check('r12 适配器不再转手', () => remoteCommandInvariants(tamper(REAL_REMOTE,
    'dispatchRemoteCommand(event.command, event.position)',
    'void event.command')),
  '未把命令原样交给唯一漏斗')

  // r13 适配器丢掉 import → 报「未从 service.ts 引入漏斗」
  check('r13 适配器丢 import', () => remoteCommandInvariants(tamper(REAL_REMOTE,
    "import { dispatchRemoteCommand } from '@/plugins/player/service'\n",
    '')),
  '未从 service.ts 引入漏斗')

  // r14 别处又挂一条 RemotePause 监听 → 报「service.ts 之外」
  check('r14 别处又挂一条 RemotePause 监听', () => srcScanInvariants([
    { file: 'src/fake/other.ts', content: "TrackPlayer.addEventListener(TPEvent.RemotePause, () => {})\n" },
  ]), 'service.ts 之外')

  // r15 一次性安装守卫回魂 → 报「一次性守卫」
  check('r15 一次性守卫回魂', () => appDelegateInvariants(tamper(REAL_APPDELEGATE,
    '  if (LXInsideRemoteCommandHandler) return;\n',
    '  if (LXRemoteCommandHandlersInstalled) return;\n')),
  '一次性守卫')

  // r16 removeTarget:nil 清空命令 target → 报「removeTarget:nil」
  check('r16 removeTarget:nil 清空', () => appDelegateInvariants(tamper(REAL_APPDELEGATE,
    '  if (LXRemoteCommandTargetTokens[5] != nil) {\n    [commandCenter.changePlaybackPositionCommand removeTarget:LXRemoteCommandTargetTokens[5]];\n    LXRemoteCommandTargetTokens[5] = nil;\n  }\n',
    '  [commandCenter.changePlaybackPositionCommand removeTarget:nil];\n')),
  'removeTarget:nil')

  // r17 原生少装一个遥控处理器 → 报「遥控处理器缺失」
  check('r17 原生少装 previousTrack 处理器', () => appDelegateInvariants(tamper(REAL_APPDELEGATE,
    '[commandCenter.previousTrackCommand addTargetWithHandler:',
    '[commandCenter.unusedCommand addTargetWithHandler:')),
  'AppDelegate 遥控处理器缺失')

  // r18 handler 不置 in-handler 守卫（重装会摘掉此刻正在跑的 target）→ 报「不成对」
  check('r18 handler 不置守卫', () => appDelegateInvariants(tamper(REAL_APPDELEGATE,
    '  LXInsideRemoteCommandHandler = YES;\n  LXApplyNowPlayingInfo();',
    '  LXApplyNowPlayingInfo();')),
  '不成对')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-remote-command-single-source ===')
console.log('两条原生通路 → 一个 JS 漏斗：五段 RNTP 监听（含 RemoteSeek）+ 纯适配器 + 原生幂等自愈')
console.log()

const checks = [
  ['RNTP 通路 + 唯一漏斗（service.ts：五段监听全部交给 dispatchRemoteCommand）', () => serviceInvariants(REAL_SERVICE)],
  ['纯适配器（remoteCommand.ts 只转手，不长出第二份逻辑）', () => remoteCommandInvariants(REAL_REMOTE)],
  ['原生侧处理器 + 幂等自愈安装（AppDelegate.mm）', () => appDelegateInvariants(REAL_APPDELEGATE)],
  ['全 src 扫描（遥控事件名只出现在 service.ts）', () => srcScanInvariants(listSrcEntries())],
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
