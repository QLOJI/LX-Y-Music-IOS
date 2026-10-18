import playerActions from '@/store/player/action'
import playerState from '@/store/player/state'

import { getListMusicSync } from '@/utils/listManage'
import { setProgress } from '@/core/player/progress'
import { LIST_IDS } from '@/config/constant'


export const setMusicInfo = (musicInfo: Partial<LX.Player.MusicInfo>) => {
  playerActions.setMusicInfo(musicInfo)
}

export const setLoadErrorPicUrl = (url: string) => {
  playerActions.setLoadErrorPicUrl(url)
}

export const setLastLyric = (lrc?: string) => {
  playerActions.setLastLyric(lrc)
}

export const setPlayListId = (listId: string | null) => {
  playerActions.setPlayListId(listId)
}


/**
 * 更新播放位置
 * @returns 播放位置
 */
export const updatePlayIndex = () => {
  const indexInfo = getPlayIndex(playerState.playMusicInfo.listId, playerState.playMusicInfo.musicInfo, playerState.playMusicInfo.isTempPlay)
  // console.log('indexInfo', indexInfo)
  playerActions.updatePlayIndex(indexInfo.playIndex, indexInfo.playerPlayIndex)
  return indexInfo
}


export const getPlayIndex = (listId: string | null, musicInfo: LX.Download.ListItem | LX.Music.MusicInfo | null, isTempPlay: boolean): {
  playIndex: number
  playerPlayIndex: number
} => {
  const { playInfo } = playerState
  const playerList = getListMusicSync(playInfo.playerListId)

  // if (listIndex < 0) throw new Error('music info not found')
  // playInfo.playIndex = listIndex

  let playIndex = -1
  let playerPlayIndex = -1
  if (playerList.length) {
    playerPlayIndex = Math.min(playInfo.playerPlayIndex, playerList.length - 1)
  }

  const list = getListMusicSync(listId)
  if (list.length && musicInfo) {
    const currentId = musicInfo.id
    playIndex = list.findIndex(m => m.id == currentId)
    if (!isTempPlay) {
      if (playIndex < 0) {
        playerPlayIndex = playerPlayIndex < 1 ? (list.length - 1) : (playerPlayIndex - 1)
      } else {
        playerPlayIndex = playIndex
      }
    }
  }

  return {
    playIndex,
    playerPlayIndex,
  }
}

export const resetPlayerMusicInfo = () => {
  setMusicInfo({
    id: null,
    pic: null,
    lrc: null,
    tlrc: null,
    rlrc: null,
    lxlrc: null,
    rawlrc: null,
    name: '',
    singer: '',
    album: '',
  })
}

const setPlayerMusicInfo = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem | null) => {
  if (musicInfo) {
    setMusicInfo('progress' in musicInfo ? {
      id: musicInfo.id,
      pic: musicInfo.metadata.musicInfo.meta.picUrl,
      name: musicInfo.metadata.musicInfo.name,
      singer: musicInfo.metadata.musicInfo.singer,
      album: musicInfo.metadata.musicInfo.meta.albumName ?? '',
      lrc: null,
      tlrc: null,
      rlrc: null,
      lxlrc: null,
      rawlrc: null,
    } : {
      id: musicInfo.id,
      pic: musicInfo.meta.picUrl,
      name: musicInfo.name,
      singer: musicInfo.singer,
      album: musicInfo.meta.albumName ?? '',
      lrc: null,
      tlrc: null,
      rlrc: null,
      lxlrc: null,
      rawlrc: null,
    })
  } else resetPlayerMusicInfo()
}

/**
 * 设置当前播放歌曲的信息
 * @param listId 歌曲所属的列表id
 * @param musicInfo 歌曲信息
 * @param isTempPlay 是否临时播放
 */
export const setPlayMusicInfo = (listId: string | null, musicInfo: LX.Download.ListItem | LX.Music.MusicInfo | null, isTempPlay: boolean = false) => {
  // 【第 110 轮】**同一首歌**的再次装载不许清零进度：清零只属于「真的换歌」。
  // 现场日志：快速 seek 会触发同曲重新装载 → `setProgress(0, 0)` ⇒ 进度变 0/0 ⇒ 进度条、
  // 播完判定、暂停全部失灵（用户报的「点 3~5 次跳转后卡死」）。判据用歌曲 id 相等。
  const prevMusicId = playerState.playMusicInfo.musicInfo?.id
  playerActions.setPlayMusicInfo(listId, musicInfo, isTempPlay)
  setPlayerMusicInfo(musicInfo)

  // 【第 115 轮】清场（null）或**歌曲 id 真的变了**才清零。不再看 isPlay：缓冲会把 UI 收成
  // 暂停，而那一刻正是同曲重装最容易发生的时候 —— 旧判据会在那时把进度清成 0/0，进度条
  // 从此不可拖。同曲重装（取链重试 / seek 触发的重载）一律保留当前进度。
  if (musicInfo == null || (prevMusicId != null && prevMusicId !== musicInfo.id)) setProgress(0, 0)

  if (musicInfo == null) {
    playerActions.updatePlayIndex(-1, -1)
    setPlayListId(null)
  } else {
    const { playIndex, playerPlayIndex } = getPlayIndex(listId, musicInfo, isTempPlay)

    playerActions.updatePlayIndex(playIndex, playerPlayIndex)
    global.app_event.musicToggled()
  }
}

export const getList = (listId: string | null): LX.Music.MusicInfo[] | LX.Download.ListItem[] => {
  // return listId == LIST_ID_DOWNLOAD ? downloadList : getListMusicSync(listId)
  return listId == LIST_IDS.DOWNLOAD ? [] : getListMusicSync(listId)
}
