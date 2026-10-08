import { memo } from 'react'

import Button, { type BtnProps } from '@/components/common/Button'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { createStyle } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'

export interface ButtonProps extends BtnProps {
  size?: number
}

export default memo(({ disabled, size = 14, onPress, children }: ButtonProps) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  // 「按钮圆角」行内覆盖（静态 styles.button.borderRadius 原样保留作兜底）
  const buttonRadius = useButtonRadius()

  // 按钮底色随「按钮透明度」淡出。只改颜色 alpha，不用容器 style.opacity——后者会把文字一起变淡。
  // 「按钮圆角」：无固定高度，按可见高度 ≈28pt 传参（默认 14pt 文字行高约 17 + 上下 padding 5×2）
  return (
    <Button
      style={{ ...styles.button, backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity), borderRadius: buttonRadius(28) }}
      onPress={onPress}
      disabled={disabled}
    >
      <Text size={size} color={theme['c-button-font']}>
        {children}
      </Text>
    </Button>
  )
})

const styles = createStyle({
  button: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    marginRight: 10,
  },
})
