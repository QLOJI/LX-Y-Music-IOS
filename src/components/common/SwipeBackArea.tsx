import { memo, useRef } from 'react'
import { PanResponder, StyleSheet, View } from 'react-native'

import { HEADER_HEIGHT } from '@/config/constant'
import { useStatusbarHeight } from '@/store/common/hook'
import { scaleSizeH } from '@/utils/pixelRatio'

interface SwipeBackAreaProps {
  onBack: () => void
  enabled?: boolean
  // 手势带顶部内缩量（pt）：只从页头下方开始参与命中。
  // 缺省不再是 0，而是「状态栏高度 + 标准页头高度（HEADER_HEIGHT）」：
  // 这条最上层条带会把落在其上的点击整个吞掉，默认让开页头后才不会压住页头按钮。
  // 无页头（内容从顶部铺满）的页面请显式传 0，保住左缘整高滑动。
  insetTop?: number
}

const styles = StyleSheet.create({
  area: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 12,
    zIndex: 10,
  },
})

const SwipeBackArea = memo(({ onBack, enabled = true, insetTop }: SwipeBackAreaProps) => {
  // 默认内缩「状态栏 + 标准页头高度」：本工程页头统一按
  // scaleSizeH(HEADER_HEIGHT) + 状态栏高度渲染（Home 页头 / 下载管理 / 相似歌曲等），
  // 同源取值可让手势带开箱即用地从页头下沿才开始，不再压住页头按钮；
  // 调用点显式传值（含 0）时以显式值为准。
  const statusBarHeight = useStatusbarHeight()
  const resolvedInsetTop = insetTop ?? statusBarHeight + scaleSizeH(HEADER_HEIGHT)

  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack

  const panResponder = useRef(
    PanResponder.create({
      // 显式声明「单击不认领触摸」：PanResponder 只有 onMoveShouldSet* 时，起始
      // 触摸的响应权归属存在歧义，在同时存在横向 ScrollView / PagerView 的场景下
      // 可能把一次单纯的点击也纳入本层响应链而不再向下传递，使落在本区域
      // （左侧 12pt、全高、zIndex 10）上的按钮点击丢失。显式返回 false 后，
      // 只有明确的横向滑动（dx>12 且横向位移大于纵向两倍）才被本层接管。
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_event, { dx, dy }) =>
        dx > 12 && Math.abs(dx) > Math.abs(dy) * 2,
      onMoveShouldSetPanResponderCapture: (_event, { dx, dy }) =>
        dx > 12 && Math.abs(dx) > Math.abs(dy) * 2,
      onPanResponderRelease: (_event, { dx }) => {
        if (enabledRef.current && dx > 40) onBackRef.current()
      },
    }),
  ).current

  // pointerEvents 必须保持 'auto'：'box-none' 等价于「自身 pointer-events:none、
  // 子节点 all」，会让本层自身不再是触摸目标，挂在它上面的 PanResponder 收不到
  // 事件、横滑返回直接失效。
  // insetTop：本层是最上层参与命中的视图（onStartShouldSetPanResponder 返回 false
  // 只是「不认领」，不能把触摸还给下层兄弟），top:0 全高时盖在页头按钮上的部分会把
  // 点击整个吞掉；现在默认内缩到页头下方（见 resolvedInsetTop），无页头页面显式传 0
  // 即可恢复左缘整高滑动。
  return (
    <View
      style={[styles.area, { top: resolvedInsetTop }]}
      pointerEvents={enabled ? 'auto' : 'none'}
      {...panResponder.panHandlers}
    />
  )
})

SwipeBackArea.displayName = 'CommonSwipeBackArea'
export default SwipeBackArea
