import { memo, useMemo, useEffect, useRef, useCallback, useState } from 'react'
import {
  View,
  FlatList,
  type FlatListProps,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  TouchableOpacity,
  PanResponder,
} from 'react-native'
// import { useLayout } from '@/utils/hooks'
import { type Line, useLrcPlay, useLrcSet, useLrcWordsMap, anchorLyric as lrcAnchorToTime, findLineIndexByTime } from '@/plugins/lyric'
import type { LxLyricWord } from '@/plugins/lxLyricPlayer'
import { getPosition } from '@/plugins/player'
import { LyricScrollLayout } from '@/utils/lyricScroll'
import { audioClock } from '@/core/player/audioClock'
import { createStyle } from '@/utils/tools'
import { updateSetting } from '@/core/common'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useIsPlay } from '@/store/player/hook'
import { AnimatedColorText } from '@/components/common/Text'
import { setSpText } from '@/utils/pixelRatio'
import settingState from '@/store/setting/state'
import playerState from '@/store/player/state'
import { useWindowSize } from '@/utils/hooks'
import KaraokeLyric from '@/screens/PlayDetail/components/KaraokeLyric'
import PlayLine, { type PlayLineType } from '@/screens/PlayDetail/components/PlayLine'
// 播放页动效时长的统一来源（数值与背景见 lyricAnimation.ts）；
// 例外：大歌词「换行停留 / 换行滑动」两个时长按需求 #1 直接对齐 REF 参考工程，
// 以本文件下方的 LINE_CHANGE_HOLD_MS / LINE_CHANGE_GLIDE_REF_MS 定义（原因见其注释）。
import { IDLE_RETURN_MS, OVERLAY_FADE_MS } from '@/screens/PlayDetail/lyricAnimation'
// import { screenkeepAwake } from '@/utils/nativeModules/utils'
// import { log } from '@/utils/log'
// import { toast } from '@/utils/tools'

type FlatListType = FlatListProps<Line>

// 大歌词手动定位：拖动超过这么多 pt 才显示定位浮层。
// 横向翻页会被外层 PagerView 抢走手势，那时列表只收到 beginDrag / endDrag（位移为 0），
// 不该为此闪一个空浮层出来。（与小歌词 MiniLyric 的 OVERLAY_SHOW_MOVE 同值同义。）
const OVERLAY_SHOW_MOVE = 2

// const useLock = () => {
//   const showCommentRef = useRef(false)

//   useEffect(() => {
//     let appstateListener = AppState.addEventListener('change', (state) => {
//       switch (state) {
//         case 'active':
//           if (showLyricRef.current && !showCommentRef.current) screenkeepAwake()
//           break
//         case 'background':
//           screenUnkeepAwake()
//           break
//       }
//     })
//     return () => {
//       appstateListener.remove()
//     }
//   }, [])
//   useEffect(() => {
//     let listener: ReturnType<typeof onNavigationComponentDidDisappearEvent>
//     showCommentRef.current = !!componentIds.comment
//     if (showCommentRef.current) {
//       if (showLyricRef.current) screenUnkeepAwake()
//       listener = onNavigationComponentDidDisappearEvent(componentIds.comment as string, () => {
//         if (showLyricRef.current && AppState.currentState == 'active') screenkeepAwake()
//       })
//     }

//     const rm = global.state_event.on('componentIdsUpdated', (ids) => {

//     })

//     return () => {
//       if (listener) listener.remove()
//     }
//   }, [])
// }

interface LineProps {
  line: Line
  lineNum: number
  activeLine: number
  onLayout: (lineNum: number, height: number, width: number, isActive: boolean) => void
  onPress: (index: number) => void
  isSmallWindow?: boolean
  wordsByIndex: ReadonlyArray<LxLyricWord[] | null>
}
const LrcLine = memo(
  ({ line, lineNum, activeLine, onLayout, onPress, isSmallWindow, wordsByIndex }: LineProps) => {
    const theme = useTheme()
    const lrcFontSize = useSettingValue('playDetail.vertical.style.lrcFontSize')
    const textAlign = useSettingValue('playDetail.style.align')
    const isActive = activeLine == lineNum
    const size = lrcFontSize / 10
    const lineHeight = setSpText(size) * 1.3
    // 有逐字时间轴的行始终用卡拉OK渲染器（非激活时静态显示未播放颜色）：
    // 嵌套 Text 与纯文本的换行断点不同，若激活时才切换渲染器，行高会在切行瞬间突变，
    // 造成抖动且实测高度与累计偏移基准不一致、高亮行偏离中心。
    const words = wordsByIndex[lineNum] ?? null

    const colors = useMemo(() => {
      return isActive
        ? ([theme.isDark ? theme['c-font'] : theme['c-primary-font-active'], theme['c-primary-alpha-200'], 1] as const)
        // 非激活行透明度 0.8 → 0.6：对齐 REF 『非激活 0.6 → 激活 1』的落差。
        // 0.8→1 的差太小，叠加 200ms 淡入后几乎看不出过渡，等于没做柔性切换。
        : ([theme['c-450'], theme['c-400'], 0.6] as const)
    }, [isActive, theme])

    // 行布局（字号/字重/行高）与激活状态解耦：激活行仅靠颜色高亮，不再放大加粗。
    // 否则切行瞬间文字变宽 → 换行数变化 → 行高突变，FlatList 重布局 + 回正滚动叠加
    // 造成「换行时抖动」，且激活/非激活两套高度基准不一致会让高亮行偏离居中位置。
    // 仍上报 isActive 供 LyricScrollLayout 记录（激活高度现恒等于非激活高度，两套基准天然一致）。
    const handleLayout = ({ nativeEvent }: LayoutChangeEvent) => {
      onLayout(lineNum, nativeEvent.layout.height, nativeEvent.layout.width, isActive)
    }

    const handlePress = useCallback(() => {
      onPress(lineNum)
    }, [onPress, lineNum])

    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={line.text || undefined}
      >
        <View style={[styles.line, isSmallWindow && { paddingTop: 6, paddingBottom: 6 }]} onLayout={handleLayout}>
          {words
            ? (
              <KaraokeLyric
                style={{
                  ...styles.lineText,
                  textAlign,
                  lineHeight,
                  fontWeight: '400',
                  opacity: colors[2],
                }}
                words={words}
                lineTime={line.time}
                size={size}
                isActive={isActive}
                playedColor={colors[0]}
                inactiveColor={theme['c-450']}
              />
              )
            : (
              <AnimatedColorText
                style={{
                  ...styles.lineText,
                  textAlign,
                  lineHeight,
                  fontWeight: '400',
                }}
                textBreakStrategy="simple"
                color={colors[0]}
                opacity={colors[2]}
                size={size}
                // 颜色瞬时 + 透明度 200ms 淡入：原先 duration={0} 让颜色与透明度都走 1ms
                // 伪瞬时，高亮切换毫无过渡，是「生硬」的直接来源（对齐 REF 的柔软形态）。
                // 颜色仍即时（colorDuration=0），高亮行不会滞后；放慢的只有透明度。
                // 两个动画节点必须同为 useNativeDriver:true，混用会 Fatal（见 Text.tsx 注释）。
                duration={OVERLAY_FADE_MS}
                colorDuration={0}
              >
                {line.text}
              </AnimatedColorText>
              )}
          {line.extendedLyrics.map((lrc, index) => {
            return (
              <AnimatedColorText
                style={{
                  ...styles.lineTranslationText,
                  textAlign,
                  lineHeight: lineHeight * 0.8,
                  ...(isSmallWindow && { paddingTop: 2 }),
                }}
                textBreakStrategy="simple"
                key={index}
                color={colors[1]}
                opacity={colors[2]}
                size={size * 0.8}
                duration={OVERLAY_FADE_MS}
                colorDuration={0}
              >
                {lrc}
              </AnimatedColorText>
            )
          })}
        </View>
      </TouchableOpacity>
    )
  },
  (prevProps, nextProps) => {
    return (
      prevProps.line === nextProps.line &&
      prevProps.activeLine != nextProps.lineNum &&
      nextProps.activeLine != nextProps.lineNum &&
      prevProps.onPress === nextProps.onPress &&
      prevProps.wordsByIndex === nextProps.wordsByIndex &&
      // onLayout 引用稳定（useCallback），无需比较；isSmallWindow 变化时必须放行更新，
      // 否则小屏/大屏切换后行内边距不刷新。
      prevProps.isSmallWindow === nextProps.isSmallWindow
    )
  },
)

