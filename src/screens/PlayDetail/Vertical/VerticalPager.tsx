import { Children, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native'

/**
 * 【第 241 轮】详情页两页横滑：用横向 ScrollView + pagingEnabled 替换
 * react-native-pager-view。理由：库的 goTo/animating/disableSwipe 闩锁会让程序化
 * setPage 静默失败并锁死子树；ScrollView 的 scrollTo 是原生滚动，不存在这些闩锁，
 * 点击切页与手动左右滑永远走同一条路径。
 *
 * 对外接口刻意模仿 PagerView（setPage / setPageWithoutAnimation / setScrollEnabled /
 * isScrolling + onPageSelected / onPageScroll / onPageScrollStateChanged），
 * VerticalNew 的恢复链与点击逻辑可以原样保留。
 */
export interface VerticalPagerHandle {
  setPage: (index: number, animated?: boolean) => void
  setPageWithoutAnimation: (index: number) => void
  setScrollEnabled: (enabled: boolean) => void
  isScrolling: boolean
}

interface PageEvent {
  nativeEvent: { position: number }
}
interface ScrollEvent {
  nativeEvent: { position: number, offset: number }
}
interface PageStateEvent {
  nativeEvent: { pageScrollState: 'idle' | 'dragging' | 'settling' }
}

interface Props {
  initialPage?: number
  scrollEnabled?: boolean
  onPageSelected?: (event: PageEvent) => void
  onPageScroll?: (event: ScrollEvent) => void
  onPageScrollStateChanged?: (event: PageStateEvent) => void
  onLayout?: (event: LayoutChangeEvent) => void
  style?: StyleProp<ViewStyle>
  children?: React.ReactNode
}

// 程序化滚动的落页兜底：iOS 的 scrollTo(animated:true) 不保证触发 onMomentumScrollEnd。
const PROGRAMMATIC_SETTLE_MS = 360
// 零速度松手不会产生 momentum：等这么久仍没有 momentum 就按当前偏移吸附。
const NO_MOMENTUM_SNAP_MS = 180
const MAX_INDEX = 1

const VerticalPager = forwardRef<VerticalPagerHandle, Props>((props, ref) => {
  const { initialPage = 0, scrollEnabled = true } = props
  const scrollRef = useRef<ScrollView>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const widthRef = useRef(0)
  const currentIndexRef = useRef(Math.max(0, Math.min(MAX_INDEX, initialPage)))
  const scrollingRef = useRef(false)
  const programmaticRef = useRef(false)
  const momentumRef = useRef(false)
  const lastOffsetRef = useRef(0)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [enabled, setEnabled] = useState(true)
  const initialPlacedRef = useRef(false)

  const emitState = useCallback((pageScrollState: 'idle' | 'dragging' | 'settling') => {
    props.onPageScrollStateChanged?.({ nativeEvent: { pageScrollState } })
  }, [props.onPageScrollStateChanged])

  const settle = useCallback((index: number) => {
    const next = Math.max(0, Math.min(MAX_INDEX, index))
    if (next === currentIndexRef.current) return
    currentIndexRef.current = next
    props.onPageSelected?.({ nativeEvent: { position: next } })
  }, [props.onPageSelected])

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [])
  const clearDragTimer = useCallback(() => {
    if (dragTimerRef.current) {
      clearTimeout(dragTimerRef.current)
      dragTimerRef.current = null
    }
  }, [])

  const scrollToIndex = useCallback((index: number, animated: boolean) => {
    const width = widthRef.current
    if (width <= 0) return
    const next = Math.max(0, Math.min(MAX_INDEX, index))
    scrollingRef.current = true
    programmaticRef.current = true
    clearDragTimer()
    clearSettleTimer()
    emitState('settling')
    scrollRef.current?.scrollTo({ x: next * width, animated })
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null
      settle(next)
      lastOffsetRef.current = next * width
      scrollingRef.current = false
      programmaticRef.current = false
      emitState('idle')
    }, animated ? PROGRAMMATIC_SETTLE_MS : 0)
  }, [clearDragTimer, clearSettleTimer, emitState, settle])

  // 惯性结束后按最终偏移吸附到最近页（只做最后那一点点，速度已经交给系统惯性）。
  const snapToNearest = useCallback(() => {
    const width = widthRef.current
    if (width <= 0) return
    const offset = lastOffsetRef.current
    const index = Math.max(0, Math.min(MAX_INDEX, Math.round(offset / width)))
    const target = index * width
    if (Math.abs(offset - target) > 0.5) {
      scrollRef.current?.scrollTo({ x: target, animated: true })
    }
    lastOffsetRef.current = target
    settle(index)
    scrollingRef.current = false
    programmaticRef.current = false
    emitState('idle')
  }, [emitState, settle])

  useImperativeHandle(ref, () => ({
    setPage: (index: number, animated = true) => { scrollToIndex(index, animated) },
    setPageWithoutAnimation: (index: number) => { scrollToIndex(index, false) },
    setScrollEnabled: (value: boolean) => { setEnabled(value) },
    get isScrolling() { return scrollingRef.current },
    set isScrolling(value: boolean) { scrollingRef.current = value },
  }), [scrollToIndex])

  // 尺寸就绪 / 变化：无动画回到当前页（首帧不闪第 0 页）。
  useEffect(() => {
    if (size.width <= 0) return
    if (!initialPlacedRef.current) {
      initialPlacedRef.current = true
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ x: currentIndexRef.current * size.width, animated: false })
        lastOffsetRef.current = currentIndexRef.current * size.width
      })
      return
    }
    scrollRef.current?.scrollTo({ x: currentIndexRef.current * size.width, animated: false })
    lastOffsetRef.current = currentIndexRef.current * size.width
  }, [size.width, size.height])

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width)
    const height = Math.round(event.nativeEvent.layout.height)
    if (width > 0) widthRef.current = width
    setSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }))
    props.onLayout?.(event)
  }, [props.onLayout])

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const width = widthRef.current
    if (width <= 0) return
    const x = event.nativeEvent.contentOffset.x
    lastOffsetRef.current = x
    const progress = x / width
    const position = Math.max(0, Math.min(MAX_INDEX, Math.floor(progress)))
    props.onPageScroll?.({ nativeEvent: { position, offset: progress - position } })
  }, [props.onPageScroll])

  const handleScrollBeginDrag = useCallback(() => {
    clearSettleTimer()
    clearDragTimer()
    programmaticRef.current = false
    momentumRef.current = false
    scrollingRef.current = true
    emitState('dragging')
  }, [clearDragTimer, clearSettleTimer, emitState])

  // 【第 244 轮】松手不再接管：让系统按用户原来的速度继续惯性滚动（不再用固定动画把速度
  // 重置，用户报「阻力太大 / 滑不过去」）。只有零速度松手不会产生 momentum，才在 180ms
  // 后按当前偏移吸附；惯性结束后的最后一点吸附由 onMomentumScrollEnd 做。
  const handleScrollEndDrag = useCallback(() => {
    emitState('settling')
    clearDragTimer()
    dragTimerRef.current = setTimeout(() => {
      dragTimerRef.current = null
      if (momentumRef.current) return
      snapToNearest()
    }, NO_MOMENTUM_SNAP_MS)
  }, [clearDragTimer, emitState, snapToNearest])

  const handleMomentumScrollBegin = useCallback(() => {
    clearDragTimer()
    momentumRef.current = true
    scrollingRef.current = true
    emitState('settling')
  }, [clearDragTimer, emitState])

  const handleMomentumScrollEnd = useCallback(() => {
    momentumRef.current = false
    if (programmaticRef.current) return
    snapToNearest()
  }, [snapToNearest])

  const pages = Children.toArray(props.children)
  // 只在尺寸变化时重建样式对象：每次父渲染都传新对象会让原生反复重排内容。
  const contentStyle = useMemo(
    () => ({ width: size.width * (MAX_INDEX + 1), height: size.height }),
    [size.width, size.height],
  )
  const pageStyles = useMemo(
    () => [0, 1].map(() => ({ width: size.width, height: size.height })),
    [size.width, size.height],
  )

  return (
    <View style={props.style} collapsable={false} onLayout={handleLayout}>
      {size.width > 0 && size.height > 0 ? (
        <ScrollView
          ref={scrollRef}
          horizontal
          bounces={false}
          alwaysBounceHorizontal={false}
          showsHorizontalScrollIndicator={false}
          scrollEnabled={scrollEnabled && enabled}
          scrollEventThrottle={16}
          onScroll={handleScroll}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          onMomentumScrollBegin={handleMomentumScrollBegin}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          style={{ flex: 1 }}
          contentContainerStyle={contentStyle}
          // 不传 contentOffset：它每次 prop diff 都会把原生滚动位置写回旧值，
          // 滑动中会表现为「被拉回 / 左右抖」。初始页由尺寸就绪后的 scrollTo 定位。
        >
          {[0, 1].map(index => (
            <View key={index} style={pageStyles[index]}>
              {pages[index] ?? null}
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  )
})

VerticalPager.displayName = 'VerticalPager'

export default VerticalPager
