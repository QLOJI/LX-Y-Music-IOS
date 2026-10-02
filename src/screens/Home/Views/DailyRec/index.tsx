import { memo, useRef, useState, useCallback, useEffect } from 'react'
import { TouchableOpacity, View, BackHandler, StyleSheet } from 'react-native'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import PagerView, { type PagerViewOnPageSelectedEvent } from 'react-native-pager-view'
import RecPlaylists from './RecPlaylists'
import RecSongs from './RecSongs'
import StylizedModal, { type StylizedSelection, loadStylizedSelection } from './StylizedModal'
import { BorderWidths } from '@/theme'
import SonglistDetail from '../../../SonglistDetail'
import { type ListInfoItem } from '@/store/songlist/state'
import commonState from '@/store/common/state'
import { setNavActiveId } from '@/core/common'
import PageTopInset from '@/components/common/PageTopInset'
import DetailPageTitle from '@/components/common/DetailPageTitle'
import SwipeBackArea from '@/components/common/SwipeBackArea'

// 一行里的列数 = 标题 + 2 个主 tab + （「推荐歌曲」下的 2 个子模式 chip）：
// songs 模式 5 列、playlists 模式 3 列；再经「最多同时显示 4 个」收敛（用户第 18 轮第 1 条）——
// songs 模式 4 列：标题 / 推荐歌曲 / 推荐歌单 / 默认推荐 同时可见，「风格化推荐」横向滑动查看；
// playlists 模式 3 列：全部同时可见（切到推荐歌单时没有风格化概念，子模式 chip 不渲染）。
const columnCountOf = (activeTab: 'songs' | 'playlists') => activeTab === 'songs' ? 5 : 3

