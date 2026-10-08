import { memo, useMemo } from 'react'
import { View } from 'react-native'
import { useLayout, useHorizontalMode } from '@/utils/hooks'
import { scaleSizeW } from '@/utils/pixelRatio'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'
import type { ListInfoItem } from '@/store/songlist/state'
import SectionHeader from '@/components/common/SectionHeader'
import PlaylistCard from './PlaylistCard'

interface PlaylistGridProps {
  title: string
  data: ListInfoItem[]
  onPressItem: (item: ListInfoItem) => void
}

// 列宽基准与「歌单」页 List.tsx:18-20 完全同源（最小列宽 110/横屏 150、GAP 20、
// 列数上限 10），保证两处网格观感一致。
const MIN_WIDTH_PORTRAIT = scaleSizeW(110)
const MIN_WIDTH_LANDSCAPE = scaleSizeW(150)
const GAP = scaleSizeW(20)
const PADDING = scaleSizeW(designSpacing.lg)
const ROW_GAP = scaleSizeW(designSpacing.md)
const MAX_COLUMNS = 10

const styles = createStyle({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: designSpacing.lg,
    // 注意：columnGap/rowGap 不在 createStyle 的尺寸换算白名单里（tools.ts 只认 gap），
    // 这里必须传已换算好的值（GAP / ROW_GAP），不要再套 designSpacing 原值。
    columnGap: GAP,
    rowGap: ROW_GAP,
  },
})

const PlaylistGrid = memo(({ title, data, onPressItem }: PlaylistGridProps) => {
  const { onLayout, width } = useLayout()
  // 横屏判定与歌单页同口径（宽高比 > 1.2 时用更大的最小列宽）
  const isHorizontal = useHorizontalMode()

  const rowInfo = useMemo(() => {
    // 必须用 useLayout 实测宽度：iPad 横屏时推荐页被 LandscapeCentered 限宽居中，
    // winWidth 是整屏宽，用它算列数会多出一列、卡片越界。
    if (width <= 0) return { num: 2, cardWidth: 0 }
    const available = width - PADDING * 2
    // 极端窄容器直接不渲染，避免算出 0/负列宽
    if (available < MIN_WIDTH_PORTRAIT * 2 + GAP) return { num: 2, cardWidth: 0 }
    const minWidth = isHorizontal ? MIN_WIDTH_LANDSCAPE : MIN_WIDTH_PORTRAIT
    // 列数公式与歌单页 List.tsx:128-142 一致；available 的扣减对象不同：
    // 歌单页扣的是它 FlatList 自带的左右 10pt，本网格扣自己的左右 padding（PADDING）。
    let n = available / (minWidth + GAP)
    if (n > MAX_COLUMNS) n = MAX_COLUMNS
    const computedItemWidth = Math.floor((available - GAP) / n)
    const num = Math.max(Math.floor(available / computedItemWidth), 2)
    // 卡片宽度按「num 列 + (num-1) 个 GAP 恰好铺满 available」等分。
    // 歌单页的槽位 slot=(available-GAP)/num 是把间隙做进卡片内部 margin 的写法
    // （真实卡宽 slot-15）；若照抄 slot 再叠加 columnGap，整行会多出 (num-2)*GAP，
    // 第 num 张被 flexWrap 折到下一行。等分后卡宽与歌单页实测同量级
    // （iPhone 竖屏 3 列：约 98 vs 歌单页 98.8，可见列距 18 vs 18）。
    // 向下取整防浮点误差触发折行。
    const cardWidth = Math.floor((available - GAP * (num - 1)) / num)
    return { num, cardWidth }
  }, [width, isHorizontal])

  return (
    <View onLayout={onLayout}>
      <SectionHeader title={title} />
      {rowInfo.cardWidth > 0 ? (
        <View style={styles.grid}>
          {data.map((item) => (
            <PlaylistCard
              key={`${item.source}-${item.id}`}
              item={item}
              width={rowInfo.cardWidth}
              onPress={onPressItem}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
})
PlaylistGrid.displayName = 'HomePlaylistGrid'
export default PlaylistGrid
