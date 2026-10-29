import { memo, useEffect, useRef, useCallback, useState } from 'react'
import { View } from 'react-native'
import OnlineList, { type OnlineListType } from '@/components/OnlineList'
import { toast } from '@/utils/tools'
import kgDailyRec from '@/utils/musicSdk/kg/dailyRec'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { stageOnlineListToDefault } from '@/core/playListToDefault'
import { refreshCoverCaches } from '@/core/music/coverUrl'
import { useHomePageVisible } from '@/store/common/pageVisibility'

type RecType = 'recommend' | 'everyday'

interface Props {
  type: RecType
  /** 当前 tab：每次切到本 tab 都自动下拉刷新（保留原列表）。 */
  active?: boolean
}

const handlePlay = async(list: LX.Music.MusicInfoOnline[], listId: string, index = 0) => {
  // 酷狗每日推荐整份写入试听列表(DEFAULT)，不再走临时列表（见 core/list.ts playOnlineList 的说明）
  await stageOnlineListToDefault(listId, [...list], index)
}

export default memo(({ type, active = true }: Props) => {
  const listRef = useRef<OnlineListType>(null)
  const playerMusicInfo = usePlayerMusicInfo()
  // 离屏 Home 页重新进入时也刷新当前 tab（pageVisible false→true 的上升沿）。
  const pageVisible = useHomePageVisible()
  const [enterSeq, setEnterSeq] = useState(0)
  const prevPageVisibleRef = useRef(pageVisible)
  useEffect(() => {
    if (pageVisible && !prevPageVisibleRef.current) setEnterSeq(v => v + 1)
    prevPageVisibleRef.current = pageVisible
  }, [pageVisible])

  // 当前 tab 的首载/刷新都用下拉动画（'refreshing'）。
  const fetchSongs = useCallback(async(showRefreshing = true) => {
    try {
      if (showRefreshing) listRef.current?.setStatus('refreshing')
      let songs: LX.Music.MusicInfoOnline[] = []

      switch (type) {
        case 'recommend':
          songs = await kgDailyRec.getRecommendSongs()
          break
        case 'everyday':
          songs = await kgDailyRec.getNewSongs()
          break
      }

      if (songs && songs.length > 0) {
        listRef.current?.setList(songs, false)
        listRef.current?.setStatus('idle')
      } else {
        listRef.current?.setStatus('idle')
        toast('暂无推荐歌曲')
      }
    } catch (error) {
      console.error(`[KG DailyRec] 获取${type}失败:`, error)
      toast('加载失败，请检查酷狗登录状态')
      listRef.current?.setStatus('error')
    }
  }, [type])

  // 每次切到本 tab / 重新进入本页：保留原列表，只点亮下拉刷新动画。
  // 首次加载时列表本来就是空的，自然就是「空白 + 刷新」。
  useEffect(() => {
    if (!active) return
    // 列表已有数据：只展示，不再自动下拉刷新（第一次刷出后只能手动下拉）。
    // 列表为空（首次进入 / PagerView 恢复重挂后数据丢失）时必须加载一次，否则就是空白页。
    if ((listRef.current?.getList()?.length ?? 0) > 0) return
    // 封面缓存签名计算很重，延后到这一帧之后，避免切页瞬间 JS 卡一下。
    setTimeout(refreshCoverCaches, 0)
    void fetchSongs(true)
  }, [active, enterSeq, fetchSongs, type])

  const handleRefresh = useCallback(() => {
    void fetchSongs()
  }, [fetchSongs])

  const handlePlayList = useCallback((index: number) => {
    const list = listRef.current?.getList()
    if (!list) return
    const listId = `kg_daily_rec_${type}`
    handlePlay(list, listId, index)
  }, [type])

  return (
    <View style={{ flex: 1 }}>
      <OnlineList
        ref={listRef}
        listId={`kg_daily_rec_${type}`}
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
