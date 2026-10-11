import { isInitialized, initial as playerInitial, isEmpty, isEngineOnMusic, setPause, setPlay, setResource, setStop, initTrackInfo, getPosition } from '@/plugins/player'
import {
  setStatusText,
} from '@/core/player/playStatus'
import { setProgress as updatePlayProgress } from '@/core/player/progress'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import {
  getList,
  setPlayMusicInfo,
  setMusicInfo,
  setPlayListId,
} from '@/core/player/playInfo'
import {
  clearPlayedList,
  addPlayedList,
  removePlayedList,
} from '@/core/player/playedList'
import {
  clearTempPlayeList,
  removeTempPlayList,
} from '@/core/player/tempPlayList'
import { getMusicUrlInfo, getPicPath, getLyricInfo } from '@/core/music'
import { removeMusicUrlAll } from '@/core/music/utils'
import { requestMsg } from '@/utils/message'
import { getRandom } from '@/utils/common'
import { filterList } from './utils'
import BackgroundTimer from 'react-native-background-timer'
import { checkIgnoringBatteryOptimization, checkNotificationPermission, debounceBackgroundTimer } from '@/utils/tools'
import { LIST_IDS } from '@/config/constant'
import { addListMusics, removeListMusics } from '@/core/list'
import { addDislikeInfo } from '@/core/dislikeList'
import { markTimeoutExitInteraction } from './timeoutExit'
import { markManualPause } from './manualPause'

// import { checkMusicFileAvailable } from '@renderer/utils/music'

const createDelayNextTimeout = (delay: number) => {
  let timeout: number | null
  const clearDelayNextTimeout = () => {
    // console.log(this.timeout)
    if (timeout) {
      BackgroundTimer.clearTimeout(timeout)
      timeout = null
    }
  }

  const addDelayNextTimeout = () => {
    clearDelayNextTimeout()
    timeout = BackgroundTimer.setTimeout(() => {
      timeout = null
      if (global.lx.isPlayedStop) return
      void playNext(true)
    }, delay)
  }

  return {
    clearDelayNextTimeout,
    addDelayNextTimeout,
  }
}
const { addDelayNextTimeout, clearDelayNextTimeout } = createDelayNextTimeout(5000)
const { addDelayNextTimeout: addLoadTimeout, clearDelayNextTimeout: clearLoadTimeout } = createDelayNextTimeout(100000)

const createGettingUrlId = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem) => {
  const tInfo = 'progress' in musicInfo ? musicInfo.metadata.musicInfo.meta.toggleMusicInfo : musicInfo.meta.toggleMusicInfo
  return `${musicInfo.id}_${tInfo?.id ?? ''}`
}

interface PlayUrlInfo {
  url: string
  quality: LX.Quality | null
}
const currentStreamInfo = {
  musicId: null as string | null,
  url: '',
  quality: null as LX.Quality | null,
}
/**
 * 检查音乐信息是否已更改
 */
const diffCurrentMusicInfo = (curMusicInfo: LX.Music.MusicInfo | LX.Download.ListItem): boolean => {
  // return curMusicInfo !== playerState.playMusicInfo.musicInfo || playerState.isPlay
  return createGettingUrlId(curMusicInfo) != global.lx.gettingUrlId || curMusicInfo.id != playerState.playMusicInfo.musicInfo?.id || playerState.isPlay
}

