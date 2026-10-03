/**
 * Kugou Music playlist page - Displays user-created and collected playlists (replicating QQ Music playlist page)
 */

import { memo, useEffect, useState, useCallback, useRef } from 'react'
import { View, FlatList, RefreshControl, BackHandler, StyleSheet, Keyboard, ActivityIndicator } from 'react-native'
import ListItem from './ListItem'
import { getUserPlaylists, subscribePlaylist, unsubscribePlaylist } from '@/utils/musicSdk/kg/utils/api'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'
import { toast, confirmDialog } from '@/utils/tools'
import SonglistDetail from '../../../SonglistDetail'
import commonState from '@/store/common/state'
import { useSettingValue } from '@/store/setting/hook'
import Menu, { type MenuType, type Position } from '@/components/common/Menu'
import ConfirmAlert, { type ConfirmAlertType } from '@/components/common/ConfirmAlert'
import Input from '@/components/common/Input'
import { useHorizontalMode } from '@/utils/hooks'
import PageTopInset from '@/components/common/PageTopInset'
import DetailPageTitle from '@/components/common/DetailPageTitle'
import PillTabs from '@/components/common/PillTabs'
import SwipeBackArea from '@/components/common/SwipeBackArea'
import { setNavActiveId } from '@/core/common'
import { useBottomOverlayInset } from '@/store/common/hook'

interface PlaylistInfo {
  id: string
  listid?: number
  name: string
  cover: string
  songCount: number
  desc?: string
  isFavorites?: boolean
  isCollected?: boolean
}

type TabType = 'created' | 'collected'

