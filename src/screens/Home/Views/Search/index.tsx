import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { InteractionManager } from 'react-native'
import { type LayoutChangeEvent, View, BackHandler } from 'react-native'
import HeaderBar, { type HeaderBarProps, type HeaderBarType } from './HeaderBar'
import SearchTypeSelector from './SearchTypeSelector'
import searchState, { type SearchType } from '@/store/search/state'
import commonState from '@/store/common/state'
import searchMusicState from '@/store/search/music/state'
import searchSonglistState, { type ListInfoItem } from '@/store/search/songlist/state'
import { getSearchSetting, saveSearchSetting } from '@/utils/data'
import { consumePendingAction } from '@/core/pendingAction'
import { createStyle } from '@/utils/tools'
import TipList, { type TipListType } from './TipList'
import List, { type ListType } from './List'
import { addHistoryWord, setSearchText as setSearchState } from '@/core/search/search'
import SonglistDetail from '../../../SonglistDetail'
import { COMPONENT_IDS } from '@/config/constant'
import { useSettingValue } from '@/store/setting/hook'
import { designSpacing } from '@/theme/DesignTokens'

interface SearchInfo {
  temp_source: LX.OnlineSource
  source: LX.OnlineSource | 'all'
  searchType: 'music' | 'songlist' | 'singer' | 'album'
}

