import { memo, useRef, useState, useCallback, useEffect } from 'react'
import { TouchableOpacity, View, BackHandler, StyleSheet, ScrollView } from 'react-native'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
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

// 一行里的列数 = 标题 + 4 个 tab = 5 → 收敛到「最多同时显示 4 个」（用户第 18 轮第 1 条：
// 「比如 QQ每日推荐、主页推荐、雷达推荐、推荐歌单这 4 个文字」）：标题按**自然宽**渲染，
// 剩余行宽由 3 个 tab 列等宽平分，「推荐新歌」横向滑动查看（列宽不变、不压缩）。
// 【第 20 轮·图二】列数的含义没变（含标题列），变的是标题不再占等分列 ——
// 旧版把标题塞进 1/4 列宽里自动缩字号，三页缩得不一样（「字体不一样」的根因），见 DetailPageTitle 注释四。
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
            // 列宽 = DetailPageTitle 下发的 tab 列宽（行内给；剩余宽不够时靠横向滑动查看，不压缩列宽）
            { width: columnWidth },
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
  // ③ 顶部到标题行的间距：由共享组件 DetailPageTitle 的 row.paddingTop（designSpacing.sm）
  //    统一提供 —— 第 16 轮时只有这三页在自己的 headerExtraTop 里垫这一下，第 19 轮第 2 条起
  //    写进共享组件（十个用它的页面一条来源，七个「我的」二级列表页因此与推荐页同高）。
  // ④ 用户第 18 轮第 1 条 + 第 20 轮图二：标题按自然宽渲染（字号不再被列宽挤压，三页一致），
  //    tab 列宽由 DetailPageTitle 按「（行宽 − 标题自然宽）÷ tab 列数」实测后经渲染回调下发，
  //    各 tab 列等宽、列内文字水平居中，且整个 tab 行下移到位（与标题字形底部对齐）。
  const pageHeader = (
    <>
      <PageTopInset />
      <DetailPageTitle title={t('nav_tx_daily_rec')} equalColumnsCount={COLUMN_COUNT}>
        {(columnWidth) => (
          <Tabs activeTab={activeTab} onTabChange={handleTabChange} columnWidth={columnWidth} />
        )}
      </DetailPageTitle>
    </>
  )

  return (
    <View style={{ flex: 1 }}>
      <View
        style={[{ flex: 1 }, selectedPlaylist ? { opacity: 0 } : null]}
        pointerEvents={selectedPlaylist ? 'none' : 'auto'}
      >
        {/* 页头必须在这层「变暗层」**里面**（用户第 33 轮第 6 条：点歌单后原标题/封面重叠）。
            以前它在外面，打开歌单详情（页内浮层，见下方 absoluteFill 的 SonglistDetail）时
            只把 PagerView 那层 opacity:0 了，状态栏占位 + 大标题 + tabs 仍然可见，而详情页
            自己的封面/标题从 statusBarHeight 起画，正好压上去 ⇒ 用户截图那种「两套标题叠着」。
            放进这一层后：打开详情 = 整页一起吃 opacity:0 + pointerEvents:none，
            屏幕上只剩歌单内容（原每日推荐标题不再显示）。
            同仓 MyPlaylist / KgPlaylist / TxPlaylist 的 index 都是这个范式，此处对齐。 */}
        {pageHeader}
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
  // 四个 tab 与标题同处一行（DetailPageTitle 的 row；【第 20 轮·图二】起整行下移，
  // 与标题字形底部对齐）。flex:1 吃掉标题自然宽右侧的剩余宽度；每列宽度由页面行内给
  // （= DetailPageTitle 下发的 tab 列宽），一屏「标题 + 3 个 tab」，第 4 个横向滑动查看
  // （用户第 18 轮第 1 条）。
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
