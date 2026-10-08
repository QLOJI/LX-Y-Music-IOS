import { forwardRef, useImperativeHandle, useRef } from 'react'
import { View, ScrollView } from 'react-native'
import Dialog, { type DialogType } from './Dialog'
import Button from './Button'
import { createStyle } from '@/utils/tools'
import { useI18n } from '@/lang/index'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import Text from './Text'
import { designRadius, designSpacing } from '@/theme/DesignTokens'
import { useButtonRadius } from '@/utils/buttonRadius'

const styles = createStyle({
  main: {
    // flexGrow: 0,
    flexShrink: 1,
    marginTop: designSpacing.sm,
    marginLeft: designSpacing.xs,
    marginRight: designSpacing.xs,
    marginBottom: designSpacing.md,
  },
  content: {
    flexGrow: 0,
    paddingLeft: designSpacing.sm,
    paddingRight: designSpacing.sm,
  },
  btns: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingBottom: designSpacing.sm,
    // paddingRight: 15,
  },
  btnsDirection: {
    paddingLeft: designSpacing.sm,
  },
  btnsReversedDirection: {
    paddingLeft: designSpacing.sm,
    flexDirection: 'row-reverse',
  },
  btn: {
    flex: 1,
    height: 36,
    paddingHorizontal: designSpacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: designRadius.pill,
  },
  btnDirection: {
    marginRight: designSpacing.sm,
  },
  btnReversedDirection: {
    marginLeft: designSpacing.sm,
  },
})

export interface LogConfirmAlertProps {
  onCancel?: () => void
  onHide?: () => void
  onConfirm?: () => void
  keyHide?: boolean
  bgHide?: boolean
  closeBtn?: boolean
  title?: string
  text?: string
  cancelText?: string
  confirmText?: string
  showConfirm?: boolean
  disabledConfirm?: boolean
  reverseBtn?: boolean
  children?: React.ReactNode | React.ReactNode[]
  middleText?: string
  onMiddle?: () => void
  showMiddle?: boolean
}

export interface LogConfirmAlertType {
  setVisible: (visible: boolean) => void
}

export default forwardRef<LogConfirmAlertType, LogConfirmAlertProps>(
  (
    {
      onHide,
      onCancel,
      onConfirm = () => {},
      keyHide,
      bgHide,
      closeBtn,
      title = '',
      text = '',
      cancelText = '',
      confirmText = '',
      showConfirm = true,
      disabledConfirm = false,
      children,
      reverseBtn = false,
      middleText = '',
      onMiddle = () => {},
      showMiddle = false,
    }: LogConfirmAlertProps,
    ref,
  ) => {
    const theme = useTheme()
    const buttonOpacity = useSettingValue('theme.buttonOpacity')
    // 「按钮圆角」：三颗弹窗按钮同高，行内覆盖（高度取静态 styles.btn.height，设计值 36）
    const buttonRadius = useButtonRadius()
    const t = useI18n()

    const dialogRef = useRef<DialogType>(null)

    useImperativeHandle(ref, () => ({
      setVisible(visible: boolean) {
        dialogRef.current?.setVisible(visible)
      },
    }))

    const handleCancel = () => {
      onCancel?.()
      dialogRef.current?.setVisible(false)
    }

    return (
      <Dialog
        onHide={onHide}
        keyHide={keyHide}
        bgHide={bgHide}
        closeBtn={closeBtn}
        title={title}
        ref={dialogRef}
      >
        <View style={styles.main}>
          <ScrollView
            style={styles.content}
            keyboardShouldPersistTaps={'always'}
          >
            {children ?? <Text>{text}</Text>}
          </ScrollView>
        </View>
        <View
          style={{
            ...styles.btns,
            ...(reverseBtn ? styles.btnsReversedDirection : styles.btnsDirection),
          }}
        >
          <Button
            style={{
              ...styles.btn,
              ...(reverseBtn ? styles.btnReversedDirection : styles.btnDirection),
              // 取消按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
              backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
              borderRadius: buttonRadius(36) /* 36 = 设计原值；不要传 styles.btn.height，它已被 createStyle 预缩放，传它会二次缩放 */,
            }}
            onPress={handleCancel}
          >
            <Text color={theme['c-button-font']}>{cancelText || t('cancel')}</Text>
          </Button>
          {showMiddle ? (
            <Button
              style={{
                ...styles.btn,
                ...(reverseBtn ? styles.btnReversedDirection : styles.btnDirection),
                // 中间按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                borderRadius: buttonRadius(36) /* 36 = 设计原值；不要传 styles.btn.height，它已被 createStyle 预缩放，传它会二次缩放 */,
              }}
              onPress={onMiddle}
            >
              <Text color={theme['c-button-font']}>{middleText}</Text>
            </Button>
          ) : null}
          {showConfirm ? (
            <Button
              style={{
                ...styles.btn,
                ...(reverseBtn ? styles.btnReversedDirection : styles.btnDirection),
                // 确认按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
                borderRadius: buttonRadius(36) /* 36 = 设计原值；不要传 styles.btn.height，它已被 createStyle 预缩放，传它会二次缩放 */,
              }}
              onPress={onConfirm}
              disabled={disabledConfirm}
            >
              <Text color={theme['c-button-font']}>{confirmText || t('confirm')}</Text>
            </Button>
          ) : null}
        </View>
      </Dialog>
    )
  },
)
