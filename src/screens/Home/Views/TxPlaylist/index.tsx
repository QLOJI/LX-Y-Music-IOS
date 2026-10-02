/**
 * QQ音乐歌单页面 - 显示用户自建歌单和收藏歌单
 */

import { memo, useEffect, useState, useCallback, useRef } from 'react'
import { View, FlatList, RefreshControl, BackHandler, StyleSheet, Keyboard, TouchableOpacity, ActivityIndicator } from 'react-native'
import ListItem from './ListItem'
import txUserApi from '@/utils/musicSdk/tx/user'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'
import { toast, confirmDialog } from '@/utils/tools'
import SonglistDetail from '../../../SonglistDetail'
import commonState from '@/store/common/state'
import Menu, { type MenuType, type Position } from '@/components/common/Menu'
import ConfirmAlert, { type ConfirmAlertType } from '@/components/common/ConfirmAlert'
import Input from '@/components/common/Input'
import { useHorizontalMode } from '@/utils/hooks'
import { useButtonRadius } from '@/utils/buttonRadius'
import PageTopInset from '@/components/common/PageTopInset'
import DetailPageTitle from '@/components/common/DetailPageTitle'
import { useBottomOverlayInset } from '@/store/common/hook'

interface PlaylistInfo {
  id: string
  name: string
  cover: string
  songCount: number
  desc?: string
  isFavorites?: boolean
  isCollected?: boolean
  dirid?: number
}