const Tabs = ({
  activeTab,
  onTabChange,
  isStylized,
  setIsStylized,
  onOpenModal,
  columnWidth,
}: {
  activeTab: 'songs' | 'playlists'
  onTabChange: (tab: 'songs' | 'playlists') => void
  isStylized: boolean
  setIsStylized: (v: boolean) => void
  onOpenModal: () => void
  /** 等分列宽（pt）：由 DetailPageTitle 实测行宽后下发，标题列与本行每一列严格同宽 */
  columnWidth: number
}) => {
  const theme = useTheme()
  // 子模式 chip 的描边随「按钮透明度」淡出，文字色不动。只改颜色 alpha，不能用容器 style.opacity。
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  return (
    // 标题与本行四个按钮/子模式同处一行（页头里的 DetailPageTitle，第 16 轮第 6 条：标题与「推荐」
    // 字样在一条直线上、同一垂直中线）：
    // 推荐歌曲 / 推荐歌单 是主 tab（下划线选区），默认推荐 / 风格化推荐 是「推荐歌曲」下的子模式
    // （切到「推荐歌单」时没有风格化概念，故只在 songs 下显示）。
    // 用户第 18 轮第 1 条：整行按等分列排布（每列宽度 = columnWidth，列内文字水平居中）——
    // 不换行、不超宽，超过 4 列时靠横向滑动查看（原来的 flexWrap 在 Pro Max 上会把「风格化推荐」
    // 挤到第二行，撑破「所有顶部栏文字同一高度」）。
    <ScrollView
      style={styles.tabsScroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.tabsContainer}
    >
      <TouchableOpacity
        style={[
          styles.tab,
          // 列宽 = 等分列宽（行内给）
          { width: columnWidth },
          // 主 tab 圆角随「按钮圆角」设置行内覆盖；可见高度 ≈ 32 = 15 号文字行高 17 + 下划线留白 5 + 上下 padding 5×2
          { borderRadius: buttonRadius(32) },
        ]}
        onPress={() => { onTabChange('songs') }}
      >
        <Text
          style={[styles.tabText, { borderBottomColor: activeTab === 'songs' ? theme['c-primary-font-active'] : 'transparent' }]}
          color={theme['c-font']}
          // 单行 + 放不下自动缩字号：不换行（换行会撑破行高、破坏「同一高度」）、不裁字
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
        >
          推荐歌曲
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.tab,
          { width: columnWidth },
          // 主 tab 圆角随「按钮圆角」设置行内覆盖；可见高度 ≈ 32 = 15 号文字行高 17 + 下划线留白 5 + 上下 padding 5×2
          { borderRadius: buttonRadius(32) },
        ]}
        onPress={() => { onTabChange('playlists') }}
      >
        <Text
          style={[styles.tabText, { borderBottomColor: activeTab === 'playlists' ? theme['c-primary-font-active'] : 'transparent' }]}
          color={theme['c-font']}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
        >
          推荐歌单
        </Text>
      </TouchableOpacity>
      {activeTab === 'songs' ? (
        <>
          {/* 子模式 chip：自身宽度仍贴合文字（描边贴着文字，不是整列宽的外框），
              但在自己的等分列内居中 —— 与两个主 tab 同列宽、同一垂直中线。 */}
          <View style={[styles.subTabColumn, { width: columnWidth }]}>
            <TouchableOpacity
              onPress={() => { setIsStylized(false) }}
              style={[
                styles.subTab,
                !isStylized ? { borderColor: applyOpacity(theme['c-primary-font'], buttonOpacity) } : { borderColor: 'transparent' },
                // 子模式 chip 圆角随「按钮圆角」设置行内覆盖；可见高度 ≈ 22 = 13 号文字行高 15 + 上下 padding 3×2 + 边框 0.4×2
                { borderRadius: buttonRadius(22) },
              ]}
            >
              <Text
                color={!isStylized ? theme['c-primary-font'] : theme['c-font']}
                size={13}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.75}
              >
                默认推荐
              </Text>
            </TouchableOpacity>
          </View>
          <View style={[styles.subTabColumn, { width: columnWidth }]}>
            <TouchableOpacity
              onPress={() => {
                if (!isStylized) setIsStylized(true)
                else onOpenModal()
              }}
              style={[
                styles.subTab,
                isStylized ? { borderColor: applyOpacity(theme['c-primary-font'], buttonOpacity) } : { borderColor: 'transparent' },
                // 子模式 chip 圆角随「按钮圆角」设置行内覆盖；可见高度 ≈ 22 = 13 号文字行高 15 + 上下 padding 3×2 + 边框 0.4×2
                { borderRadius: buttonRadius(22) },
              ]}
            >
              <Text
                color={isStylized ? theme['c-primary-font'] : theme['c-font']}
                size={13}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.75}
              >
                {isStylized ? '风格化推荐 ▾' : '风格化推荐'}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}
    </ScrollView>
  )
}

