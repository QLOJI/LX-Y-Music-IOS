import { useCallback, useEffect, useMemo, useRef, useState, memo, type ComponentRef, type ReactNode } from 'react'
import { Keyboard, View } from 'react-native'
import Search from '../Views/Search'
import Discovery from '../Views/Discovery'
import SongList from '../Views/SongList'
import Mylist from '../Views/Mylist'
import Leaderboard from '../Views/Leaderboard'
import Setting from '../Views/Setting'
import commonState, { type InitState as CommonState } from '@/store/common/state'
import { createStyle } from '@/utils/tools'
import PagerView, {
  type PageScrollStateChangedNativeEvent,
  type PagerViewOnPageSelectedEvent,
} from 'react-native-pager-view'
import { setNavActiveId } from '@/core/common'
import DailyRec from '../Views/DailyRec'
import TXDailyRec from '../Views/DailyRec/TXDailyRec'
import MyPlaylist from '../Views/MyPlaylist'
import FollowedArtists from '../Views/FollowedArtists'
import SubscribedAlbums from '../Views/SubscribedAlbums'
import { NAV_MENUS, type NAV_ID_Type, getEffectiveFlatOrder } from '@/config/constant.ts'
import { useSettingValue } from '@/store/setting/hook.ts'
import { useHomeLazyPage } from '@/utils/hooks'
import PlayHistory from '../Views/PlayHistory'
import WebDAV from '../Views/WebDAV'

import LocalDownload from '../Views/LocalDownload'
import TXPlaylist from '../Views/TxPlaylist'
import KgPlaylist from '../Views/KgPlaylist'
import KgDailyRec from '../Views/KgDailyRec'
import {
  emitPagerProgress,
  emitPagerDrag,
  subscribeTabBarDragActive,
} from '@/utils/homeTabScroll'

const hideKeys = ['list.isShowAlbumName', 'list.isShowInterval'] as Readonly<
Array<keyof LX.AppSetting>
>

// 底部 tab 的 5 个页面 id，顺序必须与 ModernTabBar 的 TAB_IDS 完全一致
// （推荐→歌单→搜索→我的→设置）：横滑链条与 tab 栏取同一套顺序，滑动落点才能与
// 指示器一一对应。注意**不做 navStatus 过滤**——tab pager 的页面集必须固定为
// 这 5 页：iOS 上对运行中的 PagerView 原位增删/重排子页面会 index out of bounds
// 崩溃（见下方 pagerKey 注释），而 navStatus 是可随时改的用户设置；被隐藏的 tab
// 仍然可点可滑（tab 栏也固定渲染 5 项，两者集合一致）。
const TAB_PAGE_IDS = ['nav_discovery', 'nav_songlist', 'nav_search', 'nav_love', 'nav_setting'] as const
const TAB_PAGE_ID_SET: ReadonlySet<string> = new Set(TAB_PAGE_IDS)
const isTabPageId = (id: NAV_ID_Type): boolean => TAB_PAGE_ID_SET.has(id)

/**
 * PagerView 兜底重建的会话上限。
 * 背景：后台恢复后原生 pager 可能失效（setPage* 变空操作），而首页 disable 了横向滑动，
 * 页面只能靠 JS 切页 → 点了按钮没反应。重试链全失败时换 key 重建原生实例来修复。
 * 每次重建都会重挂载整棵页面树（各页丢失滚动位置与本地 state），故设上限 + 防抖：
 * 只当"确实坏了"才修，且修不好也不要被连点拖成反复重建。
 */
const MAX_PAGER_REBUILDS = 3
const PAGER_REBUILD_DEBOUNCE_MS = 3000

const SearchPage = () => (
  useHomeLazyPage('nav_search', () => <Search />)
)
const SongListPage = () => (
  useHomeLazyPage('nav_songlist', () => <SongList />)
)
// 播放历史浮层：容器必须保持透明（只做定位与层级），不去铺不透明主题色底。
// 浮层出现时由 Main 把 PagerView 隐藏，于是浮层直接透出 Home PageContent 已绘制好的背景层，
// 进入瞬间不存在“新解码 + 新模糊一张整屏背景图”的过程，也就没有闪白（详见 PlayHistory 内注释）。
const PlayHistoryOverlay = ({ visible }: { visible: boolean }) => {
  const component = useMemo(() => <PlayHistory />, [])
  return visible ? <View style={styles.historyOverlay}>{component}</View> : null
}

