import { View } from 'react-native'
import Content from './Content'
import PlayerBar from '@/components/player/PlayerBar'

export default ({ componentId }: { componentId: string }) => {
  return (
    // 外层 flex:1 容器作为 PlayerBar 绝对定位的参照系，
    // 让胶囊能稳定浮在屏幕底部、不挤压 Content 高度。
    <View style={{ flex: 1 }}>
      <Content />
      {/*
        这里必须传 Home 页自己的 componentId，与 Horizontal 布局
        （Horizontal/index.tsx）保持一致：迷你播放器的「是否被覆盖 / 暂停渲染」
        按 componentId 记账，传 commonState.componentIds 栈顶（最近 push 的页面 id）
        会让 Home 上的实例永远以为自己被别人盖着。
      */}
      <PlayerBar componentId={componentId} isHome />
    </View>
  )
}
