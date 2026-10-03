import { useEffect, useMemo, useState } from 'react'
import { onTabBarCollapseChanged } from '@/utils/nativeModules/utils'
import { scaleSizeH, scaleSizeW } from '@/utils/pixelRatio'
import { tabBarBaseHeight, designSpacing, collapsedFloatBottom, collapsedPillGap, bottomFloatGap, floatDistance } from '@/theme/DesignTokens'
import { useSafeAreaBottom, useHomeCovered } from '@/store/common/hook'
import { useHorizontalMode } from '@/utils/hooks'
import { useSettingValue } from '@/store/setting/hook'

/**
 * 底部 Tab 栏收起状态（iOS 26 风格最小化）：
 * - 任何歌曲列表滚动离开顶部（offset > 48）→ 收起为左下角圆形按钮；
 * - 列表滚回顶部（offset ≤ 2）→ 自动展开；
 * - 点击收起按钮 → 手动展开，保持到下一次列表滚动离开顶部。
 * 状态由原生滚动跟踪器维护（全 App 列表统一生效，无需逐页接线），
 * 仅状态变化时通知 JS。消费方：ModernTabBar（Home）与 PlayerBar（isHome）。
 */

let collapsed = false
let miniPlayerHeight = 0
const listeners = new Set<(v: boolean) => void>()
const heightListeners = new Set<(h: number) => void>()
let inited = false

const init = (): void => {
  if (inited) return
  inited = true
  onTabBarCollapseChanged((v) => {
    if (collapsed === v) return
    collapsed = v
    for (const listener of listeners) listener(v)
  })
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
 *  未测量时由 getCollapsedPillSize 的 token 兜底 —— 与圆钮同源。 */
export const useAboveMiniPlayerBottom = (): number => {
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
    const playerBottom = isHome && tabBarCollapsed ? collapsedFloatBottom(safeAreaBottom) : bottomExpanded
    return playerBottom + getCollapsedPillSize(measured)
  }, [safeAreaBottom, homeCovered, isHorizontalMode, tabBarDistance, tabBarCollapsed, measured])
}
