import { memo, useRef, useState, useCallback } from 'react'
import { TouchableOpacity, View, ScrollView } from 'react-native'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
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

// 一行里的列数 = 标题 + 2 个 tab = 3（≤ 4，全部同时可见、平分整行）——用户第 18 轮第 1 条。
const COLUMN_COUNT = TABS.length + 1

const Tabs = ({
  activeTab,
  onTabChange,
  columnWidth,
}: {
  activeTab: TabType
  onTabChange: (tab: TabType) => void
  /** 等分列宽（pt）：由 DetailPageTitle 实测行宽后下发，标题列与本行每个 tab 列同宽 */
  columnWidth: number
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
          style={[styles.tab, { width: columnWidth }]}
          onPress={() => { onTabChange(tab.id) }}
        >
          <Text
            style={[
              styles.tabText,
              { borderBottomColor: activeTab === tab.id ? theme['c-primary-font-active'] : 'transparent' },
            ]}
            color={theme['c-font']}
            // 单行 + 放不下自动缩字号：不换行（换行会撑破行高、破坏「同一高度」）、不裁字
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.75}
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
  // ③ 顶部到标题行的间距：由共享组件 DetailPageTitle 的 row.paddingTop（designSpacing.sm）
  //    统一提供 —— 第 16 轮时只有这三页在自己的 headerExtraTop 里垫这一下，第 19 轮第 2 条起
  //    写进共享组件（十个用它的页面一条来源，七个「我的」二级列表页因此与推荐页同高）。
  // ④ 用户第 18 轮第 1 条：整行等分成 min(列数, 4) 列 —— 列宽由 DetailPageTitle 实测行宽后
  //    经渲染回调下发，标题列与每个 tab 列严格同宽、列内文字水平居中、垂直同一中线。
  const pageHeader = (
    <>
      <PageTopInset />
      <DetailPageTitle title={t('nav_kg_daily_rec')} equalColumnsCount={COLUMN_COUNT}>
        {(columnWidth) => (
          <Tabs activeTab={activeTab} onTabChange={handleTabChange} columnWidth={columnWidth} />
        )}
      </DetailPageTitle>
    </>
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
  // 两个 tab 与标题同处一行（DetailPageTitle 的 row，alignItems center → 同一垂直中线）。
  // flex:1 吃掉标题列右侧的剩余宽度；每列宽度由页面行内给（= 标题列宽，等分整行），
  // 项目数 > 4 时横向滚动查看（本页 3 列，全可见、无滚动）。
  tabsScroll: {
    flex: 1,
  },
  tabsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // 列盒：宽度行内给；文字在列内水平居中 —— 各文字块中心等距（间距相等、平分整个宽度）。
  tab: {
    paddingVertical: 5,
    alignItems: 'center',
  },
  tabText: {
    // 文字上下中心对齐（用户第 18 轮第 1 条）：下划线占走「paddingBottom + borderBottomWidth」
    // 的高度，只在下方留白会让文字在盒里整体偏上（≈4pt）；顶部补回同样多，文字中心才与标题
    // （42pt 行高居中）落在同一条垂直中线上。（createStyle 会对两个 padding 各做一次
    // scaleSizeH 取整，补偿后残差 < 0.5pt。）
    paddingTop: 5 + BorderWidths.normal3,
    paddingBottom: 5,
    borderBottomWidth: BorderWidths.normal3,
  },
})
