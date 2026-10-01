import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Animated, Pressable, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'

import { type COMPONENT_IDS } from '@/config/constant'

interface Props {
  visibleNavNames: COMPONENT_IDS[]
  widthPercentage: number
  widthPercentageMax?: number
  children: React.ReactNode
  renderNavigationView: () => React.ReactNode
  drawerPosition?: 'left' | 'right'
  drawerBackgroundColor?: string
  style?: StyleProp<ViewStyle>
}

export interface DrawerLayoutFixedType {
  openDrawer: () => void
  closeDrawer: () => void
  fixWidth: () => void
}

const DrawerLayoutFixed = forwardRef<DrawerLayoutFixedType, Props>(({
  widthPercentage,
  widthPercentageMax,
  children,
  renderNavigationView,
  drawerPosition = 'left',
  drawerBackgroundColor,
  style,
}, ref) => {
  const [containerWidth, setContainerWidth] = useState(0)
  const [visible, setVisible] = useState(false)
  // 动画期间把侧边栏内容光栅化成位图，避免滑入/滑出时逐帧重新合成
  // 复杂的歌单卡片列表（封面图 + 文本），显著降低 GPU 合成开销、提升帧率。
  const [rasterize, setRasterize] = useState(false)
  const animation = useRef(new Animated.Value(0)).current

  const drawerWidth = useMemo(() => {
    if (!containerWidth) return 0
    const width = Math.floor(containerWidth * widthPercentage)
    return widthPercentageMax ? Math.min(width, widthPercentageMax) : width
  }, [containerWidth, widthPercentage, widthPercentageMax])

  const openDrawer = useCallback(() => {
    if (!drawerWidth) return
    setVisible(true)
    setRasterize(true)
    Animated.timing(animation, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setRasterize(false)
    })
  }, [animation, drawerWidth])

  const closeDrawer = useCallback(() => {
    setRasterize(true)
    Animated.timing(animation, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setVisible(false)
      setRasterize(false)
    })
  }, [animation])

  // 抽屉锁（首页横滑开关）的唯一真值来源 = visible（2026-10-01，P0）。
  // 旧写法只在 openDrawer 里发 false、在 closeDrawer 的动画完成回调里发 true，两个缺口：
  // ① 关闭动画被打断（finished=false）时 setVisible(false) 不执行、但回调照样发 true——
  //    抽屉还在屏幕上，锁却放开了（写反的另一种卡法：首页横滑与抽屉手势同时可用）；
  // ② 组件在「锁住」期间被卸载（切主题/退出登录引起的重挂载、导航栈回收）后，
  //    再也没有人发 true——首页 PagerView 永久停在不可横滑。用户侧表现为「推荐/歌单/
  //    搜索/我的/设置五页滑不动，点击和底部 tab 栏都正常」。
  // 改成由 visible 派生：进入/离开可见态各同步一次锁，语义与 overlay 自己的
  // pointerEvents={visible ? 'auto' : 'box-none'} 完全一致；卸载时兜底放开
  // （抽屉已不存在，锁必须交还，否则首页横滑直到杀进程都回不来）。
  useEffect(() => {
    global.app_event.changeHomePageScrollEnabled?.(!visible)
  }, [visible])
  useEffect(() => () => {
    global.app_event.changeHomePageScrollEnabled?.(true)
  }, [])

  useImperativeHandle(ref, () => ({
    openDrawer,
    closeDrawer,
    fixWidth() {},
  }), [closeDrawer, openDrawer])

  const handleLayout = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    setContainerWidth(layout.width)
  }, [])

  const drawerTranslate = animation.interpolate({
    inputRange: [0, 1],
    outputRange: drawerPosition == 'left' ? [-drawerWidth, 0] : [drawerWidth, 0],
  })
  const overlayOpacity = animation.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.32],
  })

  return (
    <View onLayout={handleLayout} style={[{ flex: 1, width: '100%', overflow: 'hidden' }, style]}>
      <View style={{ flex: 1, overflow: 'hidden' }}>
        {children}
      </View>
      {
        drawerWidth
          ? (
              <View
                pointerEvents={visible ? 'auto' : 'box-none'}
                style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
              >
                <Animated.View
                  pointerEvents={visible ? 'auto' : 'none'}
                  style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: overlayOpacity }}
                >
                  <Pressable onPress={closeDrawer} style={{ flex: 1, backgroundColor: '#000' }} />
                </Animated.View>
                <Animated.View
                  pointerEvents={visible ? 'auto' : 'none'}
                  shouldRasterizeIOS={rasterize}
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    width: drawerWidth,
                    backgroundColor: drawerBackgroundColor,
                    transform: [{ translateX: drawerTranslate }],
                    left: drawerPosition == 'left' ? 0 : undefined,
                    right: drawerPosition == 'right' ? 0 : undefined,
                  }}
                >
                  {renderNavigationView()}
                </Animated.View>
              </View>
            )
          : null
      }
    </View>
  )
})

export default DrawerLayoutFixed
