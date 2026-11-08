import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  Pressable,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  View,
  Animated,
  Easing,
  Platform,
  requireNativeComponent,
} from 'react-native'
import Text from '@/components/common/Text'
import KaraokeLyric from './KaraokeLyric'
import PlayLine, { type PlayLineType } from './PlayLine'
import { type Line, useLrcPlay, useLrcSet, useLrcWordsMap, anchorLyric as lrcAnchorToTime, findLineIndexByTime } from '@/plugins/lyric'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { scaleSizeH, scaleSizeW, setSpText } from '@/utils/pixelRatio'
import { useWindowSize } from '@/utils/hooks'
import { useAppActive, useComponentIds, useNavReturning } from '@/store/common/hook'
import { COMPONENT_IDS } from '@/config/constant'
import playerState from '@/store/player/state'
import { useIsPlay } from '@/store/player/hook'
import { IDLE_RETURN_MS, LINE_ZOOM_MS, RETURN_TO_ACTIVE_MS, easeInOutSine } from '@/screens/PlayDetail/lyricAnimation'
import { addPagerTapListener } from '@/utils/nativeModules/utils'

// 迷你歌词 = 封面页上的「上一行 / 当前行 / 下一行」**定窗**歌词窗（窗口高度固定，行高逐行算）。
//
// 定窗是这一版的核心，三个历史问题都由它根治：
//   1) 三行间距不等：相邻两行文本之间的净间距恒为同一个 gap，与行高无关；
//   2) 行数不足时高度塌缩、整块抖动：行数少于三行（首行/末行/歌词未就绪）时，
//      内容上下留白，块高始终 = 行数 × 最坏行高，绝不随内容变化；
//   3) 换行时歌名等元素抖动：换行只改变列表的滚动位置（一次不重算目标的滚动动画），
//      不改变任何一行的高度与字号（统一字号，当前行只靠颜色区分）。
// 2026-10-02（第 16 轮第 8 条）：行高从「整首歌一个常量」改成「逐行按内容算」——
// 只有**当前行**带真实翻译时那一行才多占一个翻译槽，其余行只占行盒 + 净间距，
// 恢复重写前「翻译只跟当前行走」的密度（用户原话：现在间距太大了，还原以前的）。
//
// 交互：长按/拖动歌词进入手动定位态（浮层 = 虚线 + 时间 + 播放三角），
// 停手 IDLE_RETURN_MS 后自动平滑回位到当前播放行并淡出浮层；点行文本仍切换到歌词页。
const BASE_FONT_SIZE = 17
// 翻译行字号略小（与主行共用同一行高倍率，故行盒高度仍然确定）
const TRANSLATION_FONT_SIZE = 14
// 显式指定 lineHeight 而不依赖字体自然行高：不同字体（PingFang / SF）的自然行高差最大 0.2em，
// 定高定位要求行盒高度是一个确定值，不能交给字体度量。
const LINE_HEIGHT_RATIO = 1.3
// 行与行之间的净间距（定高布局下它就是行间距本身，三行恒等）
// 2026-10-01 用户要求「减少一半小歌词每行间距」：8 → 4
const LINE_GAP_NORMAL = 4
// 小屏（与 SongInfo / FeatureBtns 的判定阈值一致）空间不足：只保留当前行，
// 避免三行定高窗口把歌名块顶出容器、压到下方控制条
const SMALL_WINDOW_HEIGHT = 700
// 定高窗口的行数：由实测可用高度自动定档（用户要求「区域没填满就多显示一行」）。
// 3 行是基准档，最多 4 行 —— 再多就会把上方封面挤掉，也不符合「3~4 行」的原话。
// 可用高度更小时（小屏 / 横屏被压扁）逐档降到 2 行、1 行，绝不低于 1。
const MAX_WINDOW_ROWS = 4
// 外层还没实测出可用高度（首帧 / 老调用点）时的兜底行数：按基准档 3 行渲染，
// 实测值一到就按实测重新定档。小屏另有更保守的降级（见下方 limit）。
const FALLBACK_WINDOW_ROWS = 3
// 歌词内容的左右内缩（pt，经横向缩放）：与信息块里其它文字（歌名/歌手/专辑）同一个左缘。
// 它现在只作用在**列表内容**上，容器自身不再留左右内边距 —— 手动定位浮层（绝对定位、
// 与本容器同级）要按大歌词的口径贴到屏幕边，容器带左右 padding 会把浮层一起缩进去
// （用户原话：虚线和播放图标离最右侧太远了）。
const BASE_LINE_INSET_H = 20
// 档位切换的滞回余量（pt，经全局缩放）。见下方 rowCount 处的说明：
// 它必须小于一行行高，否则降档判断会迟钝到把三行窗口挤出行外。
const ROW_SWITCH_HYSTERESIS = 8
// 自动跟随时跨行距离超过这么多行：直接落位，不做长距离快速滑动（进度条 seek / 恢复播放）
const FAR_JUMP_ROWS = 8
// 长按进入定位态时用来「逼出首帧滚动信息」的位移：小于半个像素（视觉不可见），
// 但足以让滚动容器发出一次带完整 contentOffset / layoutMeasurement / contentSize 的滚动事件
const SCROLL_NUDGE = 0.5
// 拖动超过这么多 pt 才显示定位浮层：横向翻页会被外层 PagerView 抢走手势，
// 那时列表只收到 beginDrag / endDrag（位移为 0），不该为此闪一个空浮层出来
const OVERLAY_SHOW_MOVE = 2

// 三个尺寸常量：字号 → 文字行高 → 行高（含行间距）。用 setSpText/scaleSizeH 与 Text 组件
// 的缩放同源，全局字体调大时行高同步变大，不会出现「字被行高裁掉」。
const calcMetrics = () => ({
  lineHeight: Math.round(setSpText(BASE_FONT_SIZE) * LINE_HEIGHT_RATIO),
  translationHeight: Math.round(setSpText(TRANSLATION_FONT_SIZE) * LINE_HEIGHT_RATIO),
  gap: Math.max(scaleSizeH(LINE_GAP_NORMAL), 1),
})

/**
 * 一行小歌词的整行高度（行盒 + 行间距；hasTranslation 时再叠加翻译行高度与它自己的间距）。
 * 与组件内部的 baseRowHeight / worstRowHeight **同源**（同一个 calcMetrics）。独立出来的唯一原因：
 * 竖屏布局（VerticalNew）必须知道「一行小歌词至少多高」，
 * 才能把封面的尺寸上限压到「放得下这一行」——封面是 flexShrink:0 的居中块，
 * 小歌词被强制渲染 ≥1 行时多出来的高度会直接把封面顶到歌名上（用户报的越界）。
 * 调用方传 hasTranslation=true 取**最坏情况**，这样就不必订阅歌词内容：
 * 常态机型上这条上限根本不生效，多算一点只是保守。
 */
export const getMiniLyricRowHeight = (hasTranslation: boolean) => {
  const m = calcMetrics()
  return m.lineHeight + m.gap + (hasTranslation ? m.translationHeight + m.gap : 0)
}
// 「这一行真的有翻译」的判据：空串 / 纯空白不算。
// 某些歌词源会给每一行都挂一条空翻译（[''] 或 [' ']），旧判据 (extendedLyrics.length > 0)
// 会把整首歌误判成「有翻译」，于是每一行都留出一个看不见的翻译槽，行与行之间空出一大截 ——
// 这是用户第 16 轮第 8 条「现在间距太大」的一种来源，必须按「有真内容」判断。
const hasRealTranslation = (line: Line | undefined) => ((line?.extendedLyrics?.[0] ?? '').trim().length > 0)
// 空占位必须用不换行空格：RN 里空字符串的 <Text> 高度为 0
const BLANK = ' '
// 【第 233 轮】常驻隐形按钮：原生 RCTView 子类在 didMoveToWindow 自己装 tap 手势，
// 只识别点击、滑动不拦；不依赖 tag / 桥，页面重建后自动恢复。
const PagerTapView = Platform.OS === 'ios'
  ? requireNativeComponent<any>('LXPagerTapView')
  : View

