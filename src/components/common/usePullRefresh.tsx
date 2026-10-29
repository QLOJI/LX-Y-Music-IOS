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
 * 自绘下拉刷新（不依赖系统 UIRefreshControl）：
 *   · 下拉时圆环从圆点逐渐画满，松手即刷新；刷新中圆环旋转；
 *   · 触发距离 PULL_TRIGGER，刷新时把列表托在刷新位，不额外向下推；
 *   · 刷新结束平滑回到「下拉前的原顶部位置」（不是强制 scrollTo 0），
 *     因此「歌单 / 我的」这类带页头列表不会在刷新后把标题顶上去；
 *   · 指示器至少展示 REFRESH_MIN_MS，各列表节奏统一。
 *
 * 用法：
 *   const { indicator, scrollProps } = usePullRefresh(refreshing, onRefresh, flatListRef)
 *   把 indicator 放在列表容器顶层（容器加 overflow:'hidden'），scrollProps 展开到 FlatList。
 */
export const PULL_TRIGGER = 40
export const REFRESH_MIN_MS = 900
const UNHOLD_DELAY_MS = 240
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
  const lastPullRef = useRef(0)
  // 下拉前的原顶部偏移（可能是 0，也可能是自动安全区 inset 的负值）。
  // 刷新结束回到这里，而不是无条件 scrollToOffset(0)。
  const restOffsetRef = useRef<number | null>(null)
  const refreshingRef = useRef(refreshing)
  const armedRef = useRef(false)
  const heldRef = useRef(false)
  const [held, setHeld] = useState(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const [displayRefreshing, setDisplayRefreshing] = useState(refreshing)
  const displayRef = useRef(refreshing)
  const startedAtRef = useRef(refreshing ? Date.now() : 0)
  const minTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unholdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const releaseHold = useCallback(() => {
    if (!heldRef.current) return
    heldRef.current = false
    // 回到「下拉前的原顶部位置」：带安全区 inset 的列表不是 0。
    listRef?.current?.scrollToOffset?.({
      offset: restOffsetRef.current ?? 0,
      animated: true,
    })
    if (unholdTimerRef.current) clearTimeout(unholdTimerRef.current)
    unholdTimerRef.current = setTimeout(() => {
      unholdTimerRef.current = null
      setHeld(false)
    }, UNHOLD_DELAY_MS)
  }, [listRef])

  useEffect(() => {
    refreshingRef.current = refreshing
    if (refreshing) {
      armedRef.current = true
      // 程序触发的自动刷新也把列表托到刷新位，显示成一次下拉动作，
      // 指示器出现在列表上方而不是盖住第一行。
      heldRef.current = true
      setHeld(true)
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
      return
    }
    if (!displayRef.current) return

    const finish = () => {
      displayRef.current = false
      armedRef.current = false
      setDisplayRefreshing(false)
      releaseHold()
      progress.stopAnimation()
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start()
    }
    const remain = REFRESH_MIN_MS - (Date.now() - startedAtRef.current)
    if (remain <= 0) {
      finish()
      return
    }
    if (minTimerRef.current) clearTimeout(minTimerRef.current)
    minTimerRef.current = setTimeout(() => {
      minTimerRef.current = null
      finish()
    }, remain)
    return () => {
      if (minTimerRef.current) {
        clearTimeout(minTimerRef.current)
        minTimerRef.current = null
      }
    }
  }, [refreshing, progress, releaseHold])

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
    if (minTimerRef.current) clearTimeout(minTimerRef.current)
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
    if (unholdTimerRef.current) clearTimeout(unholdTimerRef.current)
  }, [])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (refreshingRef.current || armedRef.current) return
    const y = e.nativeEvent.contentOffset.y
    // 记录静止时的顶部偏移：列表中带自动安全区 inset 时它是负值。
    // 取观察到的、最接近 0 的非正 offset 作为基底。
    if (y <= 0) {
      if (restOffsetRef.current == null || y > restOffsetRef.current) restOffsetRef.current = y
    }
    const base = restOffsetRef.current ?? 0
    const pull = Math.max(0, base - y)
    if (pull === lastPullRef.current) return
    lastPullRef.current = pull
    pullRef.current = pull
    progress.stopAnimation()
    progress.setValue(Math.min(1, pull / PULL_TRIGGER))
  }, [progress])

  const handleScrollBeginDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (refreshingRef.current) return
    // 手指按下开始拖动的这一刻就是「原顶部位置」：带安全区 inset 的页面是负值。
    const y = e.nativeEvent.contentOffset.y
    if (y <= 0) restOffsetRef.current = y
  }, [])

  const handleScrollEndDrag = useCallback(() => {
    if (refreshingRef.current) return
    const triggered = pullRef.current >= PULL_TRIGGER
    if (triggered) {
      armedRef.current = true
      heldRef.current = true
      // 托住列表：inset 只到刷新位，不再往下推。
      setHeld(true)
      onRefreshRef.current()
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null
        if (refreshingRef.current) return
        armedRef.current = false
        heldRef.current = false
        setHeld(false)
        Animated.timing(progress, {
          toValue: 0,
          duration: 150,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false,
        }).start()
      }, 200)
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start()
    }
    pullRef.current = 0
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
      scrollEventThrottle: 16,
      bounces: true,
      // 保留系统自动安全区 inset（关掉会把「歌单 / 我的」页头整体推上去）；
      // 只在刷新时叠加一个 PULL_TRIGGER 的顶部 inset 做下拉动作。
      contentInset: { top: held ? PULL_TRIGGER : 0 },
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
