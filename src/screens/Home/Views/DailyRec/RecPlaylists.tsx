import { memo, useEffect, useState, useCallback, useRef, type ReactElement } from 'react'
import { View, FlatList, RefreshControl, Keyboard, TouchableOpacity } from 'react-native'
import Text from '@/components/common/Text'
import { useSettingValue } from '@/store/setting/hook'
import { createStyle, toast } from '@/utils/tools'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { useHorizontalMode } from '@/utils/hooks'
import { useButtonRadius } from '@/utils/buttonRadius'
import wyApi from '@/utils/musicSdk/wy/dailyRec'
import wy from '@/utils/musicSdk/wy/index'
import ListItem from '../MyPlaylist/ListItem'
import { useBottomOverlayInset } from '@/store/common/hook'
import { getDailyRecPlaylistsCache, setDailyRecPlaylistsCache, clearDailyRecPlaylistsCache } from '@/core/cache'

export default memo(({ header, onOpenDetail }: { header?: ReactElement, onOpenDetail: (info: any) => void }) => {
  const [playlists, setPlaylists] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  // 失败原因（'' = 没失败）。空列表时用它区分「没有歌单」与「请求失败」，并给用户重试入口
  const [loadError, setLoadError] = useState('')
  const cookie = useSettingValue('common.wy_cookie')
  const theme = useTheme()
  const t = useI18n()
  const isHorizontal = useHorizontalMode()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const buttonRadius = useButtonRadius()
  // 只认最后一次发起的加载：cookie 变化 / 连续重试时丢弃过期响应，避免旧结果覆盖新结果
  const loadIdRef = useRef(0)

  const loadPlaylists = useCallback((isRefresh = false) => {
    const loadId = ++loadIdRef.current
    if (!cookie) {
      // 无 cookie 不是「列表为空」：这里只清空数据，由 ListEmptyComponent 渲染
      // 「请先设置网易云 Cookie」占位（对齐 SubscribedAlbums 的范式），
      // 避免用户面对一片空白分不清是没登录还是没加载
      setLoading(false)
      setPlaylists([])
      setLoadError('')
      return
    }

    if (!isRefresh) {
      const cachedPlaylists = getDailyRecPlaylistsCache()
      // [] 也是 truthy：不校验长度的话，空结果一旦进过缓存，本次会话内再进页面
      // 会「命中」缓存直接跳过加载并一直显示空列表
      if (cachedPlaylists && cachedPlaylists.length > 0) {
        setPlaylists(cachedPlaylists)
        setLoadError('')
        setLoading(false)
        return
      }
    }

    setLoading(true)
    setLoadError('')
    wyApi.getRecPlaylists(cookie).then(async(list: any) => {
      const adaptedList = list
        // .filter(item => !item.name.includes('雷达'))
        .map((item: any) => ({
          id: item.id,
          name: item.name,
          trackCount: item.trackCount,
          coverImgUrl: item.picUrl,
          creator: { nickname: item.creator?.nickname ?? '推荐' },
          playCount: item.playcount,
          description: item.copywriter,
        }))

      let isFirstRadarFound = false
      for (let i = 0; i < adaptedList.length; i++) {
        if (!isFirstRadarFound && adaptedList[i].name.includes('私人雷达') && adaptedList[i].trackCount === 0) {
          isFirstRadarFound = true
          try {
            const detail = await wy.songList.getListDetail(String(adaptedList[i].id), 1)
            if (detail?.info) {
              adaptedList[i].name = detail.info.name || adaptedList[i].name
              adaptedList[i].trackCount = detail.total != null ? detail.total : adaptedList[i].trackCount
              adaptedList[i].coverImgUrl = detail.info.img || adaptedList[i].coverImgUrl
            }
          } catch (e) {
            console.log('Failed to fetch radar detail:', e)
          }
        }
      }

      if (loadId !== loadIdRef.current) return
      setPlaylists(adaptedList)
      // 只缓存非空结果，避免 [] 污染命中判断（见上）
      if (adaptedList.length > 0) setDailyRecPlaylistsCache(adaptedList)
    }).catch((err: any) => {
      if (loadId !== loadIdRef.current) return
      // 记下失败原因：空列表时 renderEmpty 会展示它 + 重试按钮。
      // 之前失败只有一次 toast，FlatList 又没有 ListEmptyComponent，
      // 失败后除非 cookie 变化 effect 不会重跑，用户没有任何恢复路径
      setLoadError(err?.message || '')
      toast(t('daily_rec_playlists_load_failed', { msg: err.message }))
    }).finally(() => {
      if (loadId === loadIdRef.current) setLoading(false)
    })
  }, [cookie, t])

  useEffect(() => {
    loadPlaylists()
  }, [loadPlaylists])

  const handleItemPress = (playlistInfo: any) => {
    onOpenDetail(playlistInfo)
  }

  const handleRefresh = () => {
    clearDailyRecPlaylistsCache()
    loadPlaylists(true)
  }

  // 空列表渲染：只有这里能区分「未登录 / 加载中 / 加载失败 / 真的没有歌单」，
  // 并为失败和空数据提供「重新加载」入口（重试先清缓存再强刷）
  const renderEmpty = () => {
    if (!cookie) {
      return (
        <View style={styles.empty}>
          <Text color={theme['c-font-label']}>{t('wy_cookie_not_set')}</Text>
        </View>
      )
    }
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

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ListHeaderComponent={header}
        onScrollBeginDrag={Keyboard.dismiss}
        data={playlists}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        key={isHorizontal ? 'horizontal' : 'vertical'}
        numColumns={isHorizontal ? 2 : 1}
        columnWrapperStyle={isHorizontal ? { paddingHorizontal: 8 } : undefined}
        renderItem={({ item }) => (
          <View style={isHorizontal ? { flex: 1, maxWidth: '50%' } : null}>
            <ListItem item={item} onPress={handleItemPress} />
          </View>
        )}
        keyExtractor={item => String(item.id)}
        ListEmptyComponent={renderEmpty()}
        refreshControl={
          <RefreshControl
            colors={[theme['c-primary']]}
            refreshing={loading}
            onRefresh={handleRefresh}
          />
        }
      />
    </View>
  )
})

const styles = createStyle({
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