let cancelDelayRetry: (() => void) | null = null
const delayRetry = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh = false): Promise<PlayUrlInfo | null> => {
  // if (cancelDelayRetry) cancelDelayRetry()
  return new Promise<PlayUrlInfo | null>((resolve, reject) => {
    const time = getRandom(2, 6)
    setStatusText(global.i18n.t('player__getting_url_delay_retry', { time }))
    const tiemout = setTimeout(() => {
      getMusicPlayUrl(musicInfo, isRefresh, true).then((result) => {
        cancelDelayRetry = null
        resolve(result)
      }).catch(async(err: any) => {
        cancelDelayRetry = null
        reject(err)
      })
    }, time * 1000)
    cancelDelayRetry = () => {
      clearTimeout(tiemout)
      cancelDelayRetry = null
      resolve(null)
    }
  })
}
const getMusicPlayUrl = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh = false, isRetryed = false, quality?: LX.Quality): Promise<PlayUrlInfo | null> => {
  // this.musicInfo.url = await getMusicPlayUrl(targetSong, type)
  setStatusText(global.i18n.t('player__getting_url'))
  addLoadTimeout()

  // const type = getPlayType(settingState.setting['player.isPlayHighQuality'], musicInfo)
  let toggleMusicInfo = ('progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo).meta.toggleMusicInfo

  return (toggleMusicInfo ? getMusicUrlInfo({
    musicInfo: toggleMusicInfo,
    isRefresh,
    quality,
    allowToggleSource: false,
  }) : Promise.reject(new Error('not found'))).catch(async() => {
    return getMusicUrlInfo({
      musicInfo,
      isRefresh,
      quality,
      onToggleSource(_mInfo) {
        if (diffCurrentMusicInfo(musicInfo)) return
        setStatusText(global.i18n.t('toggle_source_try'))
      },
    })
  }).then(url => {
    if (global.lx.isPlayedStop || diffCurrentMusicInfo(musicInfo)) return null

    return url
  }).catch(async err => {
    // console.log('err', err.message)
    if (global.lx.isPlayedStop ||
      diffCurrentMusicInfo(musicInfo) ||
      err.message == requestMsg.cancelRequest) return null

    if (err.message == requestMsg.tooManyRequests) return delayRetry(musicInfo, isRefresh)

    if (!isRetryed) return getMusicPlayUrl(musicInfo, isRefresh, true, quality)

    throw err
  })
}

// 启动恢复的一次性 seek 意图：handleRestorePlay 写入、setMusicUrl 消费后即清。
// 旧实现非刷新路径直接取 playerState.progress.nowPlayTime —— 切歌时该值是旧歌的
// 残留位置（handleStop 归零走异步 stop 事件，与 debounce 后的 URL 加载竞态），
// 捕获到旧值就把新歌 seek 到旧位置 = 「切歌不从头上播放」（真机有概率复现）。
// 再补一层歌曲 id 绑定：一个裸数字不区分「这是哪首歌的恢复意图」，恢复曲加载
// 失败/被取消时意图会残留（旧实现只在成功分支清），被 5s 后自动跳歌或用户手动
// 点播的任意一首歌误消费，再次把新歌 seek 到旧进度——带 id 后按歌匹配，
// 任何「另一首歌先加载」的路径都因 id 不匹配自然丢弃该意图。
// 【第 53 轮第 1 条】id 匹配仍挡不住「同一首歌被再次播放」（单曲循环重播 / 随机连抽同一首 /
// 手动重播），所以消费再加一道开关：只有 setMusicUrl 的 allowRestoreSeek=true（即 play()
// 恢复上次播放）能拿到这个时间，其余调用一律 0 起播——见 setMusicUrl 的说明与 play()。
let pendingRestoreSeek: { id: string, time: number } | null = null

// 【第 53 轮第 2 条】刷新取链前的缓存作废：走到 isRefresh 说明「上一次拿到的链接已被判定
// 不可用」（加载错误 / 降级 / 25s 加载超时，见 controller.ts），此时这条链接的缓存必须整体
// 作废，否则它永远是下一次读取的**首选命中**——重取到的好链接按达成档另存一条，坏链那条
// 键还在原位，于是每次重播都变成「命中坏链 → 失败 → 再请求一次」，正好是用户要消灭的
// 重复取链（用户原话：「如果链接可用，将不再获取歌曲链接……为接口减轻负担」）。
//
// 必须 await 完再取链：取链成功后会 saveMusicUrl 写回缓存，先清后写才是「旧键作废 + 新键
// 生效」；若并发清（不 await），这次写入可能被随后的删除一起带走，缓存反而被清空。
//
// 两首歌都要清：getMusicPlayUrl 优先按 meta.toggleMusicInfo（换源后的目标曲）取链，
// 坏链可能挂在那首的 id 下，只清本曲等于没清。
const invalidateUrlCacheOnRefresh = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem) => {
  const baseInfo = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
  const toggleMusicInfo = baseInfo.meta.toggleMusicInfo
  await Promise.all([
    removeMusicUrlAll(musicInfo).catch(() => {}),
    toggleMusicInfo ? removeMusicUrlAll(toggleMusicInfo).catch(() => {}) : Promise.resolve(),
  ])
}

/**
 * 取链并装载资源。`allowRestoreSeek` 是本函数唯一的「允许从非 0 位置起播」开关：
 * 只有 `play()`（恢复上次播放）那条调用传 true，切歌 / 重播 / 失败重取一律 false。
 */
