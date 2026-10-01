/**
 * QQ音乐歌单列表项 - 复刻网易云"我的歌单"列表项
 */

import { memo, useRef } from 'react'
import { View, TouchableOpacity, StyleSheet } from 'react-native'
import Image from '@/components/common/Image'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { Icon } from '@/components/common/Icon'
import type { Position } from '@/components/common/Menu'
import { scaleSizeH } from '@/utils/pixelRatio'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { designRadius, designSpacing } from '@/theme/DesignTokens'

interface PlaylistItem {
  id: string
  name: string
  cover: string
  songCount: number
  desc?: string
  isFavorites?: boolean
  isCollected?: boolean
  dirid?: number
}

interface ListItemProps {
  item: PlaylistItem
  onPress: (item: PlaylistItem) => void
  onMenuPress: (item: PlaylistItem, position: Position) => void
}

export default memo(({ item, onPress, onMenuPress }: ListItemProps) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  const menuBtnRef = useRef<TouchableOpacity>(null)

  const handleMenuPress = () => {
    menuBtnRef.current?.measure((fx, fy, width, height, px, py) => {
      const position = { x: Math.ceil(px), y: Math.ceil(py), w: Math.ceil(width), h: Math.ceil(height) }
      onMenuPress(item, position)
    })
  }

  const showMenu = !item.isFavorites && !item.isCollected

  // 整行是可点列表行：底色随「按钮透明度」淡出。只改颜色 alpha，不用容器 style.opacity——否则文字图标会一起变淡。
  return (
    <TouchableOpacity
      style={[styles.container, { backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-300'], buttonOpacity) }]}
      onPress={() => { onPress(item) }}
    >
      <View style={styles.coverContainer}>
        <Image
          url={item.cover}
          style={[
            styles.cover,
            // 歌单封面圆角随「按钮圆角」设置行内覆盖；高度取 styles.cover.height 源值 40
            { borderRadius: buttonRadius(40) },
          ]}
        />
        {item.isFavorites && (
          <View
            style={[
              styles.favoritesOverlay,
              // 收藏遮罩必须与它覆盖的封面同源：同一高度 40 一起变，避免设置后遮罩直角切掉封面圆角
              { borderRadius: buttonRadius(40) },
            ]}
          >
            <Icon name="love-filled" color="white" size={20} />
          </View>
        )}
      </View>

      <View style={styles.info}>
        <Text size={16} numberOfLines={2} color={theme['c-font']} style={{ fontWeight: '700' }}>{item.name}</Text>
        {item.songCount > 0 ? (
          <Text size={12} color={theme['c-font-label']} style={{ marginTop: 4 }}>
            {item.songCount} 首
          </Text>
        ) : null}
      </View>

      {showMenu && (
        <TouchableOpacity
          ref={menuBtnRef}
          style={[
            styles.menuButton,
            // 图标按钮圆角随「按钮圆角」设置行内覆盖；可见高度 ≈ 30 = 图标 20 + 上下 padding 5×2
            { borderRadius: buttonRadius(30) },
          ]}
          onPress={(e) => {
            e.stopPropagation()
            handleMenuPress()
          }}
        >
          <Icon name="dots-vertical" color={theme['c-font-label']} size={20} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  )
})

const styles = StyleSheet.create({
  // 卡片行样式与「我的」tab 歌单卡片完全一致
  // 不可再设 width：卡片靠父容器 stretch 撑满，否则与 marginHorizontal 相加会溢出、右侧被裁切
  container: {
    height: scaleSizeH(64),
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: designSpacing.md,
    marginHorizontal: designSpacing.md,
    marginBottom: designSpacing.sm,
    borderRadius: designRadius.md,
    overflow: 'hidden',
  },
  coverContainer: {
    position: 'relative',
    marginRight: designSpacing.md,
  },
  cover: {
    width: 40,
    height: 40,
    borderRadius: designRadius.md,
  },
  favoritesOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: designRadius.md,
  },
  info: {
    flex: 1,
  },
  menuButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    justifyContent: 'center',
    alignItems: 'center',
  },
})
