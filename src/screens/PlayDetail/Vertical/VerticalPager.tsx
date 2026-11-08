import { Children, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  PanResponder,
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
  /** 从屏幕左边缘向右滑返回上一页（替代被横向 ScrollView 吃掉的 RNN 边缘返回手势）。 */
  onSwipeBack?: () => void
  style?: StyleProp<ViewStyle>
  children?: React.ReactNode
}

// 程序化滚动的落页兜底：iOS 的 scrollTo(animated:true) 不保证触发 onMomentumScrollEnd。
const PROGRAMMATIC_SETTLE_MS = 360
const MAX_INDEX = 1

const VerticalPager = forwardRef<VerticalPagerHandle, Props>((props, ref) => {
  const { initialPage = 0, scrollEnabled = true } = props
  const swipeBackRef = useRef(props.onSwipeBack)
  swipeBackRef.current = props.onSwipeBack
  // 【第 246 轮】横向 ScrollView 会吃掉 RNN 的左边缘右滑返回手势；在根 View 的 capture
  // 阶段抢回「从左边缘开始、水平向右」的手势，松手距离够就 pop。
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (event, gesture) => {
      if (gesture.x0 > 24) return false
      if (gesture.dx <= 8) return false
      return Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2
    },
    onPanResponderRelease: (event, gesture) => {
      if (gesture.dx > 60) swipeBackRef.current?.()
    },
  }), [])
  const scrollRef = useRef<ScrollView>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const widthRef = useRef(0)
  const currentIndexRef = useRef(Math.max(0, Math.min(MAX_INDEX, initialPage)))
  const scrollingRef = useRef(false)
  const programmaticRef = useRef(false)
  const lastOffsetRef = useRef(0)
  const dragStartXRef = useRef(0)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  const scrollToIndex = useCallback((index: number, animated: boolean) => {
    const width = widthRef.current
    if (width <= 0) return
    const next = Math.max(0, Math.min(MAX_INDEX, index))
    scrollingRef.current = true
    programmaticRef.current = true
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
  }, [clearSettleTimer, emitState, settle])

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
    programmaticRef.current = false
    dragStartXRef.current = lastOffsetRef.current
    scrollingRef.current = true
    emitState('dragging')
  }, [clearSettleTimer, emitState])

  // 【第 245 轮】一松手立刻吸附，动画与点击切页完全相同（PROGRAMMATIC_SETTLE_MS）：
  // 按「这次拖动的方向」决定目标页（位移 > 8pt 就认方向），避免半路停留，也避免
  // 轻扫一点因为没过半而滑不过去。
  const handleScrollEndDrag = useCallback(() => {
    const width = widthRef.current
    if (width <= 0) return
    const delta = lastOffsetRef.current - dragStartXRef.current
    const offset = lastOffsetRef.current / width
    let target: number
    if (delta > 8) target = 1
    else if (delta < -8) target = 0
    else target = offset >= 0.5 ? 1 : 0
    scrollToIndex(target, true)
  }, [scrollToIndex])

  // 手势被系统取消等极端路径的兜底：没有程序化动画在跑时，按当前偏移落页。
  const handleMomentumScrollEnd = useCallback(() => {
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
    <View style={props.style} collapsable={false} onLayout={handleLayout} {...panResponder.panHandlers}>
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
