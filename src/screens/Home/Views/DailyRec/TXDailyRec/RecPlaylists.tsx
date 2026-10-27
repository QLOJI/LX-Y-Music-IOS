import { memo, useEffect, useRef, useState, useCallback } from 'react'
import { RefreshControl, View, FlatList, TouchableOpacity } from 'react-native'
import Image from '@/components/common/Image'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useHorizontalMode } from '@/utils/hooks'
import { createStyle, toast } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import { retryAsync } from '@/utils/retry'
import { useI18n } from '@/lang'
import txApi from '@/utils/musicSdk/tx'
import { type ListInfoItem } from '@/store/songlist/state'
import { useBottomOverlayInset } from '@/store/common/hook'
import { useHomePageVisible } from '@/store/common/pageVisibility'
import { refreshCoverCaches } from '@/core/music/coverUrl'

interface PlaylistInfo {
  id: number
  title: string
  picurl: string
  songnum: number
  listennum: number
  creator_nick: string
}

interface Props {
  onOpenDetail: (playlistInfo: ListInfoItem) => void
  /** 当前 tab：每次切到本 tab 都清空列表并自动下拉刷新。 */
  active?: boolean
}

const ListItem = ({ item, onPress }: { item: PlaylistInfo, onPress: () => void }) => {
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  return (
    <TouchableOpacity style={styles.item} onPress={onPress}>
      <Image
        url={item.picurl}
        style={[
          styles.cover,
          // 歌单封面圆角随「按钮圆角」设置行内覆盖；高度取 styles.cover.height 源值 60
          { borderRadius: buttonRadius(60) },
        ]}
      />
      <View style={styles.info}>
        <Text style={styles.title} color={theme['c-font']} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.subtitle} color={theme['c-font-label']} size={12}>
          {item.songnum}首歌 · {item.creator_nick}
        </Text>
      </View>
    </TouchableOpacity>
  )
}

