import { useRef, useState, useMemo, useCallback, forwardRef, useImperativeHandle, type ReactElement } from 'react'
import { FlatList, View, type FlatListProps, Keyboard, useWindowDimensions } from 'react-native'
import usePullRefresh from '@/components/common/usePullRefresh'

import ListItem from './ListItem'
// import { navigations } from '@/navigation'
import { type ListInfoItem } from '@/store/songlist/state'
import { useLayout, useHorizontalMode } from '@/utils/hooks'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { scaleSizeW } from '@/utils/pixelRatio'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { useBottomOverlayInset, useStatusbarHeight } from '@/store/common/hook'
import { designSpacing } from '@/theme/DesignTokens'

type FlatListType = FlatListProps<ListInfoItem>

// const MAX_WIDTH = scaleSizeW(110)
const MIN_WIDTH_PORTRAIT = scaleSizeW(110)
const MIN_WIDTH_LANDSCAPE = scaleSizeW(150)
const GAP = scaleSizeW(20)
// 网格行左右内边距（见下方 columnWrapperStyle）：让第一列卡片的**左缘**正好落在
// designSpacing.lg = 24pt —— 与页面大标题、平台/排序/标签胶囊、以及推荐页
// 「推荐歌单」网格（PlaylistGrid 的 paddingHorizontal: lg、卡片无外边距）同一条左基准线，
// 满足用户第 1 条「推荐界面和歌单界面…要左对齐」。
// 卡片自带 margin: gap/2（ListItem.tsx 的 gap = scaleSizeW(15)），所以行内边距要取
// 24 − gap/2 = 16.5 抵消它。两处常量必须同源同值：改 ListItem 的 gap 就要同步改这里。
// 这是裸值（内联在 columnWrapperStyle 上，不过 createStyle 的 scaleSizeW），
// 与 width 的推导口径一致。
const ROW_INSET = 24 - scaleSizeW(15) / 2

export interface ListProps {
  header?: ReactElement
  onRefresh: () => void
  onLoadMore: () => void
  onOpenDetail: (item: ListInfoItem, index: number) => void
}
export type Status = 'loading' | 'refreshing' | 'end' | 'error' | 'idle' | 'empty'

export interface ListType {
  setList: (list: ListInfoItem[], showSource?: boolean) => void
  setStatus: (val: Status) => void
}

