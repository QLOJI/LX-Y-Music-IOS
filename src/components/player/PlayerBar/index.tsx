import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { Animated, Easing, View, TouchableOpacity } from 'react-native'
import { useHorizontalMode, useKeyboard } from '@/utils/hooks'
import { scaleSizeH } from '@/utils/pixelRatio'
import { useTabBarCollapsed, setMiniPlayerHeight, useCollapsedRowGeometry } from '@/utils/tabBarCollapse'
import Pic from './components/Pic'
import Title from './components/Title'
import PlayInfo from './components/PlayInfo'
import ControlBtn from './components/ControlBtn'
import { createStyle, isIOS26_2OrAbove } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { navigations } from '@/navigation'
import { PLAY_DETAIL_SCREEN } from '@/navigation/screenNames'
import commonState from '@/store/common/state'
import playerState from '@/store/player/state'
import { getJumpListId } from '@/core/player/player'
import { LIST_IDS } from '@/config/constant'
import { useSafeAreaBottom, useScreenCovered, useSafeAreaReady, useNavTransitioning } from '@/store/common/hook'
import { usePlayerMusicInfo } from '@/store/player/hook'
import {
  designRadius,
  designSpacing,
  designMotion,
  bottomFloatGap,
  tabBarBaseHeight,
  floatDistance,
} from '@/theme/DesignTokens'
import LiquidGlass from '@/components/common/LiquidGlass'

