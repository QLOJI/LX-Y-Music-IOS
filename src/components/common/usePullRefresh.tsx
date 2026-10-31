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
 * 最重要的约束：**绝不修改列表自身的滚动状态** —— 不设 contentInset、不调用
 * scrollToOffset。之前用「inset 托住 + 程序化滚动」时，会和 UIScrollView 自己的
 * 减速、回弹动画抢控制权，抢输后列表会卡死在半路（只能重进）。
 *
 * 现在的下拉动作靠调用方套一层 `Animated.View`（把返回的 `pullOffset` 作为
 * `translateY`）：位移只发生在渲染层，滚动状态、惯性、回弹完全交给系统。
 *
 * 指示器只在「越过列表顶部」时出现：以挂载后学到的顶部偏移为基准，
 * 列表中间往下滑（往顶部滚）时 y 永远大于顶部，进度恒为 0。
 */
export const PULL_TRIGGER = 32
export const REFRESH_MIN_MS = 900
const SETTLE_MS = 250
const FALLBACK_MS = 700
const WATCHDOG_MS = 10000
const ICON_SIZE = 26
const ICON_RADIUS = 10
const ICON_STROKE = 2.4
const ICON_CIRCUMFERENCE = 2 * Math.PI * ICON_RADIUS

type ScrollListRef = { current: any }

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

const usePullRefresh = (refreshing: boolean, onRefresh: () => void, _listRef?: ScrollListRef, topOffset = 0) => {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current
  const spin = useRef(new Animated.Value(0)).current
  const pullRef = useRef(0)
  const lastPullRef = useRef(-1)
  const dragStartRef = useRef<number | null>(null)
  const lastOffsetRef = useRef<number | null>(null)
  // 列表顶部偏移（含 iOS 安全区 inset，可能为负）：挂载后静默 120ms 学一次。
  const topOffsetRef = useRef<number | null>(null)
  const topCandidateRef = useRef<number | null>(null)
  const topCaptureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshingRef = useRef(refreshing)
  const displayRef = useRef(refreshing)
  const sawRefreshingRef = useRef(false)
  const [displayRefreshing, setDisplayRefreshing] = useState(refreshing)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const startedAtRef = useRef(refreshing ? Date.now() : 0)
  const minTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  refreshingRef.current = refreshing

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }

  const hideIndicator = useCallback(() => {
    displayRef.current = false
    dragStartRef.current = null
    pullRef.current = 0
    lastPullRef.current = 0
    setDisplayRefreshing(false)
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start()
  }, [progress])

  useEffect(() => {
    if (refreshing) {
      clearTimer(settleTimerRef)
      clearTimer(fallbackTimerRef)
      clearTimer(minTimerRef)
      sawRefreshingRef.current = true
      startedAtRef.current = Date.now()
      displayRef.current = true
      setDisplayRefreshing(true)
      progress.stopAnimation()
      Animated.timing(progress, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start()
      clearTimer(watchdogRef)
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null
        // 父级 refreshing 长期不落地（接口挂起/页面态丢失）：强制收起，
        // 绝不把刷新图标永久留在顶部。
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
  }, [refreshing, progress, hideIndicator])

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
    clearTimer(settleTimerRef)
    clearTimer(fallbackTimerRef)
    clearTimer(topCaptureTimerRef)
    clearTimer(watchdogRef)
  }, [])

  /** 学顶部偏移：只认顶部区域（y ≤ 0）且滚动停住 120ms 后的静止值。 */
  const scheduleTopCapture = useCallback((y: number) => {
    if (topOffsetRef.current != null) return
    if (dragStartRef.current != null || displayRef.current) return
    if (y > 0) return
    topCandidateRef.current = y
    clearTimer(topCaptureTimerRef)
    topCaptureTimerRef.current = setTimeout(() => {
      topCaptureTimerRef.current = null
      if (topOffsetRef.current != null) return
      if (dragStartRef.current != null || displayRef.current) return
      const candidate = topCandidateRef.current
      const last = lastOffsetRef.current
      if (candidate == null || last == null) return
      if (Math.abs(last - candidate) > 0.5) return
      topOffsetRef.current = last
    }, 120)
  }, [])

  const handleScrollBeginDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // 记住拖动起点：顶部偏移还没学到时，用它作兜底基准。
    dragStartRef.current = e.nativeEvent.contentOffset.y
    pullRef.current = 0
    lastPullRef.current = 0
  }, [])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = y
    scheduleTopCapture(y)
    if (displayRef.current) {
      // 刷新中：忽略回弹过程，指示器保持在完整状态。
      if (lastPullRef.current !== PULL_TRIGGER) {
        lastPullRef.current = PULL_TRIGGER
        progress.setValue(1)
      }
      return
    }
    const start = dragStartRef.current
    // 非拖动滚动（惯性、回弹、程序化滚动）：一律归零，绝不点亮图标。
    if (start == null) {
      if (lastPullRef.current !== 0) {
        lastPullRef.current = 0
        pullRef.current = 0
        progress.stopAnimation()
        progress.setValue(0)
      }
      return
    }
    const top = topOffsetRef.current
    // 顶部已知：只有「越过顶部」（y 比顶部更负）才算下拉；列表中间往下滑恒为 0。
    // 顶部未知：退回拖动起点，但只认从顶部区域开始的拖动。
    const pull = top != null
      ? Math.max(0, top - y)
      : (start <= 0 ? Math.max(0, start - y) : 0)
    pullRef.current = pull
    if (pull === lastPullRef.current) return
    lastPullRef.current = pull
    progress.stopAnimation()
    progress.setValue(Math.min(1, pull / PULL_TRIGGER))
  }, [progress, scheduleTopCapture])

  const handleScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const start = dragStartRef.current
    dragStartRef.current = null
    if (displayRef.current) return
    const y = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = y
    const top = topOffsetRef.current
    const pull = top != null
      ? Math.max(0, top - y)
      : (start != null && start <= 0 ? Math.max(0, start - y) : 0)
    pullRef.current = pull
    const atTop = top != null || (start != null && start <= 0)
    if (atTop && pull >= PULL_TRIGGER) {
      displayRef.current = true
      setDisplayRefreshing(true)
      progress.stopAnimation()
      progress.setValue(1)
      onRefreshRef.current()
      // 父级没有进入 refreshing（空实现 / 被丢弃）时收回图标。
      sawRefreshingRef.current = false
      clearTimer(fallbackTimerRef)
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null
        if (!sawRefreshingRef.current && !refreshingRef.current) hideIndicator()
      }, FALLBACK_MS)
      return
    }
    // 轻拉 / 普通滚动松手：等回弹结束再复位（回弹过程可能不再发 onScroll）。
    clearTimer(settleTimerRef)
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null
      if (displayRef.current) return
      pullRef.current = 0
      lastPullRef.current = 0
      progress.stopAnimation()
      Animated.timing(progress, {
        toValue: 0,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start()
    }, SETTLE_MS)
  }, [progress, hideIndicator])

  const handleMomentumScrollEnd = useCallback(() => {
    if (displayRef.current) return
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
  // 列表本体的下拉位移（调用方套在 Animated.View 上）：只动渲染，不动滚动状态。
  const pullOffset = progress.interpolate({ inputRange: [0, 1], outputRange: [0, PULL_TRIGGER] })

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
