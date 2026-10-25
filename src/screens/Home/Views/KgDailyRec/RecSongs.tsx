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
  /** 【第 191 轮】只有当前 tab 才自动刷新：每次启动每个 tab 只自动下拉一次。 */
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

  // 【第 191 轮】去掉加载中界面：无论首载还是刷新都用下拉动画（'refreshing'）。
  const fetchSongs = useCallback(async() => {
    try {
      listRef.current?.setStatus('refreshing')
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

  // 挂载先还原本次启动里上次拿到的列表（页面离开会卸载），再决定要不要自动下拉。
  useEffect(() => {
    const cached = getDailyRecSessionList<LX.Music.MusicInfoOnline[]>(cacheKey)
    if (cached?.length) listRef.current?.setList(cached, false)
  }, [cacheKey])

  useEffect(() => {
    if (!active) return
    if (!takeDailyRecAutoRefresh(cacheKey)) return
    refreshCoverCaches()
    void fetchSongs()
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
