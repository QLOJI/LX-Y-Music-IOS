import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import {
  Animated,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  TouchableOpacity,
  View,
} from 'react-native'
import { type Lines } from 'lrc-file-parser'

import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { formatPlayTime2 } from '@/utils'
import { scaleSizeW } from '@/utils/pixelRatio'
import { OVERLAY_FADE_MS } from '@/screens/PlayDetail/lyricAnimation'

// 歌词手动定位浮层：一条横向虚线 + 该行时间 + 播放三角。
// 移植自 REF（lx-music-mobile-ios-adaptation）的 PlayLine，行为一比一：
//   • 拖动歌词列表时由调用方 setVisible(true) 淡入；停手后由调用方隐藏；
//   • 虚线指向「当前定位到的那一行」——目标行 = scrollY + 视高 × topPercent
//     命中的累计行高（与调用方把该行居中到 topPercent 处保持一致）；
//   • 点播放三角回调 onPlayLine(该行时间，单位秒)，由调用方 seek。
//
// 与 REF 的差异只有两处：
//   1) 新增 topPercent（默认 0.4，与 REF 的 top:'40%' 等价）：小歌词是 3 行定高窗口、
//      定位行钉在容器正中，故传 0.5。虚线、时间、按钮三者共用同一个纵向基准，
//      所以「虚线必须压住行垂直中心」由「调用方把该行对齐到 topPercent」唯一决定，
//      不再是两套常量各算各的（这是用户点名过的问题点）。
//   2) 淡入淡出时长改用 lyricAnimation 的 OVERLAY_FADE_MS（全局动效单一来源），不再内联 300。
//
// 浮层状态（滚动信息 / 行高 / 歌词行）走命令式 handle 更新，不经过父组件 setState：
// 拖动的每一帧只会重渲染浮层自身，歌词列表与歌名块完全不动（滚动期抖动隔离的关键）。

export interface PlayLineType {
  /** 滚动信息（拖动中每帧）。传 null 表示尚未滚动过。 */
  updateScrollInfo: (scrollInfo: NativeSyntheticEvent<NativeScrollEvent>['nativeEvent'] | null) => void
  /** 列表布局：上下留白高度 + 逐行行高（与歌词行同序）。 */
  updateLayoutInfo: (listLayoutInfo: { spaceHeight: number, lineHeights: number[] }) => void
  /** 歌词行（取时间显示与 seek 目标）。 */
  updateLyricLines: (lyricLines: Lines) => void
  /** 显隐（带 OVERLAY_FADE_MS 淡入淡出）。 */
  setVisible: (visible: boolean) => void
}

export interface PlayLineProps {
  /** 点播放三角：从定位到的那一行开始播放，时间为秒。 */
  onPlayLine: (time: number) => void
  /** 定位基准线在容器内的垂直位置（0~1）。大歌词 0.4（REF 原值），小歌词 0.5（钉在正中）。 */
  topPercent?: number
}

// 虚线小段与间距：更短、间距更小 → 虚线更细、更密集
const DASH_LEN = 3
const DASH_GAP = 2
const DASH_HEIGHT = 1
// .line(虚线)是 flex:1，其后是播放三角按钮；虚线的右端距容器右缘 = 行间距 + 按钮宽
const ROW_GAP = 5
const LABEL_RIGHT_FALLBACK = 45
// 由左(浅)→右(深)渐变的不透明度区间；最深也不超过右侧播放三角(c-button-font≈0.9)
const DASH_ALPHA_MIN = 0.15
const DASH_ALPHA_MAX = 0.5
// REF 的定位线在容器 40% 处
const DEFAULT_TOP_PERCENT = 0.4