export default memo(() => {
  const t = useI18n()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const theme = useTheme()
  const kgCookie = useSettingValue('common.kg_cookie')
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

  // 取歌单。三种模式（用户第 16 轮第 7 条：刷新动画只能由「用户真的下拉」触发）：
  //   'initial' 首载 —— 列表还没挂（listReady 闸门），loading 只喂加载占位；
  //   'pull'    用户下拉 —— 只有这一条路径会把 RefreshControl 的 refreshing 置位；
  //   'silent'  程序触发的重取（新建 / 删除歌单之后）—— 两者都不动，列表原地换数据，
  //             不再出现「点完删除，顶部自己弹一次下拉动画再回弹」的上跳。
  const fetchPlaylists = useCallback(async(mode: 'initial' | 'pull' | 'silent' = 'initial') => {
    if (!kgCookie) {
      // 静默清空会让用户误以为歌单被删光了：与失败路径的 toast 保持一致给出提示。
      // 只在非刷新时提示，避免下拉刷新反复弹
      if (mode !== 'pull') toast(t('kg_cookie_not_set'))
      setCreatedPlaylists([])
      setCollectedPlaylists([])
      setLoading(false)
      setListReady(true)
      return
    }
    try {
      if (mode === 'pull') {
        setRefreshing(true)
      } else if (mode === 'initial') {
        setLoading(true)
      }
      const result = await getUserPlaylists(kgCookie)
      if (result.success && result.data) {
        setCreatedPlaylists((result.data.createdList || []) as PlaylistInfo[])
        setCollectedPlaylists((result.data.collectedList || []) as PlaylistInfo[])
      } else if (mode !== 'pull') {
        toast(`获取歌单失败: ${result.message}`)
      }
    } catch (err: any) {
      console.error('获取酷狗歌单失败:', err)
      if (mode !== 'pull') {
        toast(`获取歌单失败: ${err.message}`)
      }
    } finally {
      // 闸门与 loading 同批落位：列表挂载那一帧 loading 已经是 false。
      setLoading(false)
      setRefreshing(false)
      setListReady(true)
    }
  }, [kgCookie, t])

  useEffect(() => {
    void fetchPlaylists()
  }, [fetchPlaylists])

  const handleItemPress = useCallback((info: PlaylistInfo) => {
    const playlistInfo = {
      id: info.id,
      listid: info.listid,
      name: info.name,
      author: '',
      img: info.cover,
      play_count: 0,
      desc: info.desc,
      source: 'kg',
      userId: '',
      total: info.songCount,
      isFavorites: info.isFavorites,
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
          if (!kgCookie) {
            toast(t('kg_cookie_not_set'))
            return
          }
          if (!item.listid) {
            toast('无法获取歌单信息')
            return
          }
          try {
            const result = await unsubscribePlaylist(kgCookie, item.listid)
            if (result.success) {
              toast('删除成功')
              await fetchPlaylists('silent')
            } else {
              toast(`删除失败: ${result.message}`)
            }
          } catch (err: any) {
            toast(`删除失败: ${err.message}`)
          }
        })
        break
    }
  }, [fetchPlaylists, kgCookie, t])

  const handleCreatePlaylist = useCallback(async() => {
    const name = newPlaylistName.trim()
    if (!name) {
      toast('歌单名不能为空')
      return
    }
    if (!kgCookie) {
      toast(t('kg_cookie_not_set'))
      return
    }

    try {
      const result = await subscribePlaylist(kgCookie, {
        name,
        list_create_userid: 0,
        list_create_listid: 0,
        type: 0,
      })
      if (result.success) {
        toast('创建成功')
        setNewPlaylistName('')
        createModalRef.current?.setVisible(false)
        await fetchPlaylists('silent')
      } else {
        toast(`创建失败: ${result.message}`)
      }
    } catch (err: any) {
      toast(`创建失败: ${err.message}`)
    }
  }, [newPlaylistName, fetchPlaylists, kgCookie, t])

  // 【第 21 轮·图三/图四】tab 从标题行里搬出来（原 equalColumns 三等分写法），改到标题
  // **下面**单独一行，几何用共享 PillTabs（与 WebDAV 页逐字同源）。原因：tab 文字为给
  // 下划线留位（paddingBottom 3 + 边框 2）整体比标题字形中心高 ~2.5pt —— 用户看到的就是
  // 「标题右边的按钮中文字不和标题文字在同一直线上（显示在标题文字上面一点）」；且用户
  // 点名「都参考 WebDAV 布局：标题在上面、按钮在标题栏下面、按钮下面显示列表」。
  // key 只可能是这两个（tabs 数组就在 JSX 里），onChange 原样回传。
  const handleTabChange = useCallback((key: string) => {
    setActiveTab(key as TabType)
  }, [])

  // 【第 21 轮·图三/图四】右滑返回「我的」主界面：与排行榜页（Leaderboard/Vertical）同一条
  // 右缘手势带，onBack 只做一件事 —— 把首页切回「我的」（setNavActiveId('nav_love')）。
  const handleBackToLove = useCallback(() => {
    setNavActiveId('nav_love')
  }, [])

  // 页头（状态栏占位 + 标题行 + 标题下面那行 tab）。用户第 16 轮第 2/7 条后它**不再**进列表：
  // 之前它就是 ListHeaderComponent，列表挂载/换数据/下拉刷新时它都在可滚动内容里，
  // 用户看到「第一次进入时标题和内容一起向上跳一下」。现在它是列表的兄弟节点、固定在
  // 容器顶部 —— 标题在任何时候都不动（既不随列表滚动，也不随刷新位移），列表只占它
  // 下面那块，首载中/已就绪两条分支的页头是同一份、同一几何（第 15 轮第 3 条也保持）。
  const pageHeader = (
    <>
      <PageTopInset />
      {/* 标题行：位置/行高/字重与「我的」标题同源，字号取 WebDAV 页标题（共享页头）的
          字号。此前用裸 StyleSheet.create 写死 lineHeight 42、字号却随「字体大小」设置
          放大，字体调大后标题上下笔画被裁 —— 用户第 14 轮第 1 条的「显示不全」。
          详见组件注释。 */}
      <DetailPageTitle title={t('nav_kg_playlist')} />
      {/* 标题下面那行 tab（WebDAV 布局，第 21 轮·图三/图四）：与列表同为固定头的一部分，
          不随列表滚动；按钮下面才是列表。 */}
      <PillTabs
        tabs={[
          { key: 'created', label: `自建歌单 (${createdPlaylists.length})` },
          { key: 'collected', label: `收藏歌单 (${collectedPlaylists.length})` },
        ]}
        activeKey={activeTab}
        onChange={handleTabChange}
      />
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
                  {/* 无 Cookie 时不能只说「列表为空」，否则用户分不清「没登录」和「歌单被清空」 */}
                  <Text style={styles.emptyText}>
                    {kgCookie ? (playlists.length === 0 ? t('list_empty') : '') : t('kg_cookie_not_set')}
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
      {/* 【第 21 轮·图三/图四】右滑返回「我的」主界面：与排行榜页（Leaderboard/Vertical）
          同一条右缘手势带。歌单详情浮层打开时本层让位（enabled=false）—— 浮层里
          SonglistDetail 自带手势，返回到歌单列表由它负责，这一层再拦就会「一次滑动连退两级」。 */}
      <SwipeBackArea onBack={handleBackToLove} enabled={!selectedPlaylist} />
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
  // 【第 21 轮·图三/图四】原 tabBar / tabItem / tabText（标题行内三等分 tab）已删除：
  // tab 改成标题下面的 PillTabs 行（几何来自 WebDAV，见组件注释），标题行的 equalColumns
  // 一并去掉 —— 本页页头里已没有需要三等分的东西。
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
