import { memo, useEffect, useState, useCallback, useRef } from 'react'
import { View, FlatList, RefreshControl, BackHandler, StyleSheet, Keyboard, ActivityIndicator } from 'react-native'
import ListItem from './ListItem'
import wyApi from '@/utils/musicSdk/wy/user'
import wyDailyRecApi from '@/utils/musicSdk/wy/dailyRec'
import wyMusicDetailApi from '@/utils/musicSdk/wy/musicDetail'
import { playOnlineList } from '@/core/list'
import { MUSIC_TOGGLE_MODE } from '@/config/constant'
import { updateSetting } from '@/core/common'
import { useWySubscribedPlaylists, useWyUid } from '@/store/user/hook.ts'
import { useBottomOverlayInset } from '@/store/common/hook'
import { useHorizontalMode } from '@/utils/hooks'
import { useI18n } from '@/lang'
import PageTopInset from '@/components/common/PageTopInset'
import DetailPageTitle from '@/components/common/DetailPageTitle'
import userState from '@/store/user/state'
import { useSettingValue } from '@/store/setting/hook'
import { toast, confirmDialog, createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import SonglistDetail from '../../../SonglistDetail'
import { type ListInfoItem } from '@/store/songlist/state'
import commonState from '@/store/common/state'
import { setWySubscribedPlaylists, removeWySubscribedPlaylist } from '@/store/user/action.ts'
import Menu, { type MenuType, type Position } from '@/components/common/Menu'
import PlaylistEditModal, { type PlaylistEditModalType } from './PlaylistEditModal'
import MusicInfoOnline = LX.Music.MusicInfoOnline

export default memo(() => {
  const playlists = useWySubscribedPlaylists()
  const uid = useWyUid()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const [loading, setLoading] = useState(true)
  // 首载闸门（用户第 15 轮第 3 条）：FlatList 必须等首次加载结束再挂载，**不能**先以
  // data=[] 挂出来、数据到了再补进去 —— 空列表里只有页头那一格，数据到达后整块内容按
  // 最终高度重排/复位，用户看到的就是「第一次进入歌单页时整体向上跳一下再落下来」。
  // 对照「我的」页（Mylist/NewListUI）：同一套 ListHeaderComponent 结构，它的 FlatList
  // 挂在 isLoading 之后（转圈 → 有数据才挂列表），从来没有这个跳动 —— 这里照抄那条口径。
  // 另一个同样重要的副作用：本页 RefreshControl 是 refreshing={loading}，而 loading 初值
  // 为 true；列表若在挂载帧就出现，iOS 的刷新控件会当场激活、把内容整体下压，加载结束
  // 回弹时再上跳一次（就是那条「向上跳一下再下移」的回弹弹簧）。把列表挂载推迟到首载
  // 结束 —— 那一帧 loading 与闸门在同一次提交里一起落位为 false —— 这条路径就不存在了。
  // 闸门只认「首次加载是否结束」，不认 loading：下拉刷新时列表必须留在原地，不能整块换成转圈。
  const [listReady, setListReady] = useState(false)
  const cookie = useSettingValue('common.wy_cookie')
  const theme = useTheme()
  const t = useI18n()
  const isHorizontal = useHorizontalMode()
  const [selectedPlaylist, setSelectedPlaylist] = useState<ListInfoItem | null>(null)
  const [scrollToMusicInfo, setScrollToMusicInfo] = useState<MusicInfoOnline | null>(null)
  const selectedPlaylistRef = useRef(selectedPlaylist)
  selectedPlaylistRef.current = selectedPlaylist

  const [menuVisible, setMenuVisible] = useState(false)
  const menuRef = useRef<MenuType>(null)
  const selectedItemRef = useRef<any>(null)
  const playlistEditModalRef = useRef<PlaylistEditModalType>(null)

  // 记录上一次加载的 cookie+uid 组合，避免重复请求；cookie 或 uid 变化时强制刷新。
  const lastLoadKeyRef = useRef('')
  useEffect(() => {
    if (!cookie || !uid) {
      lastLoadKeyRef.current = ''
      setLoading(false)
      setListReady(true)
      setWySubscribedPlaylists([])
      return
    }
    const loadKey = `${uid}:${cookie}`
    if (lastLoadKeyRef.current === loadKey) {
      setLoading(false)
      setListReady(true)
      return
    }
    lastLoadKeyRef.current = loadKey
    setLoading(true)
    wyApi.getUserPlaylists(uid, cookie)
      .then((playlists: any[]) => {
        setWySubscribedPlaylists(playlists)
      })
      .catch((err: any) => {
        lastLoadKeyRef.current = ''
        toast(`获取歌单失败: ${err.message}`)
      })
      .finally(() => {
        // 闸门与 loading 必须同批落位：列表挂载那一帧 loading 已经是 false，
        // RefreshControl 不会在挂载帧被激活（见 listReady 注释）。
        setLoading(false)
        setListReady(true)
      })
  }, [cookie, uid])

  const onRefresh = useCallback(() => {
    if (!cookie || !uid) {
      setLoading(false)
      setWySubscribedPlaylists([])
      return
    }
    setLoading(true)
    wyApi.getUserPlaylists(uid, cookie)
      .then((playlists: any[]) => {
        setWySubscribedPlaylists(playlists)
      })
      .catch((err: any) => {
        toast(`刷新歌单失败: ${err.message}`)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [cookie, uid])

  useEffect(() => {
    const onBackPress = () => {
      if (selectedPlaylistRef.current) {
        if (commonState.componentIds.length > 1) {
          return false
        }

        setSelectedPlaylist(null)
        return true
      }

      return false
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress)
    return () => { subscription.remove() }
  }, [])

  const handleItemPress = useCallback((playlistInfo: ListInfoItem) => {
    setSelectedPlaylist(playlistInfo)
  }, [])

  const handleHeartbeatPress = useCallback(async(playlistInfo: ListInfoItem) => {
    if (!cookie || !uid) return
    try {
      toast('正在开启心动模式...')
      let ids = Array.from(userState.wy_liked_song_ids)
      if (!ids?.length) {
        ids = (await wyApi.getLikedSongList(uid, cookie)).map(String)
      }

      if (!ids?.length) {
        toast('没有喜欢的歌曲')
        return
      }

      const randomSongId = ids[Math.floor(Math.random() * ids.length)]
      const musicInfoRes = await wyMusicDetailApi.getList([randomSongId])
      const mInfo = musicInfoRes.list[0]

      if (!mInfo) {
        toast('获取歌曲详情失败')
        return
      }

      const res = await wyDailyRecApi.getHeartbeatModeList(cookie, playlistInfo.id, randomSongId)
      const heartbeatList = [mInfo, ...res.list].filter(Boolean)

      updateSetting({ 'player.togglePlayMethod': MUSIC_TOGGLE_MODE.heartbeat })
      // 最后一个参数 true = 心动模式仍写临时列表（动态电台队列，不写进试听列表）
      playOnlineList('heartbeat', heartbeatList, 0, false, true)
      toast('心动模式已开启')
    } catch (err: any) {
      toast(`开启心动模式失败: ${err.message}`)
    }
  }, [cookie, uid])

  const handleMenuPress = useCallback((item: any, position: Position) => {
    selectedItemRef.current = item
    setMenuVisible(true)
    requestAnimationFrame(() => {
      menuRef.current?.show(position)
    })
  }, [])

  const handleMenuAction = useCallback(({ action }: { action: string }) => {
    setMenuVisible(false)
    const item = selectedItemRef.current
    if (!item) return

    switch (action) {
      case 'edit':
        playlistEditModalRef.current?.show({
          id: String(item.id),
          name: item.name,
          desc: item.description || '',
        })
        break
      case 'delete':
        confirmDialog({
          message: `确定要删除歌单"${item.name}"吗？`,
          confirmButtonText: '删除',
        }).then(async(confirmed) => {
          if (!confirmed) return
          try {
            await wyApi.deletePlaylist(item.id)
            toast('删除成功')
            removeWySubscribedPlaylist(item.id)
          } catch (err: any) {
            toast(`删除失败: ${err.message}`)
          }
        })
        break
    }
  }, [])

  // 入口已按 Cookie 登录态显隐（FeatureGrid 门控），不再渲染未登录占位页
  const handleBack = useCallback(() => {
    setSelectedPlaylist(null)
    setScrollToMusicInfo(null)
  }, [])
  // 页头（状态栏占位 + 标题行）在「首载中」与「已就绪」两条分支里必须是同一份、同一几何：
  // 加载分支把它当普通兄弟节点渲染，就绪分支把它当 ListHeaderComponent —— 两处都在容器
  // 顶部、同样的 paddingTop/marginBottom，所以从转圈切到列表时标题一动不动（第 15 轮第 3 条）。
  const pageHeader = (
    <>
      <PageTopInset />
      {/* 页面标题行：位置/行高/字重与「我的」标题同源，字号取 WebDAV 页标题
          （共享页头）的字号。此前这里用裸 StyleSheet.create 写死 lineHeight
          42、字号却跟着「字体大小」设置放大，字体调大后标题上下笔画被裁
          —— 用户第 14 轮第 1 条的「显示不全」。详见组件注释。 */}
      <DetailPageTitle title={t('nav_my_playlist')} />
    </>
  )
  return (
    <View style={{ flex: 1 }}>
      <View style={[{ flex: 1 }, selectedPlaylist ? { opacity: 0 } : null]} pointerEvents={selectedPlaylist ? 'none' : 'auto'}>
        {listReady ? (
          <FlatList
            onScrollBeginDrag={Keyboard.dismiss}
            data={playlists}
            ListHeaderComponent={pageHeader}
            contentContainerStyle={{ paddingBottom: bottomInset }}
            key={isHorizontal ? 'horizontal' : 'vertical'}
            numColumns={isHorizontal ? 2 : 1}
            columnWrapperStyle={isHorizontal ? { paddingHorizontal: 8 } : undefined}
            renderItem={({ item }) => (
              <View style={isHorizontal ? { flex: 1 } : null}>
                <ListItem item={item} onPress={handleItemPress} onHeartbeatPress={handleHeartbeatPress} onMenuPress={handleMenuPress} />
              </View>
            )}
            keyExtractor={item => String(item.id)}
            refreshControl={
              <RefreshControl
                colors={[theme['c-primary']]}
                refreshing={loading}
                onRefresh={onRefresh}
              />
            }
          />
        ) : (
          <>
            {pageHeader}
            <View style={styles.loadingContainer}>
              <ActivityIndicator color={theme['c-primary-font']} size="large" />
            </View>
          </>
        )}
      </View>
      {selectedPlaylist && (
        <View style={[StyleSheet.absoluteFill]}>
          <SonglistDetail info={selectedPlaylist} onBack={handleBack} initialScrollToInfo={scrollToMusicInfo} />
        </View>
      )}
      {menuVisible && (
        <Menu
          ref={menuRef}
          menus={[{ action: 'edit', label: '编辑' }, { action: 'delete', label: '删除' }]}
          onPress={handleMenuAction}
          onHide={() => { setMenuVisible(false) }}
        />
      )}
      <PlaylistEditModal ref={playlistEditModalRef} />
    </View>
  )
})

const styles = createStyle({
  // 首载闸门期间（列表还没挂）占住页头以下的整块区域，转圈居中 —— 与「我的」页
  // （NewListUI.loadingContainer）同一个口径：有数据才挂列表，之前只显示加载指示。
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
})

