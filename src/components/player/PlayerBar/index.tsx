import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, View, TouchableOpacity } from 'react-native'
import { useHorizontalMode } from '@/utils/hooks'
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
import { useSafeAreaBottom, useGlassCovered, useSafeAreaReady, useNavTransitioning, useNavRevealing, useAppActive, usePagerDragging } from '@/store/common/hook'
import { usePlayerMusicInfo } from '@/store/player/hook'
import {
  designRadius,
  designSpacing,
  bottomFloatGap,
  tabBarBaseHeight,
  floatDistance,
} from '@/theme/DesignTokens'
import LiquidGlass from '@/components/common/LiquidGlass'

export default memo(({ componentId, isHome = false }: { componentId?: string, isHome?: boolean }) => {
  // 省电门：本屏被压栈页覆盖（栈顶不是本屏）时暂停玻璃 Metal 渲染循环。
  // PlayerBar 多屏复用（Home / 专辑页 / 歌手页…），按各自 componentId 判定；
  // 调用方未传 componentId 时恒不门控（行为同旧版）。
  // 2026-10-11（第 52 轮第 2 条）：改用**玻璃专用**门（= 本门 ∧ 不在返回露出窗口内）。
  // 返回发起时账本（componentIds）还没翻，必须提前恢复渲染并重采背景，否则整段返回
  // 动画透过的都是暂停前那一帧，动画结束才跳一下（用户原话「透过的画面要在返回动画
  // 之前就实时显示」）。账面 hook 本身（useScreenCovered）语义不动——它还有布局类消费点。
  const glassCovered = useGlassCovered(componentId)
  // 转场门（2026-10-01 开窗；2026-10-02 只保留 push 侧）：整段 **push** 转场期间
  // 也暂停玻璃——省电门只看账本，盖不住转场本身（转场中间态被采进胶囊 =
  // 每次切换画面闪一下）。返回（pop）不再置位：玻璃正在被露出来，按住等于让用户
  // 多看一截陈旧画面（用户第 5 条），pop 事件到达即释放。见
  // navigation.beginNavTransitionWindow / endNavTransitionWindow。
  const navTransitioning = useNavTransitioning()
  // 前台门（2026-10-02 用户第 8 条）：迷你播放器的液态玻璃同样是 MTKView 连续渲染，
  // 锁屏/退后台后音频还在放、进程还常驻，它会跟着跑一整夜（省电门只看「被不被压栈页
  // 覆盖」，前台栈顶时恒为 false，盖不住这条）。接进前台门后 App 退后台即停渲染，
  // 回前台自动恢复（原生恢复时重捕获背景，无残帧）。
  const appActive = useAppActive()
  // 实时采景门（2026-10-02 用户第 2/9 条）：与 ModernTabBar 同一个信号 —— 首页横滑
  // 手势会话期间，迷你播放器的玻璃也按实时档（60fps 采景，渲染档同速，见
  // LiquidGlassView.syncRenderFrameRate）跟手，否则
  // 它就是「滑动时透过的画面延迟高、掉帧」的另一半（两块玻璃在同一个背景上）。
  const pagerDragging = usePagerDragging()
  // 返回露出窗口（2026-10-11，第 58 轮第 2 条）：pop 发起时打开的窗口，见
  // navigation/revealWindow.ts。与 useGlassCovered 内部用的是同一个信号，这里单独取一次
  // 是为了**驱动实时采景档**（live）——只在「本屏正被露出」时为真。
  const navRevealing = useNavRevealing()
  // 【第 58 轮第 1 条】本屏行宽（wrapper 的宽度）。只由 wrapper 的 onLayout 上报，见
  // 下方 glassWidth 的说明。
  const [rowWidth, setRowWidth] = useState(0)
  // 安全区就绪门（仅首页实例用得上，见下方 return）：首页播放器的底边 =
  // 安全区 + 底缝 + Tab 栏高 + 滑块距离，安全区没回来之前不下发，
  // 否则先用 0 画出来、再跳到 34pt = 「启动时抽动」。
  const safeAreaReady = useSafeAreaReady()
  // 键盘：本组件**不再订阅**（2026-10-02 需求被推翻的那一半，见下方「键盘不再抬升」）。
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

  // 键盘不再抬升（2026-10-02 需求）：
  //   上一轮（见 改动清单-20261001.md 第 5 条）为了让播放器「输入法弹出时也看得见」，
  //   在键盘升起时把它整体抬到键盘顶边之上（keyboardLift = 键盘高 - 安全区）。
  //   本次用户明确否决了这个位置：「迷你播放器目前始终显示了，但是位置不对，应该始终挂在
  //   底部 tab，不会向上移动」。所以上浮量、keyboardAnim 及其 Animated.add 全部删除 ——
  //   bottom 只由「收起/展开」一条动画决定，键盘弹出时它原地不动（键盘是系统浮层，
  //   会把它盖住；这是用户接受的代价，换来的是「位置恒定挂在底部 tab」）。
  //   注意：组件仍不隐藏、仍然挂载，只是不再移动；useKeyboard 在 Popup/Dialog 里继续使用。

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
      // 【第 58 轮第 1 条】玻璃宿主的**固定宽度** = 展开态容器宽 = 行宽 − 展开态左让位 −
      // 右内边距（wrapper 的 paddingHorizontal）。收起/展开动画期间变的只有 wrapper 的
      // paddingLeft（= 容器左缘往右推、容器变窄），右缘恒定不动（paddingRight 是静态的
      // designSpacing.lg）—— 所以「展开态宽度 + 右对齐」的宿主在整段动画里尺寸恒定。
      //
      // 为什么必须恒定（第 56/58 轮反复出现的黑弧）：迷你播放器胶囊的收/展是 220ms 的
      // **逐帧变形动画**（bottom + paddingLeft 同帧插值）。玻璃原生视图此前是「铺满容器」
      // 的——容器一帧比一帧宽，玻璃的 bounds 就一帧一变，captureSize / backdropView.frame
      // 跟着一帧一变，CABackdropLayer 每帧都要整幅重合成：展开时新长出来的那一块（右端）
      // 在重合成完成前是**黑的**，shader 的 clamp_to_edge 边缘折射再把它弯进胶囊右端圆头
      // —— 就是用户看到的「下一首按钮旁那道粗黑弧」。宿主定尺后原生视图在动画期间一动不动，
      // 变化只剩容器这一层的裁剪，重合成不再发生。
      // 首帧（还没量到行宽）退回「铺满容器」的旧口径，行为与改动前逐字一致。
      const glassWidth = rowWidth > 0 ? rowWidth - collapsedRow.roundLeft - designSpacing.lg : 0
      const glassHostStyle = glassWidth > 0
        ? [styles.glassHost, { width: glassWidth, height: pillSize }]
        : styles.glassHostFill
      return (
        <Animated.View
          style={[
            styles.wrapper,
            {
              // bottom 只有「收起/展开」一个来源：键盘不再参与（见上方「键盘不再抬升」）
              bottom: collapseAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [bottomExpanded, bottomCollapsed],
              }),
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
          onLayout={(e) => {
            // 【第 58 轮第 1 条】只认 wrapper 自己的宽度（= 行宽）。它不随收展动画变化
            //（动画动的是 paddingLeft，改的是内容盒，不是本视图的 frame），因此这里**只**
            // 会因为窗口尺寸/旋转变化重测一次。绝不能用容器的 onLayout 来量：容器的宽度
            // 正是动画量，逐帧上报会把玻璃宿主的「固定宽度」当场毁掉（黑弧复发）。
            const width = e.nativeEvent.layout.width
            setRowWidth(prev => (Math.abs(prev - width) < 0.5 ? prev : width))
          }}
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
            {/* 【第 58 轮第 1 条】玻璃宿主：定尺 + 右对齐的绝对定位层（尺寸见上方 glassWidth）。
                宿主不是布局节点（absolute），迷你播放器其余子元素的位置一个数都没动；
                胶囊形状照旧由容器的 borderRadius + overflow:hidden 裁出（LiquidGlass 自身
                也带同一个圆角），收起态被裁掉的左端由容器的圆角补上，右端与宿主右缘重合。 */}
            <View pointerEvents="none" style={glassHostStyle}>
              <LiquidGlass glassOpacity={glassOpacity} dark={theme.isDark} liquid={liquidGlassOn} paused={glassCovered || navTransitioning || !appActive} live={pagerDragging || navRevealing || navTransitioning} style={{ borderRadius: designRadius.glass }} />
            </View>
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
    // appActive 必须在依赖里（2026-10-02 用户第 8 条）：这一项是「App 前台」门，
    // 漏掉它的话前后台切换时 useMemo 不会重建节点，paused 永远停在首次渲染的值
    // （等价于前台门失效，锁屏后玻璃照样整夜渲染）。
    // pagerDragging 同理（用户第 9 条）：它是 live 门，漏掉就永远停在 false，
    // 横滑期间玻璃仍是 30fps 采景档 —— 表现就是这一个门完全没接上。
    // 【第 58 轮第 2 条】navRevealing 也是 live 门（返回转场期间走 60fps 采景档），
    // rowWidth 是玻璃宿主的定尺来源：两者都必须在依赖里，否则节点不重建、门与尺都失效。
    [glassOpacity, liquidGlassOn, glassCovered, navTransitioning, navRevealing, appActive, pagerDragging, rowWidth, theme.isDark, isHome, handleNavigate, handleLongPress, safeAreaBottom, isHorizontalMode, collapseAnim, pillSize, collapsedRow, tabBarDistance, tabBarCollapsed],
  )

  // 首页实例在安全区就绪前不下发（见 useSafeAreaReady）：它的 bottom 含 safeAreaBottom，
  // 先用 0 画、再跳到 34pt 就是「启动时迷你播放器抽动」。专辑页/歌手页等实例的 bottom
  // 不含安全区（bottomFloatGap 裸值），不受影响、也不需要等。
  if (isHome && !safeAreaReady) return null

  // 键盘与播放器的最终口径（2026-10-02）：
  //   · 不隐藏 —— 底部 tab 栏（ModernTabBar）键盘弹出时照旧挂载，播放器也须常驻，
  //     否则会出现「tab 栏还在、播放器没了」的不对称（2026-10-01 已定）。
  //   · 不上浮 —— 它始终挂在底部 tab 上（bottom 只由收起/展开决定）。键盘弹出时
  //     播放器被系统键盘浮层盖住是**预期行为**：用户要的是「位置恒定」，不是「永远可见」。
  //     上一轮的上浮实现（keyboardLift/keyboardAnim）已按本次需求删除。
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
  // 【第 58 轮第 1 条】玻璃宿主：右对齐 + 定尺（宽 = 展开态容器宽、高 = pillSize，
  // 由内联 style 给）。两个方向都钉死是**必须**的：容器高度在动画中间也可能差一两 pt，
  // 只钉宽度的话高度仍会逐帧变，黑弧照样回来。首帧未量到行宽时用 glassHostFill 退回
  // 「铺满容器」的旧口径（逐帧变形，但只有一帧）。
  glassHost: {
    position: 'absolute',
    top: 0,
    right: 0,
  },
  glassHostFill: {
    position: 'absolute',
    top: 0,
    right: 0,
    left: 0,
    bottom: 0,
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
