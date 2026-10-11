import { COMPONENT_IDS } from '@/config/constant'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { subscribePagerDrag } from '@/utils/homeTabScroll'
import state, { type InitState } from './state'

export const useFontSize = () => {
  const [value, update] = useState(state.fontSize)

  useEffect(() => {
    global.state_event.on('fontSizeUpdated', update)
    return () => {
      global.state_event.off('fontSizeUpdated', update)
    }
  }, [])

  return value
}

// 全局顶部间距偏移（pt）：所有页面 Header 均以 useStatusbarHeight 作为
// 距状态栏的 paddingTop，在此统一加一点留白，避免标题贴住状态栏/灵动岛。
// 只读偏移，不写入 state，避免影响 SizeView 的原始高度校准。
const STATUSBAR_TOP_OFFSET = 6

export const useStatusbarHeight = () => {
  const [value, update] = useState(state.statusbarHeight)

  useEffect(() => {
    global.state_event.on('statusbarHeightUpdated', update)
    return () => {
      global.state_event.off('statusbarHeightUpdated', update)
    }
  }, [])

  return value + STATUSBAR_TOP_OFFSET
}

/**
 * 底部安全区高度（pt）：Home 指示器 / iPad 底部区域。
 * 底部弹层、列表需用它补 paddingBottom，否则最后一行会被系统 UI 遮挡。
 * 由 SizeView 在启动与窗口尺寸变化（旋转 / 分屏）时从原生侧同步。
 */
export const useSafeAreaBottom = () => {
  const [value, update] = useState(state.safeAreaBottom)

  useEffect(() => {
    global.state_event.on('safeAreaBottomUpdated', update)
    return () => {
      global.state_event.off('safeAreaBottomUpdated', update)
    }
  }, [])

  return value
}

/**
 * 底部安全区是否已经拿到过一次真实值（启动首帧为 false）。
 *
 * 用途只有一处：底部悬浮层（底部 Tab 栏 / 首页迷你播放器）**首帧不下发**。
 * 两者的 bottom 完全由 safeAreaBottom 决定，而它是 SizeView 挂载后异步向原生取的
 * （启动时 state 里是 0）：先按 0 画出来（整条沉到屏幕最下、压在 Home 指示器上），
 * 一两帧后拿到真实值（iPhone 34pt / iPad 20pt）再整体上跳一次 —— 用户看到的就是
 * 「启动软件时底部 tab 栏和迷你播放器抽动」。等安全区就绪再画，位置一次到位，
 * 代价只是这两条比页面内容晚一两帧出现（首屏本来还在转场，看不出）。
 *
 * 兜底在 SizeView：原生 getSafeAreaInsets 万一不回调，250ms 后按现有值放行，
 * 绝不允许「原生卡住 → 底部栏永远不出现」。
 */
export const useSafeAreaReady = () => {
  const [value, update] = useState(state.safeAreaReady)

  useEffect(() => {
    global.state_event.on('safeAreaReadyUpdated', update)
    return () => {
      global.state_event.off('safeAreaReadyUpdated', update)
    }
  }, [])

  return value
}

/**
 * 是否处于 **push** 转场窗口内（pop 不再置位，见下）。
 * push 期间玻璃（Tab 栏 / 迷你播放器）必须暂停渲染：转场中途采到的背景是
 * 「上一页正在滑走 + 新页正在盖上来」的中间态，采进胶囊就是每次切页闪的那一下。
 * 返回方向相反——玻璃正在被露出来，按住等于让用户多看一截陈旧画面，所以 pop
 * 事件到达即释放。详见 navigation.beginNavTransitionWindow / endNavTransitionWindow。
 */
export const useNavTransitioning = () => {
  const [value, update] = useState(state.navTransitioning)

  useEffect(() => {
    global.state_event.on('navTransitioningUpdated', update)
    return () => {
      global.state_event.off('navTransitioningUpdated', update)
    }
  }, [])

  return value
}

