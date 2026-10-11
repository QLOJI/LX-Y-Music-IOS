import { type NAV_ID_Type, type COMPONENT_IDS } from '@/config/constant'

export interface InitState {
  fontSize: number
  statusbarHeight: number
  // 底部安全区高度（pt）：Home 指示器 / iPad 底部区域。
  // 底部弹层与列表据此补 paddingBottom，避免最后一行被系统 UI 遮挡。
  safeAreaBottom: number
  // 底部安全区是否已从原生侧拿到过一次真实值（启动首帧为 false）。
  // 底部悬浮层（Tab 栏 / 迷你播放器）在 false 期间不下发，见 useSafeAreaReady：
  // 它俩的 bottom 完全由 safeAreaBottom 决定，先用 0 画出来、几十毫秒后拿到真实的
  // 34pt（iPhone）再整体上跳一次，就是用户看到的「启动时底部抽动」。
  safeAreaReady: boolean
  // push 转场窗口：**发起 push** 到转场结束期间所有玻璃暂停渲染（pop 侧不置位，
  // 返回时立即释放——原因写在 navigation.beginNavTransitionWindow /
  // endNavTransitionWindow）。
  navTransitioning: boolean
  // 「露出门」（2026-10-11，第 52 轮第 2 条）：**发起返回** 到该返回收尾期间置位。
  // 语义与 navTransitioning 相反——它不是「按住玻璃」，而是在账本（componentIds）
  // 还没来得及翻之前，先把玻璃的**覆盖门**作废：返回时玻璃正在被露出来，必须
  // 在转场开始前就恢复渲染并重采背景，否则整段返回动画显示的都是暂停那一刻的
  // 陈旧纹理，动画结束才跳一下（用户原话「返回到有底部 tab 栏和迷你播放器栏的
  // 界面时，底部会在返回动画结束时出现一瞬间闪烁，然后透过的画面才刷新」）。
  // 只影响玻璃省电门（useGlassCovered / useGlassHomeCovered），**不改**账本语义。
  // 写/清全在 navigation 内（navigation/utils 的 pop 三入口 + handleScreenPopped），
  // 见 navigation/revealWindow.ts。
  navRevealing: boolean
  componentIds: Array<{ name: COMPONENT_IDS, id: string }>
  navActiveId: NAV_ID_Type
  lastNavActiveId: NAV_ID_Type
  sourceNames: Record<LX.OnlineSource | 'all', string>
  bgPic: string | null
}

const initData = {}

const state: InitState = {
  fontSize: global.lx.fontSize,
  statusbarHeight: 0,
  safeAreaBottom: 0,
  safeAreaReady: false,
  navTransitioning: false,
  navRevealing: false,
  componentIds: [],
  navActiveId: 'nav_discovery',
  lastNavActiveId: 'nav_discovery',
  sourceNames: initData as InitState['sourceNames'],
  bgPic: null,
}

export default state
