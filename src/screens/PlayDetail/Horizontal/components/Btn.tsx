import { TouchableOpacity } from 'react-native'
import { Icon } from '@/components/common/Icon'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { scaleSizeW } from '@/utils/pixelRatio'

import { HEADER_HEIGHT } from '@/config/constant'
import { useButtonRadius } from '@/utils/buttonRadius'
export const BTN_WIDTH = scaleSizeW(HEADER_HEIGHT)
export const BTN_ICON_SIZE = 20

export default ({
  icon,
  size,
  color,
  onPress,
  onLongPress,
}: {
  icon: string
  size?: number
  color?: string
  onPress: () => void
  onLongPress?: () => void
}) => {
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  return (
    <TouchableOpacity
      style={[{ ...styles.cotrolBtn, width: BTN_WIDTH, height: BTN_WIDTH }, { borderRadius: buttonRadius(BTN_WIDTH) /* 「按钮圆角」：按钮自身 HEADER_HEIGHT 见方（BTN_WIDTH，设计 42pt） */ }]}
      activeOpacity={0.5}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <Icon name={icon} color={color ?? theme['c-550']} size={size ?? BTN_ICON_SIZE} />
    </TouchableOpacity>
  )
}

const styles = createStyle({
  cotrolBtn: {
    // marginLeft: 5,
    justifyContent: 'center',
    alignItems: 'center',

    // backgroundColor: '#ccc',
  },
})