/**
 * 是否处于**返回（pop）露出窗口**内（2026-10-11，第 52 轮第 2 条）。
 *
 * 与 useNavTransitioning 是反作用力：那个把玻璃按住（push：玻璃正在被盖住），
 * 这个把玻璃的**覆盖门**临时作废（pop：玻璃正在被露出来）。
 *
 * 为什么需要它：覆盖门读的是账本（componentIds），而账本只在 screenPopped 事件到达时
 * 才翻——该事件晚于「用户按下返回」，于是从按下返回到账本收尾之间，玻璃被「以为还盖着」
 * 而暂停渲染、显示的是暂停前那一帧（push 之前的画面）；等到账本收尾、原生走
 * handleResumeFromPause（丢纹理 + 重采 + 立即画）时，返回动画已经跑完 —— 用户看到的就是
 * 「返回动画结束时闪一下，然后透过的画面才刷新」。
 *
 * 本 hook 只给玻璃省电门用（见 useGlassCovered / useGlassHomeCovered），
 * **不要**用它替换 useHomeCovered / useScreenCovered —— 后两者还有非玻璃消费点
 * （tabBarCollapse 的 useAboveMiniPlayerBottom 布局、PlayingIcon 动画门等），
 * 提前翻转会让那些布局在返回动画中途跳一下。
 */
export const useNavRevealing = () => {
  const [value, update] = useState(state.navRevealing)

  useEffect(() => {
    global.state_event.on('navRevealingUpdated', update)
    return () => {
      global.state_event.off('navRevealingUpdated', update)
    }
  }, [])

  return value
}

// 底部悬浮层（悬浮迷你播放器 + 底部 Tab）的固定部分总高（pt），
// 实际避让高度还需叠加底部安全区（useBottomOverlayInset）。
export const BOTTOM_OVERLAY_BASE_HEIGHT = 180

/**
 * 底部悬浮层避让高度（pt）：迷你播放器 + 底部 Tab + 底部安全区。
 * 各列表 FlatList 的 contentContainerStyle.paddingBottom 统一使用该值：
 * 相当于在列表末尾追加一段滚动空白，让最后一行能滚到悬浮层上方、可正常点击，
 * 列表容器自身高度不变（仍占满页面），播放器与 Tab 仍是悬浮层、不移动不缩小。
 * safeAreaBottom 随 iPad 旋转 / 窗口尺寸变化自动同步，横竖屏切换后依然准确。
 */
export const useBottomOverlayInset = () => {
  const safeAreaBottom = useSafeAreaBottom()
  return BOTTOM_OVERLAY_BASE_HEIGHT + safeAreaBottom
}

/**
 * App 是否处于前台（**响应式**，随 AppState 变化重新渲染）。
 *
 * 与 utils/tools.ts 的 `isActive()` 不同：那个是即时查询（非响应式，全仓唯一消费点是
 * store/player/hook.ts 里的暂停态判断），拿不到「前台→后台」这个边沿。本 hook 是省电
 * 门控用的：本 App 有音频后台播放能力，锁屏后进程仍常驻，只有前台才需要的工作
 * （液态玻璃的 Metal 连续渲染、缓冲进度轮询、下载进度高频回调）必须随 App 退到后台而停。
 *
 * 判定口径 = `AppState.currentState === 'active'`：
 *   · 'background'（已退到后台）与 'inactive'（iOS 切换器/控制中心/系统弹窗打断）都算
 *     「非前台」——这两态下界面都不可见，继续渲染纯属浪费电。
 *   · 订阅建立时立即对齐一次当前值（组件可能在 App 已经退到后台之后才挂载）。
 *
 * 只用 useState + AppState 订阅，不写进 store/common/state：门控是**组件局部**关心的事
 * （Tab 栏 / 迷你播放器 / 详情页缓冲轮询各订阅各的，同时最多 3 个订阅者），
 * 走 store + state_event 反而多一层广播。
 */