export default memo(({ componentId, isHome = false }: { componentId?: string, isHome?: boolean }) => {
  // 省电门：本屏被压栈页覆盖（栈顶不是本屏）时暂停玻璃 Metal 渲染循环。
  // PlayerBar 多屏复用（Home / 专辑页 / 歌手页…），按各自 componentId 判定；
  // 调用方未传 componentId 时恒不门控（行为同旧版）。
  const screenCovered = useScreenCovered(componentId)
  // 转场门（2026-10-01）：整段 push/pop 转场期间也暂停玻璃——省电门只看账本，
  // 盖不住转场本身（转场中间态被采进胶囊 = 每次切换画面闪一下），见
  // navigation.beginNavTransitionWindow。
  const navTransitioning = useNavTransitioning()
  // 安全区就绪门（仅首页实例用得上，见下方 return）：首页播放器的底边 =
  // 安全区 + 底缝 + Tab 栏高 + 滑块距离，安全区没回来之前不下发，
  // 否则先用 0 画出来、再跳到 34pt = 「启动时抽动」。
  const safeAreaReady = useSafeAreaReady()
  // 键盘订阅（willShow: true → keyboardWillShow 起跑，与键盘动画同时）：
  // 迷你播放器**不隐藏**，改为随键盘上浮（见下方 keyboardLift）。
  const { keyboardShown, keyboardHeight } = useKeyboard({ willShow: true })
  const isHorizontalMode = useHorizontalMode()
  const theme = useTheme()
  const musicInfo = usePlayerMusicInfo()
  const navigatingRef = useRef(false)
  const safeAreaBottom = useSafeAreaBottom()

  // 纯玻璃（不跟随主题色）：磨砂覆层走原生中性色，浓度由 theme.glassOpacity 驱动；
  // 液态形态走 kit 预设动态色（不传 tint）
  const glassOpacity = useSettingValue('theme.glassOpacity') / 100
  // 液态玻璃开关：仅 iOS 14~26.1 生效（开 → vendored Metal 液态玻璃；关 → 系统
  // 磨砂），实时响应设置切换。**26.2+ 强制磨砂**（2026-09-30 定案）：UIGlassEffect
  // (.regular) 在白底/图底页面切换瞬间闪烁，开关已从设置页隐藏，残留的开关值在此
  // 屏蔽。最终兜底在 LiquidGlass 组件内部。
  const liquidGlassOn = useSettingValue('theme.liquidGlass') && !isIOS26_2OrAbove

  // Tab 栏收起时（仅 Home）：迷你播放器下移到收起按钮所在行并左侧让位（对齐参考交互）。
  // 动画为逐帧收窄：bottom/paddingLeft 两布局属性随 220ms 插值同步变化，胶囊边收窄
  // 边滑入落点。收起/展开过程玻璃逐帧变形（背景捕获的动画跟踪由引擎内建）。
  // 收起态几何与圆钮**同源**：左缘 / 尺寸 / 底边 / 让位四个量全部来自
  // collapsedRow（useCollapsedRowGeometry），与 ModernTabBar 是**同一个对象**——
  // 「同排」靠共享计算结果保证，不靠两边把数字写的一样。
  const tabBarCollapsed = useTabBarCollapsed()
  const effectiveCollapsed = isHome && tabBarCollapsed
  // 收起行几何（尺寸 / 底边 / 播放器左让位）：**与 ModernTabBar 的圆钮取同一个对象**。
  // 2026-10-01（B1 重点修复）：此前两边各自调 getCollapsedPillSize /
  // collapsedFloatBottom 各算一遍，公式同源但计算两次，任何一次读取时序差就会
  // 重现「播放器还停在展开位、圆钮已经在左下角」。现在只在这里取一次。
  const collapsedRow = useCollapsedRowGeometry()
  const pillSize = collapsedRow.size
  // 「Tab栏距离」滑块（0-100）：展开态播放器底边与 Tab 栏顶边之间的间距来源
  const tabBarDistance = useSettingValue('theme.tabBarDistance')
  const collapseAnim = useRef(new Animated.Value(effectiveCollapsed ? 1 : 0)).current
  useEffect(() => {
    // bottom/paddingLeft 属布局属性，原生驱动不支持，走 JS 驱动（状态变化低频，开销可忽略）
    Animated.timing(collapseAnim, {
      toValue: effectiveCollapsed ? 1 : 0,
      // 220 为有意保留（2026-10-01 定案）：收起/展开不属于 designMotion.quick
      // （150→200）那一档，用户要求整体放慢——把 220 改成 200 反而是加速，与意图相反。
      duration: 220,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start()
  }, [effectiveCollapsed, collapseAnim])

  // 键盘上浮量（pt）：键盘是**浮层**，不挤压页面布局 —— 迷你播放器绝对定位在屏幕底部
  // （bottom = 安全区 + …），键盘一升起来就正好盖住它（键盘 ~300pt 高，播放器只占底部
  // ~114pt），用户看到的现象就是「一点输入框播放器就没了」。它其实一直在，只是被挡住了；
  // 需求同样是「不隐藏、要一直显示」，所以这里把播放器整体抬到键盘顶边之上。
  //
  // 为什么减 safeAreaBottom：键盘高度**已经包含**底部安全区（键盘视图一直铺到屏幕底边），
  // 而播放器的 bottom 里也已经加过一次 safeAreaBottom；不减就会多抬 34pt
  // （观感是「播放器浮在键盘上方一大截」）。减完播放器底边恰好落在键盘顶边上。
  // Math.max(0) 兜住外接键盘 / 中文候选栏等 height < 安全区的边角情况，避免把播放器往下推。
  const keyboardLift = keyboardShown ? Math.max(keyboardHeight - safeAreaBottom, 0) : 0
  // 上浮走独立 Animated.Value 并**与键盘同时长**（designMotion.standard = 250 ≈ iOS 键盘动画
  // 0.25s）：一次性 Set 值会先于键盘到位，看起来是播放器「先跳上去、键盘再升上来」。
  // 与收起动画是两路相加（Animated.add）：键盘弹着的时候 Tab 栏仍可收起/展开，两者互不干扰。
  const keyboardAnim = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.timing(keyboardAnim, {
      toValue: keyboardLift,
      duration: designMotion.standard,
      easing: Easing.out(Easing.quad),
      // bottom 属布局属性，原生驱动不支持，与收起动画同为 JS 驱动
      useNativeDriver: false,
    }).start()
  }, [keyboardLift, keyboardAnim])

  const handleNavigate = useCallback(() => {
    if (!musicInfo.id) return
    // 防重入：动画进行中忽略连续点击，避免 PlayDetail 被反复压栈导致界面卡死。
    if (navigatingRef.current) return
    const ids = commonState.componentIds
    // 若顶层已是播放详情页，不再重复 push。
    if (ids.length && String(ids[ids.length - 1]?.name) === PLAY_DETAIL_SCREEN) return
    navigatingRef.current = true
    const currentComponentId = ids[ids.length - 1]?.id
    navigations.pushPlayDetailScreen(String(currentComponentId))
    setTimeout(() => {
      navigatingRef.current = false
    }, 600)
  }, [musicInfo.id])

  // 长按左侧封面 → 跳到「我的」页对应列表并定位到正在播放的那一首
  // （对齐参考工程 PlayerBar/Pic 的交互）。只在首页实例生效：专辑页/歌手页等
  // 复用实例的「我的」入口不在这一层，长按跳转会让用户莫名其妙换页。
  const handleLongPress = useCallback(() => {
    if (!isHome) return
    // getJumpListId 而不是直接读 playMusicInfo.listId：本地增强，让「稍后播放」队列里
    // 那些没有来源列表（listId 为空）的歌也能回退到播放器当前所在列表，而不是毫无反应。
    const listId = getJumpListId()
    // 没有正在播放的歌曲（空态）或来源是「下载」时无处可跳：下载列表不在「我的」页里。
    if (!listId || listId == LIST_IDS.DOWNLOAD) return
    global.app_event.jumpListPosition()
  }, [isHome])

  const playerComponent = useMemo(
    () => {
      // 液态玻璃模式：背景折射由原生 LiquidGlass（vendored LiquidGlassKit）实时渲染，
      // 容器透明、无描边（纯玻璃质感，玻璃材质自带明暗自适应的染色与边缘光）。
      // 外圈投影已移除（用户反馈胶囊下方有「底子」）。
      //
      // 展开态底边 = 安全区 + 底缝 + Tab 栏高 + 「Tab栏距离」滑块距离：
      //   safeAreaBottom + bottomFloatGap（裸值）+ scaleSizeH(tabBarBaseHeight)
      //   （与 ModernTabBar 的 bar height 同 token、同函数）+ floatDistance(滑块)（裸值）。
      //   三段各自只缩放一次：字体变化时播放器底边与 Tab 栏顶边一起移动，两者间距
      //   恒等于滑块距离（不再随字体漂移）；滑块因此同时接进了渲染路径。
      //   （横屏沿用既有 76 裸值，未纳入本次口径统一。）
      const bottomExpanded = safeAreaBottom + (isHome
        ? (isHorizontalMode ? 76 : bottomFloatGap + scaleSizeH(tabBarBaseHeight) + floatDistance(tabBarDistance))
        : bottomFloatGap)
      // 收起态底边：直接取收起行几何里的 bottom（与 ModernTabBar 圆钮同一个数），
      // 不再在这里复算一遍公式
      const bottomCollapsed = collapsedRow.bottom
      // 收起态左让位 = 圆钮左缘 + 圆钮尺寸 + 间距，三项都来自同一个几何对象
      // （collapsedRow.playerLeft），与圆钮右缘的间距恒等于 collapsedPillGap。
      const paddingLeftCollapsed = collapsedRow.playerLeft
      return (
        <Animated.View
          style={[
            styles.wrapper,
            {
              // 键盘上浮量与收起位移**相加**（不是二选一）：键盘升起时播放器仍在
              // bottomExpanded / bottomCollapsed 之间做收起动画，只是整体又高了 keyboardAnim。
              bottom: Animated.add(
                collapseAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [bottomExpanded, bottomCollapsed],
                }),
                keyboardAnim,
              ),
              paddingLeft: collapseAnim.interpolate({
                inputRange: [0, 1],
                // 展开端取 collapsedRow.roundLeft（= scaleSizeW(24)，与圆钮左缘、
                // Tab 栏左右缘同一个基准）：任意字体下左右缘都与 Tab 栏重合
                outputRange: [collapsedRow.roundLeft, paddingLeftCollapsed],
              }),
            },
            // 关键：wrapper 全宽且盖在收起按钮上层，必须 box-none——否则透明区域
            // 拦截触摸，导致点击收起按钮无效
            { pointerEvents: 'box-none' },
          ]}
        >
          {/* 收起态**把高度钉死成 pillSize**（= 圆钮边长，同一个数）。
              这是「同排/共线」的最后一环，也是前几轮没修好的真正原因：
                · 两边 bottom 早已同源（collapsedRow.bottom）——底边在同一条线上；
                · 圆钮边长 = 实测的**展开态**胶囊高（pillSize）；
                · 可收起态胶囊的**高度是内容撑出来的**（wrapper 只给了 bottom/paddingLeft），
                  左让位把可用宽度压窄后，只要标题/副标题多占一行、或字体档位变化让行盒
                  长高一两 pt，胶囊就会比圆钮高 —— 底边齐、顶边不齐 = 看起来「不共线 /
                  高出圆钮」。调数值永远追不上，因为它本来就不是个常数。
              高度写死成 pillSize 后，胶囊高 ≡ 圆钮高是**构造保证**：无论 pillSize 是
              实测值还是首帧兜底（token ≈57），两边永远是同一个数。内容若真的超高，
              由 overflow:hidden 裁掉——同尺寸优先。 */}
          <View
            style={[styles.container, effectiveCollapsed && { height: pillSize }]}
            onLayout={(e) => {
              // 只按**展开态**的测量上报（2026-10-01，B1/「大小不一致」）：收起态
              // 左让位把可用宽度压窄 ~63pt，标题/副标题可能因此换行、容器高度变大；
              // 一旦把这个偏大的值当成「圆钮边长」，圆钮会跟着变高变胖。展开态是
              // 最宽形态、高度最小且稳定，是唯一可靠的基准。首帧若恰好处于收起态
              // 则不上报，由 getCollapsedPillSize 的 token 兜底（≈57）。
              if (effectiveCollapsed) return
              setMiniPlayerHeight(e.nativeEvent.layout.height)
            }}
          >
            <LiquidGlass glassOpacity={glassOpacity} dark={theme.isDark} liquid={liquidGlassOn} paused={screenCovered || navTransitioning} style={{ borderRadius: designRadius.glass }} />
            <TouchableOpacity style={styles.left} onPress={handleNavigate} onLongPress={handleLongPress} activeOpacity={0.8}>
              <Pic />
              <View style={styles.center}>
                <Title />
                <PlayInfo isHome={isHome} />
              </View>
            </TouchableOpacity>
            <View style={styles.right}>
              <ControlBtn />
            </View>
          </View>
        </Animated.View>
      )
    },
    [glassOpacity, liquidGlassOn, screenCovered, navTransitioning, theme.isDark, isHome, handleNavigate, handleLongPress, safeAreaBottom, isHorizontalMode, collapseAnim, keyboardAnim, pillSize, collapsedRow, tabBarDistance, tabBarCollapsed],
  )

  // 首页实例在安全区就绪前不下发（见 useSafeAreaReady）：它的 bottom 含 safeAreaBottom，
  // 先用 0 画、再跳到 34pt 就是「启动时迷你播放器抽动」。专辑页/歌手页等实例的 bottom
  // 不含安全区（bottomFloatGap 裸值），不受影响、也不需要等。
  if (isHome && !safeAreaReady) return null

  // 键盘门已移除（用户要求：tab 栏在，迷你播放器就不该消失）：底部 tab 栏
  // （ModernTabBar）无任何键盘逻辑、键盘弹出时照旧挂载，播放器也须常驻，否则会出现
  // 「tab 栏还在、播放器没了」的不对称。
  // 2026-10-01 追加：只有「常驻」还不够 —— 键盘是浮层，常驻的播放器会被它整个盖住，
  // 用户看到的仍是「一点输入框就没了」。所以键盘升起时用 keyboardAnim 把播放器抬到
  // 键盘顶边之上（见上文 keyboardLift），既没隐藏也没被遮挡。
  return playerComponent
})

