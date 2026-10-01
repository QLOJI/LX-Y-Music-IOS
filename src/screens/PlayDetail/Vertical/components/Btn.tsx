import { TouchableOpacity } from 'react-native'
import { Icon } from '@/components/common/Icon'
import { SvgIcon } from '@/components/common/SvgIcon'
import { createStyle } from '@/utils/tools'
import { scaleSizeH } from '@/utils/pixelRatio'
import { HEADER_HEIGHT as _HEADER_HEIGHT } from '@/config/constant'
import { useButtonRadius } from '@/utils/buttonRadius'

export const HEADER_HEIGHT = scaleSizeH(_HEADER_HEIGHT)

export default ({
  icon,
  color,
  onPress,
}: {
  icon: string
  color?: string
  onPress: () => void
}) => {
  const buttonRadius = useButtonRadius()
  return (
    <TouchableOpacity onPress={onPress} style={[{ ...styles.button, width: HEADER_HEIGHT }, { borderRadius: buttonRadius(HEADER_HEIGHT) /* 「按钮圆角」：按钮自身高度 = HEADER_HEIGHT（设计 42pt，宽度同值） */ }]}>
      {icon.startsWith('svg:') ? (
        <SvgIcon name={icon.replace('svg:', '')} color={color} size={18} />
      ) : (
        <Icon name={icon} color={color} size={18} />
      )}
    </TouchableOpacity>
  )
}

const styles = createStyle({
  button: {
    justifyContent: 'center',
    alignItems: 'center',
    height: '100%',
    flex: 0,
  },
})
