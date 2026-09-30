import { arrPush, arrUnshift, formatPlayTime2 } from '@/utils'
import { clamp01 } from '@/utils/tools'
import state from './state'

type PlayerMusicInfoKeys = keyof LX.Player.MusicInfo
const musicInfoKeys: PlayerMusicInfoKeys[] = Object.keys(state.musicInfo) as PlayerMusicInfoKeys[]

export default {
  updatePlayIndex(playIndex: number, playerPlayIndex: number) {
    state.playInfo.playIndex = playIndex
    state.playInfo.playerPlayIndex = playerPlayIndex

    global.state_event.playInfoChanged({ ...state.playInfo })
  },
  setPlayListId(playerListId: string | null) {
    state.playInfo.playerListId = playerListId

    global.state_event.playInfoChanged({ ...state.playInfo })
  },
  setPlayMusicInfo(
    listId: string | null,
    musicInfo: LX.Download.ListItem | LX.Music.MusicInfo | null,
    isTempPlay: boolean = false,
  ) {
    state.playMusicInfo = { listId, musicInfo, isTempPlay }

    global.state_event.playMusicInfoChanged(state.playMusicInfo)
  },
  setMusicInfo(_musicInfo: Partial<LX.Player.MusicInfo>) {
    for (const key of musicInfoKeys) {
      const val = _musicInfo[key]
      if (val !== undefined) {
        // @ts-expect-error
        state.musicInfo[key] = val
      }
    }

    global.state_event.playerMusicInfoChanged({ ...state.musicInfo })
  },
  setIsPlay(isPlay: boolean) {
    state.isPlay = isPlay

    global.state_event.playStateChanged(isPlay)
  },
  setStatusText(statusText: string) {
    state.statusText = statusText
    global.state_event.playStateTextChanged(statusText)
  },
  setNowPlayTime(time: number) {
    // 已播时间不得越过总时长（需求：「歌曲实际播放时间不能超过进度条上的总时长」）。
    // 为什么必须钳在这一处，而不是逐个调用点：
    //   1) 4Hz 原生位置快路径发布的是**歌词时钟外推值**（AppDelegate 里
    //      anchorElapsed + (now - anchorSystem) * rate），原生侧只有 MAX(0,…) 下限、
    //      没有 duration 上限钳制，播放到尾部 / 变速 / 缓冲抖动时会短暂越过总时长；
    //   2) 越过之后 progress 比例虽被下面的 clamp01 挡住（进度条不会冲出容器），
    //      但左侧时间文字取的是**未钳制**的 time，于是显示成「4:12 / 4:05」
    //      —— 这就是「播放时间超过最后进度条时间」最直观的样子；
    //   3) 歌词行点击 / 远程命令走 setProgress 也直接传原始秒数（歌词末行时间可能
    //      本就超出元数据时长），同一条不变量在这一处收口，覆盖面最广。
    // maxPlayTime 未就绪（切歌瞬间为 0）时不钳，否则会把真实位置压成 0。
    // 钳到恰好 maxPlayTime 不影响播完判定：判定用的是 `>= maxPlayTime`，等号依然成立。
    if (state.progress.maxPlayTime > 0 && time > state.progress.maxPlayTime) {
      time = state.progress.maxPlayTime
    }
    state.progress.nowPlayTime = time
    state.progress.nowPlayTimeStr = formatPlayTime2(time)
    // 比例必须钳到 [0,1]：切歌/时长未就绪时 nowPlayTime 可能大于（尚未刷新的）maxPlayTime，
    // 不钳会让进度条冲过 100%（对齐 REF store/player/action 的 calcProgress 兜底）。
    state.progress.progress = state.progress.maxPlayTime ? clamp01(time / state.progress.maxPlayTime) : 0

    global.state_event.playProgressChanged({ ...state.progress })
  },
  setMaxplayTime(time: number) {
    state.progress.maxPlayTime = time
    state.progress.maxPlayTimeStr = formatPlayTime2(time)
    // 同理，防止旧的 nowPlayTime 残留造成比例越界（time 为 0 时直接归零，避免 NaN）。
    state.progress.progress = time ? clamp01(state.progress.nowPlayTime / time) : 0

    global.state_event.playProgressChanged({ ...state.progress })
  },
  setProgress(currentTime: number, totalTime: number) {
    // 与 setNowPlayTime 同一条不变量：已播时间不得越过总时长（切歌的 setProgress(0,0)
    // 不受影响——totalTime 为 0 时不钳）。
    if (totalTime > 0 && currentTime > totalTime) currentTime = totalTime
    state.progress.nowPlayTime = currentTime
    state.progress.nowPlayTimeStr = formatPlayTime2(currentTime)
    state.progress.maxPlayTime = totalTime
    state.progress.maxPlayTimeStr = formatPlayTime2(totalTime)
    // 进度比例必须是「已播放 / 总时长」。原写法为 nowPlayTime / currentTime（两者相等），
    // 结果恒为 1（currentTime 为 0 时更是 NaN），切歌瞬间进度条会直接满格 / 崩成 NaN。
    state.progress.progress = totalTime > 0 ? clamp01(currentTime / totalTime) : 0

    global.state_event.playProgressChanged({ ...state.progress })
  },
  addPlayedList(info: LX.Player.PlayMusicInfo) {
    if (state.playedList.some((m) => m.musicInfo.id == info.musicInfo.id)) return
    state.playedList.push(info)

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  removePlayedList(index: number) {
    state.playedList.splice(index, 1)

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  clearPlayedList() {
    state.playedList = []

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  addTempPlayList(list: LX.Player.TempPlayListItem[]) {
    const topList: Array<{
      listId: string | null
      musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
    }> = []
    const bottomList = list.filter(({ isTop, ...musicInfo }) => {
      if (isTop) {
        topList.push(musicInfo)
        return false
      }
      return true
    })
    if (topList.length) {
      arrUnshift(
        state.tempPlayList,
        topList.map(({ musicInfo, listId }) => ({ musicInfo, listId, isTempPlay: true })) as any,
      )
    }
    if (bottomList.length) {
      arrPush(
        state.tempPlayList,
        bottomList.map(({ musicInfo, listId }) => ({ musicInfo, listId, isTempPlay: true })) as any,
      )
    }

    global.state_event.playTempPlayListChanged([...state.tempPlayList])
  },
  removeTempPlayList(index: number) {
    state.tempPlayList.splice(index, 1)

    global.state_event.playTempPlayListChanged([...state.tempPlayList])
  },
  clearTempPlayeList() {
    state.tempPlayList = []

    global.state_event.playTempPlayListChanged([...state.tempPlayList])
  },
  setLoadErrorPicUrl(url: string) {
    state.loadErrorPicUrl = url
  },
  setLastLyric(lrc?: string) {
    state.lastLyric = lrc
  },
}