export const setMusicUrl = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh?: boolean, quality?: LX.Quality, allowRestoreSeek = false) => {
  // addLoadTimeout()
  if (!diffCurrentMusicInfo(musicInfo)) return
  if (cancelDelayRetry) cancelDelayRetry()
  global.lx.gettingUrlId = createGettingUrlId(musicInfo)
  // 恢复意图的消费点必须前移到「发起请求之前」，且无论是否匹配都无条件清空：
  // - 前移：请求存在 result=null（取消/竞态）与抛错（走 5s 延迟跳歌）等中断分支，
  //   旧实现把清空放在成功分支里，这些路径会把意图留下来给下一首歌消费——跨歌
  //   续播旧进度的泄漏口；在任何 await 之前消费，加载失败/被取消同样丢弃意图。
  // - 无条件清空：意图是一次性的，本次加载若不是它的目标曲（另一首歌先加载），
  //   它就已经过期，留着只会污染后续歌曲。
  // - id 匹配：只有恢复曲本身的首次非刷新加载能拿到恢复时间，从保存进度起播。
  //   【第 53 轮第 1 条】两侧 id 都必须非空：`null == null` 会退化成相等，裸意图漏给下一首。
  // - 【第 53 轮第 1 条】只有 allowRestoreSeek 的那条路径能消费：id 匹配是**不够**的，
  //   它挡不住「同一首歌的第二次播放」——单曲循环自动重播、随机连抽到同一首、手动点播
  //   当前正在放的这首，id 全都相等，旧逻辑就把「上次退出时的保存进度」当成这次的起播
  //   位置，正是用户报的「下一首歌从 1:00 开始放」（用户原话：上一首/下一首都要从头播放）。
  //   本函数的调用方里只有 play() 是「恢复上次播放」，其余（debouncePlay / isRefresh 重取）
  //   都必须 0 起播，所以开关由调用方显式给出，而不是在这里猜。
  const canConsumeRestoreSeek = allowRestoreSeek && !isRefresh &&
    pendingRestoreSeek != null && pendingRestoreSeek.id != null && musicInfo.id != null &&
    pendingRestoreSeek.id === musicInfo.id
  const restoreTime = canConsumeRestoreSeek && pendingRestoreSeek ? pendingRestoreSeek.time : 0
  pendingRestoreSeek = null
  // 【第 53 轮第 1 条】刷新重取的位置同样要「引擎真在放这首歌」才允许沿用。
  // 旧实现无条件取 getPosition()：引擎此刻停在哪，这个数就是哪首歌的——包括上一首的
  // 残留位置（错误/降级/加载超时这几条 isRefresh 路径上，引擎可能还装着旧资源）。
  // 那种情况下新歌就被 seek 到旧歌的位置（用户报的 1:00 起播的另一条通路）。
  // isEngineOnMusic 按引擎曲目 id 比对（nativeflac://<id> / <id>__//…），确认是同一首才沿用。
  const currentTimePromise = isRefresh && isEngineOnMusic(musicInfo)
    ? getPosition().catch(() => playerState.progress.nowPlayTime)
    // 非 refresh = 新歌：仅恢复曲的首次加载携带显式恢复时间，其余一律从 0 开始
    : Promise.resolve(isRefresh ? 0 : restoreTime)
  void (async() => {
    // 【第 53 轮第 2 条】刷新 = 这条链接已被判定不可用，先作废缓存再取链（顺序不可颠倒，见函数注释）
    if (isRefresh) await invalidateUrlCacheOnRefresh(musicInfo)
    return getMusicPlayUrl(musicInfo, isRefresh, false, quality)
  })().then(async(result) => {
    if (!result) return
    const currentTime = await currentTimePromise
    currentStreamInfo.musicId = musicInfo.id
    currentStreamInfo.url = result.url
    currentStreamInfo.quality = result.quality
    setResource(musicInfo, result.url, currentTime, result.quality)
  }).catch((err: any) => {
    setStatusText(err.message as string)
    global.app_event.error()
    addDelayNextTimeout()
  }).finally(() => {
    if (musicInfo === playerState.playMusicInfo.musicInfo) {
      global.lx.gettingUrlId = ''
      clearLoadTimeout()
    }
  })
}

