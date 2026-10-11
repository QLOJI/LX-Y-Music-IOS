import commonActions from '@/store/common/action'

/**
 * 导航转场窗口（push / pop **两侧共用**）：底部两块液态玻璃的「按住门」。
 *
 * 为什么是「按住」而不是「提前重采」：转场期间玻璃背后那一块屏幕正在变，逐帧采进
 * 胶囊就是「透过的画面反着流 / 错位 / 拉伸」那一类现象。返回时最典型——玻璃背后
 * 其实还是**正在滑走的那一页**（页面向右走、玻璃不动），页面的内容在玻璃里就是
 * 由右向左流。用户第 61 轮原话：「当我右滑时，底部 tab 栏和迷你播放器栏透过的
 * 画面是由右向左滑入的，这个方向是反的，需要改」。
 * 修法 = 整段转场保持转场前那一帧（对返回来说那就是底层页面自己的画面，它本来
 * 就是静止的），转场结束再恢复渲染；恢复那一下由原生 handleResumeFromPause 收口
 * （保留旧纹理 → 重采 → 立即画，第 56 轮），所以不会「动画末尾跳一下」。
 *
 * 开窗时机（都在导航命令之前 / 同帧）：
 *   · push：startPush —— 玻璃正在被盖住，整段按住，代价不可见；
 *   · pop：JS 派发的三个返回入口（navigation/utils 的 pop / popTo / popToRoot）
 *     在派发前开；**系统边缘返回手势不经过 JS**，只能等 screenPopped 到达时由
 *     handleScreenPopped 补开。该事件可能落在转场开头，所以那里是**续期**——
 *     续期保住的是整段转场，不是让陈旧画面多留一会儿（按住的就是底层画面本身）。
 *
 * 历史（别改回去）：2026-10-02 ~ 第 60 轮，pop 侧是「screenPopped 到达即立即释放」，
 * 第 52 / 56 / 58 轮还额外加过一道「露出门」让玻璃在返回转场开始前就复位重采——
 * 那正是玻璃在返回转场里逐帧采到「正在滑走的那一页」的原因，也是第 58 / 59 / 60 / 61 轮
 * 反复出现的「错位 / 延迟 / 方向反了」的来源。第 61 轮起整条露出门已删除。
 */
export const NAV_TRANSITION_SETTLE_MS = 420

let navTransitionTimer: ReturnType<typeof setTimeout> | null = null

/** 开窗 / 续期：重复调用把窗口从这一刻重新计时（RNN 系统默认转场 0.35s）。 */
export const beginNavTransitionWindow = () => {
  if (navTransitionTimer) clearTimeout(navTransitionTimer)
  commonActions.setNavTransitioning(true)
  navTransitionTimer = setTimeout(() => {
    navTransitionTimer = null
    commonActions.setNavTransitioning(false)
  }, NAV_TRANSITION_SETTLE_MS)
}
