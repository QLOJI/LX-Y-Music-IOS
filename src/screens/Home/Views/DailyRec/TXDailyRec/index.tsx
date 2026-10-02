import { memo, useRef, useState, useCallback, useEffect } from 'react'
import { TouchableOpacity, View, BackHandler, StyleSheet, ScrollView } from 'react-native'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { designSpacing } from '@/theme/DesignTokens'
import PagerView, { type PagerViewOnPageSelectedEvent } from 'react-native-pager-view'
import RecSongs from './RecSongs'
import RecPlaylists from './RecPlaylists'
import { BorderWidths } from '@/theme'
import SonglistDetail from '../../../../SonglistDetail'
import { type ListInfoItem } from '@/store/songlist/state'
import commonState from '@/store/common/state'
import { setNavActiveId } from '@/core/common'
import PageTopInset from '@/components/common/PageTopInset'
import DetailPageTitle from '@/components/common/DetailPageTitle'
import SwipeBackArea from '@/components/common/SwipeBackArea'

type TabType = 'home' | 'radar' | 'songlist' | 'newsong'

const TABS: Array<{ id: TabType, label: string }> = [
  { id: 'home', label: '主页推荐' },
  { id: 'radar', label: '雷达推荐' },
  { id: 'songlist', label: '推荐歌单' },
  { id: 'newsong', label: '推荐新歌' },
]

const Tabs = ({
  activeTab,
  onTabChange,
}: {
  activeTab: TabType
  onTabChange: (tab: TabType) => void
}) => {
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  return (
    <ScrollView
      style={styles.tabsScroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.tabsContainer}
    >
      {TABS.map((tab) => (
        <TouchableOpacity
          key={tab.id}
          style={[
            styles.tab,
            // 顶部分段 tab 圆角随「按钮圆角」设置行内覆盖；可见高度 ≈ 32 = 15 号文字行高 17 + 下划线留白 5 + 上下 padding 5×2
            { borderRadius: buttonRadius(32) },
          ]}
          onPress={() => { onTabChange(tab.id) }}
        >
          <Text
            style={[
              styles.tabText,
              { borderBottomColor: activeTab === tab.id ? theme['c-primary-font-active'] : 'transparent' },
            ]}
            color={theme['c-font']}
          >
            {tab.label}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  )
}

export default memo(() => {
  const [activeTab, setActiveTab] = useState<TabType>('home')
  const pagerViewRef = useRef<PagerView>(null)
  const [selectedPlaylist, setSelectedPlaylist] = useState<ListInfoItem | null>(null)
  const selectedPlaylistRef = useRef(selectedPlaylist)
  selectedPlaylistRef.current = selectedPlaylist
  const t = useI18n()

  const handleTabChange = (newTab: TabType) => {
    if (activeTab === newTab) return
    setActiveTab(newTab)
    const tabIndex = TABS.findIndex((t) => t.id === newTab)
    pagerViewRef.current?.setPage(tabIndex)
  }

  const onPageSelected = useCallback(
    (event: PagerViewOnPageSelectedEvent) => {
      const newTab = TABS[event.nativeEvent.position]?.id || 'home'
      if (newTab !== activeTab) {
        setActiveTab(newTab)
      }
    },
    [activeTab],
  )

  const handleOpenDetail = useCallback((playlistInfo: ListInfoItem) => {
    setSelectedPlaylist(playlistInfo)
  }, [])

  const handleCloseDetail = useCallback(() => {
    setSelectedPlaylist(null)
  }, [])

  const handleBackToDiscovery = useCallback(() => {
    setNavActiveId('nav_discovery')
  }, [])

  useEffect(() => {
    const onBackPress = () => {
      if (selectedPlaylistRef.current) {
        if (commonState.componentIds.length > 1) {
          return false
        }
        setSelectedPlaylist(null)
        return true
      }
      return false
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress)
    return () => { subscription.remove() }
  }, [])


  // 页头（状态栏占位 + 标题行）。用户第 16 轮第 6/7 条：
  // ① 它以前是四个子页的 ListHeaderComponent，在可滚动内容里 —— 列表挂载/换数据时标题跟着
  //    整体位移（「第一次进入向上刷新」），滚动时还会被推走（「标题没有固定」）。现在提到
  //    PagerView 外面，四页共用同一个固定页头，任何情况下都不动。
  // ② 标题与 tab 同一行、同一垂直中线（原来是「标题一行、tab 另一行」两个基线）。
  // ③ 顶部到标题行的间距加大：PageTopInset 之后再垫 designSpacing.sm（见 headerExtraTop）。
  const pageHeader = (
    <View style={styles.headerExtraTop}>
      <PageTopInset />
      <DetailPageTitle title={t('nav_tx_daily_rec')}>
        <Tabs activeTab={activeTab} onTabChange={handleTabChange} />
      </DetailPageTitle>
    </View>
  )

  return (
    <View style={{ flex: 1 }}>
      {pageHeader}
      <View
        style={[{ flex: 1 }, selectedPlaylist ? { opacity: 0 } : null]}
        pointerEvents={selectedPlaylist ? 'none' : 'auto'}
      >
        <PagerView
          ref={pagerViewRef}
          style={{ flex: 1 }}
          initialPage={TABS.findIndex((t) => t.id === activeTab)}
          onPageSelected={onPageSelected}
          scrollEnabled
        >
          <View key="home">
            <RecSongs type="home" onOpenDetail={handleOpenDetail} />
          </View>
          <View key="radar">
            <RecSongs type="radar" />
          </View>
          <View key="songlist">
            <RecPlaylists onOpenDetail={handleOpenDetail} />
          </View>
          <View key="newsong">
            <RecSongs type="newsong" />
          </View>
        </PagerView>
      </View>
      {selectedPlaylist && (
        <View style={[StyleSheet.absoluteFill]}>
          <SonglistDetail info={selectedPlaylist} onBack={handleCloseDetail} initialScrollToInfo={null} />
        </View>
      )}
      <SwipeBackArea onBack={handleBackToDiscovery} enabled={!selectedPlaylist} />
    </View>
  )
})

const styles = createStyle({
  // 【第 16 轮第 6 条】「增大上面到顶部的间距」：PageTopInset（= 状态栏高度 − md，兜底 sm）之外
  // 再垫 sm(12)。仅每日推荐页加，歌单页不加 —— 用户点名的是每日推荐页。
  headerExtraTop: {
    paddingTop: designSpacing.sm,
  },
  // 四个 tab 与标题同处一行（DetailPageTitle 的 row，alignItems center → 同一垂直中线）。
  // flex:1 吃掉标题右侧的剩余宽度，横向滚动兜底：字号放大 / 窄屏放不下时可左右滑动，
  // 不会换行或被裁掉。
  tabsScroll: {
    flex: 1,
  },
  tabsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tab: {
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  tabText: {
    paddingBottom: 5,
    borderBottomWidth: BorderWidths.normal3,
  },
})
