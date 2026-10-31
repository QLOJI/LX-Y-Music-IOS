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
 * holdSpace（歌单详情歌曲列表 / 每日推荐 / WebDAV / 关注歌手 / 专辑等）：
 *   · 拖动阶段只跟手显示圆圈，不动 inset；
 *   · 松手未达阈值：若拖动中途抬过 inset，撤掉并主动动画回「拖动起点」（静止位）；
 *   · 松手达阈值：把 inset 抬到 32，让停留位（静止位 - 32pt）成为合法位置，
 *     再用系统滚动动画滚到该位置 —— 停留位固定、不依赖系统弹簧的目标；
 *   · 刷新结束：保持 inset，先动画回静止位，落定后再撤 inset（顺序反了会被原生打断）；
 *   · 圆圈按「静止位高度」定位（拖动起点 −y），正好落在新打开的 32pt 空白区中心。
 *
 * holdSpace=false（歌单主页 / 我的 / 播放历史 / 排行榜）：完全不干预，只用系统回弹。
 *
 * 下拉只在「从列表顶部开始的拖动」里计数：起点 > 0（列表中间）一律不算。
 */
export const PULL_TRIGGER = 32
/** 有停留位的页面：触发距离与空白高度（比纯回弹页面大一些）。 */
const HOLD_TRIGGER = 60
const HOLD_GAP = 44
export const REFRESH_MIN_MS = 900
const FALLBACK_MS = 700
const WATCHDOG_MS = 10000
const INSET_COMMIT_MS = 60
const RETURN_ANIM_MS = 340
const ICON_SIZE = 26
const ICON_RADIUS = 10
const ICON_STROKE = 2.4
const ICON_CIRCUMFERENCE = 2 * Math.PI * ICON_RADIUS

type ScrollListRef = { current: any }

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

