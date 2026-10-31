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
 * 1. 不修改列表自身的滚动状态（不设 contentInset、不调 scrollToOffset）；
 * 2. **不在手指拖动过程中改列表 transform** —— 给正在被拖动的 ScrollView 逐帧改
 *    transform 会让 UIKit 反复重算 pan，表现为「拉不动 + 频繁抖动」；
 * 3. 圆圈位置相对「列表可视区顶部」固定，所有页面一致。
 *
 * 交互分三段：
 *   · 拖动阶段：只按进度点亮圆圈，列表位移由系统回弹提供（不干预）；
 *   · 松手未达阈值：用 transform 做一段「惯性减速」的回落 —— 以系统剩余过冲为
 *     基准抵消掉它的快速回弹，再由 easeOutCubic 慢慢把位移收到 0（时长随拉动距离
 *     增长），观感接近一次自然减速；
 *   · 刷新阶段（松手达标 / 程序刷新）：列表整体下移 32pt 停留，结束时同样按惯性
 *     曲线收回。
 *
 * 只在「从列表顶部开始的拖动」里计数：以手指按下时的偏移为基准，起点 > 0（列表中间）
 * 一律不算，图标不会在列表中段冒出来。
 */
export const PULL_TRIGGER = 32
export const REFRESH_MIN_MS = 900
const FALLBACK_MS = 700
const WATCHDOG_MS = 10000
const RETURN_MIN_MS = 300
const RETURN_MAX_MS = 700
const ICON_SIZE = 26
const ICON_RADIUS = 10
const ICON_STROKE = 2.4
const ICON_CIRCUMFERENCE = 2 * Math.PI * ICON_RADIUS

type ScrollListRef = { current: any }

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

