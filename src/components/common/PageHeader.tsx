import { memo, useMemo } from 'react'
import { View } from 'react-native'

import { useTheme } from '@/store/theme/hook'
import { useStatusbarHeight } from '@/store/common/hook'
import { createStyle } from '@/utils/tools'
import { designSpacing, pageTitleGap, pageTitleLineHeight } from '@/theme/DesignTokens'
import Text from './Text'

interface PageHeaderProps {
  title: string
}

const PageHeader = memo(({ title }: PageHeaderProps) => {
  const theme = useTheme()
  const statusBarHeight = useStatusbarHeight()

  // paddingTop 与推荐页（Discovery）头部保持同一公式，两个页面的标题才会落在同一水平线上。
  // 此前这里是 statusBarHeight + designSpacing.sm（=12），而推荐页是
  // max(designSpacing.sm, statusBarHeight - designSpacing.md)（= max(12, h - 16)），
  // 两者恒差 26~28pt（iPhone 59 状态栏下 77 vs 49），表现为「设置页标题明显比推荐页低一截」。
  // 注意 useStatusbarHeight 内部已叠加常量偏移 STATUSBAR_TOP_OFFSET(=6)，这里不要再加。
  const paddingTop = useMemo(
    () => Math.max(designSpacing.sm, statusBarHeight - designSpacing.md),
    [statusBarHeight],
  )

  return (
    <View style={[styles.container, { paddingTop }]}>
      <Text style={styles.title} size={34} color={theme['c-font']}>
        {title}
      </Text>
    </View>
  )
})

const styles = createStyle({
  container: {
    paddingHorizontal: designSpacing.lg,
    // 标题行 → 下方第一行内容的统一间距（原写死 sm=12，比推荐/歌单/我的/搜索页的 16 少 4pt，
    // 「设置」页的分类列表因此比别的页贴得近一点。本组件当前只被设置页使用，改这里不波及其他页）
    paddingBottom: pageTitleGap,
  },
  title: {
    fontWeight: '800',
    // 34pt 页面大标题统一行高（原不写 lineHeight，落到 Text 的兜底 = round(34 × 1.15) ≈ 39，
    // 与推荐/歌单/我的/搜索页的 42 差 3pt）
    lineHeight: pageTitleLineHeight,
  },
})

PageHeader.displayName = 'CommonPageHeader'
export default PageHeader
