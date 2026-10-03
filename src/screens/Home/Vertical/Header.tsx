import { View } from 'react-native'
import { useNavActiveId, useStatusbarHeight } from '@/store/common/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { scaleSizeH } from '@/utils/pixelRatio'
import { HEADER_HEIGHT } from '@/config/constant'
import { designSpacing, designTypography } from '@/theme/DesignTokens'
import { isPageOwnedHeader } from '../pageOwnedHeaders'

const Header = () => {
  const id = useNavActiveId()
  const t = useI18n()
  const statusBarHeight = useStatusbarHeight()
  // 【第二十轮·图三】纵深防御：页面自管页头（DetailPageTitle 那批 id）时共享页头绝不渲染。
  // 调用方 Vertical/Content 已经判过一次，这里让 Header 自己再认一次 —— 任何渲染路径都
  // 不可能再画出第二行标题（用户图三：WebDAV 页出现两个「WebDAV」标题）。
  // 三个 hook 都在此之前无条件调用，早返回不会破坏 hook 顺序。集合见 ../pageOwnedHeaders。
  if (isPageOwnedHeader(id)) return null
  return (
    <View
      style={{
        ...styles.container,
        height: scaleSizeH(HEADER_HEIGHT) + statusBarHeight,
        paddingTop: statusBarHeight,
      }}
    >
      <View style={styles.left}>
        {/* 字号取 designTypography.title（= 20）：它同时是「我的」二级列表页标题
            （subPageTitleSize）的字号来源，见 DesignTokens 里该 token 的注释。
            这里走 token 而不是字面量 20，是为了让「谁引用谁」在源码里看得见。 */}
        <Text style={styles.title} size={designTypography.title}>
          {t(id)}
        </Text>
      </View>
    </View>
  )
}

const styles = createStyle({
  container: {
    paddingRight: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    paddingLeft: 12,
    alignItems: 'center',
  },
  title: {
    paddingLeft: designSpacing.xs,
    paddingRight: designSpacing.sm,
    fontWeight: '700',
  },
})

export default Header
