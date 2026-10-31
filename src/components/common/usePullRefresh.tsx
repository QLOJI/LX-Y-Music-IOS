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
/** 有停留位的页面：触发距离与停留空白高度，两者必须一致（圆圈正好停在空白中心）。 */
const HOLD_GAP = 60
const HOLD_TRIGGER = HOLD_GAP
export const REFRESH_MIN_MS = 900
const FALLBACK_MS = 700
// holdAfterSettle 页面：父级不回报 refreshing（如歌手页），只能靠兜底收起。
// 停留位要等系统回弹落定后才展开（约 300ms）+ 240ms 渐入，兜底时间必须盖住这一段，
// 否则空白区只亮一下就被收掉。
const HOLD_SETTLE_FALLBACK_MS = 1500
// 等系统回弹落定的兜底：正常由 onScroll 发现已回到静止位就立即展开。
// 取 600ms（大于大距离下拉的回弹耗时）防止兜底先于回弹落定、两段位移又叠在一起。
const HOLD_SETTLE_MS = 600
const WATCHDOG_MS = 10000
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
  /**
   * 纯回弹页面的圆圈定位区：`top` 为容器顶（一般 = 状态栏高度），`height` 为标题上方
   * 的留白高度。提供时圆圈**下对齐**贴在该区域底部（即标题正上方）。
   */
  indicatorArea?: { top: number, height: number, inline?: boolean },
  /**
   * holdSpace 页面的「停留位延后展开」：松手后先让系统把下拉过冲回弹完，回到静止位后
   * 再单独把列表下移 HOLD_GAP。默认 false（松手即下移，与其它页面一致）。
   *
   * 为什么需要：松手时系统橡胶回弹向上收、transform 向下移，两段位移同时进行且速率不同，
   * 叠加后内容会先被顶到比松手位置更靠下、再被拽回 —— 就是「回弹时上下跳」。
   * 延后展开把两者拆成先后两段，任何时刻只有一段在动。
   */
  holdAfterSettle = false,
) => {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current
  // 刷新态的列表下移（0~1 系数，乘 HOLD_GAP）。只在手指松开后 / 刷新收尾时做一次性
  // 动画——拖动过程中恒为 0，绝不逐帧改 transform（那会和 pan 打架）。
  // 用 transform 而不是 contentInset / scrollToOffset：后两者会改动滚动状态，
  // 与手势竞争时表现为「上下滑动被锁住」。
  const holdAnim = useRef(new Animated.Value(0)).current
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
  // holdAfterSettle：松手达标后先挂起，等回到静止位（或超时兜底）再展开停留位。
  const pendingHoldRef = useRef(false)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  refreshingRef.current = refreshing

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }

  // 展开停留位（holdAfterSettle）：只在挂起时执行一次。此时系统回弹已落定，
  // 列表下移是唯一在动的位移 → 不会出现上下跳。
  const startHold = useCallback(() => {
    if (!pendingHoldRef.current) return
    pendingHoldRef.current = false
    clearTimer(holdTimerRef)
    if (!displayRef.current) return
    holdAppliedRef.current = true
    holdAnim.stopAnimation()
    Animated.timing(holdAnim, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
    // 圆圈随空白区一起展开：拖动阶段已淡出（避免压在还没让开的列表行上），
    // 这里按空白高重新淡入，正好落在空白中心。
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start()
  }, [progress, holdAnim])

  const hideIndicator = useCallback(() => {
    pendingHoldRef.current = false
    clearTimer(holdTimerRef)
    displayRef.current = false
    dragStartRef.current = null
    pullRef.current = 0
    lastPullRef.current = 0
    lastStepRef.current = 0
    setDisplayRefreshing(false)
    // 收尾：把刷新态的列表下移（transform）平滑归零。
    // 全程不改滚动偏移、不改 contentInset —— 列表一定回到原位，也不会锁住滑动。
    if (holdAppliedRef.current) {
      holdAppliedRef.current = false
      holdAnim.stopAnimation()
      Animated.timing(holdAnim, {
        toValue: 0,
        duration: 320,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start()
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, holdAnim])

  useEffect(() => {
    if (refreshing) {
      clearTimer(fallbackTimerRef)
      clearTimer(minTimerRef)
      sawRefreshingRef.current = true
      startedAtRef.current = Date.now()
      displayRef.current = true
      setDisplayRefreshing(true)
      // 延后展开的页面：此刻系统还在回弹，圆圈先保持收起，等停留位展开时再一起出现。
      if (!(holdAfterSettle && pendingHoldRef.current)) {
        progress.stopAnimation()
        Animated.timing(progress, {
          toValue: 1,
          duration: 280,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }).start()
      }
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
    clearTimer(holdTimerRef)
  }, [])

  // 学「真实静止位」：只在第一次见到非拖动、非刷新、顶部区域（y ≤ 0）的偏移时记下，
  // 之后所有回位都用它，避免一次没回到位导致起点越来越低、空白越拉越大。
  const learnRestTop = useCallback((y: number) => {
    // 只学负偏移：有安全区 inset 的列表静止位是负值（如 -54）；y ≥ 0 的列表说明
    // 没有自动 inset，此时静止位就是 0，由「下拉达标时的拖动起点」兜底确定。
    if (restTopRef.current != null || y >= 0 || dragStartRef.current != null || displayRef.current) return
    restTopRef.current = y
  }, [])

  const handleScrollBeginDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // 拖动开始时不改动 contentInset：在手势进行中改滚动范围会打断 UIKit 的 pan，
    // 表现为「列表滑不动」。inset 只由「触发刷新」和「刷新收尾」两个时刻切换。
    const y = e.nativeEvent.contentOffset.y
    // 用户又上手了：取消还没展开的停留位，别在他拖动时突然下移列表。
    pendingHoldRef.current = false
    clearTimer(holdTimerRef)
    // 先学静止位（此刻 dragStart 还是 null），再登记本次拖动起点。
    learnRestTop(y)
    dragStartRef.current = y
    dragTopRef.current = y
    lastOffsetRef.current = y
    pullRef.current = 0
    lastPullRef.current = 0
    lastStepRef.current = 0
  }, [learnRestTop])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = y
    if (displayRef.current) {
      if (pendingHoldRef.current) {
        // 延后展开停留位的页面：等系统回弹把偏移送回静止位（= 本次拖动起点），
        // 落定后再单独展开空白区 —— 任何时刻只有一段位移在动。
        if (y >= dragTopRef.current - 1) startHold()
        return
      }
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
    // 注意：拖动过程中**绝不**改 inset —— 那会让系统可回弹范围变化、松手后停在半路。
    const step = Math.min(1, Math.round((pull / (holdSpace ? HOLD_TRIGGER : PULL_TRIGGER)) * 32) / 32)
    if (step === lastStepRef.current) return
    lastStepRef.current = step
    lastPullRef.current = pull
    progress.stopAnimation()
    progress.setValue(step)
  }, [progress, holdSpace, learnRestTop, startHold])

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
      // 达标时的拖动起点就是「用户看到的静止位」，比任何采样都可靠（无自动 inset 的
      // 列表只能从这里拿到 0）。只写一次，之后永远用它回位，避免一次没回成功就累积偏移。
      if (restTopRef.current == null) restTopRef.current = start
      // 只有「有停留位」的页面才下移列表。歌单主页 / 我的 / 播放历史 / 排行榜
      // 不做任何位移 —— 它们松手后交给系统回弹，否则收尾归零时会「猛地上跳一下」。
      const settleHold = holdSpace && holdAfterSettle
      if (settleHold) {
        // 挂起停留位：等 onScroll 看到偏移回到静止位（或 600ms 兜底）再展开，
        // 避免与系统橡胶回弹同时运动造成上下跳。
        pendingHoldRef.current = true
        clearTimer(holdTimerRef)
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null
          startHold()
        }, HOLD_SETTLE_MS)
      } else if (holdSpace) {
        holdAppliedRef.current = true
        holdAnim.stopAnimation()
        Animated.timing(holdAnim, {
          toValue: 1,
          duration: 220,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start()
      }
      displayRef.current = true
      setDisplayRefreshing(true)
      lastStepRef.current = 1
      if (settleHold) {
        // 回弹期间先把圆圈收起（它会压在还没让开的列表行上），空白展开时再淡入。
        progress.stopAnimation()
        Animated.timing(progress, {
          toValue: 0,
          duration: 140,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false,
        }).start()
      } else {
        progress.stopAnimation()
        progress.setValue(1)
      }
      onRefreshRef.current()
      sawRefreshingRef.current = false
      clearTimer(fallbackTimerRef)
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null
        if (!sawRefreshingRef.current && !refreshingRef.current) hideIndicator()
      }, settleHold ? HOLD_SETTLE_FALLBACK_MS : FALLBACK_MS)
      return
    }
    // 轻拉松手（未达触发位）：列表交给系统自然回弹，圆圈淡出即可。
    if (start != null && start <= 0) dragTopRef.current = start
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, holdAnim, holdSpace, holdAfterSettle, startHold])

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
  // 纯回弹页面保持原来的 32pt 圆圈几何、位置固定；有停留位的页面用更大的空白高度，
  // 圆圈随下拉距离移动，始终停在下拉出来的空白区中心，达到触发高度后固定不再移动。
  const ringGap = holdSpace ? HOLD_GAP : PULL_TRIGGER
  const ringTranslate = holdSpace
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [-ringGap / 2, 0] })
    : 0
  // 纯回弹页面若给了定位区：圆圈下对齐贴在标题上方；否则维持原几何。
  const useArea = !holdSpace && indicatorArea != null
  const areaHeight = useArea ? indicatorArea!.height : ringGap
  // inline 模式：由调用方把圆圈放进页头里正常排版（不用绝对定位），
  // 适合「绝对定位坐标系不可靠」的页面（如歌单主页）。
  const isInline = useArea && indicatorArea!.inline === true
  const indicatorStyle = isInline
    ? { height: areaHeight, alignItems: 'center' as const, justifyContent: 'center' as const }
    : {
        ...styles.indicator,
        top: useArea ? indicatorArea!.top : topOffset,
        height: areaHeight,
        justifyContent: (useArea ? 'flex-end' : 'center') as 'flex-end' | 'center',
      }

  const indicator = (
    <Animated.View
      pointerEvents="none"
      style={[
        indicatorStyle,
        {
          opacity: progress,
          transform: [{ translateY: ringTranslate }],
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

  // 列表下移量（调用方套在 Animated.View 上）：只由刷新态的 holdAnim 驱动。
  const pullOffset = holdSpace
    ? holdAnim.interpolate({ inputRange: [0, 1], outputRange: [0, HOLD_GAP] })
    : holdAnim

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
      // 完全不传 contentInset：滚动范围保持不变，列表才能正常上下滑。
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
