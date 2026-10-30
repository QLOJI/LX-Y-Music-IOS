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
  // 80ms 探测：点击后原生若没开始滑（setPage 被 Manager 吞掉 / settling 事件丢失），
  // 立刻非动画切过去。此前只能等 600ms 兜底，用户看到「按钮已切换、页面等一会儿才动」。
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quietTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pagerKey, setPagerKey] = useState(0)
  // 原生当前页（onPageSelected 回报）。恢复链要「非动画回到当前页」来清 animating，
  // 不能拿 JS 的 activeTab —— 点击后它已经指向目标页了。
  const nativeIndexRef = useRef(activeIndexRef.current)

  const clearPagerLatch = useCallback(() => {
    const pager = pagerRef.current as unknown as PagerLike
    if (pager?.isScrolling) pager.isScrolling = false
  }, [pagerRef])

  const clearSwitchTimers = useCallback(() => {
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current)
      probeTimerRef.current = null
    }
    if (quietTimerRef.current) {
      clearTimeout(quietTimerRef.current)
      quietTimerRef.current = null
    }
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
  // 切页请求时刻 / 最近一次页面滚动时刻：80ms 探测据此判断「原生到底动没动」。
  // 有滚动 = 动画已开始，保留滑动；没滚动 = setPage 被 animating 闩锁吞掉，立即直达。
  const pageRequestAtRef = useRef(0)
  const lastScrollAtRef = useRef(0)

  /** 只布防恢复链（动画重试 → 非动画硬落位 → 重挂），不自己发 setPage。 */
  const armFallback = useCallback((index: number) => {
    clearSwitchTimers()
    pendingIndexRef.current = index
    // 非动画回到「当前原生页」只为清掉卡住的 animating / 交互闩锁，画面不动；
    // 紧接着再发一次动画 setPage，让用户看到的是滑动而不是瞬移。
    const retryAnimated = () => {
      if (pendingIndexRef.current !== index) return
      pagerRef.current?.setPageWithoutAnimation?.(nativeIndexRef.current)
      pagerRef.current?.setPage?.(index)
    }
    // 短探测：30ms（约两帧）后既没进入滚动、也没有页面滚动事件 = setPage 被原生
    // animating 闩锁吞掉 —— 清闩锁后立刻动画重试。
    probeTimerRef.current = setTimeout(() => {
      probeTimerRef.current = null
      if (pendingIndexRef.current !== index) return
      if (scrollStateRef.current === 'idle' && lastScrollAtRef.current <= pageRequestAtRef.current) {
        retryAnimated()
      }
    }, 30)
    // 安静一拍：状态事件可能丢失（pageScrollState 卡在 settling），不能只看状态。
    // 200ms 后若 120ms 内完全没有滚动事件，说明页面确实没动 → 清闩锁后动画重试；
    // 还在动（转场进行中）就绝不插手，避免把滑到一半的动画打断成「卡一下」。
    quietTimerRef.current = setTimeout(() => {
      quietTimerRef.current = null
      if (pendingIndexRef.current !== index) return
      if (Date.now() - lastScrollAtRef.current < 120) return
      retryAnimated()
    }, 200)
    // 最后兜底：900ms 仍没落页 → 非动画硬落位；再 700ms 仍不落页 → 重挂 PagerView。
    fallbackTimerRef.current = setTimeout(() => {
      fallbackTimerRef.current = null
      if (pendingIndexRef.current !== index) return
      pagerRef.current?.setPageWithoutAnimation?.(index)
      remountTimerRef.current = setTimeout(() => {
        remountTimerRef.current = null
        if (pendingIndexRef.current !== index) return
        pendingIndexRef.current = null
        setPagerKey(k => k + 1)
      }, 700)
    }, 900)
  }, [clearSwitchTimers, pagerRef])

  /** 只登记目标页并布防恢复链；过渡中（直连 setPage 可能被原生丢弃）立即非动画直达。 */
  const trackPageSwitch = useCallback((index: number) => {
    pageRequestAtRef.current = Date.now()
    lastScrollAtRef.current = 0
    if (scrollStateRef.current !== 'idle') {
      pendingIndexRef.current = index
      pagerRef.current?.setPageWithoutAnimation?.(index)
    }
    armFallback(index)
  }, [armFallback, pagerRef])

  const sendPage = useCallback((index: number) => {
    pendingIndexRef.current = index
    pageRequestAtRef.current = Date.now()
    lastScrollAtRef.current = 0
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
    pageRequestAtRef.current = Date.now()
    lastScrollAtRef.current = 0
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
  const notifyPageSelected = useCallback((position?: number) => {
    if (position != null) nativeIndexRef.current = position
    pendingIndexRef.current = null
    clearSwitchTimers()
    clearWatchdog()
    clearPagerLatch()
  }, [clearPagerLatch, clearSwitchTimers, clearWatchdog])

  const onPageScroll = useCallback(() => {
    activityAtRef.current = Date.now()
    lastScrollAtRef.current = Date.now()
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
