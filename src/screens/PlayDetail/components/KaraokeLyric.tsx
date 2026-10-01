import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, type LayoutChangeEvent, type StyleProp, type TextStyle, View } from 'react-native'

import Text from '@/components/common/Text'
import KaraokeLine from './KaraokeLine'
import { audioClock } from '@/core/player/audioClock'
import { findLineIndexByTime, getWordState, useLrcSet } from '@/plugins/lyric'
import { useTheme } from '@/store/theme/hook'
import { useIsPlay } from '@/store/player/hook'
import { createStyle } from '@/utils/tools'
import type { LxLyricWord } from '@/plugins/lxLyricPlayer'

// 逐字（卡拉OK）歌词行渲染器。两种数据来源，同一个出口：
//
//  1) words：lxlyric 的逐字时间轴（useLrcWordsMap 提供，与歌词行同序，纯 LRC 行为 null）。
//     按每个字的真实起止时间高亮，时间取自 audioClock 外推时钟 —— 快进/快退/拖动进度条后
//     高亮立即跟随音频真实位置。大歌词（Vertical/Horizontal Lyric）走这条；行级 ticker 短暂失步
//     （seek/缓冲恢复的重锚窗口）时由跨行钳制兜底（见 KaraokeWords 内注释）。
//
//  2) text + startTime/endTime：没有逐字时间戳时按「字符数均分该行时长」做线性高亮。
//     进度用 **单个 Animated.Value + interpolate** 驱动：rAF 每帧只写一次这个值，
//     再由它插值出高亮遮罩的宽度 —— 绝不逐字 setState（那会让每个字都触发一次
//     React 重渲染并掉帧）。小歌词启用「逐字高亮」开关、且该行没有逐字时间戳时走这条。
//
// 两种模式下「已唱 / 未唱」都是同一套两色接口：playedColor / inactiveColor
// （不传时按主题兜底，调用方仍可显式指定，保持向后兼容）。

export interface KaraokeLyricProps {
  /** 逐字时间戳（优先）。 */
  words?: LxLyricWord[] | null
  /** 行起始时间（ms），words 模式使用。 */
  lineTime?: number
  /** 整行文本，无逐字时间戳时的降级路径。 */
  text?: string
  /** text 模式的行起止时间（ms）。 */
  startTime?: number
  endTime?: number
  /** 字号（design pt，由 Text 组件按全局字体缩放）。 */
  size: number
  /** 已唱部分颜色。 */
  playedColor?: string
  /** 未唱部分颜色。 */
  inactiveColor?: string
  /** 文字样式（行高/对齐等），接受样式数组，方便调用方直接把手里的 memo 样式传进来。 */
  style?: StyleProp<TextStyle>
  isActive: boolean
  /** 单行省略：小歌词每行定高，超长行必须省略号截断而不是换行（换行会破坏定高与居中）。 */
  numberOfLines?: number
}

// 跨行钳制的容差（ms）：行级 ticker 的换行由歌词引擎内部定时器驱动，正常换行可能比
// audioClock 外推晚一拍；「音频时间扣掉本容差后仍落在本行之后的行」才判定为明显跨行。
const OUT_OF_LINE_MS = 500

