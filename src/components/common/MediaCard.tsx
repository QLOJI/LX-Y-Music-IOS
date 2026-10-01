import { memo, useMemo } from 'react'
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle, type ImageStyle } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { useButtonRadius } from '@/utils/buttonRadius'
import Image from './Image'
import Text from './Text'

const styles = createStyle({
  card: {
    width: 148,
  },
  image: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: designRadius.md,
    marginBottom: designSpacing.sm,
  },
  title: {
    fontWeight: '600',
  },
  subtitle: {
    marginTop: 2,
  },
})

interface MediaCardProps {
  url?: string | number | null
  title: string
  subtitle?: string
  onPress?: () => void
  style?: StyleProp<ViewStyle>
  imageStyle?: StyleProp<ImageStyle>
}

export default memo(({ url, title, subtitle, onPress, style, imageStyle }: MediaCardProps) => {
  const theme = useTheme()
  // 「按钮圆角」：封面为正方形（卡片默认宽 148 × aspectRatio 1），按自身设计高度 148 行内覆盖
  const buttonRadius = useButtonRadius()

  const cardStyle = useMemo(
    () => StyleSheet.compose(styles.card, style),
    [style],
  )

  const titleStyle = useMemo(
    () => StyleSheet.compose(styles.title, {
      color: theme['c-font'],
    }),
    [theme],
  )

  const subtitleStyle = useMemo(
    () => StyleSheet.compose(styles.subtitle, {
      color: theme['c-font-label'],
    }),
    [theme],
  )

  // 「按钮圆角」：静态 styles.image.borderRadius 保留作兜底，调用方 imageStyle 仍优先
  const coverStyle = useMemo(
    () => StyleSheet.compose(StyleSheet.compose(styles.image, { borderRadius: buttonRadius(148) }), imageStyle),
    [buttonRadius, imageStyle],
  )

  return (
    <Pressable style={cardStyle} onPress={onPress} disabled={!onPress}>
      <View>
        <Image style={coverStyle} url={url} />
      </View>
      <Text style={titleStyle} size={designTypography.body} numberOfLines={2}>{title}</Text>
      {subtitle ? <Text style={subtitleStyle} size={designTypography.caption} numberOfLines={1}>{subtitle}</Text> : null}
    </Pressable>
  )
})
