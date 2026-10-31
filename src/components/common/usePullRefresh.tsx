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
 * 2. 不调 scrollToOffset / 不改 contentInset（绝对偏移的坐标口径不可靠，会把落点搞偏）。
 *
 * 松手后的回落由「逐帧曲线」接管：
 *   · 视觉目标 V(t) 从松手时的拉动距离按 easeOutCubic 减速到终点
 *     （轻拉 → 0；下拉触发 → 32pt 刷新位）；
 *   · 每帧读系统当前剩余过冲 R = 松手顶部偏移 − 当前滚动偏移，
 *     令 transform = V − R。于是「系统偏移 + transform」恒等于 V ——
 *     系统自己的快速回弹被完全抵消，画面只按我们的曲线走，位置永远精确。
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

const usePullRefresh = (refreshing: boolean, onRefresh: () => void, _listRef?: ScrollListRef, topOffset = 0) => {
  const theme = useTheme()
  // 圆圈进度：拖动跟手 / 刷新保持 / 回落时跟随 V。
  const progress = useRef(new Animated.Value(0)).current
  // 列表位移（0~1 系数，乘 32pt）。回落期间由逐帧曲线直接赋值。
  const hold = useRef(new Animated.Value(0)).current
  const spin = useRef(new Animated.Value(0)).current
  const pullRef = useRef(0)
  const lastPullRef = useRef(-1)
  const dragStartRef = useRef<number | null>(null)
  const lastOffsetRef = useRef<number | null>(null)
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
  // 逐帧回落会话
  const returningRef = useRef(false)
  const returnRafRef = useRef<number | null>(null)
  const returnTopRef = useRef(0)
  const returnPullRef = useRef(0)
  const returnTargetRef = useRef(0)
  const returnStartAtRef = useRef(0)
  const returnDurationRef = useRef(400)
  const holdSessionRef = useRef(false)
  // 补偿量的平滑值：滚动事件与渲染帧不同步时，直接 setValue 会一帧一跳。
  const lastHoldRef = useRef(0)
  refreshingRef.current = refreshing

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }

  const stopReturn = useCallback(() => {
    returningRef.current = false
    if (returnRafRef.current != null) {
      cancelAnimationFrame(returnRafRef.current)
      returnRafRef.current = null
    }
  }, [])

  const animateHold = useCallback((to: number, duration: number) => {
    hold.stopAnimation()
    // 必须与回落会话一样走 JS 驱动：同一个 Animated.Value 混用原生/JS 驱动
    // 会被 RN 丢弃更新，表现为回落时上下跳变。
    Animated.timing(hold, {
      toValue: to,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [hold])

  /**
   * 逐帧回落：视觉目标 V 走 easeOutCubic，transform = V − 系统剩余过冲。
   * 系统怎么弹都不影响最终位置与速度。
   */
  const startReturnSession = useCallback((top: number, pull: number, target: number) => {
    stopReturn()
    holdSessionRef.current = true
    returningRef.current = true
    returnTopRef.current = top
    returnPullRef.current = pull
    returnTargetRef.current = target
    returnStartAtRef.current = Date.now()
    // 目标越远收得越久；整体比惯性慢一档。
    const distance = Math.abs(pull - target)
    returnDurationRef.current = target > 0
      ? Math.round(clamp(320 + distance * 3, 320, 700))
      : Math.round(clamp(420 + distance * 7, 420, 980))
    hold.stopAnimation()
    hold.setValue(0)
    lastHoldRef.current = 0
    progress.stopAnimation()

    const tick = () => {
      returnRafRef.current = null
      if (!returningRef.current) return
      const p = clamp((Date.now() - returnStartAtRef.current) / returnDurationRef.current, 0, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = returnPullRef.current + (returnTargetRef.current - returnPullRef.current) * eased
      const last = lastOffsetRef.current
      const remain = last == null
        ? 0
        : clamp(returnTopRef.current - last, 0, Math.max(0, v) + PULL_TRIGGER)
      // 平滑补偿：滚动事件与渲染帧不同步时，直接赋值会一帧一跳（页头在列表里的
      // 页面最明显）；取 0.6 的一阶低通，视觉误差远小于可见抖动。
      const targetHold = clamp((v - remain) / PULL_TRIGGER, 0, 2.2)
      const smoothed = lastHoldRef.current + (targetHold - lastHoldRef.current) * 0.6
      lastHoldRef.current = smoothed
      hold.setValue(smoothed)
      progress.setValue(clamp(v / PULL_TRIGGER, 0, 1))
      if (p >= 1) {
        returningRef.current = false
        holdSessionRef.current = true
        lastHoldRef.current = target / PULL_TRIGGER
        hold.setValue(target / PULL_TRIGGER)
        progress.setValue(target > 0 ? 1 : 0)
        return
      }
      returnRafRef.current = requestAnimationFrame(tick)
    }
    tick()
  }, [hold, progress, stopReturn])

  const hideIndicator = useCallback(() => {
    const dragging = dragStartRef.current != null
    displayRef.current = false
    dragStartRef.current = null
    pullRef.current = 0
    lastPullRef.current = 0
    setDisplayRefreshing(false)
    stopReturn()
    holdSessionRef.current = false
    if (dragging) {
      // 手指还按在列表上：直接归零，绝不在拖动中逐帧改 transform。
      hold.stopAnimation()
      hold.setValue(0)
      lastHoldRef.current = 0
    } else {
      // 刷新收尾：按同一套减速曲线收回 32pt。
      animateHold(0, 460)
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, animateHold, hold, stopReturn])

  useEffect(() => {
    if (refreshing) {
      clearTimer(fallbackTimerRef)
      clearTimer(minTimerRef)
      sawRefreshingRef.current = true
      startedAtRef.current = Date.now()
      displayRef.current = true
      setDisplayRefreshing(true)
      // 下拉触发的刷新由 startReturnSession 负责滑到 32pt；
      // 程序刷新（切 tab / 首次进入）没有会话，这里补一段从 0 到 32pt 的减速。
      if (!holdSessionRef.current) animateHold(1, 320)
      progress.stopAnimation()
      Animated.timing(progress, {
        toValue: 1,
        duration: 240,
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
    clearTimer(watchdogRef)
    if (returnRafRef.current != null) cancelAnimationFrame(returnRafRef.current)
  }, [])

  const handleScrollBeginDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // 刷新中用户又按住列表：保持 32pt 位移，避免抓取瞬间画面跳。
    if (!displayRef.current) {
      // 回落途中被按住：停掉曲线，位移交给系统/手势（残余量通常已很小）。
      stopReturn()
      holdSessionRef.current = false
      hold.stopAnimation()
      hold.setValue(0)
      lastHoldRef.current = 0
      progress.stopAnimation()
    }
    dragStartRef.current = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = dragStartRef.current
    pullRef.current = 0
    lastPullRef.current = 0
  }, [hold, progress, stopReturn])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = y
    if (displayRef.current) {
      if (lastPullRef.current !== PULL_TRIGGER) {
        lastPullRef.current = PULL_TRIGGER
        progress.setValue(1)
      }
      return
    }
    // 回落期间由曲线独占，不让滚动事件提前归零。
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
    const pull = start <= 0 ? Math.max(0, start - y) : 0
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
    lastOffsetRef.current = y
    const pull = start == null ? pullRef.current : (start <= 0 ? Math.max(0, start - y) : 0)
    pullRef.current = pull
    if (start != null && start <= 0 && pull >= PULL_TRIGGER) {
      // 下拉触发：从松手位置按减速曲线滑到 32pt 刷新位。
      displayRef.current = true
      setDisplayRefreshing(true)
      progress.setValue(1)
      startReturnSession(start, pull, PULL_TRIGGER)
      onRefreshRef.current()
      sawRefreshingRef.current = false
      clearTimer(fallbackTimerRef)
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null
        if (!sawRefreshingRef.current && !refreshingRef.current) hideIndicator()
      }, FALLBACK_MS)
      return
    }
    // 轻拉松手：按减速曲线收回 0（比系统回弹慢，且位置精确）。
    if (start != null && start <= 0 && pull > 0) {
      startReturnSession(start, pull, 0)
      return
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, hideIndicator, startReturnSession])

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
  const pullOffset = hold.interpolate({ inputRange: [0, 2.2], outputRange: [0, PULL_TRIGGER * 2.2] })

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
