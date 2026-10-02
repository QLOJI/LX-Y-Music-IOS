import { memo, useEffect, useRef, useCallback } from 'react'
import { View } from 'react-native'
import OnlineList, { type OnlineListType } from '@/components/OnlineList'
import { toast } from '@/utils/tools'
import kgDailyRec from '@/utils/musicSdk/kg/dailyRec'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { stageOnlineListToDefault } from '@/core/playListToDefault'

type RecType = 'recommend' | 'everyday'

interface Props {
  type: RecType
}

const handlePlay = async(list: LX.Music.MusicInfoOnline[], listId: string, index = 0) => {
  // 酷狗每日推荐整份写入试听列表(DEFAULT)，不再走临时列表（见 core/list.ts playOnlineList 的说明）
  await stageOnlineListToDefault(listId, [...list], index)
}

export default memo(({ type }: Props) => {
  const listRef = useRef<OnlineListType>(null)
  const playerMusicInfo = usePlayerMusicInfo()

  // isPullRefresh（第 16 轮第 7 条）：只有用户真的下拉才用 'refreshing' 播下拉动画。
  // 首载走 'loading' —— 旧写法在挂载时也置 'refreshing'，iOS 刷新控件当场激活，把整个
  // 列表（含当时的页内标题）压下去、加载结束再弹回来，就是用户看到的「第一次进入向上刷新」。
  const fetchSongs = useCallback(async(isPullRefresh = false) => {
    try {
      listRef.current?.setStatus(isPullRefresh ? 'refreshing' : 'loading')
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

  useEffect(() => {
    void fetchSongs()
  }, [fetchSongs])

  const handleRefresh = useCallback(() => {
    void fetchSongs(true)
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
