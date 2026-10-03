/**
 * sim-remote-command-single-source.js
 *
 * 「车机 / 方向盘 / 控制中心的遥控命令必须**只有一条处理通路**（且切歌带去重）」
 * 契约不变量（第 20 轮，2026-10-03）。
 *
 * 用户实锤（越狱 CarPlay）：用车机方向盘「下一曲」时只在少数几首之间来回循环；
 * 用 App 内按钮则正常。
 *
 * 根因：同一批 MPRemoteCommandCenter 命令被挂了两套 target：
 *   ① RNTP 原生侧（SwiftAudioEx RemoteCommandController）→ RNTP 事件 remote-next 等
 *      → src/plugins/player/service.ts；
 *   ② 本工程原生侧（AppDelegate.mm LXInstallRemoteCommandHandlers）→ LXRemoteCommand
 *      通知 → UtilsModule 'remote-command' 事件 → core/init/player/remoteCommand.ts。
 * 一次物理按键两条通路各跑一遍 playNext() ⇒ 一次跳两首（短列表就成了「在少数几首
 * 之间循环」）；播放/暂停则是开关两下互相抵消；控制中心进度条重复 seek。
 *
 * 修法：
 *   - service.ts 里删掉 RemotePlay/RemotePause/RemoteNext/RemotePrevious/RemoteSeek 的
 *     重复监听，只保留 RNTP 独有的 RemoteDuck（来电/路由打断）与 RemoteStop；
 *   - 唯一入口 remoteCommand.ts 的上一曲/下一曲加「在途去重」，兜住车机重复投递
 *     （真实连按间隔 ≥100ms ≫ 一次切歌处理时间，不会吞掉用户操作）；
 *   - 用户手动播放/暂停所需的 cancelResumePending（作废「被抢占自动续播」标记）
 *     由 service.ts 导出、在 remoteCommand.ts 的 play/pause/toggle 分支调用 ——
 *     不能改挂 app_event 'pause'（缓冲时的暂停也发那个事件，会误清标记）。
 *
 * 本脚本从源码抽取真实写法做断言，并带反例自检（通路重复这类回归 tsc/eslint 无感：
 * 原生不参与 TS 检查、多一条监听也不报错，只表现为「一次按键跳两首」）。
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

// ---------------------------------------------------------------------------
// 不变量 A：service.ts 只剩 RNTP 独有的两条监听，且语义未动
// ---------------------------------------------------------------------------

const serviceInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // ① 重复监听删净：五个旧事件名不得再出现（任何拼法）
  for (const dead of ['RemotePlay', 'RemotePause', 'RemoteNext', 'RemotePrevious', 'RemoteSeek']) {
    if (code.includes(dead)) {
      reasons.push(`重复通路未删净（service.ts 仍在监听 ${dead} —— 一次物理按键会被两条通路各处理一遍）`)
    }
  }

  // ② 只保留 RemoteStop / RemoteDuck 两条，且恰好两条
  const tokens = code.match(/TPEvent\.(Remote\w+)/g) ?? []
  const names = tokens.map(t => t.replace('TPEvent.', ''))
  if (!names.includes('RemoteStop') || !names.includes('RemoteDuck')) {
    reasons.push('RNTP 独有监听丢失（RemoteDuck 来电/路由打断、RemoteStop 停止退出必须保留）')
  }
  if (names.length !== 2) {
    reasons.push(`service.ts 的 RNTP 监听未收敛到 2 条（实测 ${names.length} 条：${names.join(' / ')}）`)
  }

  // ③ RemoteDuck 语义（自动续播 / 音量恢复的兜底，不能随删监听一起丢）
  const duckBody = extractBracedBody(code, 'TrackPlayer.addEventListener(TPEvent.RemoteDuck, ({ permanent, paused, ducking }) =>')
  if (!duckBody) {
    reasons.push('RemoteDuck 处理体缺失或抽取失败（锚点漂移）')
  } else {
    for (const [needle, label] of [
      // 第 21 轮·优化 1：待恢复记录的判据从「瞬间 isPlay 快照」换成「最近 3s 确实在播」
      // 时间窗（车机蓝牙下导航播报会先触发路由暂停，isPlay 已被置 false；快照会漏记意图）
      ['shouldResumeAfterDuck ||= wasPlayingRecently()', 'iOS 音量闪避的待恢复记录（最近 3s 在播时间窗）'],
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

  // ⑤ cancelResumePending 必须导出（唯一入口 remoteCommand.ts 需要它），且语义完整
  if (!code.includes('export const cancelResumePending = () =>')) {
    reasons.push('cancelResumePending 未导出（唯一入口拿不到它 —— 用户手动暂停后会被「被抢占自动续播」兜底逻辑误拉起）')
  }
  const cancelBody = extractBracedBody(code, 'cancelResumePending = () =>')
  if (!cancelBody) {
    reasons.push('cancelResumePending 缺失或抽取失败（锚点漂移）')
  } else {
    for (const needle of ['shouldResumeAfterDuck = false', 'resumeRetryCount = 0', 'clearResumeTimer()']) {
      if (!cancelBody.includes(needle)) reasons.push(`cancelResumePending 语义被改动（缺 ${needle}）`)
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：remoteCommand.ts 是唯一入口，六个命令全覆盖 + 切歌在途去重
// ---------------------------------------------------------------------------

const remoteCommandInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // ① 唯一入口：onRemoteCommand 订阅恰好 1 处
  const subs = (code.match(/onRemoteCommand\(\(event\)/g) ?? []).length
  if (subs !== 1) {
    reasons.push(`唯一入口未收敛（onRemoteCommand 订阅出现 ${subs} 处，应恰好 1 处）`)
  }

  // ② 六个命令全覆盖（少一个 = 车机对应按键静默失效）
  for (const cmd of ['play', 'pause', 'toggle', 'next', 'previous', 'seek']) {
    if (!code.includes(`case '${cmd}':`)) {
      reasons.push(`遥控命令覆盖不全（缺 case '${cmd}'）`)
    }
  }

  // ③ 用户手动播放/暂停：作废「被抢占自动续播」标记（play / pause / toggle 各一次）
  if (!code.includes("import { cancelResumePending } from '@/plugins/player/service'")) {
    reasons.push('cancelResumePending 未从 service.ts 引入（手动播放/暂停清理不到待续播标记）')
  }
  const cancelCalls = (code.match(/cancelResumePending\(\)/g) ?? []).length
  if (cancelCalls !== 3) {
    reasons.push(`用户手动播放/暂停未作废续播标记（cancelResumePending() 出现 ${cancelCalls} 处，应为 3：play / pause / toggle）`)
  }

  // ④ 切歌在途去重：100ms 窗口，只作用于 next / previous
  if (!code.includes('const SKIP_DEDUP_WINDOW_MS = 100')) {
    reasons.push('切歌去重窗口缺失或被改动（应为 100ms —— 真实连按间隔 ≥100ms，窗口内判为重复投递）')
  }
  if (!code.includes("if (shouldSuppressSkipCommand('next')) break") ||
      !code.includes("if (shouldSuppressSkipCommand('previous')) break")) {
    reasons.push('切歌去重未接（next / previous 分支缺 shouldSuppressSkipCommand 守卫 —— 车机重复投递仍会一次跳两首）')
  }
  // 去重不得溢出到其他分支：判定函数只允许被调用 2 次（定义处是「= (command」，不计入）
  const supCalls = (code.match(/shouldSuppressSkipCommand\(/g) ?? []).length
  if (supCalls !== 2) {
    reasons.push(`切歌去重作用域漂移（shouldSuppressSkipCommand( 出现 ${supCalls} 处，应为 2：仅 next / previous）`)
  }
  // 每方向独立时间戳：next 与 previous 共用一个戳会误并「下一曲→上一曲」的快速切换
  if (!code.includes("Record<'next' | 'previous', number>")) {
    reasons.push('切歌去重未按方向分记时间戳（next / previous 共用一个戳会误并快速的反向切换）')
  }
  // 先判定、后写戳：被丢弃的重复项不得刷新窗口，否则持续投递会把窗口无限延长
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

  // ⑤ 交互标记：任何遥控命令都要续期「超时退出」交互时间
  if (!code.includes('markTimeoutExitInteraction()')) {
    reasons.push('遥控命令未调 markTimeoutExitInteraction（超时退出可能在遥控操作中途触发）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：原生侧六个处理器 + 转发链路仍在（唯一入口的另一半）
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
      reasons.push(`AppDelegate 遥控处理器缺失（${cmd} 未安装 target，车机/控制中心该键会静默失效）`)
    }
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
// 不变量 D：全 src 扫描 —— 除 service.ts 保留的两条外，不许任何文件再出现遥控事件名
// ---------------------------------------------------------------------------

const srcScanInvariants = (entries) => {
  const reasons = []
  const deadPattern = /\bRemote(Play|Pause|Next|Previous|Seek)\b/
  for (const { file, content } of entries) {
    const m = stripComments(content).match(deadPattern)
    if (m) {
      reasons.push(`重复通路残留（${file} 里仍有 ${m[0]} —— 遥控命令必须只有 remoteCommand.ts 一条 JS 处理通路）`)
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

  // r1 把 RNTP 的重复监听加回来 → 报「重复通路未删净」
  check('r1 重复监听加回 service.ts', () => serviceInvariants(tamper(REAL_SERVICE,
    '  initUnifiedPlayerController()\n',
    '  initUnifiedPlayerController()\n  TrackPlayer.addEventListener(TPEvent.RemoteNext, () => {})\n')),
  '重复通路未删净')

  // r2 cancelResumePending 不再导出 → 报「未导出」
  check('r2 cancelResumePending 收回导出', () => serviceInvariants(tamper(REAL_SERVICE,
    'export const cancelResumePending = () => {',
    'const cancelResumePending = () => {')),
  'cancelResumePending 未导出')

  // r3 去重窗口清零 → 报「窗口缺失或被改动」
  check('r3 去重窗口清零', () => remoteCommandInvariants(tamper(REAL_REMOTE,
    'const SKIP_DEDUP_WINDOW_MS = 100',
    'const SKIP_DEDUP_WINDOW_MS = 0')),
  '切歌去重窗口缺失或被改动')

  // r4 摘掉上一曲的去重守卫 → 报「去重未接」
  check('r4 摘掉 previous 去重守卫', () => remoteCommandInvariants(tamper(REAL_REMOTE,
    "        if (shouldSuppressSkipCommand('previous')) break\n",
    '')),
  '切歌去重未接')

  // r5 先写戳后判定（被丢弃项也刷新窗口）→ 报「先写戳后判定」
  check('r5 去重先写戳后判定', () => remoteCommandInvariants(tamper(REAL_REMOTE,
    '  if (now - lastSkipCommandAt[command] < SKIP_DEDUP_WINDOW_MS) return true\n  lastSkipCommandAt[command] = now',
    '  lastSkipCommandAt[command] = now\n  if (now - lastSkipCommandAt[command] < SKIP_DEDUP_WINDOW_MS) return true')),
  '切歌去重先写戳后判定')

  // r6 用户手动暂停不再作废续播标记 → 报「未作废续播标记」
  check('r6 pause 分支丢 cancelResumePending', () => remoteCommandInvariants(tamper(REAL_REMOTE,
    '      case \'pause\':\n        // 用户手动要求暂停：清除自动续播标记，避免之后被兜底逻辑误自动播放\n        cancelResumePending()\n        void pause()',
    '      case \'pause\':\n        void pause()')),
  '用户手动播放/暂停未作废续播标记')

  // r7 删掉一个命令 case（seek）→ 报「覆盖不全」
  check('r7 删掉 seek 分支', () => remoteCommandInvariants(tamper(REAL_REMOTE,
    '      case \'seek\':\n        if (typeof event.position == \'number\') {\n          global.app_event.setProgress(event.position)\n        }\n        break\n',
    '')),
  '遥控命令覆盖不全')

  // r8 原生少装一个遥控处理器 → 报「遥控处理器缺失」
  check('r8 原生少装 previousTrack 处理器', () => appDelegateInvariants(tamper(REAL_APPDELEGATE,
    '[commandCenter.previousTrackCommand addTargetWithHandler:',
    '[commandCenter.unusedCommand addTargetWithHandler:')),
  'AppDelegate 遥控处理器缺失')

  // r9 其他文件里又长出一条遥控事件监听 → 报「重复通路残留」
  check('r9 别处又挂一条 RemotePause 监听', () => srcScanInvariants([
    { file: 'src/fake/other.ts', content: "TrackPlayer.addEventListener(TPEvent.RemotePause, () => {})\n" },
  ]), '重复通路残留')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-remote-command-single-source ===')

const checks = [
  ['单一通路（service.ts 只剩 RemoteStop / RemoteDuck）', () => serviceInvariants(REAL_SERVICE)],
  ['唯一入口（remoteCommand.ts 六命令覆盖 + 切歌去重）', () => remoteCommandInvariants(REAL_REMOTE)],
  ['原生侧处理器与转发链路（AppDelegate.mm）', () => appDelegateInvariants(REAL_APPDELEGATE)],
  ['全 src 扫描（无第二处遥控事件监听）', () => srcScanInvariants(listSrcEntries())],
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
