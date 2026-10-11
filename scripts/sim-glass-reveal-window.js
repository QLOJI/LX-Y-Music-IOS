/**
 * 玻璃「露出门」契约（2026-10-11，第 52 轮第 2 条）。
 *
 * 用户原话：
 *   「当我返回主界面或者从某个界面返回到有底部 tab 栏和迷你播放器栏的界面时，
 *     底部 tab 栏和迷你播放器栏会在返回动画结束时出现一瞬间闪烁，然后透过的画面
 *     才刷新新的透过画面，这个问题之前也一直存在，要保证不要有瞬间闪烁，透过的
 *     画面要在返回动画之前就实时显示，总之透过画面要实时显示底部画面，不要出现
 *     突然或者延迟的变化，因为很明显。」
 *
 * 成因：底部两块液态玻璃的省电门读的是**账本**（commonState.componentIds，见
 *   useScreenCovered / useHomeCovered），栈顶不是自己就暂停原生 Metal 逐帧渲染；
 *   而账本只在 RNN 的 screenPopped 到达时才翻，该事件**晚于用户按下返回**
 *   （可能落在返回转场开头，也可能落在结尾——两种时序见 navigation.ts 的注释）。
 *   于是在这段缝里：玻璃保持暂停 → CAMetalLayer 留着暂停前那一帧（push 之前的画面）
 *   → 返回动画把玻璃一路露出来时透过的还是那张陈旧纹理 → 事件到达才走
 *   handleResumeFromPause（丢纹理 + 重采 + 立即 draw）——画面上就是「闪一下，
 *   然后透过的画面才刷新」。
 *
 * 修法：navigation/utils.ts 的 pop / popTo / popToRoot（全 app 返回按钮的**唯一入口**）
 *   在派发命令**之前**就开「露出门」（navigation/revealWindow.ts），并让出一帧
 *   （NAV_REVEAL_LEAD_MS）等 React 提交 + 桥把 paused=false 送到原生。此刻被返回的
 *   那一页还完整盖着玻璃，复位与首帧采景都看不见；等转场把玻璃露出来时，透过的已经
 *   是当前画面。门的消费点只有玻璃（useGlassCovered / useGlassHomeCovered），
 *   账本语义与其它消费点（tabBarCollapse 布局、PlayingIcon 动画门）一个字不动。
 *
 * 本脚本钉住：
 *   A 露出窗口本体（revealWindow.ts）：让帧间隔 >0、兜底时限 ≥ 转场窗口时长、
 *     开窗立即置位 + 兜底定时器带代次对号、收尾**延后一个宏任务**（账本先翻）、
 *     作废是同步关（push 方向）；
 *   B 三入口（navigation/utils.ts）：pop / popTo / popToRoot 都经 revealBeforePop，
 *     且**开门与让帧都在派发 Navigation.* 之前**；
 *   C 两端动作（navigation.ts）：push 起手 clearNavRevealWindow（作废在途露出门）、
 *     screenPopped 收尾 endNavRevealWindow（且不得反过来开门）；
 *   D 状态管线（state / action / stateEvent / hook）：navRevealing 字段 + 初值 false +
 *     同值短路 + 事件 + 订阅/退订；
 *   E 玻璃专用门与消费点：useGlassCovered / useGlassHomeCovered = 账本门 ∧ 不在露出窗口内
 *     （**不得**退化成账面门别名），PlayerBar / ModernTabBar 的 paused 只喂玻璃门
 *     （不得再出现 paused={screenCovered…} / paused={homeCovered…}）、PlayerBar 的
 *     useMemo 依赖含 glassCovered；
 *   F 反例自检：任一条被拆掉一点都必须拦下；替换未命中 = 失败（防止用例指向的代码
 *     改名后脚本退化成永真）。
 *
 * 运行：node scripts/sim-glass-reveal-window.js
 *   （本机没有 node，真跑法用 %TEMP% 下的浏览器版迷你运行器（headless Edge/Chrome +
 *     python，不在仓库里）：
 *     python "C:\Users\Q\AppData\Local\Temp\lx-jsrun\run.py" scripts/sim-glass-reveal-window.js --brief）
 * 退出码：0 = 全部断言 + 全部反例通过；1 = 有任一项不合格。
 *
 * 声明：本脚本是**静态断言**（对源码文本做结构检查）。通过只代表源码形态符合约定，
 * 不代表能编译、更不代表真机观感 —— 本机没有 Xcode / 真机，Swift 与转场行为无法验证。
 * 已知边界（写在这里免得被当成缺陷）：系统**边缘返回手势**不经过 JS 的 pop 三入口，
 * 那条路径只能等 screenPopped 到达时才开门（与改动前一致，不会更差）。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const F = {
  reveal: 'src/navigation/revealWindow.ts',
  utils: 'src/navigation/utils.ts',
  nav: 'src/navigation/navigation.ts',
  state: 'src/store/common/state.ts',
  action: 'src/store/common/action.ts',
  event: 'src/event/stateEvent.ts',
  hook: 'src/store/common/hook.ts',
  playerbar: 'src/components/player/PlayerBar/index.tsx',
  tabbar: 'src/components/layout/ModernTabBar.tsx',
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

const swiftNumber = null // 本脚本不查 Swift，占位说明命名空间只服务 JS/TS

// ---------------------------------------------------------------------------
// A 露出窗口本体
// ---------------------------------------------------------------------------

const revealWindowInvariants = (f) => {
  const reasons = []
  const src = f.reveal

  // A1 让帧间隔：必须 >0（否则开门还没落到原生，pop 命令就抢在前头，
  // 复位又落回转场中间 = 本轮要消除的形态）；上限防「返回被拖慢」。
  const lead = /const NAV_REVEAL_LEAD_MS = (\d+)/.exec(src)
  if (!lead) {
    reasons.push('revealWindow 缺 NAV_REVEAL_LEAD_MS（开门与派发命令之间没有让帧）')
  } else if (!(Number(lead[1]) > 0 && Number(lead[1]) <= 200)) {
    reasons.push('NAV_REVEAL_LEAD_MS=' + lead[1] + ' 不在 (0, 200] 内（0 = 原生命令可能抢先、复位落回转场中间；过大 = 返回被明显拖慢）')
  }

  // A2 兜底时限：必须长于转场窗口（NAV_TRANSITION_SETTLE_MS）——事件落在转场**结尾**
  // 的时序下，提前关门会把玻璃重新按回暂停，正好复现「返回末尾闪一下」。
  const settle = /const NAV_TRANSITION_SETTLE_MS = (\d+)/.exec(f.nav)
  const tmo = /const NAV_REVEAL_TIMEOUT_MS = (\d+)/.exec(src)
  if (!tmo) {
    reasons.push('revealWindow 缺 NAV_REVEAL_TIMEOUT_MS（露出门没有兜底，push 打断/事件丢失时玻璃再也不省电）')
  } else {
    const v = Number(tmo[1])
    if (!(v > 0 && v <= 10000)) {
      reasons.push('NAV_REVEAL_TIMEOUT_MS=' + tmo[1] + ' 不在 (0, 10000] 内（0 = 没有兜底）')
    } else if (settle && v < Number(settle[1])) {
      reasons.push('NAV_REVEAL_TIMEOUT_MS=' + tmo[1] + ' 短于转场窗口 NAV_TRANSITION_SETTLE_MS=' + settle[1] + '（事件落在转场结尾的时序下会提前关门 → 玻璃重新被按回暂停、返回末尾又闪一下）')
    }
  }

  // A3 开窗：立即置位 + 兜底定时器（带代次对号，不会关掉新开的门）
  const beginBody = fnBody(src, /export const beginNavRevealWindow = \(\) => \{/)
  if (!beginBody) {
    reasons.push('revealWindow 缺 beginNavRevealWindow（返回发起时无门可开）')
  } else {
    if (!/setNavRevealing\(true\)/.test(beginBody)) {
      reasons.push('beginNavRevealWindow 未立即置位 navRevealing=true（玻璃不会提前恢复渲染）')
    }
    // 必须是 `revealTimer = setTimeout(...)`（句柄存起来才清得掉）；裸 setTimeout 不算
    if (!/revealTimer = setTimeout\(/.test(beginBody) || !/NAV_REVEAL_TIMEOUT_MS/.test(beginBody) || !/setNavRevealing\(false\)/.test(beginBody)) {
      reasons.push('beginNavRevealWindow 未挂兜底关门定时器（push 打断 / 事件丢失时门一直开着、玻璃不再省电）')
    }
    if (!/if \(seq !== revealSeq\) return/.test(beginBody)) {
      reasons.push('兜底关门没有代次对号（旧定时器会关掉后开的门）')
    }
    if (!/clearTimeout\(revealTimer\)/.test(beginBody)) {
      reasons.push('beginNavRevealWindow 未清上一个兜底定时器（重复开门会堆叠定时器）')
    }
  }

  // A4 收尾：必须**延后一个宏任务**关门（账本 componentIds 与本站状是两个更新源，
  // 同帧落地会出现「账本还没收尾、门已经关了」的一帧 = 玻璃又被按回暂停一次）
  const endBody = fnBody(src, /export const endNavRevealWindow = \(\) => \{/)
  if (!endBody) {
    reasons.push('revealWindow 缺 endNavRevealWindow（screenPopped 到达时无法收尾，只能等兜底时限）')
  } else if (!/closeRevealWindow\(true\)/.test(endBody)) {
    reasons.push('endNavRevealWindow 未走「延后一个宏任务」的关门（与账本同帧落地 → 收尾那一帧玻璃被重新按回暂停，正是用户看到的「返回末尾闪一下」）')
  }

  // A5 作废：push 方向必须**同步**关（玻璃正在被盖住，不能留门把这次 push 的暂停按掉）
  const clearBody = fnBody(src, /export const clearNavRevealWindow = \(\) => \{/)
  if (!clearBody) {
    reasons.push('revealWindow 缺 clearNavRevealWindow（push 发起时在途露出门无法作废）')
  } else if (!/closeRevealWindow\(false\)/.test(clearBody)) {
    reasons.push('clearNavRevealWindow 未走同步关门（作废拖到下一个宏任务，push 的首帧仍可能带着露出门）')
  }

  // A6 closeRevealWindow：两条路径（deferred / 同步）都必须真关门 + 代次对号
  const closeBody = fnBody(src, /const closeRevealWindow = \(deferred: boolean\) => \{/)
  if (!closeBody) {
    reasons.push('revealWindow 缺 closeRevealWindow（开/关两条路径没有共同出口）')
  } else {
    if (!/if \(!deferred\) \{\s*\n\s*commonActions\.setNavRevealing\(false\)/.test(closeBody)) {
      reasons.push('closeRevealWindow 的同步分支未把关掉（push 方向作废失效）')
    }
    if (!/setTimeout\(\(\) => \{\s*\n\s*if \(seq !== revealSeq\) return\s*\n\s*commonActions\.setNavRevealing\(false\)/.test(closeBody)) {
      reasons.push('closeRevealWindow 的延后分支缺少「代次对号 + 关门」（返回 A 的延迟关门会关掉紧跟着的返回 B 刚打开的门）')
    }
    if (!/clearTimeout\(revealTimer\)/.test(closeBody)) {
      reasons.push('closeRevealWindow 未清兜底定时器（关门后定时器到点再关一次）')
    }
  }

  // A7 模块耦合方向：只依赖 store/common/action，不反向依赖 navigation
  // （navigation/utils 与 navigation 都 import 本模块，本模块再 import 回去就是循环）
  if (/from '\.\/(utils|index|navigation)'/.test(src)) {
    reasons.push('revealWindow 反向依赖 navigation 模块（navigation/utils 已经 import 本模块 → 循环依赖）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// B 三入口：开门 + 让帧都在派发 Navigation.* 之前
// ---------------------------------------------------------------------------

const popEntryInvariants = (f) => {
  const reasons = []
  const utils = f.utils

  if (!/import \{ beginNavRevealWindow, NAV_REVEAL_LEAD_MS \} from '\.\/revealWindow'/.test(utils)) {
    reasons.push('navigation/utils 未从 ./revealWindow 引入 beginNavRevealWindow + NAV_REVEAL_LEAD_MS（三入口无从开门）')
  }

  const body = fnBody(utils, /const revealBeforePop = <T>\(run: \(\) => Promise<T>\): Promise<T> => \{/)
  if (!body) {
    reasons.push('navigation/utils 缺 revealBeforePop（三入口没有共同的「先开门、让一帧、再派发」出口）')
  } else {
    const beginAt = body.indexOf('beginNavRevealWindow()')
    if (beginAt < 0) {
      reasons.push('revealBeforePop 未开门（返回时玻璃仍在暂停态、透出的还是暂停前那一帧）')
    }
    const yieldAt = body.indexOf('setTimeout(')
    if (yieldAt < 0) {
      reasons.push('revealBeforePop 不再让出一帧（开门只是 JS 状态更新，原生命令可能抢先 → 复位落回转场中间）')
    }
    if (beginAt >= 0 && yieldAt >= 0 && !(beginAt < yieldAt)) {
      reasons.push('revealBeforePop 的开门落在让帧之后（顺序反了：让帧期间门还没开，那几帧仍是暂停态）')
    }
    if (!/\.then\(run\)/.test(body)) {
      reasons.push('revealBeforePop 未在让帧之后才执行命令（.then(run) 缺失：命令可能抢在门开之前派发）')
    }
    if (/Navigation\./.test(body)) {
      reasons.push('revealBeforePop 里直接出现 Navigation.* 调用（命令不再统一从 run 进来，顺序保证被绕过）')
    }
  }

  const entries = [
    ['pop', 'Navigation\\.pop\\(compId\\)'],
    ['popToRoot', 'Navigation\\.popToRoot\\(compId\\)'],
    ['popTo', 'Navigation\\.popTo\\(compId\\)'],
  ]
  for (const [name, call] of entries) {
    const re = new RegExp('export const ' + name + ' = \\(compId: string\\) => revealBeforePop\\(\\(\\) => ' + call + '\\)')
    if (!re.test(utils)) {
      reasons.push('pop 三入口里的 ' + name + ' 不再经 revealBeforePop 开门（返回时玻璃仍在暂停态 → 「返回动画结束时闪一下、然后透过的画面才刷新」原地复发）')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// C 两端动作：push 作废 / screenPopped 收尾（不得反向）
// ---------------------------------------------------------------------------

const navigationHooksInvariants = (f) => {
  const reasons = []
  const nav = f.nav

  if (!/import \{ clearNavRevealWindow, endNavRevealWindow \} from '\.\/revealWindow'/.test(nav)) {
    reasons.push('navigation.ts 未从 ./revealWindow 引入 clearNavRevealWindow + endNavRevealWindow（转发门两端动作无从落地）')
  }

  const beginTrans = fnBody(nav, /function beginNavTransitionWindow\(\)\s*\{/)
  if (!beginTrans) {
    reasons.push('navigation.ts 缺 beginNavTransitionWindow（push 侧转场窗口的落点无法确定）')
  } else {
    const clearAt = beginTrans.indexOf('clearNavRevealWindow()')
    const setAt = beginTrans.indexOf('setNavTransitioning(true)')
    if (clearAt < 0) {
      reasons.push('beginNavTransitionWindow 未作废在途露出门（push 意味着玻璃又要被盖住，露出门会把这次暂停按掉 → 转场中间态被采进玻璃）')
    } else if (setAt >= 0 && clearAt > setAt) {
      reasons.push('beginNavTransitionWindow 的作废落在置位之后（那一帧门仍开着、暂停还没生效）')
    }
  }

  const popped = fnBody(nav, /export const handleScreenPopped = \(componentId: string\) => \{/)
  if (!popped) {
    reasons.push('navigation.ts 缺 handleScreenPopped（露出门没有收尾点）')
  } else {
    if (!/endNavRevealWindow\(\)/.test(popped)) {
      reasons.push('handleScreenPopped 未收尾露出门（系统边缘手势这条不经过 JS 的路径会把门一直留着 → 玻璃不再省电）')
    }
    if (/beginNavRevealWindow/.test(popped)) {
      reasons.push('handleScreenPopped 里出现开门调用（事件到达时才开门 = 返回动画期间仍是陈旧透过画面，第 52 轮要消除的正是这个）')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// D 状态管线：state / action / stateEvent / hook
// ---------------------------------------------------------------------------

const statePipelineInvariants = (f) => {
  const reasons = []

  if (!/navRevealing:\s*boolean/.test(f.state)) {
    reasons.push('store/common/state 缺 navRevealing 字段（露出门无处记录）')
  }
  if (!/navRevealing:\s*false\s*,/.test(f.state)) {
    reasons.push('store/common/state 的 navRevealing 初值不是 false（启动即「正在露出」→ 玻璃不省电）')
  }

  const setBody = fnBody(f.action, /setNavRevealing\(revealing: boolean\)\s*\{/)
  if (!setBody) {
    reasons.push('store/common/action 缺 setNavRevealing（露出门没有唯一写入口）')
  } else {
    if (!/if \(state\.navRevealing == revealing\) return/.test(setBody)) {
      reasons.push('setNavRevealing 缺同值短路（布尔边沿每帧重发事件 → 玻璃反复重渲染）')
    }
    if (!/global\.state_event\.navRevealingUpdated\(revealing\)/.test(setBody)) {
      reasons.push('setNavRevealing 未广播 navRevealingUpdated（订阅方收不到）')
    }
  }

  if (!/navRevealingUpdated\(revealing: boolean\)\s*\{\s*\n\s*this\.emit\('navRevealingUpdated', revealing\)/.test(f.event)) {
    reasons.push('stateEvent 缺 navRevealingUpdated 事件（action → hook 的通道缺失）')
  }

  const hookBody = fnBody(f.hook, /export const useNavRevealing = \(\) => \{/)
  if (!hookBody) {
    reasons.push('store/common/hook 缺 useNavRevealing（玻璃专用门没有数据源）')
  } else if (!/state_event\.on\('navRevealingUpdated'/.test(hookBody) || !/state_event\.off\('navRevealingUpdated'/.test(hookBody)) {
    reasons.push('useNavRevealing 未订阅/未退订 navRevealingUpdated')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// E 玻璃专用门 + 消费点（账面门不得直接喂到 paused）
// ---------------------------------------------------------------------------

const glassGateInvariants = (f) => {
  const reasons = []

  const coveredBody = fnBody(f.hook, /export const useGlassCovered = \(componentId\?: string\) => \{/)
  if (!coveredBody) {
    reasons.push('store/common/hook 缺 useGlassCovered（迷你播放器玻璃没有玻璃专用门）')
  } else {
    if (!/useScreenCovered\(componentId\)/.test(coveredBody)) {
      reasons.push('useGlassCovered 不再基于 useScreenCovered（账面覆盖判定被绕过）')
    }
    if (!/useNavRevealing\(\)/.test(coveredBody)) {
      reasons.push('useGlassCovered 未读 useNavRevealing（退化成账面门别名 = 返回时仍显示暂停前的陈旧透过画面）')
    }
    if (!/return covered && !revealing/.test(coveredBody)) {
      reasons.push('useGlassCovered 不是「账面门 ∧ 不在露出窗口内」（玻璃专用门的唯一正确形态）')
    }
  }

  const homeBody = fnBody(f.hook, /export const useGlassHomeCovered = \(\) => \{/)
  if (!homeBody) {
    reasons.push('store/common/hook 缺 useGlassHomeCovered（Tab 栏两块玻璃没有玻璃专用门）')
  } else {
    if (!/useHomeCovered\(\)/.test(homeBody)) {
      reasons.push('useGlassHomeCovered 不再基于 useHomeCovered（账面覆盖判定被绕过）')
    }
    if (!/useNavRevealing\(\)/.test(homeBody)) {
      reasons.push('useGlassHomeCovered 未读 useNavRevealing（退化成账面门别名 = 返回时仍显示暂停前的陈旧透过画面）')
    }
    if (!/return covered && !revealing/.test(homeBody)) {
      reasons.push('useGlassHomeCovered 不是「账面门 ∧ 不在露出窗口内」（玻璃专用门的唯一正确形态）')
    }
  }

  // 消费点：paused 只喂玻璃门；反过来「paused={screenCovered…} / paused={homeCovered…}」
  // 一个都不许留（那就是第 52 轮之前的形态，返回时透出的还是暂停前那一帧）
  const feedRaw = (src, label) => {
    if (/paused=\{(screenCovered|homeCovered)\b/.test(src)) {
      reasons.push(label + ' 的 paused 直接喂账面门（screenCovered / homeCovered 要等 screenPopped 才翻，返回动画期间透出的还是暂停前那一帧）')
    }
  }
  feedRaw(f.playerbar, 'PlayerBar')
  feedRaw(f.tabbar, 'ModernTabBar')

  if (!/const glassCovered = useGlassCovered\(componentId\)/.test(f.playerbar) ||
      !/paused=\{glassCovered\s*(\|\|[^}]*)?\}/.test(f.playerbar)) {
    reasons.push('PlayerBar 未接 paused={glassCovered}(||…)（迷你条玻璃的覆盖判定不再走玻璃专用门）')
  }
  // 漏依赖 = 前后台/返回状态变化不会重建节点，门停在首帧值（页面里已有同款注释）
  const deps = f.playerbar.match(/\[glassOpacity,[^\]\n]*\]/)
  if (!deps || !/\bglassCovered\b/.test(deps[0])) {
    reasons.push('PlayerBar 的 useMemo 依赖未含 glassCovered（露出门翻转不会重建节点 → 返回时玻璃仍是暂停态）')
  }

  if (!/const glassHomeCovered = useGlassHomeCovered\(\)/.test(f.tabbar) ||
      !/paused=\{glassHomeCovered\s*(\|\|[^}]*)?\}/.test(f.tabbar)) {
    reasons.push('ModernTabBar 未接 paused={glassHomeCovered}(||…)（Tab 栏玻璃的覆盖判定不再走玻璃专用门）')
  }

  // 账面 hook 本体与它的非玻璃消费点必须原样健在（本轮的约束：只加一层，不动账本）
  if (!/export const useHomeCovered/.test(f.hook) || !/export const useScreenCovered/.test(f.hook)) {
    reasons.push('store/common/hook 的账面门（useHomeCovered / useScreenCovered）被改动或删除（非玻璃消费点要靠它们）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

const assertions = [
  { name: 'A 露出窗口本体（让帧 >0 / 兜底 ≥ 转场窗口 / 开窗即置位 + 代次对号 / 收尾延后一个宏任务 / 作废同步关）', hits: revealWindowInvariants(REAL) },
  { name: 'B 三入口（pop / popToRoot / popTo 都先开门、让一帧、再派发 Navigation.*）', hits: popEntryInvariants(REAL) },
  { name: 'C 两端动作（push 作废 / screenPopped 收尾，且不得反向）', hits: navigationHooksInvariants(REAL) },
  { name: 'D 状态管线（state 字段 + action 同值短路 + stateEvent + hook 订阅）', hits: statePipelineInvariants(REAL) },
  { name: 'E 玻璃专用门（= 账面门 ∧ 不在露出窗口内）+ 消费点只喂玻璃门', hits: glassGateInvariants(REAL) },
]

// ---------------------------------------------------------------------------
// F 反例自检
// ---------------------------------------------------------------------------

const mut = (key, find, replace) => {
  const out = REAL[key].replace(find, replace)
  if (out === REAL[key]) throw new Error('tamper 锚点未命中: ' + String(find).slice(0, 70))
  const files = { ...REAL }
  files[key] = out
  return files
}

const counterExamples = []
const check = (name, fn, files, expectSubstr) => {
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

const CE = (name, fn, makeFiles, expectSubstr) => {
  let files
  try {
    files = makeFiles()
  } catch (e) {
    counterExamples.push({ name, ok: false, detail: e.message })
    return
  }
  check(name, fn, files, expectSubstr)
}

CE('F1 pop 入口不再开门（直连 Navigation.pop）', popEntryInvariants, () => mut('utils',
  'export const pop = (compId: string) => revealBeforePop(() => Navigation.pop(compId))',
  'export const pop = (compId: string) => Navigation.pop(compId)'), 'pop 三入口')

CE('F2 popToRoot 入口不再开门', popEntryInvariants, () => mut('utils',
  'export const popToRoot = (compId: string) => revealBeforePop(() => Navigation.popToRoot(compId))',
  'export const popToRoot = (compId: string) => Navigation.popToRoot(compId)'), 'pop 三入口')

CE('F3 popTo 入口不再开门', popEntryInvariants, () => mut('utils',
  'export const popTo = (compId: string) => revealBeforePop(() => Navigation.popTo(compId))',
  'export const popTo = (compId: string) => Navigation.popTo(compId)'), 'pop 三入口')

CE('F4 让帧间隔被改成 0（原生命令可能抢先，复位落回转场中间）', revealWindowInvariants, () => mut('reveal',
  'export const NAV_REVEAL_LEAD_MS = 32',
  'export const NAV_REVEAL_LEAD_MS = 0'), 'NAV_REVEAL_LEAD_MS')

CE('F5 兜底时限被删成 0（门一直开着、玻璃不再省电）', revealWindowInvariants, () => mut('reveal',
  'export const NAV_REVEAL_TIMEOUT_MS = 1200',
  'export const NAV_REVEAL_TIMEOUT_MS = 0'), 'NAV_REVEAL_TIMEOUT_MS')

CE('F6 兜底时限短于转场窗口（事件落在转场结尾时提前关门 → 返回末尾又闪一下）', revealWindowInvariants, () => mut('reveal',
  'export const NAV_REVEAL_TIMEOUT_MS = 1200',
  'export const NAV_REVEAL_TIMEOUT_MS = 300'), '短于转场窗口')

CE('F7 开窗不再挂兜底定时器（push 打断后门一直开着）', revealWindowInvariants, () => mut('reveal',
  '  if (revealTimer) clearTimeout(revealTimer)\n  const seq = revealSeq\n  revealTimer = setTimeout(() => {',
  '  const seq = revealSeq\n  void setTimeout(() => {'), '兜底关门定时器')

CE('F8 push 不再作废在途露出门（转场中间态被采进玻璃）', navigationHooksInvariants, () => mut('nav',
  '  clearNavRevealWindow()\n  commonActions.setNavTransitioning(true)',
  '  commonActions.setNavTransitioning(true)'), '未作废在途露出门')

CE('F9 screenPopped 不再收尾露出门（边缘手势路径把门一直留着）', navigationHooksInvariants, () => mut('nav',
  '  endNavRevealWindow()\n', ''), '未收尾露出门')

CE('F10 screenPopped 又改成开门（事件到达才开 = 返回动画期间仍是陈旧画面）', navigationHooksInvariants, () => mut('nav',
  '  endNavRevealWindow()', '  beginNavRevealWindow()'), '出现开门调用')

CE('F11 收尾改成同步关门（与账本同帧落地 → 收尾那一帧玻璃被重新按回暂停）', revealWindowInvariants, () => mut('reveal',
  'export const endNavRevealWindow = () => {\n  closeRevealWindow(true)\n}',
  'export const endNavRevealWindow = () => {\n  closeRevealWindow(false)\n}'), '延后一个宏任务')

CE('F12 作废改成延后关门（push 的首帧仍可能带着露出门）', revealWindowInvariants, () => mut('reveal',
  'export const clearNavRevealWindow = () => {\n  closeRevealWindow(false)\n}',
  'export const clearNavRevealWindow = () => {\n  closeRevealWindow(true)\n}'), '未走同步关门')

CE('F13 延后关门的代次对号被拆（返回 A 的延迟关门会关掉返回 B 刚打开的门）', revealWindowInvariants, () => mut('reveal',
  '  setTimeout(() => {\n    if (seq !== revealSeq) return\n    commonActions.setNavRevealing(false)\n  }, 0)',
  '  setTimeout(() => {\n    commonActions.setNavRevealing(false)\n  }, 0)'), '代次对号')

CE('F14 玻璃门退化成账面门别名（返回时仍显示暂停前的陈旧透过画面）', glassGateInvariants, () => mut('hook',
  /return covered && !revealing/g, 'return covered'), '账面门 ∧ 不在露出窗口内')

CE('F15 PlayerBar 的 paused 又喂回账面门', glassGateInvariants, () => mut('playerbar',
  'paused={glassCovered || navTransitioning || !appActive}',
  'paused={screenCovered || navTransitioning || !appActive}'), '直接喂账面门')

CE('F16 PlayerBar 的 useMemo 依赖漏掉 glassCovered（露出门翻转不会重建节点）', glassGateInvariants, () => mut('playerbar',
  ', glassCovered,', ', '), '依赖未含 glassCovered')

CE('F17 action 的 setNavRevealing 被改成直写（同值短路被拆，每帧重发事件）', statePipelineInvariants, () => mut('action',
  '    if (state.navRevealing == revealing) return\n', ''), '同值短路')

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

let failed = 0

console.log('='.repeat(92))
console.log('玻璃露出门（navigation/revealWindow.ts，2026-10-11 第 52 轮第 2 条）')
console.log('='.repeat(92))
console.log('  A 露出窗口本体：让帧 32ms / 兜底 1200ms（> 转场窗口 420ms）/ 收尾延后一个宏任务 / push 作废同步关')
console.log('  B 三入口：navigation/utils 的 pop / popToRoot / popTo 先开门、让一帧、再派发 Navigation.*')
console.log('  C 两端动作：beginNavTransitionWindow 作废、handleScreenPopped 收尾（不得反向）')
console.log('  D 状态管线：state.navRevealing + action 同值短路 + stateEvent + useNavRevealing')
console.log('  E 玻璃专用门：useGlassCovered / useGlassHomeCovered = 账面门 ∧ 不在露出窗口内；paused 只喂玻璃门')
console.log('  F 反例自检：任一条被拆掉一点都必须拦下（替换未命中 = 失败）')
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
