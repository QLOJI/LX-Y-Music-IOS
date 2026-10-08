import { TouchableOpacity } from 'react-native'
import { Icon } from '@/components/common/Icon'
import { SvgIcon } from '@/components/common/SvgIcon'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { scaleSizeW } from '@/utils/pixelRatio'
import { useButtonRadius } from '@/utils/buttonRadius'

export const BTN_WIDTH = scaleSizeW(32)
export const BTN_ICON_SIZE = 22

export default ({
  icon,
  color,
  onPress,
}: {
  icon: string
  color?: string
  onPress: () => void
}) => {
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  return (
    <TouchableOpacity
      style={[{ ...styles.cotrolBtn, width: BTN_WIDTH, height: BTN_WIDTH }, { borderRadius: buttonRadius(BTN_WIDTH) /* 「按钮圆角」：按钮自身 32×32（BTN_WIDTH，设计 32pt） */ }]}
      activeOpacity={0.5}
      onPress={onPress}
    >
      {icon.startsWith('svg:')
        ? <SvgIcon name={icon.replace('svg:', '')} color={color ?? theme['c-font-label']} size={BTN_ICON_SIZE} />
        : <Icon name={icon} color={color ?? theme['c-font-label']} size={BTN_ICON_SIZE} />
      }
    </TouchableOpacity>
  )
}

const styles = createStyle({
  cotrolBtn: {
    marginBottom: 5,
    justifyContent: 'center',
    alignItems: 'center',

    // backgroundColor: '#ccc',
  },
})
