import { memo, type ComponentProps } from 'react'
import { Text, type TextProps as _TextProps, StyleSheet, Animated, type ColorValue, type TextStyle } from 'react-native'
import { useTextShadow, useTheme } from '@/store/theme/hook'
import { setSpText } from '@/utils/pixelRatio'
import { useAnimateColor } from '@/utils/hooks/useAnimateColor'
import { DEFAULT_DURATION, useAnimateNumber } from '@/utils/hooks/useAnimateNumber'
import { designTypography } from '@/theme/DesignTokens'
// import { AppColors } from '@/theme'

export interface TextProps extends _TextProps {
  /**
   * 字体大小
   */
  size?: number
  /**
   * 字体颜色
   */
  color?: ColorValue
}

// const warpText = <P extends TextProps>(Component: ComponentType<TextProps>) => {
//   return ({ style, size = 15, color, children, ...props }: P) => {
//     const theme = useTheme()
//     return (
//       <Component
//         style={StyleSheet.compose({ fontFamily: 'System', fontSize: setSpText(size), color: color ?? theme['c-font'] }, style)}
//         {...props}
//       >{children}</Component>
//     )
//   }
// }

export default memo(({ style, size = 15, color, children, ...props }: TextProps) => {
  const theme = useTheme()
  const textShadow = useTextShadow()
  // 全局行高基线（A-6）：只注入默认值，不覆盖页面显式传的 lineHeight —— compose 里传入的
  // style 在后、优先级更高，页面级 lineHeight 原样生效。比例取自 designTypography.lineHeightRatio
  // （≈1.2×字号，与 iOS 自然行高相当）；基准取 style 里已生效的 fontSize，避免
  // 「页面写 fontSize: 14、size 用默认 15」时行高按 15 误算（小字号档误差可达 ±1pt）。
  const defaultLineHeight = Math.round(
    (StyleSheet.flatten(style)?.fontSize ?? setSpText(size)) * designTypography.lineHeightRatio,
  )
  style = StyleSheet.compose(textShadow ? {
    // fontFamily: 'System',
    textShadowColor: theme['c-primary-dark-300-alpha-800'],
    textShadowOffset: { width: 0.2, height: 0.2 },
    textShadowRadius: 2,
    fontSize: setSpText(size),
    lineHeight: defaultLineHeight,
    color: color ?? theme['c-font'],
  } : {
    // fontFamily: 'System',
    fontSize: setSpText(size),
    lineHeight: defaultLineHeight,
    color: color ?? theme['c-font'],
  }, style)

  return (
    <Text
      style={style}
      {...props}
    >{children}</Text>
  )
})

export interface AnimatedTextProps extends _AnimatedTextProps {
  /**
   * 字体大小
   */
  size?: number
  /**
   * 字体颜色
   */
  color?: ColorValue
}
export const AnimatedText = ({ style, size = 15, color, children, ...props }: AnimatedTextProps) => {
  const theme = useTheme()
  const textShadow = useTextShadow()
  // 同默认 Text：全局行高基线（A-6），页面显式 lineHeight 优先
  const defaultLineHeight = Math.round(
    (StyleSheet.flatten(style as TextStyle)?.fontSize ?? setSpText(size)) * designTypography.lineHeightRatio,
  )
  style = StyleSheet.compose(textShadow ? {
    // fontFamily: 'System',
    textShadowColor: theme['c-primary-dark-300-alpha-800'],
    textShadowOffset: { width: 0.2, height: 0.2 },
    textShadowRadius: 2,
    fontSize: setSpText(size),
    lineHeight: defaultLineHeight,
    color: color ?? theme['c-font'],
  } : {
    // fontFamily: 'System',
    fontSize: setSpText(size),
    lineHeight: defaultLineHeight,
    color: color ?? theme['c-font'],
  }, style as TextStyle)

  return <Animated.Text style={style} {...props}>{children}</Animated.Text>
}


type _AnimatedTextProps = ComponentProps<(typeof Animated)['Text']>
export interface AnimatedColorTextProps extends _AnimatedTextProps {
  /**
   * 字体大小
   */
  size?: number
  /**
   * 字体颜色
   */
  color?: string
  /**
   * 字体透明度
   */
  opacity?: number
  /**
   * 透明度过渡时长(ms)。默认 DEFAULT_DURATION(800)，用于主题/切歌平滑过渡。
   * 歌词整行高亮的「不生硬」来源是把颜色与透明度拆开：duration 单独驱动透明度淡入，
   * 颜色切换另见 colorDuration。
   */
  duration?: number
  /**
   * 颜色过渡时长(ms)。不传时取 duration，全应用既有调用点行为不变；
   * 传 0 表示颜色瞬时切换（useAnimateColor 会折算成 1ms 兜底，见其注释）。
   * 歌词行高亮用 colorDuration={0} 搭配 duration=淡入时长，即「颜色即时 + 透明度淡入」。
   */
  colorDuration?: number
}
export const AnimatedColorText = ({ style, size = 15, opacity: _opacity, color: _color, duration, colorDuration, children, ...props }: AnimatedColorTextProps) => {
  const theme = useTheme()
  const textShadow = useTextShadow()
  // 同默认 Text/AnimatedText：全局行高基线（A-6），页面显式 lineHeight 优先 ——
  // 歌词两条路径都显式传了 lineHeight，不受这里影响。
  const defaultLineHeight = Math.round(
    (StyleSheet.flatten(style as TextStyle)?.fontSize ?? setSpText(size)) * designTypography.lineHeightRatio,
  )

  // 颜色时长与透明度时长解耦：歌词高亮要求颜色立即切换（否则换行后高亮行颜色滞后），
  // 但透明度需要淡入才不生硬。默认 colorDuration=duration，保持全应用既有行为
  // （主题/切歌 800ms 过渡）不受影响；只有显式传值（歌词行 colorDuration={0}）才分流。
  // 注意：无论分流与否，color 与 opacity 两个节点都必须同为 useNativeDriver:true（见下方注释）。
  const [color] = useAnimateColor(_color ?? theme['c-font'], colorDuration ?? duration ?? DEFAULT_DURATION)
  // opacity 必须与 color 同为原生驱动：二者挂在同一个 Animated.Text 的 style 上，
  // RN 原生动画启动时 __makeNative 会沿共享 props 图传播，把 opacity 节点也标记为
  // native；若 opacity 仍走 JS 驱动（false），切歌歌词行 opacity 变化时对已标记
  // native 的节点启动 JS 动画会直接 Fatal："Attempting to run JS driven animation
  // on animated node that has been moved to 'native' earlier..."（表现为播放详情页
  // 切歌即崩，JS 线程停止后只剩背景层 = 全屏封面底色）。opacity 在原生驱动白名单
  // 内，转 true 后两个节点驱动方式一致，混用即消除。
  const [opacity] = useAnimateNumber(_opacity ?? 1, duration ?? DEFAULT_DURATION, true)

  style = StyleSheet.compose(textShadow ? {
    // fontFamily: 'System',
    textShadowColor: theme['c-primary-dark-300-alpha-800'],
    textShadowOffset: { width: 0.2, height: 0.2 },
    textShadowRadius: 2,
    fontSize: setSpText(size),
    lineHeight: defaultLineHeight,
    color: color as unknown as ColorValue,
    opacity,
  } : {
    // fontFamily: 'System',
    fontSize: setSpText(size),
    lineHeight: defaultLineHeight,
    color: color as unknown as ColorValue,
    opacity,
  }, style as TextStyle)

  return <Animated.Text style={style} {...props}>{children}</Animated.Text>
}
