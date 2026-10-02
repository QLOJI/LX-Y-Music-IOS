import { memo, useRef, useState, useCallback } from 'react'
import { TouchableOpacity, View, ScrollView } from 'react-native'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { designSpacing } from '@/theme/DesignTokens'
import PagerView, { type PagerViewOnPageSelectedEvent } from 'react-native-pager-view'
import RecSongs from './RecSongs'
import { BorderWidths } from '@/theme'
import { setNavActiveId } from '@/core/common'
import PageTopInset from '@/components/common/PageTopInset'
import DetailPageTitle from '@/components/common/DetailPageTitle'
import SwipeBackArea from '@/components/common/SwipeBackArea'

type TabType = 'recommend' | 'everyday'

const TABS: Array<{ id: TabType, label: string }> = [
  { id: 'recommend', label: '每日推荐' },
  { id: 'everyday', label: '新歌速递' },
]

const Tabs = ({
  activeTab,
  onTabChange,
}: {
  activeTab: TabType
  onTabChange: (tab: TabType) => void
}) => {
  const theme = useTheme()
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
          style={styles.tab}
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
  const [activeTab, setActiveTab] = useState<TabType>('recommend')
  const pagerViewRef = useRef<PagerView>(null)
  const t = useI18n()

  const handleTabChange = (newTab: TabType) => {
    if (activeTab === newTab) return
    setActiveTab(newTab)
    const tabIndex = TABS.findIndex((t) => t.id === newTab)
    pagerViewRef.current?.setPage(tabIndex)
  }

  const onPageSelected = useCallback(
    (event: PagerViewOnPageSelectedEvent) => {
      const newTab = TABS[event.nativeEvent.position]?.id || 'recommend'
      if (newTab !== activeTab) {
        setActiveTab(newTab)
      }
    },
    [activeTab],
  )

  const handleBackToDiscovery = useCallback(() => {
    setNavActiveId('nav_discovery')
  }, [])

  // 页头（状态栏占位 + 标题行）。用户第 16 轮第 6/7 条：
  // ① 它以前是各页 OnlineList 的 ListHeaderComponent，在可滚动内容里 —— 列表挂载/换数据时
  //    标题会跟着整体位移（「第一次进入向上刷新」），滚动时也会被推走（「标题没有固定」）。
  //    现在提到 PagerView 外面，成为所有页共用的固定页头，任何情况下都不动。
  // ② 标题与 tab 并排在同一行、同一垂直中线（原来是「标题一行、tab 另一行」两个基线）。
  // ③ 顶部到标题行的间距加大：PageTopInset 之后再垫 designSpacing.sm（见 headerExtraTop）。
  const pageHeader = (
    <View style={styles.headerExtraTop}>
      <PageTopInset />
      <DetailPageTitle title={t('nav_kg_daily_rec')}>
        <Tabs activeTab={activeTab} onTabChange={handleTabChange} />
      </DetailPageTitle>
    </View>
  )

  return (
    <View style={{ flex: 1 }}>
      {pageHeader}
      <View style={{ flex: 1 }}>
        <PagerView
          ref={pagerViewRef}
          style={{ flex: 1 }}
          initialPage={TABS.findIndex((t) => t.id === activeTab)}
          onPageSelected={onPageSelected}
          scrollEnabled
        >
          <View key="recommend">
            <RecSongs type="recommend" />
          </View>
          <View key="everyday">
            <RecSongs type="everyday" />
          </View>
        </PagerView>
      </View>
      <SwipeBackArea onBack={handleBackToDiscovery} />
    </View>
  )
})

const styles = createStyle({
  // 【第 16 轮第 6 条】「增大上面到顶部的间距」：PageTopInset（= 状态栏高度 − md，兜底 sm）之外
  // 再垫 sm(12)。仅本页/另两页每日推荐加，歌单页不加 —— 用户点名的是每日推荐页。
  headerExtraTop: {
    paddingTop: designSpacing.sm,
  },
  // 两个 tab 与标题同处一行（DetailPageTitle 的 row，alignItems center → 同一垂直中线）。
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
