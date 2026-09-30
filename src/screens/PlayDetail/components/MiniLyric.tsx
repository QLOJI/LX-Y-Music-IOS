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
import { scaleSizeH, setSpText } from '@/utils/pixelRatio'
import { useWindowSize } from '@/utils/hooks'
import { scrollTo } from '@/utils/scroll'
import playerState from '@/store/player/state'
import { getReturnDuration, IDLE_RETURN_MS, LINE_CHANGE_GLIDE_MS } from '@/screens/PlayDetail/lyricAnimation'

// 迷你歌词 = 封面页上的「上一行 / 当前行 / 下一行」三行**定高**窗口。
//
// 定高是这一版的核心，三个历史问题都由它根治：
//   1) 三行间距不等：行高由同一个常量算出，任意两行之间的净间距完全相等；
//   2) 行数不足时高度塌缩、整块抖动：行数少于三行（首行/末行/歌词未就绪）时，
//      内容上下留白各一排，块高始终 = 3 × 行高，绝不随内容变化；
//   3) 换行时歌名等元素抖动：换行只改变列表的滚动位置（一次不重算目标的滚动动画），
//      不改变任何一行的高度与字号（三行统一字号，当前行只靠颜色区分）。
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
const LINE_GAP_NORMAL = 8
// 小屏（与 SongInfo / FeatureBtns 的判定阈值一致）空间不足：只保留当前行，
// 避免三行定高窗口把歌名块顶出容器、压到下方控制条
const SMALL_WINDOW_HEIGHT = 700
// 定高窗口的目标行数；实测可用高度不足时降级为 1 行（只显示当前行）
const WINDOW_ROWS = 3
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
// 空占位必须用不换行空格：RN 里空字符串的 <Text> 高度为 0
const BLANK = ' '

export interface MiniLyricProps {
  /** 点击歌词：切换到歌词页（保持向后兼容）。 */
  onPress?: () => void
  /** 外层样式（由竖屏封面页传入，含水平对齐）。 */
  style?: StyleProp<ViewStyle>
  /**
   * 竖屏布局**实测**传入的「小歌词区域当前真实可用高度」（pt）。
   * 语义是「返回栏底边 → 信息栏顶边」的实测像素高（布局系统的真实输出，
   * 与字号 / 机型 / 封面尺寸同步），不是解析推导值。
   * 未传（首帧还没量到 / 老调用点）时用不依赖外部测量的保守上限兜底，
   * 保持旧行为（小屏只显示当前行）；**绝不能当成 0**，否则首帧塌陷。
   */
  maxHeight?: number
}

