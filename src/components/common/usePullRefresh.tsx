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
 * 结论先行：**松手后的回弹不接管**。前面几版尝试过逐帧补偿系统回弹（取消它的快速
 * 回弹、自己跑减速曲线），在带页头的列表上会因事件与帧不同步产生上下弹跳、位置
 * 跳顶等不稳定现象。现在回归最自然、最稳的做法：
 *   · 拖动阶段：只按进度点亮顶部圆圈，列表位移完全由系统橡胶回弹提供；
 *   · 松手未达阈值：系统自己弹回，圆圈按减速曲线淡出；
 *   · 刷新态：延迟 200ms（等系统回弹落定）后，列表用 380ms 平滑下移 32pt 形成
 *     刷新位；结束用 460ms 收回。全程只有一段单次 JS 动画，没有逐帧补偿。
 *
 * 下拉只在「从列表顶部开始的拖动」里计数：起点 > 0（列表中间）一律不算。
 */
export const PULL_TRIGGER = 32
export const REFRESH_MIN_MS = 900
const FALLBACK_MS = 700
const WATCHDOG_MS = 10000
const HOLD_IN_DELAY_MS = 200
const HOLD_IN_MS = 380
const HOLD_OUT_MS = 460
const ICON_SIZE = 26
const ICON_RADIUS = 10
const ICON_STROKE = 2.4
const ICON_CIRCUMFERENCE = 2 * Math.PI * ICON_RADIUS

type ScrollListRef = { current: any }

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

const usePullRefresh = (refreshing: boolean, onRefresh: () => void, _listRef?: ScrollListRef, topOffset = 0) => {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current
  // 列表刷新位的位移（只在刷新态使用，单次动画，不做逐帧补偿）。
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
  const holdDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  refreshingRef.current = refreshing

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }

  const hideIndicator = useCallback(() => {
    const dragging = dragStartRef.current != null
    displayRef.current = false
    dragStartRef.current = null
    pullRef.current = 0
    lastPullRef.current = 0
    setDisplayRefreshing(false)
    clearTimer(holdDelayRef)
    if (dragging) {
      // 手指还按在列表上：位移直接归零，不在拖动中做任何动画。
      hold.stopAnimation()
      hold.setValue(0)
    } else {
      hold.stopAnimation()
      Animated.timing(hold, {
        toValue: 0,
        duration: HOLD_OUT_MS,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: false,
      }).start()
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, hold])

  useEffect(() => {
    if (refreshing) {
      clearTimer(fallbackTimerRef)
      clearTimer(minTimerRef)
      sawRefreshingRef.current = true
      startedAtRef.current = Date.now()
      displayRef.current = true
      setDisplayRefreshing(true)
      progress.stopAnimation()
      Animated.timing(progress, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start()
      // 等系统橡胶回弹先落定，再用一段平滑下移形成刷新位（避免两段运动叠在一起）。
      clearTimer(holdDelayRef)
      holdDelayRef.current = setTimeout(() => {
        holdDelayRef.current = null
        // 手指正按着列表时不要做位移动画（拖动中改 transform 会抖）。
        if (!displayRef.current || dragStartRef.current != null) return
        hold.stopAnimation()
        Animated.timing(hold, {
          toValue: 1,
          duration: HOLD_IN_MS,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }).start()
      }, HOLD_IN_DELAY_MS)
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
  }, [refreshing, progress, hideIndicator, hold])

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
    clearTimer(holdDelayRef)
    clearTimer(watchdogRef)
  }, [])

  const handleScrollBeginDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // 刷新中用户又按住列表：不动位移，避免抓取瞬间画面跳。
    if (!displayRef.current) {
      hold.stopAnimation()
      hold.setValue(0)
      progress.stopAnimation()
    }
    dragStartRef.current = e.nativeEvent.contentOffset.y
    pullRef.current = 0
    lastPullRef.current = 0
  }, [hold, progress])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (displayRef.current) {
      if (lastPullRef.current !== PULL_TRIGGER) {
        lastPullRef.current = PULL_TRIGGER
        progress.setValue(1)
      }
      return
    }
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
    // 轻拉松手：列表交给系统回弹（自然、不会抖），圆圈按减速曲线淡出。
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, hideIndicator])

  const handleMomentumScrollEnd = useCallback(() => {
    if (displayRef.current) return
    pullRef.current = 0
    lastPullRef.current = 0
    progress.stopAnimation()
    progress.setValue(0)
  }, [progress])

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
