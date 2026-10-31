import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Animated,
  Easing,
  StyleSheet,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { useTheme } from '@/store/theme/hook'

/**
 * 自绘下拉刷新（不依赖系统 UIRefreshControl）。
 *
 * 硬约束：
 * 1. 不在手指拖动过程中改列表 transform（会让 UIKit 反复重算 pan → 拉不动/抖动）；
 * 2. 松手后的回落**不交给系统**：系统的橡胶回弹几乎瞬间弹回，观感就是「跳过去」。
 *
 * 回落做法（松手瞬间、手指已离开）：
 *   · 用 `scrollToOffset({animated:false})` 把系统偏移静默归位，取消系统自己的快速回弹；
 *   · 同时把等量的位移交给 transform（画面位置与松手瞬间一致，不闪）；
 *   · 再用 `easeOutCubic` 把 transform 收回去，时长随拉动距离增长（≈320~780ms），
 *     即「按惯性速率」的减速收尾。
 *
 * 下拉只在「从列表顶部开始的拖动」里计数：起点 > 0（列表中间）一律不算。
 */
export const PULL_TRIGGER = 32
export const REFRESH_MIN_MS = 900
const FALLBACK_MS = 700
const WATCHDOG_MS = 10000
const ICON_SIZE = 26
const ICON_RADIUS = 10
const ICON_STROKE = 2.4
const ICON_CIRCUMFERENCE = 2 * Math.PI * ICON_RADIUS

type ScrollListRef = { current: any }

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

