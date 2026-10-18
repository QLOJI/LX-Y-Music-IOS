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
  // 导航转场窗口：**push 与 pop 两侧共用**。写/清全在 navigation 内（startPush /
  // pop 三入口 / handleScreenPopped），见 navigation/transitionWindow.ts。
  // 第 61 轮第 3 条之前 pop 侧是「立即释放」，另有一道 navRevealing「露出门」——
  // 两者都已删除，原因写在那份文件的历史段里。
  navTransitioning: boolean
  // 【第 74 轮第 3 条】**本次转场是返回（pop）**：`useGlassNavHold` 据此在返回侧
  // **放行**玻璃 —— 返回转场的第一帧就重采当前画面，整段转场实时跟到底。
  // 与上面那条「是否有转场」分开记（不是第二个窗口）：窗口时长、续期、单一出口
  // 全都还是 navTransitioning 那一套，这里只补一个方向。
  // 为什么不沿用第 61 轮之前那个同名机制：那一版的玻璃是**活的**、逐帧采正在滑走的
  // 那一页（采景源当时是整个 App 根视图，转场里根视图同时挂着两屏）；第 73 轮把采景源
  // 收窄成「包含本玻璃的那一屏」之后，返回转场里采到的就是本屏自己（静止的、正确的那一
  // 帧），那个成因已经从结构上消失 —— 所以这里给的是「返回侧不按住」，不是旧机制回来。
  navReturning: boolean
  // 【第 125 轮】返回转场的**整段**放行窗口（true = 从 pop 命令派发到 420ms 关窗）。
  // navReturning 在 50ms 后会被重冻定时器落回 false（第 75 轮口径），而账本覆盖门
  // （componentIds）要等 screenPopped 才翻 —— 两者一夹，玻璃在返回里一直 paused，
  // 显示的还是推页前的冻结帧。本字段与 navReturning 一起消费：整段返回玻璃保持活体采景，
  // 背景怎么动都跟着更新；关窗时一起清。
  navReturningWindow: boolean
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
  navReturning: false,
  navReturningWindow: false,
  componentIds: [],
  navActiveId: 'nav_discovery',
  lastNavActiveId: 'nav_discovery',
  sourceNames: initData as InitState['sourceNames'],
  bgPic: null,
}

export default state
