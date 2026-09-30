import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, PanResponder, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { useNavActiveId, useSafeAreaBottom, useHomeCovered } from '@/store/common/hook'
import { setNavActiveId } from '@/core/common'
import { useSettingValue } from '@/store/setting/hook'
import { createStyle, isIOS26_2OrAbove } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { useTabBarCollapsed, useMiniPlayerHeight, getCollapsedPillSize } from '@/utils/tabBarCollapse'
import { setTabBarExpanded } from '@/utils/nativeModules/utils'
import { designRadius, designSpacing, tabBarBaseHeight, collapsedFloatBottom } from '@/theme/DesignTokens'
import type { NAV_ID_Type } from '@/config/constant'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import LiquidGlass from '@/components/common/LiquidGlass'
import LiquidLens, { type LiquidLensHandle } from '@/components/common/LiquidLens'
import { subscribePagerProgress, subscribePagerDrag, emitTabBarDragActive } from '@/utils/homeTabScroll'

// Tab 栏非选中项文字/图标色（按主题模式分派，替换 c-450）：
//   - c-450 在玻璃底衬上对比度只有 1.45~2.44:1（AA 4.5:1），且可用背景亮度区间
//     测度仅 2.5%，加厚材质也救不了 → 必须换色；
//   - 两个值均经 scripts/sim-glass-contrast.js 断言5/7 在「全部内置主题 × 背景 ×
//     glassOpacity 全域」验证达标（浅色最坏 5.9:1 / 深色最坏 4.7:1）；
//   - 不动全局 c-450（它服务全 App 次级文字，非玻璃背景上对比度尚可）——只改玻璃场景。
// ⚠️ 与脚本常量 TAB_INACTIVE_LIGHT_V(94) / TAB_INACTIVE_DARK_V(248) 人工同步。
const TAB_INACTIVE_LIGHT = 'rgb(94,94,94)'
const TAB_INACTIVE_DARK = 'rgb(248,248,248)'

const styles = createStyle({
  wrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: designSpacing.lg,
  },
  bar: {
    // 与迷你播放条胶囊(~54)接近的纤细高度；透镜条带高度按 BAR_HEIGHT 推导。
    // 取 token 而不是写死 56：PlayerBar 算「与 Tab 栏的距离」时用的是同一个
    // tabBarBaseHeight，两处若各写各的，改一处就会让间距算错（需求9）。
    height: tabBarBaseHeight,
    flexDirection: 'row',
    // 圆角与透镜一致（designRadius.glass 注释），玻璃衬底同值
    borderRadius: designRadius.glass,
    // 外圈投影已移除（用户反馈胶囊下方有「底子」）：纯玻璃质感，立体感由玻璃
    // 自身边缘光 + 原生 0.5pt 内缘线提供
    overflow: 'hidden',
  },
  item: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 收起态圆钮的独立图层：**无 padding / margin**（为什么必须独立见组件内注释）。
  // 它只负责给圆钮一个与 PlayerBar 绝对 wrapper 等价的定位基准；高度在组件内
  // 内联为「收起行高」（圆钮要落在图层 bounds 之内）。
  // 注意不能挪回 wrapper（wrapper 带 paddingBottom，绝对子节点的 bottom inset 会
  // 与父级 padding 叠加——RN 0.73 默认不启用 Yoga 的 AbsolutePositioningIncorrect
  // 修复，是「同排」历次修不好的根因）。
  pillLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  // 深浅色模式均无描边（纯玻璃质感，玻璃材质自带边缘光；覆层为中性色不随主题色）
  pillWrapper: {
    position: 'absolute',
    // left / bottom 在组件内联（scaleSizeW / collapsedFloatBottom），**不能**写成
    // createStyle 属性：createStyle 把 left/right/top/bottom 交给 setSpText（另一套
    // 倍率，默认字体下 24 会变 28），圆钮左缘与 tab 栏/播放器的 24 基准对不齐，
    // 字体一变差距还会放大。宽=高=运行时 pillSize。
  },
  pillInner: {
    width: '100%',
    height: '100%',
    borderRadius: designRadius.pill,
    overflow: 'hidden',
  },
  pillIcon: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    marginTop: 2,
    fontWeight: '600',
  },
  iconWrap: {
    height: 24,
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
})

const TAB_IDS = [
  { id: 'nav_discovery', icon: 'home' },
  { id: 'nav_songlist', icon: 'album' },
  { id: 'nav_search', icon: 'search-2' },
  { id: 'nav_love', icon: 'love' },
  { id: 'nav_setting', icon: 'setting' },
] as const

