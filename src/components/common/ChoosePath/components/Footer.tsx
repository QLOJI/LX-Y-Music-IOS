import { memo } from 'react'
import { View, StyleSheet } from 'react-native'
import Button from '@/components/common/Button'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { shadow } from '@/utils/shadow'
import { useButtonRadius } from '@/utils/buttonRadius'

export default memo(
  ({
    onConfirm,
    onHide,
    dirOnly,
  }: {
    onConfirm: () => void
    onHide: () => void
    dirOnly: boolean
  }) => {
    const t = useI18n()
    const theme = useTheme()
    const buttonRadius = useButtonRadius()

    return (
      <View style={{ ...styles.footer, backgroundColor: theme['c-content-background'] }}>
        <Button
          style={[
            styles.footerBtn,
            { width: dirOnly ? '50%' : '100%' },
            { borderRadius: buttonRadius(49) /* 模态底部按钮可见高度 ≈ 49 = 文字行高 17（默认 15×1.15）+ 上下 padding 16×2 */ },
          ]}
          onPress={onHide}
        >
          <Text color={theme['c-button-font']}>{t('cancel')}</Text>
        </Button>
        {dirOnly ? (
          <Button
            style={[styles.footerBtn, { borderRadius: buttonRadius(49) /* 高度依据同取消按钮：49 */ }]}
            onPress={onConfirm}
          >
            <Text color={theme['c-button-font']}>{t('confirm')}</Text>
          </Button>
        ) : null}
      </View>
    )
  },
)

const styles = StyleSheet.create({
  footer: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'row',
    // borderTopWidth: BorderWidths.normal,
    // iOS 浮层阴影（仅 iPhone/iPad）
    ...shadow(8),
  },
  footerBtn: {
    width: '50%',
    paddingTop: 16,
    paddingBottom: 16,
    alignItems: 'center',
  },
})
