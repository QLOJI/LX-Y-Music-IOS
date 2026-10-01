import { memo, useMemo } from 'react'
import { Pressable, ScrollView } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { createStyle } from '@/utils/tools'
import { designSpacing, designTypography } from '@/theme/DesignTokens'
import Text from '@/components/common/Text'

export interface PlatformOption {
  id: string
  label: string
}

interface PlatformChipsProps {
  options: PlatformOption[]
  selectedId: string
  onChange: (id: string) => void
  /** 嵌入已带水平内边距的容器（如歌单页头部）时关闭自带的左右内边距 */
  noInset?: boolean
}

const styles = createStyle({
  scroll: {
    flexGrow: 0,
  },
  content: {
    paddingHorizontal: designSpacing.lg,
    paddingRight: designSpacing.md,
  },
  contentBare: {
    // 用于无父容器内边距的场景（如歌单页头部）：滚动范围直达屏幕两缘，
    // 仅通过内容内边距保证首屏位置与标题对齐、末尾胶囊不贴边
    paddingLeft: designSpacing.lg,
    paddingRight: designSpacing.lg,
  },
  chip: {
    height: 34,
    paddingHorizontal: designSpacing.md,
    marginRight: designSpacing.sm,
    borderRadius: 999,
    justifyContent: 'center',
    borderWidth: 1,
  },
  label: {
    fontWeight: '600',
  },
})

const PlatformChips = memo(({ options, selectedId, onChange, noInset }: PlatformChipsProps) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()

  // 胶囊的底色与边框随「按钮透明度」淡出；只改颜色 alpha，不能用容器 style.opacity
  // ——那会把文字一起变淡，而需求是 0 时「只剩文字」。激活态（c-primary 实底）同样处理，
  // 否则未激活的透明了、当前选中的平台却还是实心，出现割裂。
  const activeChipStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary'], buttonOpacity),
      borderColor: applyOpacity(theme['c-primary'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  const inactiveChipStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-300'], buttonOpacity),
      borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={noInset ? styles.contentBare : styles.content}
      horizontal
      showsHorizontalScrollIndicator={false}
      // 嵌套滚动容器内按钮触摸立即下发，避免概率性点击无响应
      delaysContentTouches={false}
    >
      {options.map((option) => {
        const isActive = option.id === selectedId
        return (
          <Pressable
            key={option.id}
            style={[
              styles.chip,
              isActive ? activeChipStyle : inactiveChipStyle,
              // 胶囊圆角随「按钮圆角」设置行内覆盖；高度取 styles.chip 的源值 34（胶囊自身高度）
              { borderRadius: buttonRadius(34) },
            ]}
            onPress={() => { onChange(option.id) }}
          >
            <Text
              style={styles.label}
              size={designTypography.body}
              color={isActive ? theme['c-primary-light-1000'] : theme['c-font']}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
})
PlatformChips.displayName = 'HomePlatformChips'
export default PlatformChips
