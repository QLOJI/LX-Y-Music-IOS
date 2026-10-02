import { memo, useEffect, useRef, useCallback, useState } from 'react'
import { View, FlatList, TouchableOpacity, Image, RefreshControl } from 'react-native'
import OnlineList, { type OnlineListType } from '@/components/OnlineList'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useHorizontalMode } from '@/utils/hooks'
import { createStyle, toast } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import { retryAsync } from '@/utils/retry'
import { useI18n } from '@/lang'
import txApi from '@/utils/musicSdk/tx'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { stageOnlineListToDefault } from '@/core/playListToDefault'
import { type ListInfoItem } from '@/store/songlist/state'
import { useBottomOverlayInset } from '@/store/common/hook'

type RecType = 'home' | 'radar' | 'newsong'

interface Props {
  type: RecType
  onOpenDetail?: (playlistInfo: ListInfoItem) => void
}

const handlePlay = async(list: LX.Music.MusicInfoOnline[], listId: string, index = 0) => {
  // QQ 每日推荐（雷达/新歌）整份写入试听列表(DEFAULT)，不再走临时列表（见 core/list.ts playOnlineList 的说明）
  await stageOnlineListToDefault(listId, [...list], index)
}

const PlaylistItem = ({ item, onPress }: { item: { id: string, name: string, cover: string, playCount: number }, onPress: () => void }) => {
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  return (
    <TouchableOpacity style={styles.item} onPress={onPress}>
      <Image
        source={{ uri: item.cover || 'https://y.gtimg.cn/mediastyle/y/img/cover_qzone_130.jpg' }}
        style={[
          styles.cover,
          // 歌单封面圆角随「按钮圆角」设置行内覆盖；高度取 styles.cover.height 源值 60
          { borderRadius: buttonRadius(60) },
        ]}
      />
      <View style={styles.info}>
        <Text style={styles.title} color={theme['c-font']} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.subtitle} color={theme['c-font-label']} size={12}>
          {item.playCount > 0 ? `${(item.playCount / 10000).toFixed(1)}万` : '推荐'}
        </Text>
      </View>
    </TouchableOpacity>
  )
}

