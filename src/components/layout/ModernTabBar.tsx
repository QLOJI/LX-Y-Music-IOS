import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, PanResponder, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { useNavActiveId, useHomeCovered, useSafeAreaReady, useNavTransitioning, useAppActive, usePagerDragging } from '@/store/common/hook'
import { setNavActiveId } from '@/core/common'
import { useSettingValue } from '@/store/setting/hook'
import { createStyle, isIOS26_2OrAbove } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { useTabBarCollapsed, useCollapsedRowGeometry } from '@/utils/tabBarCollapse'
import { setTabBarExpanded } from '@/utils/nativeModules/utils'
import { designRadius, designSpacing, tabBarBaseHeight } from '@/theme/DesignTokens'
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

// A-5「长按底部激活滑动」：长按激活拖动（松手按落点吸附切 tab）。
// 2026-10-01 需求「减少长按触发时间」：250 → **150**。
// 阈值压低后，「按得稍久的点击」会先触发长按、从而抑制 onPress——若不管它，
// 用户会觉得「点 tab 没反应」。故配一条回退：长按后**既没拖动**、按压时长又
// 短于 TAP_FALLBACK_MS 的，仍按点击语义切页（见 handleTabPressOut）。
const LONG_PRESS_MS = 150
const TAP_FALLBACK_MS = 350

