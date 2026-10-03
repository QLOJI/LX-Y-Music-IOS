import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  FlatList,
  Pressable,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  View,
} from 'react-native'
import Text from '@/components/common/Text'
import KaraokeLyric from './KaraokeLyric'
import PlayLine, { type PlayLineType } from './PlayLine'
import { type Line, useLrcPlay, useLrcSet, useLrcWordsMap } from '@/plugins/lyric'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { scaleSizeH, scaleSizeW, setSpText } from '@/utils/pixelRatio'
import { useWindowSize } from '@/utils/hooks'
import playerState from '@/store/player/state'
import { IDLE_RETURN_MS, LINE_CHANGE_GLIDE_MS, RETURN_TO_ACTIVE_MS } from '@/screens/PlayDetail/lyricAnimation'

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
}

const MiniLyric = ({ onPress, style, maxHeight, bleedH = 0 }: MiniLyricProps) => {
  const theme = useTheme()
  const { line: activeLine } = useLrcPlay()
  const lyricLines = useLrcSet()
  const wordsByIndex = useLrcWordsMap()
  const textAlign = useSettingValue('playDetail.style.miniLyricAlign')
  // 小歌词逐字高亮（设置项）：关闭时整行高亮（当前行一种颜色、其余一种颜色）
  const isKaraoke = useSettingValue('playDetail.isMiniLyricKaraoke')
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
  const activeLineRef = useRef(activeLine)
  activeLineRef.current = activeLine

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
      baseRowHeight + (index === activeLine && hasRealTranslation(line) ? translationSlot : 0),
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
    cancelScroll()
    const from = scrollInfoRef.current?.contentOffset.y
    const distance = from == null ? 0 : offset - from
    // 起点未知（还没滚动过 / 首帧）或位移小到看不见：直接落位，不播动画
    if (from == null || Math.abs(distance) < 1) {
      list.scrollToOffset({ offset, animated: false })
      onDone?.()
      return
    }
    const total = Math.max(duration ?? RETURN_TO_ACTIVE_MS, 1)
    let rafId = 0
    let startTime = 0
    const step = (now: number) => {
      if (!startTime) startTime = now
      const t = Math.min(1, (now - startTime) / total)
      // easeInOutQuad（与大歌词同一条曲线）
      const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2
      list.scrollToOffset({ offset: from + distance * eased, animated: false })
      if (t < 1) {
        rafId = requestAnimationFrame(step)
        return
      }
      rafId = 0
      scrollCancelRef.current = null
      isAutoScrollRef.current = false
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
    const info = scrollInfoRef.current
    const offset = getScrollOffset(index)
    if (info && Math.abs(offset - info.contentOffset.y) > worstRowHeight * FAR_JUMP_ROWS) {
      cancelScroll()
      listRef.current?.scrollToOffset({ offset, animated: false })
      return
    }
    animateToLine(index, LINE_CHANGE_GLIDE_MS)
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
  useEffect(() => {
    if (activeLine < 0) return
    // 手动定位期间不跟随：否则用户刚拖到位就被自动跟随拽回去
    if (isPauseScrollRef.current) return
    followActiveLine(activeLine)
  }, [activeLine, followActiveLine])

  // 复位只在「歌词数组真的换了一份」时跑（useLrcSet 只在换歌 / 歌词就绪 / 歌词源刷新时换引用，
  // 换行不换引用）。【第 22 轮】依赖刻意走 ref、只写 [lyricLines]：resetScroll 的依赖链里有
  // 活跃行（rowHeights → rowOffsets → getScrollOffset → resetScroll，每次歌词换行都重建引用），
  // 以前写成 [lyricLines, resetScroll] 等于「每次换行都复位一次」——那次复位会取消刚起步的
  // 换行滑行（followActiveLine）、把列表瞬跳（animated:false）回当前行，用户看到的就是
  // 「歌词换行过程中速度特别快」。这条 effect 从此只在整份歌词变更时跑。
  const resetScrollRef = useRef(resetScroll)
  resetScrollRef.current = resetScroll
  useEffect(() => {
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

  const handleScrollBeginDrag = useCallback(() => {
    isPauseScrollRef.current = true
    // 先记账、先不显示：等真的动了再显示浮层（横向翻页时列表位移为 0，不该闪浮层）
    dragStartOffsetRef.current = scrollInfoRef.current?.contentOffset.y ?? null
    isOverlayShownRef.current = false
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    cancelScroll()
  }, [cancelScroll])

  // 长按同样进入定位态（拖动之外的第二条入口，任务书要求）：
  // 位置基准线仍由列表的滚动信息算出，而「一直没滚动过」时它是空的，故先补一次亚像素位移。
  const handleLongPress = useCallback(() => {
    const list = listRef.current
    if (!list) return
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

  const handleScrollEndDrag = useCallback(() => {
    if (!isPauseScrollRef.current) return
    if (!isOverlayShownRef.current) {
      // 全程没动过（例如横向翻页）：直接解除定位态，不启动 3 秒倒计时，也不显示浮层
      isPauseScrollRef.current = false
      return
    }
    startIdleTimer()
  }, [startIdleTimer])

  const handleMomentumScrollEnd = useCallback(() => {
    if (!isPauseScrollRef.current || !isOverlayShownRef.current) return
    // 惯性滚动结束才算真正「停手」：重新计时，避免惯性还没停就触发回位
    startIdleTimer()
  }, [startIdleTimer])

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

  const handlePress = useCallback(() => {
    onPress?.()
  }, [onPress])

  const renderItem = useCallback(({ item, index }: { item: Line, index: number }) => {
    const isActive = index === activeLine
    const words = wordsByIndex[index] ?? null
    // 该行的结束时间 = 下一行的起始时间（末行没有下一行时给一个固定时长兜底）
    const endTime = lyricLines[index + 1]?.time ?? item.time + 4000
    return (
      <Pressable
        // 行高逐行化（第 16 轮第 8 条）：当前行带翻译时这一行更高，其余行只占行盒 + 净间距
        style={[styles.line, { height: rowHeights[index] ?? baseRowHeight }]}
        onPress={handlePress}
        onLongPress={handleLongPress}
        accessibilityRole="button"
        accessibilityLabel={item.text || undefined}
      >
        {
          // 逐字高亮：有逐字时间戳走真实时间轴，没有则按字符数均分该行时长（KaraokeLyric 内部区分）。
          // 仅激活行开启动画，其余行走静态整行配色（不为屏幕外的行跑 rAF）。
          isKaraoke && isActive
            ? (
              <KaraokeLyric
                words={words}
                lineTime={item.time}
                text={item.text}
                startTime={item.time}
                endTime={endTime}
                size={BASE_FONT_SIZE}
                style={textStyle}
                isActive
                numberOfLines={1}
                playedColor={activeColor}
                inactiveColor={inactiveColor}
              />
              )
            : (
              <Text
                size={BASE_FONT_SIZE}
                color={isActive ? activeColor : inactiveColor}
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
      </Pressable>
    )
  }, [activeLine, wordsByIndex, lyricLines, isKaraoke, baseRowHeight, rowHeights, textStyle, translationStyle, activeColor, inactiveColor, handlePress, handleLongPress])

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
    <View style={[styles.container, { height: containerHeight, marginHorizontal: -bleedH }, style]}>
      <FlatList
        ref={listRef}
        data={lyricLines}
        renderItem={renderItem}
        keyExtractor={getKey}
        getItemLayout={getItemLayout}
        style={styles.list}
        // 上下留白按首行/末行真实高度给：行号 i 居中 ⇔ 滚动偏移 = 该行中心 − 窗口中心
        //（见 getScrollOffset），定位浮层的基准线（容器 50%）因此永远压在窗口正中那一行上。
        // 左右内缩放在 contentContainer（而不是容器 padding）上：容器 padding 会把
        // 绝对定位的浮层一起缩进去，而列表内容的左右留白与滚动偏移（纵向）无关。
        contentContainerStyle={{ paddingTop: topPadding, paddingBottom: bottomPadding, paddingHorizontal: lineInsetH }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
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
    </View>
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
})

export default memo(MiniLyric)
