/**
 * 首页横滑「跟手」与 A-5 长按拖动的轻量高频通道。
 *
 * 为什么不用 global.state_event：Main（PagerView 持有方）与 ModernTabBar 是同级
 * 兄弟组件（src/screens/Home/Vertical/Content.tsx），而 onPageScroll 是逐帧级
 * 高频回调——若每次回调都 setState，整条 tab 栏会在 120Hz 下逐帧重渲染（先例：
 * src/screens/PlayDetail/Vertical/VerticalNew.tsx:60-68 用 ref 规避同类问题）。
 * 这里用模块级订阅集合：发出方同步调用订阅者，订阅者只做 setNativeProps 命令式
 * 写入，全程不触发 React 渲染。
 *
 * 两条通道：
 * - Main → TabBar：PagerView 手势进度（position/offset）与拖动会话（开始/结束）。
 *   TabBar 据此命令式驱动 LiquidLens 跟手位移 + 抬落。
 * - TabBar → Main：A-5 长按拖动会话。Main 据此在 TabBar 拖动期间锁住 PagerView
 *   横滑（与 B-7 横滑互斥）。
 */

type ProgressListener = (position: number, offset: number) => void
type FlagListener = (value: boolean) => void

const progressListeners = new Set<ProgressListener>()
const dragListeners = new Set<FlagListener>()
const tabBarDragListeners = new Set<FlagListener>()

/** PagerView onPageScroll 进度（仅手势会话内发出，见 Main 的 pagerDragSessionRef） */
export const emitPagerProgress = (position: number, offset: number): void => {
  for (const listener of progressListeners) listener(position, offset)
}

export const subscribePagerProgress = (listener: ProgressListener): (() => void) => {
  progressListeners.add(listener)
  return () => {
    progressListeners.delete(listener)
  }
}

/** 手势拖动会话开始（true，onPageScrollStateChanged='dragging'）/ 结束（false，'idle'） */
export const emitPagerDrag = (dragging: boolean): void => {
  for (const listener of dragListeners) listener(dragging)
}

export const subscribePagerDrag = (listener: FlagListener): (() => void) => {
  dragListeners.add(listener)
  return () => {
    dragListeners.delete(listener)
  }
}

/** A-5 长按拖动会话（TabBar → Main）：true = 拖动已接管，横滑需上锁 */
export const emitTabBarDragActive = (active: boolean): void => {
  for (const listener of tabBarDragListeners) listener(active)
}

export const subscribeTabBarDragActive = (listener: FlagListener): (() => void) => {
  tabBarDragListeners.add(listener)
  return () => {
    tabBarDragListeners.delete(listener)
  }
}
