import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, PanResponder, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { useNavActiveId, useHomeCovered, useSafeAreaReady, useNavTransitioning, useAppActive, usePagerDragging } from '@/store/common/hook'
// 【第 35 轮第 3 条】静止槽心的「新鲜」取值源：直读 store 的 navActiveId（同步写、
// 同步发事件），比 React state 早一整个提交周期。见 resolveRestingSlotX
import commonState from '@/store/common/state'
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
    //
    // 【第 37 轮】这里**不再裁剪**（原 overflow: 'hidden' → 'visible'）：
    //   · 新增样式「长按后气泡变大成水珠」要求透镜纵向溢出栏体上下边缘（参考图里
    //     水珠明显高出栏体一头）。透镜是栏体的**兄弟子节点**，栏体一裁剪，水珠就被
    //     上下削平成一条宽胶囊，造型根本出不来。
    //   · 栏体的圆角不依赖这层裁剪：LiquidGlass 宿主自己把 RN 下发的 borderRadius
    //     转发给玻璃容器（LiquidGlassViewManager.mm 的 layoutSubviews：container
    //     .clipsToBounds + cornerRadius；Metal 路径另有 shader uniforms.cornerRadius
    //     驱动折射形状），两处圆角本来就是同一个 token（designRadius.glass），
    //     裁剪只是历史冗余。
    //   · 透镜的速度形变纵向只缩不涨（LiquidLensView.applySpeedSize 的
    //     scaleY = 1 - s ≤ 1）：静止药丸不会往上顶出去；横向最多涨到约 1.18 倍槽宽，
    //     只在快速切页的一瞬间贴近栏体左右端头，与上游（系统 tab 栏同样不裁剪透镜）
    //     观感一致，可接受。
    //   · ⚠️ 也不能改成「给玻璃单独套一层裁剪 wrapper」：液态路径的捕获排除根 =
    //     玻璃宿主的 superview（见 installGlassBacking 注释），套 wrapper 会把 tab
    //     图标/文字漏进玻璃的背景捕获纹理，产生重影。
    overflow: 'visible',
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

// B-7 横滑跟手会话的超时兜底（见 armFollowWatchdog 的注释）。本定时器会在每个跟手帧上
// **重新记账**（测的是「多久没有新的跟手帧」而不是「会话开了多久」）。
// 【第 37 轮第 1 条】12s → 4s。理由：Main 侧的同名兜底（PAGER_DRAG_SILENCE_MS = 2000）
// 本来就会在「最后一帧之后 2s」收尾并 emitPagerDrag(false)，正常路径根本轮不到本
// 看门狗；它只在「Main 的收尾链路整个没跑」时兜底（例如事件在桥上层被丢弃）。而 12s
// 意味着真出这种事时用户要盯着一个错位/抬起态的药丸 12 秒——这正是用户报的「只有滑动
// 会错位、点一下才好」（点击路径会立刻收尾）。4s = Main 的 2s + 一整个往返的余量，
// 比 Main 的判据更保守，不会和它抢：真实拖动每帧都在续期，按住不动最长 2s 就由 Main
// 先行收尾（本看门狗随即被销毁）。
const FOLLOW_SESSION_TIMEOUT_MS = 4000

