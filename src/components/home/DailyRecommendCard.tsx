import { memo, useMemo } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { SvgIcon } from '@/components/common/Icon'
import Text from '@/components/common/Text'

interface DailyRecommendCardProps {
  title: string
  subtitle: string
  onPress: () => void
}

const styles = createStyle({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 72,
    paddingHorizontal: designSpacing.md,
    borderRadius: designRadius.md,
  },
  iconContent: {
    width: 44,
    height: 44,
    borderRadius: designRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    paddingLeft: designSpacing.sm,
  },
  title: {
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 2,
  },
})

const DailyRecommendCard = memo(({ title, subtitle, onPress }: DailyRecommendCardProps) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')

  // 整卡是一颗按钮（点击进入每日推荐）：底色与图标底框随「按钮透明度」淡出。
  // 只改颜色 alpha，不用容器 style.opacity——否则标题/副标题会一起变淡。
  const cardStyle = useMemo(
    () => StyleSheet.compose(styles.card, {
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-300'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  const iconContentStyle = useMemo(
    () => StyleSheet.compose(styles.iconContent, {
      backgroundColor: applyOpacity(theme['c-primary'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  return (
    <Pressable style={cardStyle} onPress={onPress}>
      <View style={iconContentStyle}>
        <SvgIcon name="calendar" size={22} color={theme['c-primary-light-1000']} />
      </View>
      <View style={styles.content}>
        <Text style={styles.title} size={designTypography.title} color={theme['c-font']}>
          {title}
        </Text>
        <Text style={styles.subtitle} size={designTypography.body} color={theme['c-font-label']} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  )
})
DailyRecommendCard.displayName = 'HomeDailyRecommendCard'
export default DailyRecommendCard