const TAB_LABEL_KEYS: Record<(typeof TAB_IDS)[number]['id'], string> = {
  nav_discovery: 'nav_discovery',
  nav_songlist: 'discovery_tab_discover',
  nav_search: 'nav_search',
  nav_love: 'discovery_tab_playlists',
  nav_setting: 'nav_setting',
}

// 「子页面 → 归属 tab」映射：底部指示器（液态透镜药丸 + 图标/文字高亮）只认 5 个 tab，
// 但 navActiveId 可以是任意一个 PagerView 页 id（见 Vertical/Main.tsx 的 pageComponents，
// 共 16 个）。此前直接 TAB_IDS.findIndex(activeId)：子页 id 找不到 → 返回 -1 → 被
// Math.max(..., 0) 兜成 0（推荐），于是「在我的页点进 WebDAV」时药丸和高亮整体跳到推荐位。
//
// 归属的权威来源是**入口所在页**：
//   - FeatureGrid（src/components/home/FeatureGrid.tsx）渲染在 Mylist/NewListUI 的
//     页脚，只属于「我的」→ 它列出的入口全部归 nav_love；
//   - MOVED_INTO_DISCOVERY_IDS 那批（排行榜/三平台每日推荐/播放历史）已并入推荐页，
//     由推荐页内的卡片或右上角时钟进入 → 归 nav_discovery。
// 显式登记 nav_discovery 那一组（虽然 -1 兜底成 0 恰好也是推荐）是为了不让正确性
// 依赖 TAB_IDS 的当前顺序 —— 日后谁调整 tab 顺序，这组会静默跑偏。
//
// 注意：本映射**只影响指示器归属**，不参与导航；onPress 仍然直接 setNavActiveId(tab.id)。
const CHILD_TAB_PARENT: Partial<Record<NAV_ID_Type, (typeof TAB_IDS)[number]['id']>> = {
  // 我的 → 页脚 FeatureGrid 的入口
  nav_my_playlist: 'nav_love',
  nav_kg_playlist: 'nav_love',
  nav_tx_playlist: 'nav_love',
  nav_followed_artists: 'nav_love',
  nav_subscribed_albums: 'nav_love',
  nav_webdav: 'nav_love',
  nav_local_download: 'nav_love',
  // 推荐 → 已并入推荐页的入口
  nav_top: 'nav_discovery',
  nav_daily_rec: 'nav_discovery',
  nav_tx_daily_rec: 'nav_discovery',
  nav_kg_daily_rec: 'nav_discovery',
  nav_play_history: 'nav_discovery',
}

// A-5「长按底部激活滑动」：长按 250ms 激活拖动（松手按落点吸附切 tab）。
// 这是**恢复被移除的功能**（2026-09-29 曾把长按/横滑拖拽切页整体移除），
// 不是参数调优。硬编码 250ms，不引设置项（需求指定，不低于 200ms）。
const LONG_PRESS_MS = 250

