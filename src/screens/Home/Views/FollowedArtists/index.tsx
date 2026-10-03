import { memo, useState, useCallback } from 'react'
import { View, FlatList, RefreshControl, Keyboard } from 'react-native'
import ListItem from './ListItem'
import { useWyFollowedArtists } from '@/store/user/hook.ts'
import wyApi from '@/utils/musicSdk/wy/user'
import { setWyFollowedArtists } from '@/store/user/action'
import { createStyle, toast } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useHorizontalMode } from '@/utils/hooks'
import { useI18n } from '@/lang'
import PageTopInset from '@/components/common/PageTopInset'
import DetailPageTitle from '@/components/common/DetailPageTitle'
import SwipeBackArea from '@/components/common/SwipeBackArea'
import { setNavActiveId } from '@/core/common'
import { useBottomOverlayInset } from '@/store/common/hook'

export default memo(() => {
  const followedArtists = useWyFollowedArtists()
  const [loading, setLoading] = useState(false)
  const theme = useTheme()
  const t = useI18n()
  const isHorizontal = useHorizontalMode()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const onRefresh = useCallback(() => {
    setLoading(true)
    wyApi.getAllSublist()
      .then(artists => {
        setWyFollowedArtists(artists)
      })
      .catch(err => {
        toast(`刷新失败: ${err.message}`)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  // 【第 21 轮·图五~图八】右滑返回「我的」主界面：与排行榜页（Leaderboard/Vertical）同一条
  // 右缘手势带，onBack 只做一件事 —— 把首页切回「我的」（setNavActiveId('nav_love')）。
  const handleBackToLove = useCallback(() => {
    setNavActiveId('nav_love')
  }, [])

  return (
    <View style={{ flex: 1 }}>
      {/* 【第 21 轮·图五】页头（状态栏占位 + 标题行）固定在列表**外面**，参考 WebDAV 布局。
          此前它是 FlatList 的 ListHeaderComponent —— 落在可滚动内容里，iOS 会对贴着安全区
          顶边的滚动视图自动加顶部 contentInset（本机 = 62pt）：用户截图里本页标题整行消失、
          收藏专辑页标题整体低 62pt，都是这一层 inset 在吞/推页头。移成列表兄弟节点后，
          标题位置不再取决于列表配置（与「我的」/ WebDAV 同构），首载/刷新也不再位移。 */}
      <PageTopInset />
      {/* 页面标题行：位置/行高/字重与「我的」标题同源，字号取 WebDAV 页标题
          （共享页头）的字号。本页原先连标题都没有，只有共享页头那一行
          （用户第 14 轮第 1 条：标题按「我的」标题位置固定且显示完全）。 */}
      <DetailPageTitle title={t('nav_followed_artists')} />
      <FlatList
        onScrollBeginDrag={Keyboard.dismiss}
        data={followedArtists}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        key={isHorizontal ? 'horizontal' : 'vertical'}
        numColumns={isHorizontal ? 2 : 1}
        renderItem={({ item }) => (
          <View style={isHorizontal ? styles.itemWrapper : null}>
            <ListItem artist={item} />
          </View>
        )}
        keyExtractor={item => String(item.id)}
        columnWrapperStyle={isHorizontal ? styles.columnWrapper : undefined}
        refreshControl={
          <RefreshControl
            colors={[theme['c-primary']]}
            refreshing={loading}
            onRefresh={onRefresh}
          />
        }
      />
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
