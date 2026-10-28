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
 *   · 触发距离固定 30pt（比系统短一半），指示器完全显示后松手即刷新；
 *   · 松手时只把列表托在刷新位（contentInset.top=30），不再额外向下推；
 *   · 刷新结束后先平滑滚回 offset 0，再撤掉 inset —— 顶部距离与刷新前完全一致；
 *   · 指示器至少展示 600ms，所有列表节奏统一。
 *
 * 用法：
 *   const { indicator, scrollProps } = usePullRefresh(refreshing, onRefresh, flatListRef)
 *   把 indicator 放在列表容器顶层（容器加 overflow:'hidden'），scrollProps 展开到 FlatList。
 */
export const PULL_TRIGGER = 30
export const REFRESH_MIN_MS = 600
const UNHOLD_DELAY_MS = 240

type ScrollListRef = { current: any }

const usePullRefresh = (refreshing: boolean, onRefresh: () => void, listRef?: ScrollListRef, topOffset = 0) => {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current
  const pullRef = useRef(0)
  const lastPullRef = useRef(0)
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
    // 先把列表平滑滚回 0，让内容自己回到原位；稍后再撤 inset，
    // 避免 inset 变化瞬间把列表硬拽上去。
    listRef?.current?.scrollToOffset?.({ offset: 0, animated: true })
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
      releaseHold()
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
  }, [refreshing, progress, releaseHold])

  useEffect(() => () => {
    if (minTimerRef.current) clearTimeout(minTimerRef.current)
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
    if (unholdTimerRef.current) clearTimeout(unholdTimerRef.current)
  }, [])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
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
      // 禁用系统的自动安全区 inset，顶部距离完全由这里控制。
      contentInsetAdjustmentBehavior: 'never' as const,
      automaticallyAdjustContentInsets: false,
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