const isMenuVisible = (id: NAV_ID_Type, navStatus: Partial<Record<NAV_ID_Type, boolean>>) => (
  id !== 'nav_play_history' && (id === 'nav_setting' || (navStatus[id] ?? true))
)
const LeaderboardPage = () => {
  const [visible, setVisible] = useState(commonState.navActiveId == 'nav_top')
  const component = useMemo(() => <Leaderboard />, [])
  useEffect(() => {
    let currentId: CommonState['navActiveId'] = commonState.navActiveId
    const handleNavIdUpdate = (id: CommonState['navActiveId']) => {
      currentId = id
      if (id == 'nav_top') {
        requestAnimationFrame(() => {
          setVisible(true)
        })
      } else {
        // 离开排行榜页即卸载。此前只置 true 从不置 false，用户进过一次后本页会
        // 永久挂载在 PagerView 中（offscreenPageLimit=1，离屏相邻页仍在内存里），
        // 白白占着一份完整歌曲列表 + 一个左侧 12pt 全高的透明手势层（SwipeBackArea）。
        // 本页无需要跨切页保留的状态：当前榜单由 getLeaderboardSetting 持久化兜底，
        // 重新挂载后按最近一次选择恢复。
        setVisible(false)
      }
    }
    const handleHideByTheme = () => {
      if (currentId != 'nav_top') setVisible(false)
    }
    const handleConfigUpdated = (keys: Array<keyof LX.AppSetting>) => {
      if (keys.some((k) => hideKeys.includes(k)) && currentId != 'nav_top') setVisible(false)
    }
    global.state_event.on('navActiveIdUpdated', handleNavIdUpdate)
    global.state_event.on('themeUpdated', handleHideByTheme)
    global.state_event.on('languageChanged', handleHideByTheme)
    global.state_event.on('configUpdated', handleConfigUpdated)

    return () => {
      global.state_event.off('navActiveIdUpdated', handleNavIdUpdate)
      global.state_event.off('themeUpdated', handleHideByTheme)
      global.state_event.off('languageChanged', handleHideByTheme)
      global.state_event.off('configUpdated', handleConfigUpdated)
    }
  }, [])

  return visible ? component : null
}

const DailyRecPage = () => (
  useHomeLazyPage('nav_daily_rec', () => <DailyRec />)
)

const TXDailyRecPage = () => (
  useHomeLazyPage('nav_tx_daily_rec', () => <TXDailyRec />)
)

const MylistPage = () => (
  useHomeLazyPage('nav_love', () => <Mylist />)
)

const MyPlaylistPage = () => (
  useHomeLazyPage('nav_my_playlist', () => <MyPlaylist />)
)

const FollowedArtistsPage = () => (
  useHomeLazyPage('nav_followed_artists', () => <FollowedArtists />)
)

const SubscribedAlbumsPage = () => (
  useHomeLazyPage('nav_subscribed_albums', () => <SubscribedAlbums />)
)


const WebDAVPage = () => (
  useHomeLazyPage('nav_webdav', () => <WebDAV />)
)

const LocalDownloadPage = () => (
  useHomeLazyPage('nav_local_download', () => <LocalDownload />)
)

const TXPlaylistPage = () => (
  useHomeLazyPage('nav_tx_playlist', () => <TXPlaylist />)
)

const KgPlaylistPage = () => (
  useHomeLazyPage('nav_kg_playlist', () => <KgPlaylist />)
)

const KgDailyRecPage = () => (
  useHomeLazyPage('nav_kg_daily_rec', () => <KgDailyRec />)
)

const SettingPage = () => {
  const [visible, setVisible] = useState(commonState.navActiveId == 'nav_setting')
  const component = useMemo(() => <Setting />, [])
  useEffect(() => {
    const handleNavIdUpdate = (id: CommonState['navActiveId']) => {
      if (id == 'nav_setting') {
        requestAnimationFrame(() => {
          setVisible(true)
        })
      } else {
        setVisible(false)
      }
    }
    global.state_event.on('navActiveIdUpdated', handleNavIdUpdate)

    return () => {
      global.state_event.off('navActiveIdUpdated', handleNavIdUpdate)
    }
  }, [])
  return visible ? component : null
}

/**
 * detail 宿主中的单页层。为什么不是 PagerView 的页面、也不用条件渲染：
 * - 不是第二个原生 PagerView（红线段 3）：并列原生 ScrollView 会各自做
 *   viewport 恢复，后台回来时互相抢滚动，且内存翻倍；
 * - 不用条件渲染卸载：卸载会丢状态（WebDAV 已浏览目录、平台歌单滚动位置、
 *   我的列表滚动位置等全在组件本地 state 里），useHomeLazyPage 头注释记录的
 *   正是「访问过即常驻」这个取舍。
 * 所以：常驻挂载 + opacity 切换可见性；隐藏层 pointerEvents='none'，触摸全部
 * 穿透到下层 pager。首帧不可见时不渲染子树由各 *Page 的 useHomeLazyPage 负责
 * （首次 visible 才挂载）。
 */
const DetailLayer = memo(({ component, visible }: { component: ReactNode, visible: boolean }) => (
  <View
    style={visible ? styles.detailLayer : styles.detailLayerHidden}
    pointerEvents={visible ? 'auto' : 'none'}
  >
    {component}
  </View>
))

