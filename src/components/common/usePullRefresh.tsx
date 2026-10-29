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
 * 固定策略（所有列表同一套）：
 *   · 下拉距离按「手指按下时的滚动偏移」为基准计算 —— iOS 的安全区会给滚动视图
 *     一个负的初始偏移，直接拿 -contentOffset.y 当距离会在挂载瞬间误判成「已下拉」；
 *   · 只有「从列表顶部开始拖」才算下拉；达到 PULL_TRIGGER 才触发，触发后用 contentInset
 *     托住列表，给刷新图标留出空白位；
 *   · 刷新结束先动画滚回拖动起点（不是 0 —— iOS 安全区会让原始顶部是负偏移），再撤掉
 *     inset（内容位置只由 offset 决定，撤 inset 不再跳动），落点与刷新前完全一致；
 *   · 指标至少展示 REFRESH_MIN_MS；另有看门狗，父级 refreshing 卡住时也会收起；
 *   · 触发后父级若没有进入 refreshing（回调空实现 / 被丢弃），兜底定时器收回图标。
 */
export const PULL_TRIGGER = 32
export const REFRESH_MIN_MS = 900
const SETTLE_MS = 250
const FALLBACK_MS = 700
const UNHOLD_DELAY_MS = 280
const WATCHDOG_MS = 10000
const ICON_SIZE = 26
const ICON_RADIUS = 10
const ICON_STROKE = 2.4
const ICON_CIRCUMFERENCE = 2 * Math.PI * ICON_RADIUS

type ScrollListRef = { current: any }

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

const usePullRefresh = (refreshing: boolean, onRefresh: () => void, listRef?: ScrollListRef, topOffset = 0) => {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current
  const spin = useRef(new Animated.Value(0)).current
  const pullRef = useRef(0)
  const lastPullRef = useRef(-1)
  const dragStartRef = useRef<number | null>(null)
  // 下拉起点 = 原始顶部偏移（含 iOS 安全区 inset，可能为负）；托住位再往下 32pt。
  const restOffsetRef = useRef(0)
  const holdOffsetRef = useRef(-PULL_TRIGGER)
  const refreshingRef = useRef(refreshing)
  const displayRef = useRef(refreshing)
  const sawRefreshingRef = useRef(false)
  const heldRef = useRef(false)
  const [held, setHeld] = useState(false)
  const [displayRefreshing, setDisplayRefreshing] = useState(refreshing)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const startedAtRef = useRef(refreshing ? Date.now() : 0)
  const minTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unholdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  refreshingRef.current = refreshing

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }

  /** 托住列表：下拉后内容停在刷新位，图标下方/上方留出 32pt 空白。 */
  const holdList = useCallback(() => {
    heldRef.current = true
    setHeld(true)
  }, [])

  /** 松开列表：先动画回原始顶部（拖动起点），动画结束再撤 inset（不会二次跳动）。 */
  const releaseHold = useCallback(() => {
    if (!heldRef.current) return
    heldRef.current = false
    listRef?.current?.scrollToOffset?.({ offset: restOffsetRef.current, animated: true })
    clearTimer(unholdTimerRef)
    unholdTimerRef.current = setTimeout(() => {
      unholdTimerRef.current = null
      setHeld(false)
    }, UNHOLD_DELAY_MS)
  }, [listRef])

  const hideIndicator = useCallback(() => {
    displayRef.current = false
    dragStartRef.current = null
    pullRef.current = 0
    lastPullRef.current = 0
    setDisplayRefreshing(false)
    releaseHold()
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start()
  }, [progress, releaseHold])

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

  // inset 落地后再把内容推进刷新位（先有可停的区间，滚动才不会被弹回去）。
  useEffect(() => {
    if (!held) return
    listRef?.current?.scrollToOffset?.({ offset: holdOffsetRef.current, animated: true })
  }, [held, listRef])

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
    clearTimer(unholdTimerRef)
    clearTimer(watchdogRef)
  }, [])

  const handleScrollBeginDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // 记住拖动起点：iOS 安全区会把初始偏移压到负数，必须按相对位移算下拉距离。
    dragStartRef.current = e.nativeEvent.contentOffset.y
    pullRef.current = 0
    lastPullRef.current = 0
  }, [])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (displayRef.current) {
      // 刷新中：忽略回弹过程，指示器保持在完整状态。
      if (lastPullRef.current !== PULL_TRIGGER) {
        lastPullRef.current = PULL_TRIGGER
        progress.setValue(1)
      }
      return
    }
    const start = dragStartRef.current
    // 非拖动滚动（安全区初始偏移、回弹、程序化滚动）：一律视为 0，避免误点亮图标。
    if (start == null) {
      if (lastPullRef.current !== 0) {
        lastPullRef.current = 0
        pullRef.current = 0
        progress.stopAnimation()
        progress.setValue(0)
      }
      return
    }
    const pull = Math.max(0, start - e.nativeEvent.contentOffset.y)
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
    const pull = start == null ? pullRef.current : Math.max(0, start - e.nativeEvent.contentOffset.y)
    pullRef.current = pull
    // 只有从列表顶部（偏移 ≤ 0）开始的拖动才是下拉刷新；从列表中间甩到顶部的回弹不算。
    if (start != null && start <= 0 && pull >= PULL_TRIGGER) {
      // 回位目标不高于 0：防止在回弹途中再次按下时把「回弹中的偏移」当成原始顶部。
      restOffsetRef.current = Math.min(start, 0)
      holdOffsetRef.current = restOffsetRef.current - PULL_TRIGGER
      // 先点亮完整指示器、托住列表，再发请求：图标不会闪一下又缩回去，列表也留出空白位。
      displayRef.current = true
      setDisplayRefreshing(true)
      progress.stopAnimation()
      progress.setValue(1)
      holdList()
      onRefreshRef.current()
      // 父级没有进入 refreshing（空实现 / 被丢弃）时收回图标与列表。
      sawRefreshingRef.current = false
      clearTimer(fallbackTimerRef)
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null
        if (!sawRefreshingRef.current && !refreshingRef.current) hideIndicator()
      }, FALLBACK_MS)
      return
    }
    // 轻拉：等回弹结束再复位（回弹过程可能不再发 onScroll），避免图标停在顶部。
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
  }, [progress, holdList, hideIndicator])

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
    scrollProps: {
      onScroll: handleScroll,
      onScrollBeginDrag: handleScrollBeginDrag,
      onScrollEndDrag: handleScrollEndDrag,
      onMomentumScrollEnd: handleMomentumScrollEnd,
      scrollEventThrottle: 16,
      bounces: true,
      // 只有下拉触发的刷新才托住列表；程序触发的刷新不改变列表位置。
      contentInset: held ? { top: PULL_TRIGGER } : undefined,
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
