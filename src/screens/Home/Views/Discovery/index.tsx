import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BackHandler, Keyboard, ScrollView, StyleSheet, TouchableOpacity, View, useWindowDimensions } from 'react-native'
import { getDiscoveryPlatformOrder, type NAV_ID_Type } from '@/config/constant'
import { useTheme } from '@/store/theme/hook'
import { useStatusbarHeight, useBottomOverlayInset } from '@/store/common/hook'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { forceSyncNavActiveId, setNavActiveId } from '@/core/common'
import { createStyle, toast } from '@/utils/tools'
import { retryAsync } from '@/utils/retry'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { designRadius, designSpacing, designTypography, pageTitleGap, pageTitleLineHeight } from '@/theme/DesignTokens'
import songlistState, { type ListInfoItem, type Source } from '@/store/songlist/state'
import settingState from '@/store/setting/state'
import boardState, { type BoardItem } from '@/store/leaderboard/state'
import { getList } from '@/core/songlist'
import { getBoardsList } from '@/core/leaderboard'
import { saveLeaderboardSettingSync, saveViewPrevDetail } from '@/utils/data'
import { consumeViewRestore, type ViewPrevDetailState } from '@/core/viewRestore'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import PlatformChips from '@/components/home/PlatformChips'
import DailyRecommendCard from '@/components/home/DailyRecommendCard'
import PlaylistGrid from '@/components/home/PlaylistGrid'
import SonglistDetail from '../../../SonglistDetail'

// 每日推荐入口与「首页推荐平台」联动：网易/酷狗/QQ 有每日推荐页，
// 进入前要求对应平台的 Cookie 已登录；酷我/咪咕无每日推荐页，隐藏入口。
const DAILY_REC_NAVS: Partial<Record<Source, NAV_ID_Type>> = {
  wy: 'nav_daily_rec',
  kg: 'nav_kg_daily_rec',
  tx: 'nav_tx_daily_rec',
}

const DAILY_REC_COOKIE_KEYS: Partial<Record<Source, 'common.wy_cookie' | 'common.kg_cookie' | 'common.tx_cookie'>> = {
  wy: 'common.wy_cookie',
  kg: 'common.kg_cookie',
  tx: 'common.tx_cookie',
}

const getSortId = (source: Source) => songlistState.sortList[source]?.[0]?.id ?? ''

const styles = createStyle({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 180,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: designSpacing.lg,
    // 标题行 → 平台胶囊行：四页共用 pageTitleGap（原本推荐页 16 / 歌单页 12 / 我的页 8）
    marginBottom: pageTitleGap,
  },
  title: {
    fontWeight: '800',
    // 四页共用的标题行高（见 DesignTokens.pageTitleLineHeight 的说明）。
    // 这里**必须**写在 createStyle 内：只有经 trasformeStyle 才会乘 global.lx.fontSize，
    // 与同行的 42pt 播放历史圆钮（height → scaleSizeH）同口径缩放，字号变了也不会错位。
    lineHeight: pageTitleLineHeight,
  },
  historyButton: {
    width: 42,
    height: 42,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionGap: {
    marginTop: designSpacing.lg,
  },
  daily: {
    marginTop: designSpacing.lg,
    paddingHorizontal: designSpacing.lg,
  },
  platformTitle: {
    paddingHorizontal: designSpacing.lg,
  },
  sectionTitle: {
    paddingHorizontal: designSpacing.lg,
    fontWeight: '800',
  },
  boardContent: {
    paddingHorizontal: designSpacing.lg,
    gap: designSpacing.sm,
    marginTop: designSpacing.md,
  },
  boardCard: {
    width: 92,
    minHeight: 64,
    borderRadius: designRadius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: designSpacing.xs,
    paddingHorizontal: designSpacing.sm,
    paddingVertical: designSpacing.xs,
  },
  // 宽屏两行网格里的榜单卡：一行 4 个（23%×4 + 3×gap12 ≈ 内容宽 92%+36，
  // 平台间窄差距 8pt 以内），高度略增保持图标+两行字的呼吸感
  boardCardWide: {
    width: '23%',
    minHeight: 72,
  },
  // 宽屏并排行：日推卡（左）+ 榜单区（右），各自垂直居中
  wideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: designSpacing.sm,
  },
  wideDaily: {
    flex: 1,
    paddingLeft: designSpacing.lg,
    justifyContent: 'center',
  },
  wideBoards: {
    flex: 1.6,
  },
  boardGrid: {
    marginTop: designSpacing.md,
    paddingHorizontal: designSpacing.lg,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: designSpacing.sm,
  },
  boardName: {
    textAlign: 'center',
    fontWeight: '600',
  },
  status: {
    textAlign: 'center',
    marginTop: designSpacing.lg,
  },
  // 失败态的重试入口：整行可点（文案自带「点击尝试重新加载」），与 wy 每日推荐
  // 失败态的「重新加载」按钮同一套语义，只是这里不额外放按钮、少一层视觉噪音
  retryEntry: {
    marginTop: designSpacing.lg,
    alignItems: 'center',
  },
})