const Main = () => {
  const pagerViewRef = useRef<ComponentRef<typeof PagerView>>(null)
  // activeNavId 的镜像 state：detail 宿主的可见性在渲染期由它派生（commonState 不具
  // 反应性），所以这里需要真实值，而不只是「触发重渲染」的哑元。
  const [activeNavId, setActiveNavIdState] = useState(commonState.navActiveId)
  const navStatus = useSettingValue('common.navStatus')
  const navOrder = useSettingValue('common.navOrder')
  const navFlatOrder = useSettingValue('common.navFlatOrder')

  // 与功能网格保持同一套“有效顺序”，否则过滤状态不一致时会跳到未挂载页面。
  // 优先使用用户自定义的扁平顺序 navFlatOrder，否则回退 navOrder。
  const effectiveOrder = useMemo(() => getEffectiveFlatOrder(navFlatOrder, navOrder), [navFlatOrder, navOrder])

  // tab pager 的页面集：**固定 5 个 tab 页**（顺序 = TAB_PAGE_IDS），不做 navStatus
  // 过滤（原因见 TAB_PAGE_IDS 注释）。变量名沿用 visibleNavs/viewMap/indexMap：
  // 契约脚本（scripts/sim-board-nav.js）与既有切页链路都锚定这套命名，
  // 且 visibleNavs.length 恒为 5 —— 重试链的范围校验口径不变。
  const visibleNavs = useMemo(() => {
    return TAB_PAGE_IDS.map((id) => {
      const menuInfo = NAV_MENUS.find(menu => menu.id === id)
      return menuInfo || { id, icon: 'unknown' }
    })
  }, [])

  // detail 页（不进 tab pager 的页面）：有效顺序去掉 5 个 tab id，保留 navStatus
  // 过滤（被隐藏的 detail 页不挂载）。nav_play_history 是浮层，isMenuVisible 已排除。
  const detailNavs = useMemo(() => {
    return effectiveOrder.filter((id: NAV_ID_Type) => (
      !isTabPageId(id) && isMenuVisible(id, navStatus)
    ))
  }, [navStatus, effectiveOrder])
  const detailNavIdSet = useMemo(() => new Set<NAV_ID_Type>(detailNavs), [detailNavs])

  const { viewMap, indexMap } = useMemo(() => {
    const viewMap: Partial<Record<NAV_ID_Type, number>> = {}
    const indexMap: NAV_ID_Type[] = []
    visibleNavs.forEach((nav: { id: NAV_ID_Type }, index: number) => {
      viewMap[nav.id] = index
      indexMap.push(nav.id)
    })
    return { viewMap, indexMap }
  }, [visibleNavs])

  const getInitialIndex = () => {
    let idx = viewMap[commonState.navActiveId]
    if (idx == null && visibleNavs.length > 0) {
      idx = 0
    }
    return idx ?? 0
  }
  const activeIndexRef = useRef(getInitialIndex())
  // 播放历史浮层可见性：浮层是覆盖在 PagerView 之上的（不是 PagerView 的一页），
  // 显示期间把 PagerView 隐藏，让浮层透出背景层而不是下面那一页的列表内容。
  // 与原 PlayHistoryOverlay 内部一致地用 requestAnimationFrame 延后一帧，保持既有挂载时机。
  const [isHistoryOverlayVisible, setHistoryOverlayVisible] = useState(commonState.navActiveId == 'nav_play_history')
  useEffect(() => {
    const handleNavIdUpdate = (id: CommonState['navActiveId']) => {
      if (id == 'nav_play_history') {
        requestAnimationFrame(() => { setHistoryOverlayVisible(true) })
      } else {
        setHistoryOverlayVisible(false)
      }
    }
    global.state_event.on('navActiveIdUpdated', handleNavIdUpdate)
    return () => {
      global.state_event.off('navActiveIdUpdated', handleNavIdUpdate)
    }
  }, [])

  // 当前 navActiveId 对应的 detail 页；tab 页 / 播放历史浮层 / 当前已隐藏的 detail id
  // 均为 null。detail 宿主层与 pager 的显隐都由此派生。
  const activeDetailId = !isTabPageId(activeNavId) && activeNavId !== 'nav_play_history' && detailNavIdSet.has(activeNavId)
    ? activeNavId
    : null
  const isDetailHostVisible = activeDetailId != null
  // tab pager 在「播放历史浮层」或「detail 宿主」盖住时整体隐藏（仅改透明度：
  // 页面保持挂载，返回后滚动位置/状态不丢），让上层透出 Home 已绘制好的背景层，
  // 既有背景不会被下面的列表内容干扰。
  const isTabPageCovered = isHistoryOverlayVisible || isDetailHostVisible

  // 横滑/长按拖动的总开关：
  // - 抽屉开合锁：DrawerLayoutFixed.ios.tsx 打开抽屉时发 changeHomePageScrollEnabled(false)，
  //   关闭时发 true（写法对齐 REF 版 Main.tsx 的同一监听）。V2 不恢复
  //   common.homePageScroll 设置项（fixPlan 第 11 条），这里只做抽屉开合锁。
  // - A-5 长按拖动期间锁住 pager 横滑（与 B-7 横滑互斥，见 homeTabScroll.ts）。
  const [drawerScrollEnabled, setDrawerScrollEnabled] = useState(true)
  const [tabBarDragActive, setTabBarDragActive] = useState(false)
  const pagerScrollEnabled = drawerScrollEnabled && !tabBarDragActive
  useEffect(() => {
    // 抽屉锁：DrawerLayoutFixed.ios.tsx 打开抽屉时发 changeHomePageScrollEnabled(false)、
    // 关闭时发 true。该事件此前只在 src/types/app.d.ts 的类型层存在、AppEvent 类里没有
    // 实现，调用靠可选链静默降级成空操作；现已在 src/event/appEvent.ts 补上真方法，
    // 这里只负责监听（emit 走 setImmediate，回调在下一次宏任务到达）。
    const handleScrollEnabled = (enabled: boolean) => {
      setDrawerScrollEnabled(enabled)
    }
    global.app_event.on('changeHomePageScrollEnabled', handleScrollEnabled)
    return () => {
      global.app_event.off('changeHomePageScrollEnabled', handleScrollEnabled)
    }
  }, [])
  useEffect(() => subscribeTabBarDragActive(setTabBarDragActive), [])

  // PagerView 非 idle 状态的兜底恢复定时器（防止 homePagerIdle 卡死在 false）
  const pagerIdleFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (pagerIdleFallbackRef.current) {
        clearTimeout(pagerIdleFallbackRef.current)
        pagerIdleFallbackRef.current = null
      }
      if (clearLastIssuedIndexRef.current) {
        clearTimeout(clearLastIssuedIndexRef.current)
        clearLastIssuedIndexRef.current = null
      }
    }
  }, [])
  // 页面集（id + 顺序）签名：分组开关 / 侧边栏显隐变化时会改变页面集合。
  // iOS 上对运行中的 PagerView 原位重排子页面并立即 setPage，存在原生侧
  // “index out of bounds” 崩溃（release 下表现为整个 App 白屏）。用 key 让
  // 页面集变化时整体重建 PagerView 实例，initialPage 直接落到当前页，彻底避开该竞争。
  const pagerKey = useMemo(() => `flat|${visibleNavs.map(n => n.id).join('|')}`, [visibleNavs])
  // ---- PagerView 实例兜底重建（2026-09-30）----
  // 场景：播放中把 App 放后台一段时间再回前台，iOS 会回收/重建 PagerView 的原生子视图，
  // 此后所有 setPage* 都变成空操作。页面切换靠 JS 下发（横滑只覆盖手势路径，按钮/卡片
  // 切页仍是 JS）→ 表现为「点榜单卡片/平台按钮没反应，列表照样能上下滚」。
  // （core/common.ts 的 forceSyncNavActiveId 注释记录的正是这个场景，那次补的是
  //  「再下发一次 setPage」；原生实例真失效时 setPage 再发也是空操作，所以仍无效。）
  // 兜底：重试链全部失败（原生始终没回报到达目标页）时换 key 重建实例，
  // initialPage 直接落到目标页。只在"已经坏掉"的路径上触发，正常切页零影响。
  const [pagerRebuild, setPagerRebuild] = useState(0)
  const rebuildTargetRef = useRef<number | null>(null)

  // remount 时的初始页：优先用兜底重建请求记录的目标页（原生已失效时，navActiveId 与
  // 界面落点已经对不上，只有这个记录是可靠的），其次按当前导航 id 在新顺序中的位置。
  // 依赖 pagerRebuild：重建后必须重算，否则 initialPage 还是旧值、重建也落错页。
  const initialPageIndex = useMemo(() => {
    const target = rebuildTargetRef.current
    if (pagerRebuild > 0 && target != null && target >= 0 && target < visibleNavs.length) return target
    return viewMap[commonState.navActiveId] ?? 0
  }, [viewMap, visibleNavs.length, pagerRebuild])

  // pager 的原生真实落点（仅 onPageSelected 更新）与切换重试定时器。
  // 原生偶发丢弃 setPageWithoutAnimation（busy 竞争，无 onPageSelected 回调）时，
  // activeIndexRef 已被乐观写入目标值，若再用它做「是否已切过去」的判断，重试
  // 会被永久跳过——表现为点按钮切页偶发无响应且再点也无效，手动滑动后才恢复。
  const observedIndexRef = useRef(initialPageIndex)
  const pageRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 本 tick 内已经下发过 setPage 的目标 index。用于让「常规切页 + 紧随其后的强制
  // 同步」（点在榜单卡片上的调用序）只真正下发一次 setPage，避免重复驱动原生切换
  // 造成可见抖动。
  // 必须按 tick 失效：这两个调用的事件都是微任务、在同一批里连续到达；若标记跨批
  // 残留，会把后续本该执行的强制同步误判为重复而跳过（那样修复就失效了）。
  // 因此在下发 setPage 后用一个 0ms 宏任务把它清掉——微任务批先跑完，宏任务才清。
  const lastIssuedIndexRef = useRef<number | null>(null)
  const clearLastIssuedIndexRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const markIssuedIndex = (index: number) => {
    lastIssuedIndexRef.current = index
    if (clearLastIssuedIndexRef.current) clearTimeout(clearLastIssuedIndexRef.current)
    clearLastIssuedIndexRef.current = setTimeout(() => {
      clearLastIssuedIndexRef.current = null
      lastIssuedIndexRef.current = null
    }, 0)
  }

  // ---- 兜底重建的执行体（状态声明见上，须先于 initialPageIndex）----
  const rebuildCountRef = useRef(0)
  const lastRebuildAtRef = useRef(0)
  const repairPager = useCallback((index: number) => {
    const now = Date.now()
    // 防抖 + 上限：连点或走多个入口时不重复重建；一次会话最多 3 次，
    // 避免"重建也没修好"时被用户连点触发连续重建（每次都会重挂载整棵页面树）。
    if (now - lastRebuildAtRef.current < PAGER_REBUILD_DEBOUNCE_MS) return
    if (rebuildCountRef.current >= MAX_PAGER_REBUILDS) return
    rebuildCountRef.current += 1
    lastRebuildAtRef.current = now
    rebuildTargetRef.current = index
    // 新实例挂载前后的这段窗口里，原生落点未知：置 -1 让守卫的乐观短路全部失效
    observedIndexRef.current = -1
    activeIndexRef.current = index
    setPagerRebuild(v => v + 1)
  }, [])

  const onPageSelected = useCallback(({ nativeEvent }: PagerViewOnPageSelectedEvent) => {
    activeIndexRef.current = nativeEvent.position
    // observedIndex 只在原生回调里更新，反映 pager 的真实落点——区别于
    // activeIndexRef 的乐观写入（setPage 前就写目标值）。原生偶发丢弃
    // setPageWithoutAnimation（busy 竞争，无 onPageSelected 回调）时，靠它
    // 识别「切换未生效」并重试，否则再次点击同一按钮会被守卫跳过、永久无响应。
    observedIndexRef.current = nativeEvent.position
    // 原生已回报落点 ⇒ 兜底重建的"目标页"使命结束，后续 remount 回到常规口径
    rebuildTargetRef.current = null
    if (pageRetryTimerRef.current) {
      clearTimeout(pageRetryTimerRef.current)
      pageRetryTimerRef.current = null
    }
    const selectedId = indexMap[activeIndexRef.current]
    if (!selectedId) return
    // 只有「当前激活页是 tab 页」时才把镜像 state / 导航 id 切到 pager 落点：
    // - 播放历史是抽屉底部入口调起的全屏浮层，不属于 PagerView 页面；用户 swipe
    //   切页时不应把它覆盖回我的列表；
    // - detail 页激活期间宿主盖在 pager 上，晚到的 onPageSelected（重试链尾巴、
    //   兜底重建挂载时的初始回调等）不得把用户从 detail 宿主里拽出来。
    if (isTabPageId(commonState.navActiveId)) {
      setActiveNavIdState(selectedId)
      if (activeIndexRef.current !== viewMap[commonState.navActiveId]) {
        setNavActiveId(selectedId)
      }
    }
  }, [indexMap, viewMap])

  // 手势拖动会话：仅在「用户手势开始（dragging）」到「落定（idle）」之间为 true。
  // 程序化 setPage*（点击切页 / 重试链 / 兜底重建）只产生 settling/idle、不产生
  // dragging，跟手进度因此只在真实手势期间发出，绝不会抢掉点击时的弹簧动画
  // （recon fixPlan 第 7 条）。类型写法对齐先例 VerticalNew.tsx:73。
  const pagerDragSessionRef = useRef(false)
  const onPageScroll = useCallback((e: { nativeEvent: { position: number, offset: number } }) => {
    // 只用 ref 判定、绝不 setState（先例 VerticalNew.tsx:60-68）：本回调是滚动
    // 帧级频率，setState 会让整条 tab 栏在 120Hz 下逐帧重渲染。
    // progress = position + offset 的约定无关取法见 ModernTabBar（订阅端 clamp）。
    if (!pagerDragSessionRef.current) return
    emitPagerProgress(e.nativeEvent.position, e.nativeEvent.offset)
  }, [])

  const onPageScrollStateChanged = useCallback(
    ({ nativeEvent }: PageScrollStateChangedNativeEvent) => {
      Keyboard.dismiss()
      if (nativeEvent.pageScrollState == 'dragging') {
        // 真实手势开始：开跟手会话（tab 栏据此抬起透镜并开始跟随手指）
        pagerDragSessionRef.current = true
        emitPagerDrag(true)
      }
      if (nativeEvent.pageScrollState == 'idle') {
        if (pagerDragSessionRef.current) {
          pagerDragSessionRef.current = false
          // 手势结束：通知 tab 栏结束跟手、放下透镜。最后一次跟手进度即目标槽心
          // （跟手是原生零动画直落），若随后换了页，navActiveIdUpdated 会用新的
          // x prop 走原生同位守卫自然接管，不会重播弹簧。
          emitPagerDrag(false)
        }
        if (pagerIdleFallbackRef.current) {
          clearTimeout(pagerIdleFallbackRef.current)
          pagerIdleFallbackRef.current = null
        }
        if (!global.lx.homePagerIdle) global.lx.homePagerIdle = true
      } else {
        // 兜底：setPageWithoutAnimation 切页期间可能丢失配对的 idle 事件，
        // homePagerIdle 会永久停留在 false，列表点击被静默吞掉（表现为点了没反应）。
        // 800ms 内未收到 idle 则强制恢复。
        if (pagerIdleFallbackRef.current) clearTimeout(pagerIdleFallbackRef.current)
        pagerIdleFallbackRef.current = setTimeout(() => {
          pagerIdleFallbackRef.current = null
          global.lx.homePagerIdle = true
        }, 800)
      }
    },
    [],
  )

  useEffect(() => {
    // 播放历史是浮层，不是 PagerView 的页面；visibleNavs 变化时不要把它重置到第一页
    if (commonState.navActiveId === 'nav_play_history') return
    // detail 页不在 tab pager 里：已挂载的 detail 由宿主层自己显示（别把 pager
    // 拨回去）；未登记的 id 兜底回第一个 tab，避免 pager 停在无对应页的索引上。
    if (!isTabPageId(commonState.navActiveId)) {
      if (detailNavIdSet.has(commonState.navActiveId)) return
      activeIndexRef.current = 0
      if (visibleNavs[0]) setNavActiveId(visibleNavs[0].id)
      return
    }
    let index = viewMap[commonState.navActiveId]
    if (index == null && visibleNavs.length > 0) {
      index = 0
      activeIndexRef.current = index
      if (visibleNavs[0]) {
        setNavActiveId(visibleNavs[0].id)
      }
    } else if (index != null) {
      // 防御：索引必须在当前页面集范围内，避免对原生 pager 下发越界页码
      if (index >= visibleNavs.length) return
      activeIndexRef.current = index
      pagerViewRef.current?.setPageWithoutAnimation(index)
    }
  }, [viewMap, visibleNavs, detailNavIdSet])

  useEffect(() => {
    const handleConfigUpdated = (keys: Array<keyof LX.AppSetting>) => {
      if (keys.includes('common.navStatus')) {
        // 播放历史是浮层，不在可见菜单列表里，但不应被导航状态变更重置
        if (commonState.navActiveId === 'nav_play_history') return
        // tab 页固定在 pager 里（不走 navStatus 过滤），不需要兜底；
        // 只有「被隐藏的 detail 页正处于激活态」才需要回退到第一个 tab。
        if (isTabPageId(commonState.navActiveId)) return
        const isActiveVisible = isMenuVisible(commonState.navActiveId, navStatus)
        if (!isActiveVisible && visibleNavs.length > 0) {
          setNavActiveId(visibleNavs[0].id)
        }
      }
    }
    global.state_event.on('configUpdated', handleConfigUpdated)
    return () => {
      global.state_event.off('configUpdated', handleConfigUpdated)
    }
  }, [navStatus, visibleNavs])

  useEffect(() => {
    const handleUpdate = (id: CommonState['navActiveId']) => {
      setActiveNavIdState(id)
      // 播放历史是浮层，切到它时不要同步 PagerView 页面，否则 setPageWithoutAnimation(0)
      // 会触发 onPageSelected，进而把 navActiveId 又覆盖成我的列表。
      if (id === 'nav_play_history') return
      // detail 页（榜单 / 每日推荐 / 我的歌单 / WebDAV…）也不是 PagerView 的页面：
      // 由常驻宿主层显示，这里绝不下发 setPage（否则会把 tab pager 拨到第一页，
      // 后台失配场景下的重试链与兜底重建还会错误地在 detail 页上重放）。
      if (!isTabPageId(id)) {
        if (detailNavIdSet.has(id)) {
          // 强制同步标记是一次性的：detail 路径同样消费它，避免残留到下一次
          // 常规切页时被误判为「强制同步请求」。
          if (global.lx.homePagerForceSync && id === commonState.navActiveId) {
            global.lx.homePagerForceSync = false
          }
          return
        }
        // 未登记的 id（如已被 navStatus 隐藏的 detail 页被强行切到）：
        // 兜底回第一个 tab，避免 pager 停在无对应页的索引上。
        if (visibleNavs[0]) setNavActiveId(visibleNavs[0].id)
        return
      }
      let index = viewMap[id]
      if (index == null && visibleNavs.length > 0) {
        index = 0
      }
      // 防御：索引必须在当前页面集范围内，避免对原生 pager 下发越界页码
      if (index != null && index < visibleNavs.length) {
        activeIndexRef.current = index
        // 本页是否就是「强制同步」的目标页。forceSyncNavActiveId() 重新广播的是
        // **当前** navActiveId，所以只有 id 与 commonState.navActiveId 一致的那次
        // 回调才算「强制同步请求」，其余（例如调用方紧邻的 setNavActiveId 触发的那次）
        // 是常规切页，不应消费该标记。
        const isForceSync = global.lx.homePagerForceSync && id === commonState.navActiveId
        // 用原生真实落点（observedIndexRef）判断是否需要切换：原生偶发丢弃
        // setPageWithoutAnimation 时，靠下面的重试把页面真正切过去。
        //
        // 但 observedIndexRef 可能是**乐观值**（初始化为 initialPageIndex，由
        // navActiveId 推导，从未经原生确认），App 从后台恢复、PagerView 原生子视图
        // 被重建后它更可能整体失真。若只凭它 `=== index` 就提前 return，会把
        // 「界面其实停在别的页」当成「已经在目标页」，切页被永久跳过。
        // 因此对「强制同步」请求一律真正下发一次 setPage，并让 onPageSelected 的
        // 回执刷新 observedIndexRef；只有常规请求才沿用乐观短路。
        if (!isForceSync && observedIndexRef.current === index) {
          if (pageRetryTimerRef.current) {
            clearTimeout(pageRetryTimerRef.current)
            pageRetryTimerRef.current = null
          }
          return
        }
        // 同一批事件里已经为该 index 下发过 setPage 时不再重复（见
        // lastIssuedIndexRef 注释）：这一支只可能是紧随常规切页而来的强制同步。
        if (isForceSync && lastIssuedIndexRef.current === index) {
          global.lx.homePagerForceSync = false
          return
        }
        // 强制标记是一次性的：消费后立即复位，避免后续常规切页都绕开短路。
        if (isForceSync) {
          global.lx.homePagerForceSync = false
          // 强制同步必须真正驱动一次原生切换：把原生落点标记为「未知」，
          // 使下面重试链的首个校验不会因为乐观值恰好相等而提前判定成功。
          observedIndexRef.current = -1
        }
        markIssuedIndex(index)
        pagerViewRef.current?.setPageWithoutAnimation(index)
        // 重试链：400ms / 900ms 两次校验原生落点，未达目标则带动画重发 setPage。
        // onPageSelected 到达即清链（observedIndexRef === index）。
        if (pageRetryTimerRef.current) clearTimeout(pageRetryTimerRef.current)
        const armRetry = (delay: number, attempt: number) => {
          pageRetryTimerRef.current = setTimeout(() => {
            pageRetryTimerRef.current = null
            if (observedIndexRef.current === index) return
            pagerViewRef.current?.setPage(index)
            if (attempt < 2) armRetry(500, attempt + 1)
            // 两次重试都换不来 onPageSelected 回执（原生落点既非目标、也不回执）：
            // 判定为「原生 pager 实例已失效」，setPage 再发也是空操作 —— 重建实例。
            // 时序：点击 → 0/400/900ms 三次 setPage → 约 1.4s 后重建并落到目标页。
            else repairPager(index)
          }, delay)
        }
        armRetry(400, 1)
      }
    }

    global.state_event.on('navActiveIdUpdated', handleUpdate)
    return () => {
      global.state_event.off('navActiveIdUpdated', handleUpdate)
      if (pageRetryTimerRef.current) {
        clearTimeout(pageRetryTimerRef.current)
        pageRetryTimerRef.current = null
      }
    }
  }, [viewMap, visibleNavs, repairPager, detailNavIdSet])

  // tab pager 的 5 页（顺序 = visibleNavs = TAB_PAGE_IDS）
  const pages = useMemo(() => {
    const pageComponents: Partial<Record<NAV_ID_Type, ReactNode>> = {
      nav_discovery: <Discovery />,
      nav_songlist: <SongListPage />,
      nav_search: <SearchPage />,
      nav_love: <MylistPage />,
      nav_setting: <SettingPage />,
    }

    return visibleNavs.map((nav: { id: NAV_ID_Type }) => (
      <View collapsable={false} key={nav.id} style={styles.pageStyle}>
        {pageComponents[nav.id] ?? null}
      </View>
    ))
  }, [visibleNavs])

  // detail 宿主的页面组件表（不进 pager）。各 *Page 内部的懒挂载/常驻语义
  // （useHomeLazyPage / LeaderboardPage 的离开即卸载）原样保留，这里只是常驻挂出。
  const detailPageComponents = useMemo<Partial<Record<NAV_ID_Type, ReactNode>>>(() => ({
    nav_top: <LeaderboardPage />,
    nav_daily_rec: <DailyRecPage />,
    nav_tx_daily_rec: <TXDailyRecPage />,
    nav_kg_daily_rec: <KgDailyRecPage />,
    nav_my_playlist: <MyPlaylistPage />,
    nav_followed_artists: <FollowedArtistsPage />,
    nav_subscribed_albums: <SubscribedAlbumsPage />,
    nav_webdav: <WebDAVPage />,
    nav_local_download: <LocalDownloadPage />,
    nav_tx_playlist: <TXPlaylistPage />,
    nav_kg_playlist: <KgPlaylistPage />,
  }), [])

  return (
    <View style={styles.container}>
      <PagerView
        // pagerRebuild：兜底重建计数。原生实例在后台恢复后可能失效（见 repairPager 注释），
        // 换 key 让 RN 重建原生 PagerView，initialPage 落到目标页。
        key={`${pagerKey}#${pagerRebuild}`}
        ref={pagerViewRef}
        initialPage={initialPageIndex}
        offscreenPageLimit={1}
        onPageSelected={onPageSelected}
        onPageScrollStateChanged={onPageScrollStateChanged}
        // 跟手：只在真实手势会话内发轻量进度（不 setState），见 onPageScroll
        onPageScroll={onPageScroll}
        // 横滑开关：抽屉开合锁 + A-5 长按拖动互斥（不再有 common.homePageScroll 设置项）
        scrollEnabled={pagerScrollEnabled}
        // 播放历史浮层 / detail 宿主显示时整体隐藏（仅改透明度：页面仍挂载，返回后
        // 滚动位置/状态不丢），让上层透出 Home 已经绘制好的背景层，既有背景不会被
        // 下面的列表内容干扰。
        style={isTabPageCovered ? styles.pagerViewHidden : styles.pagerView}
        pointerEvents={isTabPageCovered ? 'none' : 'auto'}
      >
        {pages}
      </PagerView>
      {/* detail 宿主：常驻堆叠层（唯一原生 PagerView 仍是上面的 tab pager，红线段 3）。
          层级在 pager 之上、播放历史浮层之下；不可见层 pointerEvents='none' 全部穿透。 */}
      <View
        style={styles.detailHost}
        pointerEvents={isDetailHostVisible && !isHistoryOverlayVisible ? 'box-none' : 'none'}
      >
        {detailNavs.map(id => (
          <DetailLayer
            key={id}
            component={detailPageComponents[id] ?? null}
            visible={id === activeDetailId && !isHistoryOverlayVisible}
          />
        ))}
      </View>
      <PlayHistoryOverlay visible={isHistoryOverlayVisible} />
    </View>
  )
}