const usePullRefresh = (refreshing: boolean, onRefresh: () => void, _listRef?: ScrollListRef, topOffset = 0) => {
  const theme = useTheme()
  // 圆圈进度：拖动时跟手，刷新时保持满格。
  const progress = useRef(new Animated.Value(0)).current
  // 列表位移（0~1 系数，乘 32pt）：只在刷新态和「惯性回落」期间使用。
  const hold = useRef(new Animated.Value(0)).current
  const spin = useRef(new Animated.Value(0)).current
  const pullRef = useRef(0)
  const lastPullRef = useRef(-1)
  const lastOffsetRef = useRef<number | null>(null)
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
  // 惯性回落会话
  const returningRef = useRef(false)
  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const returnTopRef = useRef(0)
  const returnPullRef = useRef(0)
  const returnStartRef = useRef(0)
  const returnDurationRef = useRef(RETURN_MIN_MS)
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

  const stopReturn = useCallback(() => {
    returningRef.current = false
    clearTimer(returnTimerRef)
    hold.stopAnimation()
    hold.setValue(0)
  }, [hold])

  const hideIndicator = useCallback(() => {
    // 手指还按在列表上时直接归零，不做 transform 动画——拖动中逐帧改位移就是抖动的来源。
    const dragging = dragStartRef.current != null
    displayRef.current = false
    dragStartRef.current = null
    pullRef.current = 0
    lastPullRef.current = 0
    setDisplayRefreshing(false)
    if (dragging) {
      stopReturn()
    } else {
      // 收尾按惯性减速：从 32pt 刷新位平滑收回，而不是 180ms 弹一下。
      returningRef.current = false
      clearTimer(returnTimerRef)
      animateHold(0, 320)
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, animateHold, stopReturn])

  useEffect(() => {
    if (refreshing) {
      clearTimer(fallbackTimerRef)
      clearTimer(minTimerRef)
      sawRefreshingRef.current = true
      startedAtRef.current = Date.now()
      displayRef.current = true
      setDisplayRefreshing(true)
      stopReturn()
      // 列表在系统回弹之上按惯性曲线落到 32pt 刷新位（不是瞬间顶下去）。
      animateHold(1, 260)
      progress.stopAnimation()
      Animated.timing(progress, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start()
      clearTimer(watchdogRef)
      watchdogRef.current = setTimeout(() => {
        watchdogRef.current = null
        // 父级 refreshing 长期不落地（接口挂起/页面态丢失）：强制收起，
        // 绝不把刷新图标永久留在列表上方。
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
  }, [refreshing, progress, hideIndicator, animateHold, stopReturn])

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

  /**
   * 松手未达阈值：抵消系统的快速回弹，再按 easeOutCubic 慢慢收回。
   *   R(t) = 系统此刻剩余的过冲（顶部 - 当前偏移，来自 onScroll）
   *   V(t) = 我们期望的「剩余下移量」，从松手时的拉动距离按惯性曲线降到 0
   *   额外位移 = max(0, V - R)，加到列表 transform 上 —— 观感就是「弹得慢、收得稳」。
   */
  const startInertiaReturn = useCallback((top: number, pull: number) => {
    returningRef.current = true
    returnTopRef.current = top
    returnPullRef.current = Math.max(pull, 8)
    returnStartRef.current = Date.now()
    returnDurationRef.current = Math.round(Math.min(RETURN_MAX_MS, RETURN_MIN_MS + pull * 4))
    hold.stopAnimation()
    hold.setValue(0)
    clearTimer(returnTimerRef)
    const tick = () => {
      returnTimerRef.current = null
      if (!returningRef.current) return
      const elapsed = Date.now() - returnStartRef.current
      const p = Math.min(1, elapsed / returnDurationRef.current)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = returnPullRef.current * (1 - eased)
      const last = lastOffsetRef.current
      // 松手后接近尾声时系统回弹一定已结束，不再依赖可能缺失的滚动事件。
      const remaining = p > 0.7 || last == null
        ? 0
        : Math.max(0, returnTopRef.current - last)
      const extra = Math.max(0, v - Math.min(remaining, v))
      hold.setValue(Math.min(1, extra / PULL_TRIGGER))
      progress.setValue(Math.min(1, v / PULL_TRIGGER))
      if (p >= 1) {
        returningRef.current = false
        hold.setValue(0)
        progress.setValue(0)
        return
      }
      returnTimerRef.current = setTimeout(tick, 16)
    }
    tick()
  }, [hold, progress])

  const handleScrollBeginDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // 新手势开始：撤掉上一次的回落动画，避免 transform 和 pan 抢。
    stopReturn()
    progress.stopAnimation()
    dragStartRef.current = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = dragStartRef.current
    pullRef.current = 0
    lastPullRef.current = 0
  }, [stopReturn, progress])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = y
    if (displayRef.current) {
      // 刷新中：忽略回弹过程，指示器保持在完整状态。
      if (lastPullRef.current !== PULL_TRIGGER) {
        lastPullRef.current = PULL_TRIGGER
        progress.setValue(1)
      }
      return
    }
    const start = dragStartRef.current
    // 惯性回落会话中：进度与位移由 startInertiaReturn 驱动，这里只负责记录偏移。
    if (returningRef.current) return
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
    // 只有「从顶部区域开始的拖动」才算下拉：起点在列表中间（> 0）时，
    // 往下滑是往顶部滚，不是下拉，进度恒为 0。
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
      displayRef.current = true
      setDisplayRefreshing(true)
      progress.stopAnimation()
      progress.setValue(1)
      onRefreshRef.current()
      // 父级没有进入 refreshing（空实现 / 被丢弃）时收回图标与位移。
      sawRefreshingRef.current = false
      clearTimer(fallbackTimerRef)
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null
        if (!sawRefreshingRef.current && !refreshingRef.current) hideIndicator()
      }, FALLBACK_MS)
      return
    }
    // 轻拉松手：走惯性减速回落（顶部位移补偿 + easeOutCubic 收尾）。
    if (start != null && start <= 0 && pull > 0) {
      startInertiaReturn(start, pull)
      return
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, hideIndicator, startInertiaReturn])

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
  // 列表位移（调用方套在 Animated.View 上）：只跟刷新态 / 惯性回落走。
  const pullOffset = hold.interpolate({ inputRange: [0, 1], outputRange: [0, PULL_TRIGGER] })

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