export default ({ active = true, pagerHeight = 0 }: { active?: boolean, pagerHeight?: number }) => {
  const lyricLines = useLrcSet()
  const { line } = useLrcPlay()
  // 播放态（暂停/停止即 false）：给下面的「每帧连续滚动循环」加门控用。
  // 暂停时音频时钟不再推进，循环体只会逐帧算不出变化而早退，但 rAF 仍每帧被
  // CADisplayLink 唤醒（120Hz 解锁后成本翻倍）——只冻结时间不停帧，省不掉这份开销。
  const isPlay = useIsPlay()
  // 逐字时间轴（与 lyricLines 同序）：第 i 项为第 i 行歌词的逐字数组；无逐字（纯 LRC）为 null。
  // 激活行据此走逐字卡拉OK渲染，否则退回整行高亮。
  const wordsByIndex = useLrcWordsMap()
  const { height: winHeight } = useWindowSize()
  const isSmallWindow = winHeight < 700
  // 歌词页实际可用高度由父容器（PagerView 子页面）的 onLayout 给出，
  // 不再用 winHeight - HEADER_HEIGHT 估算：后者未扣除状态栏高和底部 Player
  // 控制区高，导致 FlatList 被撑得比歌词页还大，下方被 PagerView 裁剪或顶上去。
  const [pageHeight, setPageHeight] = useState(winHeight > 0 ? Math.max(0, winHeight - 180) : 0)
  // 用 ref 持有最新页面高度：handleScrollToActive 内部多处依赖 pageHeight 计算居中偏移，
  // 而 [active] effect 里延迟的 re-center（rAF / getPosition().then）闭包捕获的是旧渲染的
  // pageHeight（初始估算 winHeight-180），此时真实高度（onLayout）可能尚未到来，
  // 导致切到歌词页时高亮行偶发不居中。改为读 ref，确保延迟定位始终用真实高度。
  const pageHeightRef = useRef(pageHeight)
  const flatListRef = useRef<FlatList>(null)
  // active 页面首次挂载时即可自动定位；只有用户手动拖动歌词时才暂时暂停。
  const isPauseScrollRef = useRef(false)
  const scrollTimoutRef = useRef<NodeJS.Timeout | null>(null)
  const delayScrollTimeout = useRef<NodeJS.Timeout | null>(null)
  // 歌词页是从封面页切换时才挂载；初始值直接取引擎当前行，避免新页面先回到第 0 行。
  const lineRef = useRef({ line: line >= 0 ? line : 0, prevLine: line >= 0 ? line : 0 })
  // 记录上一帧的 active，用于检测“从封面页切回歌词页”的上升沿，
  // 上升沿这一次强制走 force 路径，避免被 [line, active] effect 的“舒适区动画滚动”抢先。
  const activeRef = useRef(active)
  // 缓存歌词行高与累计偏移，把滚动定位从 O(n²) 降到 O(1)。
  const lyricScrollLayoutRef = useRef(new LyricScrollLayout(isSmallWindow ? 40 : 54))
  const scrollCancelRef = useRef<(() => void) | null>(null)
  const scrollYRef = useRef(0)
  // 连续滚动指数平滑：rAF 算出的目标 offset 不直接写入列表，而是让跟随值按固定速率收敛到目标。
  // 逐字歌词「句内停住」模式下两句之间没有间隙时，切行瞬间目标会从当前行中心硬跳到下一行中心
  // （长句换行后行高更大、跳变越明显），行高测量后的回正修正同样是硬跳；
  // 平滑收敛把这些瞬跳都变成约 200ms 的短滑动，消除换行长句切行时的顿挫感。
  const smoothOffsetRef = useRef(0)
  const lastWrittenOffsetRef = useRef(-1)
  const lastFrameTsRef = useRef(0)
  const wasPauseRef = useRef(true)
  // 跳转/首开时大量行尚未测量，定位落地后需在新行完成测量时静默回正一次。
  const recentreTimerRef = useRef<NodeJS.Timeout | null>(null)

  // ---- 歌词手动定位浮层（PlayLine）：拖动歌词 → 虚线 + 目标行时间 + 播放三角 → 点三角 seek ----
  // 与小歌词 MiniLyric 同一套浮层、同一套交互，此前只挂在小歌词上，大歌词没有（需求 2 的缺口）。
  // 浮层基准线取 0.5（不是 PlayLine 默认的 0.4）：0.4 是参考工程大歌词的值，而本工程的大歌词
  // 已把高亮行钉在【正中】（handleScrollToActive 的 viewPosition 0.5，见其注释），
  // 浮层虚线必须与定位口径一致，否则虚线会压在高亮行的上一行。
  const playLineRef = useRef<PlayLineType>(null)
  // 是否允许歌词手动定位（既有设置位，同时控制浮层显隐；小歌词读的是同一个键）
  const isShowLyricProgress = useSettingValue('playDetail.isShowLyricProgressSetting')
  // 本次拖动开始时的滚动偏移（判断「是否真的动过」，见 OVERLAY_SHOW_MOVE 的说明）
  const dragStartOffsetRef = useRef<number | null>(null)
  // 浮层当前是否已显示（放 ref 不放 state：拖动的每一帧都不该让本组件重渲染）
  const isOverlayShownRef = useRef(false)

  // 把浮层需要的几何喂给它：定位基准线上方的留白 + 逐行行高 + 歌词行（取时间显示）。
  // 必须与 handleScrollToActive 的定位计算同源：留白 = 视高的 50%（与 contentContainerStyle
  // 的 paddingTop、与定位用的 paddingV 同值），行高取 LyricScrollLayout 的缓存
  //（已测行实测值 / 未测行分桶估算，与 getTargetOffsetPrecise 完全一致）。
  // 只在进入手动定位态时快照一次：行高会随字号设置、翻译行出现而变，拖动开始这一刻的值
  // 才是用户眼里看到的那一份；浮层隐藏期间不需要保持同步。
  const pushPlayLineLayout = useCallback(() => {
    if (!isShowLyricProgress) return
    const listHeight = pageHeightRef.current > 0 ? pageHeightRef.current : pagerHeight
    if (listHeight <= 0) return
    playLineRef.current?.updateLayoutInfo({
      spaceHeight: listHeight * 0.5,
      lineHeights: lyricScrollLayoutRef.current.getLineHeights(lyricLines.length),
    })
    playLineRef.current?.updateLyricLines(lyricLines)
  }, [isShowLyricProgress, lyricLines, pagerHeight])

  // 用户动作（拖动进度条 / 跳转 / 恢复播放）期间强制让歌词列表立即滚动到高亮行，
  // 使高亮行与进度条（及音频）绝对同步；被动逐秒重锚时仍用舒适区节流，避免逐行微滚动卡顿。
  const forceScrollRef = useRef(false)
  const forceScrollTimer = useRef<NodeJS.Timeout | null>(null)
  const setForceScroll = useCallback((on: boolean, persist = false) => {
    forceScrollRef.current = on
    if (forceScrollTimer.current) {
      clearTimeout(forceScrollTimer.current)
      forceScrollTimer.current = null
    }
    // 瞬时动作（persist=false）在 500ms 后自动复位；持续动作（persist=true，如拖动进度条）
    // 保持 force 直到手动复位，避免拖动过程中被定时器复位后“舒适区”节流导致高亮行滞后/错位。
    if (on && !persist) {
      forceScrollTimer.current = setTimeout(() => {
        forceScrollRef.current = false
        forceScrollTimer.current = null
      }, 500)
    }
  }, [])

  const initialDistanceRef = useRef(0)
  const initialFontSizeRef = useRef(0)
  // 缩放节流：updateSetting 每次调用都会全量序列化 setting 并写 AsyncStorage，
  // 缩放手势每帧触发会导致连串写盘 + configUpdated 广播，造成掉帧。
  // move 中按 120ms 节流提交（UI 仍平滑跟随），最新期望值暂存 pending，
  // 松手时一次性提交终值，保证最终字号准确落盘。
  const lastZoomCommitRef = useRef(0)
  const pendingZoomSizeRef = useRef<number | null>(null)

  const panResponder = useMemo(() => PanResponder.create({
    // 仅当两根手指同时按下时才接管手势（双指缩放歌词字号），
    // 单指留给 FlatList 自身做垂直滚动。用 gestureState.numberActiveTouches
    // 判断，避免直接读 evt.nativeEvent.touches（iOS 某些触摸事件下为 undefined，
    // 会抛 “Cannot read property 'length' of undefined” 导致整个歌词界面崩溃）。
    onStartShouldSetPanResponder: (_, gestureState) => gestureState.numberActiveTouches === 2,
    onMoveShouldSetPanResponder: (_, gestureState) => gestureState.numberActiveTouches === 2,
    onPanResponderGrant: (evt) => {
      const touches = evt.nativeEvent.touches ?? evt.nativeEvent.changedTouches
      if (!touches || touches.length < 2) return
      const dx = touches[0].pageX - touches[1].pageX
      const dy = touches[0].pageY - touches[1].pageY
      initialDistanceRef.current = Math.sqrt(dx * dx + dy * dy)
      initialFontSizeRef.current = settingState.setting['playDetail.vertical.style.lrcFontSize']
      lastZoomCommitRef.current = 0
      pendingZoomSizeRef.current = null
    },
    onPanResponderMove: (evt) => {
      const touches = evt.nativeEvent.touches ?? evt.nativeEvent.changedTouches
      if (!touches || touches.length < 2 || initialDistanceRef.current <= 0) return
      const dx = touches[0].pageX - touches[1].pageX
      const dy = touches[0].pageY - touches[1].pageY
      const distance = Math.sqrt(dx * dx + dy * dy)

      const scale = distance / initialDistanceRef.current
      let newSize = Math.round((initialFontSizeRef.current * scale) / 2) * 2
      newSize = Math.max(100, Math.min(newSize, 300)) // ensure within bounds

      if (settingState.setting['playDetail.vertical.style.lrcFontSize'] === newSize) return
      // 节流提交：间隔内的帧只更新 pending，松手时补交终值，避免每帧写盘。
      pendingZoomSizeRef.current = newSize
      const now = Date.now()
      if (now - lastZoomCommitRef.current >= 120) {
        lastZoomCommitRef.current = now
        updateSetting({ 'playDetail.vertical.style.lrcFontSize': newSize })
      }
    },
    onPanResponderRelease: () => {
      initialDistanceRef.current = 0
      // 松手补交：把节流期间暂存的最终字号落盘，保证手势结束后的字号与用户预期一致。
      const pending = pendingZoomSizeRef.current
      pendingZoomSizeRef.current = null
      if (pending != null && settingState.setting['playDetail.vertical.style.lrcFontSize'] !== pending) {
        updateSetting({ 'playDetail.vertical.style.lrcFontSize': pending })
      }
    },
    onPanResponderTerminate: () => {
      initialDistanceRef.current = 0
      // 手势被系统接管（如来电/通知下拉）时同样补交终值，避免缩放结果丢失。
      const pending = pendingZoomSizeRef.current
      pendingZoomSizeRef.current = null
      if (pending != null && settingState.setting['playDetail.vertical.style.lrcFontSize'] !== pending) {
        updateSetting({ 'playDetail.vertical.style.lrcFontSize': pending })
      }
    },
  }), [])

  // useLock()
  // const [imgUrl, setImgUrl] = useState(null)
  // const theme = useGetter('common', 'theme')
  // const { onLayout, ...layout } = useLayout()

  // useEffect(() => {
  //   const url = playMusicInfo ? playMusicInfo.musicInfo.img : null
  //   if (imgUrl == url) return
  //   setImgUrl(url)
  //
  // }, [playMusicInfo])

  // const imgWidth = useMemo(() => layout.width * 0.75, [layout.width])
  const getLineIndexForTime = useCallback((time: number) => {
    return findLineIndexByTime(lyricLines, time)
  }, [lyricLines])

  // 歌词高亮行定位：让当前行落在歌词界面【正中央】（等效 viewPosition≈0.5），满足第 5 条同步要求。
  // 第 7 条“高亮行上移一行”已按用户要求取消，故不再额外偏移一个 itemHeight，仅居中。
  // 跨行切换时无条件滚动到该位置，确保播放中高亮行与音频同步且位置一致。
  // 同一行重锚时再用“舒适区 15%”节流，避免逐秒重锚把歌词列表反复微滚动造成抖动。
  // force=true 时无视舒适区，用于切回歌词页 / 切歌 / 拖动进度条 / 点击歌词 / 恢复播放等需要立即定位的场景。
  const lastScrolledLineRef = useRef(-1)
  // useCallback 稳定引用：handleLinePress / scheduleRecentre / 各 effect 依赖它，
  // 若每次渲染重建会让 handleLinePress 引用跟着变，LrcLine 的 memo 比较器
  // （onPress 引用比较）将永远失效，行切换时全部可见行都被迫重渲染。
  const handleScrollToActive = useCallback((index = lineRef.current.line, force = false) => {
    if (index < 0 || !flatListRef.current || isPauseScrollRef.current) return
    if (scrollCancelRef.current) {
      scrollCancelRef.current()
      scrollCancelRef.current = null
    }
    const listHeight = pageHeightRef.current > 0 ? pageHeightRef.current : pagerHeight
    if (listHeight <= 0) return
    // 上下留白必须等于列表高的 50%（与横屏歌词页、与 contentContainerStyle 同源）：
    // 居中偏移 = 留白 + 前序行高累计 + 本行高/2 - 列表高/2，只有留白 >= 50% 时该值才恒落在
    // [0, 最大可滚距离] 区间内。留白为 12% 时，歌曲开头会算出负偏移、结尾会超出最大可滚距离，
    // 两端都被 FlatList 钳制，高亮行只能停在偏上/偏下的位置（两行及以上的长句行高更大，更显眼）。
    const paddingV = pageHeightRef.current > 0 ? pageHeightRef.current * 0.5 : 0
    // 等效 viewPosition:0.5：让高亮行落在歌词界面【正中央】（第 5 条同步要求：高亮行居中）。
    // 第 7 条“高亮行上移一行”已取消，故不再额外偏移一个 itemHeight。
    // 使用精确偏移：已测量行用真实行高，未测量行按「是否有翻译」分档估算，
    // 避免切到歌词页 / 跳到中后段时 FlatList 虚拟化导致之前行未测量、平均估算偏差过大，
    // 高亮行偶发不居中。
    const targetOffset = lyricScrollLayoutRef.current.getTargetOffsetPrecise(index, listHeight, lyricLines, 0.5, paddingV)
    const lineChanged = index !== lastScrolledLineRef.current
    // 非强制 + 同一行 + 当前行已在可视舒适区内（距目标 < 15% 视高）则跳过本次滚动（防抖动）；
    // 跨行切换 / 强制场景无条件滚动到中央，保证高亮行与音频同步且居中。
    if (!force && !lineChanged && Math.abs(targetOffset - scrollYRef.current) < listHeight * 0.15) return
    try {
      // force=true（切回歌词页 / 切歌 / 初次加载 / 拖动 / 点击）时立即定位，不用动画，避免高亮行“姗姗来迟”。
      flatListRef.current.scrollToOffset({ offset: targetOffset, animated: !force })
      lastScrolledLineRef.current = index
      // force 瞬时定位后把平滑跟随值直接对齐目标：连续滚动循环从同一基准出发，
      // 不会把列表拽回旧位置。非 force（动画滚动）不改动跟随值，交给循环平滑收敛。
      if (force) {
        smoothOffsetRef.current = targetOffset
        lastWrittenOffsetRef.current = targetOffset
        // 硬跳定位后取消进行中的切行滑动与未走完的停留窗口，否则下一帧会被滑动轨迹
        // 拉回旧位置、或被停留窗口冻住；同时把“上一次滚动到的行”对齐，避免下一帧把
        // 这次硬跳当成换行再滑一次。
        glideStartTsRef.current = -1
        lineChangeTsRef.current = -1
        glideStartedRef.current = true
        lastContinuousIndexRef.current = index
      }
    } catch { }
  }, [lyricLines, pagerHeight])

  // 连续平滑滚动：每帧把「当前高亮行」精确居中。
  // 目标行一律取高亮行本身（lineRef.current.line，与行着色同一个来源）：
  // 原先这里用 audioClock 另算一个行号，两处时间基准不同，换行边界附近会出现
  // 「滚动目标已到下一行、而高亮还停在当前行」，视觉上就是高亮行整行偏离中心；
  // 行高越大偏得越多——这正是两行及以上的长句最容易看出不居中的原因。
  // 同时不再做「句末提前滚到下一行」的预滚动：那会让整句末尾那段（最长约 0.7s）
  // 高亮行被持续拉离中心，与「高亮行必须居中」的要求冲突。
  // 现在改为切行瞬间把目标切到新行，并用固定时长的 easeInOut 滑动滑到新行居中。
  const lastContinuousTimeRef = useRef(-1)
  const lastContinuousIndexRef = useRef(-1)
  // 切行滑动：起点偏移 / 终点偏移 / 滑动起始时间戳（< 0 表示当前不在滑动中）。
  const glideFromRef = useRef(0)
  const glideToRef = useRef(0)
  // 换行节奏对齐 REF 参考工程（需求 #1「换行动画顺滑不生硬」）：
  //   REF 是「连续换行（diff==1）后先停留 600ms，再用 600ms 滑到新行」——
  //   停留见 REF Vertical/Lyric.tsx:290-298（diff==1 时 setTimeout(600) 后才 handleScrollToActive），
  //   滑动见 REF Vertical/Lyric.tsx:186（scrollTo(..., 600)）；非连续跳变则立即定位。
  //   本工程此前是「换行当帧立即起滑、200ms 滑完」，没有停留段，节奏明显更急、更生硬。
  // ⚠️ 停留窗口锚定在【一串连续换行的第一行】，不是锚定最后一次换行：
  //   串内后续换行只更新滑动目标、绝不重置 lineChangeTsRef。否则行间隔 <600ms 的快歌里
  //   窗口会被每次换行续命、列表长时间不动（比原缺陷更糟）。REF 同样是「首个 600ms 到点
  //   即起滑，后续换行只改目标」，因此不会冻住。「新的一串」判据：距锚点已超过
  //   停留+滑动（即上一轮整周期已走完）。
  //   这两个值刻意不放进 lyricAnimation.ts：那里的 LINE_CHANGE_GLIDE_MS 仍被小歌词
  //   MiniLyric 引用，且是「全局动效放慢」定案的 designMotion.quick(200)；本次只对齐大歌词。
  const LINE_CHANGE_HOLD_MS = 600
  const LINE_CHANGE_GLIDE_REF_MS = 600
  // lineChangeTsRef：当前这串连续换行的停留锚点（< 0 = 不在串内，直接平滑跟随）。
  const lineChangeTsRef = useRef(-1)
  // glideStartedRef：本串是否已经起过滑（防止停留到点后每帧重复起滑；新的一串开始时复位；
  // 跳变/强制定位等无停留段的路径直接置 true）。
  const glideStartedRef = useRef(true)
  // 滑动用固定时长 + easeInOutQuad（与 REF utils/scroll.ts 的 easeInOutQuad 同族）：
  // 原先切行后用「指数速率 12/s → 40/s」追，40/s 单帧就吃掉 47% 的距离，观感是
  // “顿一下再猛追”；固定时长滑动的起步/收尾都平缓、中段略快，每帧位移连续变化，
  // 整段看起来才是平滑地滑上去（行高越大越明显）。
  // 同一行内的平滑速率：只用来吸收行高测量带来的小幅修正（12/s ≈ 200ms 收敛 95%），
  // 目标本身基本不动，不会产生可见位移。
  const SMOOTH_RATE_NORMAL = 12
  const scrollToActiveContinuous = (ts: number) => {
    const t = audioClock.getTime() * 1000 // ms
    if (t === lastContinuousTimeRef.current) {
      lastFrameTsRef.current = ts
      return // 暂停/无推进时跳过，避免空转 Bridge 写
    }
    lastContinuousTimeRef.current = t
    if (!flatListRef.current || !lyricLines.length) return
    const listHeight = pageHeightRef.current > 0 ? pageHeightRef.current : pagerHeight
    if (listHeight <= 0) return
    // 与 handleScrollToActive 同源：留白 50% 视高，保证任何一行（含两行以上的长句）都能被精确居中。
    const paddingV = pageHeightRef.current > 0 ? pageHeightRef.current * 0.5 : 0
    // 末位参数 false：统一用非激活行高做基准，切行前后同基准，不会突跳。
    let i = lineRef.current.line
    if (i < 0 || i >= lyricLines.length) i = 0
    const continuousOffset = lyricScrollLayoutRef.current.getTargetOffsetPrecise(i, listHeight, lyricLines, 0.5, paddingV, 0, false)
    if (i !== lastContinuousIndexRef.current) {
      // REF 把换行分两类（REF Vertical/Lyric.tsx:290-298）：连续推进一行（diff==1）先停留
      // 600ms 再滑；非连续跳变立即定位。恢复首帧 lastContinuousIndexRef=-1 属未知态，按跳变处理。
      const isContinuousAdvance = lastContinuousIndexRef.current >= 0 && i === lastContinuousIndexRef.current + 1
      lastContinuousIndexRef.current = i
      if (!isContinuousAdvance) {
        // 跳变（seek / 恢复首帧未知态）：取消停留窗口，立即起滑，避免恢复播放后还要干等 600ms。
        lineChangeTsRef.current = -1
        glideStartedRef.current = true
        glideFromRef.current = smoothOffsetRef.current
        glideToRef.current = continuousOffset
        glideStartTsRef.current = ts
      } else {
        const runElapsed = lineChangeTsRef.current >= 0 ? ts - lineChangeTsRef.current : Number.POSITIVE_INFINITY
        if (runElapsed > LINE_CHANGE_HOLD_MS + LINE_CHANGE_GLIDE_REF_MS) {
          // 新的一串连续换行（上一轮的停留+滑动整周期已走完）：锚定停留起点，600ms 后再起滑。
          lineChangeTsRef.current = ts
          glideStartedRef.current = false
          glideStartTsRef.current = -1
        } else if (glideStartTsRef.current >= 0) {
          // 同一串内、且已经起滑：把滑动重新锚定到「当前位置 → 新目标」。起点就是当前值，
          // 位移连续不跳变（等价于 REF 每次换行都从当前位置起一段新动画）。
          glideFromRef.current = smoothOffsetRef.current
          glideToRef.current = continuousOffset
          glideStartTsRef.current = ts
        }
        // 同一串内、仍在停留窗口：什么都不做——只更新目标（起滑那一帧会用上当帧的
        // continuousOffset），停留锚点绝不重置。这是快歌（行间隔 <600ms）不被冻住的关键。
      }
    }
    const dt = lastFrameTsRef.current > 0 ? Math.min(Math.max((ts - lastFrameTsRef.current) / 1000, 0.001), 0.05) : 0.016
    lastFrameTsRef.current = ts
    const holdElapsed = lineChangeTsRef.current >= 0 ? ts - lineChangeTsRef.current : Number.POSITIVE_INFINITY
    if (holdElapsed < LINE_CHANGE_HOLD_MS && !glideStartedRef.current) {
      // 停留窗口内：保持原位不动。这里【必须】跳过下面的指数平滑——目标已切到新行，
      // 若照常平滑会提前蠕动，停留段就名存实亡（这正是与 REF 观感的关键差异点）。
    } else {
      if (lineChangeTsRef.current >= 0 && !glideStartedRef.current) {
        // 停留到点：起滑（一串连续换行只在这里起滑一次，之后由上面的「重新锚定」跟随新行）。
        glideStartedRef.current = true
        glideFromRef.current = smoothOffsetRef.current
        glideToRef.current = continuousOffset
        glideStartTsRef.current = ts
      }
      const glideElapsed = glideStartTsRef.current >= 0 ? ts - glideStartTsRef.current : Number.POSITIVE_INFINITY
      if (glideElapsed < LINE_CHANGE_GLIDE_REF_MS) {
        // 滑动中：easeInOutQuad。终点取起滑/重新锚定当帧记录的新行偏移；若这期间行高测量修正了
        // 目标，滑动结束后由下面的指数平滑继续收敛（小幅位移，无感），不会硬跳。
        const p = glideElapsed / LINE_CHANGE_GLIDE_REF_MS
        const eased = p < 0.5 ? 2 * p * p : 1 - (((-2 * p) + 2) * ((-2 * p) + 2)) / 2
        smoothOffsetRef.current = glideFromRef.current + (glideToRef.current - glideFromRef.current) * eased
      } else {
        // 无停留、无滑动（或本串滑动已结束）：指数平滑跟随。同一串内后续换行走这里，
        // 每帧重算目标，天然跟得上；12/s ≈ 200ms 收敛 95%，位移连续。
        glideStartTsRef.current = -1
        const delta = continuousOffset - smoothOffsetRef.current
        if (Math.abs(delta) < 0.5) smoothOffsetRef.current = continuousOffset
        else smoothOffsetRef.current += delta * (1 - Math.exp(-dt * SMOOTH_RATE_NORMAL))
      }
    }
    if (Math.abs(smoothOffsetRef.current - lastWrittenOffsetRef.current) < 0.5) return
    try {
      flatListRef.current.scrollToOffset({ offset: smoothOffsetRef.current, animated: false })
      lastWrittenOffsetRef.current = smoothOffsetRef.current
    } catch { }
  }

  // 跳转/歌词页中途打开时，当前行之前的大量行还没被测量，首跳落点必然有偏差；
  // 等新一批行测量完成（防抖 150ms）后静默回正一次，保证高亮行最终严格居中。
  const scheduleRecentre = useCallback(() => {
    if (recentreTimerRef.current) clearTimeout(recentreTimerRef.current)
    recentreTimerRef.current = setTimeout(() => {
      recentreTimerRef.current = null
      if (!active || isPauseScrollRef.current) return
      // 非 force：测量修正交给连续滚动循环平滑收敛，避免 force 硬跳在长句测量后产生可见顿挫。
      handleScrollToActive(lineRef.current.line)
    }, 150)
  }, [active, handleScrollToActive])
  const handleScrollBeginDrag = () => {
    isPauseScrollRef.current = true
    // 先记账、先不显示：等列表真的动了再显示浮层（见 OVERLAY_SHOW_MOVE）。
    // 用 scrollYRef（handleScroll 持续记录的真实偏移）而不是另存一份滚动信息快照：
    // 大歌词的自动跟随每帧都在写偏移，ref 里的值就是用户手指按下那一刻的位置。
    dragStartOffsetRef.current = scrollYRef.current
    isOverlayShownRef.current = false
    // 每次进入手动定位态都重算一次浮层几何：行高会随字号设置、翻译行出现而变化，
    // 只有拖动开始这一刻的快照才与用户眼前看到的列表一致。
    pushPlayLineLayout()
    if (delayScrollTimeout.current) {
      clearTimeout(delayScrollTimeout.current)
      delayScrollTimeout.current = null
    }
    if (scrollTimoutRef.current) {
      clearTimeout(scrollTimoutRef.current)
      scrollTimoutRef.current = null
    }
    if (scrollCancelRef.current) {
      scrollCancelRef.current()
      scrollCancelRef.current = null
    }
  }

  const onScrollEndDrag = () => {
    if (!isPauseScrollRef.current) return
    if (!isOverlayShownRef.current) {
      // 全程没动过（横向翻页被外层 PagerView 抢走手势、或只是轻点了一下）：
      // 直接解除定位态，既不显示浮层也不启动回位倒计时，避免列表白冻 3 秒。
      isPauseScrollRef.current = false
      // 必须一并清空：handleScroll 用「dragStartOffsetRef 非空」判断是否处于手动定位态，
      // 留着一个过期的起点，后续自动跟随的滚动事件就会被当成用户在拖、把浮层弹出来。
      dragStartOffsetRef.current = null
      return
    }
    if (scrollTimoutRef.current) clearTimeout(scrollTimoutRef.current)
    scrollTimoutRef.current = setTimeout(() => {
      scrollTimoutRef.current = null
      isPauseScrollRef.current = false
      // 回位的同时收起浮层：浮层虚线是按滚动偏移实时算的，回位动画期间不收，
      // 虚线会从用户停手的位置一路扫回当前行，像一条乱窜的线。
      // dragStartOffsetRef 必须一并清空：handleScroll 以它非空作为「用户在拖」的判据，
      // 下面 handleScrollToActive() 的回位滚动会触发一串 onScroll，
      // 留着过期的起点会让浮层在回位过程中被重新弹出来（虚线乱扫的另一个来源）。
      dragStartOffsetRef.current = null
      isOverlayShownRef.current = false
      playLineRef.current?.setVisible(false)
      // 到时即回位，与是否在播放无关：暂停时把大歌词滑离当前行，停手 IDLE_RETURN_MS
      // 后同样要平滑回到高亮行（Bug 5）。同屏小歌词 MiniLyric 的停手回位本来就
      // 不判断 isPlay，这里与它对齐。注意：参考工程此回调带「暂停即 return」守卫，
      // 本行属对参考行为的有意分歧，不是移植遗漏——不要以参考工程为「正确行为」依据。
      handleScrollToActive()
    }, IDLE_RETURN_MS)
  }

  // 点浮层的播放三角：从虚线指向的那一行开始播。
  // 与小歌词 MiniLyric 的 handlePlayLine 同构（含「收口到总长之前」的防误跳歌）。
  const handlePlayLine = useCallback((time: number) => {
    if (scrollTimoutRef.current) {
      clearTimeout(scrollTimoutRef.current)
      scrollTimoutRef.current = null
    }
    isPauseScrollRef.current = false
    dragStartOffsetRef.current = null
    isOverlayShownRef.current = false
    playLineRef.current?.setVisible(false)
    // 目标时间若等于/超过歌曲总时长，会被当作「已播放到结尾」而直接切下一首，
    // 这里收回到总长之前一小段（与参考工程同源，防误跳歌）
    const maxTime = playerState.progress.maxPlayTime
    if (maxTime > 0 && time >= maxTime) time = Math.max(maxTime - 0.5, 0)
    // 只 seek：歌词行跟引擎事件走，落点出声后由换行跟随把该行滑到正中。
    // 这里**不**提前把列表滚到目标行，避免「先滚回旧行、再滑向新行」的二次动画。
    // setProgress 事件本身会触发 setForceScroll(true)，无需在这里重复。
    global.app_event.setProgress(time)
  }, [])

  useEffect(() => {
    return () => {
      if (delayScrollTimeout.current) {
        clearTimeout(delayScrollTimeout.current)
        delayScrollTimeout.current = null
      }
      if (scrollTimoutRef.current) {
        clearTimeout(scrollTimoutRef.current)
        scrollTimoutRef.current = null
      }
      if (recentreTimerRef.current) {
        clearTimeout(recentreTimerRef.current)
        recentreTimerRef.current = null
      }
      if (pendingInitialScrollTimerRef.current) {
        clearTimeout(pendingInitialScrollTimerRef.current)
        pendingInitialScrollTimerRef.current = null
      }
    }
  }, [])

  // 拖动进度条 / 跳转 / 恢复播放等用户动作期间强制让歌词列表立即滚动到高亮行，
  // 保证高亮行与进度条（及音频）绝对同步，不出现“高亮行滞后 / 错位的 15% 舒适区跳过重滚动”。
  useEffect(() => {
    const handleDragState = (dragging: boolean) => {
      if (dragging) {
        // 拖动进度条期间持续强制同步：让 force 一直为 true，不被 500ms 定时器复位，
        // 否则长拖动中途被复位后“舒适区”节流会让高亮行跟不上进度条。
        setForceScroll(true, true)
      } else {
        // 拖动结束：保持一小段时间让最后一段定位动画落位，再复位。
        if (forceScrollTimer.current) clearTimeout(forceScrollTimer.current)
        forceScrollTimer.current = setTimeout(() => {
          forceScrollRef.current = false
          forceScrollTimer.current = null
        }, 500)
      }
    }
    const handleSetProgress = () => { setForceScroll(true) }
    const handlePlay = () => { setForceScroll(true) }
    global.app_event.on('progressDragState', handleDragState)
    global.app_event.on('setProgress', handleSetProgress)
    global.app_event.on('play', handlePlay)
    return () => {
      global.app_event.off('progressDragState', handleDragState)
      global.app_event.off('setProgress', handleSetProgress)
      global.app_event.off('play', handlePlay)
    }
  }, [setForceScroll])

  // 「引擎当前行号」的镜像：重置 effect 不能再把 line 放进依赖（原因见下），
  // 但首跳又必须用最新行号，故用 ref 镜像替代依赖项。
  const latestLineRef = useRef(line)
  latestLineRef.current = line
  // 首跳等待标记：切歌 / 异步歌词到达后会换 key 重新挂载 FlatList，
  // 必须等新列表内容布局完成（onContentSizeChange）再定位，
  // 否则会在“马上要被卸载的旧列表”上定位，位置随后丢失。
  const pendingInitialScrollRef = useRef(false)
  // 首跳兜底定时器：万一 onContentSizeChange 未触发，也要解除暂停并定位，
  // 避免列表永久卡在暂停态（不跟随播放滚动）。
  const pendingInitialScrollTimerRef = useRef<NodeJS.Timeout | null>(null)
  // handleScrollToActive 的稳定引用：重置 effect 不把它放进依赖项（否则其引用变化会连带触发重置）。
  const handleScrollToActiveRef = useRef(handleScrollToActive)
  useEffect(() => {
    handleScrollToActiveRef.current = handleScrollToActive
  }, [handleScrollToActive])
  // 歌词内容版本号：内容变化时给 FlatList 换 key 强制重新挂载。
  // 重新挂载的首次渲染会按 initialNumToRender（= 整首歌行数）把每一行都渲染一次并完成
  // onLayout 实测 —— 只在“已挂载列表”上换 data 时 FlatList 只渲染当前窗口，
  // 首播位置之前/之后的大量行永远不被渲染、行高只能估算，累计偏移因此持续偏差
  // （高亮行越走越偏的直接原因之一）。
  const [lyricKey, setLyricKey] = useState(0)
  // 首次挂载不必换 key（首挂本身就会按 initialNumToRender 渲染整首），只在后续内容变化时换。
  const isFirstLyricKeyRef = useRef(true)
  useEffect(() => {
    if (isFirstLyricKeyRef.current) {
      isFirstLyricKeyRef.current = false
      return
    }
    setLyricKey(key => key + 1)
  }, [lyricLines])

  // 仅歌词内容真正变化（切歌 / 异步歌词到达）时才重置行高缓存并重新挂载列表。
  // ⚠️ 依赖项里【绝不能】放 line / active：
  // 修复前依赖了 line，导致【每切一行】都执行一次 reset() —— 清空全部实测行高、把列表
  // 拽回顶部、并把平滑跟随基准归零。清空之后累计偏移只能用 defaultHeight（54pt）等
  // 估算值累加，而两行及以上的歌词行真实高度约 71pt，每行少算约 17pt，于是偏移随播放
  // 逐行偏小、高亮行越来越靠下（用户录屏中的现象：高亮行从居中一路漂到屏幕下方）。
  // active 同理：切页只应重新定位，不该清空缓存（下面的 [active] effect 负责定位）。
  useEffect(() => {
    lyricScrollLayoutRef.current.reset()
    lastScrolledLineRef.current = -1
    lineRef.current.prevLine = 0
    lineRef.current.line = 0
    // 标记等待首跳：等新列表 onContentSizeChange 里再定位；
    // 期间暂停连续滚动循环，避免它按刚归零的行号把旧列表拽回顶部造成闪动。
    pendingInitialScrollRef.current = true
    isPauseScrollRef.current = true
    // 切歌 / 歌词内容变化时一并收起手动定位浮层：浮层的行高与歌词行都是按下那一刻的快照，
    // 换歌后这份快照已经属于上一首，留着会看到虚线停在新歌的列表上（浮层本身不会自动消失）。
    dragStartOffsetRef.current = null
    isOverlayShownRef.current = false
    playLineRef.current?.setVisible(false)
    if (!flatListRef.current) return
    flatListRef.current.scrollToOffset({ offset: 0, animated: false })
    scrollYRef.current = 0
    // 平滑跟随基准同步归零，避免切歌后循环把列表从旧位置拽回顶部。
    smoothOffsetRef.current = 0
    lastWrittenOffsetRef.current = -1
    lastFrameTsRef.current = 0
    glideStartTsRef.current = -1
    lineChangeTsRef.current = -1
    glideStartedRef.current = true
    lastContinuousIndexRef.current = -1
    if (!lyricLines.length) {
      pendingInitialScrollRef.current = false
      isPauseScrollRef.current = false
      return
    }

    // 切歌/异步歌词到达后，必须强制下一次 line 更新时立即定位到当前高亮行。
    // 否则 play/setProgress 事件可能晚于 line 更新，forceScrollRef 仍为 false，
    // 导致高亮行无法居中。
    setForceScroll(true)

    // 兜底：onContentSizeChange 未触发时也要解除暂停并定位（见 pendingInitialScrollTimerRef 注释）
    if (pendingInitialScrollTimerRef.current) clearTimeout(pendingInitialScrollTimerRef.current)
    pendingInitialScrollTimerRef.current = setTimeout(() => {
      pendingInitialScrollTimerRef.current = null
      if (!pendingInitialScrollRef.current) return
      pendingInitialScrollRef.current = false
      isPauseScrollRef.current = false
      handleScrollToActiveRef.current(Math.max(0, latestLineRef.current), true)
    }, 800)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyricLines])

  useEffect(() => {
    if (line < 0) return
    lineRef.current.prevLine = lineRef.current.line
    lineRef.current.line = line
    if (!flatListRef.current || isPauseScrollRef.current) {
      activeRef.current = active
      return
    }

    // 非歌词页（封面页）时，歌词时钟仍在推进，但不在后台驱动 FlatList 滚动，
    // 避免 PagerView 横向滑页时与歌词的逐秒 scrollToIndex 抢帧导致卡顿。
    if (!active) {
      activeRef.current = active
      return
    }

    // 从封面页切回歌词页的“上升沿”这一次强制立刻定位（force=true）：
    // 否则本 effect 比 [active] effect 先执行，会先发一个 animated:true 的舒适区动画滚动，
    // 高亮行就“慢慢滚”到目标，而非立即到位。
    const force = forceScrollRef.current || !activeRef.current
    activeRef.current = active
    // 拖动进度条 / 跳转 / 恢复播放等用户动作（force）期间立即无动画定位；
    // 普通播放推进交给每帧连续滚动循环（scrollToActiveContinuous），实现平滑上移而非逐行跳变。
    if (force) {
      handleScrollToActive(lineRef.current.line, true)
    }
  }, [line, active, handleScrollToActive])

  // 每帧连续平滑滚动循环：歌词页激活【且正在播放】且非用户手动滚动时，基于外推时钟精确时间驱动歌词连续上移。
  // iOS 后台 / 锁屏时 rAF 暂停（歌词停滚无妨）；前台播放每帧（~16ms）定位，消除原来的行级跳变。
  // 暂停即取消 rAF（cancel，而不是把滚动速度改 0 / 让循环空转）：暂停时时钟冻结，
  // 循环体每帧都算不出位移只会早退，但帧请求照样被逐帧唤醒——停帧才真正省下 JS 线程与
  // 渲染树的这份常驻开销。恢复播放时 effect 重跑、重新起帧。
  useEffect(() => {
    if (!active) return
    // 暂停期间用户可能手动滚动歌词/拖动进度条：恢复播放的首帧必须像「手动滚动恢复」一样
    // 以列表真实位置为平滑基准（见下面 wasPauseRef 分支），否则会被暂停前的旧基准拽回去。
    if (!isPlay) {
      wasPauseRef.current = true
      return
    }
    let rafId = 0
    const loop = (ts: number) => {
      if (isPauseScrollRef.current) {
        wasPauseRef.current = true
      } else if (flatListRef.current && lyricLines.length) {
        // 从暂停（用户手动滚动/拖动歌词）恢复的首帧：把平滑基准重置为列表真实位置，
        // 避免沿用暂停前的旧基准把列表瞬间拽回去。
        if (wasPauseRef.current) {
          wasPauseRef.current = false
          smoothOffsetRef.current = scrollYRef.current
          lastWrittenOffsetRef.current = scrollYRef.current
          lastFrameTsRef.current = ts
          // 恢复首帧不承接暂停前的切行滑动/停留窗口：lastContinuousIndexRef 置 -1 后，
          // 下一帧按「跳变」处理立即起滑，不会先干等 600ms。
          glideStartTsRef.current = -1
          lineChangeTsRef.current = -1
          glideStartedRef.current = true
          lastContinuousIndexRef.current = -1
        }
        scrollToActiveContinuous(ts)
      }
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(rafId) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, isPlay, lyricLines])

  // 从封面页切回歌词页时，立即把歌词时钟重锚到真实音频位置，并强制把当前行定位到【正中】
  // （viewPosition 0.5，不再是历史上的 42%——42% 与「高亮行居中」的要求冲突），
  // 避免“长暂停后再播放 / 重开后”高亮行姗姗来迟、与音频不同步。
  useEffect(() => {
    if (!active) return

    // 先用同步的播放进度做一次立即重锚（播放中重启 ticker 从该位置推进），
    // 再按歌词引擎当前行定位；不等待原生 getPosition Promise，保证切页首个
    // 布局帧就显示接近真实位置的高亮行。
    isPauseScrollRef.current = false
    const cachedPosition = playerState.progress.nowPlayTime
    let immediateLine = lineRef.current.line
    if (Number.isFinite(cachedPosition) && cachedPosition >= 0) {
      immediateLine = getLineIndexForTime(cachedPosition * 1000)
      if (immediateLine >= 0) {
        lineRef.current.prevLine = lineRef.current.line
        lineRef.current.line = immediateLine
        try { lrcAnchorToTime(cachedPosition * 1000, playerState.isPlay) } catch {}
      }
    }
    setForceScroll(true)
    handleScrollToActive(immediateLine, true)
    requestAnimationFrame(() => {
      handleScrollToActive(lineRef.current.line, true)
    })

    // 再用音频引擎真实位置校正一次，纠正切歌/恢复播放时 store 进度尚未更新的情况。
    void getPosition().then((p) => {
      if (p == null || !playerState.musicInfo.id) return
      try { lrcAnchorToTime(p * 1000, playerState.isPlay) } catch {}
      requestAnimationFrame(() => {
        setForceScroll(true)
        handleScrollToActive(lineRef.current.line, true)
      })
    })
  }, [active, getLineIndexForTime, handleScrollToActive, setForceScroll])

  // 页面真实高度（onLayout）到来后用精确高度把高亮行重新定位到中央，
  // 修正首次用估算高度（winHeight-180）计算偏移、导致切到歌词页时高亮行偶发不居中的问题。
  useEffect(() => {
    if (!active || pageHeight <= 0 || isPauseScrollRef.current) return
    handleScrollToActive(lineRef.current.line, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageHeight, active])

  // 记录当前滚动偏移（供“舒适区感知滚动”判断）＋手动定位期间喂浮层；均不触发重渲染。
  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nativeEvent = e.nativeEvent
    scrollYRef.current = nativeEvent.contentOffset.y
    // 仅手动定位期间喂浮层：自动跟随期间每帧都有一次 scrollToOffset → onScroll，
    // 此时浮层是隐藏的，喂它只会白白让一个看不见的组件每帧重渲染。
    // dragStartOffsetRef 只在 handleScrollBeginDrag 里赋值、在收起浮层的每条路径上都清空，
    // 因此它非空就等价于「用户正按着歌词」——比用 isPauseScrollRef 更准：
    // 后者在「进入歌词页 / 切歌后等布局就位」的窗口里也是 true，
    // 那期间的程序化滚动（scrollToOffset）不该把浮层弹出来。
    if (dragStartOffsetRef.current == null) return
    if (!isOverlayShownRef.current) {
      if (Math.abs(nativeEvent.contentOffset.y - dragStartOffsetRef.current) < OVERLAY_SHOW_MOVE) return
      isOverlayShownRef.current = true
      playLineRef.current?.setVisible(true)
    }
    playLineRef.current?.updateScrollInfo(nativeEvent)
  }, [])

  const handleLineLayout = useCallback<LineProps['onLayout']>((lineNum, height, _width, isActive) => {
    const layout = lyricScrollLayoutRef.current
    const wasMeasured = layout.isMeasured(lineNum)
    // 把该行是否有翻译传给布局，使其未测量行估算能区分「无翻译/有翻译」两类真实平均高度，
    // 避免快进/快退到中后段时高亮行偏高/偏低一行。
    // isActive：激活态高度只用于该行自身定位，不计入累计偏移（见 LyricScrollLayout 说明）。
    layout.updateLineHeight(lineNum, height, !!(lyricLines[lineNum]?.extendedLyrics?.length), isActive)
    if (!active || isPauseScrollRef.current) return
    const current = lineRef.current.line
    // 当前行首次测量（切歌/跳转后激活行真实高度就位），或非激活行首次测量导致累计偏移变化时，
    // 防抖回正：避免跳到中段后估算误差让高亮行一直停在非居中位置。
    if (lineNum === current || (!wasMeasured && lineNum < current)) {
      scheduleRecentre()
    }
  }, [active, scheduleRecentre, lyricLines])

  // 小屏/大屏切换时同步估算行高，保证滚动定位偏移计算准确。
  useEffect(() => {
    lyricScrollLayoutRef.current.setDefaultHeight(isSmallWindow ? 40 : 54)
  }, [isSmallWindow])

  const handleLinePress = useCallback((index: number) => {
    if (scrollTimoutRef.current) {
      clearTimeout(scrollTimoutRef.current)
      scrollTimoutRef.current = null
    }
    if (scrollCancelRef.current) {
      scrollCancelRef.current()
      scrollCancelRef.current = null
    }
    isPauseScrollRef.current = false
    // 点歌词行也是一次主动跳转，等同于点了浮层的播放三角：无论浮层当时是否显示，
    // 都要清掉定位态与浮层，避免「点完行之后浮层还挂在屏幕上」。
    dragStartOffsetRef.current = null
    isOverlayShownRef.current = false
    playLineRef.current?.setVisible(false)
    const line = lyricLines[index]
    if (line) {
      // 对齐上游：行点击只 seek 音频（setProgress），歌词行不立即镜像——歌词跟
      // 引擎事件走（seek 落点出声时 playing 事件重锚到落点行）。此前的
      // lrcSyncToTime 立即镜像会让行提前跳到目标、而音频还在放旧内容/缓冲。
      global.app_event.setProgress(line.time / 1000)
    }
    // 用户点击歌词行属于主动跳转：强制让歌词列表立即、无动画地定位到被点行，
    // 越过“舒适区 15%”节流与动画延迟，使高亮行与音频（及进度条）绝对同步跟随。
    setForceScroll(true)
    handleScrollToActive(index, true)
  }, [lyricLines, setForceScroll, handleScrollToActive])

  // useCallback 稳定 renderItem：依赖项均为稳定引用或低频变化值（line 每行切换变化一次），
  // 配合 LrcLine 的 memo 比较器，行切换时只有新旧激活两行重渲染。
  const renderItem: FlatListType['renderItem'] = useCallback(({ item, index }: { item: Line, index: number }) => {
    return <LrcLine line={item} lineNum={index} activeLine={line} onLayout={handleLineLayout} onPress={handleLinePress} isSmallWindow={isSmallWindow} wordsByIndex={wordsByIndex} />
  }, [line, handleLineLayout, handleLinePress, isSmallWindow, wordsByIndex])
  const getkey: FlatListType['keyExtractor'] = (_item, index) => `${index}`

  const handlePageLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const h = Math.round(nativeEvent.layout.height)
    if (h > 0) {
      pageHeightRef.current = h
      if (h !== pageHeight) setPageHeight(h)
    }
  }, [pageHeight])

  // 列表内容尺寸就绪（切歌换 key 重新挂载后的首批布局完成）：执行等待中的首跳定位。
  // 用最新行号镜像（latestLineRef），而不是 lineRef.current.line（刚被重置为 0 或残留旧歌行号）。
  const handleContentSizeChange = useCallback(() => {
    if (pendingInitialScrollTimerRef.current) {
      clearTimeout(pendingInitialScrollTimerRef.current)
      pendingInitialScrollTimerRef.current = null
    }
    if (!pendingInitialScrollRef.current) return
    pendingInitialScrollRef.current = false
    isPauseScrollRef.current = false
    handleScrollToActiveRef.current(Math.max(0, latestLineRef.current), true)
  }, [])

  return (
    <View style={{ flex: 1, width: '100%' }} onLayout={handlePageLayout} collapsable={false}>
      <FlatList
        // key 随歌词内容变化：强制重新挂载，使 initialNumToRender（整首行数）生效，
        // 首屏把每一行都渲染一次并完成实测（详见上方 lyricKey 注释）。
        key={lyricKey}
        data={lyricLines}
        renderItem={renderItem}
        keyExtractor={getkey}
        onContentSizeChange={handleContentSizeChange}
        style={{ height: pageHeight > 0 ? pageHeight : pagerHeight, width: '100%' }}
        // 歌词列表从顶部排布，当前行由 scrollToOffset(viewPosition 0.5) 定位到【中央】；
        // 不再用 justifyContent:'center' 整体垂直居中——那样是把整个列表当成一个块居中，
        // 歌词少时会整页被顶到中间、上下同时露白（即用户反馈的“被空白遮住 / 下面空白”）。
        // 这里改为「首尾各补 50% 视高留白」：内容仍从顶部开始排布，只是让第一行/最后一行
        // 也有足够空间滚到正中，行为与横屏歌词页一致。留白值必须与滚动计算的 paddingV 相等。
        contentContainerStyle={{
          paddingHorizontal: isSmallWindow ? 12 : 20,
          paddingTop: pageHeight > 0 ? pageHeight * 0.5 : 0,
          paddingBottom: pageHeight > 0 ? pageHeight * 0.5 : 0,
        }}
        ref={flatListRef}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        // 仅记录偏移，不触发重渲染；16ms 让手动滚动轨迹更平滑，同时记录精度更高。
        scrollEventThrottle={16}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        // 首屏把整首歌的歌词行全部渲染一次（而不是只渲染前 60 行）：
        // 每行高度只能由 onLayout 实测，未渲染过的行只能用「已测量行平均高度」估算。
        // 一旦播放中途拖动进度条跳到中后段，FlatList 只会渲染目标附近的窗口，
        // 开头这批行与窗口之间会留下一段“永远不渲染”的行，它们的行高只能靠估算；
        // 只要这段里出现两行及以上的长句（真实行高约为单行的 2 倍），累计偏移就会持续偏差，
        // 表现为高亮行整段偏低/偏高、怎么都回不到正中。全部渲染一次后所有行高均为实测值，
        // 累计偏移无估算误差，高亮行任何情况下都能精确居中（同时消除“歌词不全载”）。
        // 行高实测值会被 LyricScrollLayout 长期缓存，之后 FlatList 正常回收行也不影响精度。
        initialNumToRender={Math.max(lyricLines.length, 60)}
        windowSize={21}
        maxToRenderPerBatch={30}
        updateCellsBatchingPeriod={10}
        // 不向 FlatList 注册 getItemLayout：改用动态测量，避免“虚拟行 + 变高行 + 估算高度”
        // 在滚动时造成的歌词行定位错乱 / 空白缺失（即用户反馈的“滑动时歌词不全载”）。
        // 滚动目标偏移由 LyricScrollLayout 的缓存累计行高计算（O(1)）。
        extraData={[line, wordsByIndex]}
        // 禁用 removeClippedSubviews：iOS FlatList 在动态行高下回收屏幕外行后，
        // 配合 getItemLayout 估算高度常导致歌词行重绘失败 / 出现空白缺失。
        removeClippedSubviews={false}
        {...panResponder.panHandlers}
      />
      {
        // 歌词手动定位浮层：虚线压在容器正中（= 高亮行被 handleScrollToActive 居中的位置），
        // 拖动时实时跟随。topPercent 必须与定位用的 viewPosition 一致（都是 0.5），
        // 否则虚线会压在高亮行的上一行。
        isShowLyricProgress ? (
          <PlayLine ref={playLineRef} topPercent={0.5} onPlayLine={handlePlayLine} />
        ) : null
      }
    </View>
  )
}

const styles = createStyle({
  line: {
    paddingTop: 12,
    paddingBottom: 12,
  },
  lineText: {
    textAlign: 'center',
    // fontSize: 16,
    // lineHeight: 20,
    // paddingTop: 5,
    // paddingBottom: 5,
    // opacity: 0,
  },
  lineTranslationText: {
    textAlign: 'center',
    // fontSize: 13,
    // lineHeight: 17,
    paddingTop: 5,
    // paddingBottom: 5,
  },
})
