import { memo, useMemo } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
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
  const buttonRadius = useButtonRadius()

  // 整卡是一颗按钮（点击进入每日推荐）：底色与图标底框随「按钮透明度」淡出。
  // 只改颜色 alpha，不用容器 style.opacity——否则标题/副标题会一起变淡。
  const cardStyle = useMemo(
    () => StyleSheet.compose(styles.card, {
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-300'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  // 2026-10-02：图标底框由「主色实底 c-primary」改为淡灰 c-primary-background、图标改为
  // c-primary-font（主题里就等于主色 c-primary），与歌单详情页「播放全部」同一套配色 ——
  // 需求原文「推荐界面每日推荐左边的图标也改为其他颜色和灰色背景的样式」。
  // 主色图标压在原来的主色实底上会看不见，两个色必须一起改。
  const iconContentStyle = useMemo(
    () => StyleSheet.compose(styles.iconContent, {
      backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  return (
    <Pressable
      style={[
        cardStyle,
        // 整卡是一颗按钮（与「按钮透明度」的覆盖口径一致）；高度取 styles.card 的源值 72
        { borderRadius: buttonRadius(72) },
      ]}
      onPress={onPress}
    >
      <View style={iconContentStyle}>
        <SvgIcon name="calendar" size={22} color={theme['c-primary-font']} />
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