// 恢复上次播放的状态
const handleRestorePlay = async(restorePlayInfo: LX.Player.SavedPlayInfo) => {
  const musicInfo = playerState.playMusicInfo.musicInfo
  if (!musicInfo) return

  // Avoid seeking the 2-second placeholder track during startup restore.
  const restoreTime = settingState.setting['player.isSavePlayTime'] ? restorePlayInfo.time : 0
  // 绑定歌曲 id，交给随后的 setMusicUrl 精确 seek（一次性、只有该曲的非刷新加载会消费）
  pendingRestoreSeek = { id: musicInfo.id, time: Math.max(0, restoreTime) }
  updatePlayProgress(restoreTime, restorePlayInfo.maxTime)
  global.app_event.seekLyric(restoreTime)

  const playMusicInfo = playerState.playMusicInfo

  void initTrackInfo(musicInfo, playerState.musicInfo)

  void getPicPath({ musicInfo, listId: playMusicInfo.listId }).then((url: string) => {
    if (
      musicInfo.id != playMusicInfo.musicInfo?.id ||
      playerState.musicInfo.pic == url ||
      playerState.loadErrorPicUrl == url
    ) return
    setMusicInfo({ pic: url })
    global.app_event.picUpdated()
  })

  void getLyricInfo({ musicInfo }).then((lyricInfo) => {
    if (musicInfo.id != playMusicInfo.musicInfo?.id) return
    setMusicInfo({
      lrc: lyricInfo.lyric,
      tlrc: lyricInfo.tlyric,
      lxlrc: lyricInfo.lxlyric,
      rlrc: lyricInfo.rlyric,
      rawlrc: lyricInfo.rawlrcInfo.lyric,
    })
    global.app_event.lyricUpdated()
  }).catch((err) => {
    console.log(err)
    if (musicInfo.id != playMusicInfo.musicInfo?.id) return
    setStatusText(global.i18n.t('lyric__load_error'))
  })

  if (settingState.setting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) addPlayedList(playMusicInfo as LX.Player.PlayMusicInfo)
}


const debouncePlay = debounceBackgroundTimer((musicInfo: LX.Player.PlayMusic) => {
  setMusicUrl(musicInfo)

  void getPicPath({ musicInfo, listId: playerState.playMusicInfo.listId }).then((url: string) => {
    if (
      musicInfo.id != playerState.playMusicInfo.musicInfo?.id ||
      playerState.musicInfo.pic == url ||
      playerState.loadErrorPicUrl == url) return
    setMusicInfo({ pic: url })
    global.app_event.picUpdated()
  })

  void getLyricInfo({ musicInfo }).then((lyricInfo) => {
    if (musicInfo.id != playerState.playMusicInfo.musicInfo?.id) return
    setMusicInfo({
      lrc: lyricInfo.lyric,
      tlrc: lyricInfo.tlyric,
      lxlrc: lyricInfo.lxlyric,
      rlrc: lyricInfo.rlyric,
      rawlrc: lyricInfo.rawlrcInfo.lyric,
    })
    global.app_event.lyricUpdated()
  }).catch((err) => {
    console.log(err)
    if (musicInfo.id != playerState.playMusicInfo.musicInfo?.id) return
    setStatusText(global.i18n.t('lyric__load_error'))
  })
}, 200)

// 处理音乐播放
const handlePlay = async() => {
  if (!isInitialized()) {
    await checkNotificationPermission()
    void checkIgnoringBatteryOptimization()
    await playerInitial({
      volume: settingState.setting['player.volume'],
      playRate: settingState.setting['player.playbackRate'],
      cacheSize: settingState.setting['player.cacheSize'] ? parseInt(settingState.setting['player.cacheSize']) : 0,
      isHandleAudioFocus: settingState.setting['player.isHandleAudioFocus'],
      isEnableAudioOffload: settingState.setting['player.isEnableAudioOffload'],
    })
  }

  global.lx.isPlayedStop &&= false
  resetRandomNextMusicInfo()

  if (global.lx.restorePlayInfo) {
    void handleRestorePlay(global.lx.restorePlayInfo)
    global.lx.restorePlayInfo = null
    return
  }

  const playMusicInfo = playerState.playMusicInfo
  const musicInfo = playMusicInfo.musicInfo

  if (!musicInfo) return

  await setStop()
  global.app_event.pause()

  clearDelayNextTimeout()
  clearLoadTimeout()


  if (settingState.setting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) addPlayedList(playMusicInfo as LX.Player.PlayMusicInfo)

  debouncePlay(musicInfo)
}

