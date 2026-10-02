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
  componentIds: [],
  navActiveId: 'nav_discovery',
  lastNavActiveId: 'nav_discovery',
  sourceNames: initData as InitState['sourceNames'],
  bgPic: null,
}

export default state