// 解析主题主色为 rgb 分量（兼容 rgb()/rgba()/hex），用于按透明度生成渐变
const parseRgb = (color: string): { r: number, g: number, b: number } | null => {
  if (!color) return null
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (m) return { r: +m[1], g: +m[2], b: +m[3] }
  const hex = color.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const n = parseInt(hex, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  return null
}

export default forwardRef<PlayLineType, PlayLineProps>(({ onPlayLine, topPercent = DEFAULT_TOP_PERCENT }, ref) => {
  const theme = useTheme()
  const [scrollInfo, setScrollInfo] = useState<NativeSyntheticEvent<NativeScrollEvent>['nativeEvent'] | null>(null)
  const [listLayoutInfo, setListLayoutInfo] = useState<{ spaceHeight: number, lineHeights: number[] }>({ spaceHeight: 0, lineHeights: [] })
  const [lyricLines, setLyricLines] = useState<Lines>([])
  const [isMounted, setIsMounted] = useState(false)
  const [dashWidth, setDashWidth] = useState(0)
  const [buttonWidth, setButtonWidth] = useState(0)
  const opsAnim = useRef<Animated.Value>(
    new Animated.Value(0),
  ).current

  const setShow = (visible: boolean) => {
    Animated.timing(opsAnim, {
      toValue: visible ? 1 : 0,
      duration: OVERLAY_FADE_MS,
      useNativeDriver: true,
    }).start(() => {
      // 淡出结束后才真正卸载：否则透明度还在过渡时浮层就被摘掉，观感是「闪一下消失」
      if (!visible) setIsMounted(false)
    })
  }

  useImperativeHandle(ref, () => ({
    updateScrollInfo(scrollInfo) {
      setScrollInfo(scrollInfo)
    },
    updateLayoutInfo(listLayoutInfo) {
      setListLayoutInfo(listLayoutInfo)
    },
    updateLyricLines(lyricLines) {
      setLyricLines(lyricLines)
    },
    setVisible(visible) {
      if (visible) {
        setIsMounted(true)
      }
      // 先挂载（让 opacity 从 0 开始）再在下一帧启动淡入，否则首次显示没有过渡
      requestAnimationFrame(() => {
        setShow(visible)
      })
    },
  }))

  const handleLineLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width
    setDashWidth((prevWidth: number) => (prevWidth == width ? prevWidth : width))
  }

  const handleButtonLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width
    setButtonWidth((prevWidth: number) => (prevWidth == width ? prevWidth : width))
  }

  if (!scrollInfo || !isMounted) return null
  // 定位基准线上方的「累计行高」：虚线指向包含基准线的那一行，而调用方保证
  // 「把定位行对齐到基准线」（行垂直中心 == 基准线），故虚线必然压在该行中心上。
  const offset = scrollInfo.contentOffset.y + scrollInfo.layoutMeasurement.height * topPercent
  let lineOffset = listLayoutInfo.spaceHeight
  let targetLineNum = -1
  for (let line = 0; line < listLayoutInfo.lineHeights.length; line++) {
    lineOffset += listLayoutInfo.lineHeights[line]
    if (lineOffset < offset) continue
    targetLineNum = line
    break
  }
  if (targetLineNum == -1) targetLineNum = listLayoutInfo.lineHeights.length - 1
  const time = lyricLines[targetLineNum]?.time ?? 0
  const timeLabel = formatPlayTime2(time / 1000)

  // 时间在渲染期算好后闭包进来：点播放三角 seek 到虚线指向的那一行（歌词时间为 ms，事件收秒）
  const handlePlayLine = () => {
    onPlayLine(time / 1000)
  }

  // 渐变颜色：左侧浅 → 右侧深，均由主题主色派生
  const rgb = parseRgb(theme['c-primary'] || theme['c-primary-alpha-300']) ?? { r: 255, g: 255, b: 255 }
  // 小色块/间距由 createStyle 按全局字体缩放，dashWidth 是缩放后的实际布局宽度；
  // 这里用缩放后的真实段宽算数量，保证任意字体大小下虚线都铺满整段、不留下右侧空白
  const dashStep = scaleSizeW(DASH_LEN) + scaleSizeW(DASH_GAP)
  const dashCount = dashWidth > 0 && dashStep > 0 ? Math.floor((dashWidth + scaleSizeW(DASH_GAP)) / dashStep) : 0
  const getDashColor = (index: number) => {
    const ratio = dashCount > 1 ? index / (dashCount - 1) : 1
    const alpha = (DASH_ALPHA_MIN + (DASH_ALPHA_MAX - DASH_ALPHA_MIN) * ratio).toFixed(2)
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
  }
  // 时间文本右对齐虚线的右端：虚线右端距容器右缘 = 缩放后的行间距 + 播放按钮宽度
  const labelRight = buttonWidth > 0 ? buttonWidth + scaleSizeW(ROW_GAP) : scaleSizeW(LABEL_RIGHT_FALLBACK)

  return (
    // 浮层铺满整个歌词容器，但 pointerEvents=box-none：
    //   • 自身不拦截触摸（虚线带 / 空白处照常能拖动歌词列表）；
    //   • 子视图（播放三角）仍在父级 bounds 之内 —— iOS 命中测试不会因为
    //     「按钮超出父视图边界」而失效（REF 的父视图只有 2pt 高，按钮其实大半在界外）。
    <Animated.View style={[styles.playLine, { opacity: opsAnim }]} pointerEvents="box-none">
      <View style={[styles.lineContent, { top: `${(topPercent * 100).toFixed(2)}%` }]} pointerEvents="box-none">
        <View style={styles.line} onLayout={handleLineLayout} pointerEvents="none">
          {
            dashCount > 0
              ? Array.from({ length: dashCount }, (_, index) => (
                <View key={index} style={{ ...styles.dash, backgroundColor: getDashColor(index) }} />
              ))
              : null
          }
        </View>
        <View pointerEvents="none" style={{ ...styles.label, right: labelRight }}>
          <Text color={theme['c-primary-font']} size={13}>{timeLabel}</Text>
        </View>
        <TouchableOpacity style={styles.button} onLayout={handleButtonLayout} onPress={handlePlayLine}>
          <Icon name="play" color={theme['c-button-font']} size={18} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  )
})

const styles = createStyle({
  playLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  lineContent: {
    position: 'absolute',
    width: '100%',
    // 高度加高，使时间文本能整体浮在虚线之上；包裹层以基准线为中心（上移半高），
    // 因此虚线正好压在基准线上，而基准线由调用方对齐到目标行的垂直中心。
    height: 34,
    marginTop: -17,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
  },
  line: {
    marginLeft: 30,
    // iOS 对 1px 高度的 dashed 边框渲染不可靠（不可见），
    // 这里改为由若干个细短的小色块（dash）自行拼出虚线，保证可见
    height: DASH_HEIGHT,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  dash: {
    width: DASH_LEN,
    height: DASH_HEIGHT,
    marginRight: DASH_GAP,
  },
  label: {
    position: 'absolute',
    // 时间文本浮在虚线之上并基本贴线：只锚定底部（距容器底 16），右对齐由外层动态 right 控制。
    // 数字行盒下方约含 2-3px 空白(descender)，故文字实际下缘与虚线的间距 ≈ 虚线点间距(2px)
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  button: {
    flex: 0,
    paddingLeft: 5,
    paddingRight: 15,
  },
})