/**
 * 播放列表内歌曲
 * @param listId 列表id
 * @param id 歌曲id
 */
export const playListById = async(listId: string, id: string) => {
  const prevListId = playerState.playInfo.playerListId
  setPlayListId(listId)
  const musicInfo = getList(listId).find(m => m.id == id)
  if (!musicInfo) return
  setPlayMusicInfo(listId, musicInfo)
  if (settingState.setting['player.isAutoCleanPlayedList'] || prevListId != listId) clearPlayedList()
  clearTempPlayeList()
  await handlePlay()
}

/**
 * 播放列表内歌曲
 * @param listId 列表id
 * @param index 播放的歌曲位置
 */
export const playList = async(listId: string, index: number) => {
  const prevListId = playerState.playInfo.playerListId
  setPlayListId(listId)
  setPlayMusicInfo(listId, getList(listId)[index])
  if (settingState.setting['player.isAutoCleanPlayedList'] || prevListId != listId) clearPlayedList()
  clearTempPlayeList()
  await handlePlay()
}

/**
 * 长按迷你播放器封面时应该跳转到的「来源列表」id（本地增强，上游没有）。
 *
 * 正常情况下就是当前播放歌曲的来源列表（playMusicInfo.listId）。但「稍后播放」队列里的歌
 * 在入队时写死 listId 为空（见 components/OnlineList/listAction.ts 的 handlePlayLater，
 * 本地文件 / WebDAV 那几处写 null）——这类歌不在任何列表里，播放时 playMusicInfo.listId
 * 是空值，上游在长按入口 `if (!listId) return` 直接早退，表现为「长按完全没反应」。
 * 这里回退到播放器当前正在迭代的列表（playInfo.playerListId：「稍后播放」只是插播，
 * 插播结束后下一曲仍然回到这条列表），跳到「我的」并打开它。
 * 这首歌本身若不在该列表里，就只打开列表、不按下标定位（见 Mylist/MusicList/List.tsx 的守卫）。
 */
export const getJumpListId = (): string => {
  const listId = playerState.playMusicInfo.listId
  if (listId) return listId
  return playerState.playInfo.playerListId ?? ''
}

const handleToggleStop = async() => {
  await stop()
  setTimeout(() => {
    setPlayMusicInfo(null, null)
  })
}


const randomNextMusicInfo = {
  info: null as LX.Player.PlayMusicInfo | null,
  // index: -1,
}
export const resetRandomNextMusicInfo = () => {
  if (randomNextMusicInfo.info) {
    randomNextMusicInfo.info = null
    // randomNextMusicInfo.index = -1
  }
}

export const getNextPlayMusicInfo = async(): Promise<LX.Player.PlayMusicInfo | null> => {
  if (playerState.tempPlayList.length) { // 如果稍后播放列表存在歌曲则直接播放改列表的歌曲
    const playMusicInfo = playerState.tempPlayList[0]
    return playMusicInfo
  }

  if (playerState.playMusicInfo.musicInfo == null) return null

  if (randomNextMusicInfo.info) return randomNextMusicInfo.info

  const playMusicInfo = playerState.playMusicInfo
  const playInfo = playerState.playInfo
  // console.log(playInfo.playerListId)
  const currentListId = playInfo.playerListId
  if (!currentListId) return null
  const currentList = getList(currentListId)

  const playedList = playerState.playedList
  if (playedList.length) { // 移除已播放列表内不存在原列表的歌曲
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const musicInfo = currentList[playInfo.playerPlayIndex]
      if (musicInfo) currentId = musicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo!.id
    }
    // 从已播放列表移除播放列表已删除的歌曲
    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) + 1; index < playedList.length; index++) {
      const playMusicInfo = playedList[index]
      const currentId = playMusicInfo.musicInfo.id
      if (playMusicInfo.listId == currentListId && !currentList.some(m => m.id === currentId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index < playedList.length) return playedList[index]
  }
  // const isCheckFile = findNum > 2 // 针对下载列表，如果超过两次都碰到无效歌曲，则过滤整个列表内的无效歌曲
  let { filteredList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: true,
  })

  if (!filteredList.length) return null
  // let currentIndex: number = filteredList.indexOf(currentList[playInfo.playerPlayIndex])
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex

  let togglePlayMethod = settingState.setting['player.togglePlayMethod']
  switch (togglePlayMethod) {
    case 'listLoop':
      nextIndex = playerIndex === filteredList.length - 1 ? 0 : playerIndex + 1
      break
    case 'random':
      nextIndex = getRandom(0, filteredList.length)
      break
    case 'list':
      nextIndex = playerIndex === filteredList.length - 1 ? -1 : playerIndex + 1
      break
    case 'singleLoop':
      break
    default:
      return null
  }
  if (nextIndex < 0) return null

  const nextPlayMusicInfo = {
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  }

  if (togglePlayMethod == 'random') {
    randomNextMusicInfo.info = nextPlayMusicInfo
    // randomNextMusicInfo.index = nextIndex
  }
  return nextPlayMusicInfo
}

