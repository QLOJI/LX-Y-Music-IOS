import { memo, useMemo } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { formatPlayCountText } from '@/utils'
import { useButtonRadius } from '@/utils/buttonRadius'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { NAV_SHEAR_NATIVE_IDS } from '@/config/constant'
import type { ListInfoItem } from '@/store/songlist/state'
import Image from '@/components/common/Image'
import Text from '@/components/common/Text'

interface PlaylistCardProps {
  item: ListInfoItem
  width: number
  onPress: (item: ListInfoItem) => void
}

const styles = createStyle({
  cover: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: designRadius.md,
    overflow: 'hidden',
  },
  playCount: {
    position: 'absolute',
    // 角标统一约定（与 Songlist/ListItem.tsx、SonglistDetail/index.tsx 逐字一致）：
    // 贴角 top/right 2（createStyle 会随全局字号缩放；2026-10-01 需求「数字位置再往
    // 右上角靠近一点」，4 → 2）、固定高 20、水平内边距 10 ≥ 半高，
    // 圆弧不会削到首尾字形；居中交给 View 的 alignItems/justifyContent。
    top: 2,
    right: 2,
    height: 20,
    paddingHorizontal: 10,
    borderRadius: designRadius.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCountText: {
    textAlign: 'center',
  },
  title: {
    // 原写法是 designRadius.sm —— 属于误把圆角令牌当间距用，且圆角整体下调后
    // 它会跟着缩到 6；这里改用间距令牌，并与歌单页 ListItem 的标题间距保持一致。
    marginTop: designSpacing.sm,
    fontWeight: '600',
  },
})

const PlaylistCard = memo(({ item, width, onPress }: PlaylistCardProps) => {
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  const playCount = formatPlayCountText(item.play_count)

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

  return (
    <Pressable style={{ width }} onPress={() => { onPress(item) }}>
      <View>
        <Image
          style={[
            coverStyle,
            // 封面圆角随「按钮圆角」设置行内覆盖；封面为正方形（aspectRatio: 1），自身高度 = 传入的 width（布局值）
            { borderRadius: buttonRadius(width) },
          ]}
          url={item.img}
          nativeID={`${NAV_SHEAR_NATIVE_IDS.songlistDetail_pic}_from_${item.id}`}
        />
        {playCount ? (
          <View style={styles.playCount}>
            <Text style={styles.playCountText} size={11} color="#FFFFFF" numberOfLines={1}>{playCount}</Text>
          </View>
        ) : null}
      </View>
      <Text style={titleStyle} size={designTypography.body} numberOfLines={2}>
        {item.name}
      </Text>
    </Pressable>
  )
})
PlaylistCard.displayName = 'HomePlaylistCard'
export default PlaylistCard
