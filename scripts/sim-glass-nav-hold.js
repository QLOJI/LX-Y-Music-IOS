/**
 * 玻璃「转场按住门」契约（2026-10-11，第 61 轮第 3 条）。
 *
 * 用户原话：
 *   「越改越乱 … 当我右滑时，底部 tab 栏和迷你播放器栏透过的画面是由右向左滑入的，
 *     这个方向是反的，需要改。」
 *
 * 现象成因（本轮实锤）：返回转场期间玻璃是**活的**（第 52 / 56 / 58 轮拆掉了暂停、
 *   让它逐帧重采），而返回时玻璃背后其实还是**正在向右滑走的那一页**（页面向右走、
 *   玻璃不动）—— 采进胶囊的就是「透过的画面由右向左滑入」的反向流（第 58 / 59 轮报的
 *   「错位、延迟也很高」是同一现象）。
 *
 * 修法 = **整段转场按住玻璃**（保持转场前那一帧：对返回来说那就是底层页面自己的画面，
 *   它本来就是静止的，看起来才是贴着玻璃一起滑进来），转场结束由 JS 解除暂停、原生
 *   handleResumeFromPause 平滑收口（保留旧纹理 → 重采 → 立即画一帧，第 56 轮）。为此：
 *   · 转场窗口 push 与 pop **两侧共用**（navigation/transitionWindow.ts）：push 发起即开；
 *     pop 侧由三个 JS 返回入口在派发前开，**系统边缘返回手势不经过 JS**，只能等
 *     screenPopped 到达时**续期**（该事件可能落在转场开头也可能落在结尾）；
 *   · 第 52 轮的「露出门」整条删除（revealWindow.ts / navRevealing / NAV_REVEAL_* /
 *     revealBeforePop 的 32ms 让帧 / componentWillAppear 提前锚点）—— 它正是让玻璃在
 *     返回转场里逐帧重采的原因；
 *   · 原生删掉第 58 轮「被覆盖屏重新入窗口就无视 JS 的 paused 自行恢复渲染」那条通道
 *     （pauseRequested / resumeFromReentryIfPaused / resumedFromReentry / suspendWhileDetached
 *     / clearReentryResume）—— 返回开始时被覆盖屏的视图重新挂回窗口，它会在那一刻把 JS 的
 *     按住击穿；JS 的 paused 整段转场里值没变（React 不会重发 prop），所以只改 JS 挡不住它。
 *
 * 历史（别改回去）：2026-10-02 ~ 第 60 轮 pop 侧曾从「续期」改成「事件到达立即释放」，
 *   理由正是用户第 5 轮原话「底部透过的画面短暂刷新，突然变了一下」。本轮判断：按住显示的
 *   就是底层画面本身（通常与刷新后一致），代价远小于「整段转场反向流」；陈旧度门
 *   （maxStaleHoldAge = 150ms）与保纹理恢复机制已把末尾跳变压到最小。
 *
 * 本脚本钉住：
 *   A 转场窗口本体（transitionWindow.ts）：时长 350~700ms、开窗立即置位 + 续期先
 *     clearTimeout + 定时器是唯一关窗出口、模块不反向依赖 navigation（否则循环依赖）；
 *   B push 侧：startPush 里开窗，且 navigation.ts 里只有「开窗 + 续期」两处调用；
 *   C pop 三入口：pop / popTo / popToRoot 都经 holdTransitionBeforePop，且**不让帧**；
 *   D screenPopped = **续期**（不是「立即释放」，也不是绕过窗口模块直接置位）；
 *   E 状态管线：state 字段 + 初值、action 同值短路、stateEvent、hook 订阅/退订、
 *     core/common 的写入口；
 *   F 玻璃门与消费点：useGlassNavHold = 转场 ∧ 不拖页；两块玻璃的 paused 走玻璃门
 *     （不得直接喂账面门）、live 只有 pagerDragging 一个来源；账面 hook 本体不许动；
 *   G 原生：自恢复通道一个记号都不许留；didMoveToWindow 只做沉降窗口 + 实时采景窗口 +
 *     闸门复位 + 帧率同步（不许碰暂停态）；setPaused 保留「恢复时 handleResumeFromPause
 *     + isPaused = paused」这条收口；RN prop 落点仍在；
 *   H 反例自检：任一条被拆掉一点都必须拦下，且 tamper 锚点必须**唯一命中**（脚本自查）。
 *
 * 运行：node scripts/sim-glass-nav-hold.js
 *   （本机没有 node，真跑法用 %TEMP% 下的浏览器版迷你运行器（headless Edge/Chrome + python，
 *     不在仓库里）：
 *     python "C:\Users\Q\AppData\Local\Temp\lx-jsrun\run.py" scripts/sim-glass-nav-hold.js --brief）
 * 退出码：0 = 全部断言 + 全部反例通过；1 = 有任一项不合格。
 *
 * 声明：本脚本是**静态断言**（对源码文本做结构检查）。通过只代表源码形态符合约定，
 * 不代表能编译、更不代表真机观感 —— 本机没有 Xcode / 真机，Swift 与转场时序都无法验证。
 * 已知边界（写在这里免得被当成缺陷）：系统边缘返回手势只靠 screenPopped 续期，而
 * 「该事件是否真的在 pop 之前/之中到达」本机无法核实；若 RNN 7.39.2 压根不派发它，
 * 按住门就只剩按钮那条路径（退化到第 52 轮形态，不会更差）。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const F = {
  window: 'src/navigation/transitionWindow.ts',
  utils: 'src/navigation/utils.ts',
  nav: 'src/navigation/navigation.ts',
  index: 'src/navigation/index.ts',
  core: 'src/core/common.ts',
  state: 'src/store/common/state.ts',
  action: 'src/store/common/action.ts',
  event: 'src/event/stateEvent.ts',
  hook: 'src/store/common/hook.ts',
  glass: 'src/components/common/LiquidGlass.tsx',
  tabbar: 'src/components/layout/ModernTabBar.tsx',
  playerbar: 'src/components/player/PlayerBar/index.tsx',
  settingDetail: 'src/screens/SettingDetail/index.tsx',
  swiftView: 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassView.swift',
  swiftEffect: 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassEffectView.swift',
  swiftManager: 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassViewManager.mm',
}

const REAL = {}
for (const key of Object.keys(F)) REAL[key] = read(F[key])

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 取一个函数定义体（签名后首个 `{` 起到配平 `}` 止）。被解析的函数里注释不能含花括号。 */
const fnBody = (src, signatureRe) => {
  const m = signatureRe.exec(src)
  if (!m) return null
  const start = m.index + m[0].length
  let depth = 1
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(start, i)
    }
  }
  return null
}

