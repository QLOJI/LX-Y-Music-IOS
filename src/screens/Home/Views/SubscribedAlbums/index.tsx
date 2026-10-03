import { memo, useState, useCallback, useEffect } from 'react'
import { View, FlatList, RefreshControl, Keyboard } from 'react-native'
import { useWySubscribedAlbums } from '@/store/user/hook'
import wyApi from '@/utils/musicSdk/wy/user'
import { setWySubscribedAlbums } from '@/store/user/action'
import { createStyle, toast } from '@/utils/tools'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import Text from '@/components/common/Text'
import ListItem from './ListItem'
import { useHorizontalMode } from '@/utils/hooks'
import PageTopInset from '@/components/common/PageTopInset'
import DetailPageTitle from '@/components/common/DetailPageTitle'
import SwipeBackArea from '@/components/common/SwipeBackArea'
import { setNavActiveId } from '@/core/common'
import { useBottomOverlayInset } from '@/store/common/hook'

export default memo(() => {
  const subscribedAlbums = useWySubscribedAlbums()
  const [loading, setLoading] = useState(false)
  // 下拉刷新动画只认「用户真的下拉过」（用户第 16 轮第 7 条）。本页列表**没有**首载闸门，
  // 而挂载时那个 effect 会立刻调一次 onRefresh —— 旧写法 refreshing={loading} 会让刷新控件
  // 在进入页面时当场激活：内容被压下去、加载完再弹回来（「第一次进入向上刷新」）。
  // 现在程序加载只用 loading（只喂空态文案），refreshing 只由用户下拉置位。
  const [refreshing, setRefreshing] = useState(false)
  const theme = useTheme()
  const t = useI18n()
  const cookie = useSettingValue('common.wy_cookie')
  const isHorizontal = useHorizontalMode()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()

  const onRefresh = useCallback((isPullRefresh = false) => {
    if (!cookie) {
      setLoading(false)
      setRefreshing(false)
      setWySubscribedAlbums([])
      return
    }
    if (isPullRefresh) setRefreshing(true)
    else setLoading(true)
    wyApi.getAllSubAlbumList()
      .then(albums => {
        setWySubscribedAlbums(albums)
      })
      .catch(err => {
        toast(`刷新失败: ${err.message}`)
      })
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [cookie])

  useEffect(() => {
    if (!subscribedAlbums.length && cookie) {
      onRefresh()
    }
  }, [onRefresh, subscribedAlbums.length, cookie])

  // 【第 21 轮·图五~图八】右滑返回「我的」主界面：与排行榜页（Leaderboard/Vertical）同一条
  // 右缘手势带，onBack 只做一件事 —— 把首页切回「我的」（setNavActiveId('nav_love')）。
  const handleBackToLove = useCallback(() => {
    setNavActiveId('nav_love')
  }, [])

  return (
    <View style={{ flex: 1 }}>
      {/* 【第 21 轮·图六】页头（状态栏占位 + 标题行）固定在列表**外面**，参考 WebDAV 布局。
          此前它是 FlatList 的 ListHeaderComponent —— 落在可滚动内容里，iOS 会对贴着安全区
          顶边的滚动视图自动加顶部 contentInset（本机 = 62pt）：用户截图里本页标题整体比
          正常位置低 62pt，就是这一层 inset 在推页头。移成列表兄弟节点后，标题位置不再
          取决于列表配置（与「我的」/ WebDAV 同构），未登录占位与列表态也是同一份页头 ——
          标题按「我的」标题位置固定，不随列表有无而变（用户第 14 轮第 1 条）。 */}
      <PageTopInset />
      {/* 页面标题行：位置/行高/字重与「我的」标题同源，字号取 WebDAV 页标题
          （共享页头）的字号。本页原先连标题都没有，只有共享页头那一行
          （用户第 14 轮第 1 条：标题按「我的」标题位置固定且显示完全）。 */}
      <DetailPageTitle title={t('nav_subscribed_albums')} />
      {!cookie ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text>{t('wy_cookie_not_set')}</Text>
        </View>
      ) : (
        <FlatList
          onScrollBeginDrag={Keyboard.dismiss}
          data={subscribedAlbums}
          contentContainerStyle={{ paddingBottom: bottomInset }}
          key={isHorizontal ? 'horizontal' : 'vertical'}
          numColumns={isHorizontal ? 2 : 1}
          renderItem={({ item }) => (
            <View style={isHorizontal ? styles.itemWrapper : null}>
              <ListItem item={item} showSubscribeButton={false} />
            </View>
          )}
          keyExtractor={item => String(item.id)}
          columnWrapperStyle={isHorizontal ? styles.columnWrapper : undefined}
          refreshControl={
            <RefreshControl
              colors={[theme['c-primary']]}
              // 只认用户下拉（见 refreshing 状态注释）
              refreshing={refreshing}
              onRefresh={() => { onRefresh(true) }}
            />
          }
        />
      )}
      <SwipeBackArea onBack={handleBackToLove} />
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
})