const styles = createStyle({
  container: {
    flex: 1,
    // 底部内边距：给悬浮的迷你播放器留出空间，避免列表最后一行被胶囊盖住。
    // 数值 = wrapper paddingTop 4 + 容器内边距 20 + 内容区约 46 + 进度条 3 ≈ 73，取 80 留余量。
    paddingBottom: 0,
  },
  pagerView: {
    flex: 1,
    overflow: 'hidden',
  },
  pagerViewHidden: {
    flex: 1,
    overflow: 'hidden',
    opacity: 0,
  },
  // detail 宿主：盖在 pager 之上、播放历史浮层之下的一层透明容器（只做定位与层级）。
  // 不铺背景色：隐藏时整层不可见/不可点，显示时由激活层自己的页面内容铺底。
  detailHost: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1,
  },
  // 单页层：撑满宿主。可见层沿用原 PagerView 页容器的观感（透明，内容自己铺底）
  detailLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  // 隐藏层：仅淡出（保持挂载，返回后滚动位置/本地 state 不丢），触摸由
  // pointerEvents='none' 全部穿透
  detailLayerHidden: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    opacity: 0,
  },
  historyOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    // 2：必须盖在 detail 宿主（zIndex 1）之上——浮层容器透明，靠 PagerView 与
    // detail 宿主双双隐藏来透出背景层，层级错了会露出 detail 页内容
    zIndex: 2,
    // iOS-only 项目，移除 Android 专属的 elevation，避免 iOS 侧样式/层级歧义
  },
  pageStyle: {
    // alignItems: 'center',
    // padding: 20,
  },
})

export default Main
