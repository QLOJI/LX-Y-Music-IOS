#!/usr/bin/env node
/**
 * sim-nowplaying-card-status-text.js —— 第 50 轮第 1 条契约
 * 「卡片歌词区状态文案 + 逐行换行取消延迟」
 *
 * 需求原话（2026-10-11 第 50 轮第 1 条）：
 *   「锁屏和灵动岛界面在歌词区域增加歌曲链接获取中、歌曲加载中、缓存中等状态显示，因为我
 *     发现刚开始播放歌曲时，歌词区域是空白显示的，实际播放详情页的大歌词已经有歌词显示了
 *     或者歌曲还在加载，这个需要实时反馈到歌词区域，而且我发现歌曲在播放过程中，锁屏和
 *     灵动岛界面的歌词换行延迟太高了，取消延迟换行」
 *
 * 拆成两件事，本脚本各钉一组不变量：
 *  ⓐ 状态文案：详情页底部状态条（player__getting_url / player__loading / player__caching）
 *     只画在应用内，从不进 artist（卡片歌词区唯一字段）——起播放曲目时卡片歌词区一片空白，
 *     而详情页已经有歌词 / 状态在动。修法是把**同一个数据源**（store/player/action.ts 的
 *     setStatusText → global.state_event.playStateTextChanged）经新模块
 *     core/init/player/nowPlayingStatus.ts 转发给新桥 setNowPlayingStatusText；原生侧用
 *     一份 LXNowPlayingStatusText 覆盖 artist：
 *       非空 → 立即写 artist + 重发 + 重绘，此后 0.05s 时钟与 JS 逐行通路都让位（状态优先）；
 *       空   → 撤销覆盖，并把当前歌词行立即仲裁回来（有时间轴走 LXNowPlayingLyricStep）。
 *     三条守卫缺一不可：① 撤销必须仲裁回歌词行（否则状态消失后卡片空着，比不显示更糟）；
 *     ② 逐行快桥在状态期间必须让位（否则「缓存中…」被歌词行顶掉，等于状态根本没生效）；
 *     ③ 清卡（停止 / 退出）必须复位状态（否则「缓存中…」跨曲复活）。
 *  ⓑ 取消换行延迟：逐行文本此前要经 updateMetaData（发布前先取一次引擎位置快照 = 一次桥
 *     往返）→ 500ms 发布冷却 → updateNowPlayingInfo → 发布前仲裁。新通路让 JS 逐行钩子
 *     （与详情页大歌词**同一个** onLyricPlay 事件）把行文本一次轻量桥调用直接写 artist：
 *     setNowPlayingCurrentLine。位置无关，故不依赖原生时钟锚点健康度（冻结 / 停钟期间逐行
 *     通路照常准时）。原生时钟仍是行权威（0.05s 内按「绝不回退」仲裁纠偏），口径一字未改。
 *
 * 为什么必须靠契约脚本：「开关门控漏一处 / 顺序写反（先发管线再发快桥）/ 状态分支落在
 * 无歌词早退之后」这三类错误 tsc、eslint 一律无感，只在真机上表现为「关掉蓝牙歌词后
 * 「缓存中…」还挂在歌名下面」「无歌词的歌状态永远不显示」「换行还是慢半拍」。
 *
 * 运行：node scripts/sim-nowplaying-card-status-text.js
 * 退出码：不变量 A~E 全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** 去行注释与块注释：否则「把某行注释掉」的篡改会被当成仍然存在（NOTES-conventions 记过这个坑） */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 取某个函数 / 分支的源码切片；startAnchor 找不到返回 null */
const sliceFn = (code, startAnchor, endAnchor) => {
  const at = code.indexOf(startAnchor)
  if (at < 0) return null
  const end = code.indexOf(endAnchor, at + startAnchor.length)
  return code.slice(at, end < 0 ? code.length : end)
}

