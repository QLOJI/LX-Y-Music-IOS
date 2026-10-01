import { memo } from 'react'
import { View, TouchableOpacity } from 'react-native'
import Image from '@/components/common/Image'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import { navigations } from '@/navigation'
import { Icon } from '@/components/common/Icon'
import { useIsWyAlbumSubscribed } from '@/store/user/hook'
import wyApi from '@/utils/musicSdk/wy/user'
import { addWySubscribedAlbum, removeWySubscribedAlbum } from '@/store/user/action'
import { type SubscribedAlbumInfo } from '@/store/user/state'

export default memo(({ componentId, item, width, viewMode }: { componentId: string, item: any, width: number, viewMode: 'grid' | 'list' }) => {
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  const isSubscribed = useIsWyAlbumSubscribed(item.id)

  const handlePress = () => {
    const author = item.artist?.name || item.artistName || ''
    const source = item.source || 'wy'
    const albumId = source === 'tx' ? (item.mid || item.id) : item.id

    const albumInfo = {
      id: albumId,
      mid: item.mid || item.id,
      name: item.name,
      author,
      img: item.picUrl,
      play_count: '',
      desc: item.briefDesc,
      source,
      artists: item.artists,
      picUrl: item.picUrl,
      size: item.size,
      publishTime: item.publishTime,
    }
    navigations.pushAlbumDetailScreen(componentId, albumInfo)
  }

  const toggleSubscribe = (event: any) => {
    event.stopPropagation()
    if (!item.id) return
    const newSubState = !isSubscribed
    wyApi.subAlbum(String(item.id), newSubState).then(() => {
      toast(newSubState ? '收藏成功' : '取消收藏成功')
      if (newSubState) {
        const albumInfoForStore: SubscribedAlbumInfo = {
          id: item.id,
          name: item.name,
          picUrl: item.picUrl,
          artists: item.artists,
          publishTime: item.publishTime,
          size: item.size,
        }
        addWySubscribedAlbum(albumInfoForStore)
      } else {
        removeWySubscribedAlbum(item.id)
      }
    }).catch((err: any) => {
      toast(`操作失败: ${err.message}，可能是Cookie已失效，请重新登录`)
    })
  }

  if (viewMode === 'list') {
    return (
      <TouchableOpacity style={[listStyles.container, { width }]} onPress={handlePress}>
        <Image url={item.picUrl} style={[listStyles.artwork, { borderRadius: buttonRadius(60) /* 专辑封面 60×60：按封面自身高度 60 折算半高 */ }]} />
        <View style={listStyles.info}>
          <Text style={listStyles.name} numberOfLines={1}>{item.name}</Text>
          <Text style={listStyles.time} size={12} color={theme['c-font-label']}>
            {item.size} 首
          </Text>
        </View>
        {item.source === 'wy' && (
          <TouchableOpacity style={[listStyles.likeButton, { borderRadius: buttonRadius(18) /* 列表态图标按钮：listStyles.likeButton 只有 paddingHorizontal:25、没有纵向 padding，可见高就是图标本身 18。旧值 28 抄的是 gridStyles.likeButton（padding:5，上下各 5）那一份，多算了 10（≈55%），中间档位半径会明显偏大 */ }]} onPress={toggleSubscribe}>
            <Icon name={isSubscribed ? 'love-filled' : 'love'} color={isSubscribed ? theme['c-liked'] : theme['c-font-label']} size={18} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    )
  }

  return (
    <TouchableOpacity style={{ ...gridStyles.container, width }} onPress={handlePress}>
      <Image
        url={item.picUrl}
        style={{
          ...gridStyles.artwork,
          width,
          height: width,
          // 专辑封面高度 = 网格算出的 width：按封面自身高度折算半高，行内覆盖「按钮圆角」
          borderRadius: buttonRadius(width),
        }}
      />
      <Text style={gridStyles.name} numberOfLines={1}>{item.name}</Text>
      <View style={gridStyles.metaContainer}>
        <View style={gridStyles.metaTextContainer}>
          <Text style={gridStyles.time} size={10} color={theme['c-font-label']}>
            {item.size} 首
          </Text>
        </View>
        {item.source === 'wy' && (
          <TouchableOpacity style={[gridStyles.likeButton, { borderRadius: buttonRadius(28) /* 同列表态：图标 18 + 上下 padding 5×2 = 28 */ }]} onPress={toggleSubscribe}>
            <Icon name={isSubscribed ? 'love-filled' : 'love'} color={isSubscribed ? theme['c-liked'] : theme['c-font-label']} size={18} />
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  )
})

const gridStyles = createStyle({
  container: {
    marginBottom: 16,
  },
  artwork: {
    // 专辑封面：对齐 REF 的封面圆角（4），与 designRadius.md 同值
    borderRadius: 4,
    marginBottom: 8,
  },
  name: {
    fontSize: 12,
  },
  metaContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  metaTextContainer: {
    flexDirection: 'column',
  },
  time: {},
  trackCount: {
    marginTop: 2,
  },
  likeButton: {
    padding: 5,
  },
})

const listStyles = createStyle({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 0,
  },
  artwork: {
    width: 60,
    height: 60,
    // 专辑封面：对齐 REF 的封面圆角（4），与 designRadius.md 同值
    borderRadius: 4,
  },
  info: {
    flex: 1,
    marginLeft: 15,
    justifyContent: 'center',
  },
  name: {
    fontSize: 15,
    marginBottom: 5,
  },
  time: {},
  likeButton: {
    paddingHorizontal: 25,
  },
})