const handlePlayNext = async(playMusicInfo: LX.Player.PlayMusicInfo) => {
  setPlayMusicInfo(playMusicInfo.listId, playMusicInfo.musicInfo, playMusicInfo.isTempPlay)
  await handlePlay()
}
/**
 * 下一曲
 * @param isAutoToggle 是否自动切换
 * @returns
 */
export const playNext = async(isAutoToggle = false): Promise<void> => {
  if (!isAutoToggle) markTimeoutExitInteraction()
  if (playerState.tempPlayList.length) { // 如果稍后播放列表存在歌曲则直接播放改列表的歌曲
    const playMusicInfo = playerState.tempPlayList[0]
    removeTempPlayList(0)
    await handlePlayNext(playMusicInfo)
    return
  }

  const playMusicInfo = playerState.playMusicInfo
  const playInfo = playerState.playInfo
  if (playMusicInfo.musicInfo == null) return handleToggleStop()

  // console.log(playInfo.playerListId)
  const currentListId = playInfo.playerListId
  if (!currentListId) return handleToggleStop()
  const currentList = getList(currentListId)

  const playedList = playerState.playedList

  if (playedList.length) { // 移除已播放列表内不存在原列表的歌曲
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const musicInfo = currentList[playInfo.playerPlayIndex]
      if (musicInfo) currentId = musicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo.id
    }
    // 从已播放列表移除播放列表已删除的歌曲
    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) + 1; index < playedList.length; index++) {
      const playMusicInfo = playedList[index]
      const currentId = playMusicInfo.musicInfo.id
      if (playMusicInfo.listId == currentListId && !currentList.some(m => m.id === currentId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index < playedList.length) {
      await handlePlayNext(playedList[index])
      return
    }
  }
  if (randomNextMusicInfo.info) {
    await handlePlayNext(randomNextMusicInfo.info)
    return
  }
  // const isCheckFile = findNum > 2 // 针对下载列表，如果超过两次都碰到无效歌曲，则过滤整个列表内的无效歌曲
  let { filteredList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: true,
  })

  if (!filteredList.length) return handleToggleStop()
  // let currentIndex: number = filteredList.indexOf(currentList[playInfo.playerPlayIndex])
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex

  let togglePlayMethod = settingState.setting['player.togglePlayMethod']
  if (!isAutoToggle) {
    switch (togglePlayMethod) {
      case 'list':
      case 'singleLoop':
      case 'none':
        togglePlayMethod = 'listLoop'
    }
  }
  switch (togglePlayMethod) {
    case 'listLoop':
      nextIndex = playerIndex === filteredList.length - 1 ? 0 : playerIndex + 1
      break
    case 'random':
      nextIndex = getRandom(0, filteredList.length)
      break
    case 'list':
      nextIndex = playerIndex === filteredList.length - 1 ? -1 : playerIndex + 1
      break
    case 'singleLoop':
      break
    default:
      nextIndex = -1
      return
  }
  if (nextIndex < 0) return

  await handlePlayNext({
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  })
}

/**
 * 上一曲
 */
