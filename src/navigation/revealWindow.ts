import commonActions from '@/store/common/action'

/**
 * 玻璃「露出门」——返回（pop）专用（2026-10-11，第 52 轮第 2 条）。
 *
 * ## 要解决的现象（用户原话）
 * 「当我返回主界面或者从某个界面返回到有底部 tab 栏和迷你播放器栏的界面时，底部 tab 栏和
 * 迷你播放器栏会在返回动画结束时出现一瞬间闪烁，然后透过的画面才刷新新的透过画面……
 * 要保证不要有瞬间闪烁，透过的画面要在返回动画之前就实时显示」。
 *
 * ## 成因
 * 底部两块液态玻璃的省电门读的是「账本」（commonState.componentIds，见
 * useScreenCovered / useHomeCovered）：栈顶不是自己 ⇒ 暂停 Metal 逐帧渲染。
 * 而账本只在 RNN 的 screenPopped 事件到达时才翻，该事件**晚于用户按下返回**
 * （可能落在返回转场开头，也可能落在结尾——两种时序都在 navigation.ts 的
 * endNavTransitionWindow 注释里记着）。于是在这段缝里：
 *   玻璃处于「暂停」——CAMetalLayer 保留着暂停前呈现的那一帧（push 之前的画面，
 *   即上一次可见时刻的背景）；
 *   返回动画把玻璃一路露出来时，透过的画面还是那张陈旧纹理；
 *   等事件到达、账本收尾，原生才走 handleResumeFromPause（丢旧纹理 + 重采 + 立即 draw）
 *   ——这一步发生在返回动画**即将结束/已结束**时，画面上就是「闪一下，然后才刷新」。
 *
 * ## 修法
 * 在**派发 pop 命令之前**就把玻璃的覆盖门作废：玻璃提前复位并重采一次背景。
 * 此刻被返回的那一页还完整盖在玻璃上，复位与首帧采景都看不见；等转场把玻璃露出来时，
 * 透过的画面已经是当前画面（玻璃背后就是目标页底色 + 目标页内容），全程实时，
 * 动画结束不再跳变。门的消费点只有玻璃（useGlassCovered / useGlassHomeCovered），
 * 账本语义与其它消费点（布局、动画门）一个字不动。
 *
 * ## 边界
 * · 只有「按返回键」这条路径会经过本模块（navigation/utils 的 pop / popTo / popToRoot
 *   是全 app 返回按钮的唯一入口）。**系统边缘返回手势**不经过 JS —— 那种情况下
 *   screenPopped 到达时才开门（与改动前一致，不会更差）。
 * · 开着门而事件始终没来（转场被打断、RNN 事件丢失）必须有上限，否则玻璃在真正被
 *   压栈页盖住时不再省电 ⇒ NAV_REVEAL_TIMEOUT_MS 兜底关门；push 发起时也立即作废
 *   （clearNavRevealWindow）——push 意味着玻璃又要被盖住了。
 */

/**
 * 开门与派发 pop 命令之间的让帧间隔（ms）。
 *
 * 开门只是 JS 侧的状态更新：要等 React 提交 + RN 桥把 `paused=false` 送到原生，
 * 原生才会执行 handleResumeFromPause（丢纹理 → 采景 → draw）。这两步（以及
 * `Navigation.pop` 的原生命令派发）是两条独立通道，谁先到不确定；真让 pop 抢先，
 * 复位就落在转场中间——那正是本模块要消除的「动画中途才重采」。
 * 32ms ≈ 两拍（60Hz）：足够让状态更新落到原生，又远低于人能感知的点击延迟
 * （返回动画本身 0.35s）。代价是返回动画晚 ~2 帧开始。
 */
export const NAV_REVEAL_LEAD_MS = 32

/**
 * 兜底关窗时限（ms）：开门后若 screenPopped 始终没来（转场被取消、事件丢失），
 * 到点无条件关门。取得比任何返回转场都长（RNN 系统默认 0.35s），否则会在
 * 「事件落在转场结尾」的时序里提前关门 → 玻璃重新被按回暂停 → 又出现那一下闪烁。
 */
export const NAV_REVEAL_TIMEOUT_MS = 1200

// 代次号（与 volumeFade 的 pauseSeq 同一套「领号 / 对号」口径）：
// 每一次开窗、关窗、作废都递增，延迟动作执行前先对号——号变了说明期间又发生过
// 新的导航事件，本次动作作废。没有它，下面两个延迟动作会互相踩：
//   · 返回 A 收尾时排的「延迟关门」会关掉紧跟着的返回 B 刚打开的门；
//   · 兜底定时器会关掉一个新开的门。
let revealSeq = 0
let revealTimer: ReturnType<typeof setTimeout> | null = null

/** 内部：关窗。deferred = 延后一个宏任务再落状态（见 endNavRevealWindow）。 */
const closeRevealWindow = (deferred: boolean) => {
  const seq = ++revealSeq
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
  if (!deferred) {
    commonActions.setNavRevealing(false)
    return
  }
  // 账本（componentIds）与本站状是两个独立更新源，在同一个 screenPopped 处理里先后落地。
  // 若两者落进同一帧的两遍渲染，中间态会是「账本还没收尾、露出门已经关了」——那一帧
  // 会把玻璃重新按回暂停，紧接着账本收尾又恢复：正好复现「返回末尾闪一下」。
  // 延后一个宏任务关门，保证账本先落地、关门只是 false → false 的无边沿收尾。
  // （React 18 自动批处理通常已把两次更新并成一次渲染，这里是显式兜底。）
  setTimeout(() => {
    if (seq !== revealSeq) return
    commonActions.setNavRevealing(false)
  }, 0)
}

/**
 * 开窗（返回发起前调用，见 navigation/utils 的 pop 三入口）。
 * 重复调用只是续期：代次号递增会作废上一个兜底定时器与在途的延迟关门。
 */
export const beginNavRevealWindow = () => {
  revealSeq++
  commonActions.setNavRevealing(true)
  if (revealTimer) clearTimeout(revealTimer)
  const seq = revealSeq
  revealTimer = setTimeout(() => {
    if (seq !== revealSeq) return
    revealTimer = null
    commonActions.setNavRevealing(false)
  }, NAV_REVEAL_TIMEOUT_MS)
}

/**
 * 收尾关窗（screenPopped 到达时调用，见 navigation.handleScreenPopped）。
 * 延后一个宏任务落状态，保证账本先收尾（理由见 closeRevealWindow）。
 */
export const endNavRevealWindow = () => {
  closeRevealWindow(true)
}

/**
 * 立即作废在途的露出窗口（push 发起时调用，见 navigation.beginNavTransitionWindow）。
 * push 方向与 pop 相反——玻璃正在被盖住——不能留着露出门把 push 的暂停按掉。
 */
export const clearNavRevealWindow = () => {
  closeRevealWindow(false)
}
