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
 *   · 下拉距离达到 PULL_TRIGGER 才触发；松手后列表固定在 PULL_TRIGGER 的刷新位；
 *   · 不足 PULL_TRIGGER 的轻拉：不回弹刷新，指示器在回弹后复位为 0（带兜底定时器）；
 *   · 刷新结束固定 scrollToOffset(0) 并撤掉 inset —— 轻拉/重拉、刷新多少次，
 *     最后都回到同一个原始顶部，不会出现两种落点；
 *   · 指标至少展示 REFRESH_MIN_MS；另设看门狗，父级 refreshing 卡住时也会收起，
 *     不留下永远停在顶部的图标。
 */
export const PULL_TRIGGER = 32
export const REFRESH_MIN_MS = 900
const UNHOLD_DELAY_MS = 240
const WATCHDOG_MS = 10000
const RELEASE_SETTLE_MS = 300
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
  const refreshingRef = useRef(refreshing)
  const displayRef = useRef(refreshing)
  const heldRef = useRef(false)
  // 刷新收尾/回顶期间禁止用滚动偏移反推下拉进度（否则会把正在淡出的图标重新点亮）。
  const suppressPullUntilRef = useRef(0)
  const [held, setHeld] = useState(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const [displayRefreshing, setDisplayRefreshing] = useState(refreshing)
  const startedAtRef = useRef(refreshing ? Date.now() : 0)
  const minTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unholdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }

  const releaseHold = useCallback(() => {
    if (!heldRef.current) return
    // 固定回到 0：所有列表的顶部基准一致，不再使用「可变原顶部偏移」。
    // heldRef 先保持为 true，直到回顶动画结束再撤掉，期间 handleScroll 不再改进度。
    suppressPullUntilRef.current = Date.now() + 650
    listRef?.current?.scrollToOffset?.({ offset: 0, animated: true })
    clearTimer(unholdTimerRef)
    unholdTimerRef.current = setTimeout(() => {
      unholdTimerRef.current = null
      heldRef.current = false
      setHeld(false)
    }, UNHOLD_DELAY_MS)
  }, [listRef])

  const hideIndicator = useCallback(() => {
    displayRef.current = false
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
    refreshingRef.current = refreshing
    if (refreshing) {
      clearTimer(settleTimerRef)
      startedAtRef.current = Date.now()
      displayRef.current = true
      setDisplayRefreshing(true)
      // 程序触发的自动刷新也托住列表，形成下拉动作；手动触发时已经托住。
      heldRef.current = true
      setHeld(true)
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
    if (!displayRef.current) return
    clearTimer(watchdogRef)

    const finish = () => {
      hideIndicator()
    }
    const remain = REFRESH_MIN_MS - (Date.now() - startedAtRef.current)
    if (remain <= 0) {
      finish()
      return
    }
    clearTimer(minTimerRef)
    minTimerRef.current = setTimeout(() => {
      minTimerRef.current = null
      finish()
    }, remain)
    return () => { clearTimer(minTimerRef) }
  }, [refreshing, progress, releaseHold, hideIndicator])

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
    clearTimer(unholdTimerRef)
    clearTimer(watchdogRef)
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
    // 刷新收尾 / 回顶动画期间：不要让偏移把正在收起的图标重新点亮。
    if (heldRef.current || Date.now() < suppressPullUntilRef.current) return
    const y = e.nativeEvent.contentOffset.y
    const pull = Math.max(0, -y)
    pullRef.current = pull
    if (pull === lastPullRef.current) return
    lastPullRef.current = pull
    progress.stopAnimation()
    progress.setValue(Math.min(1, pull / PULL_TRIGGER))
  }, [progress])

  const handleScrollEndDrag = useCallback(() => {
    if (displayRef.current || heldRef.current || Date.now() < suppressPullUntilRef.current) return
    if (pullRef.current >= PULL_TRIGGER) {
      heldRef.current = true
      setHeld(true)
      onRefreshRef.current()
      // 父级没有进入 refreshing（onRefresh 是空实现 / 被丢弃）时，
      // 撤销托住并回顶，绝不留下一直停在顶部的图标。
      clearTimer(settleTimerRef)
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null
        if (displayRef.current) return
        heldRef.current = false
        setHeld(false)
        suppressPullUntilRef.current = Date.now() + 650
        progress.stopAnimation()
        progress.setValue(0)
        listRef?.current?.scrollToOffset?.({ offset: 0, animated: true })
      }, 500)
      return
    }
    // 轻拉：指示器回到 0。列表回弹可能不再发 onScroll，加一个兜底复位，
    // 避免「图标停在顶部」。
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
    }, RELEASE_SETTLE_MS)
  }, [progress, listRef])

  const handleMomentumScrollEnd = useCallback(() => {
    if (displayRef.current || heldRef.current || Date.now() < suppressPullUntilRef.current) return
    if (pullRef.current >= PULL_TRIGGER) return
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
      onScrollEndDrag: handleScrollEndDrag,
      onMomentumScrollEnd: handleMomentumScrollEnd,
      scrollEventThrottle: 16,
      bounces: true,
      // 不刷新时完全不传 contentInset，保持列表原先的顶部布局；
      // 刷新时叠加 PULL_TRIGGER，把列表托在统一的刷新位。
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
