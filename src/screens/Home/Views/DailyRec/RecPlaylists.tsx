import { memo, useEffect, useState, useCallback, useRef } from 'react'
import { View, FlatList, Keyboard, TouchableOpacity } from 'react-native'
import usePullRefresh from '@/components/common/usePullRefresh'
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
import { useHomePageVisible } from '@/store/common/pageVisibility'

export default memo(({ onOpenDetail, active = true }: { onOpenDetail: (info: any) => void, active?: boolean }) => {
  const [playlists, setPlaylists] = useState<any[]>([])
  const flatListRef = useRef<FlatList>(null)
  // 每次切换/进入都走下拉刷新，loading 空态占位不再需要。
  const [refreshing, setRefreshing] = useState(false)
  // 失败原因（'' = 没失败）。空列表时用它区分「没有歌单」与「请求失败」，并给用户重试入口。
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
  // 当前列表对应的 cookie：cookie 变了必须重新加载，哪怕旧列表还有数据。
  const loadKeyRef = useRef('')
  // 离屏 Home 页重新进入时也刷新当前 tab（pageVisible false→true 的上升沿）。
  const pageVisible = useHomePageVisible()
  const [enterSeq, setEnterSeq] = useState(0)
  const prevPageVisibleRef = useRef(pageVisible)
  useEffect(() => {
    if (pageVisible && !prevPageVisibleRef.current) setEnterSeq(v => v + 1)
    prevPageVisibleRef.current = pageVisible
  }, [pageVisible])

  const loadPlaylists = useCallback(() => {
    const loadId = ++loadIdRef.current
    if (!cookie) {
      // 无 cookie 不是「列表为空」：这里只清空数据，由 ListEmptyComponent 渲染
      // 「请先设置网易云 Cookie」占位。
      setRefreshing(false)
      setPlaylists([])
      setLoadError('')
      return
    }

    setRefreshing(true)
    setLoadError('')
    wyApi.getRecPlaylists(cookie).then(async(list: any) => {
      const adaptedList = list
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
    }).catch((err: any) => {
      if (loadId !== loadIdRef.current) return
      // 记下失败原因：空列表时 renderEmpty 会展示它 + 重试按钮。
      setLoadError(err?.message || '')
      toast(t('daily_rec_playlists_load_failed', { msg: err.message }))
    }).finally(() => {
      if (loadId === loadIdRef.current) setRefreshing(false)
    })
  }, [cookie, t])

  // 每次切到本 tab / 重新进入本页：保留原列表，只点亮下拉刷新动画。
  // 首次加载时列表本来就是空的，自然就是「空白 + 刷新」。
  useEffect(() => {
    if (!active) return
    // 已有数据且 cookie 没变：只展示，不再自动下拉刷新（第一次刷出后只能手动下拉）。
    // 列表为空（首次进入 / 重挂后数据丢失）或 cookie 变了，必须加载，否则就是空白页或旧内容。
    if (loadKeyRef.current === cookie && playlists.length > 0) return
    loadKeyRef.current = cookie
    setLoadError('')
    loadPlaylists()
  }, [active, enterSeq, loadPlaylists])

  const handleItemPress = (playlistInfo: any) => {
    onOpenDetail(playlistInfo)
  }

  const handleRefresh = () => {
    loadPlaylists()
  }

  // 自绘下拉刷新：不改变列表 inset，触发/结束都不会上下跳，刷新后顶部距离不变。
  const { indicator: pullIndicator, scrollProps: pullScrollProps } = usePullRefresh(refreshing, handleRefresh, flatListRef)

  // 空列表渲染：区分「未登录 / 加载失败 / 真的没有歌单」，并为失败/空数据提供重试入口。
  const renderEmpty = () => {
    // 自动/手动刷新期间不显示「暂无数据」，交给下拉动画。
    if (refreshing && playlists.length === 0) return null
    if (!cookie) {
      return (
        <View style={styles.empty}>
          <Text color={theme['c-font-label']}>{t('wy_cookie_not_set')}</Text>
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
    <View style={{ flex: 1, overflow: 'hidden' }}>
      {pullIndicator}
      <FlatList
        ref={flatListRef}
        {...pullScrollProps}
        onScrollBeginDrag={(e) => {
          Keyboard.dismiss()
          pullScrollProps.onScrollBeginDrag?.(e)
        }}
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
