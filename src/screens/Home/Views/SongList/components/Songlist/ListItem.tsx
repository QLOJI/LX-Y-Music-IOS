import { memo, useMemo } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { createStyle } from '@/utils/tools'
import { type ListInfoItem } from '@/store/songlist/state'
import Text from '@/components/common/Text'
import { scaleSizeW } from '@/utils/pixelRatio'
import { NAV_SHEAR_NATIVE_IDS } from '@/config/constant'
import { useTheme } from '@/store/theme/hook'
import Image from '@/components/common/Image'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { formatPlayCountText } from '@/utils'

const gap = scaleSizeW(15)

interface ListItemProps {
  item: ListInfoItem
  index: number
  showSource: boolean
  width: number
  onPress: (item: ListInfoItem, index: number) => void
}

export default memo(({
  item,
  index,
  width,
  showSource,
  onPress,
}: ListItemProps) => {
  const theme = useTheme()
  const itemWidth = width - gap
  const playCount = formatPlayCountText(item.play_count)

  const handlePress = () => {
    onPress(item, index)
  }

  const coverStyle = useMemo(
    () => StyleSheet.compose(styles.cover, {
      // 封面占位底色（封面图未加载时的占位）：封面占位不是按钮，
      // 不参与「按钮透明度」设置，只随主题色变化。
      backgroundColor: theme['c-primary-light-900-alpha-200'],
    }),
    [theme],
  )

  const titleStyle = useMemo(
    () => StyleSheet.compose(styles.title, {
      color: theme['c-font'],
    }),
    [theme],
  )

  return item.source ? (
    <Pressable style={[styles.card, { width: itemWidth, margin: gap / 2 }]} onPress={handlePress}>
      <View style={styles.coverWrapper}>
        <Image
          url={item.img}
          nativeID={`${NAV_SHEAR_NATIVE_IDS.songlistDetail_pic}_from_${item.id}`}
          style={coverStyle}
        />
        {showSource ? (
          <Text style={styles.sourceLabel} size={11} color="#FFFFFF">
            {item.source.toUpperCase()}
          </Text>
        ) : null}
        {playCount ? (
          <View style={styles.playCount}>
            <Text style={styles.playCountText} size={11} color="#FFFFFF" numberOfLines={1}>
              {playCount}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={titleStyle} size={designTypography.body} numberOfLines={2}>
        {item.name}
      </Text>
    </Pressable>
  ) : (
    <View style={{ ...styles.placeholder, width: itemWidth }} />
  )
})

const styles = createStyle({
  card: {
    borderRadius: designRadius.md,
    // 不能加 overflow: 'hidden'：圆角 + 裁剪会把紧贴卡片边缘的标题字形削掉半截
    // （封面自身的圆角裁剪由 cover 的 overflow: 'hidden' 负责）
    paddingBottom: 2,
  },
  coverWrapper: {
    position: 'relative',
  },
  cover: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: designRadius.md,
    overflow: 'hidden',
  },
  sourceLabel: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    // 水平内边距必须 ≥ 圆角半径（胶囊高度的一半），否则圆弧会削掉首尾字形；
    // 圆角背景无需裁剪内容，移除 overflow: 'hidden'。
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: designRadius.pill,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  playCount: {
    position: 'absolute',
    // 角标统一约定（与 PlaylistCard.tsx、SonglistDetail/index.tsx 逐字一致）：
    // 贴角 top/right 2（createStyle 会随全局字号缩放；2026-10-01 需求「数字位置再往
    // 右上角靠近一点」，4 → 2）、固定高 20、水平内边距 10 ≥ 半高，
    // 圆弧不会削到首尾字形；居中交给 View 的 alignItems/justifyContent。
    top: 2,
    right: 2,
    height: 20,
    paddingHorizontal: 10,
    borderRadius: designRadius.pill,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCountText: {
    textAlign: 'center',
  },
  title: {
    marginTop: designSpacing.sm,
    fontWeight: '600',
    // 按 A-6「所有界面文字间距收敛」的全局约定 ≈1.2×字号收口（原为 1.3×）；
    // 比例现已由 DesignTokens.lineHeightRatio 提供，引全局令牌，之后一处调优全局生效
    lineHeight: designTypography.body * designTypography.lineHeightRatio,
  },
  placeholder: {
    margin: gap / 2,
  },
})
