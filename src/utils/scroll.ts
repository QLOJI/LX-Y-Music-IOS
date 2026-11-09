import { type NativeScrollEvent, type FlatList, type NativeSyntheticEvent } from 'react-native'

const easeInOutQuad = (t: number, b: number, c: number, d: number): number => {
  t /= d / 2
  if (t < 1) return (c / 2) * t * t + b
  t--
  return (-c / 2) * (t * (t - 2) - 1) + b
}

type Noop = () => void
const noop: Noop = () => {}

type ScrollElement<T> = {
  lx_scrollLockKey?: number
  lx_scrollNextParams?: [
    ScrollElement<FlatList<any>>,
    NativeSyntheticEvent<NativeScrollEvent>['nativeEvent'],
    number,
    number,
    Noop,
  ]
  lx_scrollTimeout?: NodeJS.Timeout
  lx_scrollDelayTimeout?: NodeJS.Timeout
} & T

const handleScrollY = (
  element: ScrollElement<FlatList<any>>,
  info: NativeSyntheticEvent<NativeScrollEvent>['nativeEvent'],
  to: number,
  duration = 300,
  fn = noop,
): Noop => {
  if (element == null) {
    fn()
    return noop
  }

  const clean = () => {
    element.lx_scrollLockKey = undefined
    element.lx_scrollNextParams = undefined
    if (element.lx_scrollTimeout) clearTimeout(element.lx_scrollTimeout)
    element.lx_scrollTimeout = undefined
  }
  if (element.lx_scrollLockKey) {
    element.lx_scrollNextParams = [element, info, to, duration, fn]
    element.lx_scrollLockKey = -1
    return clean
  }

  let start = info.contentOffset.y
  if (to > start) {
    let maxScrollTop = info.contentSize.height - info.layoutMeasurement.height
    if (to > maxScrollTop) to = maxScrollTop
  } else if (to < start) {
    if (to < 0) to = 0
  } else {
    fn()
    return noop
  }
  let change = to - start
  // 步进间隔对齐 REF 参考工程（REF src/utils/scroll.ts:50 increment = 10）：
  // 由 5ms 改为 10ms，定时器回调次数减半（每段动画少一半的 JS 线程唤醒与
  // scrollToOffset 桥调用），单步位移略大；easeInOutQuad 步进本身是逐点重算的
  // 离散采样，10ms 步长在 300~600ms 动画下仍是约 30~60 个采样点，观感连续。
  const increment = 10
  if (!change) {
    fn()
    return noop
  }

  let currentTime = 0
  let val: number
  let key = Math.random()

  const animateScroll = () => {
    element.lx_scrollTimeout = undefined
    currentTime += increment
    val = Math.trunc(easeInOutQuad(currentTime, start, change, duration))
    element.scrollToOffset({ offset: val, animated: false })
    if (currentTime < duration) {
      element.lx_scrollTimeout = setTimeout(animateScroll, increment)
    } else {
      if (element.lx_scrollNextParams) {
        const [_element, info, _to, duration, fn] = element.lx_scrollNextParams
        if (to > _to && info.contentOffset.y < val) info.contentOffset.y = val
        info.contentOffset.y = val
        clean()
        handleScrollY(_element, info, _to, duration, fn)
      } else {
        clean()
        fn()
      }
    }
  }

  element.lx_scrollLockKey = key
  animateScroll()

  return clean
}
/**
 * 设置滚动条位置
 * @param element 要设置滚动的容器 dom
 * @param to 滚动的目标位置
 * @param duration 滚动完成时间 ms
 * @param fn 滚动完成后的回调
 * @param delay 延迟执行时间
 */
/**
 * rAF 版定时长滚动：与 scrollTo 的边界/回调口径一致，区别是逐帧按**浮点**偏移写入，
 * 不跟 10ms 定时器错拍（120Hz 下尤其明显），用于歌词回位这类必须丝滑的路径。
 * 取消函数被调用时不触发完成回调。
 */
export const scrollToRaf = (
  element: ScrollElement<FlatList<any>> | null,
  info: NativeSyntheticEvent<NativeScrollEvent>['nativeEvent'],
  to: number,
  duration = 300,
  fn = noop,
  ease: (p: number) => number = (p: number) => p,
): Noop => {
  if (element == null) {
    fn()
    return noop
  }
  const start = info.contentOffset.y
  const maxScrollTop = info.contentSize.height - info.layoutMeasurement.height
  if (to > start) {
    if (to > maxScrollTop) to = Math.max(maxScrollTop, 0)
  } else if (to < start) {
    if (to < 0) to = 0
  }
  const change = to - start
  if (!change) {
    fn()
    return noop
  }

  const total = Math.max(duration, 1)
  let rafId = 0
  let startTs = 0
  let done = false
  const step = (ts: number) => {
    if (!startTs) startTs = ts
    const p = Math.min(1, (ts - startTs) / total)
    if (p >= 1) {
      rafId = 0
      done = true
      element.scrollToOffset({ offset: to, animated: false })
      fn()
      return
    }
    element.scrollToOffset({ offset: start + change * ease(p), animated: false })
    rafId = requestAnimationFrame(step)
  }
  rafId = requestAnimationFrame(step)

  return () => {
    if (done) return
    done = true
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
  }
}

export const scrollTo = (
  element: ScrollElement<FlatList<any>>,
  info: NativeSyntheticEvent<NativeScrollEvent>['nativeEvent'],
  to: number,
  duration = 300,
  fn = () => {},
  delay = 0,
): (() => void) => {
  let cancelFn: () => void
  if (element.lx_scrollDelayTimeout != null) {
    clearTimeout(element.lx_scrollDelayTimeout)
    element.lx_scrollDelayTimeout = undefined
  }
  if (delay) {
    let scrollCancelFn: Noop
    cancelFn = () => {
      if (element.lx_scrollDelayTimeout == null) {
        scrollCancelFn?.()
      } else {
        clearTimeout(element.lx_scrollDelayTimeout)
        element.lx_scrollDelayTimeout = undefined
      }
    }
    element.lx_scrollDelayTimeout = setTimeout(() => {
      element.lx_scrollDelayTimeout = undefined
      scrollCancelFn = handleScrollY(element, info, to, duration, fn)
    }, delay)
  } else {
    cancelFn = handleScrollY(element, info, to, duration, fn) ?? noop
  }
  return cancelFn
}