export default () => {
  const headerBarRef = useRef<HeaderBarType>(null)
  const searchTipListRef = useRef<TipListType>(null)
  const listRef = useRef<ListType>(null)
  const layoutHeightRef = useRef<number>(0)
  const containerHeightRef = useRef(0)
  const searchInfo = useRef<SearchInfo>({ temp_source: 'kw', source: 'kw', searchType: 'music' })
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [selectedList, setSelectedList] = useState<ListInfoItem | null>(null)
  // 搜索框自身的几何（相对页面）。联想浮层要「上边界与搜索框下边界齐平、左右与搜索框等宽」，
  // 不能再拿整块 header 的高度当上边距（那会落到平台胶囊/类型选择器下面），也不能
  // 铺满整页宽（用户第 11 轮第 8 条）。由 HeaderBar 的 onSearchBarLayout 上报。
  const [searchBarRect, setSearchBarRect] = useState<{
    x: number, y: number, width: number, height: number
  } | null>(null)
  // 筛选浮层容器「上端」的页面 y：有搜索框测量值时 = 搜索框下端，否则退回整块 header 下端。
  // 这个值既是浮层的定位基准，也是展开动画的高度基准 —— components/SearchTipList 的
  // 展开/收起动画用 translateY(∓height/2) 抵消「以中心缩放」带来的位移，height 必须等于
  // 浮层容器的真实高度（页面底部 − 上端），盒子才不会在动画期间越过这个上端。
  // 此前传的是「容器高 − 整块 header 高」，比真实高度小 (header 高 − 搜索框下端)/2，
  // 展开时盒子从搜索框上端附近一路往下滑、遮住搜索输入框（用户第 15 轮第 2 条）。
  const tipListTopRef = useRef(0)
  const syncTipListHeight = useCallback(() => {
    const top = tipListTopRef.current
    layoutHeightRef.current = Math.max(0, containerHeightRef.current - top)
  }, [])
  const handleSearchBarLayout = useCallback((rect: { x: number, y: number, width: number, height: number }) => {
    tipListTopRef.current = rect.y + rect.height
    syncTipListHeight()
    setSearchBarRect(prev => (
      prev && prev.x == rect.x && prev.y == rect.y && prev.width == rect.width && prev.height == rect.height
        ? prev
        : rect
    ))
  }, [syncTipListHeight])
  const [source, setSource] = useState<SearchInfo['source']>(searchInfo.current.source)
  const [sourceType, setSourceType] = useState<SearchInfo['searchType']>(searchInfo.current.searchType)
  const selectedListRef = useRef(selectedList)
  selectedListRef.current = selectedList

  const enabledSources = useSettingValue('search.enabledSources')
  const filteredMusicSources = useMemo(
    () => searchMusicState.sources.filter(s => enabledSources[s]),
    [enabledSources],
  )
  const filteredSonglistSources = useMemo(
    () => searchSonglistState.sources.filter(s => enabledSources[s]),
    [enabledSources],
  )

  const availableSources = useMemo(
    () => sourceType === 'songlist' ? filteredSonglistSources : filteredMusicSources,
    [filteredMusicSources, filteredSonglistSources, sourceType],
  )

  const [headerKey, setHeaderKey] = useState(Date.now())

  useEffect(() => {
    const onBackPress = () => {
      if (selectedListRef.current) {
        const lastScreen = commonState.componentIds[commonState.componentIds.length - 1]

        if (lastScreen && lastScreen.name !== COMPONENT_IDS.home) {
          return false
        }

        setSelectedList(null)
        return true
      }
      return false
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress)

    return () => { subscription.remove() }
  }, [])

  useEffect(() => {
    if (!selectedList) {
      setHeaderKey(Date.now())
      if (searchState.searchText) {
        listRef.current?.loadList(
          searchState.searchText,
          searchInfo.current.source,
          searchInfo.current.searchType,
        )
      }
    }
  }, [selectedList])

  const handleSearch: HeaderBarProps['onSearch'] = useCallback((text) => {
    handleHideTipList()
    setSelectedList(null)
    setSearchState(text)
    searchTipListRef.current?.search(text, layoutHeightRef.current)
    headerBarRef.current?.setText(text)
    headerBarRef.current?.blur()
    void addHistoryWord(text)
    void listRef.current?.loadList(text, searchInfo.current.source, searchInfo.current.searchType)
  }, [])

  useEffect(() => {
    void getSearchSetting().then((info) => {
      searchInfo.current.temp_source = info.temp_source
      searchInfo.current.source = info.source
      searchInfo.current.searchType = info.type
      setSource(info.source)
      setSourceType(info.type)
      headerBarRef.current?.setText(searchState.searchText)
      void listRef.current?.loadList(
        searchState.searchText,
        searchInfo.current.source,
        searchInfo.current.searchType,
      )
    })

    const handleTypeChange = (type: SearchType) => {
      setSelectedList(null)
      searchInfo.current.searchType = type
      setSourceType(type)
      void saveSearchSetting({ type })
      if (searchState.searchText) {
        listRef.current?.loadList(searchState.searchText, searchInfo.current.source, type)
      }
    }
    global.app_event.on('searchTypeChanged', handleTypeChange)

    const handleSearchDeepLink = async(keyword: string, source: string, type: string) => {
      const info = await getSearchSetting()
      searchInfo.current.source = (source || info.source) as LX.OnlineSource
      searchInfo.current.searchType = (type || info.type) as SearchType
      setSource(searchInfo.current.source)
      setSourceType(searchInfo.current.searchType)
      if (type) {
        global.app_event.searchTypeChanged(searchInfo.current.searchType)
      }
      if (keyword) {
        listRef.current?.loadList(
          keyword,
          searchInfo.current.source,
          searchInfo.current.searchType,
        )
      }
      setTimeout(() => headerBarRef.current?.focus(), 300)
    }
    global.app_event.on('searchDeepLink', handleSearchDeepLink)

    return () => {
      global.app_event.off('searchTypeChanged', handleTypeChange)
      global.app_event.off('searchDeepLink', handleSearchDeepLink)
    }
  }, [filteredMusicSources, filteredSonglistSources, headerKey])

  useEffect(() => {
    const handleNavChange = async(id: string) => {
      if (id === 'nav_search') {
        const info = await getSearchSetting()
        searchInfo.current.source = info.source
        searchInfo.current.searchType = info.type
        setSource(info.source)
        setSourceType(info.type)
        headerBarRef.current?.setText(searchState.searchText)
        if (searchState.searchText) {
          void listRef.current?.loadList(searchState.searchText, info.source, info.type)
        }
        if (consumePendingAction('searchFocus')) {
          void InteractionManager.runAfterInteractions(() => {
            headerBarRef.current?.focus()
          })
        }
      }
    }
    global.state_event.on('navActiveIdUpdated', handleNavChange)

    if (consumePendingAction('searchFocus')) {
      void InteractionManager.runAfterInteractions(() => {
        headerBarRef.current?.focus()
      })
    }

    return () => {
      global.state_event.off('navActiveIdUpdated', handleNavChange)
    }
  }, [])

  const handleLayout = (e: LayoutChangeEvent) => {
    containerHeightRef.current = e.nativeEvent.layout.height
    syncTipListHeight()
  }
  const handleSourceChange: HeaderBarProps['onSourceChange'] = (source) => {
    setSelectedList(null)
    setSource(source)
    searchInfo.current.source = source
    void saveSearchSetting({ source: source as LX.OnlineSource })
    if (searchState.searchText) {
      listRef.current?.loadList(searchState.searchText, source, searchInfo.current.searchType)
    }
  }

  const handleTipSearch: HeaderBarProps['onTipSearch'] = (text) => {
    setTimeout(() => {
      searchTipListRef.current?.search(text, layoutHeightRef.current)
    }, 500)
  }
  const handleHideTipList = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    searchTipListRef.current?.hide()
  }
  const handleCancelSearch = useCallback(() => {
    handleHideTipList()
    setSelectedList(null)
    setSearchState('')
    headerBarRef.current?.setText('')
    headerBarRef.current?.blur()
    void listRef.current?.loadList('', searchInfo.current.source, searchInfo.current.searchType)
  }, [])
  const handleShowTipList: HeaderBarProps['onShowTipList'] = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      searchTipListRef.current?.show(layoutHeightRef.current)
    }, 500)
  }

  const handleOpenDetail = useCallback((item: ListInfoItem) => {
    setSelectedList(item)
  }, [])

  const searchHeader = selectedList ? null : (
    // 【第 16 轮第 5 条】这里不再挂 onLayout 记录「整块 header 高度」：
    // 联想浮层的定位/动画高度一律以搜索框实测底边为唯一基准（HeaderBar 的
    // onSearchBarLayout → tipListTopRef / layoutHeightRef），旧的整块 header 锚点已删。
    <View>
      <HeaderBar
        key={headerKey}
        ref={headerBarRef}
        sources={availableSources}
        source={source}
        onSourceChange={handleSourceChange}
        onTipSearch={handleTipSearch}
        onSearch={handleSearch}
        onHideTipList={handleHideTipList}
        onOpenSearch={() => {}}
        onCancelSearch={handleCancelSearch}
        onShowTipList={handleShowTipList}
        onSearchBarLayout={handleSearchBarLayout}
      />
      <View style={styles.typeRow}>
        <SearchTypeSelector />
      </View>
    </View>
  )

  // 联想浮层几何：上边界与搜索框下边界齐平 + 与搜索框等宽（第 11 轮第 8 条、第 16 轮第 5 条）。
  // 搜索框几何来自 HeaderBar 的 onSearchBarLayout；首帧（尚未测量到）容器给 0 高 ——
  // 既不参与任何显示（SearchTipList 的高度门控同样是 0），也不会以错误几何先闪一下。
  // 注意：浮层高度与这里同源（见 syncTipListHeight），改定位基准时两处必须一起改，
  // 否则展开动画的位移补偿会与真实几何错位（用户第 15 轮第 2 条）。
  const tipListContainerStyle = useMemo(
    () => searchBarRect
      ? {
          top: searchBarRect.y + searchBarRect.height,
          left: searchBarRect.x,
          width: searchBarRect.width,
        }
      : { top: 0, height: 0, left: 0, right: 0 },
    [searchBarRect],
  )

  return (
    // 刻意*不*用 KeyboardAvoidingView（用户第 11 轮第 4/5 条）：本页输入框在最上方，
    // 键盘永远盖不到它，而 behavior='padding' 会让整块内容随键盘升降改高度——键盘收起时
    // 就是这个「整页下移再上移」的抽动来源，点「取消」时（先 blur 再换页）叠在一起看就是
    // 整屏闪一下。代价：键盘弹着时结果列表的底部被键盘盖住（可先收键盘或上滑列表），
    // 换来的是键盘进出完全不改变布局。
    <View
      style={styles.container}
      onLayout={handleLayout}
    >
      { !selectedList && (
        <List
          ref={listRef}
          header={searchHeader ?? undefined}
          onSearch={handleSearch}
          onOpenDetail={handleOpenDetail}
        />
      )}
      {selectedList ? (
        <View style={styles.content} onLayout={handleLayout}>
          <SonglistDetail
            info={selectedList}
            onBack={() => { setSelectedList(null) }}
            initialScrollToInfo={null}
          />
        </View>
      ) : (
        <View style={[styles.tipListContainer, tipListContainerStyle]} pointerEvents="box-none">
          <TipList ref={searchTipListRef} onSearch={handleSearch} />
        </View>
      )}
    </View>
  )
}


const styles = createStyle({
  container: {
    width: '100%',
    flex: 1,
  },
  content: {
    flex: 1,
  },
  typeRow: {
    // 高度 = 类型按钮自身高度 36（原为 42）：多出的 6pt 会让按钮上下各留 3pt 白边，
    // 叠加到平台胶囊行的 paddingVertical 之上，「胶囊行 → 类型按钮行」就比同页其它
    // 行距更远。收成 36 后上间距恰为 controlGap，与搜索页其它各行一致。
    height: 36,
    paddingHorizontal: designSpacing.lg,
    justifyContent: 'center',
  },
  tipListContainer: {
    // 几何（top/left/width 或 top/left/right）全部由行内 tipListContainerStyle 给出：
    // 有搜索框测量值时贴搜索框下端并等宽，没有时退回旧的整宽布局。
    // 这里只保留不随测量变化的定位基准与层级。
    position: 'absolute',
    bottom: 0,
    zIndex: 10,
  },
})
