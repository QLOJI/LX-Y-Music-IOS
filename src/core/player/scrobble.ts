import playerState from '@/store/player/state'
import listState from '@/store/list/state'
import { LIST_IDS } from '@/config/constant'
import { getTopSourceInfo } from '@/core/playListToDefault'
import wyApi from '@/utils/musicSdk/wy/user'

export let scrobbleInfo: {
  songId: string | number
  sourceId: string
  totalTime: number
  accumulatedPlayedTime: number
  lastReportedTime: number
  isScrobbled?: boolean
} | null = null


export const updateScrobbleInfo = () => {
  const musicInfo = playerState.playMusicInfo.musicInfo
  const listId = playerState.playMusicInfo.listId
  if (!musicInfo || !('source' in musicInfo) || musicInfo.source !== 'wy') {
    scrobbleInfo = null
    return
  }

  let sourceId = ''
  const rawListId = listId === LIST_IDS.TEMP ? listState.tempListMeta.id : listId
  let sourceListId = rawListId
  if (rawListId === LIST_IDS.DEFAULT) {
    // 歌单/榜单/搜索点歌整份写入试听列表后，playMusicInfo.listId 变成 default，
    // 真实来源只记录在 playListToDefault 的「顶部这一段」里。带 playIndex 守卫：
    // 只有正在播的那一首确实位于这一段时才归给该歌单，避免把其下的旧歌误报给这份歌单。
    const top = getTopSourceInfo()
    const playIndex = playerState.playInfo.playIndex
    if (top.id && playIndex > -1 && playIndex < top.len) sourceListId = top.id
  }
  if (sourceListId) {
    if (sourceListId.startsWith('album_')) {
      sourceId = sourceListId.replace('album_', '')
    } else if (sourceListId.startsWith('wy__')) {
      sourceId = sourceListId.replace('wy__', '')
    } else if (sourceListId.startsWith('userlist_')) {
      const userListInfo = listState.userList.find(l => l.id === sourceListId)
      if (userListInfo?.source === 'wy' && userListInfo.sourceListId) {
        sourceId = userListInfo.sourceListId
      }
    }
  }

  scrobbleInfo = {
    songId: ('meta' in musicInfo) ? musicInfo.meta.songId : '',
    sourceId,
    totalTime: 0,
    accumulatedPlayedTime: 0,
    lastReportedTime: 0,
    isScrobbled: false,
  }
  console.log('Scrobble info updated for new song:', scrobbleInfo)
}

export const updateScrobblePlayTime = (currentTime: number) => {
  if (!scrobbleInfo || !playerState.isPlay) return

  const deltaTime = currentTime - scrobbleInfo.lastReportedTime

  if (deltaTime > 0 && deltaTime < 2) {
    scrobbleInfo.accumulatedPlayedTime += deltaTime
  }

  scrobbleInfo.lastReportedTime = currentTime

  if (!scrobbleInfo.isScrobbled) {
    const playedTime = Math.floor(scrobbleInfo.accumulatedPlayedTime)
    const { totalTime } = scrobbleInfo
    if (playedTime >= 120 || (totalTime > 0 && playedTime >= totalTime * 0.5)) {
      scrobbleInfo.isScrobbled = true
      console.log(`Scrobbling song realtime: ${scrobbleInfo.songId}, Source ID: '${scrobbleInfo.sourceId}', Time: ${playedTime}s`)
      void wyApi.scrobble(scrobbleInfo.songId, scrobbleInfo.sourceId, playedTime)
    }
  }
}

export const updateScrobbleTotalTime = (time: number) => {
  if (scrobbleInfo) {
    scrobbleInfo.totalTime = time
  }
}