// 【第 35 轮第 3 条】手势收尾后「静止位重申」的时刻表（ms，相对收尾瞬间）。
// 用户原话：「当我左右滑动主界面时，底部 tab 的椭圆形水泡边缘与我的文字不是中心对齐，
// 左边明显大点，如果我点击就不会有这个情况，只有滑动才会出现这个问题」。
//
// 为什么一次重锚不够：收尾那一刻能做的只是「把药丸写回当时算出来的槽心」，而它可能
//  ① 算在**旧的**归属 tab 上（pager 的 idle 事件与「onPageSelected 引发的 React 提交」
//     赛跑，提交还没跑完，读到的静止槽心还是上一页的）；
//  ② 被随后到达的迟到跟手帧 / 被点击路径的弹簧动画打断在半路 —— 而 x prop 只在**值变化**
//     时下发，值没变就不会再发，错位就地固化（这正是「点一下就好、只有滑动才会」的成因：
//     点击一定改变 lensX，于是重发一次 x，药丸被拽回正确槽心）。
// 重申是幂等的：目标始终是「当下」的槽心（resolveRestingSlotX 直读 store），已经对齐时
// LiquidLens 的 0.1pt 去重与原生同位守卫都会把它吞成零写入。任一次重申若发现新一轮跟手
// 已经开始（lastFollowXRef ≥ 0），立刻让位 —— 绝不和手指抢位置。
const REST_REASSERT_DELAYS = [120, 360, 800, 1600]

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
  // 【第 35 轮第 3 条】收尾后的「静止位重申」定时器表（见 reassertRestingSlot）
  const restReassertTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
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
  // B-7 跟手会话看门狗（2026-10-08）：见 armFollowWatchdog 注释
  const followWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 「带点击回退的长按」用的按下信息（见 LONG_PRESS_MS 注释）
  const pressStartAtRef = useRef(0)
  const pressedTabIdRef = useRef<NAV_ID_Type | null>(null)
  useEffect(() => {
    barWidthRef.current = barWidth
    lensXRef.current = lensX
    lensReadyRef.current = liquidGlassOn && !collapsed && barWidth > 0
    resolvedActiveIdRef.current = resolvedActiveId
  })

  // 【第 35 轮第 3 条】「当下」的静止槽心。与 lensX 是同一个公式（(i + 0.5) * 槽宽，
  // 槽宽 = 栏宽 / 5），差别只在取值时机：
  //   · lensX 来自 useNavActiveId() 这个 React state —— 要等 onPageSelected 引发的
  //     那次提交跑完 effect（本文件 300 行那个无依赖 useEffect）才写进 lensXRef；
  //   · 这里直读 store 的 navActiveId —— setNavActiveId 是**同步**写 state + 同步发事件的
  //    （store/common/action.ts），比 React 提交早一整个周期。
  // 收尾/重申都可能在提交之前发生，所以必须走这条「新鲜」的路。
  const resolveRestingSlotX = useCallback(() => {
    const width = barWidthRef.current
    if (width <= 0) return lensXRef.current
    // 子页面归属（C-2）：navActiveId 可能是 WebDAV 这类子页 id，映射回所属 tab 再取槽
    const activeIdNow = commonState.navActiveId
    const normalized = CHILD_TAB_PARENT[activeIdNow] ?? activeIdNow
    const index = TAB_IDS.findIndex((tab) => tab.id === normalized)
    if (index < 0) return lensXRef.current
    return ((index + 0.5) * width) / TAB_IDS.length
  }, [])

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
    // 【第 35 轮第 3 条】目标改成**当下**的静止槽心（resolveRestingSlotX 直读 store），
    // 不再是 lensXRef：后者的新鲜度取决于「onPageSelected 引发的那次 React 提交」，
    // 而收尾事件（pager idle）可能与这次提交赛跑。提交还没跑完就收尾 ⇒ 锚回**旧槽**，
    // 药丸就停在旧槽上 —— 且「滑回同一个 tab」根本不产生 lensX 变化，不会再有下一次
    // 重发把它拽回来（用户第 35 轮第 3 条：只有滑动会错位、点一下就好）。
    // 【第 37 轮第 1 条】force 写：收尾锚回是「权威落位」，必须过桥、且原生侧不过
    // 同位守卫（见 LiquidLens.setFollowX / applyFollowX 的注释）——它要纠正的恰恰是
    // 「原生 _x 已经等于槽心、显示却停在别处」这种错位，普通写会被两头去重吞掉。
    lensRef.current?.setFollowX(resolveRestingSlotX(), true)
  }, [resolveRestingSlotX])

  // 【第 35 轮第 3 条】静止位重申（收尾自愈，见 REST_REASSERT_DELAYS 的注释）。
  // 清账：新一轮会话开始时调用（手指接管期间不留任何迟到的重申）。
  const clearRestReassert = useCallback(() => {
    for (const timer of restReassertTimersRef.current) clearTimeout(timer)
    restReassertTimersRef.current = []
  }, [])
  const reassertRestingSlot = useCallback(() => {
    clearRestReassert()
    for (const delay of REST_REASSERT_DELAYS) {
      restReassertTimersRef.current.push(setTimeout(() => {
        // 【第 37 轮第 1 条】让位条件收紧成「真的在拖动」。
        // 原写法把 dragArmedRef 也算进来：A-5 的 arm 只表示「长按已触发、等待移动
        // 接管」，它靠三道超时（400ms 抬手 / 8s arm / 8s drag）解除——任何一次抬手
        // 事件被系统手势吃掉，arm 就会挂在那里最多 8s。这 8s 里 B-7 的每一次静止位
        // 重申都被这句话挡掉，而药丸此刻既没跟手、也没人管 —— 用户看到的就是
        // 「滑一下之后椭圆与文字不对中，点一下才好」。拖动中（draggingRef）让位是
        // 必须的（手指正握着药丸），arm 未接管时药丸仍在槽上，重申是幂等的零写入。
        if (draggingRef.current) return
        // 新一轮 B-7 跟手已经开始（有帧驱动过药丸）：让位，别和手指抢位置
        if (lastFollowXRef.current >= 0) return
        lensRef.current?.setFollowX(resolveRestingSlotX(), true)
      }, delay))
    }
  }, [clearRestReassert, resolveRestingSlotX])

  // 【第 35 轮第 3 条】卸载时撤掉未到点的静止位重申（定时器持有一个已死的 lensRef）
  useEffect(() => clearRestReassert, [clearRestReassert])

  // B-7 会话兜底收尾（2026-10-08）：与正常 idle 收尾同一套动作、同一顺序
  //（锚回槽心 → 落回静止药丸 → 复位跟手去重），供看门狗在「收尾事件丢失」时调用。
  // 顺序不可换：snap 必须在 endFollow 之前，否则 setFollowX 会走 removeAllAnimations
  // 分支打断弹簧（同 subscribePagerDrag 里正常收尾的注释）。
  const closePagerFollowSession = useCallback(() => {
    snapLensToRestingSlot()
    lensRef.current?.setLifted(false)
    // 【第 37 轮第 1 条】兜底收尾也要收水珠：水珠是 A-5 长按的造型，理论上本分支
    // 不会在 A-5 会话里执行（调用点都有 dragging 守卫），但收尾路径宁可多一句幂等
    // 的复位——一个卡在抬起/水珠态的透镜会一直挂在栏上，比少一次造型难看得多。
    lensRef.current?.setDroplet(false)
    lensRef.current?.endFollow()
    // 【第 35 轮第 3 条】兜底收尾同样要走「重申」：这条路径出现时收尾事件本来就丢了，
    // 此刻读到的归属 tab 更可能是旧值（提交没跑完），一次重锚不足以定住。
    reassertRestingSlot()
  }, [snapLensToRestingSlot, reassertRestingSlot])

  // B-7 会话看门狗（2026-10-08，用户报「椭圆与其中文字和图标没有中心对齐」的兜底）：
  // 横滑跟手期间药丸只由 followX 命令式驱动（不经过 x prop），**收尾完全依赖 Main 发出的
  // pager 'idle'**（subscribePagerDrag(false)）。该事件会被系统手势抢占、被压栈转场吞掉、
  // 或随 App 退后台丢掉——A-5 的注释里已把「抬手事件丢失」记为常态并配了两道 8s 看门狗，
  // 而 B-7 这条通道一直没有兜底。丢收尾的后果有两层，任一都在屏幕上留痕：
  //   1) 药丸中心停在手指离开的那一帧（不是槽心）→ 椭圆与图标/文字错位，且因为
  //      «x prop 值没变 → React 不会重发» 而**永不自愈**；
  //   2) 透镜停在抬起态 → 原生 displayLink 不落回、逐帧在跑（白烧电），静止药丸不现身。
  // 记账方式：会话开始 arm；每个跟手帧重新记账（refreshFollowWatchdog，测「无帧时长」）；
  // 收到正常 idle 即销毁。超时未收尾 → closePagerFollowSession()。
  const armFollowWatchdog = useCallback(() => {
    if (followWatchdogRef.current) clearTimeout(followWatchdogRef.current)
    followWatchdogRef.current = setTimeout(() => {
      followWatchdogRef.current = null
      // 已被 A-5 接管（长按 arm / 拖动中）：药丸归手势管，兜底立即让位——
      // 否则会在用户按住拖动的中途把药丸锚回槽心（跟手指抢位置）。
      if (dragArmedRef.current || draggingRef.current) return
      closePagerFollowSession()
    }, FOLLOW_SESSION_TIMEOUT_MS)
  }, [closePagerFollowSession])

  // 静止锚点自愈（2026-10-08）：x prop 只在**值变化**时下发，而跟手通道会把药丸中心写到
  // 任意位置。任何一次「native `_x` 与 JS lensX 脱钩」（跟手会话丢收尾、被中断的弹簧、
  // 重挂载后残留的位置）都会因为 prop 值不变而**永久**留着 —— 用户看到的就是椭圆与其中
  // 图标/文字没有中心对齐（2026-10-08 报障）。这里在每一次「锚点输入」变化（含挂载、
  // 切换 tab/子页面归属变化、栏宽变化、收起/展开、液态开关切换）都经 setRestX 重申一次
  // 静止位：它走的是与 x prop 完全相同的原生通道（setTargetX:animated:YES），原生的
  // 同位守卫（差 <0.5pt 直接吞掉）保证没漂移时是零开销 no-op、不重播任何动画；
  // 真漂了才播一次回位弹簧。
  // 注意：不能拿 setFollowX 代替 —— 那条通道是 removeAllAnimations + 直落，会在点击切页
  // 时把「淡入 + 抬起 + 弹簧」动画打断成瞬移。A-5 会话期间不重申（药丸归手势管，且 A-5
  // 收尾自己会把药丸锚回 lensXRef，同一个值，不依赖本效果）。
  useEffect(() => {
    if (!liquidGlassOn || collapsed || barWidth <= 0) return
    if (dragArmedRef.current || draggingRef.current) return
    lensRef.current?.setRestX(lensX)
  }, [lensX, resolvedActiveId, barWidth, collapsed, liquidGlassOn])

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
    // 逐帧重新记账（见 armFollowWatchdog）：本看门狗测的是「多久没有新帧」而不是
    // 「会话开了多久」——手指按住不动时 pager 会停止发帧，但只要会话还活着就说明
    // 收尾事件仍有可能正常到达，阈值给足（12s）就不会误伤。
    armFollowWatchdog()
  }), [armFollowWatchdog])

  // Main → TabBar：手势会话开始/结束（抬起/放下透镜；结束时会话收尾）
  useEffect(() => subscribePagerDrag((dragging) => {
    // A-5 拖动期间不接受 pager 的抬落指令，否则透镜会被「放下 → 抬起」来回翻转
    //（抽动的另一半）。A-5 自己负责抬落（arm 时抬、finishTabDrag 里落）。
    // 【第 37 轮第 1 条】让位条件从 `dragArmedRef || draggingRef` 收紧成
    // **只在真的拖动中让位**（与上一轮 reassertRestingSlot 同一处病根）：
    //   · 「抬起」（true）在 arm 期间照旧丢弃 —— 手在栏上，抬落归 A-5；
    //   · 「放下」（false）**必须放行**：这是 B-7 会话的收尾信号（Main 的 idle 或
    //     2s 静默兜底）。原写法里只要 arm 标志还挂着（长按抬手事件被系统手势吃掉
    //     时最长挂 8s），这个收尾就会被整句吞掉——透镜既不落回、药丸也不锚回槽心，
    //     而 A-5 因为根本没接管（dragging=false）也不会来收尾，于是药丸停在手指
    //     离开的那一帧、还是抬起玻璃的造型（用户看到的「椭圆形气泡」）。
    //     arm 未接管时药丸仍在槽上，让收尾跑完是安全的（幂等的零写入）；
    //     真在拖动中才让位（那时 A-5 的 finishTabDrag 负责全部收尾）。
    if (draggingRef.current) return
    if (dragging && dragArmedRef.current) return
    lensRef.current?.setLifted(dragging)
    if (dragging) {
      // B-7 会话开始：启动兜底看门狗（真收尾在下面的 !dragging 分支销毁它）。
      // 会话开始与首个进度帧的到达顺序不保证（都过桥），两处都 arm，幂等。
      armFollowWatchdog()
      // 【第 35 轮第 3 条】新一轮手势开始：撤掉上一轮留下的静止位重申（否则它会在
      // 手指还按着的时候把药丸拽回槽心）
      clearRestReassert()
    } else {
      // 正常收尾：先销毁看门狗（这一次不再需要兜底）
      if (followWatchdogRef.current) {
        clearTimeout(followWatchdogRef.current)
        followWatchdogRef.current = null
      }
      // 收尾重锚必须在 endFollow() 之前：endFollow 会把 LiquidLens 的跟手去重值复位
      //（第 37 轮起复位到 -1 哨兵），先锚则这一笔走的是「上一帧的目标值」去重口径，
      // 语义上没有歧义（且它本身是 force 写，两头都不会吞）。
      // 【第 37 轮第 1 条】收尾是「落回静止药丸」的唯一时机：这里必须把水珠一起收掉
      //（本分支只可能在真实 pager 会话结束时到达，A-5 的造型不该跨会话存活）。
      snapLensToRestingSlot()
      lensRef.current?.setDroplet(false)
      lensRef.current?.endFollow()
      // 【第 35 轮第 3 条】收尾之后再重申几次静止位（见 REST_REASSERT_DELAYS 注释）
      reassertRestingSlot()
    }
  }), [snapLensToRestingSlot, armFollowWatchdog, clearRestReassert, reassertRestingSlot])

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
    // 同步销毁 B-7 的兜底看门狗：B-7 会话逻辑上已结束，收尾由 A-5 全权负责。
    //（不销毁也不致错——看门狗触发时有 dragArmed/dragging 守卫会让位——但留着
    // 就会在 A-5 会话结束后凭空多触发一次无意义的收尾。）
    if (followWatchdogRef.current) {
      clearTimeout(followWatchdogRef.current)
      followWatchdogRef.current = null
    }
    // 【第 37 轮第 1 条】新一轮 A-5 会话开始：撤掉上一轮留下的静止位重申
    //（否则它会在手指还按着的时候把药丸拽回槽心）
    clearRestReassert()
    lensRef.current?.setLifted(true)
    // 【第 37 轮新增样式】长按即长成水珠（直径 ≈ 1.45 × 栏高、纵向溢出栏体，
    // 见 LiquidGlassViewManager 的 kLGDropletScale）。与抬起同拍下发：抬起负责
    // 「亮出液态玻璃」，水珠负责「变大成圆」。所有收尾路径都会 setDroplet(false)。
    lensRef.current?.setDroplet(true)
    // arm 看门狗：只 arm 不接管（抬手被系统手势吃掉 / 抬手事件丢失）时自动解除，
    // 否则下一次触摸在栏体上滑动会被 PanResponder 当成拖动接管，连点击都受影响
    if (armWatchdogRef.current) clearTimeout(armWatchdogRef.current)
    armWatchdogRef.current = setTimeout(() => {
      armWatchdogRef.current = null
      if (draggingRef.current || !dragArmedRef.current) return
      dragArmedRef.current = false
      // force 写：arm 未接管就解除时药丸本来就在槽上，这一笔是「权威复位」，
      // 无需被 0.1pt 去重挡下（真被别的东西写到别处时它必须落下去）
      lensRef.current?.setFollowX(lensXRef.current, true)
      lensRef.current?.setLifted(false)
      lensRef.current?.setDroplet(false)
      lensRef.current?.endFollow()
    }, 8000)
  }, [clearRestReassert])

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
        lensRef.current?.setFollowX(lensXRef.current, true)
      } else {
        // 吸附公式（需求指定）：index = clamp(round(centerX / slot - 0.5), 0, 4)
        const index = Math.min(Math.max(Math.round(centerX / slot - 0.5), 0), TAB_IDS.length - 1)
        const targetId = TAB_IDS[index].id
        // 直接落到目标槽心（不走 x prop 的弹簧，松手即吸附）。落回原 tab 时
        // x prop 不会重发（React 不会因相同 props 重新下发），必须在这里收尾，
        // 否则药丸会停在松手点。force 写（第 37 轮第 1 条）：吸附是权威落位，
        // 不吃 0.1pt 去重。
        lensRef.current?.setFollowX((index + 0.5) * slot, true)
        // 落点就是当前归属 tab 时只吸附回位、不切页（C-2：子页面激活时药丸停在
        // 父 tab 上，拖回父 tab 不应把用户从子页面里弹出去）
        if (targetId !== resolvedActiveIdRef.current) setNavActiveId(targetId)
      }
    } else {
      // 系统终止/拖动会话异常：落回当前 tab 槽心
      lensRef.current?.setFollowX(lensXRef.current, true)
    }
    lensRef.current?.setLifted(false)
    // 【第 37 轮新增样式】收尾即缩回胶囊：A-5 的所有结束路径都必须收水珠，
    // 否则长按的水珠造型会一直挂在栏上（比少一个造型难看得多）
    lensRef.current?.setDroplet(false)
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
      lensRef.current?.setFollowX(lensXRef.current, true)
      lensRef.current?.setLifted(false)
      // 【第 37 轮新增样式】长按未拖动就抬手：水珠同样要收（不然它会一直挂着）
      lensRef.current?.setDroplet(false)
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
    if (followWatchdogRef.current) { clearTimeout(followWatchdogRef.current); followWatchdogRef.current = null }
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
