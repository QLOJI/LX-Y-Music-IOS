import { View } from 'react-native'
import PlayerBar from '@/components/player/PlayerBar'
import StatusBar from '@/components/common/StatusBar'
import Header from './Header'
import Main from './Main'
import ModernTabBar from '@/components/layout/ModernTabBar'
import { createStyle } from '@/utils/tools'
import { useNavActiveId } from '@/store/common/hook'
// 【第二十轮·图三】「页面自管页头」集合收敛到 ../pageOwnedHeaders（此前竖屏、横屏各内联
// 一份完全相同的副本）。集合语义、为什么 Header 内部还要再判一次，见该文件头注释。
import { isPageOwnedHeader } from '../pageOwnedHeaders'

const styles = createStyle({
  container: {
    flex: 1,
  },
  bodyWrap: {
    flex: 1,
    overflow: 'hidden',
  },
})

export default ({ componentId }: { componentId: string }) => {
  const activeNavId = useNavActiveId()

  return (
    <>
      <StatusBar />
      <View style={styles.container}>
        <View style={styles.bodyWrap}>
          {/* 页面自管页头时不渲染共享页头（Header 内部还有一层同样的判断） */}
          {isPageOwnedHeader(activeNavId) ? null : <Header />}
          <Main />
        </View>
        <ModernTabBar />
        <PlayerBar componentId={componentId} isHome />
      </View>
    </>
  )
}
