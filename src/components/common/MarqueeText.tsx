import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import Text, { type TextProps } from '@/components/common/Text'

/**
 * 超出一行宽度的文本 → 从右到左滚动（跑马灯）；放得下就是静态文本，不花任何动画开销。
 *
 * 【第 30 轮·图十】需求原话：
 *   「如果歌名过长无法显示完整，目前是增加...，改为从右到左的滚动显示，动画速率适中，
 *     目前有显示不全的地方包括迷你播放器栏、所有歌单列表的歌曲等，这些都改为滚动显示，
 *     歌单封面下面的文字和简介部分不改成滚动显示。」
 * 所以：歌名（迷你播放器 / 在线列表 / 歌单列表 / WebDAV 列表）用本组件；
 * 「歌单封面下面的文字」（歌单名 / 歌曲数）和「歌手、歌单简介」不用 —— 简介改为上下滑动查看
 * （见 SonglistDetail/index.tsx 与 ArtistDetail/Header.tsx）。
 *
 * 速率「适中」：30px/s（原 PlayDetail/Vertical/components/Marquee.tsx 那份没人用的实现是
 * (宽度+50)×35ms，约 28~35px/s，这里取整成常量 MARQUEE_SPEED_PX_PER_S）。
 * 只在实际放不下时才滚动；两端各停一拍（MARQUEE_PAUSE_MS）再回到开头。
 *
 * 测量方式沿用上面那份旧实现（先量容器、再量文本自身帧宽，文本比容器宽才启动），但：
 *   · 内层行宽用 '1000%' 是为了让文本**不被容器宽度约束**（Yoga 对行内子节点按父宽 AtMost
 *     测量，会被截断成容器宽 → 永远量不出溢出；旧实现同一处也用了这个办法）；
 *   · 文本变化时把位置复位（否则新歌名会带着上一首的偏移出现），宽度由 onLayout 重新量；
 *   · 单一 Animated.Value + useNativeDriver，delay 节点自己带独立的 Value，不存在
 *     「JS 驱动动画跑在已转 native 的节点上」那种 Fatal（见 common/Text.tsx 的长注释）。
 */
export const MARQUEE_SPEED_PX_PER_S = 30
/** 滚到末尾后留出的间隔（第二份副本贴在第一份后面，间隔即首尾之间的空隙） */
const MARQUEE_GAP_PX = 60
/** 起点 / 终点各停留一拍 */
const MARQUEE_PAUSE_MS = 900

export interface MarqueeTextProps extends Omit<TextProps, 'numberOfLines'> {
  /** 用于判断「文本变了要复位」以及（无 children 时）实际显示的文本 */
  text: string
  /**
   * 需要保留富文本（如歌名后面灰字的别名）时传它：渲染用 children，变更检测仍看 text。
   * 两个副本共用同一份 children（纯展示，不进任何列表 key）。
   */
  children?: ReactNode
  /** 可视区（容器）样式：宽度由使用方决定，内部只做 overflow 裁剪与垂直居中 */
  containerStyle?: StyleProp<ViewStyle>
}

export default memo(({ text, children, containerStyle, ...props }: MarqueeTextProps) => {
  const containerWidthRef = useRef(0)
  const textWidthRef = useRef(0)
  // >0 表示「放不下，需要滚动」，值就是一次循环要走的距离（文本宽 + 间隔）
  const [distance, setDistance] = useState(0)
  const translateX = useRef(new Animated.Value(0)).current

  const measure = useCallback(() => {
    const textWidth = textWidthRef.current
    const containerWidth = containerWidthRef.current
    setDistance(
      containerWidth > 0 && textWidth > containerWidth
        ? textWidth + MARQUEE_GAP_PX
        : 0,
    )
  }, [])

  const handleContainerLayout = useCallback((e: LayoutChangeEvent) => {
    containerWidthRef.current = e.nativeEvent.layout.width
    measure()
  }, [measure])

  const handleTextLayout = useCallback((e: LayoutChangeEvent) => {
    textWidthRef.current = e.nativeEvent.layout.width
    measure()
  }, [measure])

  // 文本变了先复位：新文本若宽度不同会走 onLayout 重新计算；宽度恰好相同则沿用旧距离
  // （同宽 ⇒ 溢出量不变，仍是对的）。
  useEffect(() => {
    translateX.setValue(0)
  }, [text, translateX])

  useEffect(() => {
    if (!distance) {
      translateX.setValue(0)
      return
    }
    const duration = Math.round((distance / MARQUEE_SPEED_PX_PER_S) * 1000)
    translateX.setValue(0)
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(MARQUEE_PAUSE_MS),
        Animated.timing(translateX, {
          toValue: -distance,
          duration,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        // 第二份副本此刻正好落在起点位置，瞬时归零 = 无缝衔接（不再有额外的空档）
        Animated.timing(translateX, {
          toValue: 0,
          duration: 0,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.delay(MARQUEE_PAUSE_MS),
      ]),
    )
    animation.start()
    return () => { animation.stop() }
  }, [distance, translateX])

  return (
    <View
      style={[styles.container, containerStyle]}
      onLayout={handleContainerLayout}
    >
      <Animated.View style={[styles.row, { transform: [{ translateX }] }]}>
        <Text {...props} numberOfLines={1} onLayout={handleTextLayout}>
          {children ?? text}
        </Text>
        {distance > 0 ? (
          <Text {...props} numberOfLines={1} style={[props.style, styles.repeat]}>
            {children ?? text}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    // 见文件头注释：给足「不被容器约束」的测量宽度
    width: '1000%',
  },
  repeat: {
    marginLeft: MARQUEE_GAP_PX,
  },
})
