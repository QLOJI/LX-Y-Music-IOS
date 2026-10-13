import { useEffect, useMemo, useState } from 'react'
import { onTabBarCollapseChanged } from '@/utils/nativeModules/utils'
import { scaleSizeH, scaleSizeW } from '@/utils/pixelRatio'
import { tabBarBaseHeight, designSpacing, collapsedFloatBottom, collapsedPillGap, bottomFloatGap, floatDistance } from '@/theme/DesignTokens'
import { useSafeAreaBottom, useHomeCovered } from '@/store/common/hook'
import { useHorizontalMode } from '@/utils/hooks'
import { useSettingValue } from '@/store/setting/hook'
import state from '@/store/common/state'
import { COMPONENT_IDS } from '@/config/constant'

/**
 * 底部 Tab 栏收起状态（iOS 26 风格最小化）：
 * - 主界面的歌曲列表滚动离开顶部（offset > 48）→ 收起为左下角圆形按钮；
 * - 列表滚回顶部（offset ≤ 2）→ 自动展开；
 * - 点击收起按钮 → 手动展开，保持到下一次列表滚动离开顶部。
 * 状态由原生滚动跟踪器维护（无需逐页接线），仅状态变化时通知 JS。
 * 第 63 轮曾在原生侧把驱动范围收窄成「只有主界面自己的滚动才算数」，但那条门在全
 * App 恒为假（RNN 的屏幕 VC 嵌在它自己的容器里，拿不到「导航栈根屏」这个身份），
 * 结果是**任何**滚动都不再驱动状态机 —— 用户第 64 轮第 1 条报的「迷你播放器栏和
 * 底部 tab 栏不会合并了」。第 64 轮起原生侧改按「只有用户主动的滚动才改变状态」+
 * 「谁收起的谁负责展开」两条规则拦（见 AppDelegate.mm 的滚动静默观察器），本文件
 * 只负责**延迟下发**：
 *
 * 【第 64 轮第 1 条·避免闪】Home 的两块玻璃在被压栈页盖住 / 导航转场期间是**冻结**的
 *（转场按住门 + 账本覆盖门，见 store/common/hook 的 useGlassHomeCovered），冻结的纹理
 * 与「刚刚被 220ms 收起/展开动画挪动的图层」必然错开，恢复那一刻重采对齐 = 用户反复报的
 *「最后一瞬间闪一下」。所以：玻璃冻着的时候收到的收起/展开**只记账不下发**（布局一动不动，
 * 冻结纹理就永远对得上），等玻璃真的醒来（转场按住门松开 = navTransitioning 落回 false，
 * 那一刻原生侧 handleResumeFromPause 正要重采一帧）再一次性落地 —— 布局变化与重采同拍发生，
 * 用户看到的就是「返回 → 栏回到该有的样子」，中间没有旧画面。
 * 【第 74 轮第 3 条】返回侧不再按住（玻璃在 pop 方向是活的），所以这里的「冻着」也必须
 * 只在 push 方向成立（见下面 glassFrozen）：返回时欠账在「Home 回到栈顶」那一拍落地。
 * 消费方：ModernTabBar（Home）与 PlayerBar（isHome）。
 */

let collapsed = false
/** 玻璃冻着期间收到的状态（只记账不下发，见头部说明）；null = 没有待落地的 */
let held: boolean | null = null
let miniPlayerHeight = 0
const listeners = new Set<(v: boolean) => void>()
const heightListeners = new Set<(h: number) => void>()
let inited = false

/** Home 的两块玻璃（tab 栏 / 收起圆钮 / 迷你播放器）现在是不是被冻着 */
const glassFrozen = (): boolean => {
  // 转场窗口：窗口内玻璃被按住门冻着（第 61 轮第 3 条）——但**只在 push 侧**。
  // 【第 74 轮第 3 条】返回侧（navReturning）玻璃不冻（useGlassNavHold 在返回方向放行，
  // 见 store/common/hook.ts），所以这道门也不该再拦返回侧收到的变化：欠账必须在
  // 「Home 回到栈顶、玻璃开始实时采景」那一拍落地（两者的翻转时刻逐字对齐），
  // 拖到 420ms 之后就是「返回完成后栏又跳一下」。
  if (state.navTransitioning && !state.navReturning) return true
  // 账本覆盖门：RNN 栈顶不是 home 即 Home 被盖住（与 useHomeCovered 同一判据，
  // 这里读的是同一个 state，所以两者的翻转时刻完全一致）
  const ids = state.componentIds
  return ids.length > 0 && String(ids[ids.length - 1]?.name) != COMPONENT_IDS.home
}

const applyCollapsed = (v: boolean): void => {
  if (collapsed === v) return
  collapsed = v
  for (const listener of listeners) listener(v)
}

/** 玻璃醒了：把欠下的那一次落地 */
const flushHeld = (): void => {
  if (held == null || glassFrozen()) return
  const v = held
  held = null
  applyCollapsed(v)
}