export default memo(({ type, onOpenDetail }: Props) => {
  const listRef = useRef<OnlineListType>(null)
  const playerMusicInfo = usePlayerMusicInfo()
  const [playlists, setPlaylists] = useState<Array<{ id: string, name: string, cover: string, playCount: number }>>([])
  const [loading, setLoading] = useState(false)
  // 下拉刷新动画只认「用户真的下拉过」（用户第 16 轮第 7 条）：loading 只喂空列表占位，
  // 程序触发的加载不再激活 iOS 刷新控件（否则内容会被压下去再弹回来 = 向上刷新）。
  const [refreshing, setRefreshing] = useState(false)
  // 失败原因（'' = 没失败）：空列表时用它区分「真的没推荐」与「请求失败」，并给重试入口。
  // 与同目录 RecPlaylists / 网易 recPlaylists 同一套失败态（②-5：原先失败只有一次 toast，
  // FlatList 没有 ListEmptyComponent，失败后没有任何恢复路径）
  const [loadError, setLoadError] = useState('')
  const theme = useTheme()
  const isHorizontal = useHorizontalMode()
  const t = useI18n()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const buttonRadius = useButtonRadius()
  // 只认最后一次发起的加载：连续重试 / 下拉刷新重叠时丢弃过期响应
  const loadIdRef = useRef(0)
  // 「已经拿到过数据」的闸门。原判据读 playlists.length 且写在依赖里，加载成功会重建
  // 函数、把 effect 再触发一次空跑；换成 ref 后语义不变（有数据就不自动重发）但不自激
  const loadedRef = useRef(false)

  const loadPlaylists = useCallback(async(refresh = false) => {
    if (type !== 'home') return
    if (!refresh && loadedRef.current) return
    const loadId = ++loadIdRef.current
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setLoadError('')
    try {
      // 有界重试（2 次，800/2000ms）：冷启动首个请求容易输给「网络栈就绪 / 平台偶发 5xx」
      const result = await retryAsync(() => txApi.dailyRec.getHomeFeed(), {
        shouldRetry: () => loadId === loadIdRef.current,
      })
      if (loadId !== loadIdRef.current) return
      if (result?.list) {
        if (result.list.length) loadedRef.current = true
        setPlaylists(result.list.map((item: any) => ({
          id: String(item.id),
          name: item.name,
          cover: item.cover,
          playCount: item.playCount,
        })))
      }
    } catch (error: any) {
      if (loadId !== loadIdRef.current) return
      setLoadError(error?.message || '')
      toast('加载失败', 'long')
    } finally {
      if (loadId === loadIdRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [type])

  const fetchSongs = useCallback(async() => {
    try {
      let result: { list: LX.Music.MusicInfoOnline[] } | null = null

      switch (type) {
        case 'radar': {
          const radarResult = await txApi.dailyRec.getRadarRecommend()
          result = { list: radarResult.list }
          break
        }
        case 'newsong': {
          const newsongResult = await txApi.dailyRec.getRecommendNewsong()
          result = { list: newsongResult.list }
          break
        }
        default:
          return
      }

      if (result?.list) {
        listRef.current?.setList(result.list, false)
      }
    } catch (error) {
      console.error(`获取QQ${type === 'radar' ? '雷达推荐' : '推荐新歌'}失败:`, error)
      toast('加载失败', 'long')
      listRef.current?.setStatus('error')
    } finally {
      listRef.current?.setStatus('idle')
    }
  }, [type])

  useEffect(() => {
    if (type === 'home') {
      void loadPlaylists()
    } else {
      // 首载用 'loading'（列表内占位），不用 'refreshing' —— 后者会当场激活 iOS 刷新控件，
      // 把内容压下去再弹回来（用户第 16 轮第 7 条）。
      listRef.current?.setStatus('loading')
      void fetchSongs()
    }
  }, [type, loadPlaylists, fetchSongs])

  const handleRefresh = useCallback(() => {
    if (type === 'home') {
      void loadPlaylists(true)
    } else {
      // 用户下拉：这条路径才播下拉刷新动画
      listRef.current?.setStatus('refreshing')
      void fetchSongs()
    }
  }, [type, loadPlaylists, fetchSongs])

  const handlePlayList = useCallback((index: number) => {
    const list = listRef.current?.getList()
    if (!list) return
    const listId = `tx_daily_rec_${type}`
    handlePlay(list, listId, index)
  }, [type])

  const handlePlaylistPress = (item: { id: string, name: string, cover: string, playCount: number }) => {
    if (onOpenDetail) {
      const listInfo = {
        id: item.id,
        name: item.name,
        img: item.cover,
        songCount: 0,
        playCount: item.playCount,
        source: 'tx',
        author: '',
      } as ListInfoItem
      onOpenDetail(listInfo)
    }
  }

  // 空列表渲染：区分「加载中 / 加载失败 / 真的没推荐」，并给失败态一个重试入口
  const renderEmpty = () => {
    if (type !== 'home') return null
    if (loading) {
      return (
        <View style={styles.empty}>
          <Text color={theme['c-font-label']}>{t('list_loading')}</Text>
        </View>
      )
    }
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

  if (type === 'home') {
    return (
      <View style={{ flex: 1 }}>
        <FlatList
          data={playlists}
          // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
          contentContainerStyle={{ paddingBottom: bottomInset }}
          key={isHorizontal ? 'horizontal' : 'vertical'}
          numColumns={isHorizontal ? 2 : 1}
          columnWrapperStyle={isHorizontal ? styles.columnWrapper : undefined}
          renderItem={({ item }) => (
            <View style={isHorizontal ? styles.itemWrapper : null}>
              <PlaylistItem item={item} onPress={() => { handlePlaylistPress(item) }} />
            </View>
          )}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={renderEmpty()}
          refreshControl={
            // 只认用户下拉（见 refreshing 状态注释）
            <RefreshControl colors={[theme['c-primary']]} refreshing={refreshing} onRefresh={handleRefresh} />
          }
        />
      </View>
    )
  }

  return (
    <View style={{ flex: 1 }}>
      <OnlineList
        ref={listRef}
        listId={`tx_daily_rec_${type}`}
        forcePlayList={true}
        playingId={playerMusicInfo.id}
        onPlayList={handlePlayList}
        onRefresh={handleRefresh}
        onLoadMore={() => {}}
        checkHomePagerIdle
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