export interface MiniLyricProps {
  /** 点击歌词：切换到歌词页（保持向后兼容）。 */
  onPress?: () => void
  /** 外层样式（由竖屏封面页传入，含水平对齐）。 */
  style?: StyleProp<ViewStyle>
  /**
   * 竖屏布局推导传入的「小歌词区域可用高度」上限（pt）。
   * 竖屏侧只用「与 MiniLyric 自身高度无关」的量算出（页面容器实测高 R − 容器留白 −
   * SongInfo 实测高）：小歌词撑高自己不会反过来改这个上限，这是断开「行数 ⇄ 自身高度」
   * 闪烁反馈环的结构条件；旧口径（用「返回栏底边 → 信息栏顶边」那段区域，把小歌词自身
   * 高度也算了进去）会在阈值两侧 2 循环，观感就是持续闪烁。
   * 未传（首帧还没量到 / 老调用点）时用不依赖外部测量的保守上限兜底，
   * 保持旧行为（小屏只显示当前行）；**绝不能当成 0**，否则首帧塌陷。
   */
  maxHeight?: number
  /**
   * 外层为对齐而加在小歌词上的**水平内边距**（pt）。传进来后小歌词会把自己左右各外扩这么多，
   * 把 frame 顶到屏幕边缘 —— 手动定位浮层（绝对定位，左右 0）因此落在与大歌词完全相同的位置，
   * 虚线右端与大歌词一致地贴到右侧（用户点名的问题）；而歌词文本自身再内缩相同距离，
   * 文字左缘与歌名/歌手/专辑保持同一条竖线。
   * 不传（= 0）时几何与旧行为完全一致。
   */
  bleedH?: number
  /** 【第 173 轮】封面页是否为当前页：隐藏时不跑逐字 rAF / 换行跟随（不可见，纯耗电）。 */
  visible?: boolean
}