// 时间轴逐字渲染：自带 rAF 循环，根据 audioClock 外推时钟实时计算当前字索引与进度，
// 仅重渲染本组件（不触发整张歌词列表重渲染）。务必与音频绝对同步：时间来自 audioClock，
// 因此快进/快退/拖动进度条后，当前字的高亮会立即跟随音频真实位置。
const KaraokeWords = memo(({
  words,
  lineTime,
  size,
  playedColor,
  inactiveColor,
  style,
  isActive,
  numberOfLines,
}: {
  words: LxLyricWord[]
  lineTime: number
  size: number
  playedColor: string
  inactiveColor: string
  style?: StyleProp<TextStyle>
  isActive: boolean
  numberOfLines?: number
}) => {
  const [state, setState] = useState({ index: -1, progress: 0 })
  const stateRef = useRef(state)
  // 播放态：暂停/停止时停掉逐字 rAF（见下）。
  const isPlay = useIsPlay()
  // 歌词行表（与调用方同一份 currentLines）：跨行钳制要判断「音频时间应该在哪一行」，
  // 复用现成的 findLineIndexByTime 二分查找，不另造行查找逻辑。
  const lines = useLrcSet()

  useEffect(() => {
    // 非激活行静态渲染：停掉 rAF、进度归零（全部字用未播放颜色）。
    // 激活/非激活共用同一渲染器是为了让行的换行布局恒定——若激活时才切换渲染器，
    // 嵌套 Text 与纯文本的换行断点不同，行高会在切行瞬间突变（抖动 + 居中偏移）。
    if (!isActive) {
      stateRef.current = { index: -1, progress: 0 }
      setState(stateRef.current)
      return
    }
    // 暂停即停帧（cancel，不是让循环空转）：audioClock 暂停期间不再推进，tick 只会逐帧
    // 算出同一状态，但帧请求照样逐帧唤醒 JS 线程——这个循环的唤醒成本固定在整屏歌词行数上，
    // 暂停时不省就是白烧。这里【不清零逐字状态】：已唱的字要保持亮着（归零会让整行瞬间褪色、
    // 恢复播放时再跳回来）。恢复播放后 effect 重跑，第一帧按冻结的时钟算出的仍是当前状态，
    // 天然无缝。
    if (!isPlay) return
    // 本行在行表中的位置（按起点时间精确匹配：调用方传入的 lineTime 就是本行 time）。
    // 匹配不到（行表未就绪/非当前歌词表）时不启用钳制，保守跳过。
    const myLineIndex = lines.findIndex((l) => l.time === lineTime)
    let raf = 0
    const tick = () => {
      // audioClock 返回秒，歌词时间为毫秒
      const t = audioClock.getTime() * 1000
      let s = getWordState(words, t - lineTime)
      // 【跨行钳制】行级 ticker 尚未重锚时（seek/缓冲恢复的重锚被状态抖动丢弃的窗口），
      // 激活行会停在旧行，而 audioClock 已推进到新位置：继续用 t - lineTime 相减得到的
      // 巨值会把旧行渲染成「整行已唱完」（进度越界成 1），表现为整行颜色错位。用现成的
      // 行二分查找判断：「音频时间扣掉容差后仍落在本行之后的行」= 本行明显已不是当前行，
      // 本帧钳为未播放（index=-1/progress=0），绝不基于错误行的起点硬算。保守边界：本行
      // 不在行表（myLineIndex<0，如空表/时间不匹配）或已是末行时不钳制；容差内的正常
      // 换行（ticker 落后 audioClock 一拍）不受影响。
      if (
        s.index >= 0 && myLineIndex >= 0 &&
        findLineIndexByTime(lines, t - OUT_OF_LINE_MS) > myLineIndex
      ) {
        s = { index: -1, progress: 0 }
      }
      const prev = stateRef.current
      // 量化到 2% 步长 + 跨字才更新，过滤掉无视觉差异的逐帧重渲染，降低 Bridge 开销。
      if (prev.index !== s.index || Math.abs(prev.progress - s.progress) >= 0.02) {
        stateRef.current = s
        setState(s)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf) }
  }, [words, lineTime, isActive, isPlay, lines])

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      <KaraokeLine
        words={words}
        activeWordIndex={state.index}
        activeWordProgress={state.progress}
        size={size}
        playedColor={playedColor}
        inactiveColor={inactiveColor}
      />
    </Text>
  )
})

// 进度写入的最小步长：量化到 1/240（120Hz 下一帧的行内进度变化约 1/120），
// 无视觉差异的帧直接跳过，避免把每一帧都推到原生侧。
const PROGRESS_STEP = 1 / 240

