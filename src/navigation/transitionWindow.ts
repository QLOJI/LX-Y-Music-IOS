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
 * 【第 74 轮第 3 条】**返回侧不再按住**（`beginNavTransitionWindow('pop')`）。
 * 用户原话（2026-10-13 第 5 条 / 2026-10-14 第 3 条，两轮同一句）：「静态情况下，
 * 液态播放透过的画面在切入切回时可以实时显示，当我上下左右滑动界面再切入切回，透过的
 * 画面会显示在移动前的画面……能否在切回刚开始就确认主界面移动后画面，然后快速实时更新」。
 * 按住门能保证的只是「转场里不出现**新的**错帧」，它没法保证那帧**是当前的**：玻璃整段
 * 暂停期间 CAMetalLayer 上留的是冻结那一刻的画面，而返回时用户看到的就是它 —— 只要
 * 它和「返回后第一帧」有任何差（冻结帧被系统回收 / 被 - 重新可见 的一次性复位丢掉 /
 * 列表在冻结前后又贴过一次落点），返回整段就都在展示那张旧画面。
 * 第 61 轮之所以两侧都按住，是因为当时的采景源是**整个 App 的根视图**：返回转场里根视图
 * 同时挂着两屏（被弹走那屏的 view 在 model 坐标里还在原位），玻璃一恢复渲染就逐帧把
 * 「正在滑走的那一页」采进胶囊 —— 那才是「反向流」的真正成因。第 73 轮已把采景源收窄成
 * 「包含本玻璃的那一屏」（LiquidGlassView.findCaptureSourceView），本屏的内容本来就静止，
 * 逐帧采到的就是正确的那一帧。所以返回侧改成：
 *   · `navReturning = true` → useGlassNavHold 放行 → 采景门一翻（账本覆盖门翻转那一刻，
 *     即 screenPopped 到达）玻璃立刻走 handleResumeFromPause：丢掉旧纹理 + **同步**采一帧
 *     当前背景 + 立刻画（这就是「切回刚开始就确认主界面移动后画面」）；
 *   · 之后整段返回转场继续实时采景，画面一直是当下这一帧（「快速实时更新」）。
 * push 侧一个字没动（玻璃正被盖住，按住最省电、也最不容易出错）。
 *
 * 历史（别改回去）：2026-10-02 ~ 第 60 轮，pop 侧是「screenPopped 到达即立即释放」，
 * 第 52 / 56 / 58 轮还额外加过一道「露出门」让玻璃在返回转场开始前就复位重采——
 * 那正是玻璃在返回转场里逐帧采到「正在滑走的那一页」的原因，也是第 58 / 59 / 60 / 61 轮
 * 反复出现的「错位 / 延迟 / 方向反了」的来源。第 61 轮起整条露出门已删除，pop 侧改成
 * 「与 push 一样按住」——**第 74 轮把按住门的方向拆开：push 按住、pop 放行**（理由如上，
 * 关键是第 73 轮先修掉了采景源；顺序不能反，先放行再收采景源就是第 61 轮那个现场）。
 */
export const NAV_TRANSITION_SETTLE_MS = 420

/** 本次转场的方向：'push' 盖住（按住）/'pop' 返回（放行玻璃，见文件头第 74 轮段） */
export type NavTransitionDirection = 'push' | 'pop'

let navTransitionTimer: ReturnType<typeof setTimeout> | null = null

/** 开窗 / 续期：重复调用把窗口从这一刻重新计时（RNN 系统默认转场 0.35s）。
 *
 *  方向先落、再置「有转场」：反过来的话，一次返回会先按一拍再放行（多一次
 *  暂停/恢复，正是要治的那种「旧画面闪一下」）。两个动作都在同一个同步块里，
 *  组件重渲染时看到的已经是最终组合。 */
export const beginNavTransitionWindow = (direction: NavTransitionDirection = 'push') => {
  if (navTransitionTimer) clearTimeout(navTransitionTimer)
  commonActions.setNavReturning(direction === 'pop')
  commonActions.setNavTransitioning(true)
  navTransitionTimer = setTimeout(() => {
    navTransitionTimer = null
    commonActions.setNavTransitioning(false)
    commonActions.setNavReturning(false)
  }, NAV_TRANSITION_SETTLE_MS)
}