const init = (): void => {
  if (inited) return
  inited = true
  onTabBarCollapseChanged((v) => {
    if (glassFrozen()) {
      held = v
      return
    }
    held = null
    applyCollapsed(v)
  })
  // 两个「玻璃醒了」的锚点：转场按住门松开、Home 回到栈顶（账本覆盖门翻转）
  global.state_event.on('navTransitioningUpdated', flushHeld)
  global.state_event.on('componentIdsUpdated', flushHeld)
}

export const useTabBarCollapsed = (): boolean => {
  const [value, setValue] = useState(collapsed)
  useEffect(() => {
    init()
    const listener = (v: boolean): void => {
      setValue(v)
    }
    listeners.add(listener)
    listener(collapsed)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return value
}

/** 迷你播放器实际高度（收起按钮据此对齐高度）；未测量时返回 0（调用方用默认值兜底） */
export const useMiniPlayerHeight = (): number => {
  const [value, setValue] = useState(miniPlayerHeight)
  useEffect(() => {
    const listener = (h: number): void => {
      setValue(h)
    }
    heightListeners.add(listener)
    listener(miniPlayerHeight)
    return () => {
      heightListeners.delete(listener)
    }
  }, [])
  return value
}

/** PlayerBar 测量到自身高度后上报（供收起按钮对齐） */
export const setMiniPlayerHeight = (height: number): void => {
  if (!Number.isFinite(height) || height <= 0 || Math.abs(height - miniPlayerHeight) < 0.5) return
  miniPlayerHeight = height
  for (const listener of heightListeners) listener(height)
}

/** 收起态圆钮尺寸的**唯一来源**（ModernTabBar 的圆钮与 PlayerBar 收起态的左侧
 *  让位共用同一个结果）：
 *  - 首选用实测的迷你播放器高度（宽=高保持圆形，且与播放器等高，视觉上「同排同高」）；
 *  - 首帧尚未测量（=0）时用 scaleSizeW(tabBarBaseHeight) 兜底——取的是 tab 栏高的
 *    token（它本身已经乘过 fontSize），与 Tab 栏同口径。
 *  以前这里散落着 55（实测）与 57（scaleSizeW(56)）两个写死值分居两文件，
 *  字体档位一变就对不上；尺寸只能从这里取。 */
export const getCollapsedPillSize = (measuredHeight: number): number =>
  measuredHeight > 0 ? measuredHeight : scaleSizeW(tabBarBaseHeight)

/** 收起行（圆钮 + 迷你播放器）的完整几何，**一次算出、两边取用**。
 *
 *  2026-10-01 定案（B1「迷你播放器高出圆钮且间距很大」重点修复）：
 *  此前两个消费方各自调用同一组函数、各算一遍 left/bottom/size——公式同源但
 *  **计算两次、订阅两次**，任何一次漏读（订阅时序 / 测量时序）都会让「播放器还停在
 *  展开位、圆钮已经出现在左下角」这类分叉在设备上重现，而盯着公式看是看不出问题的
 *  （这就是它修了好几轮都好不了的原因）。现在只保留这一处计算：
 *    - bottom ：收起行底边（圆钮 bottom 与播放器收起态 bottom 取同一个数）
 *    - size   ：圆钮边长 = 收起态播放器高度（等高才叫同排）
 *    - roundLeft ：圆钮左缘（scaleSizeW 口径，与 tab 栏/播放器展开态左缘同一个 24）
 *    - playerLeft：播放器收起态左内边距 = 圆钮右缘 + collapsedPillGap（贴着圆钮）
 *  两边**不再各自推导**，只允许从这里取值。 */
export interface CollapsedRowGeometry {
  size: number
  bottom: number
  roundLeft: number
  playerLeft: number
}

export const useCollapsedRowGeometry = (): CollapsedRowGeometry => {
  const safeAreaBottom = useSafeAreaBottom()
  const measured = useMiniPlayerHeight()
  const size = getCollapsedPillSize(measured)
  const roundLeft = scaleSizeW(designSpacing.lg)
  return useMemo(() => ({
    size,
    bottom: collapsedFloatBottom(safeAreaBottom),
    roundLeft,
    playerLeft: roundLeft + size + collapsedPillGap,
  }), [size, safeAreaBottom, roundLeft])
}

/** 迷你播放器**顶边**距屏底的距离（pt）：底部悬浮元素要「紧贴迷你播放器上沿」时
 *  的唯一来源。返回的是顶边（不是底边），调用方直接把它当 `bottom` 用即可贴合。
 *
 *  2026-10-03（第 31 轮·图二）定案。此前 LocalDownload 的批量管理框、OnlineList 的
 *  多选操作条、下载悬浮球三处都把「播放器顶边」写死成 `160 + safeAreaBottom`——
 *  160 是「底缝 4 + Tab 栏高 56 + 滑块满程 20 + 播放器高 ≈80」在**标准字体**下
 *  的和。用户在主题设置里把「Tab栏距离」调小后，按钮整体下移、Tab 栏高度也随字体
 *  缩放变化，这三处却纹丝不动 ⇒ 批量管理框和播放器之间裂出一条空隙
 *  （需求原文「未与下方迷你播放器栏紧贴……导致出现间距，需要消除间距」）。
 *
 *  正确做法不是再报一个常数，而是照 PlayerBar 的实际落点算 —— 公式与
 *  PlayerBar 的 bottomExpanded / bottomCollapsed **逐字同式**：
 *    · 展开态底边 = 安全区 + (首页 ? (横屏 ? 76 : 底缝 + scaleSizeH(tabBarBaseHeight) + floatDistance(滑块)) : 底缝)
 *      四路输入全带：home 与否、横屏、字体缩放、滑块值；
 *    · 收起态底边 = collapsedFloatBottom(安全区)（与左下角圆钮共用同一条公式）；
 *    · 顶边 = 底边 + 播放器高（= 收起行几何的 size，同一份实测值）。
 *  播放器高度取 useMiniPlayerHeight 的实测值（PlayerBar 只按展开态上报），
 *  未测量时由 getCollapsedPillSize 的 token 兜底 —— 与圆钮同源。
 *
 *  【第 74 轮】新增 `{ pinnedExpanded }` 入参：true = 底边恒取**展开态**、不跟 Tab 栏收起态。
 *  可滚动内容的末尾避让一律走 useListBottomClearance（= 它 + 一道呼吸缝），
 *  悬浮控件（要贴着播放器）用默认值。 */
export const useAboveMiniPlayerBottom = ({ pinnedExpanded = false }: { pinnedExpanded?: boolean } = {}): number => {
  const safeAreaBottom = useSafeAreaBottom()
  const homeCovered = useHomeCovered()
  const isHorizontalMode = useHorizontalMode()
  const tabBarDistance = useSettingValue('theme.tabBarDistance')
  const tabBarCollapsed = useTabBarCollapsed()
  const measured = useMiniPlayerHeight()
  return useMemo(() => {
    // 与 PlayerBar 的 isHome 同义：栈顶是首页（没被压栈页盖住）时，播放器下面还有 Tab 栏这一层
    const isHome = !homeCovered
    const bottomExpanded = safeAreaBottom + (isHome
      ? (isHorizontalMode ? 76 : bottomFloatGap + scaleSizeH(tabBarBaseHeight) + floatDistance(tabBarDistance))
      : bottomFloatGap)
    // pinnedExpanded：永久按**展开态**（最高形态）取底边，不跟 Tab 栏收起态走。
    // 悬浮控件（批量管理框 / 多选条 / 悬浮球）要「贴着播放器」，必须跟；可滚动内容的避让
    // 高度不能跟 —— 原因见 useListBottomClearance 的说明（跟着走会在滚动中途改 contentSize）。
    const playerBottom = isHome && tabBarCollapsed && !pinnedExpanded ? collapsedFloatBottom(safeAreaBottom) : bottomExpanded
    return playerBottom + getCollapsedPillSize(measured)
  }, [safeAreaBottom, homeCovered, isHorizontalMode, tabBarDistance, tabBarCollapsed, measured, pinnedExpanded])
}

/** 可滚动内容（列表 / 设置页 ScrollView）**末尾**要留的避让高度：让最后一行完整露在底部
 *  悬浮层之上。
 *
 *  2026-10-14（第 74 轮第 1 条）定案。此前列表末尾各有各的写法：「我的」页 / 歌曲列表页吃
 *  useBottomOverlayInset()（= BOTTOM_OVERLAY_BASE_HEIGHT 180 + 安全区，一个按最高形态凑出来
 *  的常数），设置页吃 useAboveMiniPlayerBottom()（**会跟着 Tab 栏收起态变**）。后者在真机上
 *  是一个自馈环 —— 设置页是 Home 的一个 tab 页（不是压栈页），**它自己的滚动**就驱动 Tab 栏
 *  收起：收起态一变，padding 从 168 掉到 92 → 列表 contentSize 当场缩小 → iOS 把
 *  contentOffset 夹回新的最大值 → 夹回来的 offset 落回展开门限以内 → 原生状态机又判展开 →
 *  padding 涨回 168 …… 用户看到的就是「向下滑到底部，反复在底部碰撞跳动」；同一根因还会让
 *  每一次 fling 的收尾提前「撞墙」（内容长度在半途变小），表现成「上下滑动有抖动/不平滑」。
 *
 *  所以列表避让**必须是一个不随滚动改变的量**：取展开态（最高形态）的播放器顶边，再加一道
 *  呼吸缝。代价是收起态下末尾会多出 tab 栏那一层（≈76pt）的空白 —— 这是 iOS 系统应用的同
 *  一项取舍（内容内边距按最高形态一次定死，收起/展开都不再动列表，宁可多留一点空白也不让
 *  列表在滚动中途跳）。缝取 designSpacing.sm，与悬浮控件那边的「裸值不加缩放」口径无关
 *  （它是内容内边距，不是落点）。 */
export const useListBottomClearance = (): number =>
  useAboveMiniPlayerBottom({ pinnedExpanded: true }) + designSpacing.sm