export const playPrev = async(isAutoToggle = false): Promise<void> => {
  if (!isAutoToggle) markTimeoutExitInteraction()
  const playMusicInfo = playerState.playMusicInfo
  if (playMusicInfo.musicInfo == null) return handleToggleStop()
  const playInfo = playerState.playInfo

  const currentListId = playInfo.playerListId
  if (!currentListId) return handleToggleStop()
  const currentList = getList(currentListId)

  const playedList = playerState.playedList
  if (playedList.length) {
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const musicInfo = currentList[playInfo.playerPlayIndex]
      if (musicInfo) currentId = musicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo.id
    }
    // 从已播放列表移除播放列表已删除的歌曲
    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) - 1; index > -1; index--) {
      const playMusicInfo = playedList[index]
      const currentId = playMusicInfo.musicInfo.id
      if (playMusicInfo.listId == currentListId && !currentList.some(m => m.id === currentId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index > -1) {
      await handlePlayNext(playedList[index])
      return
    }
  }

  // const isCheckFile = findNum > 2
  let { filteredList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: false,
  })
  if (!filteredList.length) return handleToggleStop()

  // let currentIndex = filteredList.indexOf(currentList[playInfo.playerPlayIndex])
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex
  if (!playMusicInfo.isTempPlay) {
    let togglePlayMethod = settingState.setting['player.togglePlayMethod']
    if (!isAutoToggle) {
      switch (togglePlayMethod) {
        case 'list':
        case 'singleLoop':
        case 'none':
          togglePlayMethod = 'listLoop'
      }
    }
    switch (togglePlayMethod) {
      case 'random':
        nextIndex = getRandom(0, filteredList.length)
        break
      case 'listLoop':
      case 'list':
        nextIndex = playerIndex === 0 ? filteredList.length - 1 : playerIndex - 1
        break
      case 'singleLoop':
        break
      default:
        nextIndex = -1
        return
    }
    if (nextIndex < 0) return
  }


  await handlePlayNext({
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  })
}

/**
 * 恢复播放
 */
export const play = () => {
  if (playerState.playMusicInfo.musicInfo == null) return
  if (isEmpty()) {
    // 【第 53 轮第 1 条】这里是「恢复上次播放」的**唯一**入口（启动恢复由 init/player/playInfo.ts
    // 的 setTimeout(play) 或用户点播放触发，handleRestorePlay 写入的恢复意图只该在这里被消费），
    // 所以第四参传 true —— 其余任何 setMusicUrl 调用点都必须从 0 起播。
    if (createGettingUrlId(playerState.playMusicInfo.musicInfo) != global.lx.gettingUrlId) setMusicUrl(playerState.playMusicInfo.musicInfo, false, undefined, true)
    return
  }
  void setPlay()
}

/**
 * 暂停播放
 */
export const pause = async() => {
  await setPause()
}

/**
 * 停止播放
 */
export const stop = async() => {
  await setStop()
  setTimeout(() => {
    global.app_event.stop()
  })
}

/**
 * 播放、暂停播放切换
 */
export const togglePlay = () => {
  markTimeoutExitInteraction()
  global.lx.isPlayedStop &&= false
  if (playerState.isPlay) {
    // 【第 22 轮】用户主动按了暂停：落下「手动暂停」闸门（core/player/manualPause.ts），
    // 在此之前系统抢占/回到前台等任何自动续播路径都不许再出声。复位只由「播放真正开始」触发。
    markManualPause()
    void pause()
  } else {
    play()
  }
}

/**
 * 收藏当前播放的歌曲
 */
export const collectMusic = () => {
  if (!playerState.playMusicInfo.musicInfo) return
  void addListMusics(LIST_IDS.LOVE, [
    'progress' in playerState.playMusicInfo.musicInfo
      ? playerState.playMusicInfo.musicInfo.metadata.musicInfo
      : playerState.playMusicInfo.musicInfo,
  ], settingState.setting['list.addMusicLocationType'])
}

/**
 * 取消收藏当前播放的歌曲
 */
export const uncollectMusic = () => {
  if (!playerState.playMusicInfo.musicInfo) return
  void removeListMusics(LIST_IDS.LOVE, [
    'progress' in playerState.playMusicInfo.musicInfo
      ? playerState.playMusicInfo.musicInfo.metadata.musicInfo.id
      : playerState.playMusicInfo.musicInfo.id,
  ])
}

/**
 * 不喜欢当前播放的歌曲
 */
export const dislikeMusic = async() => {
  if (!playerState.playMusicInfo.musicInfo) return
  const minfo = 'progress' in playerState.playMusicInfo.musicInfo ? playerState.playMusicInfo.musicInfo.metadata.musicInfo : playerState.playMusicInfo.musicInfo
  await addDislikeInfo([{ name: minfo.name, singer: minfo.singer }])
  await playNext(true)
}