const usePullRefresh = (refreshing: boolean, onRefresh: () => void, listRef?: ScrollListRef, topOffset = 0) => {
  const theme = useTheme()
  // 圆圈进度：拖动时跟手，刷新时保持满格。
  const progress = useRef(new Animated.Value(0)).current
  // 列表位移（0~1 系数，乘 32pt）：刷新停留与惯性回落都在这里。
  const hold = useRef(new Animated.Value(0)).current
  const spin = useRef(new Animated.Value(0)).current
  const pullRef = useRef(0)
  const lastPullRef = useRef(-1)
  const dragStartRef = useRef<number | null>(null)
  const refreshingRef = useRef(refreshing)
  const displayRef = useRef(refreshing)
  const sawRefreshingRef = useRef(false)
  const [displayRefreshing, setDisplayRefreshing] = useState(refreshing)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const startedAtRef = useRef(refreshing ? Date.now() : 0)
  const minTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 惯性回落会话：returnTop = 松手时列表静止顶部偏移；returning 期间忽略滚动事件复位。
  const returningRef = useRef(false)
  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const returnTopRef = useRef(0)
  const holdInMsRef = useRef(260)
  refreshingRef.current = refreshing

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }

  const animateHold = useCallback((to: number, duration: number) => {
    hold.stopAnimation()
    Animated.timing(hold, {
      toValue: to,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [hold])

  const readHold = () => {
    const anyHold = hold as unknown as { __getValue?: () => number }
    return typeof anyHold.__getValue === 'function' ? anyHold.__getValue() : 0
  }

  /**
   * 松手后的接管：静默把系统偏移归位（取消系统快速回弹），再用 transform 保持
   * 画面位置不动。之后由调用方把 hold 动画到目标值。
   */
  const takeOverRebound = useCallback((top: number, pull: number): boolean => {
    if (typeof listRef?.current?.scrollToOffset !== 'function') return false
    returningRef.current = true
    returnTopRef.current = top
    clearTimer(returnTimerRef)
    const amount = Math.max(0.05, pull / PULL_TRIGGER)
    // 先落 transform（画面留在松手位置），再让系统偏移归位：同一次桥接批次内生效。
    hold.stopAnimation()
    hold.setValue(amount)
    listRef.current.scrollToOffset({ offset: top, animated: false })
    return true
  }, [hold, listRef])

  const hideIndicator = useCallback(() => {
    const dragging = dragStartRef.current != null
    displayRef.current = false
    dragStartRef.current = null
    pullRef.current = 0
    lastPullRef.current = 0
    setDisplayRefreshing(false)
    clearTimer(returnTimerRef)
    returningRef.current = false
    if (dragging) {
      // 手指还按在列表上：直接归零，绝不在拖动中逐帧改 transform。
      hold.stopAnimation()
      hold.setValue(0)
    } else {
      // 刷新收尾：同样按惯性减速收回 32pt，不要弹一下。
      animateHold(0, 420)
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, animateHold, hold])

  useEffect(() => {
    if (refreshing) {
      clearTimer(fallbackTimerRef)
      clearTimer(minTimerRef)
      sawRefreshingRef.current = true
      startedAtRef.current = Date.now()
      const wasDisplaying = displayRef.current
      displayRef.current = true
      setDisplayRefreshing(true)
      // 下拉触发时 takeOverRebound 已经把 hold 放在松手位置：从这里按惯性滑到 32pt。
      // 程序刷新（切 tab / 首次进入）则是从 0 滑到 32pt。
      const duration = wasDisplaying ? clamp(holdInMsRef.current, 220, 680) : 300
      returningRef.current = false
      clearTimer(returnTimerRef)
      animateHold(1, duration)
      progress.stopAnimation()
      Animated.timing(progress, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start()
      clearTimer(watchdogRef)
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null
        if (displayRef.current) hideIndicator()
      }, WATCHDOG_MS)
      return
    }
    clearTimer(watchdogRef)
    if (!displayRef.current) return

    const remain = REFRESH_MIN_MS - (Date.now() - startedAtRef.current)
    clearTimer(minTimerRef)
    if (remain <= 0) {
      hideIndicator()
      return
    }
    minTimerRef.current = setTimeout(() => {
      minTimerRef.current = null
      hideIndicator()
    }, remain)
    return () => { clearTimer(minTimerRef) }
  }, [refreshing, progress, hideIndicator, animateHold])

  // 刷新中旋转圆环
  useEffect(() => {
    if (!displayRefreshing) {
      spin.stopAnimation()
      spin.setValue(0)
      return
    }
    spin.setValue(0)
    const anim = Animated.loop(Animated.timing(spin, {
      toValue: 1,
      duration: 900,
      easing: Easing.linear,
      useNativeDriver: true,
    }))
    anim.start()
    return () => { anim.stop() }
  }, [displayRefreshing, spin])

  useEffect(() => () => {
    clearTimer(minTimerRef)
    clearTimer(fallbackTimerRef)
    clearTimer(returnTimerRef)
    clearTimer(watchdogRef)
  }, [])

  const handleScrollBeginDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // 刷新中用户又按住列表：保持 32pt 位移不动，避免抓取瞬间画面跳一下。
    if (!displayRef.current) {
      // 惯性回落途中被按住：把当前 transform 位移换回滚动偏移，保证画面连续，
      // 之后交给系统/用户手势。
      const hv = readHold()
      if (returningRef.current && hv > 0.01) {
        listRef?.current?.scrollToOffset?.({
          offset: returnTopRef.current - hv * PULL_TRIGGER,
          animated: false,
        })
      }
      returningRef.current = false
      clearTimer(returnTimerRef)
      hold.stopAnimation()
      hold.setValue(0)
      progress.stopAnimation()
    }
    dragStartRef.current = e.nativeEvent.contentOffset.y
    pullRef.current = 0
    lastPullRef.current = 0
  }, [hold, progress, listRef])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (displayRef.current) {
      if (lastPullRef.current !== PULL_TRIGGER) {
        lastPullRef.current = PULL_TRIGGER
        progress.setValue(1)
      }
      return
    }
    // 惯性回落期间由动画独占，不让滚动事件把进度提前归零。
    if (returningRef.current) return
    const start = dragStartRef.current
    if (start == null) {
      if (lastPullRef.current !== 0) {
        lastPullRef.current = 0
        pullRef.current = 0
        progress.stopAnimation()
        progress.setValue(0)
      }
      return
    }
    // 只有「从顶部区域开始的拖动」才算下拉：起点在列表中间时一律为 0。
    const pull = start <= 0 ? Math.max(0, start - e.nativeEvent.contentOffset.y) : 0
    pullRef.current = pull
    if (pull === lastPullRef.current) return
    lastPullRef.current = pull
    progress.stopAnimation()
    progress.setValue(Math.min(1, pull / PULL_TRIGGER))
  }, [progress])

  const handleScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const start = dragStartRef.current
    dragStartRef.current = null
    if (displayRef.current) return
    const y = e.nativeEvent.contentOffset.y
    const pull = start == null ? pullRef.current : (start <= 0 ? Math.max(0, start - y) : 0)
    pullRef.current = pull
    if (start != null && start <= 0 && pull >= PULL_TRIGGER) {
      // 下拉触发：接管系统回弹，让列表从松手位置按惯性滑到 32pt 刷新位。
      const ok = takeOverRebound(start, pull)
      holdInMsRef.current = ok ? clamp(240 + pull * 3, 240, 680) : 300
      displayRef.current = true
      setDisplayRefreshing(true)
      progress.stopAnimation()
      progress.setValue(1)
      onRefreshRef.current()
      sawRefreshingRef.current = false
      clearTimer(fallbackTimerRef)
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null
        if (!sawRefreshingRef.current && !refreshingRef.current) hideIndicator()
      }, FALLBACK_MS)
      return
    }
    // 轻拉松手：同样接管回弹，然后按惯性曲线收回 0。
    if (start != null && start <= 0 && pull > 0) {
      const duration = clamp(320 + pull * 6, 320, 780)
      if (takeOverRebound(start, pull)) {
        animateHold(0, duration)
        progress.stopAnimation()
        Animated.timing(progress, {
          toValue: 0,
          duration,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }).start()
        clearTimer(returnTimerRef)
        returnTimerRef.current = setTimeout(() => {
          returnTimerRef.current = null
          returningRef.current = false
        }, duration + 60)
        return
      }
      progress.stopAnimation()
      Animated.timing(progress, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start()
      return
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, hideIndicator, takeOverRebound, animateHold])

  const handleMomentumScrollEnd = useCallback(() => {
    if (displayRef.current || returningRef.current) return
    pullRef.current = 0
    lastPullRef.current = 0
    progress.stopAnimation()
    progress.setValue(0)
  }, [progress])

  // 下拉阶段：圆环从圆点画满；刷新阶段：保留一段缺口并旋转，形成加载圈。
  const dashOffset = displayRefreshing
    ? 0
    : progress.interpolate({
      inputRange: [0, 1],
      outputRange: [ICON_CIRCUMFERENCE, 0],
    })
  const dashArray = displayRefreshing
    ? `${ICON_CIRCUMFERENCE * 0.78} ${ICON_CIRCUMFERENCE}`
    : `${ICON_CIRCUMFERENCE} ${ICON_CIRCUMFERENCE}`
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  // 列表位移（调用方套在 Animated.View 上）。
  const pullOffset = hold.interpolate({ inputRange: [0, 1.6], outputRange: [0, PULL_TRIGGER * 1.6] })

  const indicator = (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.indicator,
        {
          top: topOffset,
          opacity: progress,
          transform: [{
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [-PULL_TRIGGER, 0],
            }),
          }],
        },
      ]}
    >
      <Animated.View style={{ transform: [{ rotate }] }}>
        <Svg width={ICON_SIZE} height={ICON_SIZE} viewBox={`0 0 ${ICON_SIZE} ${ICON_SIZE}`}>
          <AnimatedCircle
            cx={ICON_SIZE / 2}
            cy={ICON_SIZE / 2}
            r={ICON_RADIUS}
            stroke={theme['c-primary']}
            strokeWidth={ICON_STROKE}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={dashArray}
            strokeDashoffset={dashOffset as any}
            transform={`rotate(-90 ${ICON_SIZE / 2} ${ICON_SIZE / 2})`}
          />
        </Svg>
      </Animated.View>
    </Animated.View>
  )

  return {
    indicator,
    pullOffset,
    scrollProps: {
      onScroll: handleScroll,
      onScrollBeginDrag: handleScrollBeginDrag,
      onScrollEndDrag: handleScrollEndDrag,
      onMomentumScrollEnd: handleMomentumScrollEnd,
      scrollEventThrottle: 16,
      bounces: true,
    },
  }
}

const styles = StyleSheet.create({
  indicator: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: PULL_TRIGGER,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
})

export default usePullRefresh
