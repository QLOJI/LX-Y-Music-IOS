import { useNavActiveId } from '@/store/common/hook'
import Header from './Header'
import Main from './Main'
import ModernTabBar from '@/components/layout/ModernTabBar'
// 【第二十轮·图三】「页面自管页头」集合收敛到 ../pageOwnedHeaders（原先此处内联一份、
// Horizontal/index.tsx 里又内联一份完全相同的副本）。集合本身的语义与演进历史见该文件。
import { isPageOwnedHeader } from '../pageOwnedHeaders'

const Content = () => {
  const activeNavId = useNavActiveId()

  return (
    <>
      {/* 页面自管页头时不渲染共享页头（Header 内部还有一层同样的判断，见 pageOwnedHeaders） */}
      {isPageOwnedHeader(activeNavId) ? null : <Header />}
      <Main />
      <ModernTabBar />
    </>
  )
}

export default Content