export default memo(() => {
  const theme = useTheme()
  const statusBarHeight = useStatusbarHeight()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  // 宽屏判定（iPad 竖屏 768+ / iPad 横屏右栏；iPhone 全系 < 700 不受影响）：
  // 宽屏下「每日推荐 + 榜单」并排一行、榜单改两行网格、歌单卡加大 —— 单列布局
  // 在大屏上内容高度只占屏幕一半上下，观感偏空（AGENTS.md 大屏规范：多列/分栏）。
  const { width: winWidth } = useWindowDimensions()
  const isWide = winWidth >= 700
  const t = useI18n()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  const sourceNameType = useSettingValue('common.sourceNameType')
  // 平台文案走全局语言包别名（source_${sourceNameType}_${source}），与歌单页等处的显示一致
  const sourceLabel = useCallback(
    (source: string) => t(`source_${sourceNameType}_${source}`),
    [sourceNameType, t],
  )
  const supportedSources = useMemo(
    () => songlistState.sources.filter(
      (source): source is Source => !!songlistState.sortList[source]?.length,
    ),
    [],
  )
  // 平台按钮顺序跟随「设置 → 列表设置」里的排序；排在第一位的平台为默认选中平台
  const platformOrder = useSettingValue('common.discoveryPlatformOrder')
  const orderedSources = useMemo(
    () => getDiscoveryPlatformOrder(supportedSources, platformOrder),
    [supportedSources, platformOrder],
  )
  // B-6：冷启动恢复推荐页的页内子状态（上次选中的平台 / 页内打开的歌单详情）。
  // consumeViewRestore 是一次性消费：仅当「退出前顶层 id === nav_discovery 且本进程
  // 尚未消费」时才返回非 null，之后的手动切页/关详情不会再被恢复值覆盖。
  const restoredDiscoveryRef = useRef<ViewPrevDetailState['discovery'] | null | undefined>(undefined)
  if (restoredDiscoveryRef.current === undefined) {
    restoredDiscoveryRef.current = consumeViewRestore('nav_discovery')?.discovery ?? null
  }
  const [selectedSource, setSelectedSource] = useState<Source>(() => {
    const restored = restoredDiscoveryRef.current?.source
    // 恢复的平台必须仍在当前可用平台里（用户可能刚在设置里停用了它）；
    // 正常冷启动下 init() 先于 Home push，此处 orderedSources 必已就绪。
    if (restored && orderedSources.length > 0 && orderedSources.includes(restored as Source)) {
      return restored as Source
    }
    return (orderedSources[0] as Source) ?? 'kw'
  })
  // 排序变化时选中平台跟随新的第一位，避免改完设置仍停留在旧平台。
  // 首次运行只做「恢复的平台已失效则回落到第一位」的兜底，不重置——否则会把
  // B-6 刚恢复的平台盖掉；此后每次排序变化仍按原语义跟随新第一位。
  const isFirstOrderEffectRef = useRef(true)
  useEffect(() => {
    if (isFirstOrderEffectRef.current) {
      isFirstOrderEffectRef.current = false
      setSelectedSource(prev => (
        orderedSources.length > 0 && !orderedSources.includes(prev)
          ? ((orderedSources[0] as Source) ?? prev)
          : prev
      ))
      return
    }
    const first = orderedSources[0] as Source | undefined
    if (first) setSelectedSource(first)
  }, [orderedSources])
  const platformOptions = useMemo(
    () => orderedSources.map((source) => ({ id: source, label: sourceLabel(source) })),
    [orderedSources, sourceLabel],
  )
  const [playlists, setPlaylists] = useState<ListInfoItem[]>([])
  const [loading, setLoading] = useState(true)
  // 失败原因（'' = 没失败）。空列表时用它区分「真的没有歌单」与「请求失败」，
  // 并给出重试入口——失败只弹一次 toast 的话，用户离开这一屏再回来之前没有任何
  // 恢复路径（②-5「首次启动推荐歌单没有加载」）。
  const [loadError, setLoadError] = useState('')
  const [selectedPlaylist, setSelectedPlaylist] = useState<ListInfoItem | null>(
    () => restoredDiscoveryRef.current?.playlist ?? null,
  )
  const selectedPlaylistRef = useRef(selectedPlaylist)
  selectedPlaylistRef.current = selectedPlaylist
  // B-6：推荐页的页内子状态变化即落盘（平台选择 + 页内歌单详情），退出后重进可恢复。
  // 立即写盘不节流（理由见 utils/data.ts saveViewPrevDetail 注释）；playlist:null 是
  // 有效状态（用户已手动关掉详情），必须落盘，否则下次启动会把已关闭的歌单又弹出来。
  useEffect(() => {
    saveViewPrevDetail({ discovery: { source: selectedSource, playlist: selectedPlaylist } })
  }, [selectedSource, selectedPlaylist])
  const loadIdRef = useRef(0)
  const [boards, setBoards] = useState<BoardItem[]>([])
  const boardsLoadIdRef = useRef(0)

  const loadPlaylists = useCallback(async(source: Source) => {
    const currentLoadId = ++loadIdRef.current
    setLoading(true)
    setLoadError('')
    try {
      // 有界重试（2 次，800/2000ms）：冷启动首个请求要跟「网络栈就绪 / 平台偶发 5xx」
      // 抢时间，一次失败就定格成一屏空白。shouldRetry 兜住「等待期间用户切了平台」——
      // 被更新的一次加载取代后不再补发请求，那次错误由下面的 catch 按 loadId 丢弃。
      const result = await retryAsync(() => getList(source, '', getSortId(source), 1), {
        shouldRetry: () => currentLoadId === loadIdRef.current,
      })
      if (currentLoadId !== loadIdRef.current) return
      setPlaylists(result.list.map((item) => ({ ...item, source })))
    } catch (error: any) {
      if (currentLoadId !== loadIdRef.current) return
      // 失败不再无条件清空：只有「屏上这批数据属于别的平台」时才清，
      // 同平台的刷新失败保留上一次成功的列表——用户看到的至少还是有效内容，
      // 而不是被一次抖动清成空白（旧写法 setPlaylists([]) 正是「首次启动空白」的
      // 其中一环：失败后连原本能显示的内容也没了）。
      setPlaylists((prev) => (prev.length && prev[0]?.source === source ? prev : []))
      setLoadError(String(error?.message || ''))
      toast(String(error?.message || t('load_failed')))
    } finally {
      if (currentLoadId === loadIdRef.current) setLoading(false)
    }
  }, [t])

  const handleRetryPlaylists = useCallback(() => {
    void loadPlaylists(selectedSource)
  }, [loadPlaylists, selectedSource])

  const loadBoards = useCallback(async(source: Source) => {
    const currentLoadId = ++boardsLoadIdRef.current
    try {
      // 与歌单同档重试：榜单区失败是「整块消失」（渲染条件 boards.length），
      // 冷启动抖一下就没影了；同样是失败清空 + 无重试的老问题
      const boardList = await retryAsync(() => getBoardsList(source), {
        shouldRetry: () => currentLoadId === boardsLoadIdRef.current,
      })
      if (currentLoadId !== boardsLoadIdRef.current) return
      setBoards(boardList)
    } catch {
      if (currentLoadId !== boardsLoadIdRef.current) return
      // 榜单仍然失败即清空：BoardItem 不带 source，切换平台后若保留旧数据，
      // 屏上会是**别的平台**的榜单（比空着更糟）。重试已在上面的 retryAsync 里兜住，
      // 真正的冷启动抖动不会再走到这里。
      setBoards([])
    }
  }, [])

  useEffect(() => {
    void loadPlaylists(selectedSource)
  }, [loadPlaylists, selectedSource])

  const leaderboardSource = boardState.sources.includes(selectedSource)
    ? selectedSource
    : boardState.sources[0] ?? 'kw'

  useEffect(() => {
    void loadBoards(leaderboardSource)
  }, [leaderboardSource, loadBoards])

  const handleOpenDetail = useCallback((item: ListInfoItem) => {
    setSelectedPlaylist(item)
  }, [])

  const handleCloseDetail = useCallback(() => {
    setSelectedPlaylist(null)
  }, [])

  useEffect(() => {
    const onBackPress = () => {
      if (selectedPlaylistRef.current) {
        setSelectedPlaylist(null)
        return true
      }
      return false
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress)
    return () => { subscription.remove() }
  }, [])

  // 点榜单卡片进入排行榜页对应榜单：
  // 1) 持久化 source + boardId —— 排行榜页首次挂载时读取该设置兜底；
  // 2) 发出 showBoardDetail 事件 —— 排行榜页已挂载（切页不卸载）时实时切换到目标榜单。
  const handleOpenBoard = useCallback((board: BoardItem) => {
    // 必须用【同步】写入内存缓存：此前是 `await saveLeaderboardSetting(...)` 再切页，
    // 而该函数首次调用要先 await 一次真实存储读取（AsyncStorage I/O），切页因此被
    // 推迟到 I/O 之后；这段时间没有任何 UI 反馈，用户表现为「点了排行榜按钮有时
    // 没反应」（等待期间再点一次还会叠加两次切页）。同步写入后立即切页，响应确定；
    // 磁盘落盘仍由内部 1000ms throttle 异步完成，挂载时读到的也是刚写入的值。
    saveLeaderboardSettingSync({ source: leaderboardSource, boardId: board.id })
    // 事件 + 切页都保留：
    // - 事件（emit 基于 queueMicrotask，必定早于切页后的 rAF 挂载）在「本页尚未挂载」
    //   时会被丢弃，故排行榜页挂载时会读 getLeaderboardSetting 兜底——写入已同步完成，
    //   兜底读到的一定是本次目标榜单；
    // - 事件在「本页已挂载」时（例如已进入排行榜页后又被唤起）负责实时切榜。
    global.app_event.showBoardDetail({ source: leaderboardSource, boardId: board.id })
    // 先走常规切页，再无条件请求 PagerView 同步到 nav_top。
    //
    // 顺序很关键：forceSyncNavActiveId 重新广播的是**当前** navActiveId，所以要先把
    // 目标 id 落定（setNavActiveId），否则它会先强制切到「点之前那一页」再切到
    // 排行榜，多一次可见的抖动。
    //
    // 为什么必须补一次强制同步：setNavActiveId 有同值短路（id 相同直接 return、
    // 不发事件），而 PagerView 的原生落点可能已与 navActiveId 失配 —— 最典型的是
    // App 从后台恢复后 iOS 重建了 PagerView 的原生子视图、原生落点回到第 0 页
    // （推荐页），但 navActiveId 仍是后台前的 'nav_top'。此时用户在推荐页点榜单卡片
    // → setNavActiveId('nav_top') 被短路 → PagerView 永不校正 → 「点了没反应」
    // （该行横向滚动是原生的，仍能滑）。forceSyncNavActiveId 不受同值短路影响，
    // 会让 Main 真正下发一次 setPage，并要求 onPageSelected 回执刷新「原生真实
    // 落点」，从而把界面校正到排行榜页。
    setNavActiveId('nav_top')
    forceSyncNavActiveId()
  }, [leaderboardSource])

  // 每日推荐入口跟随平台切换；进入前校验对应平台 Cookie 是否已登录
  const dailyRecNav = DAILY_REC_NAVS[selectedSource]
  const handleOpenDailyRec = useCallback(() => {
    const nav = DAILY_REC_NAVS[selectedSource]
    if (!nav) return
    const cookieKey = DAILY_REC_COOKIE_KEYS[selectedSource]
    const logged = cookieKey ? !!settingState.setting[cookieKey] : false
    if (!logged) {
      toast(`请先登录${sourceLabel(selectedSource)}账号（设置 → 平台设置）`)
      return
    }
    setNavActiveId(nav)
  }, [selectedSource, sourceLabel])

  const headerStyle = useMemo(
    () => StyleSheet.compose(styles.header, {
      paddingTop: Math.max(designSpacing.sm, statusBarHeight - designSpacing.md),
    }),
    [statusBarHeight],
  )

  const titleStyle = useMemo(
    () => StyleSheet.compose(styles.title, {
      color: theme['c-font'],
      // 行高统一写在 styles.title 的 pageTitleLineHeight（42，四页共用）。
      // 它 > 34 × 1.15 ≈ 39.1，不存在「行高小于字高、大标题顶部笔画被裁掉」的问题；
      // 之所以不再交给 Text 组件兜底，是为了让四个主页的标题行高度完全一致
      // （见 DesignTokens.pageTitleLineHeight 的说明）。
    }),
    [theme],
  )

  // 右上角播放历史圆钮（工具栏按钮）：底色随「按钮透明度」淡出，图标色不动。
  // 只改颜色 alpha，不用容器 style.opacity——后者会把图标一起变淡。
  const historyButtonStyle = useMemo(
    () => StyleSheet.compose(styles.historyButton, {
      backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
      // 播放历史圆钮 42×42：按自身高度 42 折算半高，行内覆盖「按钮圆角」
      borderRadius: buttonRadius(42),
    }),
    [theme, buttonOpacity, buttonRadius],
  )

  // 推荐歌单区的状态行：只有这里能区分「加载中 / 加载失败 / 真的没有歌单」。
  // 失败必须与「暂无数据」分开显示、并给出重试入口 —— 旧写法把失败也显示成 list_empty
  // （「暂无数据~」），等于把「请求挂了」谎报成「没有数据」，用户既不知道发生了什么、
  // 也没有入口重来（②-5「首次启动推荐歌单没有加载」）。
  const renderShelfStatus = () => {
    if (loading) {
      return (
        <Text style={styles.status} size={designTypography.caption} color={theme['c-font-label']}>
          {t('list_loading')}
        </Text>
      )
    }
    if (playlists.length) return null
    if (loadError) {
      // 文案自带「点击尝试重新加载」，整行可点
      return (
        <TouchableOpacity style={styles.retryEntry} onPress={handleRetryPlaylists}>
          <Text size={designTypography.caption} color={theme['c-font-label']}>{t('list_error')}</Text>
        </TouchableOpacity>
      )
    }
    return (
      <Text style={styles.status} size={designTypography.caption} color={theme['c-font-label']}>
        {t('list_empty')}
      </Text>
    )
  }

  // 推荐歌单网格数据：12 → 24（getList 第 1 页本身 ~30 条，不产生额外请求）。
  // 大屏网格一屏可见卡数更多（iPad 可显示 4~5 列 × 多行），12 张一屏见底显空。
  const shelfData = useMemo(() => playlists.slice(0, 24), [playlists])

  // 榜单卡片：底色与边框随「按钮透明度」淡出；榜单名文字与榜单图标色不动。
  // 只作用于颜色 alpha，不用容器 style.opacity（会把内容一起变淡）。
  const boardCardStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-200'], buttonOpacity),
      borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  const renderBoardCard = useCallback((board: BoardItem, wide: boolean) => (
    <TouchableOpacity
      key={board.id}
      style={[styles.boardCard, wide ? styles.boardCardWide : null, boardCardStyle, { borderRadius: buttonRadius(wide ? 72 : 64) /* 榜单卡高度两态不同：窄屏横向滑轨用 boardCard.minHeight=64，宽屏两行网格变体用 boardCardWide.minHeight=72。恒传 64 会让宽屏下中间百分比按偏矮的分母折算、略欠圆；wide 布尔在本组件里已经传入（由 isWide = winWidth>=700 分流），直接按它取对应设计高度 */ }]}
      onPress={() => { handleOpenBoard(board) }}
    >
      <Icon name="leaderboard" size={18} color={theme['c-primary']} />
      <Text
        style={styles.boardName}
        numberOfLines={2}
        size={designTypography.caption}
        color={theme['c-font']}
      >
        {board.name}
      </Text>
    </TouchableOpacity>
  ), [boardCardStyle, handleOpenBoard, buttonRadius])

  return (
    <View style={styles.container}>
      <ScrollView
        style={selectedPlaylist ? { opacity: 0 } : null}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomInset }]}
        onScrollBeginDrag={Keyboard.dismiss}
        showsVerticalScrollIndicator={false}
        pointerEvents={selectedPlaylist ? 'none' : 'auto'}
        delaysContentTouches={false}
      >
        <View style={headerStyle}>
          <Text style={titleStyle} size={34}>{t('nav_discovery')}</Text>
          <TouchableOpacity
            style={historyButtonStyle}
            onPress={() => { setNavActiveId('nav_play_history') }}
          >
            <Icon name="music_time" size={21} color={theme['c-primary']} />
          </TouchableOpacity>
        </View>

        {/* 平台胶囊行直接用 PlatformChips 的 ScrollView 当子节点，外面不再包一层带
            marginTop 的 View：旧写法这里 marginTop md(16) 与上方 header 的 marginBottom
            md(16) 相加成 32pt（RN 的相邻 margin 不像 CSS 那样合并），歌单页同一行只有
            12pt，两页的平台胶囊行因此上下错开一整截。现在间距只由 header.marginBottom
            的 pageTitleGap 承担，与歌单页严格同值。 */}
        <PlatformChips
          options={platformOptions}
          selectedId={selectedSource}
          onChange={(id) => { setSelectedSource(id as Source) }}
        />

        {isWide ? (
          // 宽屏（iPad 竖屏/横屏）：日推卡（左，垂直居中）与榜单两行网格（右）
          // 并排一行，填补单列布局在大屏上的宽度留白；榜单铺 8 个（2×4），
          // 全部榜单仍从底部 Tab「排行榜」进入
          <View style={[styles.sectionGap, styles.wideRow]}>
            {dailyRecNav ? (
              <View style={styles.wideDaily}>
                <DailyRecommendCard
                  title={t('discovery_daily_title')}
                  subtitle={t('discovery_daily_subtitle')}
                  onPress={handleOpenDailyRec}
                />
              </View>
            ) : null}
            {boards.length ? (
              <View style={styles.wideBoards}>
                <Text
                  style={styles.sectionTitle}
                  size={designTypography.title}
                  color={theme['c-font']}
                >
                  {t('nav_top')}
                </Text>
                <View style={styles.boardGrid}>
                  {boards.slice(0, 8).map((board) => renderBoardCard(board, true))}
                </View>
              </View>
            ) : null}
          </View>
        ) : (
          <>
            {dailyRecNav ? (
              <View style={styles.daily}>
                <DailyRecommendCard
                  title={t('discovery_daily_title')}
                  subtitle={t('discovery_daily_subtitle')}
                  onPress={handleOpenDailyRec}
                />
              </View>
            ) : null}

            {boards.length ? (
              <View style={styles.sectionGap}>
                <Text
                  style={styles.sectionTitle}
                  size={designTypography.title}
                  color={theme['c-font']}
                >
                  {t('nav_top')}
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  delaysContentTouches={false}
                  contentContainerStyle={styles.boardContent}
                >
                  {boards.map((board) => renderBoardCard(board, false))}
                </ScrollView>
              </View>
            ) : null}
          </>
        )}

        <View style={styles.sectionGap}>
          {/* 推荐歌单：固定列数纵向网格（与「歌单」页同款列数公式），
              列宽由容器实测宽度计算，兼容 iPad 横屏 LandscapeCentered 限宽 */}
          <PlaylistGrid
            title={t('discovery_playlists_title')}
            data={shelfData}
            onPressItem={handleOpenDetail}
          />
        </View>

        {renderShelfStatus()}
      </ScrollView>
      {selectedPlaylist ? (
        <View style={StyleSheet.absoluteFill}>
          <SonglistDetail info={selectedPlaylist} onBack={handleCloseDetail} initialScrollToInfo={null} />
        </View>
      ) : null}
    </View>
  )
})
