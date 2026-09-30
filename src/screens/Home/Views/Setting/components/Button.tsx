import { memo, useMemo } from 'react'

import Button, { type BtnProps } from '@/components/common/Button'
import Text from '@/components/common/Text'
import { designRadius, designSpacing } from '@/theme/DesignTokens'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { createStyle } from '@/utils/tools'

type ButtonProps = BtnProps

// 设置页的动作按钮统一走「推荐页排行榜按钮」那套视觉语言：
// 圆角 designRadius.md + 1px 边框 + 半透明主题色底 + 主题色文字，
// 与页面里的开关行、输入行是同一套控件外观。
export default memo(({ disabled, onPress, children }: ButtonProps) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')

  // 底色与边框随「按钮透明度」淡出，按钮文字（c-primary）不动。
  // 只改颜色 alpha，不用容器 style.opacity——后者会把文字一起变淡。
  const buttonStyle = useMemo(() => ({
    backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-200'], buttonOpacity),
    borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
  }), [theme, buttonOpacity])

  return (
    <Button
      style={[
        styles.button,
        buttonStyle,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text size={14} style={styles.label} color={theme['c-primary']}>
        {children}
      </Text>
    </Button>
  )
})

const styles = createStyle({
  button: {
    minHeight: 40,
    paddingHorizontal: designSpacing.md,
    borderRadius: designRadius.md,
    borderWidth: 1,
    marginRight: 10,
    // minHeight 撑高后，RN 默认纵向排列会把文字顶到上沿，必须显式双向居中
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontWeight: '600',
  },
})