type TabType = 'created' | 'collected'

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const buttonRadius = useButtonRadius()
  const [activeTab, setActiveTab] = useState<TabType>('created')
  const [createdPlaylists, setCreatedPlaylists] = useState<PlaylistInfo[]>([])
  const [collectedPlaylists, setCollectedPlaylists] = useState<PlaylistInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // 首载闸门（用户第 15 轮第 3 条）：FlatList 必须等首次加载结束再挂载，**不能**先以
  // data=[] 挂出来、数据到了再补进去 —— 空列表里只有页头那一格（tab 文案里的数量也还是
  // 0），数据到达后整块内容按最终高度重排/复位，用户看到的就是「第一次进入歌单页时整体
  // 向上跳一下再落下来」。对照「我的」页（Mylist/NewListUI）：同一套 ListHeaderComponent
  // 结构，它的 FlatList 挂在 isLoading 之后（转圈 → 有数据才挂列表），从来没有这个跳动 ——
  // 这里照抄那条口径。闸门只认「首次加载是否结束」，不认 loading：下拉刷新（refreshing）
  // 时列表必须留在原地不动。
  const [listReady, setListReady] = useState(false)
  const [selectedPlaylist, setSelectedPlaylist] = useState<any>(null)
  const selectedPlaylistRef = useRef(selectedPlaylist)
  selectedPlaylistRef.current = selectedPlaylist

  const [menuVisible, setMenuVisible] = useState(false)
  const menuRef = useRef<MenuType>(null)
  const selectedItemRef = useRef<PlaylistInfo | null>(null)

  const [createModalVisible, setCreateModalVisible] = useState(false)
  const createModalRef = useRef<ConfirmAlertType>(null)
  const [newPlaylistName, setNewPlaylistName] = useState('')

  // 列数响应式（对齐 OnlineList）：iPad 横屏/分屏时双列，避免歌单卡片在超宽屏上
  // 被拉成一行很长、左右留白；竖屏保持单列零回归。
  // numColumns 变更时 FlatList 必须重挂载（RN 不支持运行中改列数），故加 key。
  const isHorizontal = useHorizontalMode()
  const numColumns = isHorizontal ? 2 : 1

  const playlists = activeTab === 'created' ? createdPlaylists : collectedPlaylists

  const fetchCreatedPlaylists = useCallback(async(isRefresh = false) => {
    try {
      const lists = await txUserApi.getCreatedPlaylists()

      const favoritesPlaylist = lists.find((p: PlaylistInfo) => p.isFavorites)
      if (favoritesPlaylist && favoritesPlaylist.songCount > 0) {
        try {
          const favSongs = await txUserApi.getFavSongs(1, 1)
          if (favSongs.list && favSongs.list.length > 0) {
            const firstSong = favSongs.list[0]
            const coverUrl = firstSong.albumMid
              ? `https://y.gtimg.cn/music/photo_new/T002R800x800M000${firstSong.albumMid}.jpg`
              : favoritesPlaylist.cover
            favoritesPlaylist.cover = coverUrl
          }
        } catch (err) {
          console.warn('获取"我喜欢"歌单详情失败:', err)
        }
      }

      setCreatedPlaylists(lists as PlaylistInfo[])
    } catch (err: any) {
      console.error('获取自建歌单失败:', err)
      if (!isRefresh) {
        toast(`获取自建歌单失败: ${err.message}`)
      }
    }
  }, [])

  const fetchCollectedPlaylists = useCallback(async(isRefresh = false) => {
    try {
      const result = await txUserApi.getFavPlaylists(1, 50)
      setCollectedPlaylists((result.list || []) as PlaylistInfo[])
    } catch (err: any) {
      console.error('获取收藏歌单失败:', err)
      if (!isRefresh) {
        toast(`获取收藏歌单失败: ${err.message}`)
      }
    }
  }, [])

  // 取歌单。三种模式（用户第 16 轮第 7 条：刷新动画只能由「用户真的下拉」触发）：
  //   'initial' 首载 —— 列表还没挂（listReady 闸门），loading 只喂加载占位；
  //   'pull'    用户下拉 —— 只有这一条路径会把 RefreshControl 的 refreshing 置位；
  //   'silent'  程序触发的重取（新建 / 删除歌单之后）—— 两者都不动，列表原地换数据，
  //             不再出现「点完删除，顶部自己弹一次下拉动画再回弹」的上跳。
  const fetchPlaylists = useCallback(async(mode: 'initial' | 'pull' | 'silent' = 'initial') => {
    try {
      if (mode === 'pull') {
        setRefreshing(true)
      } else if (mode === 'initial') {
        setLoading(true)
      }
      await Promise.all([
        fetchCreatedPlaylists(mode !== 'pull'),
        fetchCollectedPlaylists(mode !== 'pull'),
      ])
    } catch (err: any) {
      console.error('获取歌单失败:', err)
    } finally {
      // 闸门与 loading 同批落位：列表挂载那一帧 loading 已经是 false。
      setLoading(false)
      setRefreshing(false)
      setListReady(true)
    }
  }, [fetchCreatedPlaylists, fetchCollectedPlaylists])

  useEffect(() => {
    void fetchPlaylists()
  }, [fetchPlaylists])

  const handleItemPress = useCallback((info: PlaylistInfo) => {
    const playlistInfo = {
      id: info.id,
      name: info.name,
      author: '',
      img: info.cover,
      play_count: 0,
      desc: info.desc,
      source: 'tx',
      userId: '',
      total: info.songCount,
    }
    setSelectedPlaylist(playlistInfo)
  }, [])

  const onRefresh = useCallback(() => {
    void fetchPlaylists('pull')
  }, [fetchPlaylists])

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

  const handleBack = useCallback(() => {
    setSelectedPlaylist(null)
  }, [])

  const handleMenuPress = useCallback((item: PlaylistInfo, position: Position) => {
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
      case 'create':
        setNewPlaylistName('')
        setCreateModalVisible(true)
        requestAnimationFrame(() => {
          createModalRef.current?.setVisible(true)
        })
        break
      case 'delete':
        void confirmDialog({
          message: `确定要删除歌单"${item.name}"吗？`,
          confirmButtonText: '删除',
        }).then(async(confirmed) => {
          if (!confirmed) return
          if (!item.dirid) {
            toast('无法获取歌单信息')
            return
          }
          try {
            await txUserApi.deletePlaylist(item.dirid)
            toast('删除成功')
            await fetchPlaylists('silent')
          } catch (err: any) {
            toast(`删除失败: ${err.message}`)
          }
        })
        break
    }
  }, [fetchPlaylists])

  const handleCreatePlaylist = useCallback(async() => {
    const name = newPlaylistName.trim()
    if (!name) {
      toast('歌单名不能为空')
      return
    }

    try {
      await txUserApi.createPlaylist(name)
      toast('创建成功')
      setNewPlaylistName('')
      createModalRef.current?.setVisible(false)
      await fetchPlaylists('silent')
    } catch (err: any) {
      toast(`创建失败: ${err.message}`)
    }
  }, [newPlaylistName, fetchPlaylists])

  const renderTab = useCallback((tab: TabType, label: string) => {
    const isActive = activeTab === tab
    return (
      <TouchableOpacity
        key={tab}
        style={[
          styles.tabItem,
          // 分段 tab 圆角随「按钮圆角」设置行内覆盖；可见高度 ≈ 26 = 15 号文字行高 17 + 下划线留白 3 + 上下 padding 3×2
          { borderRadius: buttonRadius(26) },
        ]}
        onPress={() => { setActiveTab(tab) }}
      >
        <Text
          style={[styles.tabText, { borderBottomColor: isActive ? theme['c-primary-font-active'] : 'transparent' }]}
          color={theme['c-font']}
          // 三等分后每份约 109pt（375 宽屏）：数量到 4 位或「字体大小」调得很大时只截断，
          // 不换行 —— 换行会把整行撑高、三等分的视觉就被破坏（第 16 轮第 2 条）。
          numberOfLines={1}
        >
          {label}
        </Text>
      </TouchableOpacity>
    )
  }, [activeTab, theme, buttonRadius])

  // 页头（状态栏占位 + 标题行 + 同行 tab）。用户第 16 轮第 2/7 条后它**不再**进列表：
  // 之前它就是 ListHeaderComponent，列表挂载/换数据/下拉刷新时它都在可滚动内容里，
  // 用户看到「第一次进入时标题和内容一起向上跳一下」。现在它是列表的兄弟节点、固定在
  // 容器顶部 —— 标题在任何时候都不动（既不随列表滚动，也不随刷新位移），列表只占它
  // 下面那块，首载中/已就绪两条分支的页头是同一份、同一几何（第 15 轮第 3 条也保持）。
  const pageHeader = (
    <>
      <PageTopInset />
      {/* 标题行与 tab 同行：位置/行高/字重与「我的」标题同源，字号取 WebDAV 页标题
          （共享页头）的字号。此前用裸 StyleSheet.create 写死 lineHeight 42、
          字号却随「字体大小」设置放大，字体调大后标题上下笔画被裁
          —— 用户第 14 轮第 1 条的「显示不全」。详见组件注释。
          equalColumns：QQ歌单 / 自建歌单 / 收藏歌单 三等分、同一垂直中线（第 16 轮第 2 条）。 */}
      <DetailPageTitle title={t('nav_tx_playlist')} equalColumns>
        <View style={[styles.tabBar]}>
          {renderTab('created', `自建歌单 (${createdPlaylists.length})`)}
          {renderTab('collected', `收藏歌单 (${collectedPlaylists.length})`)}
        </View>
      </DetailPageTitle>
    </>
  )
  return (
    <View style={{ flex: 1 }}>
      <View
        style={[{ flex: 1, overflow: 'hidden' }, selectedPlaylist ? { opacity: 0 } : null]}
        pointerEvents={selectedPlaylist ? 'none' : 'auto'}
      >
        {pageHeader}
        {listReady ? (
          <FlatList
            key={`cols-${numColumns}`}
            onScrollBeginDrag={Keyboard.dismiss}
            data={playlists}
            contentContainerStyle={{ paddingBottom: bottomInset, paddingRight: 0 }}
            numColumns={numColumns}
            renderItem={({ item }) => (
              <View style={numColumns > 1 ? styles.itemWrapper : undefined}>
                <ListItem item={item} onPress={handleItemPress} onMenuPress={handleMenuPress} />
              </View>
            )}
            keyExtractor={item => `${item.id}-${item.isCollected ? 'collected' : 'created'}`}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                colors={[theme['c-primary']]}
                refreshing={refreshing}
                onRefresh={onRefresh}
              />
            }
            ListEmptyComponent={
              loading ? null : (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>
                    {playlists.length === 0 ? t('list_empty') : ''}
                  </Text>
                </View>
              )
            }
          />
        ) : (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={theme['c-primary-font']} size="large" />
          </View>
        )}
      </View>
      {selectedPlaylist && (
        <View style={[StyleSheet.absoluteFill]}>
          <SonglistDetail info={selectedPlaylist} onBack={handleBack} initialScrollToInfo={null} />
        </View>
      )}
      {menuVisible && (
        <Menu
          ref={menuRef}
          menus={[{ action: 'create', label: '新建歌单' }, { action: 'delete', label: '删除歌单' }]}
          onPress={handleMenuAction}
          onHide={() => { setMenuVisible(false) }}
        />
      )}
      {createModalVisible && (
        <ConfirmAlert
          ref={createModalRef}
          onConfirm={handleCreatePlaylist}
          onHide={() => { setCreateModalVisible(false) }}
          title="新建歌单"
        >
          <Input
            value={newPlaylistName}
            onChangeText={setNewPlaylistName}
            placeholder="请输入歌单名称"
            style={{ backgroundColor: theme['c-primary-input-background'] }}
          />
        </ConfirmAlert>
      )}
    </View>
  )
})

const styles = StyleSheet.create({
  itemWrapper: {
    flex: 1,
    maxWidth: '50%',
  },
  // 【第 16 轮第 2 条】三等分的后两份：标题 flex:1（DetailPageTitle.equalColumns）+ 本行
  // flex:2，行宽被切成 3 等份（标题 / 自建歌单 / 收藏歌单各 1/3），每个 tab 再对半分。
  // alignItems 由 'flex-end' 改成 'center'：tab 文字与标题同处 42pt 行高的垂直中线，
  // 视觉上「在一条直线上」（原 bottom 对齐会比标题低半行）。
  tabBar: {
    flexDirection: 'row',
    flex: 2,
    alignItems: 'center',
  },
  tabItem: {
    flex: 1,
    paddingVertical: 3,
    alignItems: 'center',
  },
  tabText: {
    paddingBottom: 3,
    borderBottomWidth: 2,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100,
  },
  emptyText: {
    fontSize: 14,
    opacity: 0.7,
  },
})
