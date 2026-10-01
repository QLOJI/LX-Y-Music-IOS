import { memo, useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { View, AppState, type LayoutChangeEvent } from 'react-native'
import PagerView, { type PagerViewOnPageSelectedEvent } from 'react-native-pager-view'
import MiniLyric, { getMiniLyricRowHeight } from '../components/MiniLyric'
import Pic, { getCoverSize } from './Pic'
import Lyric from './Lyric'
import SongInfo from './components/SongInfo'
import Header, { HEADER_HEIGHT } from './components/Header'
import Player from './Player'
import { screenkeepAwake, screenUnkeepAwake } from '@/utils/nativeModules/utils'
import commonState, { type InitState as CommonState } from '@/store/common/state'
import { useStatusbarHeight } from '@/store/common/hook'
import { createStyle } from '@/utils/tools'
import { useSettingValue } from '@/store/setting/hook'
import PlayerPlaylist, { type PlayerPlaylistType } from '@/components/player/PlayerPlaylist.tsx'
import { registerPager } from '@/utils/pagerScrollControl'
import { scaleSizeW, scaleSizeH, setSpText } from '@/utils/pixelRatio'
import { designTypography } from '@/theme/DesignTokens'
import { useWindowSize } from '@/utils/hooks'
import { COMPONENT_IDS } from '@/config/constant'

const LyricPage = ({ pagerHeight = 0, isActive = false }: { pagerHeight?: number, isActive?: boolean }) => {
  // 歌词页始终预挂载（pagerHeight 就绪后），isActive 只控制滚动/定位：
  // 若等首次滑到歌词页才挂载，FlatList 需在现场渲染大量歌词行 + 布局测量 + 无动画定位，
  // 全部挤在滑动完成的一帧里，PagerView 切页会出现明显顿挫（iPhone/iPad 竖屏“顿一下”的主因）。
  // active=false 时 Lyric 内部不启动滚动循环、不定位，常驻成本仅是一次性的初始行渲染。
  if (pagerHeight <= 0) return null
  return <Lyric key="lyric" active={isActive} pagerHeight={pagerHeight} />
}

// 封面尺寸的保留下限（占「自然尺寸」的比例）：布局空间极紧时算式会要求把封面缩得更小，
// 这里定个地板，宁可残留一点点越界量、也不让封面缩到看不见（见下方 coverSizeCap 的注释）。
const MIN_COVER_KEEP_RATIO = 0.4

const VerticalNew = memo(({ componentId }: { componentId: string }) => {
  const [pageIndex, setPageIndex] = useState(0)
  // 正在从左往右滑向歌词页（从封面切到歌词），用于让 LyricPage 提前激活高亮定位
  const pagerViewRef = useRef<PagerView>(null)
  const showLyricRef = useRef(false)
  const playlistRef = useRef<PlayerPlaylistType>(null)
  const [pagerHeight, setPagerHeight] = useState(0)
  // 封面页容器（picPageContainerNew）的实测高度 R（pt）：顶 = 返回栏底边、底 = 控制条顶边。
  // 它由 PagerView 定高，与容器内的封面 / 信息块 / 小歌词完全无关 —— 这正是它取代旧口径
  // （infoContainer 的 onLayout.y，「返回栏底边 → 信息栏顶边」）的原因：旧口径把小歌词
  // 自己的高度算了进去，小歌词变高 → 该区域变小 → 少显示一行 → 变矮 → 区域又变大 →
  // 多显示一行，环路增益恰好 −1，档位在阈值两侧 2 循环，观感就是封面页持续闪烁。
  // R 有两个去向：Pic 的尺寸上限 R/2（实测到位前的首帧由 estimatedPageHeight 的解析估算
  // 顶替，见下方；实测一到立即让位）；小歌词可用高度（见 miniLyricMaxHeight，不碰估算）。
  // 稳态仍用 onLayout 实测而不是按字号/行数估算——估算会随 global.lx.fontSize 与各组件
  // 常量漂移而失真，故估算只配当「首帧兜底」。
  const [pageHeight, setPageHeight] = useState(0)
  const handlePageLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const h = Math.round(nativeEvent.layout.height)
    if (h <= 0) return
    // 2pt 死区：亚像素级重排（转屏、全局字体缩放）不驱动封面/小歌词跟着重算
    //（保留旧口径同款防护强度）。
    setPageHeight(prev => (Math.abs(prev - h) < 2 ? prev : h))
  }, [])
  // 「信息块外框顶边 → 歌名栏视觉顶边」的距离，等于 SongInfo 自己的 marginTop
  //（大屏 20 / 小屏 8，见 SongInfo.tsx 的 styles.container 及其 isSmallWindow 分支）。
  //
  // 为什么需要它：封面要居中在「返回栏底边 → 歌名栏顶边」之间，而 picContainer 的
  // flex 居中能认的下边界只是信息块的**外框**顶边。外框把 SongInfo 的 marginTop 也算了
  // 进去，比歌名栏视觉顶边高出这一个 margin —— 于是封面整体偏上 margin/2
  //（大屏 20/2 = 10pt，正是「封面偏返回栏一点」的量）。
  // 把它实测出来加进 picContainer 的 paddingTop：paddingTop=M 会让 flex 居中的内容
  // 在 [M, H] 里重新居中，中心恰好下移 M/2，封面落回真正的中线。
  // 必须实测而不是写死：小屏 override（8）、global.lx.fontSize 缩放都会改这个值。
  const [songInfoOffset, setSongInfoOffset] = useState(0)
  // SongInfo 自身的高度（不含上下 margin；上 margin 已由上面的 layout.y 实测，
  // 下 margin 走常量镜像）。小歌词可用高度的输入之一，同样与 MiniLyric 自身无关。
  const [songInfoContentHeight, setSongInfoContentHeight] = useState(0)
  const handleSongInfoLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const y = Math.round(nativeEvent.layout.y)
    if (y < 0) return
    setSongInfoOffset(prev => (prev === y ? prev : y))
    const h = Math.round(nativeEvent.layout.height)
    if (h <= 0) return
    // 2pt 死区：歌名栏的亚像素级变化不驱动小歌词跟着重排（与页面容器同款防护）。
    setSongInfoContentHeight(prev => (Math.abs(prev - h) < 2 ? prev : h))
  }, [])
  const { width: winWidth, height: winHeight } = useWindowSize()
  // 与 HeaderNew 同源的页头高度口径（状态栏 + 6pt）：估算 R 的页头项必须与它逐 pt 一致。
  const statusBarHeight = useStatusbarHeight()
  const miniLyricAlign = useSettingValue('playDetail.style.miniLyricAlign')
  // 封面尺寸设置：与 Pic 消费的是同一个键（vertical/horizontal 两个 Pic 同源）。
  // 这里读它只有一个用途 —— 推出「自然封面直径」，作为布局算式里 coverSizeCap 的比较基准；
  // 真正的尺寸判定仍在 Pic 内部（getCoverSize），不在两处各抄一份。
  const coverSize = useSettingValue('playDetail.style.coverSize')
  // 用 ref 追踪滑动方向，避免高频 onScroll 触发大量 setState 导致卡顿
  // 仅在首次变为 true 时触发一次 setState 通知子组件
  const isComingLyricRef = useRef(false)
  // 「正在从歌词页滑回封面页」：与 isComingLyricRef 同一套写法（ref + 首次翻转时才 setState），
  // 由 onPageScroll 采样驱动（见 handlePageScroll），不依赖会被原生丢掉的状态事件。
  const isComingCoverRef = useRef(false)
  const [, setForceUpdate] = useState(0)

  const [isProgressDragging, setIsProgressDragging] = useState(false)

  const onPageSelected = ({ nativeEvent }: PagerViewOnPageSelectedEvent) => {
    setPageIndex(nativeEvent.position)
    showLyricRef.current = nativeEvent.position === 1
    // 页面选择完成后：滑向封面页，取消标记并通知子组件更新
    if (nativeEvent.position === 0 && isComingLyricRef.current) {
      isComingLyricRef.current = false
      setForceUpdate(v => v + 1)
    }
    if (showLyricRef.current) {
      screenkeepAwake()
    } else {
      screenUnkeepAwake()
    }
  }

  // 在 PagerView 滑动过程中检测方向：position===0（封面页）且 offset>0 表示正在滑向歌词页。
  // 用 ref 存状态避免高频 onScroll 触发 setState；首次变为 true 时通过 setForceUpdate 通知子组件。
  const handlePageScroll = useCallback((e: { nativeEvent: { offset: number, position: number } }) => {
    const coming = e.nativeEvent.position === 0 && e.nativeEvent.offset > 0
    if (coming && !isComingLyricRef.current) {
      isComingLyricRef.current = true
      setForceUpdate(v => v + 1)
    }
    // 反向：已停在歌词页时，只要滚动采样里出现 position===0，就说明手势正在把封面页滑回来。
    // 判据必须带「已落页码」，不能只看 position/offset —— 读 react-native-pager-view 6.7.1 的
    // ios/RNCPagerView.m（scrollViewDidScroll，offset<0 分支）：
    //   if (isAnimatingBackwards) { position = _destinationIndex(=_currentIndex-1);
    //                               absoluteOffset = fmax(0, 1 - fabs(offset)); }
    // 回滑时原生就是这么把 position 改写成 0、把 offset 折算成 (0,1) 的，
    // 与「封面页上向前滑」发出的 (position=0, offset∈(0,1)) **完全同形**；
    // 而 _currentIndex 只在落页回调（pageViewController:didFinishAnimating:）里才更新，
    // 所以「已落页码」是唯一能把两个方向分开的量 —— showLyricRef 正是它。
    // 用途：这段手势期间让封面继续转（见 JSX 里 Pic 的 active）——否则整段回滑封面都是冻着的，
    // 落页时 startAnimation 再按播放相位重锚，肉眼就是「滑到一半卡住、落页跳一下」。
    // 刻意不用 pageScrollState：Main.tsx 记过该事件会被原生丢掉（手势被取消时
    // willEndDragging 不来，最后一个状态永久停在 'dragging'）。这里靠滚动采样自愈：
    // 松手弹回歌词页时最后一帧采样是 (position=1, offset=0)（RNCPagerView.m 里 isLastPage 分支
    // 把 absoluteOffset 归 0、position 归 currentIndex），标志随即复位；最坏情况只是多转一会儿。
    const backToCover = showLyricRef.current && e.nativeEvent.position === 0
    if (backToCover !== isComingCoverRef.current) {
      isComingCoverRef.current = backToCover
      setForceUpdate(v => v + 1)
    }
  }, [])

  const handleSwitchToLyricPage = useCallback(() => {
    pagerViewRef.current?.setPage(1)
  }, [])

  useEffect(() => {
    // 本屏是否在 RNN 组件栈顶（即真正可见）：componentIds 自栈底到栈顶，
    // 判据与 useScreenCovered / useHomeCovered 同源。被压栈页（评论/设置/歌单详情…）
    // 盖住时本屏不可见，屏幕常亮必须让位，否则用户翻别的页面时屏幕会一直亮着（常亮泄漏）。
    const isScreenOnTop = (ids: CommonState['componentIds']) => {
      return String(ids[ids.length - 1]?.id) === String(componentId)
    }

    let appstateListener = AppState.addEventListener('change', (state) => {
      switch (state) {
        case 'active':
          // 回前台补齐常亮：只有「歌词页在显示 + 本屏可见（未被评论页盖住）」才点亮。
          if (
            showLyricRef.current &&
            isScreenOnTop(commonState.componentIds) &&
            !commonState.componentIds.find(item => item.name === COMPONENT_IDS.comment)
          ) screenkeepAwake()
          break
        case 'background':
          screenUnkeepAwake()
          break
      }
    })

    const handleComponentIdsChange = (ids: CommonState['componentIds']) => {
      const commentCovered = !!ids.find(item => item.name === COMPONENT_IDS.comment)
      // 本屏被压栈页盖住或评论页全屏覆盖：没有可见的歌词页，先熄掉常亮。
      if (!isScreenOnTop(ids) || commentCovered) {
        screenUnkeepAwake()
      } else if (AppState.currentState === 'active' && showLyricRef.current) {
        // 只有「歌词页在显示 + 本屏可见 + 前台」才重新点亮。原实现无条件 screenkeepAwake()——
        // 封面页（showLyricRef=false，onPageSelected 里已显式熄灯）和「本屏被压栈页盖住」
        // 这两种不可见场景也会把屏幕点亮，是常亮泄漏。
        screenkeepAwake()
      }
    }

    // 进度条拖动期间禁用 PagerView 横滑，避免与“切到歌词页”的原生手势冲突
    const handleProgressDragState = (dragging: boolean) => { setIsProgressDragging(dragging) }
    global.app_event.on('progressDragState', handleProgressDragState)

    // 将 PagerView ref 注册给同步手势锁，供进度条拖动时立即禁用原生横滑
    registerPager(pagerViewRef)

    // 必须用具名函数注册/移除，否则 off 传入新箭头函数无法匹配已注册的监听器，
    // 会导致监听器泄漏（组件多次挂载后点击 ☰ 弹出多个队列面板）。
    const handleShowPlaylist = () => { playlistRef.current?.show() }

    global.state_event.on('componentIdsUpdated', handleComponentIdsChange)
    global.app_event.on('switchToLyricPage', handleSwitchToLyricPage)
    global.app_event.on('showPlaylist', handleShowPlaylist)

    return () => {
      global.state_event.off('componentIdsUpdated', handleComponentIdsChange)
      global.app_event.off('progressDragState', handleProgressDragState)
      registerPager(null)
      global.app_event.off('switchToLyricPage', handleSwitchToLyricPage)
      global.app_event.off('showPlaylist', handleShowPlaylist)
      appstateListener.remove()
      screenUnkeepAwake()
    }
  }, [handleSwitchToLyricPage])

  const containerPaddingH = useMemo(() => scaleSizeW(10), [])
  const isSmallWindow = winHeight < 700
  // 封面页纵向布局（2026-10-01 改为「封面居中」，需求：旋转封面在返回栏与信息栏之间居中）：
  // picPageContainerNew 仍是 space-between（信息块贴底），但 picContainer 改成了
  // flex:1 + justifyContent:'center' —— 它吃掉「信息块以上」的全部剩余空间，封面在其中居中。
  // 居中区间恰好就是「返回栏底边 → 信息栏顶边」：容器顶 = 返回栏底边；区间下边界 =
  // 信息块顶边 —— 容器 paddingTop 与信息块 marginTop 同为 containerPaddingH，一上一下正好抵消。
  // 不要改成写死的 top 偏移：容器高度随机型/字号变化，写死必然再次偏心。
  //
  // PAGE_BOTTOM_PADDING（大屏 12pt / 小屏 0）的语义与旧版不同了：
  // 信息块仍贴底，但封面已经居中——paddingBottom 加大 Δ 会把信息块连同封面中心一起上移 Δ/2
  //（旧版封面贴顶时它只影响中缝、封面完全不动）。
  // 取值仍须保证「封面 + 信息块 + paddingBottom ≤ 容器高度」，否则 flexShrink:0 的信息块
  // 会被挤出容器底、压到下方控制条上（封面是居中溢出，信息块是直接顶出）。
  //   大屏（390x844）：容器约 511pt，取 12pt 给底部留出与控制条的呼吸空间；
  //                    12 的来源：上一轮按用户反馈「三行歌词整体下移一点」调定
  //                    （42→12 下移 30pt、行距 2→8 上推 18pt，净下移约 12pt）。
  //   小屏（iPhone SE 667pt）：容器仅约 384pt，空间不足，paddingBottom 归 0，
  //                    仅保留字号放大与小歌词行数降级（见 MiniLyric 的 isSmallWindow）。
  const PAGE_BOTTOM_PADDING = 12
  const pageBottomPadding = useMemo(() => ({
    paddingBottom: isSmallWindow ? 0 : PAGE_BOTTOM_PADDING,
  }), [isSmallWindow])
  // R 的首帧兜底（解析估算）：R（picPageContainerNew 实测高）要等首帧 commit 后的 onLayout
  // 才拿得到，而封面在首帧就要定尺寸。旧实现在 R 未实测时回落 Infinity（不封顶），coverSize
  // 150% 档首帧会先按 base×1.5 渲染（用户机型 ≈429pt），实测一到再一次性缩到 R/2（≈288pt）——
  // 就是本轮要消掉的入场缩放跳变（≈33%）。这里按与实测 R 完全一致的口径给一个解析估算：
  // R = 窗口高 − 页头整高 − 控制条整高，逐项镜像各组件现行实现（只读窗口与固定样式量、
  // 不含任何受封面尺寸影响的量 ⇒ 与实测口径一样无自反馈环）。以下镜像改了对应组件时
  // 必须回来同步（这些组件：HeaderNew / PlayerNew / FeatureBtns / ProgressBar / PlayInfo / ControlBtnNew）：
  //   · 页头 = useStatusbarHeight()（状态栏 + 6，HeaderNew 的 height/paddingTop 同源）+ HEADER_HEIGHT
  //   · 控制条 = PlayerNew 上下 padding（winHeight×0.006 / ×0.018，下限 4/10；JSX 内联、不缩放）
  //     + FeatureBtns 行：按钮块 scaleSizeH(scaleSizeW(42))（模块常量经 createStyle 的 height
  //       又缩放一次）+ 容器 paddingVertical（大屏 16 走 createStyle=scaleSizeH(16)；小屏内联覆盖 6，不缩放）
  //     + 进度条 scaleSizeH(6×2+7)（ProgressBar 的 progressContentHeight 经 createStyle 缩放）
  //     + 时间行行盒高（PlayInfo 的 Text 15 / Status 13 取大者 = round(setSpText(n)×1.15)）
  //     + 控制按钮行（ControlBtnNew 内联：paddingVertical max(round(winHeight×0.025),12)×2
  //       + 主按钮 min(max(winWidth×0.18, scaleSizeW(36)), scaleSizeW(72))）
  // 误差：估算与实测的偏差 e 只以 e/2 进入封面直径（首帧 − 稳态 = |R估 − R测|/2）。
  // 用户机型（440×956）代入：控制条 ≈260 → R估 ≈588 → 首帧直径 ≈294；对照稳态参考 R/2 ≈288，
  // 残差 ≈6pt（≈2% 封面直径，且只发生在推入转场头一两帧内）；390×844 对照截图反推值偏差 ≈6pt
  //（e/2 ≈ 3pt）。即无论方向，单次微调都 ≤ 约 6pt（约 2%），与旧实现 141pt/33% 的跳变差 23 倍，
  // 且与稳态共用同一封顶语义（min(base×比例, 安全上限, R/2)），不存在反向（先小后大）的跳变来源。
  // 估算 ≤ 0（窗口尺寸未就绪的极端首帧）时返回 0：Pic 视为「未实测」回落旧口径，
  // 绝不把封面先算成 0 或极小再撑大。
  const estimatedPageHeight = useMemo(() => {
    const featureBtnsHeight = scaleSizeH(scaleSizeW(42)) + (isSmallWindow ? 6 : scaleSizeH(16)) * 2
    const progressHeight = scaleSizeH(6 * 2 + 7)
    const infoRowHeight = Math.max(
      Math.round(setSpText(15) * designTypography.lineHeightRatio),
      Math.round(setSpText(13) * designTypography.lineHeightRatio),
    )
    const controlRowHeight = Math.max(Math.round(winHeight * 0.025), 12) * 2 +
      Math.min(Math.max(winWidth * 0.18, scaleSizeW(36)), scaleSizeW(72))
    const playerBarHeight = Math.max(Math.round(winHeight * 0.006), 4) +
      Math.max(Math.round(winHeight * 0.018), 10) +
      featureBtnsHeight + progressHeight + infoRowHeight + controlRowHeight
    return Math.max(0, winHeight - (statusBarHeight + HEADER_HEIGHT) - playerBarHeight)
  }, [winHeight, winWidth, statusBarHeight, isSmallWindow])
  // 下传给 Pic 的页面容器高（实测优先、首帧用解析估算，见 estimatedPageHeight 注释），
  // 与「自然封面直径」一起算出来 —— 后者只用来判断布局算式给出的上限到底有没有真的压小封面。
  const coverRegionHeight = pageHeight > 0 ? pageHeight : estimatedPageHeight
  const coverDiameter = getCoverSize(winWidth, winHeight, statusBarHeight, coverSize, coverRegionHeight)
  // 小歌词的可用高度上限 + 封面尺寸上限：这是**同一个约束的两面**，必须由同一套算式推出。
  // 原因：封面中心以下的空间里，小歌词至少会渲染一行（MiniLyric 内部 fitRows = max(1, …)），
  // 这一行的高度是刚性的；封面又是 flexShrink:0 的块，被挤时不会自己缩小，只会顶出 picContainer、
  // 压到歌名栏与大歌词上（用户报的「封面图片区域跑到其他区域，占到歌名区域和大歌词区域」）。
  // 只调小歌词上限、不管封面大小，就会在大字号 + 翻译行的机型上重新越界（130% 字体的反例，
  // 实测 375×667 越界约 9pt）—— 所以两个值一起算、一起给。
  //
  // 可用空间 available 的表达式里不出现 MiniLyric 自己的任何高度 —— 这是根治闪烁的
  // 结构条件（小歌词撑高自己不会反过来改变这个上限，反馈环断开，见上方 pageHeight 注释）。
  // 逐项：页面容器实测高 R
  //     − 容器 paddingTop 与 infoContainer marginTop（各一份 containerPaddingH）
  //     − 容器 paddingBottom（大屏 12 / 小屏 0）
  //     − SongInfo 整块：[marginTop（layout.y 实测）＋内容高（layout.height 实测）
  //       ＋ marginBottom]。SongInfo 没导出样式，marginBottom 按 SongInfo.tsx 的
  //       styles.container 及其 isSmallWindow 分支镜像：大屏走 createStyle 生成的
  //       scaleSizeH(18)（**不是裸 18**：那份样式是缩放过的，写裸值会在非基准机型上对不上），
  //       小屏 4 是那边内联覆盖、不缩放，故原样 —— 那边改了必须同步这里。
  //
  // coverSizeCap 的推导：封面在 picContainer 里按「扣掉 paddingTop = songInfoOffset 之后的区间」
  // 居中，越界量 = size − (picContainer.height − songInfoOffset)，故不越界的充要条件是
  //     size ≤ picContainer.height − songInfoOffset
  //（这个 paddingTop 的用途就是让封面中心落在「返回栏底边 → 歌名栏视觉顶边」真正的中线）。
  // 小歌词至少占一行 ⇒ picContainer.height ≤ available − 一行高 ⇒ 只要
  //     size ≤ available − songInfoOffset − 一行高
  // 就一定不越界。一行高取**带翻译行**的最坏情况（getMiniLyricRowHeight(true)）：这样不必
  // 订阅歌词内容，常态机型上这条上限根本不生效（available 足够大），多算一点只是保守。
  // MIN_COVER_KEEP_RATIO 是地板：极限机型（小屏 + 超大字号 + 多行长歌名）上算式可能要求
  // 把封面缩得很小，宁可保留至少 40% 的封面、让越界量尽可能小，也不要出现「封面几乎消失」。
  // 地板生效时小歌词仍会渲染一行、越界量可能残留一点点（有意取舍）。
  //
  // 首帧任一实测未到（= 0）时小歌词上限返回 undefined：MiniLyric 内部按保守档兜底渲染；
  // 不能返回 0 —— 那会被当作「可用高度 = 0」，整块先塌成一行再弹开。负值收回 0（宁可只显示一行）。
  const { coverSizeCap, miniLyricMaxHeight } = useMemo<{
    coverSizeCap: number
    miniLyricMaxHeight: number | undefined
  }>(() => {
    if (pageHeight <= 0 || songInfoContentHeight <= 0) return { coverSizeCap: 0, miniLyricMaxHeight: undefined }
    const songInfoMarginBottom = isSmallWindow ? 4 : scaleSizeH(18)
    const available = pageHeight - containerPaddingH * 2 - (isSmallWindow ? 0 : PAGE_BOTTOM_PADDING)
      - (songInfoOffset + songInfoContentHeight + songInfoMarginBottom)
    const cap = Math.max(
      available - songInfoOffset - getMiniLyricRowHeight(true),
      coverDiameter * MIN_COVER_KEEP_RATIO,
    )
    // 小歌词上限按**实际生效的封面尺寸**留白（min(自然直径, 上限)）：
    // 旧实现固定按 R/2 预留，封面在 50% 档时白让出一大截（用户机型约 149pt ≈ 两行小歌词），
    // 100% 档反而因为预留不足而少一行 —— 两种偏差都来自「预留量 ≠ 实际封面尺寸」。
    return {
      coverSizeCap: cap,
      miniLyricMaxHeight: Math.max(0, available - Math.min(coverDiameter, cap) - songInfoOffset),
    }
  }, [pageHeight, songInfoContentHeight, songInfoOffset, isSmallWindow, containerPaddingH, coverDiameter])
  // 小歌词的 style memo 化：内联对象每次渲染都是新引用，会让 memo(MiniLyric) 失效——
  // 滚动/切歌期父级重渲染会连带小歌词重渲染（抖动隔离的前提，见 W2 的小歌词重写）。
  // 这里只剩「水平对齐」一项：原先 miniLyricContainerNew 的 paddingHorizontal:10 已挪进
  // MiniLyric 的 bleedH/文本内缩（容器自己带水平 padding 会把绝对定位的定位浮层一起缩进去，
  // 见 MiniLyric 的 lineInsetH）。
  const miniLyricStyle = useMemo(() => miniLyricAlignStyles[miniLyricAlign as keyof typeof miniLyricAlignStyles], [miniLyricAlign])

  return (
    <>
      <Header pageIndex={pageIndex} />
      <View style={styles.container}>
        <PagerView
          onPageSelected={onPageSelected}
          onPageScroll={handlePageScroll}
          style={styles.pagerView}
          ref={pagerViewRef}
          scrollEnabled={!isProgressDragging}
          overScrollMode="never"
          onLayout={({ nativeEvent }) => {
            const h = Math.round(nativeEvent.layout.height)
            if (h > 0 && h !== pagerHeight) setPagerHeight(h)
          }}
        >
          <View collapsable={false} style={styles.pageContainer}>
            {/* 封面页容器：高度 R 在这里实测（与容器内的小孩完全无关，见上方 pageHeight
                注释），下传给 Pic 做尺寸上限，也是小歌词可用高度的基准。 */}
            <View
              collapsable={false}
              style={[styles.picPageContainerNew, pageBottomPadding, { paddingTop: containerPaddingH }]}
              onLayout={handlePageLayout}
            >
              {/* picContainer 是「返回栏底边 → 信息栏顶边」的居中区域（样式见 styles.picContainer）；
                  Pic 自己按设置决定尺寸与形状（playDetail.style.coverSize / coverShape），
                  此处下传页面容器高 R：实测到位用实测（见上方 pageHeight 注释），未到位（首帧）
                  用 estimatedPageHeight 的解析估算顶替，让封面首帧尺寸即接近稳态、不产生入场缩放
                  （见 estimatedPageHeight 注释）。 */}
              <View style={[styles.picContainer, songInfoOffset > 0 && { paddingTop: songInfoOffset }]}>
                {/* active：封面自转的可见性门控之一——PagerView 会一直保持封面页挂载，
                    划到歌词页后必须让 Pic 停掉旋转动画（另一个门控是播放态和屏幕未被覆盖，见 Pic.tsx）。
                    isComingCoverRef：从歌词页滑回封面页的手势期间也保持 true，让旋转跨手势连续。
                    落页前后这个表达式的取值不变（手势期间 true，落到封面页后 pageIndex===0 仍为 true）
                    ⇒ Pic 的启停 effect 依赖不变化、根本不重跑 ⇒ 不会二次起停、也不会重锚跳角。
                    sizeCap：布局侧给出的尺寸上限（只有「小歌词至少放得下一行」这一条），
                    与 R/2 那条并列参与 min；0 = 不施加（首帧实测未到时不额外收紧，交给 R/2 与安全上限）。 */}
                <Pic
                  componentId={componentId}
                  active={pageIndex === 0 || isComingCoverRef.current}
                  coverRegionHeight={coverRegionHeight}
                  sizeCap={coverSizeCap}
                />
              </View>
              <View
                collapsable={false}
                style={[styles.infoContainer, { paddingHorizontal: containerPaddingH, marginTop: containerPaddingH }]}
              >
                <SongInfo componentId={componentId} onLayout={handleSongInfoLayout} />
                {/* maxHeight = 由 R 与 SongInfo 实测高推出的可用高度（W2 契约的可选 prop）：
                    只含与 MiniLyric 自身无关的量，小歌词高度不再参与自己的上限计算
                    （旧口径的闪烁反馈环，见上方 pageHeight 注释）；未就绪时传 undefined。 */}
                <MiniLyric
                  maxHeight={miniLyricMaxHeight}
                  // 小歌词用负 margin 把自己左右各外扩这么多，frame 顶到屏幕边缘：
                  // 定位浮层（绝对定位，左右 0）因此和大歌词一样贴到右缘，虚线右端与播放三角
                  // 离右缘的距离同大歌词完全一致（用户点名的问题）；歌词文本再按同值内缩回去。
                  bleedH={containerPaddingH}
                  onPress={handleSwitchToLyricPage}
                  style={miniLyricStyle}
                />
              </View>
            </View>
          </View>
          <View collapsable={false} style={{ flex: 1, width: '100%', height: '100%' }}>
            <LyricPage pagerHeight={pagerHeight} isActive={pageIndex === 1 || isComingLyricRef.current} />
          </View>
        </PagerView>
        {/* Progress bar must live OUTSIDE the PagerView so its horizontal drag never
            enters the native pager gesture domain (otherwise left-drag stutters / is
            hijacked as a page swipe).
            常驻控制条：Player 控制条始终挂载并可见——封面页(pageIndex===0)与
            歌词页(pageIndex===1)底部都显示该控制条（不折叠、不透明隐藏）。
            Player 本身是 memo + 稳定 props，pageIndex 变化不会引起其重渲染；
            保留挂载避免切页卸载/重挂导致的掉帧。 */}
        <View>
          <Player componentId={componentId} />
        </View>
      </View>
      <PlayerPlaylist ref={playlistRef} />
    </>
  )
})