const usePullRefresh = (
  refreshing: boolean,
  onRefresh: () => void,
  listRef?: ScrollListRef,
  topOffset = 0,
  /** true = 刷新时给列表留出 32pt 停留位；false = 只用系统回弹，不做任何干预。 */
  holdSpace = false,
) => {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current
  const pullOffset = useRef(new Animated.Value(0)).current
  const spin = useRef(new Animated.Value(0)).current
  const pullRef = useRef(0)
  const lastPullRef = useRef(-1)
  const lastStepRef = useRef(-1)
  const lastOffsetRef = useRef<number | null>(null)
  const dragStartRef = useRef<number | null>(null)
  // 本次拖动的静止位（列表顶部的当前偏移，可能是 0，也可能因安全区 inset 为负）。
  const dragTopRef = useRef(0)
  // 列表的「真实静止位」：只在挂载后/非拖动时学一次，之后永远用它当回位目标。
  // 不能每次用拖动起点——一次没回成功，下一次的起点就更低，空白会越拉越大。
  const restTopRef = useRef<number | null>(null)
  const holdAppliedRef = useRef(false)
  // 圆圈在容器内的纵向位置：等于静止位到容器顶的距离（无安全区 inset 时为 0）。
  const [indicatorTop, setIndicatorTop] = useState(0)
  const indicatorTopRef = useRef(0)
  const refreshingRef = useRef(refreshing)
  const displayRef = useRef(refreshing)
  const sawRefreshingRef = useRef(false)
  const [displayRefreshing, setDisplayRefreshing] = useState(refreshing)
  const [insetTop, setInsetTop] = useState(0)
  const insetRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const startedAtRef = useRef(refreshing ? Date.now() : 0)
  const minTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  refreshingRef.current = refreshing

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }

  const applyInset = useCallback((on: boolean) => {
    if (!holdSpace || insetRef.current === on) return
    insetRef.current = on
    setInsetTop(on ? HOLD_GAP : 0)
  }, [holdSpace])

  const hideIndicator = useCallback(() => {
    const dragging = dragStartRef.current != null
    displayRef.current = false
    dragStartRef.current = null
    pullRef.current = 0
    lastPullRef.current = 0
    lastStepRef.current = 0
    setDisplayRefreshing(false)
    clearTimer(scrollTimerRef)
    clearTimer(restoreTimerRef)
    if (holdSpace && holdAppliedRef.current) {
      holdAppliedRef.current = false
      // 回位目标永远是「学到的真实静止位」，不是本次拖动起点——一次没回成功也不会累积偏移。
      const top = restTopRef.current ?? dragTopRef.current
      if (dragging) {
        applyInset(false)
        listRef?.current?.scrollToOffset?.({ offset: top, animated: false })
      } else {
        // 保持 inset 先动画回静止位（target 合法），落定后再撤 inset；再留一次兜底。
        listRef?.current?.scrollToOffset?.({ offset: top, animated: true })
        restoreTimerRef.current = setTimeout(() => {
          restoreTimerRef.current = null
          applyInset(false)
          restoreTimerRef.current = setTimeout(() => {
            restoreTimerRef.current = null
            if (displayRef.current || dragStartRef.current != null) return
            listRef?.current?.scrollToOffset?.({ offset: top, animated: false })
          }, 220)
        }, RETURN_ANIM_MS)
      }
    } else if (insetRef.current) {
      // 兜底：没有记录到 hold 但 inset 还开着，也要撤掉。
      applyInset(false)
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, holdSpace, applyInset, listRef])

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
        duration: 280,
        easing: Easing.inOut(Easing.quad),
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
  }, [refreshing, progress, hideIndicator])

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
    clearTimer(scrollTimerRef)
    clearTimer(restoreTimerRef)
  }, [])

  // 学「真实静止位」：只在第一次见到非拖动、非刷新、顶部区域（y ≤ 0）的偏移时记下，
  // 之后所有回位都用它，避免一次没回到位导致起点越来越低、空白越拉越大。
  const learnRestTop = useCallback((y: number) => {
    if (restTopRef.current != null || y > 0 || dragStartRef.current != null || displayRef.current) return
    restTopRef.current = y
    if (holdSpace) {
      const nextTop = -y
      if (indicatorTopRef.current !== nextTop) {
        indicatorTopRef.current = nextTop
        setIndicatorTop(nextTop)
      }
    }
  }, [holdSpace])

  const handleScrollBeginDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    clearTimer(scrollTimerRef)
    clearTimer(restoreTimerRef)
    if (!displayRef.current && insetRef.current) applyInset(false)
    const y = e.nativeEvent.contentOffset.y
    // 先学静止位（此刻 dragStart 还是 null），再登记本次拖动起点。
    learnRestTop(y)
    dragStartRef.current = y
    dragTopRef.current = y
    // 只有「有停留位」的页面才把圆圈按静止位高度定位（落在新打开的空白区中心）；
    // 歌单主页 / 我的 / 播放历史 / 排行榜保持圆圈位置固定，不随拖动移动。
    if (holdSpace && restTopRef.current != null) {
      const nextTop = -restTopRef.current
      if (indicatorTopRef.current !== nextTop) {
        indicatorTopRef.current = nextTop
        setIndicatorTop(nextTop)
      }
    }
    lastOffsetRef.current = y
    pullRef.current = 0
    lastPullRef.current = 0
    lastStepRef.current = 0
  }, [applyInset, holdSpace, learnRestTop])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = y
    if (displayRef.current) {
      if (lastPullRef.current !== PULL_TRIGGER) {
        lastPullRef.current = PULL_TRIGGER
        lastStepRef.current = 1
        progress.setValue(1)
      }
      return
    }
    const start = dragStartRef.current
    if (start == null) {
      learnRestTop(y)
      if (lastPullRef.current !== 0) {
        lastPullRef.current = 0
        pullRef.current = 0
        lastStepRef.current = 0
        progress.stopAnimation()
        progress.setValue(0)
      }
      return
    }
    const pull = start <= 0 ? Math.max(0, start - y) : 0
    pullRef.current = pull
    // 进度按 1/32 量化，慢拉时不必每帧过桥同步（触发距离按页面口径）。
    const step = Math.min(1, Math.round((pull / (holdSpace ? HOLD_TRIGGER : PULL_TRIGGER)) * 32) / 32)
    if (step === lastStepRef.current) return
    lastStepRef.current = step
    lastPullRef.current = pull
    progress.stopAnimation()
    progress.setValue(step)
  }, [progress, holdSpace, learnRestTop])

  const handleScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const start = dragStartRef.current
    dragStartRef.current = null
    if (displayRef.current) return
    const y = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = y
    const pull = start == null ? pullRef.current : (start <= 0 ? Math.max(0, start - y) : 0)
    const trigger = holdSpace ? HOLD_TRIGGER : PULL_TRIGGER
    pullRef.current = pull
    if (start != null && start <= 0 && pull >= trigger) {
      dragTopRef.current = start
      const restTop = restTopRef.current ?? start
      // 抬 inset → 停留位（静止位 - HOLD_GAP）成为合法位置 → 等原生提交后用系统滚动动画滚过去。
      // 目标固定用「真实静止位」，不随本次拖动起点漂移。
      holdAppliedRef.current = true
      applyInset(true)
      displayRef.current = true
      setDisplayRefreshing(true)
      progress.stopAnimation()
      progress.setValue(1)
      lastStepRef.current = 1
      onRefreshRef.current()
      clearTimer(scrollTimerRef)
      scrollTimerRef.current = setTimeout(() => {
        scrollTimerRef.current = null
        if (!displayRef.current) return
        listRef?.current?.scrollToOffset?.({ offset: restTop - HOLD_GAP, animated: true })
      }, INSET_COMMIT_MS)
      sawRefreshingRef.current = false
      clearTimer(fallbackTimerRef)
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null
        if (!sawRefreshingRef.current && !refreshingRef.current) hideIndicator()
      }, FALLBACK_MS)
      return
    }
    // 轻拉松手（未达触发位）：撤掉可能存在的 inset，然后交给系统自然回弹。
    // 不再叠加程序化滚动——两段动画同时跑就是「上下抖动」的来源。
    if (start != null && start <= 0) {
      dragTopRef.current = start
      if (insetRef.current) applyInset(false)
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, applyInset, listRef, holdSpace])

  const handleMomentumScrollEnd = useCallback(() => {
    if (displayRef.current) return
    pullRef.current = 0
    lastPullRef.current = 0
    lastStepRef.current = 0
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
  // 纯回弹页面保持原来的 32pt 圆圈几何；有停留位的页面才用更大的空白高度。
  const ringGap = holdSpace ? HOLD_GAP : PULL_TRIGGER

  const indicator = (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.indicator,
        {
          top: topOffset + indicatorTop,
          height: ringGap,
          opacity: progress,
          transform: [{
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [-ringGap, 0],
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
      // 只有真正需要停留位时才带 contentInset；恒传 undefined 会让部分页面
      // 丢掉了 iOS 安全区自动 inset（标题整体上移，和推荐页错位）。
      ...(insetTop > 0 ? { contentInset: { top: insetTop } } : {}),
    },
  }
}

const styles = StyleSheet.create({
  indicator: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: HOLD_GAP,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
})

export default usePullRefresh
