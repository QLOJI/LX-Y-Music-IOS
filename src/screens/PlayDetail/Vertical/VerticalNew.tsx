import { memo, useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { View, AppState, type LayoutChangeEvent } from 'react-native'
import PagerView, { type PagerViewOnPageSelectedEvent } from 'react-native-pager-view'
import MiniLyric from '../components/MiniLyric'
import Pic from './Pic'
import Lyric from './Lyric'
import SongInfo from './components/SongInfo'
import Header from './components/Header'
import Player from './Player'
import { screenkeepAwake, screenUnkeepAwake } from '@/utils/nativeModules/utils'
import commonState, { type InitState as CommonState } from '@/store/common/state'
import { createStyle } from '@/utils/tools'
import { useSettingValue } from '@/store/setting/hook'
import PlayerPlaylist, { type PlayerPlaylistType } from '@/components/player/PlayerPlaylist.tsx'
import { registerPager } from '@/utils/pagerScrollControl'
import { scaleSizeW } from '@/utils/pixelRatio'
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

const VerticalNew = memo(({ componentId }: { componentId: string }) => {
  const [pageIndex, setPageIndex] = useState(0)
  // 正在从左往右滑向歌词页（从封面切到歌词），用于让 LyricPage 提前激活高亮定位
  const pagerViewRef = useRef<PagerView>(null)
  const showLyricRef = useRef(false)
  const playlistRef = useRef<PlayerPlaylistType>(null)
  const [pagerHeight, setPagerHeight] = useState(0)
  // 「返回栏底边 → 信息栏顶边」的可用高度（pt）。页面容器顶就是返回栏底边，
  // infoContainer 的 onLayout.y = 从容器顶量到信息块顶边的距离，即该可用高度。
  // 交接给 MiniLyric 的 maxHeight（可选 prop，W2 拥有）；用 onLayout 实测而不是
  // 按字号/行数估算——估算会随 global.lx.fontSize 浮动而失真。
  // setState 用同值短路：onLayout 与重渲染之间不会互相触发，布局真的变了才会更新。
  const [coverRegionHeight, setCoverRegionHeight] = useState(0)
  const handleInfoContainerLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const y = Math.round(nativeEvent.layout.y)
    if (y <= 0) return
    setCoverRegionHeight(prev => (prev === y ? prev : y))
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
  const handleSongInfoLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const y = Math.round(nativeEvent.layout.y)
    if (y < 0) return
    setSongInfoOffset(prev => (prev === y ? prev : y))
  }, [])
  const { height: winHeight } = useWindowSize()
  const miniLyricAlign = useSettingValue('playDetail.style.miniLyricAlign')
  // 用 ref 追踪滑动方向，避免高频 onScroll 触发大量 setState 导致卡顿
  // 仅在首次变为 true 时触发一次 setState 通知子组件
  const isComingLyricRef = useRef(false)
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
  // 小歌词的 style 数组 memo 化：内联数组每次渲染都是新引用，会让 memo(MiniLyric) 失效——
  // 滚动/切歌期父级重渲染会连带小歌词重渲染（抖动隔离的前提，见 W2 的小歌词重写）。
  const miniLyricStyle = useMemo(() => [
    styles.miniLyricContainerNew,
    miniLyricAlignStyles[miniLyricAlign as keyof typeof miniLyricAlignStyles],
  ], [miniLyricAlign])

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
            <View collapsable={false} style={[styles.picPageContainerNew, pageBottomPadding, { paddingTop: containerPaddingH }]}>
              {/* picContainer 是「返回栏底边 → 信息栏顶边」的居中区域（样式见 styles.picContainer）；
                  Pic 自己按设置决定尺寸与形状（playDetail.style.coverSize / coverShape），此处不传尺寸。 */}
              <View style={[styles.picContainer, songInfoOffset > 0 && { paddingTop: songInfoOffset }]}>
                {/* active：封面自转的可见性门控之一——PagerView 会一直保持封面页挂载，
                    划到歌词页后必须让 Pic 停掉旋转动画（另一个门控是播放态和屏幕未被覆盖，见 Pic.tsx）。 */}
                <Pic componentId={componentId} active={pageIndex === 0} />
              </View>
              <View
                collapsable={false}
                style={[styles.infoContainer, { paddingHorizontal: containerPaddingH, marginTop: containerPaddingH }]}
                onLayout={handleInfoContainerLayout}
              >
                <SongInfo componentId={componentId} onLayout={handleSongInfoLayout} />
                {/* maxHeight = 上方实测的「返回栏底边 → 信息栏顶边」可用高度（W2 契约的可选 prop，
                    未就绪时不传等价于不限制）。 */}
                <MiniLyric
                  maxHeight={coverRegionHeight > 0 ? coverRegionHeight : undefined}
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
  miniLyricContainerNew: {
    paddingHorizontal: 10,
  },
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
