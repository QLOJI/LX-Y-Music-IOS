import { memo, useEffect, useRef, useCallback } from 'react'
import { View } from 'react-native'
import OnlineList, { type OnlineListType } from '@/components/OnlineList'
import { toast } from '@/utils/tools'
import kgDailyRec from '@/utils/musicSdk/kg/dailyRec'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { stageOnlineListToDefault } from '@/core/playListToDefault'
import { refreshCoverCaches } from '@/core/music/coverUrl'
import {
  takeDailyRecAutoRefresh,
  getDailyRecSessionList,
  setDailyRecSessionList,
} from '@/core/dailyRecSession'

type RecType = 'recommend' | 'everyday'

interface Props {
  type: RecType
  /** 当前 tab：切到本 tab 且本次启动尚未自动刷新时，清空列表并走下拉刷新。 */
  active?: boolean
}

const handlePlay = async(list: LX.Music.MusicInfoOnline[], listId: string, index = 0) => {
  // 酷狗每日推荐整份写入试听列表(DEFAULT)，不再走临时列表（见 core/list.ts playOnlineList 的说明）
  await stageOnlineListToDefault(listId, [...list], index)
}

export default memo(({ type, active = true }: Props) => {
  const listRef = useRef<OnlineListType>(null)
  const playerMusicInfo = usePlayerMusicInfo()
  const cacheKey = `kg_daily_rec_${type}`
  // 本次挂载已为当前 tab 还原过缓存：切回来时不再重复 setList（避免重置滚动位置）。
  const restoredKeyRef = useRef<string | null>(null)

  // 去掉加载中界面：当前 tab 首载/刷新都用下拉动画（'refreshing'）；
  // 非当前 tab 的预取静默加载，切过去时数据已经现成。
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
        setDailyRecSessionList(cacheKey, songs)
      } else {
        listRef.current?.setStatus('idle')
        toast('暂无推荐歌曲')
      }
    } catch (error) {
      console.error(`[KG DailyRec] 获取${type}失败:`, error)
      toast('加载失败，请检查酷狗登录状态')
      listRef.current?.setStatus('error')
    }
  }, [type, cacheKey])

  // 切到本 tab 时：本次启动还没自动刷过 → 立即清空 + 下拉动画 + 请求；
  // 已经刷过 → 只在本次挂载第一次进入时还原会话缓存，之后保持列表现状。
  // 非当前 tab 同样只还原一次缓存，不请求。
  useEffect(() => {
    const cached = getDailyRecSessionList<LX.Music.MusicInfoOnline[]>(cacheKey)
    const restoreCache = () => {
      if (cached?.length) listRef.current?.setList(cached, false)
    }

    if (!active) {
      if (restoredKeyRef.current === cacheKey) return
      restoredKeyRef.current = cacheKey
      restoreCache()
      return
    }
    if (!takeDailyRecAutoRefresh(cacheKey)) {
      if (restoredKeyRef.current === cacheKey) return
      restoredKeyRef.current = cacheKey
      restoreCache()
      return
    }

    // 首次切到本 tab：先清空，露出下拉刷新动画，响应后再出现新内容。
    restoredKeyRef.current = cacheKey
    listRef.current?.setList([], false)
    refreshCoverCaches()
    void fetchSongs(true)
  }, [active, cacheKey, fetchSongs])

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
