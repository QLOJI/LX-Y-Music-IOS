import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useTheme } from '@/store/theme/hook'

/**
 * 自绘下拉刷新（不依赖系统 UIRefreshControl）：
 *   · 不修改列表 contentInset：触发刷新 / 刷新结束都不会把内容整体顶下去再弹回来；
 *   · 触发距离固定为 PULL_TRIGGER（40pt，指示器完全显示），松手即刷新；
 *   · 指示器是列表顶部的绝对定位覆盖层，不占布局，刷新后顶部距离与刷新前一致；
 *   · 刷新指示器最少停留 REFRESH_MIN_MS，各页面节奏一致。
 *
 * 用法：把 indicator 放在列表容器的顶层（绝对定位），scrollProps 展开到 FlatList；
 * refreshing 传父级刷新态，onRefresh 传父级刷新入口。
 */
export const PULL_TRIGGER = 40
export const REFRESH_MIN_MS = 600

const usePullRefresh = (refreshing: boolean, onRefresh: () => void) => {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current
  const pullRef = useRef(0)
  const lastPullRef = useRef(0)
  const refreshingRef = useRef(refreshing)
  const armedRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const [displayRefreshing, setDisplayRefreshing] = useState(refreshing)
  const displayRef = useRef(refreshing)
  const startedAtRef = useRef(refreshing ? Date.now() : 0)
  const minTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    refreshingRef.current = refreshing
    if (refreshing) {
      armedRef.current = true
      startedAtRef.current = Date.now()
      displayRef.current = true
      setDisplayRefreshing(true)
      progress.stopAnimation()
      Animated.timing(progress, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start()
      return
    }
    if (!displayRef.current) return

    const finish = () => {
      displayRef.current = false
      armedRef.current = false
      setDisplayRefreshing(false)
      progress.stopAnimation()
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
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
  }, [refreshing, progress])

  useEffect(() => () => {
    if (minTimerRef.current) clearTimeout(minTimerRef.current)
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
  }, [])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // 刷新中 / 已松手触发刷新：不要让回弹过程把指示器收回去。
    if (refreshingRef.current || armedRef.current) return
    const y = e.nativeEvent.contentOffset.y
    const pull = Math.max(0, -y)
    if (pull === lastPullRef.current) return
    lastPullRef.current = pull
    pullRef.current = pull
    progress.stopAnimation()
    progress.setValue(Math.min(1, pull / PULL_TRIGGER))
  }, [progress])

  const handleScrollEndDrag = useCallback(() => {
    if (refreshingRef.current) return
    const triggered = pullRef.current >= PULL_TRIGGER
    if (triggered) {
      armedRef.current = true
      onRefreshRef.current()
      // 父级 onRefresh 可能是空实现（例如只读列表）：200ms 后仍未进入刷新就收回指示器。
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null
        if (refreshingRef.current) return
        armedRef.current = false
        Animated.timing(progress, {
          toValue: 0,
          duration: 150,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start()
      }, 200)
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start()
    }
    pullRef.current = 0
  }, [progress])

  const indicator = (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.indicator,
        {
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
      <ActivityIndicator color={theme['c-primary']} animating={displayRefreshing} />
    </Animated.View>
  )

  return {
    indicator,
    scrollProps: {
      onScroll: handleScroll,
      onScrollEndDrag: handleScrollEndDrag,
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
