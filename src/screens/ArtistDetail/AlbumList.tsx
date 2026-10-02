import { memo, useMemo, useState, useEffect, useCallback } from 'react'
import { FlatList, View, RefreshControl } from 'react-native'
import AlbumListItem from './AlbumListItem'
import { useHorizontalMode, useLayout } from '@/utils/hooks'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { scaleSizeW } from '@/utils/pixelRatio'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useBottomOverlayInset } from '@/store/common/hook'

const MIN_WIDTH = scaleSizeW(120)
const HORIZONTAL_SPACING = 24

interface AlbumListProps {
  componentId: string
  albums: any[]
  loading: boolean
  hasMore: boolean
  onLoadMore: () => void
  onRefresh: () => void
  ListHeaderComponent?: React.ComponentType<any> | React.ReactElement | null
  viewMode: 'grid' | 'list'
}

export default memo(({ componentId, albums, loading, hasMore, onLoadMore, onRefresh, ListHeaderComponent, viewMode }: AlbumListProps) => {
  const { onLayout, width } = useLayout()
  const theme = useTheme()
  const t = useI18n()
  const isHorizontal = useHorizontalMode()
  // 底部悬浮层（迷你播放器 + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  // 下拉刷新动画只认「用户真的下拉过」（用户第 16 轮第 7 条）。
  // 旧判据 refreshing={loading && albums.length === 0}：切到「所有专辑」tab 首次加载时
  // albums 为空、loading 为 true，iOS 刷新控件当场激活——内容被压下去再弹回来（「向上刷新」）。
  // 现在 refreshing 只在用户下拉的那一刻置位，等这次加载（loading true→false）落地后清除；
  // 程序触发的加载（切 tab、缓存未命中）只会有 loading，永远不会点亮刷新控件。
  const [refreshing, setRefreshing] = useState(false)

  const handlePullRefresh = useCallback(() => {
    setRefreshing(true)
    onRefresh()
  }, [onRefresh])

  useEffect(() => {
    if (refreshing && !loading) setRefreshing(false)
  }, [refreshing, loading])

  const rowInfo = useMemo(() => {
    if (width === 0) return { num: 3, itemWidth: 0 }
    if (viewMode === 'list') {
      const num = isHorizontal ? 2 : 1
      const totalSpacing = HORIZONTAL_SPACING * (num - 1)
      const itemWidth = Math.floor((width - totalSpacing) / num)
      return { num, itemWidth }
    }
    const num = Math.max(Math.floor((width + HORIZONTAL_SPACING) / (MIN_WIDTH + HORIZONTAL_SPACING)), 3)
    const totalSpacing = HORIZONTAL_SPACING * (num - 1)
    const itemWidth = Math.floor((width - totalSpacing) / num)
    return { num, itemWidth }
  }, [width, viewMode, isHorizontal])

  const renderItem = ({ item }: { item: any }) => {
    if (item.id.toString().startsWith('white__')) {
      return <View style={{ width: rowInfo.itemWidth }} />
    }
    return <AlbumListItem componentId={componentId} item={item} width={rowInfo.itemWidth} viewMode={viewMode} />
  }

  const list = useMemo(() => {
    const list = [...albums]
    if (rowInfo.num <= 1) return list
    if (rowInfo.num === 0) return list // Avoid division by zero
    let whiteItemNum = list.length % rowInfo.num
    if (whiteItemNum > 0) whiteItemNum = rowInfo.num - whiteItemNum
    for (let i = 0; i < whiteItemNum; i++) {
      list.push({ id: `white__${i}` })
    }
    return list
  }, [albums, rowInfo.num])

  const ListFooterComponent = () => {
    let text = ''
    if (loading && albums.length > 0) text = t('list_loading')
    else if (!hasMore) text = t('list_end')
    return (
      <View style={styles.footer}>
        <Text color={theme['c-font-label']}>{text}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container} onLayout={onLayout}>
      {width > 0 && (
        <FlatList
          key={String(rowInfo.num) + viewMode}
          numColumns={rowInfo.num}
          data={list}
          // 底部内边距：让专辑列表能滚到屏幕底部，最后一行停下时让位给悬浮的迷你播放器。
          contentContainerStyle={{ paddingBottom: bottomInset }}
          renderItem={renderItem}
          keyExtractor={item => String(item.id)}
          onEndReached={onLoadMore}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={ListHeaderComponent}
          ListFooterComponent={ListFooterComponent}
          refreshControl={
            <RefreshControl
              colors={[theme['c-primary']]}
              // 只认用户下拉（见 refreshing 状态注释）
              refreshing={refreshing}
              onRefresh={handlePullRefresh}
            />
          }
          columnWrapperStyle={rowInfo.num > 1 ? styles.row : undefined}
        />
      )}
    </View>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
    paddingHorizontal: 8,
  },
  row: {
    justifyContent: 'space-between',
  },
  footer: {
    width: '100%',
    paddingVertical: 10,
    alignItems: 'center',
  },
})