const F = {
  np: 'src/utils/nativeModules/nowPlaying.ts',
  status: 'src/core/init/player/nowPlayingStatus.ts',
  initIdx: 'src/core/init/player/index.ts',
  lyric: 'src/core/init/player/lyric.ts',
  action: 'src/store/player/action.ts',
  native: 'ios/LxMusicMobile/AppDelegate.mm',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

const BRIDGES = ['setNowPlayingStatusText', 'setNowPlayingCurrentLine']
const STATUS_SOURCE = "isShowBluetoothLyric() ? (playerState.statusText ?? '') : ''"
const FAST_LINE_CALL = "void setNowPlayingCurrentLine(lyric ?? '')"
const STATUS_BRANCH = 'if (LXNowPlayingStatusText.length > 0) {'
const STEP_EARLY_RETURN = 'if (LXNowPlayingLyricLines.count == 0) return;'
const HEARTBEAT = 'if (!paused && !LXNowPlayingClockHold && elapsedRefreshNowMs - LXNowPlayingElapsedRefreshAtMs >= 1000.0) {'
const POSITION_EVENT = 'postNotificationName:LXPlayerPositionNotificationName'

// ---------------------------------------------------------------------------
// 不变量 A：两条新桥（形态 / 能力守卫 / 接口声明）
// ---------------------------------------------------------------------------

const bridgeInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  for (const name of BRIDGES) {
    if (!code.includes(`export const ${name} = async`)) {
      reasons.push(`nowPlaying.ts 找不到导出 ${name}（第 50 轮的两条通路各要一条桥）`)
      continue
    }
    if (!code.includes(`if (!hasMethod('${name}')) return`)) {
      reasons.push(`${name} 未按 hasMethod 设防：安卓 / 旧包上会直接抛（既有五个桥全是这个形态）`)
    }
    if (!code.includes(`NowPlayingModule?.${name}?.(`)) {
      reasons.push(`${name} 未走可选链下发（原生未注册时要静默跳过，不能崩）`)
    }
    if (!new RegExp(`${name}\\?:\\s*\\(`).test(code)) {
      reasons.push(`NativeNowPlayingModule 接口缺 ${name} 的可选声明（TS 侧调用点会报类型错）`)
    }
  }

  // 状态文案桥的存在意义写在同一处：这是「与详情页状态条同源」这条契约的留痕，
  // 不留痕的下场是下一个改的人照着「再写一份状态机」加一套并行实现。
  if (!raw.includes('playStateTextChanged')) {
    reasons.push('nowPlaying.ts 没留下「状态文案与详情页状态条同源（playStateTextChanged）」的说明')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：转发器（数据源同源 / 开关门控 / 订阅边沿 / 无环导入）
// ---------------------------------------------------------------------------

const forwarderInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ⓑ-1 取值函数形态：默认开（undefined 视为开），与 init/player/lyric.ts 同口径
  if (!/const isShowBluetoothLyric = \(\) => settingState\.setting\['player\.isShowBluetoothLyric'\] \?\? true/.test(code)) {
    reasons.push('nowPlayingStatus.ts 未按「settingState.setting[...] ?? true」判定开关（默认开语义：'
      + 'undefined 应视为开；写成模块级快照则切换不生效）')
  }

  // ⓑ-2 状态文案必须与「显示蓝牙歌词」同门控：关闭时歌词区只该留歌名·歌手，
  //      「缓存中…」还顶在那里与开关语义自相矛盾（同一条 artist 字段）。
  if (!code.includes(STATUS_SOURCE)) {
    reasons.push("状态文案未按开关门控或数据源变了（必须是 isShowBluetoothLyric() ? (playerState.statusText ?? '') : ''，"
      + '与歌词区共用 artist 字段）')
  }

  // ⓑ-3 唯一的订阅边沿：详情页状态条的同一个出口
  if (!code.includes("global.state_event.on('playStateTextChanged', syncNowPlayingStatusText)")) {
    reasons.push('未订阅 playStateTextChanged：状态变化不会转发到卡片（只有初始化那一次）')
  }

  // ⓑ-4 首帧对齐 + 平台守卫
  const boot = sliceFn(code, 'export default () => {', null)
  if (boot == null) {
    reasons.push('缺少默认导出的初始化函数（init/player/index.ts 挂不上）')
  } else {
    if (!boot.includes("if (Platform.OS != 'ios') return")) {
      reasons.push('初始化未按平台设防（安卓上白订阅 / 白调用）')
    }
    if (!boot.includes('syncNowPlayingStatusText()')) {
      reasons.push('初始化没有首帧对齐（热重载 / 板块重挂载后 state 里的残留文案会漏发）')
    }
  }

  // ⓑ-5 不许 import ./lyric：lyric.ts 反过来 import 本模块，成环后初始化顺序在不同入口下
  //      不确定（本模块只需要一个设置取值函数，自己读 settingState 即可）
  if (/from '\.\/lyric'/.test(code)) {
    reasons.push('nowPlayingStatus.ts 从 ./lyric 取值：与 lyric.ts 形成环形导入，初始化顺序不确定')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：挂载与接线（index.ts 注册 + lyric.ts 两条调用）
// ---------------------------------------------------------------------------

const wiringInvariants = (initSrc, lyricSrc) => {
  const reasons = []
  const initCode = stripComments(initSrc)
  const lyricCode = stripComments(lyricSrc)

  // ⓒ-1 注册：import + 调用，且必须在 initLyric 之后（转发器要能立刻对齐到已建立的状态）
  if (!/import initNowPlayingStatus from '\.\/nowPlayingStatus'/.test(initCode)) {
    reasons.push('init/player/index.ts 未 import initNowPlayingStatus（转发器根本没挂上）')
  }
  const iLyric = initCode.indexOf('await initLyric(setting)')
  const iStatus = initCode.indexOf('initNowPlayingStatus()')
  if (iStatus < 0) {
    reasons.push('init/player/index.ts 未调用 initNowPlayingStatus()')
  } else if (iLyric < 0 || iStatus < iLyric) {
    reasons.push('initNowPlayingStatus() 发生在 initLyric 之前：歌词通路还没接好就对齐状态，首帧可能落空')
  }

  // ⓒ-2 lyric.ts 侧的两条接线
  if (!/import \{[^}]*setNowPlayingCurrentLine[^}]*\} from '@\/utils\/nativeModules\/nowPlaying'/.test(lyricCode)) {
    reasons.push('lyric.ts 未从 nowPlaying 桥引入 setNowPlayingCurrentLine（取消换行延迟的通路接不上）')
  }
  if (!/import \{ syncNowPlayingStatusText \} from '\.\/nowPlayingStatus'/.test(lyricCode)) {
    reasons.push('lyric.ts 未引入 syncNowPlayingStatusText（开关切换后状态文案与歌词区脱钩）')
  }

  // ⓒ-3 逐行钩子：快桥必须在 updateMetaData **之前**（顺序反了 = 延迟一分没省，
  //      仍是先走桥往返 + 500ms 冷却的那条管线）
  const hook = sliceFn(lyricCode, 'onLyricPlay((line, text) => {', 'global.app_event.on')
  if (hook == null) {
    reasons.push('lyric.ts 找不到 onLyricPlay 逐行钩子（详情页大歌词与卡片换行的共同事件源）')
  } else {
    const iFast = hook.indexOf(FAST_LINE_CALL)
    const iPipe = hook.indexOf('void updateMetaData(playerState.musicInfo, playerState.isPlay, lyric, true)')
    if (iFast < 0) {
      reasons.push('逐行钩子没有调 setNowPlayingCurrentLine：卡片换行仍要等元数据发布管线（用户报的「换行延迟太高」）')
    } else if (iPipe < 0) {
      reasons.push('逐行钩子丢了 updateMetaData 调用（歌词行不再走常规发布通路，暂停 / 重启后 artist 会停在旧行）')
    } else if (iFast > iPipe) {
      reasons.push('逐行快桥排在 updateMetaData 之后：延迟一分没省（前面仍要等一次位置快照桥往返 + 500ms 发布冷却）')
    }
  }

  // ⓒ-4 开关切换时状态文案也要对齐（末位调用）。上面的重发会把「真实行 / 空」写进
  //      歌词区，此刻若有状态文案，不重发就成了孤儿文本。
  const applyBody = sliceFn(lyricCode, 'export const applyBluetoothLyricSetting = () => {', '\nexport default')
  if (applyBody == null) {
    reasons.push('lyric.ts 找不到 applyBluetoothLyricSetting')
  } else if (!applyBody.includes('syncNowPlayingStatusText()')) {
    reasons.push('applyBluetoothLyricSetting 未对齐状态文案：切换开关后「缓存中…」会与歌词区状态不一致')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：原生（覆盖 / 让位 / 撤销仲裁 / 跨曲复位 / 顺序）
// ---------------------------------------------------------------------------

const nativeInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ⓓ-1 声明必须存在，且在使用它的函数之前（文件作用域静态变量先声明后使用）
  const declAt = code.indexOf('static NSString *LXNowPlayingStatusText = nil;')
  const setterAt = code.indexOf('static void LXSetNowPlayingStatusText(NSString *text) {')
  const stepAt = code.indexOf('static void LXNowPlayingLyricStep(void) {')
  if (declAt < 0) {
    reasons.push('原生缺 LXNowPlayingStatusText 声明（状态文案的覆盖位不存在）')
  } else {
    if (setterAt >= 0 && declAt > setterAt) reasons.push('LXNowPlayingStatusText 的声明落在写入它的函数之后（编译不过）')
    if (stepAt >= 0 && declAt > stepAt) reasons.push('LXNowPlayingStatusText 的声明落在歌词时钟之后（编译不过）')
  }

  // ⓓ-2 清卡必须复位：停止 / 退出后残留的「缓存中…」不能在下一次发布时复活
  const clear = sliceFn(code, 'static void LXClearNowPlayingInfo(void) {', 'static void LXHandleTrackPlayerLifecycleNotification')
  if (clear == null) {
    reasons.push('原生找不到 LXClearNowPlayingInfo')
  } else if (!clear.includes('LXNowPlayingStatusText = nil;')) {
    reasons.push('LXClearNowPlayingInfo 未复位状态文案：停止 / 退出后「缓存中…」会跨曲复活')
  }

  // ⓓ-3 写入函数：非空即覆盖 artist 并重发重绘；空则撤销覆盖并把当前行仲裁回来
  const setter = sliceFn(code, 'static void LXSetNowPlayingStatusText(NSString *text) {', 'static void LXSetNowPlayingCurrentLine')
  if (setter == null) {
    reasons.push('原生找不到 LXSetNowPlayingStatusText')
  } else {
    if (!setter.includes('LXNowPlayingInfoCache[MPMediaItemPropertyArtist] = LXNowPlayingStatusText;')) {
      reasons.push('状态文案没有写进 artist（卡片歌词区唯一字段，写别处看不见）')
    }
    if (!setter.includes('LXApplyNowPlayingInfo();') || !setter.includes('LXForceNowPlayingCardRepaint();')) {
      reasons.push('状态文案写入后未重发 / 未强制重绘（锁屏与灵动岛不会刷新）')
    }
    if (!setter.includes('if (LXNowPlayingLyricLines.count > 0 && LXNowPlayingLyricAnchorSystemMs > 0) {\n      LXNowPlayingLyricStep();')) {
      reasons.push('撤销覆盖时未把当前歌词行仲裁回来（状态消失后卡片空着，比不显示更糟）')
    }
    // 撤销只清「自己写过的那份」：不能误伤歌名 / 歌手这类非歌词文本
    if (!setter.includes('if (previous.length > 0 && [statusArtist isEqualToString:previous]) {')) {
      reasons.push('撤销覆盖未按「上一份确实是本函数写的状态文案」擦除（会误伤歌名 / 歌手）')
    }
  }

  // ⓓ-4 逐行快桥：状态期间让位 + 幂等
  const fast = sliceFn(code, 'static void LXSetNowPlayingCurrentLine(NSString *text) {', 'static void LXNowPlayingLyricStep(void) {')
  if (fast == null) {
    reasons.push('原生找不到 LXSetNowPlayingCurrentLine（逐行快桥没落到原生）')
  } else {
    if (!fast.includes('if (LXNowPlayingStatusText.length > 0) return;')) {
      reasons.push('逐行快桥在状态文案期间不让位：歌词行会把「缓存中…」顶掉，状态等于没生效')
    }
    if (!fast.includes('if ([currentArtist isEqualToString:line]) return;')) {
      reasons.push('逐行快桥未做同值去重（每拍重发 + 重绘 = 白耗电，第 42 轮省电口径）')
    }
    if (!fast.includes('LXApplyNowPlayingInfo();') || !fast.includes('LXForceNowPlayingCardRepaint();')) {
      reasons.push('逐行快桥写入后未重发 / 未重绘（卡片不会换行）')
    }
  }

  // ⓓ-5 时钟里的一拍：状态分支必须在 ~1Hz 心跳与前台位置事件**之后**（状态期间进度不失联），
  //      且在「无歌词早退」**之前**（起播阶段时间轴还没装载 / 无歌词的歌正是状态文案要覆盖的
  //      场景，落在早退之后 = 用户最需要它的那几秒永远看不到）
  const step = sliceFn(code, 'static void LXNowPlayingLyricStep(void) {', 'static void LXStartNowPlayingLyricTimer(void) {')
  if (step == null) {
    reasons.push('原生找不到 LXNowPlayingLyricStep')
    return reasons
  }
  const iStatusBranch = step.indexOf(STATUS_BRANCH)
  const iHeartbeat = step.indexOf(HEARTBEAT)
  const iPosition = step.indexOf(POSITION_EVENT)
  const iEarlyReturn = step.indexOf(STEP_EARLY_RETURN)

  if (iStatusBranch < 0) {
    reasons.push('歌词时钟里没有状态文案分支：0.05s 时钟仍会把时间轴行写回 artist，状态最多存活一拍')
  } else {
    if (iHeartbeat < 0) {
      reasons.push('歌词时钟丢了 ~1Hz 心跳（第 46 轮「每秒对表」）')
    } else if (iStatusBranch < iHeartbeat) {
      reasons.push('状态分支排在 ~1Hz 心跳之前并 return：状态期间进度条不再对表（第 46 轮修复回退）')
    }
    if (iPosition < 0) {
      reasons.push('歌词时钟丢了前台位置事件（进度条 4Hz 驱动源）')
    } else if (iStatusBranch < iPosition) {
      reasons.push('状态分支排在前台位置事件之前并 return：状态期间前台进度条不再刷新')
    }
    if (iEarlyReturn < 0) {
      reasons.push(`歌词时钟找不到「无歌词早退」（${STEP_EARLY_RETURN}）`)
    } else if (iStatusBranch > iEarlyReturn) {
      reasons.push('状态分支落在「无歌词早退」之后：起播阶段与无歌词的歌里，用户最需要状态的那几秒永远看不到')
    }
  }

  // ⓓ-6 两条桥都要在 NowPlayingModule 上导出（JS 调用静默失效 = 需求整个落空）
  for (const name of BRIDGES) {
    if (!code.includes(`RCT_REMAP_METHOD(${name},`)) {
      reasons.push(`NowPlayingModule 未导出 ${name}（JS 侧调用静默失效，需求整个落空）`)
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 E：数据源唯一出口（详情页状态条与卡片状态文案同源）
// ---------------------------------------------------------------------------

const statusSourceInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)
  const body = sliceFn(code, 'setStatusText(statusText: string) {', '\n  }')
  if (body == null) {
    reasons.push('store/player/action.ts 找不到 setStatusText')
    return reasons
  }
  if (!body.includes('state.statusText = statusText')) {
    reasons.push('setStatusText 不再写 state.statusText（卡片状态文案的数据源断了）')
  }
  if (!body.includes('global.state_event.playStateTextChanged(statusText)')) {
    reasons.push('setStatusText 不再广播 playStateTextChanged（详情页状态条与卡片状态文案一起失灵）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 反例：篡改真源码后必须被拦下（证明每条不变量真的在起作用）
// ---------------------------------------------------------------------------

const tamper = (src, from, to) => {
  if (!src.includes(from)) throw new Error(`反例锚点未命中: ${from.slice(0, 60)}`)
  return src.replace(from, to)
}

const cases = []

/** p1 逐行快桥不再让位状态（歌词行顶掉「缓存中…」） */
cases.push(['p1 快桥未在状态期间让位', () => {
  const broken = tamper(REAL.native, '    if (LXNowPlayingStatusText.length > 0) return;\n', '')
  return nativeInvariants(broken).some(r => r.includes('不让位'))
}])

/** p2 快桥缺同值去重（每拍重发重绘） */
cases.push(['p2 快桥缺同值去重', () => {
  const broken = tamper(REAL.native, '    if ([currentArtist isEqualToString:line]) return;\n', '')
  return nativeInvariants(broken).some(r => r.includes('同值去重'))
}])

/** p3 状态分支落进「无歌词早退」之后（起播阶段 / 无歌词的歌永远看不到状态） */
cases.push(['p3 状态分支落在无歌词早退之后', () => {
  const broken = tamper(REAL.native, `    ${STATUS_BRANCH}`,
    `    ${STEP_EARLY_RETURN}\n    ${STATUS_BRANCH}`)
  return nativeInvariants(broken).some(r => r.includes('无歌词早退'))
}])

/** p4 状态分支删掉（时钟下一拍就把状态顶回歌词行） */
cases.push(['p4 时钟里没有状态分支', () => {
  const broken = tamper(REAL.native, `    ${STATUS_BRANCH}\n`, '    if (NO) {\n')
  return nativeInvariants(broken).some(r => r.includes('没有状态文案分支'))
}])

/** p5 清卡不复位状态（「缓存中…」跨曲复活） */
cases.push(['p5 清卡未复位状态文案', () => {
  const broken = tamper(REAL.native, '    LXNowPlayingStatusText = nil;\n    LXClearNowPlayingLyricLines();', '    LXClearNowPlayingLyricLines();')
  return nativeInvariants(broken).some(r => r.includes('跨曲复活'))
}])

/** p6 撤销覆盖时不把当前行仲裁回来（状态消失后卡片空着） */
cases.push(['p6 撤销时未仲裁回歌词行', () => {
  const broken = tamper(REAL.native,
    '    if (LXNowPlayingLyricLines.count > 0 && LXNowPlayingLyricAnchorSystemMs > 0) {\n      LXNowPlayingLyricStep();\n      return;\n    }\n',
    '')
  return nativeInvariants(broken).some(r => r.includes('仲裁回来'))
}])

/** p7 JS 调用静默失效：原生没导出桥 */
cases.push(['p7 原生未导出状态桥', () => {
  const broken = tamper(REAL.native, 'RCT_REMAP_METHOD(setNowPlayingStatusText,', '// RCT_REMAP_METHOD(setNowPlayingStatusText,')
  return nativeInvariants(broken).some(r => r.includes('未导出'))
}])

/** j1 逐行快桥排在元数据发布之后（延迟一分没省） */
cases.push(['j1 快桥排在发布管线之后', () => {
  const broken = tamper(REAL.lyric,
    `      ${FAST_LINE_CALL}\n      if (playerState.playMusicInfo.musicInfo) {\n        void updateMetaData(playerState.musicInfo, playerState.isPlay, lyric, true)\n      }`,
    `      if (playerState.playMusicInfo.musicInfo) {\n        void updateMetaData(playerState.musicInfo, playerState.isPlay, lyric, true)\n      }\n      ${FAST_LINE_CALL}`)
  return wiringInvariants(REAL.initIdx, broken).some(r => r.includes('排在 updateMetaData 之后'))
}])

/** j2 逐行快桥整个丢失（换行仍走慢管线） */
cases.push(['j2 逐行钩子没有快桥', () => {
  const broken = tamper(REAL.lyric, `      ${FAST_LINE_CALL}\n`, '')
  return wiringInvariants(REAL.initIdx, broken).some(r => r.includes('没有调 setNowPlayingCurrentLine'))
}])

/** j3 开关切换后状态文案不对齐（孤儿文案） */
cases.push(['j3 apply 未对齐状态文案', () => {
  const broken = tamper(REAL.lyric, '  syncNowPlayingStatusText()\n}', '}')
  return wiringInvariants(REAL.initIdx, broken).some(r => r.includes('未对齐状态文案'))
}])

/** j4 转发器未挂载 */
cases.push(['j4 转发器未挂载', () => {
  const broken = tamper(REAL.initIdx, '  initNowPlayingStatus()\n', '')
  return wiringInvariants(broken, REAL.lyric).some(r => r.includes('未调用 initNowPlayingStatus'))
}])

/** j5 未订阅状态事件（只有初始化那一次转发） */
cases.push(['j5 未订阅 playStateTextChanged', () => {
  const broken = tamper(REAL.status, "  global.state_event.on('playStateTextChanged', syncNowPlayingStatusText)\n", '')
  return forwarderInvariants(broken).some(r => r.includes('未订阅 playStateTextChanged'))
}])

/** j6 状态文案不再按「显示蓝牙歌词」门控（关掉歌词开关后「缓存中…」仍顶在歌名下） */
cases.push(['j6 状态文案未门控', () => {
  const broken = tamper(REAL.status, STATUS_SOURCE, "(playerState.statusText ?? '')")
  return forwarderInvariants(broken).some(r => r.includes('未按开关门控'))
}])

/** j7 数据源唯一出口被改（详情页状态条与卡片一起失灵） */
cases.push(['j7 状态出口不再广播', () => {
  const broken = tamper(REAL.action, '    global.state_event.playStateTextChanged(statusText)\n', '')
  return statusSourceInvariants(broken).some(r => r.includes('不再广播'))
}])

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-nowplaying-card-status-text ===')
console.log('卡片歌词区状态文案（与详情页状态条同源 + 开关同门控 + 撤销回歌词行）+ 逐行换行取消延迟（第 50 轮第 1 条）')
console.log()

const checks = [
  ['两条新桥（形态 / hasMethod 守卫 / 可选链 / 接口声明）', () => bridgeInvariants(REAL.np)],
  ['转发器（同源数据 / 开关门控 / 订阅边沿 / 首帧对齐 / 无环导入）', () => forwarderInvariants(REAL.status)],
  ['挂载与接线（index.ts 注册 + lyric.ts 快桥与状态对齐）', () => wiringInvariants(REAL.initIdx, REAL.lyric)],
  ['原生（覆盖写入 + 逐行让位 + 撤销仲裁 / 跨曲复位 + 状态分支在心跳与位置事件之后、无歌词早退之前）', () => nativeInvariants(REAL.native)],
  ['数据源唯一出口（setStatusText → statusText + playStateTextChanged）', () => statusSourceInvariants(REAL.action)],
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
let ceOk = 0
for (const [name, fn] of cases) {
  let ok = false
  let detail = ''
  try {
    ok = fn() === true
    detail = ok ? '已拦下' : '未拦下（不变量没有真正起作用的判据）'
  } catch (e) {
    detail = `抛异常: ${e.message}`
  }
  if (ok) ceOk += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name} —— ${detail}`)
}

const allOk = invOk && ceOk === cases.length
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceOk}/${cases.length}）`)
process.exit(allOk ? 0 : 1)