const styles = createStyle({
  wrapper: {
    // 半透明迷你播放器：绝对定位浮在屏幕底部，上移 18px 不与底边贴合，
    // 留 24 水平边距让胶囊更窄（横向长度减短），"悬浮"在底部两侧。
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: designSpacing.lg,
  },
  container: {
    width: '100%',
    // 胶囊瘦身：垂直内边距 9 → 7，配合封面 46 → 40，整体高度 ~64 → ~54
    paddingVertical: 7,
    paddingLeft: designSpacing.sm,
    paddingRight: designSpacing.sm,
    // 圆角与透镜一致（designRadius.glass = 28 = 透镜胶囊半高；高 ~54 下渲染
    // 收敛为标准胶囊，端头与透镜同观感）
    borderRadius: designRadius.glass,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
    // 横屏不再限宽 760 居中：底部悬浮的 tab 栏（ModernTabBar）横屏是全宽，
    // 迷你播放器限宽后比 tab 栏短一大截（iPad 横屏两侧各空 ~200pt），两个
    // 底部悬浮条左右端不对齐、观感「长度不够」。去掉限宽后与 tab 栏同宽
    // 同位（left/right 24 边距对齐），竖屏行为不变（本就 100%）。
  },
  left: {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  center: {
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: 5,
    height: '100%',
    // justifyContent: 'space-evenly',
    // height: 48,
    // backgroundColor: 'rgba(0, 0, 0, .1)',
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    flexGrow: 0,
    flexShrink: 0,
    paddingLeft: 5,
    // 播放列表按钮已移除：去掉右侧内边距，播放/下一首贴向胶囊右缘
    // （图标右缘距胶囊边 = container.paddingRight(12) + 图标在 40 热区内的居中留白 8 = 20pt）
    paddingRight: 0,
  },
  // row: {
  //   flexDirection: 'row',
  //   flexGrow: 0,
  //   flexShrink: 0,
  // },
})
