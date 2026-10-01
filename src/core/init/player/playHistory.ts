import playerState from '@/store/player/state'
import { addPlayHistory } from '@/core/player/playHistory'
import { getTopSourceInfo } from '@/core/playListToDefault'
import { LIST_IDS } from '@/config/constant'
import listState from '@/store/list/state'

const MIN_PLAY_TIME = 2 * 60
const MIN_PLAY_RATIO = 0.5

export default () => {
  let currentMusicInfo: LX.Music.MusicInfo | null = null
  let currentListId: string | null = null
  let isRecorded = false

  const handleMusicToggled = () => {
    const playMusicInfo = playerState.playMusicInfo
    const musicInfoRaw = playMusicInfo.musicInfo
    isRecorded = false
    currentMusicInfo = null
    currentListId = null
    if (!musicInfoRaw) return

    currentMusicInfo = 'progress' in musicInfoRaw ? musicInfoRaw.metadata.musicInfo : musicInfoRaw
    const listId = playMusicInfo.listId
    if (listId === LIST_IDS.DEFAULT) {
      // 歌单/榜单/搜索点歌整份写入试听列表后，listId 是 default，真实来源记录在
      // playListToDefault 的「顶部这一段」里。带 playIndex 守卫（playInfo.ts 先
      // updatePlayIndex 再 emit musicToggled，这里读到的下标已经是对的）：
      // 只有正在播的那一首确实位于这一段时才归给它，否则维持 'default' 走原有兜底来源。
      const top = getTopSourceInfo()
      const playIndex = playerState.playInfo.playIndex
      currentListId = top.id && playIndex > -1 && playIndex < top.len ? top.id : listId
    } else if (listId === LIST_IDS.TEMP) {
      currentListId = listState.tempListMeta.id ?? listId
    } else {
      currentListId = listId
    }
  }

  const handlePlayProgressChanged: typeof global.state_event.playProgressChanged = (progress) => {
    if (isRecorded || !currentMusicInfo) return
    if (progress.nowPlayTime < MIN_PLAY_TIME && (!progress.maxPlayTime || progress.nowPlayTime / progress.maxPlayTime < MIN_PLAY_RATIO)) return

    isRecorded = true
    void addPlayHistory({
      musicInfo: currentMusicInfo,
      playTime: progress.nowPlayTime,
      maxTime: progress.maxPlayTime,
      listId: currentListId,
    })
  }

  global.app_event.on('musicToggled', handleMusicToggled)
  global.state_event.on('playProgressChanged', handlePlayProgressChanged)
}