export const useAppActive = () => {
  const [value, update] = useState(() => AppState.currentState === 'active')

  useEffect(() => {
    // 先对齐一次：从挂载到 effect 执行之间 AppState 可能已经变过
    update(AppState.currentState === 'active')
    const subscription = AppState.addEventListener('change', (nextState) => {
      update(nextState === 'active')
    })
    return () => {
      subscription.remove()
    }
  }, [])

  return value
}

/**
 * 首页 PagerView 是否正处于**真实手势**拖动会话中（2026-10-02 用户第 2/9 条）。
 *
 * 数据源是既有的轻量高频通道 `utils/homeTabScroll` 的 PagerDrag 信号：Main 在
 * `onPageScrollStateChanged` 收到 'dragging' 时发 true、'idle'（或拖动静默看门狗
 * 超时）时发 false —— 全程只有两次订阅回调，不是逐帧（逐帧的 onPageScroll 走
 * PagerProgress，绝不经过本 hook）。程序化 setPage 不发该信号，所以只有真手势命中。
 *
 * 用途只有一个：给底部两块液态玻璃（Tab 栏 / 迷你播放器）的 `live` prop 供信号，
 * 把原生采景从静止态 30fps 档放宽到实时档（见 LiquidGlass 的 live 说明）。
 * 之所以放在这里而不是各自订阅：两个消费点（ModernTabBar、PlayerBar）都要，
 * 且它们分散在不同子树、没有共同祖先可以传值。
 *
 * 用 useState 而不是 store：会话期间最多两次重渲染（开始/结束），且只有这两个
 * 消费点关心，走 state_event 广播反而多一层。
 */
export const usePagerDragging = () => {
  const [value, update] = useState(false)

  useEffect(() => subscribePagerDrag(update), [])

  return value
}

export const useComponentIds = () => {
  const [value, update] = useState(state.componentIds)

  useEffect(() => {
    global.state_event.on('componentIdsUpdated', update)
    return () => {
      global.state_event.off('componentIdsUpdated', update)
    }
  }, [])

  return value
}

/**
 * Home 是否被压栈页（播放详情 / 设置详情 / 歌单详情等）**完全覆盖**（不可见）。
 * componentIds 是 RNN 栈内组件列表（底→顶），Home 在栈底：顶层不是 home 即被
 * 覆盖。用于「不可见即省电」——暂停 Home 内玻璃的 Metal 渲染循环与装饰动画，
 * 返回 Home 时恢复（原生下一帧重捕获背景，无残帧）。
 * ⚠️ 只用于「挂在 Home 内」的组件；独立屏幕（专辑页等）用 useScreenCovered。
 */
export const useHomeCovered = () => {
  const ids = useComponentIds()
  return ids.length > 0 && String(ids[ids.length - 1]?.name) !== COMPONENT_IDS.home
}

/**
 * 「传入 componentId 的屏幕」是否被压栈页覆盖：栈顶不是自己即被覆盖。
 * componentId 未知（调用方未传）时恒 false（不门控，行为与旧版一致）——
 * 用于 PlayerBar 这类多屏复用组件：Home 实例传 home 的 id，专辑页实例
 * 不传则不做省电门控。配合 <LiquidGlass paused> 实现不可见即暂停渲染。
 */
export const useScreenCovered = (componentId?: string) => {
  const ids = useComponentIds()
  if (!componentId) return false
  return String(ids[ids.length - 1]?.id) !== String(componentId)
}

/**
 * **玻璃专用**覆盖门：useScreenCovered + 露出窗口（2026-10-11，第 52 轮第 2 条）。
 *
 * 语义 = 「现在还需要暂停这块玻璃吗」，即 `被覆盖 且 不在返回露出窗口内`。
 * 返回发起时（navigation/revealWindow 的 beginNavRevealWindow）窗口打开，本门立刻
 * 变 false ⇒ <LiquidGlass paused> 落 false ⇒ 原生在**转场开始之前**完成一次
 * 复位（丢旧纹理 + 重采当前背景 + 立即 draw）。那一刻页面还盖着玻璃，复位与首帧
 * 采景都看不见；等返回动画把玻璃露出来时，透过的画面已经是当前画面，全程实时，
 * 动画结束不再跳变（用户第 52 轮第 2 条）。
 *
 * ⚠️ 只替换**玻璃省电门**，不要拿它去替换 useScreenCovered / useHomeCovered 本身：
 * 那两个还被非玻璃消费点读（useAboveMiniPlayerBottom 的布局、PlayingIcon 的动画门），
 * 让它们在返回动画中途提前翻转，会让列表底部留白与图标动画在转场里跳一下。
 */
