import { memo } from 'react'
import { View, TouchableOpacity } from 'react-native'
import { Icon } from '@/components/common/Icon'
import { pop } from '@/navigation'
import Text from '@/components/common/Text'
import { useStatusbarHeight } from '@/store/common/hook'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { createStyle } from '@/utils/tools'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { scaleSizeH } from '@/utils/pixelRatio'
import { HEADER_HEIGHT as _HEADER_HEIGHT } from '@/config/constant'
import { designSpacing } from '@/theme/DesignTokens'

const HEADER_HEIGHT = scaleSizeH(_HEADER_HEIGHT)

export default memo(({ componentId, title }: { componentId: string, title: string }) => {
  const statusBarHeight = useStatusbarHeight()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  const back = () => { void pop(componentId) }

  return (
    <View style={{ height: HEADER_HEIGHT + statusBarHeight, paddingTop: statusBarHeight }}>
      <View style={styles.container}>
        <TouchableOpacity
          onPress={back}
          // 返回按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 opacity，否则图标会一起变淡
          style={{ ...styles.button, width: HEADER_HEIGHT, backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity), borderRadius: buttonRadius(42) /* 返回按钮高 = HEADER_HEIGHT 设计值 42：按自身高度折算半高，行内覆盖「按钮圆角」 */ }}
        >
          <Icon name="chevron-left" size={19} color={theme['c-primary']} />
        </TouchableOpacity>
        <Text numberOfLines={1} size={20} style={{ ...styles.title, color: theme['c-font'] }}>{title}</Text>
        <View style={{ width: HEADER_HEIGHT }} />
      </View>
    </View>
  )
})

const styles = createStyle({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    height: '100%',
  },
  button: {
    height: HEADER_HEIGHT,
    marginHorizontal: designSpacing.xs,
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '700',
  },
})