export default memo(() => {
  const theme = useTheme()
  const t = useI18n()
  const activeId = useNavActiveId()
  const safeAreaBottom = useSafeAreaBottom()

  // 深浅色模式均无描边（纯玻璃质感，玻璃材质自带边缘光）
  const barStyle = useMemo(() => styles.bar, [])

  // 纯玻璃（2026-09-28 定案：玻璃不跟随主题色）：磨砂覆层走原生中性色（浅色白 /
  // 深色黑），浓度由 theme.glassOpacity 用户设置驱动，实时响应滑杆调节；
  // 液态形态走 kit 预设动态色（不传 tint）
  const glassOpacity = useSettingValue('theme.glassOpacity') / 100
  // 非选中项文字/图标色：c-450 在玻璃底衬上对比度只有 1.45~2.44:1（AA 需 4.5:1，
  // 且该色「可用背景亮度区间测度」仅 2.5%，材质救不了），按主题模式分派为经
  // scripts/sim-glass-contrast.js 断言5/7 验证的中性灰。⚠️ 与脚本常量
  // TAB_INACTIVE_LIGHT_V / TAB_INACTIVE_DARK_V 人工同步（脚本有反向指路注释）。
  const tabInactiveColor = theme.isDark ? TAB_INACTIVE_DARK : TAB_INACTIVE_LIGHT
  // 液态玻璃开关：仅 iOS 14~26.1 生效（开 → vendored Metal 液态玻璃；关 → 系统磨砂）。
  // **26.2+ 强制磨砂**（2026-09-30 定案）：UIGlassEffect(.regular) 在白底/图底页面
  // 切换瞬间闪烁，开关已从设置页隐藏，残留的开关值在此屏蔽——同时控制玻璃形态与
  // 液态透镜（LiquidLens）的渲染。最终兜底在 LiquidGlass 组件内部。
  const liquidGlassOn = useSettingValue('theme.liquidGlass') && !isIOS26_2OrAbove
  // 省电门：Home 被压栈页（播放详情等）完全覆盖时暂停玻璃的 Metal 渲染循环
  // （不可见期间零逐帧 draw；返回 Home 即恢复，原生重捕获背景无残帧）
  const homeCovered = useHomeCovered()

  // 收起形态（iOS 26 风格）：歌曲列表滚动离开顶部 → 整条 tab 栏收成左下角
  // 圆形玻璃按钮（宫格图标）；点击按钮弹出，保持展开直到下一次滚动离开顶部。
  const collapsed = useTabBarCollapsed()
  // 圆钮尺寸对齐收起态迷你播放器高度（宽=高保持圆形）；未测量时用 token 兜底。
  // 唯一来源是 getCollapsedPillSize——PlayerBar 收起态的左侧让位用的是同一个值，
  // 两处不再各写 55/57（尺寸分叉过一次，字体/测量时机一变就再分叉一次）
  const miniPlayerHeight = useMiniPlayerHeight()
  const pillSize = getCollapsedPillSize(miniPlayerHeight)
  // 收起行（圆钮 / 迷你播放器）底边距屏底的统一公式，与 PlayerBar 同源
  const floatBottom = collapsedFloatBottom(safeAreaBottom)
  const collapseAnim = useRef(new Animated.Value(collapsed ? 1 : 0)).current
  useEffect(() => {
    Animated.timing(collapseAnim, {
      toValue: collapsed ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start()
  }, [collapsed, collapseAnim])

  const handlePillPress = useCallback(() => {
    setTabBarExpanded()
  }, [])

  // 液态透镜（上游 LiquidLensView 的 tab 切换动画，仅液态玻璃开启时渲染）：
  // 点击切 tab → 药丸淡入 + 抬起 morph + 弹簧滑到目标项（加速度挤压/拉伸由
  // 透镜内部 displayLink 跟踪产生，全部原生驱动，JS 只更新目标 x）。关闭液态
  // 玻璃 / 收起态不渲染（tab 切换回到直接变色）。透镜条带铺满 tab 栏，静止态
  // 半透明白色药丸常显在选中 tab 上（上游 resting 状态）。
  // 长按/横滑拖拽切页曾在 2026-09-29 被移除（上游 LiquidGlassKit 无此手势层）；
  // 2026-10-01 按需求回归，但**不走原生的手势层**，而是复用同一套 followX 通道：
  // - B-7：首页 PagerView 手势拖动期间，JS 把逐帧进度喂给药丸（跟手）；
  // - A-5：长按底部 tab 激活药丸拖动，松手按落点吸附切页。
  const [barWidth, setBarWidth] = useState(0)
  const lensStyle = useMemo(() => StyleSheet.absoluteFill, [])
  const handleLensBarLayout = useCallback((e: LayoutChangeEvent) => {
    setBarWidth(e.nativeEvent.layout.width)
  }, [])
  // 子页面（WebDAV / 本地与下载 / 各平台歌单…）先归到它的父 tab，再定位药丸；
  // 不映射的话 findIndex 得 -1，指示器会跑到推荐位（详见 CHILD_TAB_PARENT 注释）。
  const resolvedActiveId = CHILD_TAB_PARENT[activeId] ?? activeId
  const activeIndex = Math.max(TAB_IDS.findIndex((tab) => tab.id === resolvedActiveId), 0)
  // 药丸目标中心 = 目标 tab 的中点；首次设置直接落位（不显形），之后原生弹簧滑动
  const lensX = barWidth > 0 ? ((activeIndex + 0.5) * barWidth) / TAB_IDS.length : 0
  // 药丸压扁（2026-09-29 定案）：宽度恒 = 一个 tab 区间的宽度 → 无论停在哪个 tab
  // 形状都一样；最左/最右 tab 时药丸左右边缘恰与胶囊（栏体玻璃）左右边缘重叠，
  // 上下边缘随条带铺满栏体高度而重叠（透镜与胶囊融合成一块玻璃）。圆角由原生取
  // min(宽,高)/2 = 28 = 栏体圆角，端头观感不变。
  const lensPillWidth = barWidth / TAB_IDS.length

  // ---- B-7 横滑跟手（Main → TabBar）+ A-5 长按拖动（共用同一套 followX 通道）----
  // 高频数据不走 state：订阅回调里只用 ref + 命令式 setNativeProps 驱动透镜
  //（LiquidLens 的 LiquidLensHandle，先例 VerticalNew.tsx:60-68），绝不 setState，
  // 避免 120Hz 逐帧重渲染整条 tab 栏。
  const lensRef = useRef<LiquidLensHandle>(null)
  const barWidthRef = useRef(0)
  // 当前 tab 对应的药丸静止槽心（由 resolvedActiveId 推导，见下方 lensX；C-2）
  const lensXRef = useRef(0)
  // 透镜当前是否渲染（收起态 / 液态玻璃关闭 / iOS 26.2+ / 未测宽 → 不渲染就不 arm）
  const lensReadyRef = useRef(false)
  // 子页面归属后的激活 tab（C-2）：拖动期间临时 x 可以跟手指，但**静止位与吸附
  // 目标**必须继续以它为基准，否则在 WebDAV 等子页面松手时药丸会归错槽
  const resolvedActiveIdRef = useRef<NAV_ID_Type>(activeId)
  const dragArmedRef = useRef(false)
  const draggingRef = useRef(false)
  const dragStartLensXRef = useRef(0)
  const lastDragCenterXRef = useRef(0)
  useEffect(() => {
    barWidthRef.current = barWidth
    lensXRef.current = lensX
    lensReadyRef.current = liquidGlassOn && !collapsed && barWidth > 0
    resolvedActiveIdRef.current = resolvedActiveId
  })

  // Main → TabBar：PagerView 手势进度（仅真实手势会话内发出，见 Main 的
  // pagerDragSessionRef）。position/offset 的约定取「position + offset」这个两种
  // 原生约定（floor+unsigned / round+signed）下都成立的连续进度，再夹到 [0, 4]。
  useEffect(() => subscribePagerProgress((position, offset) => {
    const width = barWidthRef.current
    if (width <= 0) return
    const slot = width / TAB_IDS.length
    const progress = Math.min(Math.max(position + offset, 0), TAB_IDS.length - 1)
    lensRef.current?.setFollowX((progress + 0.5) * slot)
  }), [])

  // Main → TabBar：手势会话开始/结束（抬起/放下透镜；结束时会话收尾）
  useEffect(() => subscribePagerDrag((dragging) => {
    lensRef.current?.setLifted(dragging)
    if (!dragging) lensRef.current?.endFollow()
  }), [])

  // A-5：长按某个 tab → arm 拖动（透镜抬起，等待手指移动接管）。
  // 边界：收起态 / 液态玻璃关闭 / iOS 26.2+（透镜不渲染）→ 不 arm，长按无效果。
  const handleTabLongPress = useCallback(() => {
    if (!lensReadyRef.current) return
    dragArmedRef.current = true
    lensRef.current?.setLifted(true)
  }, [])

  // A-5 收尾：吸附 + 切页 + 解除 arm（commit=false 为系统终止：落回当前槽心）
  const finishTabDrag = useCallback((commit: boolean) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    dragArmedRef.current = false
    emitTabBarDragActive(false)
    const width = barWidthRef.current
    const slot = width / TAB_IDS.length
    const centerX = lastDragCenterXRef.current
    if (commit && width > 0) {
      if (Math.abs(centerX - dragStartLensXRef.current) < 1) {
        // 位移 < 1pt：视作原地（长按未拖动），不切页
        lensRef.current?.setFollowX(lensXRef.current)
      } else {
        // 吸附公式（需求指定）：index = clamp(round(centerX / slot - 0.5), 0, 4)
        const index = Math.min(Math.max(Math.round(centerX / slot - 0.5), 0), TAB_IDS.length - 1)
        const targetId = TAB_IDS[index].id
        // 直接落到目标槽心（不走 x prop 的弹簧，松手即吸附）。落回原 tab 时
        // x prop 不会重发（React 不会因相同 props 重新下发），必须在这里收尾，
        // 否则药丸会停在松手点。
        lensRef.current?.setFollowX((index + 0.5) * slot)
        // 落点就是当前归属 tab 时只吸附回位、不切页（C-2：子页面激活时药丸停在
        // 父 tab 上，拖回父 tab 不应把用户从子页面里弹出去）
        if (targetId !== resolvedActiveIdRef.current) setNavActiveId(targetId)
      }
    } else {
      // 系统终止/拖动会话异常：落回当前 tab 槽心
      lensRef.current?.setFollowX(lensXRef.current)
    }
    lensRef.current?.setLifted(false)
    lensRef.current?.endFollow()
  }, [])

  // 长按后未拖动就抬手：收回抬起态并解除 arm（不切页——长按已抑制 onPress）。
  // 延后一拍判定：onPanResponderGrant（拖动接管）与本次抬手可能在同批事件里竞态，
  // 同步判定会误伤刚开始的拖动。
  const handleTabPressOut = useCallback(() => {
    setTimeout(() => {
      if (draggingRef.current || !dragArmedRef.current) return
      dragArmedRef.current = false
      lensRef.current?.setFollowX(lensXRef.current)
      lensRef.current?.setLifted(false)
      lensRef.current?.endFollow()
    }, 0)
  }, [])

  // A-5 手势层：挂在**内层** Animated.View（pointerEvents='auto' 的栏体）上——
  // 绝不能挂外层 wrapper（box-none，会挡不住/接不到栏体外的触摸，且与收起态圆钮
  // 图层重叠）。滚动预抢占先例见 NewListUI.tsx / Source.tsx（长按激活前不接管）。
  const panResponder = useMemo(() => PanResponder.create({
    // 不抢普通触摸：点击仍由 Pressable 处理，只有长按 arm 过才在移动时接管
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponderCapture: () => dragArmedRef.current,
    // 一旦接管就不再释放给外层（防被 PagerView/ScrollView 抢走）
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      draggingRef.current = true
      dragStartLensXRef.current = lensXRef.current
      lastDragCenterXRef.current = lensXRef.current
      // 锁住 pager 横滑（与 B-7 互斥）；透镜已被长按抬起
      emitTabBarDragActive(true)
    },
    onPanResponderMove: (_e, gestureState) => {
      const width = barWidthRef.current
      if (width <= 0) return
      const slot = width / TAB_IDS.length
      // 拖动中心 = 起手槽心 + dx（需求公式），夹在 [slot/2, width - slot/2]：
      // 药丸不越出栏体两端
      const centerX = Math.min(Math.max(dragStartLensXRef.current + gestureState.dx, slot / 2), width - slot / 2)
      lastDragCenterXRef.current = centerX
      lensRef.current?.setFollowX(centerX)
    },
    onPanResponderRelease: () => { finishTabDrag(true) },
    onPanResponderTerminate: () => { finishTabDrag(false) },
  }), [finishTabDrag])

  // 卸载兜底：拖动中卸载（退出登录/换主题重挂载等）必须解除 pager 锁，否则
  // PagerView 会永远停在不可滑状态
  useEffect(() => () => {
    if (draggingRef.current) emitTabBarDragActive(false)
    dragArmedRef.current = false
    draggingRef.current = false
  }, [])

  return (
    <>
      {/* 展开态整条 tab 栏与收起态圆钮分属两个**同级的绝对容器**，两者 left/right/
          bottom 完全一致，落在同一个包含块上——这是「同排」能成立的结构前提。
          历史教训（别再走回头路）：RN 0.73 默认不启用 Yoga 的 AbsolutePositioning
          Incorrect 修复，「父级 paddingBottom + 绝对子节点的 bottom」会叠加着再偏移
          一次，偏移量恰好等于被反复调的那个值，所以**调数值永远追不上**。修法是消除
          父级 padding 依赖：栏体留在带 paddingBottom 的 wrapper 里（栏是 in-flow
          子节点，padding 语义明确、位置一直是对的），圆钮移进无 padding 的独立图层。 */}
      <View
        style={[
          styles.wrapper,
          { paddingBottom: floatBottom },
        ]}
        pointerEvents="box-none"
      >
        {/* 完整 tab 栏：列表在顶部或手动展开时显示，收起时下滑淡出且不再响应触摸 */}
        <Animated.View
          onLayout={handleLensBarLayout}
          style={[
            barStyle,
            {
              opacity: collapseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
              transform: [{ translateY: collapseAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 28] }) }],
            },
          ]}
          pointerEvents={collapsed ? 'none' : 'auto'}
          // A-5 手势层挂在内层栏体上（见 panResponder 注释）；未 arm 时全部
          // shouldSet 返回 false，普通点击/触摸行为与之前完全一致
          {...panResponder.panHandlers}
        >
          {/* 玻璃衬底带与容器一致的圆角：按压下陷内缩时仍呈圆角，不露直角边。
              圆角 28 = 透镜圆角（56 药丸的胶囊半高，见 LiquidLensView），2026-09-29
              起玻璃端头曲线统一 circular，观感与透镜一致 */}
          <LiquidGlass glassOpacity={glassOpacity} dark={theme.isDark} liquid={liquidGlassOn} paused={homeCovered} style={{ borderRadius: designRadius.glass }} />
          {/* 液态透镜药丸（tab 切换动画）：玻璃之上、tab 内容之下；快速点击走
              Pressable 切页（x prop 弹簧），横滑跟手 / 长按拖动走 ref 命令式
              followX（同一套通道，见组件上部注释） */}
          {liquidGlassOn && !collapsed && barWidth > 0 && (
            <LiquidLens
              ref={lensRef}
              style={lensStyle}
              x={lensX}
              pillWidth={lensPillWidth}
            />
          )}
          {TAB_IDS.map((tab) => {
            const isActive = resolvedActiveId === tab.id
            return (
              <Pressable
                key={tab.id}
                style={styles.item}
                onPress={() => { setNavActiveId(tab.id) }}
                // A-5：长按激活拖动（delayLongPress 硬编码 250ms）；长按后 onPress
                // 被 Pressability 抑制（点/拖互斥白拿），onPressOut 负责「长按后未
                // 拖动就抬手」的收尾
                onLongPress={handleTabLongPress}
                delayLongPress={LONG_PRESS_MS}
                onPressOut={handleTabPressOut}
              >
                {/* 所有 tab 的图标统一放进同尺寸容器：love 是手绘描边心形，字形只占 1em 的
                    66%×63%，体量天生比别的字体图标小一成多，故放大到 30pt（相邻 21pt）
                    视觉高度才齐平；它仍居中在 24pt 容器里，不会撑高布局把文字顶下去。
                    ⚠️ 这个字号与 SvgIcon.HEART_STROKE_WIDTH 绑定（线宽 = 屏幕线宽*1024/字号），
                    改字号必须回去重算线宽，详见该常量注释与 scripts/sim-tabbar-icon-stroke.js */}
                <View style={styles.iconWrap}>
                  <Icon
                    name={tab.icon}
                    size={tab.icon === 'love' ? 30 : 21}
                    color={isActive ? theme['c-primary'] : tabInactiveColor}
                  />
                </View>
                <Text
                  style={styles.label}
                  size={12}
                  color={isActive ? theme['c-primary'] : tabInactiveColor}
                  numberOfLines={1}
                >
                  {t(TAB_LABEL_KEYS[tab.id])}
                </Text>
              </Pressable>
            )
          })}
        </Animated.View>
      </View>
      {/* 收起态圆钮的独立图层：无 padding / margin，圆钮 bottom 的 inset 不再经过任何
          父级 padding 的二次解析。高度=收起行高（图层底边=屏底），让圆钮整个落在图层
          bounds 之内（绝对子节点超出父级 bounds 时命中测试依赖 RN 的扩展行为，不赌它）。 */}
      <View
        style={[styles.pillLayer, { height: floatBottom + pillSize }]}
        pointerEvents="box-none"
      >
        {/* 收起态圆形玻璃按钮（宫格图标）：点击弹出完整 tab 栏；尺寸对齐迷你播放器高度。
            玻璃必须直接挂在动画容器下（与展开态 tab 栏同构），不能包进 Pressable——
            玻璃被 Pressable 包裹时收起圆钮显不出玻璃质感 */}
        <Animated.View
          style={[
            styles.pillWrapper,
            {
              // left 内联 scaleSizeW（与 tab 栏左右缘、播放器展开/收起让位同一个 24 基准），
              // bottom 与 PlayerBar 收起态共用 collapsedFloatBottom
              left: scaleSizeW(designSpacing.lg),
              bottom: floatBottom,
              width: pillSize,
              height: pillSize,
              opacity: collapseAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
              transform: [{ scale: collapseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }],
            },
          ]}
          pointerEvents={collapsed ? 'auto' : 'none'}
        >
          <LiquidGlass glassOpacity={glassOpacity} dark={theme.isDark} liquid={liquidGlassOn} paused={homeCovered} style={{ borderRadius: designRadius.pill }} />
          <Pressable style={styles.pillInner} onPress={handlePillPress}>
            <View style={styles.pillIcon} pointerEvents="none">
              <Icon name="menu" size={20} color={theme['c-primary']} />
            </View>
          </Pressable>
        </Animated.View>
      </View>
    </>
  )
})
