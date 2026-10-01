import { memo } from 'react'
import { View, TouchableOpacity } from 'react-native'
import { Icon } from '@/components/common/Icon'
import { pop } from '@/navigation'
import Text from '@/components/common/Text'
import { useStatusbarHeight } from '@/store/common/hook'
import { createStyle } from '@/utils/tools'
import { scaleSizeH } from '@/utils/pixelRatio'
import { useButtonRadius } from '@/utils/buttonRadius'
import { HEADER_HEIGHT as _HEADER_HEIGHT } from '@/config/constant'

const HEADER_HEIGHT = scaleSizeH(_HEADER_HEIGHT)

export default memo(({ componentId }: { componentId: string }) => {
  const statusBarHeight = useStatusbarHeight()
  const buttonRadius = useButtonRadius()
  const back = () => { void pop(componentId) }

  return (
    <View style={{ height: HEADER_HEIGHT + statusBarHeight, paddingTop: statusBarHeight }}>
      <View style={styles.container}>
        <TouchableOpacity
          onPress={back}
          style={{
            ...styles.button,
            width: HEADER_HEIGHT,
            // 无底色/无内边距的图标按钮：可见高度 = 图标 18，行内覆盖「按钮圆角」
            borderRadius: buttonRadius(18),
          }}
        >
          <Icon name="chevron-left" size={18} />
        </TouchableOpacity>
        <Text numberOfLines={1} size={16} style={styles.title}>下载管理</Text>
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
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
  },
})
