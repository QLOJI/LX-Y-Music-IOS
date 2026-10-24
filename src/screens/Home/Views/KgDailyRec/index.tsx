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
import { useRecoverablePager } from '../useRecoverablePager'

type TabType = 'recommend' | 'everyday'

const TABS: Array<{ id: TabType, label: string }> = [
  { id: 'recommend', label: '每日推荐' },
  { id: 'everyday', label: '新歌速递' },
]

// 一行里的列数 = 标题 + 2 个 tab = 3（≤ 4，标题按自然宽、两个 tab 列平分剩余行宽，
// 全部同时可见）——用户第 18 轮第 1 条；【第 20 轮·图二】起标题不再占等分列，见 DetailPageTitle 注释四。
const COLUMN_COUNT = TABS.length + 1

const Tabs = ({
  activeTab,
  onTabChange,
  columnWidth,
}: {
  activeTab: TabType
  onTabChange: (tab: TabType) => void
  /** tab 列宽（pt）：由 DetailPageTitle 按「（行宽 − 标题自然宽）÷ tab 列数」实测下发，各 tab 列等宽 */
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
  const activeIndexRef = useRef(TABS.findIndex((t) => t.id === activeTab))
  activeIndexRef.current = TABS.findIndex((t) => t.id === activeTab)
  // 【第 184 轮】统一的可恢复 PagerView：动画切页 → 非动画兜底 → 重挂；
  // 外加手势静默看门狗与进页非动画复位（与 QQ / 网易日推共用）。
  const {
    pagerKey,
    requestPage,
    notifyPageSelected,
    clearPagerLatch,
    onPageScroll,
    onPageScrollStateChanged,
  } = useRecoverablePager(pagerViewRef, { navId: 'nav_kg_daily_rec', activeIndexRef })

  const t = useI18n()

  const handleTabChange = (newTab: TabType) => {
    if (activeTab === newTab) return
    setActiveTab(newTab)
    const tabIndex = TABS.findIndex((t) => t.id === newTab)
    requestPage(tabIndex)
  }

  const onPageSelected = useCallback(
    (event: PagerViewOnPageSelectedEvent) => {
      // 落页 = 手势确定结束：撤掉恢复链、抹平可能残留的库私有闩锁。
      notifyPageSelected()
      const newTab = TABS[event.nativeEvent.position]?.id || 'recommend'
      if (newTab !== activeTab) {
        setActiveTab(newTab)
      }
    },
    [activeTab, notifyPageSelected],
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
  // ④ 用户第 18 轮第 1 条 + 第 20 轮图二：标题按自然宽渲染（字号不再被列宽挤压，三页一致），
  //    tab 列宽由 DetailPageTitle 按「（行宽 − 标题自然宽）÷ tab 列数」实测后经渲染回调下发，
  //    各 tab 列等宽、列内文字水平居中，且整个 tab 行下移到位（与标题字形底部对齐）。
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
    <View
      style={{ flex: 1 }}
      // 触摸起点一定没有手势在跑：先抹平闩锁再让协商照常往下走（返回 false = 不截胡）。
      onStartShouldSetResponderCapture={() => {
        clearPagerLatch()
        return false
      }}
    >
      {pageHeader}
      <View style={{ flex: 1 }}>
        <PagerView
          // 原生实例彻底不响应时的最后兜底：换 key 重挂（initialPage 仍落在当前 tab）。
          key={pagerKey}
          ref={pagerViewRef}
          style={{ flex: 1 }}
          initialPage={TABS.findIndex((t) => t.id === activeTab)}
          onPageSelected={onPageSelected}
          onPageScroll={onPageScroll}
          onPageScrollStateChanged={onPageScrollStateChanged}
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
  // 两个 tab 与标题同处一行（DetailPageTitle 的 row；【第 20 轮·图二】起整行下移，
  // 与标题字形底部对齐）。flex:1 吃掉标题自然宽右侧的剩余宽度；每列宽度由页面行内给
  // （= DetailPageTitle 下发的 tab 列宽），本页标题 + 2 列全可见、无滚动。
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