/**
 * 去掉行注释后的源码。只用于「旧机制记号不得出现」这类检查：
 * 注释里写「本轮删掉了 navRevealing、为什么删」是文档（历史要留在源码里），
 * 只有**代码**里再引用旧机制才必须判红（否则契约会把说明文字当成违规）。
 * （iOS 的 `///` 也走这条：第一个 `//` 之前的内容保留。）
 */
const stripLineComments = (src) =>
  src
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//')
      return i >= 0 ? line.slice(0, i) : line
    })
    .join('\n')

const countOf = (text, needle) => text.split(needle).length - 1

/** 旧机制的记号（第 61 轮整体删除）。出现在**代码**里一律判红。 */
const DEAD_TOKENS = [
  'navRevealing',
  'useNavRevealing',
  'setNavRevealing',
  'NAV_REVEAL',
  'revealWindow',
  'revealBeforePop',
  'handleScreenWillAppear',
  'registerWillAppearAnchor',
]

const DEAD_NATIVE_TOKENS = [
  'resumeFromReentryIfPaused',
  'pauseRequested',
  'resumedFromReentry',
  'suspendWhileDetached',
  'clearReentryResume',
]

// ---------------------------------------------------------------------------
// A 转场窗口本体（navigation/transitionWindow.ts）
// ---------------------------------------------------------------------------

