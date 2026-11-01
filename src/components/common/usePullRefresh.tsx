import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
/**
 * 松手后系统橡胶回弹大致落定所需的时间（ms）。
 * 用途：**不要在回弹还没结束时替换列表数据** —— 那次 contentSize 变化会让 UIScrollView
 * 把当前的负偏移（回弹中）夹回 0，观感就是「松手后列表被往上拽一下」。页面的下拉刷新
 * 结果在这个时间之后再落地（见 SonglistDetail / ArtistDetail 的 refresh 分支）。
 */
export const PULL_SETTLE_MS = 450
// 停留位/圆圈的**硬性**最短停留：从松手触发那一刻算起。页面刷新状态回得太快、或干脆没回报
// refreshing 时，也保证停留画面能停留这么久，不会「松手就收」。
const HOLD_MIN_MS = 1200
const FALLBACK_MS = 700
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
   * 停留位的 transform 改为**由滚动偏移原生驱动**（不再是松手后的一段独立动画）：
   *   `translateY = (contentOffset.y + 60) × holdMode`，其中 holdMode 在下拉超过 60pt 时置 1、
   *   收起时归 0。这样系统橡胶回弹的每一帧（含松手初速度）都被逐帧抵消，列表在视觉上
   *   牢牢停在停留位，不会出现「惯性拽一下再回来」；拖动超过 60pt 后的部分也不再跟手。
   * 必须是 holdSpace 页面；其它页面保持原实现。
   */
  syncHoldWithScroll = false,
) => {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current
  // syncHoldWithScroll 专用：滚动偏移（原生事件映射）与停留位开关。
  const scrollY = useRef(new Animated.Value(0)).current
  const holdMode = useRef(new Animated.Value(0)).current
  const holdModeRef = useRef(0)
  // 本次拖动是否到达过停留位（带一点回拖余量）：用于松手判定「用户确实拉到位了」。
  // 视觉上列表在 60pt 处就停住了，松手时实际偏移可能刚好差零点几 pt，不能只看松手值。
  const holdIntentRef = useRef(false)
  // 刷新态的列表下移（0~1 系数，乘 HOLD_GAP）。只在手指松开后 / 刷新收尾时做一次性
  // 动画——拖动过程中恒为 0，绝不逐帧改 transform（那会和 pan 打架）。
  // 用 transform 而不是 contentInset / scrollToOffset：后两者会改动滚动状态，
  // 与手势竞争时表现为「上下滑动被锁住」。
  const holdAnim = useRef(new Animated.Value(0)).current
  // 本次刷新的触发时刻（松手那一刻），用于 HOLD_MIN_MS 硬性最短停留。
  const triggerAtRef = useRef(0)
  const holdMinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  // syncHoldWithScroll 的 transform：y∈[-∞,0] 时 = y + 60，y>0 时夹在 60；再乘 holdMode。
  // 全部是 Animated 原生节点，跟随滚动逐帧更新。
  const syncPullOffset = useMemo(() => Animated.multiply(
    scrollY.interpolate({
      inputRange: [-100000, 0],
      outputRange: [-100000 + HOLD_GAP, HOLD_GAP],
      extrapolateRight: 'clamp',
    }),
    holdMode,
  ), [scrollY, holdMode])

  const hideIndicator = useCallback(() => {
    // 硬性最短停留：从松手触发算起不足 HOLD_MIN_MS 就推迟，保证停留画面一定看得见。
    // 只对停留位页面生效（其它页面保持原有节奏）。
    const holdRemain = holdSpace ? HOLD_MIN_MS - (Date.now() - triggerAtRef.current) : 0
    if (holdRemain > 0) {
      clearTimer(holdMinTimerRef)
      holdMinTimerRef.current = setTimeout(() => {
        holdMinTimerRef.current = null
        hideIndicator()
      }, holdRemain)
      return
    }
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
      if (syncHoldWithScroll) {
        // 原生同步模式：把 holdMode 从 1 归零，停留位高度按 60→0 平滑收回。
        holdModeRef.current = 0
        holdMode.stopAnimation()
        Animated.timing(holdMode, {
          toValue: 0,
          duration: 320,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start()
      } else {
        holdAnim.stopAnimation()
        Animated.timing(holdAnim, {
          toValue: 0,
          duration: 320,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start()
      }
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, holdAnim, holdSpace, syncHoldWithScroll, holdMode])

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
    clearTimer(holdMinTimerRef)
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
    // 先学静止位（此刻 dragStart 还是 null），再登记本次拖动起点。
    learnRestTop(y)
    dragStartRef.current = y
    dragTopRef.current = y
    lastOffsetRef.current = y
    pullRef.current = 0
    lastPullRef.current = 0
    lastStepRef.current = 0
    holdIntentRef.current = false
  }, [learnRestTop])

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
    // 原生同步模式：越过 60pt 打开停留位开关（此后列表由滚动偏移逐帧钉在停留位），
    // 拖回 60pt 以内再关掉。只在跨越时写一次，不逐帧过桥。
    if (syncHoldWithScroll) {
      const next = pull >= HOLD_TRIGGER ? 1 : 0
      if (holdModeRef.current !== next) {
        holdModeRef.current = next
        holdMode.setValue(next)
      }
      // 到达过停留位就一直算「有刷新意图」，只有明显拖回去（< 45pt）才撤销，
      // 这样在停留位附近松手（差零点几 pt）不会被误判成轻拉。
      if (pull >= HOLD_TRIGGER) holdIntentRef.current = true
      else if (pull < HOLD_TRIGGER - 15) holdIntentRef.current = false
    }
    // 进度按 1/32 量化，慢拉时不必每帧过桥同步（触发距离按页面口径）。
    // 注意：拖动过程中**绝不**改 inset —— 那会让系统可回弹范围变化、松手后停在半路。
    const step = Math.min(1, Math.round((pull / (holdSpace ? HOLD_TRIGGER : PULL_TRIGGER)) * 32) / 32)
    if (step === lastStepRef.current) return
    lastStepRef.current = step
    lastPullRef.current = pull
    progress.stopAnimation()
    progress.setValue(step)
  }, [progress, holdSpace, syncHoldWithScroll, holdMode, learnRestTop])

  const handleScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const start = dragStartRef.current
    dragStartRef.current = null
    if (displayRef.current) return
    const y = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = y
    const pull = start == null ? pullRef.current : (start <= 0 ? Math.max(0, start - y) : 0)
    const trigger = holdSpace ? HOLD_TRIGGER : PULL_TRIGGER
    pullRef.current = pull
    // syncHoldWithScroll 页面：下拉越过 60pt 后列表视觉上就「停住」了，用户在停留位松手时
    // 实际偏移可能刚好差零点几 pt 没到阈值 —— 只要本次拖动打开过停留位（holdMode=1），
    // 松手就按触发处理，否则会被判成轻拉、直接弹回原位（就是「拉到停留位又被拽回去」）。
    const pinEngaged = syncHoldWithScroll && holdIntentRef.current
    if (start != null && start <= 0 && (pull >= trigger || pinEngaged)) {
      dragTopRef.current = start
      // 达标时的拖动起点就是「用户看到的静止位」，比任何采样都可靠（无自动 inset 的
      // 列表只能从这里拿到 0）。只写一次，之后永远用它回位，避免一次没回成功就累积偏移。
      if (restTopRef.current == null) restTopRef.current = start
      // 只有「有停留位」的页面才下移列表。歌单主页 / 我的 / 播放历史 / 排行榜
      // 不做任何位移 —— 它们松手后交给系统回弹，否则收尾归零时会「猛地上跳一下」。
      if (holdSpace) {
        holdAppliedRef.current = true
        if (syncHoldWithScroll) {
          // 原生同步：holdMode 在拖动阶段已打开，这里只兜底一次（例如松手帧刚好跨过阈值）。
          // 不再启动独立的位移动画 —— 停留位完全由滚动偏移原生驱动。
          if (holdModeRef.current !== 1) {
            holdModeRef.current = 1
            holdMode.setValue(1)
          }
        } else {
          holdAnim.stopAnimation()
          Animated.timing(holdAnim, {
            toValue: 1,
            duration: 220,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start()
        }
      }
      displayRef.current = true
      triggerAtRef.current = Date.now()
      setDisplayRefreshing(true)
      progress.stopAnimation()
      progress.setValue(1)
      lastStepRef.current = 1
      onRefreshRef.current()
      sawRefreshingRef.current = false
      clearTimer(fallbackTimerRef)
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null
        if (!sawRefreshingRef.current && !refreshingRef.current) hideIndicator()
      }, FALLBACK_MS)
      return
    }
    // 轻拉松手（未达触发位）：列表交给系统自然回弹，圆圈淡出即可。
    if (start != null && start <= 0) dragTopRef.current = start
    if (syncHoldWithScroll && holdModeRef.current !== 0) {
      // 拖回去了：关掉停留位开关，列表恢复跟手/回原位。
      holdModeRef.current = 0
      holdMode.setValue(0)
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, holdAnim, holdSpace, syncHoldWithScroll, holdMode])

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

  // 列表下移量（调用方套在 Animated.View 上）：
  //  · syncHoldWithScroll：由滚动偏移原生驱动（逐帧抵消系统回弹，含松手初速度）；
  //  · 其它停留位页面：仍由刷新态的 holdAnim 驱动。
  const pullOffset = holdSpace
    ? (syncHoldWithScroll
        ? syncPullOffset
        : holdAnim.interpolate({ inputRange: [0, 1], outputRange: [0, HOLD_GAP] }))
    : holdAnim

  // syncHoldWithScroll 需要把滚动偏移映射进 Animated（原生驱动），同时保留 JS 侧的
  // 圆圈进度/触发判断 —— Animated.event 的 listener 正好提供这两者。
  const onScroll = useMemo((): any => (
    syncHoldWithScroll
      ? Animated.event(
        [{ nativeEvent: { contentOffset: { y: scrollY } } }],
        { useNativeDriver: true, listener: handleScroll },
      )
      : handleScroll
  ), [syncHoldWithScroll, scrollY, handleScroll])

  return {
    indicator,
    pullOffset,
    scrollProps: {
      onScroll,
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