const MiniLyric = ({ onPress, style, maxHeight, bleedH = 0, visible = true }: MiniLyricProps) => {
  const theme = useTheme()
  const { line: engineLine } = useLrcPlay()
  const lyricLines = useLrcSet()
  const isPlay = useIsPlay()
  // 【第 197 轮】与大歌词同口径：暂停态（尤其冷启动恢复）优先按进度条换算当前行。
  // 引擎行可能还停在 0，小歌词会先按第 0 行排好、随后才跳回当前行 —— 用户看到的
  // 「闪小歌词开头」。这里让 activeLine 在挂载首帧就取进度条对应的行。
  const [pausedPosition, setPausedPosition] = useState(() => playerState.progress.nowPlayTime)
  useEffect(() => {
    if (isPlay) return
    setPausedPosition(playerState.progress.nowPlayTime)
    const handleProgress = (progress: { nowPlayTime: number }) => {
      setPausedPosition(progress.nowPlayTime)
    }
    global.state_event.on('playProgressChanged', handleProgress)
    return () => {
      global.state_event.off('playProgressChanged', handleProgress)
    }
  }, [isPlay])
  const activeLine = useMemo(() => {
    // 暂停态完全以进度条为准：引擎行会随「进入/返回详情页」的重锚而变化，
    // 拿它当暂停行会让小歌词在转场里上下跳，而进度条在暂停时是稳定值。
    if (isPlay) return engineLine
    if (!(pausedPosition > 0) || !lyricLines.length) return engineLine
    const fromProgress = findLineIndexByTime(lyricLines, pausedPosition * 1000)
    return fromProgress >= 0 ? fromProgress : engineLine
  }, [engineLine, isPlay, pausedPosition, lyricLines])
  const wordsByIndex = useLrcWordsMap()
  const textAlign = useSettingValue('playDetail.style.miniLyricAlign')
  // 小歌词逐字高亮（设置项）：关闭时整行高亮（当前行一种颜色、其余一种颜色）
  const isKaraoke = useSettingValue('playDetail.isMiniLyricKaraoke')
  // 【第 177 轮】详情页被评论 / 设置等压栈页盖住时，小歌词的逐字 rAF 也停掉；
  // 返回动画一开始（navReturning）就放行，避免高亮在转场里停在旧帧。
  const ids = useComponentIds()
  const navReturning = useNavReturning()
  const appActive = useAppActive()
  const pageOnTop = ids.length === 0 || String(ids[ids.length - 1]?.name) === COMPONENT_IDS.playDetail
  const karaokeVisible = pageOnTop || navReturning
  // 从后台回前台的首个跟随不要播滑动动画：后台期间行可能已经变了，
  // 回前台再滑一下会被看成小歌词「刷新/跳动」。首帧直接落位。
  const resumeInstantRef = useRef(false)
  const resumeInstantTimerRef = useRef<NodeJS.Timeout | null>(null)
  // 回前台/返回本屏后没有跨行时不会产生跟随，标志必须自然过期，
  // 否则下一次正常换行会被瞬跳掉。
  const armResumeInstant = useCallback(() => {
    resumeInstantRef.current = true
    if (resumeInstantTimerRef.current) clearTimeout(resumeInstantTimerRef.current)
    resumeInstantTimerRef.current = setTimeout(() => {
      resumeInstantTimerRef.current = null
      resumeInstantRef.current = false
    }, 500)
  }, [])
  const prevAppActiveRef = useRef(appActive)
  useEffect(() => {
    if (appActive && !prevAppActiveRef.current) armResumeInstant()
    prevAppActiveRef.current = appActive
  }, [appActive, armResumeInstant])
  // 从压栈页返回本屏同理：首个跟随直接落位，不播纵向滑动。
  const prevPageOnTopRef = useRef(pageOnTop)
  useEffect(() => {
    if (pageOnTop && !prevPageOnTopRef.current) armResumeInstant()
    prevPageOnTopRef.current = pageOnTop
  }, [pageOnTop, armResumeInstant])
  // 【第 171 轮】当前播放行缩放（1.0~1.5）：大歌词与小歌词共用同一个设置项。
  // 只动 transform（不改字号/行高/换行），围绕行中心缩放；过渡时长与「换行跟随」
  // 同源（LINE_CHANGE_GLIDE_MS），新旧两行同速交接。
  const lrcZoomSetting = useSettingValue('playDetail.vertical.style.lrcZoom')
  const zoom = Math.min(150, Math.max(100, lrcZoomSetting)) / 100
  const scaleValuesRef = useRef(new Map<number, Animated.Value>())
  const getLineScale = useCallback((index: number): Animated.Value => {
    let value = scaleValuesRef.current.get(index)
    if (value == null) {
      value = new Animated.Value(index === activeLine ? zoom : 1)
      scaleValuesRef.current.set(index, value)
    }
    return value
  }, [activeLine, zoom])
  // 初值不能用「当前行」：effect 首次运行会把 prev 行缩回 1、再把当前行放大到 zoom，
  // 于是每次进入播放详情页当前行都会白闪一次放大动画。用 -1 让首跑只对齐、
  // 不做「先回 1 再放大」的过渡。
  const prevActiveLineRef = useRef(-1)
  useEffect(() => {
    const prev = prevActiveLineRef.current
    prevActiveLineRef.current = activeLine
    const animate = (index: number, toValue: number) => {
      if (index < 0) return
      Animated.timing(getLineScale(index), {
        toValue,
        // 260ms 不变；曲线与换行滑行同为 easeInOutSine，起步/收尾的加速度更柔。
        duration: LINE_ZOOM_MS,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }).start()
    }
    animate(prev, 1)
    animate(activeLine, zoom)
  }, [activeLine, zoom, getLineScale])
  // 是否允许通过歌词手动定位（既有设置位：控制定位浮层的显隐）
  const isShowLyricProgress = useSettingValue('playDetail.isShowLyricProgressSetting')
  const { height: winHeight } = useWindowSize()

  const listRef = useRef<FlatList>(null)
  const playLineRef = useRef<PlayLineType>(null)
  // 滚动信息：拖动中每帧刷新；回位动画需要它做起点与边界钳制
  const scrollInfoRef = useRef<NativeSyntheticEvent<NativeScrollEvent>['nativeEvent'] | null>(null)
  // 手动定位态：拖动中或停手等待回位期间为 true，此期间不做自动跟随（列表归用户掌控）
  const isPauseScrollRef = useRef(false)
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const scrollCancelRef = useRef<(() => void) | null>(null)
  // 连续换行的速度接力：新一行在上一段滑行没结束时到来，起点速度沿用上一帧，
  // 不重新从 0 加速（否则快歌每行都「起步-停-起步」，观感生硬）。
  const animatedPositionRef = useRef<number | null>(null)
  const scrollVelocityRef = useRef(0)
  // 原生手势结束事件偶发丢失时，停手回位/浮层收起不能永久卡住。
  const isTouchingRef = useRef(false)
  const isMomentumRef = useRef(false)
  const pauseWatchdogRef = useRef<NodeJS.Timeout | null>(null)
  // 本组件正在以动画方式驱动列表滚动（回位 / 跟随滑行）：这段时间列表归动画所有 ——
  // 既不在 onScroll 里重新显示定位浮层（否则回位的路上浮层会重新冒出来），
  // 也不让「换行跟随」在回位动画没落地时插队（两条动画抢同一个 offset 就是二次回摆的来源）
  const isAutoScrollRef = useRef(false)
  // 上一次的窗口档位（三行 / 单行），只用于滞回判断，不参与渲染输出
  const rowCountRef = useRef<number | null>(null)
  // 本次拖动开始时的滚动偏移（判断「是否真的动过」，见 OVERLAY_SHOW_MOVE）
  const dragStartOffsetRef = useRef<number | null>(null)
  // 浮层当前是否已经显示（显示与否不在 state 里：拖动的每帧都不该让本组件重渲染）
  const isOverlayShownRef = useRef(false)
  // 【第 196 轮】小歌词点击改由容器统一识别：行内 Pressable 的 onPress 在原生手势
  // 竞争（PagerView / FlatList）下会被取消，导致「点了有概率没反应」。这里用触摸
  // 起点/终点自己判「短按且几乎没移动」，命中就切歌词页；拖动、长按、浮层操作都不算。
  const tapStartRef = useRef<{ x: number, y: number, at: number } | null>(null)
  // 【第 224 轮】Pressable 的 onPress 在 FlatList/PagerView 手势竞争下可能被取消；
  // onPressIn/onPressOut 仍会成对到达。用它们自己判一次短按，作为第三条切页通道。
  const pressStartRef = useRef<{ x: number, y: number, at: number } | null>(null)
  // 【第 225 轮】本次触摸期间小歌词列表是否真的开始拖动（上下滑动）：
  // 滑动开始时 FlatList 会发 onScrollBeginDrag，用它彻底取消本次点击判定。
  const scrollMovedRef = useRef(false)
  const tapMovedRef = useRef(false)
  const longPressFiredRef = useRef(false)
  const activeLineRef = useRef(activeLine)
  activeLineRef.current = activeLine
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  // 【第 236 轮】点击优先：滚动 / 回位 / 浮层状态一律让路，先清理再切页；
  // 同时短暂（250ms）停掉换行跟随，给 PagerView 的 setPage 命令让出 UI 队列。
  const pauseFollowUntilRef = useRef(0)
  const cancelScrollRef = useRef<() => void>(() => {})
  const startIdleTimerRef = useRef<() => void>(() => {})
  const handlePagerTap = useCallback((event?: any) => {
    if (isOverlayShownRef.current && event && typeof event.x === 'number' && typeof event.y === 'number' &&
        typeof event.w === 'number' && typeof event.h === 'number') {
      // 手动定位浮层的播放三角：保留 seek，不切页。
      if (event.x > event.w - 96 && Math.abs(event.y - event.h / 2) < 72) return
    }
    // 【第 238 轮】手动定位 / 回位态：点击算一次操作，重置 1.5s idle 计时（虚线保持），
    // 不碰回位动画、不隐藏浮层；自动跟随态才取消当前跟随动画给切页让路。
    if (isPauseScrollRef.current) startIdleTimerRef.current()
    else cancelScrollRef.current()
    pauseFollowUntilRef.current = Date.now() + 250
    onPress?.()
  }, [onPress])
  useEffect(() => {
    const sub = addPagerTapListener((event) => { handlePagerTap(event) })
    return () => sub.remove()
  }, [handlePagerTap])
  // 当前行强制单行显示：内容宽度实测值（用于判断是否溢出 + 横向滚动范围）。
  // 带行号，换行首帧不会拿上一行的宽度去算滚动范围。
  const [activeTextSize, setActiveTextSize] = useState<{ line: number, width: number }>({ line: -1, width: 0 })
  const activeTextWidth = activeTextSize.line === activeLine ? activeTextSize.width : 0
  // 行内播放进度（0~1）：由 KaraokeLyric 内部同一帧的 rAF 写入，不额外起循环。
  const activeScrollProgress = useRef(new Animated.Value(0)).current
  useLayoutEffect(() => {
    // 播放中不要先归零再让子组件的 rAF 补回来 —— 那一帧会把整行横向拨回行首，
    // 进详情页 / 从后台回来时就是用户看到的「小歌词闪一下刷新」。
    // KaraokeLyric 的 useLayoutEffect 会在同一帧写入真实进度；暂停时才由这里归零。
    if (playerState.isPlay) return
    activeScrollProgress.setValue(0)
  }, [activeLine, lyricLines, activeScrollProgress])

  // 三个尺寸常量（模块级 calcMetrics，与 getMiniLyricRowHeight 共享同一份算式）
  const metrics = useMemo(() => calcMetrics(), [])

  // 【第 16 轮第 8 条】恢复「以前」的行距口径：只有**当前行**挂翻译（重写前就是这样），
  // 其余行只占行盒 + 净间距。旧的「整首歌只要有翻译 ⇒ 每一行都预留翻译槽」会把没有翻译的
  // 行也撑到 48pt（22 行盒 + 4 + 18 翻译 + 4），两行主歌词之间空出一大截，观感就是
  // 「间距太大、还原以前的」——用户本轮的原话。
  // 现按行给高（rowHeights）：相邻文本之间的**净间距仍然恒为 gap**（第 2 轮「间距要相同」
  // 的要求不破），而窗口高度与行数定档仍按**最坏情况**算（见 worstRowHeight），
  // 块高与页面级布局不随歌词内容变化，不会引出整块跳动的老毛病。
  const songHasTranslation = useMemo(() => lyricLines.some(hasRealTranslation), [lyricLines])
  const translationSlot = metrics.translationHeight + metrics.gap
  const baseRowHeight = metrics.lineHeight + metrics.gap
  const worstRowHeight = baseRowHeight + (songHasTranslation ? translationSlot : 0)
  const rowHeights = useMemo(
    () => lyricLines.map((line, index) =>
      baseRowHeight +
      (index === activeLine && hasRealTranslation(line) ? translationSlot : 0),
    ),
    [lyricLines, activeLine, baseRowHeight, translationSlot],
  )
  // 每行在内容坐标系里的起点（前缀和）。滚动目标、getItemLayout、定位浮层三处同源，
  // 保证「虚线指向的行」=「列表居中行」=「滚动目标行」永远一致。
  const rowOffsets = useMemo(() => {
    let acc = 0
    return rowHeights.map((height) => {
      const offset = acc
      acc += height
      return offset
    })
  }, [rowHeights])

  // 可用高度上限：优先用竖屏布局传入的 maxHeight（竖屏侧由页面容器实测高推导，
  // 表达式中不含小歌词自身高度）；未传时退回到不依赖外部测量的保守上限 ——
  // 小屏只留当前行，大屏按三行窗口给满。
  // 注意这里不是 `?? 0`：首帧实测还没回来时若当成 0，整块会先塌陷再弹开。
  // 行数定档按最坏情况（有翻译的行）算：窗口高度必须在整首歌内保持恒定，
  // 不能一会儿按 26pt 行高定档、一会儿按 48pt 定档，否则换行时块高会跟着变。
  const limit = maxHeight ?? (winHeight < SMALL_WINDOW_HEIGHT ? worstRowHeight : worstRowHeight * FALLBACK_WINDOW_ROWS)

  // 档位（能放几行）必须断开「行数 → 自身高度 → 实测可用高度 → 行数」的自反馈环：
  // 旧口径的 maxHeight 把小歌词自身高度也算了进去（自己撑高后它反而变小），若在阈值上
  // 做硬判断，阈值附近就会 3 行 ↔ 4 行来回抖。竖屏侧现已改用与 MiniLyric 高度无关的量
  // 推导（见 VerticalNew 的 miniLyricMaxHeight），环从结构上断开；这里保留滞回
  //（Schmitt 触发器）作第二道保险：
  //   升档：新的一行真的放得下、还多出 hysteresis 才升；
  //   降档：连当前行数都放不下、且超出 hysteresis 才降。
  // 两个方向都要多走一个余量才切档 ⇒ 环路增益 < 1，不自激。
  // 用 ref（而不是 state）同步决定档位：每次渲染都按当前 limit 直接算出结果，
  // 不产生「先按旧档渲染一帧、再按新档重渲染」的中间帧 —— 中间帧本身就是一次抖动。
  const fitRows = Math.max(1, Math.min(MAX_WINDOW_ROWS, Math.floor(limit / worstRowHeight)))
  const hysteresis = Math.max(scaleSizeH(ROW_SWITCH_HYSTERESIS), 1)
  const prevRowCount = rowCountRef.current
  let rowCount: number
  if (prevRowCount == null) {
    rowCount = fitRows
  } else if (isPauseScrollRef.current) {
    // 手势进行中冻结档位；返回转场不在冻结档位之列（只跳过回中动画），
    // 否则窗口行数停在旧值会让内容错位、看起来像「歌词消失」。
    // 手势进行中（拖动 / 停手等待回位）冻结档位：此刻切档会连留白一起变，
    // 手指下正在定位的那一行会突然跳走。松手后的下一次渲染自然回到 fitRows。
    rowCount = prevRowCount
  } else if (fitRows > prevRowCount) {
    rowCount = limit >= (prevRowCount + 1) * worstRowHeight + hysteresis ? fitRows : prevRowCount
  } else if (fitRows < prevRowCount) {
    rowCount = limit < prevRowCount * worstRowHeight - hysteresis ? fitRows : prevRowCount
  } else {
    rowCount = fitRows
  }
  rowCountRef.current = rowCount
  // 块高恒定为 行数 × 最坏行高：行高逐行化之后它仍是一个与歌词内容无关的定值
  //（每行的实际高度见 rowHeights，当前行带翻译时那一行更高一些）。
  const containerHeight = rowCount * worstRowHeight
  // 上下留白按首行 / 末行各自的真实高度给：这样「行居中 ⇔ 滚动偏移 = 行中心 − 窗口中心」
  // 这条算式对第一行（偏移 0）和最后一行（撞底）也精确成立，不会偏半行。
  const topPadding = Math.max((containerHeight - (rowHeights[0] ?? baseRowHeight)) / 2, 0)
  const bottomPadding = Math.max((containerHeight - (rowHeights[rowHeights.length - 1] ?? baseRowHeight)) / 2, 0)

  // 把第 index 行滚到窗口正中：定高时代它就是 index × 行高，行高逐行化之后改成
  // 「该行垂直中心 − 窗口中心」（topPadding + 行前缀和 + 行高/2 − containerHeight/2），
  // 首行结果为 0（正好落在留白里），末行被 contentContainer 的下留白托住。
  const getScrollOffset = useCallback((index: number) => {
    const i = Math.min(Math.max(index, 0), Math.max(rowHeights.length - 1, 0))
    const height = rowHeights[i] ?? baseRowHeight
    const top = topPadding + (rowOffsets[i] ?? i * worstRowHeight)
    return Math.max(top + height / 2 - containerHeight / 2, 0)
  }, [rowHeights, rowOffsets, topPadding, containerHeight, baseRowHeight, worstRowHeight])

  // 歌词文本的左右内缩（pt，屏幕坐标系）：自己那份基准内缩 + 外层为对齐加的内边距
  // （外层内边距由根节点的负 margin 抵消掉了，文本要把它补回来，左缘才与歌名同一条竖线）
  const lineInsetH = useMemo(() => bleedH + scaleSizeW(BASE_LINE_INSET_H), [bleedH])
  // 【第 175 轮】列表宽度（量一次）：缩放锚点补偿按「文本可用宽度」算。
  const [listWidth, setListWidth] = useState(0)
  const lyricContentWidth = Math.max(0, listWidth - lineInsetH * 2)
  const alignmentSign = textAlign === 'left' ? 1 : textAlign === 'right' ? -1 : 0
  const shiftValuesRef = useRef(new Map<string, any>())
  const getLineShift = useCallback((index: number, scale: Animated.Value) => {
    // 居中：不需要补偿；居左/居右：把「居中缩放」推出去的那半段宽度补回来，
    // 锚点落在同侧边缘（RN 0.73 没有 transformOrigin）。
    // 【第 190 轮】激活行的排版宽度是 W/zoom（换行用），锚点补偿按这个块宽算：
    // 输出从「块宽缩放后与 W 的差」收回到 0，缩放全程贴住同侧边缘。
    if (!alignmentSign || lyricContentWidth <= 0) return null
    const wrapped = index === activeLine && zoom > 1
    const key = `${index}:${alignmentSign}:${lyricContentWidth}:${wrapped ? zoom : 1}`
    let value = shiftValuesRef.current.get(key)
    if (value == null) {
      value = wrapped
        ? scale.interpolate({
          inputRange: [1, zoom],
          outputRange: [alignmentSign * (lyricContentWidth / zoom - lyricContentWidth) / 2, 0],
        })
        : scale.interpolate({
          inputRange: [1, 1.5],
          outputRange: [0, alignmentSign * lyricContentWidth * 0.25],
        })
      shiftValuesRef.current.set(key, value)
    }
    return value
  }, [alignmentSign, lyricContentWidth, activeLine, zoom])

  const textStyle = useMemo<StyleProp<TextStyle>>(() => ({ textAlign, lineHeight: metrics.lineHeight }), [textAlign, metrics.lineHeight])
  const translationStyle = useMemo<StyleProp<TextStyle>>(
    () => ({ textAlign, lineHeight: metrics.translationHeight, marginTop: metrics.gap }),
    [textAlign, metrics],
  )

  const activeColor = theme.isDark ? theme['c-font'] : theme['c-primary']
  const inactiveColor = theme['c-font-label']

  // 取消进行中的定位动画（同一时刻只允许一条，避免多动画互相打架出现二次回摆）
  const cancelScroll = useCallback(() => {
    if (scrollCancelRef.current) {
      scrollCancelRef.current()
      scrollCancelRef.current = null
    }
    isAutoScrollRef.current = false
  }, [])
  cancelScrollRef.current = cancelScroll

  /**
   * 平滑滚动到第 index 行居中。
   *
   * 逐帧 rAF + `scrollToOffset({animated:false})`，与竖屏/横屏大歌词同一族实现：
   *   • 每帧落到「起点→终点」的**绝对**位置（不累加增量），因此没有累积误差、不会超调；
   *   • 帧率跟着屏幕刷新率走（120Hz 每帧都出一帧画面），不像 setTimeout(10ms) 那样与 vsync 错拍；
   *   • 起点与终点在启动前一次锁定，中途不重算 —— 这是「回位过程只朝一个方向走、
   *     不会先向上再向下」的结构性保证。
   * 先取消上一条动画；duration 不传时用 RETURN_TO_ACTIVE_MS（手动定位后的回位）。
   * 回位时长与竖屏大歌词的回位滑动同值同源 —— 用户报的 bug 就是这里以前按距离取
   * [120,300]（getReturnDuration），同屏一比小歌词"窜"得比大歌词快；两边必须同速。
   * onDone 在动画落地（或无需动画直接落位）后回调一次，任何路径都恰好回调一次。
   */
  const animateToLine = useCallback((index: number, duration?: number, onDone?: () => void) => {
    const list = listRef.current
    if (!list) {
      onDone?.()
      return
    }
    const offset = getScrollOffset(index)
    // 上一段滑行还没结束时的新目标：保留当前位置与速度，用 Hermite 接力；
    // 首段 / 手动回位仍走原来的 easeInOutSine，时长不变。
    const wasAuto = isAutoScrollRef.current
    const previousPosition = animatedPositionRef.current
    const previousVelocity = scrollVelocityRef.current
    cancelScroll()
    const from = wasAuto && previousPosition != null
      ? previousPosition
      : scrollInfoRef.current?.contentOffset.y
    const distance = from == null ? 0 : offset - from
    // 起点未知（还没滚动过 / 首帧）或位移小到看不见：直接落位，不播动画
    if (from == null || Math.abs(distance) < 1) {
      list.scrollToOffset({ offset, animated: false })
      lastScrollYRef.current = offset
      animatedPositionRef.current = offset
      scrollVelocityRef.current = 0
      onDone?.()
      return
    }
    const total = Math.max(duration ?? RETURN_TO_ACTIVE_MS, 1)
    // 速度换算到本次归一化时间轴：pt/s × total(s) = 整个动画的位移量级。
    const rawMomentum = wasAuto ? previousVelocity * total / 1000 : 0
    // 同向时限制在距离的 1.25 倍内，避免速度过大越过目标再弹回来。
    const momentum = Math.sign(rawMomentum) === Math.sign(distance)
      ? Math.sign(rawMomentum) * Math.min(Math.abs(rawMomentum), Math.abs(distance) * 1.25)
      : rawMomentum
    let rafId = 0
    let startTime = 0
    let lastTime = 0
    let lastValue = from
    const step = (now: number) => {
      if (!startTime) {
        startTime = now
        lastTime = now
      }
      const t = Math.min(1, (now - startTime) / total)
      let value: number
      if (momentum !== 0) {
        // 三次 Hermite：起点速度 = 上一帧速度，终点速度 = 0，位置和速度都连续。
        const t2 = t * t
        const t3 = t2 * t
        const h00 = 2 * t3 - 3 * t2 + 1
        const h10 = t3 - 2 * t2 + t
        const h01 = -2 * t3 + 3 * t2
        value = h00 * from + h10 * momentum + h01 * offset
      } else {
        // 【第 194 轮】easeInOutSine（与大歌词同一条曲线）：起停更柔，时长不变。
        const eased = easeInOutSine(t)
        value = from + distance * eased
      }
      list.scrollToOffset({ offset: value, animated: false })
      lastScrollYRef.current = value
      animatedPositionRef.current = value
      const dt = Math.max((now - lastTime) / 1000, 0.001)
      scrollVelocityRef.current = (value - lastValue) / dt
      lastTime = now
      lastValue = value
      if (t < 1) {
        rafId = requestAnimationFrame(step)
        return
      }
      rafId = 0
      scrollCancelRef.current = null
      isAutoScrollRef.current = false
      lastScrollYRef.current = offset
      animatedPositionRef.current = offset
      scrollVelocityRef.current = 0
      onDone?.()
    }
    isAutoScrollRef.current = true
    scrollCancelRef.current = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      isAutoScrollRef.current = false
    }
    rafId = requestAnimationFrame(step)
  }, [getScrollOffset, cancelScroll])

  // 播放行自动跟随：跨行距离很远（进度条 seek / 恢复播放）时直接落位，不做长距离快速滑动
  const followActiveLine = useCallback((index: number) => {
    // 【第 236 轮】点击切页后的 250ms 内不启动跟随动画，给 setPage 让路。
    if (Date.now() < pauseFollowUntilRef.current) return
    // 一次性消费首个跟随标志：任何分支都不留下悬空标志。
    const instant = resumeInstantRef.current
    resumeInstantRef.current = false
    if (resumeInstantTimerRef.current) {
      clearTimeout(resumeInstantTimerRef.current)
      resumeInstantTimerRef.current = null
    }
    // 【第 173 轮】封面页不可见（歌词页在前台）时不跑换行跟随动画（隐藏页里白烧帧）。
    // 但仍做一次无动画落位：切回封面页的第一帧就已经在当前行，不会先露顶部再跳。
    if (!visibleRef.current) {
      cancelScroll()
      listRef.current?.scrollToOffset({ offset: getScrollOffset(index), animated: false })
      return
    }
    const info = scrollInfoRef.current
    const offset = getScrollOffset(index)
    // 后台回前台的首个跟随直接落位，不播滑动动画（避免看起来像刷新/跳动）。
    if (instant) {
      cancelScroll()
      listRef.current?.scrollToOffset({ offset, animated: false })
      return
    }
    // 还没有过任何滚动信息 = 刚挂载 / 刚换歌，第一次定位必须无动画直接落位。
    // 旧写法在这里走 animateToLine，进入详情页（进度不在 0:00）时会看到小歌词
    // 从第 1 行往上滑一下——用户报的「短暂上跳、闪一下」。
    if (!info) {
      cancelScroll()
      listRef.current?.scrollToOffset({ offset, animated: false })
      return
    }
    if (Math.abs(offset - info.contentOffset.y) > worstRowHeight * FAR_JUMP_ROWS) {
      cancelScroll()
      listRef.current?.scrollToOffset({ offset, animated: false })
      return
    }
    // 【第 201 轮】换行跟随与大歌词同速：原来用小歌词自己的 200ms，比大歌词的
    // 400ms 快一截，同屏对比就是「小歌词窜、大歌词稳」。统一走默认 RETURN_TO_ACTIVE_MS。
    animateToLine(index)
  }, [animateToLine, getScrollOffset, worstRowHeight, cancelScroll])

  // 复位：歌词换了新的一份（切歌 / 歌词就绪 / 歌词源刷新）时立即（无动画）回到当前行，
  // 避免从上一次的滚动位置长距离滑过去。
  // 【第 22 轮】手动定位期间直接跳过、绝不抢滚动：用户报的「一滑动歌词，它会马上跳回原位置，
  // 特别快」「有时候一滑出去，就回来了」就是这里被换行触发后的后果（触发链见下面的 effect）。
  // 松手后的回位由 startIdleTimer 以 RETURN_TO_ACTIVE_MS 统一滑行完成，本函数不参与。
  const resetScroll = useCallback(() => {
    if (isPauseScrollRef.current) return
    dragStartOffsetRef.current = null
    isOverlayShownRef.current = false
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    cancelScroll()
    playLineRef.current?.setVisible(false)
    listRef.current?.scrollToOffset({ offset: getScrollOffset(activeLineRef.current), animated: false })
  }, [getScrollOffset, cancelScroll])

  // 歌词换行：把当前行滑到窗口正中（时长与其他歌词动效同源）
  const didInitFollowRef = useRef(false)
  useEffect(() => {
    if (activeLine < 0) return
    // 手动定位期间不跟随：否则用户刚拖到位就被自动跟随拽回去
    if (isPauseScrollRef.current) return
    // 首挂载的定位由 initialContentOffset / 布局阶段完成，commit 后再 follow 一次
    // 会在进入详情页时看到小歌词刷新一下。
    if (!didInitFollowRef.current) {
      didInitFollowRef.current = true
      return
    }
    followActiveLine(activeLine)
  }, [activeLine, followActiveLine])

  // 从歌词页切回封面页：隐藏期间不跟随，显形首帧必须已经落在当前行。
  // 这里用无动画落位而不是 followActiveLine：切页时任何可见的纵向滑动都会被看成「上下跳动」。
  const prevVisibleRef = useRef(visible)
  useEffect(() => {
    const wasVisible = prevVisibleRef.current
    prevVisibleRef.current = visible
    // 首挂载由 initialContentOffset 定位；这里只处理「隐藏 → 显形」的切换，
    // 否则 commit 后再滚一次会在进入详情页时可见地刷新一下。
    if (!visible || wasVisible) return
    // 从歌词页回来：上一屏的手动定位态/浮层/倒计时一律作废，回到自动跟随。
    isPauseScrollRef.current = false
    dragStartOffsetRef.current = null
    isOverlayShownRef.current = false
    playLineRef.current?.setVisible(false)
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    if (activeLineRef.current < 0) return
    cancelScroll()
    listRef.current?.scrollToOffset({ offset: getScrollOffset(activeLineRef.current), animated: false })
  }, [visible, getScrollOffset, cancelScroll])

  // 复位只在「歌词数组真的换了一份」时跑（useLrcSet 只在换歌 / 歌词就绪 / 歌词源刷新时换引用，
  // 换行不换引用）。【第 22 轮】依赖刻意走 ref、只写 [lyricLines]：resetScroll 的依赖链里有
  // 活跃行（rowHeights → rowOffsets → getScrollOffset → resetScroll，每次歌词换行都重建引用），
  // 以前写成 [lyricLines, resetScroll] 等于「每次换行都复位一次」——那次复位会取消刚起步的
  // 换行滑行（followActiveLine）、把列表瞬跳（animated:false）回当前行，用户看到的就是
  // 「歌词换行过程中速度特别快」。这条 effect 从此只在整份歌词变更时跑。
  const resetScrollRef = useRef(resetScroll)
  resetScrollRef.current = resetScroll
  // 首挂载已经由 initialContentOffset 定位；再在 commit 后滚一次会在页面上可见地
  // 「刷新一下」。只在歌词确实换了一份时复位。
  const didInitResetScrollRef = useRef(false)
  useEffect(() => {
    if (!didInitResetScrollRef.current) {
      didInitResetScrollRef.current = true
      return
    }
    resetScrollRef.current()
  }, [lyricLines])

  // 行高/留白变化（转屏、翻译行出现）与歌词变化时，同步给定位浮层：
  // 浮层按「留白 + 逐行行高」累计算出虚线指向的行，必须与列表的实际几何一致。
  useEffect(() => {
    playLineRef.current?.updateLyricLines(lyricLines)
    playLineRef.current?.updateLayoutInfo({
      spaceHeight: topPadding,
      lineHeights: rowHeights,
    })
  }, [lyricLines, rowHeights, topPadding])

  useEffect(() => () => {
    // 卸载时清掉定时器与动画，避免对已卸载的列表做 scrollToOffset
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    if (resumeInstantTimerRef.current) {
      clearTimeout(resumeInstantTimerRef.current)
      resumeInstantTimerRef.current = null
    }
    cancelScroll()
  }, [cancelScroll])

  // 停手 IDLE_RETURN_MS 后：隐藏浮层并平滑回位到当前播放行。
  // 这里**不写** `if (!isPlay) return`（旧大歌词的守卫）：暂停状态下也要回位，
  // 否则用户暂停时拖走歌词就再也回不来了。
  const startIdleTimer = useCallback(() => {
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current)
    scrollTimeoutRef.current = setTimeout(() => {
      scrollTimeoutRef.current = null
      isOverlayShownRef.current = false
      playLineRef.current?.setVisible(false)
      const target = Math.max(0, activeLineRef.current)
      // 回位动画期间继续扣住 isPauseScrollRef：否则「换行跟随」的 effect 会在回位没落地时插队，
      // 两条动画抢同一个滚动偏移，观感就是先朝一个方向窜一下、再慢慢沉回去。
      // 落地后再解除锁定；期间若歌曲已经换行（target 已过期），补一次跟随。
      animateToLine(target, undefined, () => {
        isPauseScrollRef.current = false
        const now = Math.max(0, activeLineRef.current)
        if (now !== target) followActiveLine(now)
      })
    }, IDLE_RETURN_MS)
  }, [animateToLine, followActiveLine])
  startIdleTimerRef.current = startIdleTimer

  const clearPauseWatchdog = useCallback(() => {
    if (!pauseWatchdogRef.current) return
    clearTimeout(pauseWatchdogRef.current)
    pauseWatchdogRef.current = null
  }, [])
  // 结束拖动事件丢失时，stop 态可能永久停在「手动定位」，表现为再也不自动跟回当前进度。
  // 手指已经抬起 + 超过 IDLE_RETURN_MS+1s 仍无收尾，就强制走一次与正常停手相同的回位。
  const armPauseWatchdogRef = useRef<() => void>(() => {})
  const armPauseWatchdog = useCallback(() => {
    clearPauseWatchdog()
    pauseWatchdogRef.current = setTimeout(() => {
      pauseWatchdogRef.current = null
      if (!isPauseScrollRef.current) return
      if (isTouchingRef.current || isMomentumRef.current) {
        armPauseWatchdogRef.current()
        return
      }
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
        scrollTimeoutRef.current = null
      }
      dragStartOffsetRef.current = null
      isOverlayShownRef.current = false
      playLineRef.current?.setVisible(false)
      const target = Math.max(0, activeLineRef.current)
      animateToLine(target, undefined, () => {
        isPauseScrollRef.current = false
        const now = Math.max(0, activeLineRef.current)
        if (now !== target) followActiveLine(now)
      })
    }, IDLE_RETURN_MS + 1000)
  }, [animateToLine, clearPauseWatchdog, followActiveLine])
  armPauseWatchdogRef.current = armPauseWatchdog
  useEffect(() => clearPauseWatchdog, [clearPauseWatchdog])

  const handleScrollBeginDrag = useCallback(() => {
    // 【第 225 轮】上下滑动 ≠ 点击：本次触摸已进入列表拖动，后续任何 onPress/onPressOut/
    // onTouchEnd 都不再触发切页。
    scrollMovedRef.current = true
    isPauseScrollRef.current = true
    isMomentumRef.current = false
    // 先记账、先不显示：等真的动了再显示浮层（横向翻页时列表位移为 0，不该闪浮层）
    dragStartOffsetRef.current = scrollInfoRef.current?.contentOffset.y ?? lastScrollYRef.current
    isOverlayShownRef.current = false
    // 按下这一刻同步一次浮层的数据源：从压栈页/歌词页切回来时，行高与歌词表可能
    // 还没来得及通过 effect 推给浮层，避免「第一次滑动没有虚线」。
    playLineRef.current?.updateLyricLines(lyricLines)
    playLineRef.current?.updateLayoutInfo({ spaceHeight: topPadding, lineHeights: rowHeights })
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    armPauseWatchdog()
    cancelScroll()
  }, [armPauseWatchdog, cancelScroll, lyricLines, rowHeights, topPadding])

  // 长按同样进入定位态（拖动之外的第二条入口，任务书要求）：
  // 位置基准线仍由列表的滚动信息算出，而「一直没滚动过」时它是空的，故先补一次亚像素位移。
  const handleLongPress = useCallback(() => {
    const list = listRef.current
    if (!list) return
    // 长按已经进入定位态：松手时容器点击判定必须放行，不能把这次长按当成点击切页。
    longPressFiredRef.current = true
    isPauseScrollRef.current = true
    dragStartOffsetRef.current = null
    isOverlayShownRef.current = true
    cancelScroll()
    playLineRef.current?.setVisible(true)
    if (!scrollInfoRef.current) {
      list.scrollToOffset({ offset: getScrollOffset(activeLineRef.current) + SCROLL_NUDGE, animated: false })
    }
    // 松手后不动也会自动收起浮层并回位（回位目标就是当前播放行，位移 = 上面那半个像素）
    startIdleTimer()
  }, [cancelScroll, getScrollOffset, startIdleTimer])

  const handleScroll = useCallback(({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollInfoRef.current = nativeEvent
    lastScrollYRef.current = nativeEvent.contentOffset.y
    // 动画驱动滚动期间不重开定位态：否则回位的路上浮层会重新冒出来、且每帧都在更新它
    if (isAutoScrollRef.current) return
    if (!isPauseScrollRef.current) return
    // 首帧滚动信息可能到这一步才拿到，补一次起始位移
    if (dragStartOffsetRef.current == null) dragStartOffsetRef.current = nativeEvent.contentOffset.y
    if (!isOverlayShownRef.current) {
      if (Math.abs(nativeEvent.contentOffset.y - dragStartOffsetRef.current) < OVERLAY_SHOW_MOVE) return
      isOverlayShownRef.current = true
      playLineRef.current?.setVisible(true)
    }
    // 仅手动定位期间更新浮层：自动跟随的滚动过程浮层是隐藏的，不需要每帧重渲染
    playLineRef.current?.updateScrollInfo(nativeEvent)
  }, [])

  const hasDragMoved = useCallback(() => {
    const start = dragStartOffsetRef.current
    const y = scrollInfoRef.current?.contentOffset.y ?? lastScrollYRef.current
    return start != null && Math.abs(y - start) > 0.5
  }, [])
  const releasePauseWithoutMotion = useCallback(() => {
    isPauseScrollRef.current = false
    dragStartOffsetRef.current = null
    isOverlayShownRef.current = false
    playLineRef.current?.setVisible(false)
  }, [])
  const handleScrollEndDrag = useCallback(() => {
    if (!isPauseScrollRef.current) return
    // 即使位移不到浮层阈值（短距离拖动），只要列表确实动过也必须回位。
    if (!hasDragMoved()) {
      releasePauseWithoutMotion()
      return
    }
    startIdleTimer()
  }, [hasDragMoved, releasePauseWithoutMotion, startIdleTimer])

  const handleMomentumScrollBegin = useCallback(() => {
    isMomentumRef.current = true
    // 惯性还在跑时不能开始回位倒计时，否则回位和惯性会抢同一个偏移（上下抖动）。
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
  }, [])

  const handleMomentumScrollEnd = useCallback(() => {
    isMomentumRef.current = false
    if (!isPauseScrollRef.current) return
    if (!hasDragMoved()) {
      releasePauseWithoutMotion()
      return
    }
    // 惯性滚动结束才算真正「停手」：重新计时，避免惯性还没停就触发回位。
    startIdleTimer()
  }, [hasDragMoved, releasePauseWithoutMotion, startIdleTimer])

  // 内容尺寸变化：以前直接挂 resetScroll —— 当前行带上 / 摘下翻译槽时内容总高**每次换行都会变**，
  // 于是每次换行都白跑一次「瞬跳 + 取消刚起步的换行滑行」，这正是用户报的「换行过程中速度快」的
  // 第二条入口（第一条是上面那条 effect 的依赖抖动）。现在只有**窗口高度本身**变了才同步一次
  //（转屏、行数定档变化这类整体几何变化），换行引起的行高变化交给 followActiveLine 的滑行动画；
  // 手动定位期间一律不抢滚动（与 resetScroll 同一条纪律）。
  const sizeHandledHeightRef = useRef(containerHeight)
  const handleContentSizeChange = useCallback(() => {
    if (sizeHandledHeightRef.current === containerHeight) return
    sizeHandledHeightRef.current = containerHeight
    if (isPauseScrollRef.current) return
    cancelScroll()
    listRef.current?.scrollToOffset({ offset: getScrollOffset(activeLineRef.current), animated: false })
  }, [containerHeight, getScrollOffset, cancelScroll])

  // 【用户第 60 轮】首帧对齐（与进度条同步）：resetScroll 在挂载那一帧可能早于列表量出
  // 内容尺寸，scrollToOffset 被钳回 0 —— 小歌词停在第 1 行，进度却早就不是 0:00；
  // 切到歌词页时才跳到当前行，看起来就是「小歌词上跳一下」。这里在歌词换引用后的下一帧
  // 再补一次无动画对齐（rAF 让原生滚动的 contentSize 先落地）。
  const getScrollOffsetRef = useRef(getScrollOffset)
  getScrollOffsetRef.current = getScrollOffset
  // 首帧定位：播放中直接取引擎行（进度条是 1Hz，可能落后一行，先按进度条定位会在
  // 下一帧被 useLayoutEffect 拉回引擎行，表现为进详情页时小歌词「闪一下」）；
  // 暂停态才用进度条换算。挂载时直接给 FlatList 居中的初始 contentOffset。
  const initialLineRef = useRef<number | null>(null)
  if (initialLineRef.current == null) {
    if (playerState.isPlay) {
      initialLineRef.current = Math.max(0, activeLine)
    } else {
      const seconds = playerState.progress.nowPlayTime
      const fromProgress = lyricLines.length && Number.isFinite(seconds)
        ? findLineIndexByTime(lyricLines, Math.max(0, seconds) * 1000)
        : -1
      initialLineRef.current = fromProgress >= 0 ? fromProgress : Math.max(0, activeLine)
    }
  }
  const initialContentOffset = useMemo(() => ({
    x: 0,
    y: getScrollOffsetRef.current(initialLineRef.current as number),
  }), [])
  // 最后一次已知偏移：首帧 onScroll 之前也用它给手动拖动的起点，短距离拖动才量得准。
  const lastScrollYRef = useRef(initialContentOffset.y)
  const hadLyricsAtMountRef = useRef(lyricLines.length > 0)
  const didInitLyricScrollRef = useRef(false)
  const mountedOnceRef = useRef(false)
  useEffect(() => {
    if (!lyricLines.length) return
    if (!didInitLyricScrollRef.current) {
      didInitLyricScrollRef.current = true
      // 首挂载已有歌词：initialContentOffset 已定位，rAF 再滚一次会可见地刷新一下。
      if (hadLyricsAtMountRef.current) return
    }
    let raf = requestAnimationFrame(() => {
      if (isPauseScrollRef.current) return
      listRef.current?.scrollToOffset({ offset: getScrollOffsetRef.current(activeLineRef.current), animated: false })
    })
    return () => cancelAnimationFrame(raf)
  }, [lyricLines])

  // 【用户第 60 轮·实时显示】进入详情页 / 从歌词页切回封面页时，直接按**进度条当前时间**
  // 重锚歌词引擎，并把小歌词定位到对应行 —— 大小歌词共用同一个引擎，这样两边从第一帧起
  // 就与进度条显示同一行（此前只有大歌词页在激活时按进度重锚，小歌词用的是引擎旧行，
  // 切页时才被拉过去，出现「上跳一下」）。
  useLayoutEffect(() => {
    const isFirstCommit = !mountedOnceRef.current
    mountedOnceRef.current = true
    if (!visible) return
    // 首挂载已有歌词：initialContentOffset 已经给出了正确的首帧位置，这里再滚一次
    // 会在布局阶段触发一次原生 scrollTo，观感就是小歌词「刷新一下」。
    const skipScroll = isFirstCommit && hadLyricsAtMountRef.current
    const seconds = playerState.progress.nowPlayTime
    const hasSeconds = Number.isFinite(seconds) && seconds >= 0
    const targetLine = hasSeconds && lyricLines.length
      ? findLineIndexByTime(lyricLines, Math.max(0, seconds) * 1000)
      : -1
    // 只有「暂停 / 恢复」态才以进度条为准重锚。播放中进度条是 1Hz 轮询、可能落后引擎一行，
    // 拿它重锚会把行往回翻 —— 当前行的缩放动画因此每次切画面都重播一次。
    if (!playerState.isPlay && targetLine >= 0 && targetLine !== activeLineRef.current) {
      try { lrcAnchorToTime(Math.max(0, seconds) * 1000, false) } catch {}
    }
    const scrollLine = playerState.isPlay
      ? activeLineRef.current
      : (targetLine >= 0 ? targetLine : activeLineRef.current)
    if (!skipScroll && !isPauseScrollRef.current) {
      // 布局阶段直接落位（不等下一帧）：配合初始 contentOffset，切换瞬间不会先露第 1 行。
      listRef.current?.scrollToOffset({ offset: getScrollOffsetRef.current(scrollLine), animated: false })
    }
  }, [visible, lyricLines])

  const handlePlayLine = useCallback((time: number) => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    isPauseScrollRef.current = false
    dragStartOffsetRef.current = null
    isOverlayShownRef.current = false
    playLineRef.current?.setVisible(false)
    // 目标时间若等于/超过歌曲总时长，会被当作「已播放到结尾」而直接切下一首，
    // 这里收回到总长之前一小段（与 REF 同源，防误跳歌）
    const maxTime = playerState.progress.maxPlayTime
    if (maxTime > 0 && time >= maxTime) time = Math.max(maxTime - 0.5, 0)
    // 只 seek：歌词行跟引擎事件走，落点出声后由上面的「换行跟随」把该行滑到正中。
    // 这里**不**提前滚动到当前行，避免「先滚回旧行、再滑向新行」的二次动画。
    global.app_event.setProgress(time)
  }, [])

  // 行内 Pressable 的 onPress 仍保留作为第二条通道：容器触摸判定与 Pressable 是两套
  // 独立的事件路径，任一条能到达就能切页（重复请求 requestPage 是幂等的）。
  const handlePress = useCallback(() => {
    if (scrollMovedRef.current) return
    onPress?.()
  }, [onPress])

  // 容器级点击判定：短按 + 位移 < 8pt 才算点击；拖动、长按由标记排除。
  const handleTapStart = useCallback((e: any) => {
    const { pageX, pageY } = e.nativeEvent
    isTouchingRef.current = true
    tapStartRef.current = { x: pageX, y: pageY, at: Date.now() }
    tapMovedRef.current = false
    longPressFiredRef.current = false
    scrollMovedRef.current = false
  }, [])
  const handleTapMove = useCallback((e: any) => {
    const s = tapStartRef.current
    if (!s) return
    if (Math.abs(e.nativeEvent.pageX - s.x) > 8 || Math.abs(e.nativeEvent.pageY - s.y) > 8) {
      tapMovedRef.current = true
    }
  }, [])
  const handleTapEnd = useCallback((e: any) => {
    isTouchingRef.current = false
    const s = tapStartRef.current
    tapStartRef.current = null
    if (!s || scrollMovedRef.current || tapMovedRef.current || longPressFiredRef.current) return
    if (Date.now() - s.at > 350) return
    // 松手位置再判一次：move 事件被 FlatList 抢走时 tapMovedRef 不会更新。
    const { pageX, pageY } = e.nativeEvent
    if (Math.abs(pageX - s.x) > 10 || Math.abs(pageY - s.y) > 10) return
    // 不再用 isPauseScrollRef / isOverlayShownRef 做总闸：这两个状态一旦卡住就会让
    // 「连续点击都没反应」永久化。浮层三角自己的触摸会 stopPropagation（见 PlayLine），
    // 拖动/长按由上面的位移与 longPress 标记排除。
    onPress?.()
  }, [onPress])
  const handleTapCancel = useCallback(() => {
    isTouchingRef.current = false
    tapStartRef.current = null
  }, [])

  const renderItem = useCallback(({ item, index }: { item: Line, index: number }) => {
    const isActive = index === activeLine
    const words = wordsByIndex[index] ?? null
    // 该行的结束时间 = 下一行的起始时间（末行没有下一行时给一个固定时长兜底）
    const endTime = lyricLines[index + 1]?.time ?? item.time + 4000
    // 激活行放大后要铺满原宽：按 W/zoom 排版；非激活行保持原宽。
    const rowWidth = lyricContentWidth > 0
      ? (isActive && zoom > 1 ? lyricContentWidth / zoom : lyricContentWidth)
      : 0
    const canScroll = isActive && rowWidth > 0 && activeTextWidth > rowWidth + 1
    const contentWidth = canScroll ? activeTextWidth : rowWidth
    const scrollX = canScroll
      ? activeScrollProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, -(activeTextWidth - rowWidth)],
      })
      : undefined
    return (
      <Pressable
        // 行高逐行化（第 16 轮第 8 条）：当前行带翻译时这一行更高，其余行只占行盒 + 净间距
        style={[styles.line, { height: rowHeights[index] ?? baseRowHeight }]}
        // 三通道：行内 onPress、onPressOut 自判短按、容器 handleTapEnd，任一生效都能切页；
        // 长按进入定位态（长按后 onPressOut 不再触发切页）。
        onPress={handlePress}
        onPressIn={(e) => {
          scrollMovedRef.current = false
          pressStartRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, at: Date.now() }
        }}
        onPressOut={(e) => {
          const s = pressStartRef.current
          pressStartRef.current = null
          if (!s || scrollMovedRef.current || longPressFiredRef.current) return
          if (Date.now() - s.at > 350) return
          if (Math.abs(e.nativeEvent.pageX - s.x) > 10 || Math.abs(e.nativeEvent.pageY - s.y) > 10) return
          handlePress()
        }}
        onLongPress={handleLongPress}
        // 【第 194 轮】「点小歌词偶尔没反应」的兜底：
        // ① 长按阈值 500 → 650ms：慢一点点按仍算点击，不会先被判成长按（长按不会触发 onPress）；
        // ② 放宽手指允许的偏移，轻微抖动不会被 FlatList 的滚动手势吃掉。
        delayLongPress={650}
        pressRetentionOffset={{ top: 14, bottom: 14, left: 18, right: 18 }}
        accessibilityRole="button"
        accessibilityLabel={item.text || undefined}
      >
        <Animated.View
          style={[
            {
              transform: getLineShift(index, getLineScale(index))
                ? [{ translateX: getLineShift(index, getLineScale(index)) }, { scale: getLineScale(index) }]
                : [{ scale: getLineScale(index) }],
              alignSelf: 'center',
            },
            rowWidth > 0 ? { width: rowWidth } : null,
          ]}
        >
        {
          isActive ? (
            <View style={styles.activeLineClip}>
              <Animated.View style={{ width: contentWidth, transform: scrollX ? [{ translateX: scrollX }] : undefined }}>
                <KaraokeLyric
                  words={words}
                  lineTime={item.time}
                  text={item.text}
                  startTime={item.time}
                  endTime={endTime}
                  size={BASE_FONT_SIZE}
                  style={textStyle}
                  isActive={visible && karaokeVisible}
                  numberOfLines={1}
                  // 不溢出的一行不做横向滚动：不传进度值，省掉每帧一次 Animated 写入。
                  scrollProgress={canScroll ? activeScrollProgress : undefined}
                  intrinsicWidth={canScroll}
                  // 关闭逐字高亮时两色相同，逐字 rAF 输出不可见：停帧省电。
                  animated={isKaraoke}
                  playedColor={activeColor}
                  inactiveColor={isKaraoke ? inactiveColor : activeColor}
                />
              </Animated.View>
              <View pointerEvents="none" style={styles.measureWrap}>
                <Text
                  size={BASE_FONT_SIZE}
                  style={[textStyle, styles.measureText]}
                  numberOfLines={1}
                  onLayout={({ nativeEvent }: LayoutChangeEvent) => {
                    const w = Math.round(nativeEvent.layout.width)
                    setActiveTextSize(prev => prev.line === index && prev.width === w ? prev : { line: index, width: w })
                  }}
                >
                  {item.text || BLANK}
                </Text>
              </View>
            </View>
          ) : (
            <Text
              size={BASE_FONT_SIZE}
              color={inactiveColor}
              style={textStyle}
              numberOfLines={1}
            >
              {item.text || BLANK}
            </Text>
          )
        }
        {// 【第 16 轮第 8 条】只有当前行挂翻译（与重写前一致）：行高与内容一一对应，
        // 不会再出现「整首歌有翻译 ⇒ 每一行都空出一个看不见的翻译槽」的大间距
        isActive && hasRealTranslation(item) && (
          <Text
            size={TRANSLATION_FONT_SIZE}
            color={activeColor}
            style={translationStyle}
            numberOfLines={1}
          >
            {item.extendedLyrics?.[0] || BLANK}
          </Text>
        )}
        </Animated.View>
      </Pressable>
    )
  }, [activeLine, wordsByIndex, lyricLines, isKaraoke, baseRowHeight, rowHeights, textStyle, translationStyle, activeColor, inactiveColor, handlePress, handleLongPress, getLineScale, getLineShift, visible, karaokeVisible, zoom, lyricContentWidth, activeTextWidth, activeScrollProgress])

  const getKey = useCallback((_item: Line, index: number) => `${index}`, [])
  // 定高行：getItemLayout 精确（不需要像大歌词那样动态测量），虚拟化窗口与滚动目标都以它为准
  const getItemLayout = useCallback((_data: unknown, index: number) => ({
    length: rowHeights[index] ?? baseRowHeight,
    offset: topPadding + (rowOffsets[index] ?? index * worstRowHeight),
    index,
  }), [rowHeights, rowOffsets, topPadding, baseRowHeight, worstRowHeight])

  return (
    // marginHorizontal: -bleedH 把小歌词的 frame 左右各外扩 bleedH，顶到屏幕边缘 ——
    // 根节点自己不再带左右内边距，于是绝对定位的定位浮层（left/right 0）与大歌词一样贴到屏幕边：
    // 虚线右端、播放三角离右缘的距离与大歌词完全一致（用户点名的问题）。
    // 文本内缩改由列表的 contentContainerStyle 承担（见 lineInsetH），文字位置不变。
    <PagerTapView
      style={[styles.container, { height: containerHeight, marginHorizontal: -bleedH }, style]}
      // 容器级触摸判定：短按切歌词页（行内 Pressable 在原生手势竞争下会丢 onPress）。
      onTouchStart={handleTapStart}
      onTouchMove={handleTapMove}
      onTouchEnd={handleTapEnd}
      onTouchCancel={handleTapCancel}
    >
      <FlatList
        ref={listRef}
        data={lyricLines}
        renderItem={renderItem}
        keyExtractor={getKey}
        getItemLayout={getItemLayout}
        // 首帧就停在当前播放行（居中）：进入详情页时不会先露开头再跳。
        // 用精确 contentOffset（initialScrollIndex 只能把行顶到顶部，不是居中位）。
        contentOffset={initialContentOffset}
        style={styles.list}
        // 【第 175 轮】量一次列表宽度：缩放锚点补偿按「文本可用宽度」算。
        onLayout={({ nativeEvent }) => {
          const w = Math.round(nativeEvent.layout.width)
          if (w > 0) setListWidth(prev => prev === w ? prev : w)
        }}
        // 上下留白按首行/末行真实高度给：行号 i 居中 ⇔ 滚动偏移 = 该行中心 − 窗口中心
        //（见 getScrollOffset），定位浮层的基准线（容器 50%）因此永远压在窗口正中那一行上。
        // 左右内缩放在 contentContainer（而不是容器 padding）上：容器 padding 会把
        // 绝对定位的浮层一起缩进去，而列表内容的左右留白与滚动偏移（纵向）无关。
        contentContainerStyle={{ paddingTop: topPadding, paddingBottom: bottomPadding, paddingHorizontal: lineInsetH }}
        showsVerticalScrollIndicator={false}
        // 上下限不做弹性回弹：越界惯性会把「停手 1.5s 后回位」拖长，也容易和回位动画抢偏移。
        bounces={false}
        alwaysBounceVertical={false}
        overScrollMode="never"
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollBegin={handleMomentumScrollBegin}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        onContentSizeChange={handleContentSizeChange}
        // 行高固定，不需要为动态测量保留屏幕外的行；但 iOS 上开启回收会出现整行空白，故关闭
        removeClippedSubviews={false}
      />
      {
        // 手动定位浮层：虚线压在容器正中（= 当前居中行的垂直中心），拖动时歌词实时跟随
        isShowLyricProgress ? (
          <PlayLine ref={playLineRef} topPercent={0.5} onPlayLine={handlePlayLine} />
        ) : null
      }
    </PagerTapView>
  )
}