export default VerticalNew

const styles = createStyle({
  container: {
    flex: 1,
    flexDirection: 'column',
  },
  pagerView: {
    flex: 1,
  },
  pageContainer: {
    flex: 1,
    flexDirection: 'column',
    position: 'relative',
  },
  picPageContainerNew: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'space-between',
    position: 'relative',
    // 注意：此处绝不能加 overflow: 'hidden'——iOS 上 clipsToBounds 与 transform
    // （旋转封面）叠加在同一图层时，会把带 transform 的后代剔除出渲染树，
    // 导致封面空白（SongInfo 等无 transform 的子视图不受影响）。
    // 旧 UI（v20260826 实测封面正常）的 picPageContainerOld 就没有 overflow。
  },
  picContainer: {
    // 旧版是 flexShrink:0（封面贴顶、被钉死在返回栏正下方）。
    // 现在 flex:1（含 flexShrink:1）：吃掉信息块以上的全部剩余空间，封面在其中
    // 垂直＋水平居中 —— 居中区间即「返回栏底边 → 信息栏顶边」，见组件内注释。
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoContainer: {
    flex: 0,
    flexShrink: 0,
  },
  // 小歌词容器不再带水平内边距：容器带 padding 会把绝对定位的定位浮层一起缩进去
  //（虚线右端因此离屏幕右缘更远）。原来那 10pt 已折算进 MiniLyric 的 bleedH 与文本内缩，
  // 效果是「浮层贴到屏幕边、歌词文字与歌名栏对齐在同一条竖线上」。
  miniLyricAlignLeft: {
    alignItems: 'flex-start',
  },
  miniLyricAlignCenter: {
    alignItems: 'center',
  },
  miniLyricAlignRight: {
    alignItems: 'flex-end',
  },
})

// 类型安全的“小歌词对齐”样式查表，替代 styles[`miniLyricAlign${...}`] 的
// 字符串动态索引（后者因 key 被推断为 string 触发 TS7053）。
const miniLyricAlignStyles = {
  left: styles.miniLyricAlignLeft,
  center: styles.miniLyricAlignCenter,
  right: styles.miniLyricAlignRight,
}
