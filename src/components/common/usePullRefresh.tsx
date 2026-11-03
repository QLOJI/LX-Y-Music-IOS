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
/**
 * 停留位进/出的弹簧参数：临界阻尼附近（阻尼比 ≈0.97），自然频率 ≈13.4 rad/s，
 * 约 0.4~0.5s 收住 —— 与 UIKit 橡胶回弹的节奏同一量级，替代原先固定 220ms/320ms 的位移。
 */
const HOLD_SPRING_STIFFNESS = 180
const HOLD_SPRING_DAMPING = 26
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

/**
 * 「停留位锁」：松手达到触发位后，列表先跟着系统回弹走；同时用
 * `translateY = clamp(dy + 60, 0, 60) × holdMode`（dy = 当前偏移 − 静止位）逐帧抵消回弹：
 *   · dy ≤ -60：补偿为 0，回弹速度完全由系统决定（从超过 60pt 的位置回到停留位，
 *     用的就是系统自然回弹速度）；
 *   · dy > -60：补偿把 dy 抵消掉，空白恒为 60pt —— 物理上不可能再掉到 60pt 以下；
 *   · 回弹落定（dy = 0）后补偿是常量 60，用户主动向上滚动照常，不会被冻住。
 * 拖动阶段 holdMode 恒为 0（列表跟手），只有松手达到触发位的那次刷新才为 1。
 */


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
   * 停留位「锁」：松手达标后由滚动偏移原生驱动 transform（见文件内 syncPullOffset 说明），
   * 保证空白区域不会小于 60pt、不会再被系统回弹拽上去。只对 holdSpace 页面启用。
   */
  lockHold: boolean = false,
  /**
   * 程序化停留：刷新由代码发起（切 tab / 首次加载，refreshing 被外部置 true）时，
   * 也走「列表整体下拉 60pt → 停住 → 自然收回」的同一套动画。
   * 用户手指下拉触发的刷新已经由 handleScrollEndDrag 拉下过，不会重复。
   */
  autoHold: boolean = false,
) => {
  const theme = useTheme()
  const progress = useRef(new Animated.Value(0)).current
  // lockHold 专用：滚动偏移（原生映射）与「锁定」开关。
  const scrollY = useRef(new Animated.Value(0)).current
  const holdLock = useRef(new Animated.Value(0)).current
  const holdLockRef = useRef(0)
  // 列表的「静止位」偏移：锁的补偿量都以它为基准，停留位才是「距初始位置 60pt」，
  // 而不是距容器顶 60pt（有安全区自动 inset 的列表两者不相等）。
  const restTopValue = useRef(new Animated.Value(0)).current
  // 刷新态的列表下移（0~1 系数，乘 HOLD_GAP）。只在手指松开后 / 刷新收尾时做一次性
  // 动画——拖动过程中恒为 0，绝不逐帧改 transform（那会和 pan 打架）。
  // 用 transform 而不是 contentInset / scrollToOffset：后两者会改动滚动状态，
  // 与手势竞争时表现为「上下滑动被锁住」。
  const holdAnim = useRef(new Animated.Value(0)).current
  // 本次刷新的触发时刻（松手那一刻），用于 HOLD_MIN_MS 硬性最短停留。
  const triggerAtRef = useRef(0)
  const holdMinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const spin = useRef(new Animated.Value(0)).current
  // 圆圈在空白里的位置系数：0 = 没有空白，1 = 60pt 停留位；>1 = 下拉超过 60pt。
  // 圆圈始终落在「空白高度」的中心（0.5 × blank），不再固定停在 60pt 区的中心。
  const ringPull = useRef(new Animated.Value(0)).current
  // 列表静止位相对容器顶的视觉偏移（= −静止位 contentOffset，通常 0；有安全区自动 inset 时 >0）。
  // 圆圈的定位盒整体下移这么多，才能和「距静止位 60pt」的停留空白对齐。
  const [restInset, setRestInset] = useState(0)
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

  // 「距静止位」的偏移：下拉为负，回弹落定为 0，用户向上滚动为正。
  const holdDelta: any = useMemo(() => Animated.subtract(scrollY, restTopValue), [scrollY, restTopValue])
  // lockHold 的 transform（纯 Animated 原生节点，随滚动逐帧更新）：
  //   dy ≤ -60      → 0       还没到停留位，列表完整跟随系统回弹（速度由系统决定）
  //   -60 < dy ≤ 0  → dy + 60 抵消系统回弹带来的反向位移：空白恒为 60pt，不可能跳小
  //   dy > 0        → 60      回弹落定后为常量；用户主动上滑时列表照常移动，不被冻住
  // 再乘 holdLock：拖动阶段恒为 0（列表只跟手），松手达标的那次刷新才为 1。
  const syncPullOffset = useMemo(() => Animated.multiply(
    holdDelta.interpolate({
      inputRange: [-100000, -HOLD_GAP, 0, 100000],
      outputRange: [0, 0, HOLD_GAP, HOLD_GAP],
      extrapolate: 'clamp',
    }),
    holdLock,
  ), [holdDelta, holdLock])

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
      if (lockHold) {
        // 锁：解锁（holdLock 1→0），停留位按弹簧收回。
        holdLockRef.current = 0
        holdLock.stopAnimation()
        Animated.spring(holdLock, {
          toValue: 0,
          stiffness: HOLD_SPRING_STIFFNESS,
          damping: HOLD_SPRING_DAMPING,
          mass: 1,
          useNativeDriver: true,
        }).start()
      } else {
        holdAnim.stopAnimation()
        // 收回同样走弹簧（与系统回弹同一量级的速度），不再用固定 320ms。
        Animated.spring(holdAnim, {
          toValue: 0,
          stiffness: HOLD_SPRING_STIFFNESS,
          damping: HOLD_SPRING_DAMPING,
          mass: 1,
          useNativeDriver: true,
        }).start()
      }
      // 圆圈随空白一起收回（同一组弹簧参数，始终落在空白中心）。
      ringPull.stopAnimation()
      Animated.spring(ringPull, {
        toValue: 0,
        stiffness: HOLD_SPRING_STIFFNESS,
        damping: HOLD_SPRING_DAMPING,
        mass: 1,
        useNativeDriver: false,
      }).start()
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, holdAnim, holdSpace, lockHold, holdLock, ringPull])

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
      // 程序化刷新（切 tab / 首载）：用户没下拉，也要把列表整体下拉 60pt、停住、再自然收回。
      // 用户手动下拉触发的刷新已由 handleScrollEndDrag 拉下（holdAppliedRef = true），跳过。
      if (holdSpace && autoHold && !holdAppliedRef.current) {
        holdAppliedRef.current = true
        triggerAtRef.current = Date.now()
        const holdValue = lockHold ? holdLock : holdAnim
        holdValue.stopAnimation()
        if (lockHold) holdLockRef.current = 1
        Animated.spring(holdValue, {
          toValue: 1,
          stiffness: HOLD_SPRING_STIFFNESS,
          damping: HOLD_SPRING_DAMPING,
          mass: 1,
          useNativeDriver: true,
        }).start()
        // 圆圈与空白同步下拉：同一组弹簧参数，始终落在可见空白中心
        //（restInset 是该列表静止位自带的安全区留白）。
        ringPull.stopAnimation()
        Animated.spring(ringPull, {
          toValue: 1 + restInset / HOLD_GAP,
          stiffness: HOLD_SPRING_STIFFNESS,
          damping: HOLD_SPRING_DAMPING,
          mass: 1,
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
  }, [refreshing, progress, hideIndicator, holdSpace, autoHold, lockHold, holdAnim, holdLock, ringPull, restInset])

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

  // 预热锁值：1ms 原生动画把 holdLock 挂到原生驱动。之后松手开锁用 setValue 即时生效
  // （不再等一次 timing 的启动帧）—— 回弹越过 60pt 线的那一帧不会再出现先掉下去、
  // 下一帧才被补偿拉回的小跳动。
  useEffect(() => {
    // 已经进入刷新（锁可能刚被 autoHold 的弹簧驱动）就不要重置它。
    if (!lockHold || displayRef.current) return
    holdLock.stopAnimation()
    Animated.timing(holdLock, { toValue: 0, duration: 1, useNativeDriver: true }).start()
  }, [lockHold, holdLock])

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
    restTopValue.setValue(y)
    // 有安全区自动 inset 的列表：圆圈定位盒整体下移 -y，和停留空白对齐。
    setRestInset(-y)
  }, [restTopValue])

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
  }, [learnRestTop])

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y
    lastOffsetRef.current = y
    if (displayRef.current) {
      // 锁在松手那一刻就已经打开（见 handleScrollEndDrag）；这里不再按滚动回调判断，
      // 否则 JS 回调晚到几帧，空白会先掉到 60pt 以下再被拉回来。
      // 圆圈随「当前空白高度」走：回弹过程中空白从松手时的高度收向 60pt，
      // 圆圈跟着它的中心移动，停下时正好在 60pt 空白中心。
      if (lockHold) {
        const dy = y - (restTopRef.current ?? 0)
        const comp = holdLockRef.current === 1 ? Math.max(0, Math.min(HOLD_GAP, dy + HOLD_GAP)) : 0
        // 圆圈落在「可见空白」的中心：可见空白 = 静止位自带的安全区留白 + 本次下拉/停留高度。
        // 只加本次停留高度会让圆圈停在安全区下方（与其它页位置不一致，用户看到的「错位」）。
        ringPull.setValue((restInset + Math.max(0, -dy + comp)) / HOLD_GAP)
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
    // 提前开锁（关键）：下拉**越过触发位**的那一刻就在原生侧把锁值挂上。此刻
    // dy ≤ −60，补偿量为 0，视觉上没有任何变化；等松手后系统回弹越过 60pt 线时，
    // 锁早已生效 —— 不会因为「松手事件到 JS 有 1~2 帧延迟」而先掉到 60pt 以下、
    // 下一帧再被补偿拉回（那一下就是回弹过程中的「轻微跳动」）。
    if (lockHold && holdLockRef.current === 0 && pull >= HOLD_TRIGGER) {
      restTopValue.setValue(restTopRef.current ?? start)
      holdLock.stopAnimation()
      holdLockRef.current = 1
      holdLock.setValue(1)
    }
    // 圆圈位置：跟「当前空白高度」走。锁已开时空白至少是 60pt（下拉回撤到 60 以下
    // 也会被锁住），其余情况就是当前下拉距离；超过 60pt 继续居中。
    if (holdSpace) {
      const circleBlank = holdLockRef.current === 1 ? Math.max(pull, HOLD_GAP) : pull
      // 可见空白 = 静止位自带留白（restInset）+ 下拉/停留高度；圆圈取其中心。
      ringPull.setValue((restInset + circleBlank) / HOLD_GAP)
    }
    // 进度按 1/32 量化，慢拉时不必每帧过桥同步（触发距离按页面口径）。
    // 注意：拖动过程中**绝不**改 inset —— 那会让系统可回弹范围变化、松手后停在半路。
    const step = Math.min(1, Math.round((pull / (holdSpace ? HOLD_TRIGGER : PULL_TRIGGER)) * 32) / 32)
    if (step === lastStepRef.current) return
    lastStepRef.current = step
    lastPullRef.current = pull
    progress.stopAnimation()
    progress.setValue(step)
  }, [progress, holdSpace, learnRestTop, ringPull, lockHold, holdLock, restTopValue, restInset])

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
      if (holdSpace) {
        holdAppliedRef.current = true
        if (lockHold) {
          // 松手的**同一时刻**就开锁：此刻 dy ≤ -60，补偿量为 0，不会产生任何位移；
          // 从系统回弹越过「距静止位 60pt」那条线的那一帧起，原生映射开始逐帧抵住，
          // 空白因此不可能先掉到 60pt 以下（等 JS 滚动回调再开锁会晚几帧，就是那个跳动）。
          const restTop = restTopRef.current ?? start
          restTopValue.setValue(restTop)
          if (restTop < 0) setRestInset(-restTop)
          holdLock.stopAnimation()
          holdLockRef.current = 1
          // 直接置 1（值已在挂载时预热成原生节点）：不再用 1ms timing —— 那会晚一帧
          // 才生效，回弹恰好在这一帧越过 60pt 线时就会掉一下再被拉回，即「小跳动」。
          holdLock.setValue(1)
        } else {
          holdAnim.stopAnimation()
          // 停留位（60pt）用弹簧动画到位：接近 UIKit 橡胶回弹的临界阻尼（约 0.4~0.5s、
          // 由快到慢收住），不再是固定 220ms 的机械位移。
          Animated.spring(holdAnim, {
            toValue: 1,
            stiffness: HOLD_SPRING_STIFFNESS,
            damping: HOLD_SPRING_DAMPING,
            mass: 1,
            useNativeDriver: true,
          }).start()
          ringPull.stopAnimation()
          Animated.spring(ringPull, {
            toValue: 1 + restInset / HOLD_GAP,
            stiffness: HOLD_SPRING_STIFFNESS,
            damping: HOLD_SPRING_DAMPING,
            mass: 1,
            useNativeDriver: false,
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
    // 拖过 60pt 后又回撤到触发位以下才松手（不触发刷新）：把提前挂上的锁平滑放掉，
    // 不能瞬间归 0，否则 60pt 的空白会「啪」地掉下去。
    if (lockHold && holdLockRef.current === 1) {
      holdLockRef.current = 0
      holdLock.stopAnimation()
      Animated.spring(holdLock, {
        toValue: 0,
        stiffness: HOLD_SPRING_STIFFNESS,
        damping: HOLD_SPRING_DAMPING,
        mass: 1,
        useNativeDriver: true,
      }).start()
    }
    if (holdSpace) {
      // 圆圈回到顶部（系统回弹把空白收回 0）。
      ringPull.stopAnimation()
      Animated.spring(ringPull, {
        toValue: 0,
        stiffness: HOLD_SPRING_STIFFNESS,
        damping: HOLD_SPRING_DAMPING,
        mass: 1,
        useNativeDriver: false,
      }).start()
    }
    progress.stopAnimation()
    Animated.timing(progress, {
      toValue: 0,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [progress, holdAnim, holdSpace, lockHold, restTopValue, ringPull, restInset])

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
  // 纯回弹页面保持原来的 32pt 圆圈几何、位置固定；有停留位的页面里，圆圈**始终落在
  // 当前空白的正中**：下拉多远，圆圈就在那片空白的中心（ringPull = 空白高度 / 60，
  // 允许 >1；回弹/收回时用同一组弹簧参数跟进）。不再像以前那样超过 60pt 后就停在
  // 60pt 区中心、看着偏上。
  const ringGap = holdSpace ? HOLD_GAP : PULL_TRIGGER
  const ringTranslate = holdSpace
    ? ringPull.interpolate({ inputRange: [0, 1], outputRange: [-ringGap / 2, 0], extrapolate: 'extend' })
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
        // 有停留位的页面：定位原点保持在容器顶，圆圈位置由 ringPull 统一按「可见空白」
        // （安全区自带留白 + 下拉/停留高度）的一半计算 —— 各页位置口径一致。
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
  //  · lockHold：由滚动偏移原生驱动（松手回弹越过 60pt 线后锁死在停留位）；
  //  · 其它停留位页面：由 holdAnim 弹簧驱动。
  const pullOffset = holdSpace
    ? (lockHold
        ? syncPullOffset
        : holdAnim.interpolate({ inputRange: [0, 1], outputRange: [0, HOLD_GAP] }))
    : holdAnim

  // lockHold 需要把滚动偏移映射进 Animated（原生驱动）；listener 继续跑 JS 侧逻辑
  // （圆圈进度、锁定判断）。
  const onScroll = useMemo((): any => (
    lockHold
      ? Animated.event(
        [{ nativeEvent: { contentOffset: { y: scrollY } } }],
        { useNativeDriver: true, listener: handleScroll },
      )
      : handleScroll
  ), [lockHold, scrollY, handleScroll])

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