const windowInvariants = (f) => {
  const reasons = []
  const src = f.window

  // A1 时长：要罩住整段转场（RNN 系统默认 push/pop 转场 0.35s），也不能长到把恢复拖后
  const m = /export const NAV_TRANSITION_SETTLE_MS = (\d+)/.exec(src)
  if (!m) {
    reasons.push('transitionWindow 缺 NAV_TRANSITION_SETTLE_MS 常量（转场窗口没有时长）')
  } else {
    const ms = Number(m[1])
    if (!(ms >= 350)) {
      reasons.push('NAV_TRANSITION_SETTLE_MS=' + ms + ' 短于 iOS 系统默认转场 0.35s（罩不住整段转场 → 转场没结束玻璃就恢复渲染，反向流从缝里漏回来）')
    }
    if (!(ms <= 700)) {
      reasons.push('NAV_TRANSITION_SETTLE_MS=' + ms + ' 过长（转场早结束了玻璃还按着 → 返回后底层的变化要等这么久才透出来）')
    }
  }

  // A2 开窗/续期本体：续期 → 立即置位 → 挂定时器 → 到点复位
  const body = fnBody(src, /export const beginNavTransitionWindow = \(\)\s*=>\s*\{/)
  if (!body) {
    reasons.push('transitionWindow 缺 beginNavTransitionWindow（转场按住门没有开窗出口）')
  } else {
    const clearAt = body.indexOf('clearTimeout(navTransitionTimer)')
    const openAt = body.indexOf('setNavTransitioning(true)')
    const timerAt = body.indexOf('navTransitionTimer = setTimeout(')
    const closeAt = body.indexOf('setNavTransitioning(false)')
    if (!/if \(navTransitionTimer\) clearTimeout\(navTransitionTimer\)/.test(body)) {
      reasons.push('beginNavTransitionWindow 不再续期（重复调用会叠加多个定时器 → 先开的那个提前关窗，玻璃在转场中途恢复渲染）')
    } else if (!(clearAt >= 0 && openAt > clearAt)) {
      reasons.push('beginNavTransitionWindow 的续期没落在置位之前（旧定时器可能把本次开窗覆盖掉）')
    }
    if (!/commonActions\.setNavTransitioning\(true\)/.test(body)) {
      reasons.push('beginNavTransitionWindow 未立即置位（转场头几帧玻璃还在渲染 = 采到转场中间态）')
    }
    if (!/navTransitionTimer = setTimeout\(/.test(body)) {
      reasons.push('beginNavTransitionWindow 未挂关窗定时器（门永远开着，玻璃再也不省电）')
    }
    if (!/commonActions\.setNavTransitioning\(false\)/.test(body) || !/NAV_TRANSITION_SETTLE_MS/.test(body)) {
      reasons.push('beginNavTransitionWindow 的定时器没有按时长把门关上（门没有出口）')
    }
    if (openAt >= 0 && timerAt >= 0 && closeAt >= 0 && !(openAt < timerAt && timerAt < closeAt)) {
      reasons.push('beginNavTransitionWindow 语句顺序不对（应为：续期 → 立即置位 → 挂定时器 → 到点复位）')
    }
  }

  // A3 单点管理 + 叶子模块：反向依赖 navigation/* 就是循环依赖
  //（navigation.ts 与 navigation/utils.ts 都 import 本模块）
  if (!/import commonActions from '@\/store\/common\/action'/.test(src)) {
    reasons.push('transitionWindow 未从 @/store/common/action 引入写入口（setNavTransitioning 的宿主没了）')
  }
  if (/from '\.\/navigation'|from '\.\/utils'|from 'react-native-navigation'/.test(src)) {
    reasons.push('transitionWindow 反向依赖 navigation（navigation.ts / utils.ts 都 import 本模块 → 循环依赖）')
  }
  if (!/let navTransitionTimer/.test(src)) {
    reasons.push('transitionWindow 没有续期用的定时器句柄（无法 clearTimeout → 续期不成立）')
  }
  for (const bad of DEAD_TOKENS) {
    if (stripLineComments(src).includes(bad)) {
      reasons.push('transitionWindow 里出现旧机制记号 ' + bad + '（第 61 轮已整体删除，别加回来）')
    }
  }
  // 单一出口：不许再有「事件到达就立即关窗」的第二个出口（第 58～60 轮那条就是反向流的开关）
  if (/endNavTransitionWindow/.test(stripLineComments(src))) {
    reasons.push('transitionWindow 里又出现了 endNavTransitionWindow（第二个关窗出口 = 事件到达立即释放，反向流原地复发）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// B push 侧（navigation.ts）：startPush 开窗，全局只有「开窗 + 续期」两处
// ---------------------------------------------------------------------------

const pushSideInvariants = (f) => {
  const reasons = []
  const nav = f.nav

  if (!/import \{ beginNavTransitionWindow \} from '\.\/transitionWindow'/.test(nav)) {
    reasons.push('navigation.ts 未从 ./transitionWindow 引入 beginNavTransitionWindow')
  }
  const body = fnBody(nav, /const startPush = \(id: COMPONENT_IDS, options: StartPushOptions = \{\}\) => \{/)
  if (!body) {
    reasons.push('navigation.ts 缺 startPush（push 侧没有开窗入口）')
  } else if (!/beginNavTransitionWindow\(\)/.test(body)) {
    reasons.push('startPush 未开转场窗口（push 整段转场玻璃都在采「旧页滑走 + 新页盖上来」的中间态）')
  }

  const calls = countOf(stripLineComments(nav), 'beginNavTransitionWindow()')
  if (calls !== 2) {
    reasons.push('navigation.ts 里 beginNavTransitionWindow() 出现 ' + calls + ' 处（应为 2：startPush 开窗 + handleScreenPopped 续期；多出来的调用点要么是旧机制回来了、要么该同步改这份契约）')
  }
  if (/const NAV_TRANSITION_SETTLE_MS/.test(nav) || /let navTransitionTimer/.test(nav)) {
    reasons.push('navigation.ts 里又出现了转场窗口的常量/定时器（窗口必须单点管理，见 transitionWindow.ts）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// C pop 三入口（navigation/utils.ts）：先开窗、不让帧、再派发命令
// ---------------------------------------------------------------------------

const popEntryInvariants = (f) => {
  const reasons = []
  const utils = f.utils

  if (!/import \{ beginNavTransitionWindow \} from '\.\/transitionWindow'/.test(utils)) {
    reasons.push('navigation/utils 未从 ./transitionWindow 引入 beginNavTransitionWindow（三入口无从开窗）')
  }

  const body = fnBody(utils, /const holdTransitionBeforePop = <T>\(run: \(\) => Promise<T>\): Promise<T> => \{/)
  if (!body) {
    reasons.push('navigation/utils 缺 holdTransitionBeforePop（三入口没有共同的「先开窗、再派发」出口）')
  } else {
    const openAt = body.indexOf('beginNavTransitionWindow()')
    const runAt = body.indexOf('return run()')
    if (openAt < 0) {
      reasons.push('holdTransitionBeforePop 未开窗（返回时玻璃仍在渲染 → 透过的画面反向流原地复发）')
    } else if (runAt < 0 || openAt > runAt) {
      reasons.push('holdTransitionBeforePop 的开窗落在派发命令之后（顺序反了：命令先走，门还没开）')
    }
    // 按住门只需要 JS 状态先落，不需要让帧：第 52 轮那 32ms 让帧是给「提前复位重采」用的，
    // 露出门删掉后它只剩「返回被拖慢两帧」这一个效果（第 61 轮第 1 条正为此回滚）。
    if (/setTimeout|await|\.then\(/.test(body)) {
      reasons.push('holdTransitionBeforePop 里又出现让帧/异步等待（按住门不需要让帧，只会把返回拖慢）')
    }
  }

  for (const entry of [
    ['pop', 'Navigation.pop(compId)'],
    ['popToRoot', 'Navigation.popToRoot(compId)'],
    ['popTo', 'Navigation.popTo(compId)'],
  ]) {
    const call = entry[1].replace(/[()]/g, (c) => '\\' + c)
    const re = new RegExp('export const ' + entry[0] + ' = \\(compId: string\\) => holdTransitionBeforePop\\(\\(\\) => ' + call + '\\)')
    if (!re.test(utils)) {
      reasons.push('pop 三入口里的 ' + entry[0] + ' 不再经 holdTransitionBeforePop 开窗（返回时玻璃仍在渲染 → 反向流原地复发）')
    }
  }

  for (const bad of DEAD_TOKENS) {
    if (stripLineComments(utils).includes(bad)) {
      reasons.push('navigation/utils 里残留旧机制记号 ' + bad)
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// D screenPopped = 续期（navigation.ts）
// ---------------------------------------------------------------------------

const screenPoppedInvariants = (f) => {
  const reasons = []
  const body = fnBody(f.nav, /export const handleScreenPopped = \(componentId: string\) => \{/)
  if (!body) {
    reasons.push('navigation.ts 缺 handleScreenPopped（系统边缘返回手势没有 JS 锚点）')
  } else {
    if (!/beginNavTransitionWindow\(\)/.test(body)) {
      reasons.push('handleScreenPopped 未续期转场窗口（系统边缘返回手势不经过 JS 的 pop 三入口，这是那条路径唯一的开窗锚点 → 整段返回玻璃都在采正在滑走的那一页）')
    }
    if (/setNavTransitioning\(false\)/.test(body)) {
      reasons.push('handleScreenPopped 又改回「立即释放」（事件落在转场开头时玻璃从那一刻起恢复渲染 = 反向流；第 61 轮起这里必须续期）')
    }
    if (/setNavTransitioning\(true\)/.test(body)) {
      reasons.push('handleScreenPopped 绕过 beginNavTransitionWindow 直接置位（没有定时器兜底，门会一直开着）')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// E 状态管线（state / action / stateEvent / hook / core）
// ---------------------------------------------------------------------------

const statePipelineInvariants = (f) => {
  const reasons = []

  if (!/navTransitioning:\s*boolean/.test(f.state) || !/navTransitioning:\s*false\s*,/.test(f.state)) {
    reasons.push('store/common/state 缺 navTransitioning 字段或其初值不为 false')
  }

  const actionBody = fnBody(f.action, /setNavTransitioning\(transitioning: boolean\)\s*\{/)
  if (!actionBody) {
    reasons.push('store/common/action 缺 setNavTransitioning')
  } else {
    if (!/if \(state\.navTransitioning == transitioning\) return/.test(actionBody)) {
      reasons.push('setNavTransitioning 的同值短路被拆（门是布尔边沿，重复置位会让两块玻璃反复重渲染）')
    }
    if (!/global\.state_event\.navTransitioningUpdated\(transitioning\)/.test(actionBody)) {
      reasons.push('setNavTransitioning 不发 navTransitioningUpdated 事件（门永远不翻）')
    }
  }

  if (!/navTransitioningUpdated\(transitioning: boolean\)/.test(f.event) ||
      !/this\.emit\('navTransitioningUpdated', transitioning\)/.test(f.event)) {
    reasons.push('stateEvent 缺 navTransitioningUpdated 事件')
  }

  const hookBody = fnBody(f.hook, /export const useNavTransitioning = \(\)\s*=>\s*\{/)
  if (!hookBody || !/state_event\.on\('navTransitioningUpdated'/.test(hookBody) ||
      !/state_event\.off\('navTransitioningUpdated'/.test(hookBody)) {
    reasons.push('useNavTransitioning 未订阅/未退订 navTransitioningUpdated（SettingDetail 的返回防连点门也读它，不能删）')
  }
  if (!/export const setNavTransitioning = \(transitioning: boolean\)/.test(f.core)) {
    reasons.push('core/common 缺 setNavTransitioning（navigation 没有写入口）')
  }

  for (const key of ['state', 'action', 'event', 'hook', 'core', 'index', 'nav', 'utils']) {
    const code = stripLineComments(f[key])
    for (const bad of DEAD_TOKENS) {
      if (code.includes(bad)) {
        reasons.push(key + ' 里残留旧机制记号 ' + bad + '（第 61 轮已整体删除；露出门正是「返回时透过的画面反向流」的成因）')
      }
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// F 玻璃门与消费点
// ---------------------------------------------------------------------------

const glassGateInvariants = (f) => {
  const reasons = []

  const holdBody = fnBody(f.hook, /export const useGlassNavHold = \(\)\s*=>\s*\{/)
  if (!holdBody) {
    reasons.push('store/common/hook 缺 useGlassNavHold（玻璃没有转场按住门）')
  } else {
    if (!/useNavTransitioning\(\)/.test(holdBody)) {
      reasons.push('useGlassNavHold 不再读 useNavTransitioning（不跟转场走）')
    }
    if (!/usePagerDragging\(\)/.test(holdBody)) {
      reasons.push('useGlassNavHold 不再读 usePagerDragging（拖页让位没了：底层在横向移动、玻璃却钉着旧画面）')
    }
    if (!/return transitioning && !dragging/.test(holdBody)) {
      reasons.push('useGlassNavHold 不是「转场 ∧ 不拖页」（拖页让位被拆）：用户上手拖 Home Pager 时必须立刻恢复实时采景')
    }
  }

  const coveredBody = fnBody(f.hook, /export const useGlassCovered = \(componentId\?: string\)\s*=>\s*\{/)
  if (!coveredBody) {
    reasons.push('store/common/hook 缺 useGlassCovered（迷你播放器玻璃没有玻璃专用门）')
  } else {
    if (!/useScreenCovered\(componentId\)/.test(coveredBody)) {
      reasons.push('useGlassCovered 不再基于 useScreenCovered（账面覆盖判定被绕过）')
    }
    if (!/useGlassNavHold\(\)/.test(coveredBody)) {
      reasons.push('useGlassCovered 未并入转场按住门（返回转场里玻璃照旧采正在滑走的那一页）')
    }
    if (!/return covered \|\| navHold/.test(coveredBody)) {
      reasons.push('useGlassCovered 不是「账面门 ∨ 转场按住门」（两个来源都是暂停方向，必须是或）')
    }
  }

  const homeBody = fnBody(f.hook, /export const useGlassHomeCovered = \(\)\s*=>\s*\{/)
  if (!homeBody) {
    reasons.push('store/common/hook 缺 useGlassHomeCovered（Tab 栏两块玻璃没有玻璃专用门）')
  } else {
    if (!/useHomeCovered\(\)/.test(homeBody)) {
      reasons.push('useGlassHomeCovered 不再基于 useHomeCovered（账面覆盖判定被绕过）')
    }
    if (!/useGlassNavHold\(\)/.test(homeBody)) {
      reasons.push('useGlassHomeCovered 未并入转场按住门（返回转场里玻璃照旧采正在滑走的那一页）')
    }
    if (!/return covered \|\| navHold/.test(homeBody)) {
      reasons.push('useGlassHomeCovered 不是「账面门 ∨ 转场按住门」（两个来源都是暂停方向，必须是或）')
    }
  }

  // 账面门本体不许被改动/包装：它们还有非玻璃消费点（useAboveMiniPlayerBottom 的布局、
  // PlayingIcon 的动画门、tabBarCollapse 的布局），让它们跟着转场翻转会让布局跳一下。
  const rawHome = fnBody(f.hook, /export const useHomeCovered = \(\)\s*=>\s*\{/)
  if (!rawHome || !/String\(ids\[ids\.length - 1\]\?\.name\) !== COMPONENT_IDS\.home/.test(rawHome)) {
    reasons.push('useHomeCovered 本体被改动（非玻璃消费点依赖它，别拿它当玻璃门用）')
  }
  const rawScreen = fnBody(f.hook, /export const useScreenCovered = \(componentId\?: string\)\s*=>\s*\{/)
  if (!rawScreen || !/if \(!componentId\) return false/.test(rawScreen)) {
    reasons.push('useScreenCovered 本体被改动（除玻璃外还有布局消费点）')
  }

  // 消费点：paused 只喂玻璃门
  for (const [key, label] of [['tabbar', 'ModernTabBar'], ['playerbar', 'PlayerBar']]) {
    if (/paused=\{(screenCovered|homeCovered)\b/.test(f[key])) {
      reasons.push(label + ' 的 paused 直接喂账面门（账面门要等 screenPopped 才翻、也不看转场）')
    }
  }

  for (const p of [
    'paused={glassHomeCovered || collapsed || !appActive}',
    'paused={glassHomeCovered || !collapsed || !appActive}',
  ]) {
    if (!f.tabbar.includes(p)) {
      reasons.push('ModernTabBar 玻璃的 paused 不是预期形态（应为 ' + p + '）')
    }
  }
  if (!/const glassHomeCovered = useGlassHomeCovered\(\)/.test(f.tabbar)) {
    reasons.push('ModernTabBar 未接 useGlassHomeCovered（Tab 栏玻璃的覆盖判定不走玻璃门）')
  }
  const tabLive = countOf(f.tabbar, 'live={pagerDragging}')
  if (tabLive !== 2) {
    reasons.push('ModernTabBar 的 live 不是「只有 pagerDragging」一个来源（出现 ' + tabLive + ' 处，应为 2；转场门不得并入 live：按住期间不许采景）')
  }
  if (/live=\{[^}]*navTransitioning/.test(f.tabbar)) {
    reasons.push('ModernTabBar 的 live 又并入了 navTransitioning（按住门被击穿：转场期间仍在实时采景）')
  }

  if (!f.playerbar.includes('paused={glassCovered || !appActive}')) {
    reasons.push('PlayerBar 玻璃的 paused 不是预期形态（应为 paused={glassCovered || !appActive}）')
  }
  if (!/const glassCovered = useGlassCovered\(componentId\)/.test(f.playerbar)) {
    reasons.push('PlayerBar 未接 useGlassCovered(componentId)（迷你条玻璃的覆盖判定不走玻璃门）')
  }
  const pbLive = countOf(f.playerbar, 'live={pagerDragging}')
  if (pbLive !== 1) {
    reasons.push('PlayerBar 的 live 不是「只有 pagerDragging」一个来源（出现 ' + pbLive + ' 处，应为 1）')
  }
  const deps = f.playerbar.match(/\[glassOpacity,[^\]\n]*\]/)
  if (!deps || !/\bglassCovered\b/.test(deps[0])) {
    reasons.push('PlayerBar 的 useMemo 依赖未含 glassCovered（门翻转不会重建节点 → 返回时玻璃仍是暂停态）')
  }
  if (deps && /\bnavTransitioning\b/.test(deps[0])) {
    reasons.push('PlayerBar 的 useMemo 依赖里又出现 navTransitioning（按住门由 useGlassCovered 内部消费，别在依赖里重复）')
  }

  // 组件文档：门在哪必须能从 prop 注释找到（下一个改它的人不用翻三个文件）
  if (!/transitionWindow\.ts/.test(f.glass) || !/useGlassNavHold/.test(f.glass)) {
    reasons.push('LiquidGlass 的 paused 文档没指向 transitionWindow.ts / useGlassNavHold')
  }
  if (!/useNavTransitioning\(\)/.test(f.settingDetail)) {
    reasons.push('SettingDetail 不再读 useNavTransitioning（那个消费点是 push 期间防返回连点，别顺手删掉）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// G 原生：不许再有「自行恢复渲染」的通道
// ---------------------------------------------------------------------------

const nativeInvariants = (f) => {
  const reasons = []
  const view = stripLineComments(f.swiftView)
  const effect = stripLineComments(f.swiftEffect)

  for (const bad of DEAD_NATIVE_TOKENS) {
    if (view.includes(bad)) {
      reasons.push('LiquidGlassView 里又出现 ' + bad + '（第 58 轮那条「被覆盖屏重新入窗口就无视 JS 的 paused 自行恢复渲染」的通道；留着它，JS 的按住门在返回开始的瞬间就被击穿 → 透过的画面反向流）')
    }
  }
  for (const bad of ['pauseRequested', 'clearReentryResume']) {
    if (effect.includes(bad)) {
      reasons.push('LiquidGlassEffectView 里又出现 ' + bad + '（同上：自恢复的记账不许回来）')
    }
  }

  const didMove = fnBody(view, /override func didMoveToWindow\(\)\s*\{/)
  if (!didMove) {
    reasons.push('LiquidGlassView 缺 didMoveToWindow（沉降窗口 / 实时采景窗口的锚点）')
  } else {
    if (!/beginCaptureSettleWindow\(\)/.test(didMove)) {
      reasons.push('didMoveToWindow 未开沉降窗口（重新入窗口最初几帧的半成品会被原样采进来）')
    }
    if (!/reentryLiveStartedAt = CACurrentMediaTime\(\)/.test(didMove) || !/scheduleReentryLiveExpiry\(\)/.test(didMove)) {
      reasons.push('didMoveToWindow 未开实时采景窗口（重新入窗口最初几拍采景会滞后）')
    }
    if (!/Self\.resetGlobalCaptureGate\(\)/.test(didMove)) {
      reasons.push('didMoveToWindow 未复位全局采景闸门（转场第一拍采到的是旧画面）')
    }
    if (!/syncRenderFrameRate\(\)/.test(didMove)) {
      reasons.push('didMoveToWindow 未同步渲染帧率档')
    }
    if (/isPaused|handleResumeFromPause/.test(didMove)) {
      reasons.push('didMoveToWindow 又在改暂停态（第 61 轮起暂停态只能由 JS 的 paused prop 决定）')
    }
    if (!/guard window != nil else \{ return \}/.test(didMove)) {
      reasons.push('didMoveToWindow 的移出窗口分支不是空操作（被覆盖时不该自行按停：JS 的门已经按着）')
    }
  }

  const setPaused = fnBody(effect, /@objc public func setPaused\(_ paused: Bool\)\s*\{/)
  if (!setPaused) {
    reasons.push('LiquidGlassEffectView 缺 setPaused（RN prop 的落点）')
  } else {
    if (!/if !paused, liquidGlassView\?\.isPaused == true \{/.test(setPaused) || !/handleResumeFromPause\(\)/.test(setPaused)) {
      reasons.push('setPaused 丢掉了「恢复时先做一次性复位」（保留旧纹理 → 重采 → 立即画，第 56 轮）→ 转场末尾恢复时黑边 / 旧帧闪烁原地复发')
    }
    if (!/liquidGlassView\?\.isPaused = paused/.test(setPaused)) {
      reasons.push('setPaused 未把暂停态落到 MTKView.isPaused（JS 的门到不了渲染循环）')
    }
  }
  if (!/func handleResumeFromPause\(\)\s*\{/.test(view)) {
    reasons.push('LiquidGlassView 缺 handleResumeFromPause（恢复口子没了）')
  }
  if (!/RCT_CUSTOM_VIEW_PROPERTY\(paused, NSNumber, LGLiquidGlassHostView\)/.test(stripLineComments(f.swiftManager))) {
    reasons.push('LiquidGlassViewManager 的 paused prop 落点被改动（RN 的 paused 到不了原生）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

const assertions = [
  { name: 'A 转场窗口本体（时长 350~700ms / 开窗立即置位 / 续期先 clearTimeout / 定时器唯一出口 / 叶子模块）', hits: windowInvariants(REAL) },
  { name: 'B push 侧（startPush 开窗；navigation.ts 里只有「开窗 + 续期」两处调用）', hits: pushSideInvariants(REAL) },
  { name: 'C pop 三入口（pop / popToRoot / popTo 都先开窗、不让帧、再派发 Navigation.*）', hits: popEntryInvariants(REAL) },
  { name: 'D screenPopped = 续期（不是立即释放、也不绕过窗口模块）', hits: screenPoppedInvariants(REAL) },
  { name: 'E 状态管线（state 字段 + 初值 / action 同值短路 / stateEvent / hook 订阅退订 / core 写入口）', hits: statePipelineInvariants(REAL) },
  { name: 'F 玻璃门（转场 ∧ 不拖页）+ 消费点（paused 走玻璃门、live 只有 pagerDragging）', hits: glassGateInvariants(REAL) },
  { name: 'G 原生（自恢复通道零残留；didMoveToWindow 不碰暂停态；setPaused 保留恢复收口）', hits: nativeInvariants(REAL) },
]

// ---------------------------------------------------------------------------
// H 反例自检
// ---------------------------------------------------------------------------

/**
 * 篡改一份源码。锚点用字符串时**必须是唯一命中**（String.replace 只换第一处：
 * 锚点若出现在两处，用例实际改的未必是你想改的那一处 —— 反例就成了摆设）。
 */
const mut = (key, find, replace) => {
  if (typeof find === 'string') {
    const n = countOf(REAL[key], find)
    if (n !== 1) {
      throw new Error('tamper 锚点在 ' + key + ' 里出现 ' + n + ' 次（必须唯一）：' + find.slice(0, 60))
    }
  }
  const out = REAL[key].replace(find, replace)
  if (out === REAL[key]) throw new Error('tamper 锚点未命中: ' + String(find).slice(0, 70))
  const files = { ...REAL }
  files[key] = out
  return files
}

const counterExamples = []
const CE = (name, fn, makeFiles, expectSubstr) => {
  let files
  try {
    files = makeFiles()
  } catch (e) {
    counterExamples.push({ name, ok: false, detail: e.message })
    return
  }
  let reasons = []
  try {
    reasons = fn(files)
  } catch (e) {
    counterExamples.push({ name, ok: false, detail: '抛异常: ' + e.message })
    return
  }
  const hit = reasons.some((r) => r.includes(expectSubstr))
  counterExamples.push({ name, ok: hit, detail: hit ? '已拦下' : '未拦下（reasons=' + JSON.stringify(reasons) + '）' })
}

// —— 转场窗口本体 ——
CE('H1 窗口时长被改短（罩不住整段转场，玻璃在转场中途恢复渲染）', windowInvariants, () => mut('window',
  'export const NAV_TRANSITION_SETTLE_MS = 420',
  'export const NAV_TRANSITION_SETTLE_MS = 200'), '短于 iOS 系统默认转场')

CE('H2 续期不再 clearTimeout（重复开窗叠加定时器 → 先开的那个提前关窗）', windowInvariants, () => mut('window',
  '  if (navTransitionTimer) clearTimeout(navTransitionTimer)\n',
  ''), '不再续期')

CE('H3 开窗不再立即置位（转场头几帧玻璃还在渲染）', windowInvariants, () => mut('window',
  '  commonActions.setNavTransitioning(true)\n',
  ''), '未立即置位')

CE('H4 关窗定时器被拆（门永远开着，玻璃再也不省电）', windowInvariants, () => mut('window',
  '  navTransitionTimer = setTimeout(() => {\n    navTransitionTimer = null\n    commonActions.setNavTransitioning(false)\n  }, NAV_TRANSITION_SETTLE_MS)',
  '  void NAV_TRANSITION_SETTLE_MS'), '未挂关窗定时器')

CE('H5 窗口模块反向依赖 navigation（循环依赖：navigation.ts / utils.ts 都 import 它）', windowInvariants, () => mut('window',
  "import commonActions from '@/store/common/action'",
  "import commonActions from '@/store/common/action'\nimport { Navigation } from 'react-native-navigation'"), '反向依赖 navigation')

CE('H6 又加回「事件到达立即关窗」的第二个出口', windowInvariants, () => mut('window',
  'export const NAV_TRANSITION_SETTLE_MS = 420',
  'export const NAV_TRANSITION_SETTLE_MS = 420\nexport const endNavTransitionWindow = () => { commonActions.setNavTransitioning(false) }'), 'endNavTransitionWindow')

// —— push / pop 侧 ——
CE('H7 startPush 不再开窗（push 整段转场都在采中间态）', pushSideInvariants, () => mut('nav',
  '  beginNavTransitionWindow()\n  // 安全兜底',
  '  // 安全兜底'), 'startPush 未开转场窗口')

CE('H8 pop 入口不再开窗（直连 Navigation.pop）', popEntryInvariants, () => mut('utils',
  'export const pop = (compId: string) => holdTransitionBeforePop(() => Navigation.pop(compId))',
  'export const pop = (compId: string) => Navigation.pop(compId)'), 'pop 三入口里的 pop')

CE('H9 popToRoot 入口不再开窗', popEntryInvariants, () => mut('utils',
  'export const popToRoot = (compId: string) => holdTransitionBeforePop(() => Navigation.popToRoot(compId))',
  'export const popToRoot = (compId: string) => Navigation.popToRoot(compId)'), 'pop 三入口里的 popToRoot')

CE('H10 三入口里又插回让帧（第 52 轮那 32ms 让帧已随露出门删除）', popEntryInvariants, () => mut('utils',
  '  beginNavTransitionWindow()\n  return run()',
  '  beginNavTransitionWindow()\n  setTimeout(() => { void 0 }, 32)\n  return run()'), '让帧/异步等待')

CE('H11 screenPopped 改回「立即释放」（事件落在转场开头 → 玻璃从那一刻起采正在滑走的那一页）', screenPoppedInvariants, () => mut('nav',
  '  beginNavTransitionWindow()\n  if (target) endPush(target.name)',
  '  commonActions.setNavTransitioning(false)\n  if (target) endPush(target.name)'), '未续期转场窗口')

// —— 玻璃门 ——
CE('H12 拖页让位被拆（useGlassNavHold 只跟转场走：拖 Home Pager 时玻璃钉着旧画面）', glassGateInvariants, () => mut('hook',
  'return transitioning && !dragging',
  'return transitioning'), '拖页让位被拆')

CE('H13 useGlassNavHold 不再读拖页信号', glassGateInvariants, () => mut('hook',
  '  const dragging = usePagerDragging()',
  '  const dragging = false'), '不再读 usePagerDragging')

CE('H14 玻璃门退化成账面门别名（返回转场里照旧采正在滑走的那一页）', glassGateInvariants, () => mut('hook',
  /return covered \|\| navHold/g,
  'return covered'), '不是「账面门 ∨ 转场按住门」')

CE('H15 PlayerBar 的 paused 又喂回账面门', glassGateInvariants, () => mut('playerbar',
  'paused={glassCovered || !appActive}',
  'paused={screenCovered || !appActive}'), '直接喂账面门')

CE('H16 Tab 栏某一块玻璃的 live 又并入转场门（按住期间仍在采景）', glassGateInvariants, () => mut('tabbar',
  'paused={glassHomeCovered || collapsed || !appActive} live={pagerDragging}',
  'paused={glassHomeCovered || collapsed || !appActive} live={pagerDragging || glassHomeCovered}'), 'live 不是「只有 pagerDragging」')

// —— 原生 ——
CE('H17 原生又塞回「重新入窗口自恢复渲染」的调用（JS 的按住门在返回开始的瞬间被击穿）', nativeInvariants, () => mut('swiftView',
  '        guard window != nil else { return }\n        beginCaptureSettleWindow()',
  '        guard window != nil else { return }\n        beginCaptureSettleWindow()\n        resumeFromReentryIfPaused()'), '又出现 resumeFromReentryIfPaused')

CE('H18 原生又塞回 pauseRequested 记账', nativeInvariants, () => mut('swiftView',
  '    private var reentryLiveStartedAt: TimeInterval = 0',
  '    var pauseRequested = false\n    private var reentryLiveStartedAt: TimeInterval = 0'), '又出现 pauseRequested')

CE('H19 didMoveToWindow 又开始自行恢复渲染', nativeInvariants, () => mut('swiftView',
  '        guard window != nil else { return }\n        beginCaptureSettleWindow()',
  '        guard window != nil else { return }\n        beginCaptureSettleWindow()\n        if isPaused { handleResumeFromPause() }'), '又在改暂停态')

CE('H20 setPaused 丢掉「恢复时一次性复位」（转场末尾恢复时黑边 / 旧帧闪烁）', nativeInvariants, () => mut('swiftEffect',
  '        if !paused, liquidGlassView?.isPaused == true {\n            liquidGlassView?.handleResumeFromPause()\n        }\n',
  ''), '丢掉了「恢复时先做一次性复位」')

// —— 旧机制残留 ——
CE('H21 旧机制记号残留（navRevealing 又被加回 state）', statePipelineInvariants, () => mut('state',
  '  navTransitioning: boolean\n',
  '  navTransitioning: boolean\n  navRevealing: boolean\n'), 'navRevealing')

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

let failed = 0

console.log('='.repeat(92))
console.log('玻璃转场按住门（navigation/transitionWindow.ts，2026-10-11 第 61 轮第 3 条）')
console.log('='.repeat(92))
console.log('  A 转场窗口本体：420ms（> 系统转场 0.35s）/ 开窗立即置位 / 续期先 clearTimeout / 定时器唯一出口')
console.log('  B push 侧：startPush 开窗（全文件只有「开窗 + 续期」两处调用）')
console.log('  C pop 三入口：pop / popToRoot / popTo 先开窗、不让帧、再派发 Navigation.*')
console.log('  D screenPopped：续期（系统边缘返回手势不经过 JS，这是那条路径唯一的锚点）')
console.log('  E 状态管线：state.navTransitioning + action 同值短路 + stateEvent + useNavTransitioning')
console.log('  F 玻璃门：useGlassNavHold = 转场 ∧ 不拖页；paused 走玻璃门；live 只有 pagerDragging')
console.log('  G 原生：自恢复通道零残留；didMoveToWindow 不碰暂停态；setPaused 保留恢复收口')
console.log('  H 反例自检：任一条被拆掉一点都必须拦下（锚点必须唯一命中，脚本自查）')
console.log()
console.log('='.repeat(92))
console.log('断言')
console.log('='.repeat(92))
for (const a of assertions) {
  const ok = a.hits.length === 0
  if (!ok) failed++
  console.log('  ' + (ok ? '✅' : '❌') + '  ' + a.name)
  for (const h of a.hits) console.log('        ' + h)
}
console.log()
console.log('='.repeat(92))
console.log('反例自检（修复被拆掉时必须拦下）')
console.log('='.repeat(92))
for (const c of counterExamples) {
  if (!c.ok) failed++
  console.log('  ' + (c.ok ? '✅' : '❌') + '  ' + c.name + (c.ok ? ' —— 已拦下' : '   ← 没拦住：' + c.detail))
}

const passed = assertions.filter((a) => a.hits.length === 0).length
const caught = counterExamples.filter((c) => c.ok).length
console.log()
console.log('结果：断言 ' + passed + '/' + assertions.length + ' 通过；反例 ' + caught + '/' + counterExamples.length + ' 拦下')
process.exit(failed ? 1 : 0)