export const useGlassCovered = (componentId?: string) => {
  const covered = useScreenCovered(componentId)
  const revealing = useNavRevealing()
  return covered && !revealing
}

/**
 * **玻璃专用**覆盖门（Home 版）：useHomeCovered + 露出窗口。
 * 消费点 = ModernTabBar 的两块玻璃（展开态 Tab 栏 / 收起态圆钮）。
 * ⚠️ 同上：只用于玻璃的 paused，不要用它替换 useHomeCovered 的其它消费点。
 */
export const useGlassHomeCovered = () => {
  const covered = useHomeCovered()
  const revealing = useNavRevealing()
  return covered && !revealing
}

const hasVisible = (visibleNames: COMPONENT_IDS[], ids: InitState['componentIds']) => {
  const names = ids.map(item => item.name)
  return names.length == visibleNames.length ? visibleNames.every((n) => names.includes(n)) : false
}
export const usePageVisible = (
  visibleNames: COMPONENT_IDS[],
  onChange: (visible: boolean) => void,
) => {
  // 用 ref 持有最新参数，事件订阅只建立一次（依赖数组恒空），
  // 避免调用方传入的数组字面量/内联函数导致反复订阅解绑。
  const visibleNamesRef = useRef(visibleNames)
  const onChangeRef = useRef(onChange)
  visibleNamesRef.current = visibleNames
  onChangeRef.current = onChange

  useEffect(() => {
    let visible = hasVisible(visibleNamesRef.current, state.componentIds)
    const handlecheck = (ids: InitState['componentIds']) => {
      const res = hasVisible(visibleNamesRef.current, ids)
      // console.log(visible, res, res == visible)
      if (res == visible) return
      visible = res
      onChangeRef.current(visible)
    }
    global.state_event.on('componentIdsUpdated', handlecheck)
    return () => {
      global.state_event.off('componentIdsUpdated', handlecheck)
    }
  }, [])
}

export const useAssertApiSupport = (source: LX.Source) => {
  const isSupported = useCallback(
    () => global.lx.qualityList[source] != null || source == 'local' || source == 'bilibili',
    [source],
  )
  const [value, update] = useState(isSupported)

  useEffect(() => {
    // source 变化时同步一次最新支持状态，并订阅后续更新事件
    update(isSupported())
    const handleUpdate = () => {
      update(isSupported())
    }

    global.state_event.on('apiSourceUpdated', handleUpdate)
    return () => {
      global.state_event.off('apiSourceUpdated', handleUpdate)
    }
  }, [isSupported])

  return value
}

export const useNavActiveId = () => {
  const [value, update] = useState(state.navActiveId)

  useEffect(() => {
    global.state_event.on('navActiveIdUpdated', update)
    return () => {
      global.state_event.off('navActiveIdUpdated', update)
    }
  }, [])

  return value
}

export const useBgPic = () => {
  const [value, update] = useState(state.bgPic)

  useEffect(() => {
    global.state_event.on('bgPicUpdated', update)
    return () => {
      global.state_event.off('bgPicUpdated', update)
    }
  }, [])

  return value
}

export const useSourceNames = () => {
  const [value, update] = useState(state.sourceNames)

  useEffect(() => {
    global.state_event.on('sourceNamesUpdated', update)
    return () => {
      global.state_event.off('sourceNamesUpdated', update)
    }
  }, [])

  return value
}
