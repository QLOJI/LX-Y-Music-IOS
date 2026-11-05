import { View } from 'react-native'
import Button from '@/components/common/Button'
import Text from '@/components/common/Text'
import { BorderWidths } from '@/theme'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'

export default ({
  listInfo,
  onPress,
  width,
}: {
  listInfo: LX.List.MyListInfo
  onPress: (listInfo: LX.List.MyListInfo) => void
  width: number
}) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  // 「按钮圆角」：歌单按钮的行内覆盖（高度取静态 styles.button.height = 36）
  const buttonRadius = useButtonRadius()

  const handlePress = () => {
    onPress(listInfo)
  }

  return (
    <View style={{ ...styles.listItem, width }}>
      <Button
        style={[{
          ...styles.button,
          // 按钮底色/边框随「按钮透明度」淡出，文字色不动；只改颜色 alpha，不用容器 style.opacity
          backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
          borderColor: applyOpacity(theme['c-primary-light-200-alpha-700'], buttonOpacity),
        }, { borderRadius: buttonRadius(36) /* 36 = 设计原值；不要传 styles.button.height，它已被 createStyle 预缩放，传它会二次缩放 */ }]}
        onPress={handlePress}
      >
        <Text numberOfLines={1} size={14} color={theme['c-button-font']}>
          {listInfo.name}
        </Text>
      </Button>
    </View>
  )
}

export const styles = createStyle({
  listItem: {
    // width: '50%',
    paddingRight: 13,
  },
  button: {
    height: 36,
    paddingLeft: 10,
    paddingRight: 10,
    marginRight: 10,
    marginBottom: 10,
    borderRadius: 4,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: BorderWidths.normal1,
  },
})
