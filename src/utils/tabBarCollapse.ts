import { useEffect, useState } from 'react'
import { onTabBarCollapseChanged } from '@/utils/nativeModules/utils'
import { scaleSizeW } from '@/utils/pixelRatio'
import { tabBarBaseHeight } from '@/theme/DesignTokens'

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