export default memo(() => {
  const [activeTab, setActiveTab] = useState<'songs' | 'playlists'>('songs')
  const [isStylized, setIsStylized] = useState(false)
  const [showStylizedModal, setShowStylizedModal] = useState(false)
  const [stylizedSelection, setStylizedSelection] = useState<StylizedSelection>(null)

  useEffect(() => {
    loadStylizedSelection().then(data => {
      if (data) setStylizedSelection(data)
    })
  }, [])

  const pagerViewRef = useRef<PagerView>(null)
  const [selectedPlaylist, setSelectedPlaylist] = useState<ListInfoItem | null>(null)
  const selectedPlaylistRef = useRef(selectedPlaylist)
  selectedPlaylistRef.current = selectedPlaylist
  const t = useI18n()
  const handleTabChange = (newTab: 'songs' | 'playlists') => {
    if (activeTab === newTab) return
    setActiveTab(newTab)
    pagerViewRef.current?.setPage(newTab === 'songs' ? 0 : 1)
  }

  const onPageSelected = useCallback((event: PagerViewOnPageSelectedEvent) => {
    const newTab = event.nativeEvent.position === 0 ? 'songs' : 'playlists'
    if (newTab !== activeTab) {
      setActiveTab(newTab)
    }
  }, [activeTab])

  const handleOpenDetail = useCallback((playlistInfo: ListInfoItem) => {
    setSelectedPlaylist(playlistInfo)
  }, [])

  const handleCloseDetail = useCallback(() => {
    setSelectedPlaylist(null)
  }, [])

  const handleBackToDiscovery = useCallback(() => {
    setNavActiveId('nav_discovery')
  }, [])

  // 页头（状态栏占位 + 标题行）。用户第 16 轮第 6/7 条：
  // ① 它以前是各页 RecSongs/RecPlaylists 的 ListHeaderComponent，在可滚动内容里 ——
  //    列表挂载/换数据时标题跟着整体位移（「第一次进入向上刷新」），滚动时还会被推走
  //    （「标题没有固定」）。现在提到 PagerView 外面，两页共用同一个固定页头。
  // ② 标题与「推荐」按钮同一行、同一垂直中线（原来是「大标题一行、按钮另一行」两个基线）。
  // ③ 顶部到标题行的间距：由共享组件 DetailPageTitle 的 row.paddingTop（designSpacing.sm）
  //    统一提供 —— 第 16 轮时只有这三页在自己的 headerExtraTop 里垫这一下，第 19 轮第 2 条起
  //    写进共享组件（十个用它的页面一条来源，七个「我的」二级列表页因此与推荐页同高）。
  // ④ 用户第 18 轮第 1 条：整行等分成 min(列数, 4) 列（列数随 songs / playlists 模式变）——
  //    列宽由 DetailPageTitle 实测行宽后经渲染回调下发，标题列与每个按钮列严格同宽、
  //    列内文字水平居中、垂直同一中线；超过 4 列横向滑动查看，不换行。
  const pageHeader = (
    <>
      <PageTopInset />
      <DetailPageTitle title={t('nav_daily_rec')} equalColumnsCount={columnCountOf(activeTab)}>
        {(columnWidth) => (
          <Tabs
            activeTab={activeTab}
            onTabChange={handleTabChange}
            isStylized={isStylized}
            setIsStylized={setIsStylized}
            onOpenModal={() => { setShowStylizedModal(true) }}
            columnWidth={columnWidth}
          />
        )}
      </DetailPageTitle>
    </>
  )

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

  return (
    <View style={{ flex: 1 }}>
      {pageHeader}
      <View style={[{ flex: 1 }, selectedPlaylist ? { opacity: 0 } : null]} pointerEvents={selectedPlaylist ? 'none' : 'auto'}>
        <PagerView
          ref={pagerViewRef}
          style={{ flex: 1 }}
          initialPage={activeTab === 'songs' ? 0 : 1}
          onPageSelected={onPageSelected}
          scrollEnabled
        >
          <View key="1">
            {(activeTab === 'songs') && (
              <RecSongs
                isStylized={isStylized}
                stylizedSelection={stylizedSelection}
              />
            )}
          </View>
          <View key="2">
            <RecPlaylists onOpenDetail={handleOpenDetail} />
          </View>
        </PagerView>
        <StylizedModal
          visible={showStylizedModal}
          onClose={() => { setShowStylizedModal(false) }}
          onConfirm={(selection) => {
            setStylizedSelection(selection)
            setShowStylizedModal(false)
            setIsStylized(true)
          }}
        />
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
  // 四个按钮与标题同处一行（DetailPageTitle 的 row，alignItems center → 同一垂直中线）。
  // flex:1 吃掉标题列右侧剩余宽度；每列宽度由页面行内给（= 标题列宽，等分整行）。
  // 不再用 flexWrap（换行会撑破行高、破坏「所有顶部栏文字同一高度」）——超过 4 列横向滑动。
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
  // 子模式按钮（默认推荐 / 风格化推荐）所在的一列：宽度行内给（= 等分列宽），
  // 列内居中的是 chip 本身（chip 宽度贴合文字、描边不拉满整列）。
  subTabColumn: {
    alignItems: 'center',
  },
  // 子模式 chip：描边样式；
  // 上下 padding 按「paddingBottom + 边框 ×2」配平，chip 内侧文字与主 tab 文字同一垂直中线。
  subTab: {
    paddingHorizontal: 6,
    paddingTop: 3 + BorderWidths.normal * 2,
    paddingBottom: 3,
    borderWidth: BorderWidths.normal,
  },
})