const styles = createStyle({
  container: {
    // 左右内边距必须为 0：定位浮层是绝对定位（left/right 0），父容器的内边距会把
    // 虚线连带播放三角一起缩进去 —— 用户点名「虚线和播放图标离最右侧太远」就是这个。
    // 文本的左右留白挪到了列表的 contentContainerStyle（见 lineInsetH），两者互不影响。
    // 高度由定高窗口算出，任何内容变化都不改变它
    overflow: 'hidden',
  },
  list: {
    // flex:1 是必需的：滚动容器的自测高会等于「内容总高」（整首歌词），
    // 那样它的视口 = 内容高，既滚不动、layoutMeasurement 也是错的（定位浮层要靠它算基准线）。
    // 父容器高度已由定高窗口写死，flex:1 让列表正好等于这个高度。
    flex: 1,
    // 铺满父容器宽度（父级的 alignItems 只影响水平对齐，不应把列表压成内容宽）
    alignSelf: 'stretch',
  },
  line: {
    justifyContent: 'center',
    alignItems: 'stretch',
  },
  activeLineClip: {
    width: '100%',
    overflow: 'hidden',
  },
  measureWrap: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 10000,
    flexDirection: 'row',
    opacity: 0,
  },
  measureText: {
    flexShrink: 0,
    textAlign: 'left',
  },
})

export default memo(MiniLyric)