export default forwardRef<ListType, ListProps>(({ header, onRefresh, onLoadMore, onOpenDetail }, ref) => {
  const flatListRef = useRef<FlatList>(null)
  const [currentList, setList] = useState<ListInfoItem[]>([])
  const [showSource, setShowSource] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const { onLayout, width } = useLayout()
  // 首帧宽度兜底（2026-10-02 用户第 3 条）：本组件此前首帧 `width == 0 ? null`，
  // 把**整块 ListHeaderComponent**（搜索页的搜索框 / 平台胶囊 / 歌曲·歌单·歌手·专辑
  // 按钮行）连同列表一起从树里摘掉一帧 —— 点「歌单」tab 时就是「整条头部消失一帧
  // 再出现」，观感即「瞬间闪烁刷新」。对照：歌曲 tab 的 OnlineList、歌手/专辑 tab 的
  // SearchResultList 都无条件首帧渲染 FlatList，头部从不消失，所以只有歌单闪。
  // 兜底值取窗口宽：本组件的容器（页内容区）是满宽（Search/index.tsx 的 container
  // `width:'100%'`、SongList 主页同构），onLayout 量到的就是这个宽度，因此首帧与
  // 量到后**列数一致**，FlatList 的 key（rowInfo.num）不会变、不会二次重挂。
  const { width: windowWidth } = useWindowDimensions()
  const effectiveWidth = width > 0 ? width : windowWidth
  const theme = useTheme()
  // console.log('render songlist')

  useImperativeHandle(ref, () => ({
    setList(list, showSource = false) {
      // rawListRef.current = list
      setList(list)
      setShowSource(showSource)
    },
    setStatus(val) {
      setStatus(val)
    },
  }))

  const handleLoadMore = () => {
    if (status != 'idle') return
    onLoadMore()
  }

  const renderItem: FlatListType['renderItem'] = ({ item, index }) => (
    <ListItem
      item={item}
      index={index}
      width={rowInfo.width}
      showSource={showSource}
      onPress={onOpenDetail}
    />
  )
  const getkey: FlatListType['keyExtractor'] = (item) => item.id
  // const getItemLayout: FlatListType['getItemLayout'] = (data, index) => {
  //   return { length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index }
  // }
  const handlePullRefresh = useCallback(() => {
    onRefresh()
  }, [onRefresh])
  const { indicator: pullIndicator, scrollProps: pullScrollProps } = usePullRefresh(
    status == 'refreshing',
    handlePullRefresh,
    flatListRef,
    0,
    false,
    // 与「我的」页完全相同的方案：绝对定位在下对齐区，圆圈贴在标题正上方。
    // top 用固定值（与「我的」页在刘海机上实测一致）：本页可能在状态栏测量前就挂载，
    // 依赖 hook 的值会拿到 6，圆圈就贴到屏幕顶端。
    { top: 55, height: headerTopGap },
  )
  const footerComponent = useMemo(() => {
    let label: FooterLabel
    switch (status) {
      case 'refreshing':
        return null
      case 'loading':
        label = 'list_loading'
        break
      case 'end':
        label = 'list_end'
        break
      case 'error':
        label = 'list_error'
        break
      case 'idle':
        label = null
        break
      case 'empty':
        label = 'list_empty'
        break
    }
    return (
      <View style={{ width: '100%' }}>
        <Footer label={label} onLoadMore={onLoadMore} />
      </View>
    )
  }, [onLoadMore, status])

  const isHorizontal = useHorizontalMode()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  // 顶部状态栏高度：关掉 iOS 自动安全区 inset 后，由这里显式补回，
  // 位置与推荐页（自动 inset + paddingTop）严格一致，且不受刷新影响。
  // 本页可能在 pager 预加载阶段挂载（早于状态栏测量，hook 拿到 0 且不会再更新），
  // 用 60 兜底，保证圆圈不会贴到屏幕最顶部。
  const statusBarRaw = useStatusbarHeight()
  const statusBarHeight = statusBarRaw > 20 ? statusBarRaw : 60
  // 标题上方留给圆圈的空白高度（与「我的」页 PageTopInset 同源公式）。
  const headerTopGap = Math.max(designSpacing.sm, statusBarHeight - designSpacing.md)

  const rowInfo = useMemo(() => {
    // 网格行左右各 ROW_INSET 内边距（见下方 columnWrapperStyle.paddingHorizontal），
    // 列宽必须按扣除后的可用宽度计算，否则每列比实际槽位宽，相邻列会盖住标题末尾的字。
    // 注意这些不是「FlatList 框架自带」——它们来自我们自己写的那对 padding，改一处必须改两处。
    const available = effectiveWidth - ROW_INSET * 2
    const minWidth = isHorizontal ? MIN_WIDTH_LANDSCAPE : MIN_WIDTH_PORTRAIT
    let w = available - GAP
    let n = available / (minWidth + GAP)
    if (n > 10) n = 10
    let computedItemWidth = Math.floor(w / n)
    const num = Math.max(Math.floor(available / computedItemWidth), 2)
    return {
      num,
      width: (available - GAP) / num,
    }
  }, [effectiveWidth, isHorizontal])
  // console.log(rowNum)
  const list = useMemo(() => {
    const list = [...currentList]
    let whiteItemNum = list.length % rowInfo.num
    if (whiteItemNum > 0) whiteItemNum = rowInfo.num - whiteItemNum
    for (let i = 0; i < whiteItemNum; i++) {
      list.push({
        id: `white__${i}`,
        play_count: '',
        author: '',
        name: '',
        img: '',
        desc: '',
        // @ts-expect-error
        source: '',
      })
    }
    return list
  }, [currentList, rowInfo])
  // console.log(listInfo.list.map((item) => item.id))

  return (
    <View style={styles.container} onLayout={onLayout}>
      {/* 与「我的」页同构：圆圈是列表外层的绝对定位覆盖层，不参与列表布局，
          也就不会在刷新收尾时把内容顶一下。 */}
      {pullIndicator}
      {/* 不再用 `width == 0 ? null` 门控（2026-10-02 用户第 3 条）：那会把头部一起
          摘掉一帧。宽度由 effectiveWidth 兜底，rowInfo 首帧即可用。
          本页无停留位（holdSpace=false），不需要外层的 transform 包裹：那一层在惯性
          滚动时会让内容多走一次合成，是「松手上跳」的来源之一。 */}
      <FlatList
        {...pullScrollProps}
        key={String(rowInfo.num)}
        ref={flatListRef}
        // 顶部间距显式由「页头 paddingTop = 状态栏高度」提供：关掉 iOS 自动安全区
        // inset 后滚动范围恒从 0 开始，静止位固定为 0 —— 刷新前后、拉多少次都不会
        // 漂移或贴顶。视觉高度 = 状态栏 + 页头自身间距，与推荐页一致。
        style={styles.list}
        contentInsetAdjustmentBehavior="never"
        // 左右内边距写在**每一行**上，不再写在外层 style（2026-10-02 统一搜索页四个 tab 的
        // 排列）：写在 style 上时整条列表一起内缩，连 ListHeaderComponent（搜索框、搜索平台、
        // 酷我等、歌曲/歌单/歌手/专辑按钮行）也被推进去 10pt —— 与「歌曲」tab 的 OnlineList
        // （内边距 0）、歌手/专辑 tab 的 SearchResultList（内边距 0）对不齐，切换 tab 时
        // 搜索框和整排按钮会左右跳一下。挪到 columnWrapperStyle 后：头部回到 0 内边距，
        // 网格行的可用宽度仍是 width-2*ROW_INSET（与 rowInfo 的 available 严格对应）。
        //
        // 2026-10-02（用户第 1 条「左对齐」）：该内边距由 10 改为 ROW_INSET，
        // 使第一列卡片左缘 = ROW_INSET + gap/2 = 24pt，与页面标题/胶囊行同左基准线
        // （改前是 17.5pt，比标题右缩 6.5pt）。列宽公式同步用 ROW_INSET*2 扣减。
        columnWrapperStyle={{ justifyContent: 'space-evenly', paddingHorizontal: ROW_INSET }}
        numColumns={rowInfo.num}
        data={list}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        maxToRenderPerBatch={4}
        onScrollBeginDrag={(e) => {
          Keyboard.dismiss()
          pullScrollProps.onScrollBeginDrag?.(e)
        }}
        // updateCellsBatchingPeriod={80}
        windowSize={8}
        // removeClippedSubviews 会按估算行高错误地裁剪变高网格行，
        // 表现为封面下方标题的首尾字符随机缺失/半截，必须关闭
        removeClippedSubviews={false}
        // initialNumToRender={12}
        renderItem={renderItem}
        ListHeaderComponent={(
          <View style={{ paddingTop: statusBarHeight }}>
            {header}
          </View>
        )}
        keyExtractor={getkey}
        // getItemLayout={getItemLayout}
        // onRefresh={onRefresh}
        // refreshing={refreshing}
        onEndReachedThreshold={0.6}
        onEndReached={handleLoadMore}
        showsVerticalScrollIndicator={false}
        delaysContentTouches={false}
        ListFooterComponent={footerComponent}
      />
    </View>
  )
})

type FooterLabel = 'list_loading' | 'list_end' | 'list_error' | 'list_empty' | null
const Footer = ({ label, onLoadMore }: { label: FooterLabel, onLoadMore: () => void }) => {
  const theme = useTheme()
  const t = useI18n()
  const handlePress = () => {
    if (label != 'list_error') return
    onLoadMore()
  }
  return label ? (
    <View>
      <Text onPress={handlePress} style={styles.footer} color={theme['c-font-label']}>
        {t(label)}
      </Text>
    </View>
  ) : null
}

const styles = createStyle({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  list: {
    flex: 1,
    // 左右 10pt 内边距不在这里：它已挪到 columnWrapperStyle，只作用在网格行上，
    // 头部（排序/标签行、搜索页的搜索框与按钮行）才能与其他 tab 一样顶到 0。
  },
  footer: {
    textAlign: 'center',
    padding: 10,
  },
})
