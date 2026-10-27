import { useCallback, useEffect, useRef, useState } from 'react'
import type PagerView from 'react-native-pager-view'

import commonState from '@/store/common/state'

type PagerLike = {
  isScrolling?: boolean
  setPage?: (index: number) => void
  setPageWithoutAnimation?: (index: number) => void
} | null

interface Options {
  /** 本页对应的 Home detail nav id（用于重新进入时的非动画复位） */
  navId: string
  /** 当前应停的页号镜像（避免闭包读到旧 state） */
  activeIndexRef: { current: number }
  /**
   * 是否在重新进入本页时做一次非动画落页。默认 true（对齐网易日推；
   * 网易页自己有等价的 nav 复位逻辑时可传 false 避免重复）。
   */
  resyncOnEnter?: boolean
}

const SILENCE_MS = 2000

/**
 * 可恢复的内层 PagerView（推荐页 / 日推页共用）。
 *
 * react-native-pager-view 6.7.1 的两个原生闩锁：
 *  1. Manager 在 `animated && animating` 时**直接丢弃 setPage**。一次过渡的 completion
 *     丢失（被手势打断 / 动画重叠）后 animating 卡在 YES，后续 tab 点击既不切页也没动画；
 *  2. `goTo:` 先 `disableSwipe`（userInteractionEnabled=NO），只靠 completion 恢复。
 *     completion 不来 ⇒ 整页点击/滑动全死。而构建期补丁的 600ms 恢复写在 goTo 里，
 *     setPage 被 Manager 丢弃时根本没机会布防。
 *
 * 恢复链：动画 setPage → 600ms 没落页 → 非动画 setPageWithoutAnimation（绕开 Manager
 * 闸门；构建期补丁会在非动画设置时立即清 animating、并恢复交互）→ 再 700ms 仍没落页
 * → 重挂 PagerView（最后兜底）。正常路径仍是动画切页。
 *
 * 另带手势静默看门狗：库只在 willEndDragging/didEndDecelerating 发状态，手势被取消时
 * 什么都不来；真实拖动每帧都有 onPageScroll，2s 无活动即判定取消、抹平 JS isScrolling。
 */
export const useRecoverablePager = (
  pagerRef: { current: PagerView | null },
  options: Options,
) => {
  const { navId, activeIndexRef, resyncOnEnter = true } = options

  const pendingIndexRef = useRef<number | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pagerKey, setPagerKey] = useState(0)

  const clearPagerLatch = useCallback(() => {
    const pager = pagerRef.current as unknown as PagerLike
    if (pager?.isScrolling) pager.isScrolling = false
  }, [pagerRef])

  const clearSwitchTimers = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }
    if (remountTimerRef.current) {
      clearTimeout(remountTimerRef.current)
      remountTimerRef.current = null
    }
  }, [])

  // 当前原生滚动状态。空闲时点击走带动画的 setPage（与手动滑动同一条路径）；
  // 过渡中点击不再排队等 idle —— 等不到 idle 时旧逻辑要 600ms 后才无动画跳页，
  // 用户看到「按钮已切换、页面顿一下再切过去」。过渡中直接非动画直达，立即响应。
  const scrollStateRef = useRef<'idle' | 'dragging' | 'settling'>('idle')

  /** 只布防恢复链（600ms 非动画 → 700ms 重挂），不自己发 setPage。 */
  const armFallback = useCallback((index: number) => {
    clearSwitchTimers()
    pendingIndexRef.current = index
    fallbackTimerRef.current = setTimeout(() => {
      fallbackTimerRef.current = null
      if (pendingIndexRef.current !== index) return
      // 非动画直达：绕过 Manager 的 animating 闸门；补丁会在此刻清 animating 并恢复交互。
      pagerRef.current?.setPageWithoutAnimation?.(index)
      remountTimerRef.current = setTimeout(() => {
        remountTimerRef.current = null
        if (pendingIndexRef.current !== index) return
        // 原生实例完全不响应：重挂 PagerView（initialPage 用当前页）。
        pendingIndexRef.current = null
        setPagerKey(k => k + 1)
      }, 700)
    }, 600)
  }, [clearSwitchTimers, pagerRef])

  /** 只登记目标页并布防恢复链，不自己发 setPage（给必须保留原 setPage 字面量的页面用）。 */
  const trackPageSwitch = useCallback((index: number) => {
    armFallback(index)
  }, [armFallback])

  const sendPage = useCallback((index: number) => {
    pendingIndexRef.current = index
    pagerRef.current?.setPage?.(index)
    armFallback(index)
  }, [armFallback, pagerRef])

  const requestPage = useCallback((index: number) => {
    if (scrollStateRef.current === 'idle') {
      sendPage(index)
      return
    }
    // 过渡中（dragging / settling）：立即非动画直达，不等 idle、不排队。
    // 仍布防恢复链：原生若不响应，600ms 后再补一次直达、700ms 后重挂。
    pendingIndexRef.current = index
    pagerRef.current?.setPageWithoutAnimation?.(index)
    armFallback(index)
  }, [armFallback, pagerRef, sendPage])

  // ---- 手势静默看门狗 ----
  const activityAtRef = useRef(0)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])
  const armRef = useRef<() => void>(() => {})
  const armWatchdog = useCallback(() => {
    clearWatchdog()
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null
      if (Date.now() - activityAtRef.current < SILENCE_MS) {
        armRef.current()
        return
      }
      clearPagerLatch()
    }, SILENCE_MS)
  }, [clearWatchdog, clearPagerLatch])
  armRef.current = armWatchdog

  useEffect(() => () => {
    clearSwitchTimers()
    clearWatchdog()
  }, [clearSwitchTimers, clearWatchdog])

  /** 页面 onPageSelected 的第一行调用：撤恢复链、清看门狗与 JS 闩锁。 */
  const notifyPageSelected = useCallback(() => {
    pendingIndexRef.current = null
    clearSwitchTimers()
    clearWatchdog()
    clearPagerLatch()
  }, [clearPagerLatch, clearSwitchTimers, clearWatchdog])

  const onPageScroll = useCallback(() => {
    activityAtRef.current = Date.now()
  }, [])

  const onPageScrollStateChanged = useCallback((e: { nativeEvent: { pageScrollState: string } }) => {
    const state = e.nativeEvent.pageScrollState as 'idle' | 'dragging' | 'settling'
    scrollStateRef.current = state
    if (state === 'dragging') {
      activityAtRef.current = Date.now()
      armWatchdog()
      return
    }
    if (state === 'idle') {
      clearWatchdog()
      clearPagerLatch()
    }
  }, [armWatchdog, clearWatchdog, clearPagerLatch])

  // 重新进入本页：一次非动画落页，给原生实例走完整 goTo/completion 的复位机会。
  useEffect(() => {
    if (!resyncOnEnter) return
    let prevId: string = commonState.navActiveId
    const handleNavIdUpdate = (id: string) => {
      const prev = prevId
      prevId = id
      if (id !== navId || prev === id) return
      requestAnimationFrame(() => {
        pagerRef.current?.setPageWithoutAnimation?.(activeIndexRef.current)
      })
    }
    global.state_event.on('navActiveIdUpdated', handleNavIdUpdate)
    return () => { global.state_event.off('navActiveIdUpdated', handleNavIdUpdate) }
  }, [navId, activeIndexRef, pagerRef, resyncOnEnter])

  return {
    pagerKey,
    requestPage,
    trackPageSwitch,
    notifyPageSelected,
    clearPagerLatch,
    onPageScroll,
    onPageScrollStateChanged,
  }
}
