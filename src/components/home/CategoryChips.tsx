import { memo, useMemo } from 'react'
import { Pressable, ScrollView } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import Text from '@/components/common/Text'

interface CategoryChipsProps {
  options: Array<{ id: string, label: string }>
  selectedId: string
  onChange: (id: string) => void
}

const styles = createStyle({
  scroll: {
    flexGrow: 0,
  },
  content: {
    paddingHorizontal: designSpacing.lg,
    paddingRight: designSpacing.md,
    paddingVertical: 2,
  },
  chip: {
    height: 34,
    paddingHorizontal: designSpacing.md,
    marginRight: designSpacing.xs,
    borderRadius: designRadius.pill,
    justifyContent: 'center',
    borderWidth: 1,
  },
  label: {
    fontWeight: '600',
  },
})

const CategoryChips = memo(({ options, selectedId, onChange }: CategoryChipsProps) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()

  // 底色/边框随「按钮透明度」淡出，文字色不动。不用容器 style.opacity：
  // 那会把胶囊里的文字一并变淡，0 时就「什么都不剩」而非「只剩文字」。
  // 激活态（c-primary 实底）一起处理，避免未激活透明、激活实心的割裂。
  const activeChipStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary'], buttonOpacity),
      borderColor: applyOpacity(theme['c-primary'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  const inactiveChipStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-200'], buttonOpacity),
      borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {options.map((option) => {
        const isActive = option.id === selectedId
        return (
          <Pressable
            key={option.id}
            style={[
              styles.chip,
              isActive ? activeChipStyle : inactiveChipStyle,
              // 胶囊圆角随「按钮圆角」设置行内覆盖；高度取 styles.chip 的源值 34（标签胶囊自身高度）
              { borderRadius: buttonRadius(34) },
            ]}
            onPress={() => { onChange(option.id) }}
            hitSlop={4}
          >
            <Text
              style={styles.label}
              size={designTypography.caption}
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

CategoryChips.displayName = 'HomeCategoryChips'
export default CategoryChips