const MiniLyric = ({ onPress, style, maxHeight }: MiniLyricProps) => {
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
  // 上一次的窗口档位（三行 / 单行），只用于滞回判断，不参与渲染输出
  const rowCountRef = useRef<number | null>(null)
  // 本次拖动开始时的滚动偏移（判断「是否真的动过」，见 OVERLAY_SHOW_MOVE）
  const dragStartOffsetRef = useRef<number | null>(null)
  // 浮层当前是否已经显示（显示与否不在 state 里：拖动的每帧都不该让本组件重渲染）
  const isOverlayShownRef = useRef(false)
  const activeLineRef = useRef(activeLine)
  activeLineRef.current = activeLine

  // 三个尺寸常量：字号 → 文字行高 → 行高（含行间距）。用 setSpText/scaleSizeH 与 Text 组件
  // 的缩放同源，全局字体调大时行高同步变大，不会出现「字被行高裁掉」。
  const metrics = useMemo(() => ({
    lineHeight: Math.round(setSpText(BASE_FONT_SIZE) * LINE_HEIGHT_RATIO),
    translationHeight: Math.round(setSpText(TRANSLATION_FONT_SIZE) * LINE_HEIGHT_RATIO),
    gap: Math.max(scaleSizeH(LINE_GAP_NORMAL), 1),
  }), [])

  // 翻译/罗马音：旧实现只给当前行挂一行翻译。定高窗口里「某些行比别人高」会直接破坏
  // 等距与居中，所以只要整首歌存在翻译，就为每一行预留同一高度（没有的行渲染不可见占位）。
  const hasTranslation = useMemo(
    () => lyricLines.some(line => (line.extendedLyrics?.length ?? 0) > 0),
    [lyricLines],
  )

  const rowHeight = metrics.lineHeight + metrics.gap + (hasTranslation ? metrics.translationHeight + metrics.gap : 0)

  // 可用高度上限：优先用竖屏布局实测传入的 maxHeight（该区域当前真实可用的高度）；
  // 未传时退回到不依赖外部测量的保守上限 —— 小屏只留当前行，大屏按三行窗口给满。
  // 注意这里不是 `?? 0`：首帧实测还没回来时若当成 0，整块会先塌陷再弹开。
  const limit = maxHeight ?? (winHeight < SMALL_WINDOW_HEIGHT ? rowHeight : rowHeight * WINDOW_ROWS)

  // 档位（三行 / 单行）必须断开「行数 → 自身高度 → 实测可用高度 → 行数」的自反馈环：
  // maxHeight 是布局实测值，小歌词自己撑高后它可能变小，若在阈值上做硬判断，
  // 阈值附近就会 3 行 ↔ 1 行来回抖。这里用滞回（Schmitt 触发器）：
  //   已在三行档：跌到「三行高度 − 余量」以下才降档；
  //   已在单行档：涨到「三行高度 + 余量」以上才升档。
  // 两个方向都要多走一个余量才切档 ⇒ 环路增益 < 1，不自激。
  // 用 ref（而不是 state）同步决定档位：每次渲染都按当前 limit 直接算出结果，
  // 不产生「先按旧档渲染一帧、再按新档重渲染」的中间帧 —— 中间帧本身就是一次抖动。
  const fullHeight = rowHeight * WINDOW_ROWS
  const hysteresis = Math.max(scaleSizeH(ROW_SWITCH_HYSTERESIS), 1)
  const prevRowCount = rowCountRef.current
  let rowCount: number
  if (prevRowCount == null) rowCount = limit >= fullHeight ? WINDOW_ROWS : 1
  else if (prevRowCount >= WINDOW_ROWS) rowCount = limit >= fullHeight - hysteresis ? WINDOW_ROWS : 1
  else rowCount = limit >= fullHeight + hysteresis ? WINDOW_ROWS : 1
  rowCountRef.current = rowCount
  // 上下各留 (行数-1)/2 排：行号 i 居中 ⇔ 滚动偏移 = i × 行高；块高恒定为 行数 × 行高
  const topPadding = ((rowCount - 1) / 2) * rowHeight
  const containerHeight = rowCount * rowHeight

  const rowStyle = useMemo<StyleProp<ViewStyle>>(() => ({ height: rowHeight }), [rowHeight])
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
  }, [])

  /**
   * 平滑滚动到第 index 行居中。
   * 目标位置在启动动画**之前**一次算好并锁定（不做每帧重算），且先取消上一条动画 ——
   * 这是「回位过程中不会先向上再向下」的结构性保证。
   * duration 不传时按距离取 getReturnDuration（手动定位后的回位）。
   */
  const animateToLine = useCallback((index: number, duration?: number) => {
    const list = listRef.current
    if (!list) return
    const offset = Math.max(0, index) * rowHeight
    cancelScroll()
    const info = scrollInfoRef.current
    if (!info) {
      list.scrollToOffset({ offset, animated: false })
      return
    }
    const distance = offset - info.contentOffset.y
    scrollCancelRef.current = scrollTo(
      list,
      info,
      offset,
      duration ?? getReturnDuration(distance),
      () => { scrollCancelRef.current = null },
    )
  }, [rowHeight, cancelScroll])

  // 播放行自动跟随：跨行距离很远（进度条 seek / 恢复播放）时直接落位，不做长距离快速滑动
  const followActiveLine = useCallback((index: number) => {
    const info = scrollInfoRef.current
    const offset = Math.max(0, index) * rowHeight
    if (info && Math.abs(offset - info.contentOffset.y) > rowHeight * FAR_JUMP_ROWS) {
      cancelScroll()
      listRef.current?.scrollToOffset({ offset, animated: false })
      return
    }
    animateToLine(index, LINE_CHANGE_GLIDE_MS)
  }, [animateToLine, rowHeight, cancelScroll])

  // 复位：切歌 / 歌词就绪时立即（无动画）回到当前行，避免从上一次的滚动位置长距离滑过去
  const resetScroll = useCallback(() => {
    isPauseScrollRef.current = false
    dragStartOffsetRef.current = null
    isOverlayShownRef.current = false
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    cancelScroll()
    playLineRef.current?.setVisible(false)
    listRef.current?.scrollToOffset({ offset: Math.max(0, activeLineRef.current) * rowHeight, animated: false })
  }, [rowHeight, cancelScroll])

  // 歌词换行：把当前行滑到窗口正中（时长与其他歌词动效同源）
  useEffect(() => {
    if (activeLine < 0) return
    // 手动定位期间不跟随：否则用户刚拖到位就被自动跟随拽回去
    if (isPauseScrollRef.current) return
    followActiveLine(activeLine)
  }, [activeLine, followActiveLine])

  useEffect(() => {
    resetScroll()
  }, [lyricLines, resetScroll])

  // 行高/留白变化（转屏、翻译行出现）与歌词变化时，同步给定位浮层：
  // 浮层按「留白 + 逐行行高」累计算出虚线指向的行，必须与列表的实际几何一致。
  useEffect(() => {
    playLineRef.current?.updateLyricLines(lyricLines)
    playLineRef.current?.updateLayoutInfo({
      spaceHeight: topPadding,
      lineHeights: lyricLines.map(() => rowHeight),
    })
  }, [lyricLines, rowHeight, topPadding])

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
      isPauseScrollRef.current = false
      animateToLine(Math.max(0, activeLineRef.current))
    }, IDLE_RETURN_MS)
  }, [animateToLine])

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
      list.scrollToOffset({ offset: Math.max(0, activeLineRef.current) * rowHeight + SCROLL_NUDGE, animated: false })
    }
    // 松手后不动也会自动收起浮层并回位（回位目标就是当前播放行，位移 = 上面那半个像素）
    startIdleTimer()
  }, [cancelScroll, rowHeight, startIdleTimer])

  const handleScroll = useCallback(({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollInfoRef.current = nativeEvent
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
        style={[styles.line, rowStyle]}
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
        {hasTranslation && (
          <Text
            size={TRANSLATION_FONT_SIZE}
            color={isActive ? activeColor : inactiveColor}
            style={translationStyle}
            numberOfLines={1}
          >
            {item.extendedLyrics?.[0] || BLANK}
          </Text>
        )}
      </Pressable>
    )
  }, [activeLine, wordsByIndex, lyricLines, isKaraoke, rowStyle, textStyle, translationStyle, hasTranslation, activeColor, inactiveColor, handlePress, handleLongPress])

  const getKey = useCallback((_item: Line, index: number) => `${index}`, [])
  // 定高行：getItemLayout 精确（不需要像大歌词那样动态测量），虚拟化窗口与滚动目标都以它为准
  const getItemLayout = useCallback((_data: unknown, index: number) => ({
    length: rowHeight,
    offset: rowHeight * index,
    index,
  }), [rowHeight])

  return (
    <View style={[styles.container, { height: containerHeight }, style]}>
      <FlatList
        ref={listRef}
        data={lyricLines}
        renderItem={renderItem}
        keyExtractor={getKey}
        getItemLayout={getItemLayout}
        style={styles.list}
        // 上下各留一排（单行模式为 0）：行号 i 居中 ⇔ 滚动偏移 = i × 行高，
        // 定位浮层的基准线（容器 50%）因此永远压在窗口正中那一行上。
        contentContainerStyle={{ paddingTop: topPadding, paddingBottom: topPadding }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        onContentSizeChange={resetScroll}
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
    // 水平内边距与旧实现一致（竖屏封面页还会再叠一层 10pt）
    paddingLeft: 20,
    paddingRight: 20,
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