export default memo(() => {
  const theme = useTheme()
  const t = useI18n()
  const activeId = useNavActiveId()

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
  // 转场门（2026-10-01 开窗；2026-10-02 只保留 push 侧）：整段 **push** 转场期间
  // 同样暂停——账本驱动的省电门盖不住转场本身（push 时新页 setComponentId 晚于
  // 转场开始），转场中间态被采进玻璃就是「每次切换画面闪一下」。
  // 返回（pop）不再置位：玻璃正在被露出来，按住只会让用户多看一截陈旧画面
  // （用户第 5 条），pop 事件到达即释放。见 navigation.beginNavTransitionWindow /
  // endNavTransitionWindow。
  const navTransitioning = useNavTransitioning()
  // 前台门（2026-10-02 用户第 8 条）：本 App 有音频后台播放能力，锁屏后进程仍常驻，
  // 但 Tab 栏的液态玻璃是 MTKView **连续渲染**（isPaused=false 时每帧 draw），
  // 不会随锁屏/退后台自动停 —— 于是整夜白烧电。账本驱动的省电门只看「被不被压栈页
  // 覆盖」，盖不住这一条：Home 在前台栈顶时它恒为 false。
  // 接进前台门后：App 退到后台（含 iOS 的 inactive）即停，回前台自动恢复
  // （原生恢复时重捕获背景，无残帧）。
  const appActive = useAppActive()
  // 实时采景门（2026-10-02 用户第 2/9 条）：首页横滑（PagerView 真实手势会话）期间，
  // 玻璃透过的画面此前被采景节流压在 30fps 档，而前景以 60~120fps 在动 —— 透过的
  // 画面系统性落后 1~3 拍，快速滑动时还会因欠采样看起来「反向切入」。会话期间置
  // live=true，原生按实时档（60fps 采景，渲染档同速，与抬起的透镜同档）跟手。
  const pagerDragging = usePagerDragging()
  // 安全区就绪门：底部安全区（bottom 的唯一来源）拿到真实值之前不下发，
  // 否则先用 0 画、再跳到 34pt = 「启动时底部抽动」。见 useSafeAreaReady。
  const safeAreaReady = useSafeAreaReady()

  // 收起形态（iOS 26 风格）：歌曲列表滚动离开顶部 → 整条 tab 栏收成左下角
  // 圆形玻璃按钮（宫格图标）；点击按钮弹出，保持展开直到下一次滚动离开顶部。
  const collapsed = useTabBarCollapsed()
  // 收起行几何（尺寸 / 底边 / 左缘 / 播放器让位）：与 PlayerBar 收起态**取同一个
  // 对象**，不再各算一遍——B1「迷你播放器高出圆钮、间距很大」重点修复，
  // 原理见 tabBarCollapse.useCollapsedRowGeometry 的注释。
  const collapsedRow = useCollapsedRowGeometry()
  const pillSize = collapsedRow.size
  const floatBottom = collapsedRow.bottom
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
  // B-7 跟手会话的收尾重锚（2026-10-01，修「松手后药丸停在半路」）：横滑跟手期间
  // 药丸位置**只**由 setFollowX 命令式驱动，React 侧的激活 tab 若没变，重渲染时
  // x prop 与上一次完全相同 → React 不会重新下发原生 prop → 透镜的静止位就停在手指
  // 离开的那一帧（用户看到「椭圆没和推荐/歌单/搜索/我的/设置对齐」）。手指松开
  //（pager 'idle'）时用最后写入的 follow 值判定「本次会话是否驱动过药丸」，
  // 驱动过就在收尾前补一次 setFollowX 锚回当前槽心。值 < 0 = 本次会话没驱动过。
  const lastFollowXRef = useRef(-1)
  // A-5 会话看门狗（P0 加固，2026-10-01）：拖动锁 emitTabBarDragActive(true) 只在
  // release / terminate / 卸载三处解除。一旦某次会话收不到收尾事件（系统手势抢占、
  // 原生子视图被回收、页面在拖动中被压栈覆盖…），Main 的 pagerScrollEnabled 会被
  // **永久**锁成 false——现象是「首页滑不动、只能杀进程」。两段式兜底：
  //   arm 后 8s 仍未真正接管 → 解除 arm（透镜落回原位）；
  //   接管后 8s 仍未收尾   → 强制收尾（落回原槽 + 解锁）。
  // 正常会话最长也就一两秒，8s 不可能是误伤。
  const armWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressOutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 「带点击回退的长按」用的按下信息（见 LONG_PRESS_MS 注释）
  const pressStartAtRef = useRef(0)
  const pressedTabIdRef = useRef<NAV_ID_Type | null>(null)
  useEffect(() => {
    barWidthRef.current = barWidth
    lensXRef.current = lensX
    lensReadyRef.current = liquidGlassOn && !collapsed && barWidth > 0
    resolvedActiveIdRef.current = resolvedActiveId
  })

  // B-7 会话收尾重锚：把药丸锚回「当前归属 tab 的槽心」。
  // 目标取 lensXRef.current（由 resolvedActiveId 推导的静止槽心，唯一真源）而不是
  // 「按最后跟手位置四舍五入」——后者在「拖动中途松手、pager 自己弹回原页」与
  // 「松手后惯性翻页、状态提交晚于 idle」两种时序下都会算错槽。取静止槽心则：
  //   正常跟手 → 最后一帧本来就在槽心（pager 的 scroll 事件一路发到落点），值相同，
  //              LiquidLens 内部 0.1pt 去重直接吞掉，零原生写入；
  //   中途松手 → 锚回原槽，正好是「弹回原页」的正确落点；
  //   惯性翻页 → 先锚回旧槽（不显示错误中间态），随即 x prop 变化触发弹簧走到新槽。
  // 只在本次会话真的驱动过药丸（lastFollowXRef ≥ 0）时执行：点击切页路径没有 follow
  // 写入，此时补写会走 setFollowX 的 removeAllAnimations 分支，把弹簧动画打断成瞬移。
  const snapLensToRestingSlot = useCallback(() => {
    if (lastFollowXRef.current < 0) return
    lastFollowXRef.current = -1
    lensRef.current?.setFollowX(lensXRef.current)
  }, [])

  // Main → TabBar：PagerView 手势进度（仅真实手势会话内发出，见 Main 的
  // pagerDragSessionRef）。position/offset 的约定取「position + offset」这个两种
  // 原生约定（floor+unsigned / round+signed）下都成立的连续进度，再夹到 [0, 4]。
  useEffect(() => subscribePagerProgress((position, offset) => {
    // A-5 拖动会话优先级最高（2026-10-01 修正，A2「椭圆无规律抽动」的直接来源）：
    // 长按 arm / 拖动期间，pager 的跟手进度一律丢弃。拖动时横滑已被
    // emitTabBarDragActive 锁住，但**锁之前**发车的进度帧、以及锁生效瞬间的
    // 迟到帧仍会到达；两路 setFollowX 交替写同一个 followX，就是「抽动」。
    if (dragArmedRef.current || draggingRef.current) return
    const width = barWidthRef.current
    if (width <= 0) return
    const slot = width / TAB_IDS.length
    const progress = Math.min(Math.max(position + offset, 0), TAB_IDS.length - 1)
    const followX = (progress + 0.5) * slot
    lastFollowXRef.current = followX
    lensRef.current?.setFollowX(followX)
  }), [])

  // Main → TabBar：手势会话开始/结束（抬起/放下透镜；结束时会话收尾）
  useEffect(() => subscribePagerDrag((dragging) => {
    // 同上：A-5 拖动/待拖动期间不接受 pager 的抬落指令，否则透镜会被
    // 「放下 → 抬起」来回翻转（抽动的另一半）。A-5 自己负责抬落（arm 时抬、
    // finishTabDrag 里落），不会因此卡在抬起态。
    if (dragArmedRef.current || draggingRef.current) return
    lensRef.current?.setLifted(dragging)
    if (!dragging) {
      // 收尾重锚必须在 endFollow() 之前：endFollow 会把 LiquidLens 的跟手去重值复位，
      // 之后任何 setFollowX 都必定写一次原生（含 removeAllAnimations）。先锚则正常
      // 情况下被去重吞掉，只有真的停在半路（值不同）才写。
      snapLensToRestingSlot()
      lensRef.current?.endFollow()
    }
  }), [snapLensToRestingSlot])

  // A-5：长按某个 tab → arm 拖动（透镜抬起，等待手指移动接管）。
  // 边界：收起态 / 液态玻璃关闭 / iOS 26.2+（透镜不渲染）→ 不 arm，长按无效果。
  const handleTabLongPress = useCallback((id: NAV_ID_Type) => {
    // 记录按下的 tab：长按没拖动就抬手时用它做「点击语义」回退
    pressedTabIdRef.current = id
    if (!lensReadyRef.current) return
    dragArmedRef.current = true
    // A-5 接管跟手通道：作废 B-7 留下的「会话驱动过药丸」标记，避免它被下一次
    // pager 收尾误消费（A-5 的落点由 finishTabDrag 自己显式锚定）。
    lastFollowXRef.current = -1
    lensRef.current?.setLifted(true)
    // arm 看门狗：只 arm 不接管（抬手被系统手势吃掉 / 抬手事件丢失）时自动解除，
    // 否则下一次触摸在栏体上滑动会被 PanResponder 当成拖动接管，连点击都受影响
    if (armWatchdogRef.current) clearTimeout(armWatchdogRef.current)
    armWatchdogRef.current = setTimeout(() => {
      armWatchdogRef.current = null
      if (draggingRef.current || !dragArmedRef.current) return
      dragArmedRef.current = false
      lensRef.current?.setFollowX(lensXRef.current)
      lensRef.current?.setLifted(false)
      lensRef.current?.endFollow()
    }, 8000)
  }, [])

  // A-5 收尾：吸附 + 切页 + 解除 arm（commit=false 为系统终止：落回当前槽心）
  const finishTabDrag = useCallback((commit: boolean) => {
    if (!draggingRef.current) return
    if (dragWatchdogRef.current) {
      clearTimeout(dragWatchdogRef.current)
      dragWatchdogRef.current = null
    }
    if (armWatchdogRef.current) {
      clearTimeout(armWatchdogRef.current)
      armWatchdogRef.current = null
    }
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
  // 2026-10-01 修正（A2「椭圆抽动」的第二来源）：原来是 setTimeout(...,0) 判定，
  // 而 onPanResponderGrant 是**原生手势事件**、过桥到达 JS 的时机晚于这个 0ms 宏任务
  // ——「长按 → 快速拖动」会在 grant 到达前就把 arm 清掉，拖动被腰斩、透镜弹回起点。
  // 现在改为 400ms 宽限，且真正的接管会在 grant 里清掉本定时器。
  const handleTabPressIn = useCallback((id: NAV_ID_Type) => {
    // 新一轮触摸开始（2026-10-01，P0）：上一次拖动会话若没走到收尾（onPanResponderRelease/
    // Terminate 被系统手势吃掉、事件丢失），draggingRef 会残留——本次移动在
    // onMoveShouldSetPanResponderCapture 里就会被当成拖动接管，同时 pager 横滑的
    // A-5 锁也停在锁死态（旧代码只靠两道 8s 看门狗兜底，用户会先经历 8 秒滑不动的假死）。
    // 触摸按下是「新会话开始」的确切信号，在这里强制收尾最及时（finishTabDrag(false)
    // 内部会 emitTabBarDragActive(false)，幂等）。
    if (draggingRef.current) finishTabDrag(false)
    pressStartAtRef.current = Date.now()
    pressedTabIdRef.current = id
  }, [finishTabDrag])
  const handleTabPressOut = useCallback(() => {
    // 按压时长必须在这里取：下面的定时器要 400ms 之后才跑，那时 Date.now() 已经不对了
    const releasedAt = Date.now()
    if (pressOutTimerRef.current) clearTimeout(pressOutTimerRef.current)
    pressOutTimerRef.current = setTimeout(() => {
      pressOutTimerRef.current = null
      if (draggingRef.current) return
      if (!dragArmedRef.current) return
      dragArmedRef.current = false
      lensRef.current?.setFollowX(lensXRef.current)
      lensRef.current?.setLifted(false)
      lensRef.current?.endFollow()
      // 点击语义回退（LONG_PRESS_MS 压到 150 的配套）：长按触发了、但既没拖动、
      // 按压时长又短于 TAP_FALLBACK_MS —— 用户本意就是「点一下这个 tab」，
      // 补上一次切页，否则会表现为「点 tab 没反应」。
      const id = pressedTabIdRef.current
      if (id && releasedAt - pressStartAtRef.current < TAP_FALLBACK_MS) setNavActiveId(id)
    }, 400)
  }, [])

  // A-5 手势层：挂在**内层** Animated.View（pointerEvents='auto' 的栏体）上——
  // 绝不能挂外层 wrapper（box-none，会挡不住/接不到栏体外的触摸，且与收起态圆钮
  // 图层重叠）。滚动预抢占先例见 NewListUI.tsx / Source.tsx（长按激活前不接管）。
  const panResponder = useMemo(() => PanResponder.create({
    // 不抢普通触摸：点击仍由 Pressable 处理，只有长按 arm 过才在移动时接管
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponderCapture: () => dragArmedRef.current,
    // 只在**真的处于拖动会话中**才拒绝让出 responder（P0，2026-10-02 用户第 4 条）。
    // 原写法无条件 `() => false`：RN 的 responder 只由同一个触摸流的 end/cancel 释放，
    // 而本仓多处注释都记录了「抬手事件被系统手势吃掉 / 抬手事件丢失」是常态（arm /
    // drag 两道看门狗就是为此加的）。一旦 release 丢失，这个 responder 会被**永久**
    // 持有并拒绝让出——RN 里每一次新的按压都必须先把 responder 从持有者手里拿过来
    // （setResponder → onResponderTerminationRequest），被拒就整屏「点不动」；而
    // UIScrollView 的平移是原生手势、根本不经过 responder，所以「列表还能滑」；
    // 再滑一下会触发 UIKit 的 touch cancel → RN 释放 responder → 又能点了。
    // 即用户报的「切回某个页面后点击锁死、但可以滑动、滑动后就可以点击」。
    // 收紧成「拖动会话中」后，拖动期间语义完全不变（拖动时 draggingRef 恒 true，
    // 依旧是拒绝被 PagerView/ScrollView 抢走），而任何泄漏的 responder 都会被下一次
    // 按压立即顶掉——自愈不再需要用户先滑一下。注意不能写成 dragArmedRef：arm 只
    // 表示「长按已触发、等待移动接管」，此时我们并不是 responder，让出条件用
    // draggingRef（真被授予过）才是准确的那条边界。
    // 极性（RN 语义，最容易写反的一处）：onResponderTerminationRequest **返回 false = 拒绝
    // 让出**、返回 true = 同意交出去，所以「拖动会话中拒绝」必须取反写
    // `!draggingRef.current`。写成 `() => draggingRef.current` 就整个反了：拖动期间主动
    // 让出（横滑被 PagerView 抢走、拖动中断），不拖动时反而永久拒绝（泄漏后照旧点不动）。
    onPanResponderTerminationRequest: () => !draggingRef.current,
    onPanResponderGrant: () => {
      draggingRef.current = true
      dragStartLensXRef.current = lensXRef.current
      lastDragCenterXRef.current = lensXRef.current
      // 真正接管了：撤销「长按后没拖动」的抬手收尾，以及 arm 看门狗
      if (pressOutTimerRef.current) {
        clearTimeout(pressOutTimerRef.current)
        pressOutTimerRef.current = null
      }
      if (armWatchdogRef.current) {
        clearTimeout(armWatchdogRef.current)
        armWatchdogRef.current = null
      }
      // 拖动看门狗：收尾事件丢失时强制收尾，避免 pager 横滑被永久锁死
      if (dragWatchdogRef.current) clearTimeout(dragWatchdogRef.current)
      dragWatchdogRef.current = setTimeout(() => {
        dragWatchdogRef.current = null
        finishTabDrag(false)
      }, 8000)
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
    if (armWatchdogRef.current) { clearTimeout(armWatchdogRef.current); armWatchdogRef.current = null }
    if (dragWatchdogRef.current) { clearTimeout(dragWatchdogRef.current); dragWatchdogRef.current = null }
    if (pressOutTimerRef.current) { clearTimeout(pressOutTimerRef.current); pressOutTimerRef.current = null }
  }, [])

  // 安全区未就绪前整条栏不下发（见 useSafeAreaReady）：本栏（含收起圆钮）的底边
  // 完全由 safeAreaBottom 决定，先用 0 画出来再跳到 34pt 就是「启动时抽动」。
  // 放在所有 hook 之后（前面的订阅/看门狗必须照常挂上，否则栏一出现就少一层兜底）。
  if (!safeAreaReady) return null

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
          {/* 省电门扩展（C9 发热）：本栏在收起态是**完全不可见**的（opacity 0 + 下移 28），
              却仍在跑 Metal 逐帧渲染 —— 收起态是长时间驻留状态（只要列表不停在顶部），
              这是纯白烧的电。可见性一并纳入门控。 */}
          <LiquidGlass glassOpacity={glassOpacity} dark={theme.isDark} liquid={liquidGlassOn} paused={homeCovered || collapsed || navTransitioning || !appActive} live={pagerDragging} style={{ borderRadius: designRadius.glass }} />
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
                // A-5：长按激活拖动（delayLongPress = LONG_PRESS_MS）；长按后 onPress
                // 被 Pressability 抑制（点/拖互斥白拿），onPressOut 负责「长按后未
                // 拖动就抬手」的收尾（并对短按做点击回退）
                onPressIn={() => { handleTabPressIn(tab.id) }}
                onLongPress={() => { handleTabLongPress(tab.id) }}
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
              // left / bottom 直接取收起行几何（与 PlayerBar 收起态同一个对象）：
              // left 是 scaleSizeW 后的 24 基准（与 tab 栏左右缘、播放器展开态左缘同源），
              // bottom 就是 PlayerBar 收起态的 bottom。这里**不再自己算**。
              left: collapsedRow.roundLeft,
              bottom: collapsedRow.bottom,
              width: pillSize,
              height: pillSize,
              opacity: collapseAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
              transform: [{ scale: collapseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }],
            },
          ]}
          pointerEvents={collapsed ? 'auto' : 'none'}
        >
          {/* 同上：圆钮在展开态完全不可见（opacity 0 + scale 0.5），可见性纳入省电门 */}
          <LiquidGlass glassOpacity={glassOpacity} dark={theme.isDark} liquid={liquidGlassOn} paused={homeCovered || !collapsed || navTransitioning || !appActive} live={pagerDragging} style={{ borderRadius: designRadius.pill }} />
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