// 无逐字时间戳时的线性高亮：rAF 读 audioClock 算出「行内已播放比例」写进 Animated.Value，
// 再由它插值出高亮遮罩宽度。文本只渲染一次、排版永不变化（不会因为高亮而重排/抖动），
// 每帧的产物只有一次 Animated.Value 写入 + 一次遮罩宽度更新。
const KaraokeText = memo(({
  text,
  startTime,
  endTime,
  size,
  playedColor,
  inactiveColor,
  style,
  isActive,
  numberOfLines,
}: {
  text: string
  startTime: number
  endTime: number
  size: number
  playedColor: string
  inactiveColor: string
  style?: StyleProp<TextStyle>
  isActive: boolean
  numberOfLines?: number
}) => {
  const progress = useRef<Animated.Value>(new Animated.Value(0)).current
  // 整行实测宽度：遮罩内层用同一个宽度渲染，保证上下两层文字逐像素对齐
  const [lineWidth, setLineWidth] = useState(0)
  const lastProgressRef = useRef(0)
  // 播放态：暂停/停止时停掉逐字 rAF（见下）。
  const isPlay = useIsPlay()

  useEffect(() => {
    if (!isActive) {
      // 非激活行不需要动画：进度归零（全部字用未播放色）并停掉 rAF，屏幕外的行不白跑
      lastProgressRef.current = 0
      progress.setValue(0)
      return
    }
    // 暂停即停帧（原因同 KaraokeWords）；同样【保留当前高亮进度】，不清零——
    // 归零会让暂停瞬间已唱部分整段褪色、恢复后再一次性跳回来。
    if (!isPlay) return
    let raf = 0
    // 行时长兜底 1ms：相邻两行时间戳相同（或末行无下一行时间）时不能除零
    const duration = Math.max(endTime - startTime, 1)
    const tick = () => {
      // audioClock 返回秒，歌词时间为毫秒
      const elapsed = audioClock.getTime() * 1000 - startTime
      const next = Math.min(Math.max(elapsed / duration, 0), 1)
      if (Math.abs(next - lastProgressRef.current) >= PROGRESS_STEP || next === 0 || next === 1) {
        lastProgressRef.current = next
        progress.setValue(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf) }
  }, [startTime, endTime, isActive, isPlay, progress, text])

  const handleLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const width = Math.round(nativeEvent.layout.width)
    if (width > 0) setLineWidth((prev) => (prev === width ? prev : width))
  }, [])

  const maskStyle = useMemo(() => ({
    width: progress.interpolate({ inputRange: [0, 1], outputRange: [0, lineWidth] }),
  }), [progress, lineWidth])

  return (
    <View style={styles.karaokeContainer} onLayout={handleLayout}>
      <Text size={size} color={inactiveColor} style={style} numberOfLines={numberOfLines}>{text}</Text>
      {/* 已唱部分：同一行文字再渲染一层（播放色），用 overflow:hidden 的遮罩从左往右露出。
          遮罩内层必须撑满整行宽度——只裁宽度不改排版，字与底层逐像素重合。 */}
      <View style={[styles.karaokeMask, maskStyle]} pointerEvents="none">
        <View style={{ width: lineWidth }}>
          <Text size={size} color={playedColor} style={style} numberOfLines={numberOfLines}>{text}</Text>
        </View>
      </View>
    </View>
  )
})

const KaraokeLyric = ({
  words,
  text,
  ...props
}: KaraokeLyricProps) => {
  const theme = useTheme()
  // 颜色兜底：歌词高亮色沿用播放详情页的既有取色（暗色下用正文色、亮色下用主色）
  const playedColor = props.playedColor ?? (theme.isDark ? theme['c-font'] : theme['c-primary'])
  const inactiveColor = props.inactiveColor ?? theme['c-font-label']

  // words 只要「给了」就走时间轴模式（空数组也保持与旧行为一致：渲染空内容但保留行盒高度），
  // 只有明确没有逐字时间戳（words 为 null/undefined）时才降级到文本均分模式
  if (words != null) {
    return (
      <KaraokeWords
        words={words}
        lineTime={props.lineTime ?? 0}
        size={props.size}
        style={props.style}
        isActive={props.isActive}
        numberOfLines={props.numberOfLines}
        playedColor={playedColor}
        inactiveColor={inactiveColor}
      />
    )
  }
  if (text != null && text !== '') {
    return (
      <KaraokeText
        text={text}
        startTime={props.startTime ?? 0}
        endTime={props.endTime ?? 0}
        size={props.size}
        style={props.style}
        isActive={props.isActive}
        numberOfLines={props.numberOfLines}
        playedColor={playedColor}
        inactiveColor={inactiveColor}
      />
    )
  }
  return null
}

const styles = createStyle({
  karaokeContainer: {
    position: 'relative',
    // 撑满行宽：遮罩宽度按实测行宽计算，行宽必须与容器宽度一致
    alignSelf: 'stretch',
  },
  karaokeMask: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    // iOS 上裁剪必须由 overflow:hidden 承担（宽度变化不重排文字）
    overflow: 'hidden',
  },
})

export default memo(KaraokeLyric)