export default memo(({ onOpenDetail, active = true }: Props) => {
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([])
  const [loading, setLoading] = useState(false)
  // 每次切换/进入都走下拉刷新；loading 只作为历史空态闸门的复位位保留。
  const [refreshing, setRefreshing] = useState(false)
  // 失败原因（'' = 没失败）。空列表时用它区分「真的没有歌单」与「请求失败」，
  // 并给用户重试入口（②-5：原先失败只有一次 toast，FlatList 又没有 ListEmptyComponent，
  // 失败后除非重新挂载组件 effect 不会重跑，用户没有任何恢复路径）
  const [loadError, setLoadError] = useState('')
  const theme = useTheme()
  const isHorizontal = useHorizontalMode()
  const t = useI18n()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const buttonRadius = useButtonRadius()
  // 只认最后一次发起的加载：连续重试 / 下拉刷新重叠时丢弃过期响应，避免旧结果覆盖新结果
  const loadIdRef = useRef(0)
  // 已加载闸门：非强制刷新才被挡住；切 tab / 进入页一律传 refresh=true。
  const loadedRef = useRef(false)
  // 离屏 Home 页重新进入时也刷新当前 tab（pageVisible false→true 的上升沿）。
  const pageVisible = useHomePageVisible()
  const [enterSeq, setEnterSeq] = useState(0)
  const prevPageVisibleRef = useRef(pageVisible)
  useEffect(() => {
    if (pageVisible && !prevPageVisibleRef.current) setEnterSeq(v => v + 1)
    prevPageVisibleRef.current = pageVisible
  }, [pageVisible])

  const loadPlaylists = useCallback(async(refresh = false) => {
    if (!refresh && loadedRef.current) return
    const loadId = ++loadIdRef.current
    setRefreshing(true)
    setLoadError('')
    refreshCoverCaches()
    try {
      // 有界重试（2 次，800/2000ms）：冷启动首个请求要跟「网络栈就绪 / Cookie 落盘 /
      // 平台偶发 5xx」抢时间，一次失败就定格成空白页。shouldRetry 兜住「等待期间
      // 又发起了一次加载」——被取代后不再补发请求，那次错误由 catch 按 loadId 丢弃。
      const result = await retryAsync(() => txApi.dailyRec.getRecommendSonglist(), {
        shouldRetry: () => loadId === loadIdRef.current,
      })
      if (loadId !== loadIdRef.current) return
      if (result?.songlists) {
        if (result.songlists.length) loadedRef.current = true
        setPlaylists(result.songlists)
      }
    } catch (error: any) {
      if (loadId !== loadIdRef.current) return
      setLoadError(error?.message || '')
      toast(t('load_failed'), 'long')
    } finally {
      if (loadId === loadIdRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [t])

  // 每次切到本 tab / 重新进入本页：先清空，立即下拉刷新。
  useEffect(() => {
    if (!active) return
    setPlaylists([])
    setLoadError('')
    void loadPlaylists(true)
  }, [active, enterSeq, loadPlaylists])

  const handleItemPress = (playlistInfo: PlaylistInfo) => {
    const listInfo = {
      id: String(playlistInfo.id),
      name: playlistInfo.title,
      img: playlistInfo.picurl,
      songCount: playlistInfo.songnum,
      playCount: playlistInfo.listennum,
      source: 'tx',
      author: playlistInfo.creator_nick,
    } as ListInfoItem
    onOpenDetail(listInfo)
  }

  const handleRefresh = () => {
    void loadPlaylists(true)
  }

  // 空列表渲染：只有这里能区分「加载中 / 加载失败 / 真的没有歌单」，
  // 并为失败提供「重新加载」入口（旧写法整块交给 FlatList 空数据默认渲染，什么都没有）
  const renderEmpty = () => {
    if (refreshing && playlists.length === 0) return null
    return (
      <View style={styles.empty}>
        <Text color={theme['c-font-label']}>{loadError ? t('list_error') : t('list_empty')}</Text>
        {loadError ? (
          <Text style={styles.emptyDetail} color={theme['c-font-label']} size={12}>{loadError}</Text>
        ) : null}
        <TouchableOpacity
          style={[
            styles.retry,
            // 「重新加载」文字按钮圆角随「按钮圆角」设置行内覆盖；可见高度 ≈ 17 = 单行 15 号文字行高 17（无纵向 padding）
            { borderRadius: buttonRadius(17) },
          ]}
          onPress={handleRefresh}
        >
          <Text color={theme['c-primary']}>{t('list_reload')}</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        onScrollBeginDrag={() => {}}
        data={playlists}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        key={isHorizontal ? 'horizontal' : 'vertical'}
        numColumns={isHorizontal ? 2 : 1}
        columnWrapperStyle={isHorizontal ? styles.columnWrapper : undefined}
        renderItem={({ item }) => (
          <View style={isHorizontal ? styles.itemWrapper : null}>
            <ListItem item={item} onPress={() => { handleItemPress(item) }} />
          </View>
        )}
        keyExtractor={(item) => String(item.id)}
        ListEmptyComponent={renderEmpty()}
        refreshControl={
          // 只认用户下拉（见 refreshing 状态注释）
          <RefreshControl colors={[theme['c-primary']]} refreshing={refreshing} onRefresh={handleRefresh} />
        }
      />
    </View>
  )
})

const styles = createStyle({
  columnWrapper: {
    paddingHorizontal: 8,
  },
  itemWrapper: {
    flex: 1,
    maxWidth: '50%',
  },
  item: {
    flexDirection: 'row',
    padding: 15,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
  },
  cover: {
    width: 60,
    height: 60,
    // 歌单封面：对齐 REF 的封面圆角（4），与 designRadius.md 同值
    borderRadius: 4,
  },
  info: {
    flex: 1,
    marginLeft: 12,
    justifyContent: 'center',
  },
  title: {
    fontSize: 15,
    fontWeight: '500',
  },
  subtitle: {
    marginTop: 4,
  },
  empty: {
    paddingTop: 60,
    alignItems: 'center',
  },
  emptyDetail: {
    marginTop: 6,
    opacity: 0.7,
  },
  retry: {
    marginTop: 12,
  },
})
