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
import { beginBackgroundTask } from '@/utils/nativeModules/utils'
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

  if (settingState.setting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) {
    addPlayedList(playMusicInfo as LX.Player.PlayMusicInfo)
    // 【第 69 轮第 5 条】恢复上次播放也是「这首歌已经开播」：同样记进洗牌袋（不多做重洗 ——
    // 启动时袋子本来就是空的，记一笔只为了让新一轮的第一首避开它）。
    noteShufflePlayed(playMusicInfo.listId, playMusicInfo.musicInfo!.id)
  }
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

  // 【第 83 轮第 2 条】切歌窗口要**自己持有后台执行凭证**：下面 await setStop() 会走原生
  // stop → 释放音频会话（第 57 轮的省电门），而会话正是「后台可运行」的凭证 —— 于是从这一刻
  // 到新流 openStream 重新拿到会话之间，本 App 在后台**没有任何凭证**：取链 / 取封面 / 取歌词
  // 的网络请求可能被系统挂起，表现就是用户报的「播完不跳歌 / 后台突然没了」。
  // beginBackgroundTask 这个接口本来就是为这个窗口写的（见 nativeModules/utils.ts 与
  // AppDelegate.mm 的注释），但一直没人调用。
  // 这里**不主动 end**：一是取链完成的时点不在这条链上（不引新耦合），二是原生只维护一个任务 id，
  // 主动 end 一旦被上一首的延迟调用撞上就会把**新**那份断言收掉 —— 让系统的到期回收（约 30s）
  // 收口最稳；播放中本来就有音频会话这条凭证，这 30s 不额外耗电。
  void beginBackgroundTask()
  await setStop()
  global.app_event.pause()

  clearDelayNextTimeout()
  clearLoadTimeout()


  if (settingState.setting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) {
    addPlayedList(playMusicInfo as LX.Player.PlayMusicInfo)
    // 【第 69 轮第 5 条】洗牌袋同步：这首歌已经开播 —— 不管它是点歌、自动切歌还是上一曲
    // 跳过来的，都从本轮待播里剔掉。「一轮之内不重复」这条不变量收口在这里。
    noteShufflePlayed(playMusicInfo.listId, playMusicInfo.musicInfo!.id)
  }

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
  // 【第 69 轮第 5 条】手动点歌 = 刷新随机规则（用户原话：「手动点击播放时刷新列表随机规则」）：
  // 丢掉洗牌袋，剩下的歌按新顺序重洗一轮。
  resetShufflePass(listId)
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
  // 【第 69 轮第 5 条】手动点歌 = 刷新随机规则（同 playListById）
  resetShufflePass(listId)
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

// ============================================================================
// 随机播放（洗牌袋）：一轮之内不重复，手动点歌刷新一轮
// ============================================================================
// 【第 69 轮第 5 条】用户原话：「目前选择随机播放模式，列表中共有280首歌，但是随机播放
// 不随机，始终偏重于其中几首或者几十首，请优化随机算法，使得列表随机可以不重复播放，
// 手动点击播放时刷新列表随机规则，自动播放时遵循随机规则。」
//
// 旧实现是「每次从**未播集合**里均匀取一个下标」（getRandom(0, filteredList.length)），
// 单看这一步没问题，真正的偏重在它前面那道闸门：getNextPlayMusicInfo / playNext 开头都有
// 一段「已播放列表里当前歌的下一条」。那段是**历史导航**（上一曲 / 下一曲往回走用），
// 判据只有「当前歌在 playedList 里的下标 + 1」。于是只要当前歌曾经播过 —— 用户手动点一首
// 播过的歌就是这种情况 —— 下一首就顺着旧历史下去，而不是随机；走完才轮到随机。听感上
// 就成了「总是那几首 / 那几十首」。旧实现的「不重复」也不硬：过滤已播靠 playedList，
// 而 playedList 会被 clearPlayedList 清掉（勾选「自动清空已播放列表」时每次点歌都清、
// 跨列表播放也清），一清就退回「从全量列表里均匀抽」，生日悖论下重复自然多。
//
// 现在改成**洗牌袋**（Fisher–Yates 洗一份顺序，按顺序播，播完一轮再洗）：
//   · queue  —— 本轮还没播的歌，直接就是洗好的顺序（取一首 = shift 一首）；
//   · played —— 本轮已播（只用来判断「哪些是列表里新加进来、本轮还没排过的歌」；
//               一轮开始时只保留上一首，不越积越多）；
//   · lastId —— 上一首，保证新一轮的第一首不会又是它；
//   · listId —— 袋子属于哪个列表，换列表 / 列表内容变了自动对齐。
// 一轮之内**不会重复**（用户第 1 条要求）；手动点歌（playList / playListById）把袋子丢掉
// 重洗（用户第 2 条要求「手动点击播放时刷新列表随机规则」）；自动切歌与「下一曲」都只从袋子里
// 顺序取（用户第 3 条要求「自动播放时遵循随机规则」），不再走历史回放。
// 历史回放本身没删：**上一曲**照旧按 playedList 往回走（那是它的本职），随机模式下按下
// 上一曲仍然有效。
const shufflePass = {
  listId: null as string | null,
  queue: [] as string[],
  played: new Set<string>(),
  lastId: null as string | null,
}

/** Fisher–Yates 洗牌（不改原数组） */
const shuffleIds = (ids: readonly string[]): string[] => {
  const next = ids.slice()
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = next[i]
    next[i] = next[j]
    next[j] = tmp
  }
  return next
}

/**
 * 丢掉袋子：下一次取歌时按当前列表重洗一轮。手动点歌刷新随机规则就靠它。
 * @param listId 目标列表（点歌时就是这首歌要播的那个列表）
 */
export const resetShufflePass = (listId?: string | null) => {
  shufflePass.listId = listId ?? null
  shufflePass.queue = []
  shufflePass.played = new Set()
  shufflePass.lastId = null
}

/**
 * 把袋子对齐到当前列表：换列表重洗、删掉的歌剔掉、新加的歌随机插进来、取空重洗一轮。
 */
const syncShufflePass = (listId: string, poolIds: readonly string[]) => {
  if (shufflePass.listId !== listId) resetShufflePass(listId)
  const poolSet = new Set(poolIds)
  shufflePass.queue = shufflePass.queue.filter(id => poolSet.has(id) && !shufflePass.played.has(id))
  if (!shufflePass.queue.length) { // 这一轮播完了（或刚开局 / 刚被手动点歌刷新）⇒ 重洗一轮
    const lastId = shufflePass.lastId
    shufflePass.played = new Set(lastId ? [lastId] : [])
    shufflePass.queue = shuffleIds(poolIds.filter(id => id !== lastId))
    // 列表只有一首歌（或上一首已不在列表里）时上面会洗出空袋，兜底按全量重洗
    if (!shufflePass.queue.length) shufflePass.queue = shuffleIds(poolIds)
    return
  }
  // 队列里还有歌：把「列表里新加进来、本轮既没播也没排过」的歌随机插到队列中间，
  // 别让刚加进列表的歌干等一整轮。
  const queued = new Set(shufflePass.queue)
  const fresh = poolIds.filter(id => !queued.has(id) && !shufflePass.played.has(id) && id !== shufflePass.lastId)
  if (fresh.length) {
    for (const id of shuffleIds(fresh)) {
      shufflePass.queue.splice(Math.floor(Math.random() * (shufflePass.queue.length + 1)), 0, id)
    }
  }
}

/**
 * 从袋子里取下一首（取到就出队）。返回 null = 列表里一首可播的都没有。
 */
const takeShuffleNext = (listId: string, pool: Array<LX.Music.MusicInfo | LX.Download.ListItem>) => {
  if (!pool.length) return null
  syncShufflePass(listId, pool.map(m => m.id))
  const id = shufflePass.queue.shift()
  if (!id) return null
  const musicInfo = pool.find(m => m.id === id)
  if (!musicInfo) return null
  shufflePass.lastId = id
  return musicInfo
}

/**
 * 记一笔「这首歌正在播」：从本轮待播里剔掉并记为已播。
 * 点歌 / 自动切歌 / 上一曲跳过来的都走这里 —— 「一轮之内不重复」这条不变量收口在这一处。
 */
export const noteShufflePlayed = (listId: string | null, id: string) => {
  const queued = shufflePass.queue.indexOf(id)
  if (queued > -1) shufflePass.queue.splice(queued, 1)
  if (shufflePass.listId == null) shufflePass.listId = listId
  if (shufflePass.listId !== listId) return
  shufflePass.played.add(id)
  shufflePass.lastId = id
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

  // 【第 69 轮第 5 条】随机模式走洗牌袋（见上面「随机播放（洗牌袋）」区块）：既不参与下面的
  // 历史回放，也不按「已播」过滤池子 —— 袋自己保证一轮不重复，再叠一层已播过滤只会把袋子
  // 和池子错开。
  const isRandom = settingState.setting['player.togglePlayMethod'] == 'random'

  const playedList = playerState.playedList
  if (!isRandom && playedList.length) { // 移除已播放列表内不存在原列表的歌曲
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
  let { filteredList, canPlayList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: true,
  })

  if (isRandom) {
    const musicInfo = takeShuffleNext(currentListId, canPlayList.length ? canPlayList : filteredList)
    if (!musicInfo) return null
    const nextPlayMusicInfo = {
      musicInfo,
      listId: currentListId,
      isTempPlay: false,
    }
    randomNextMusicInfo.info = nextPlayMusicInfo
    return nextPlayMusicInfo
  }

  if (!filteredList.length) return null
  // let currentIndex: number = filteredList.indexOf(currentList[playInfo.playerPlayIndex])
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex

  let togglePlayMethod = settingState.setting['player.togglePlayMethod']
  switch (togglePlayMethod) {
    case 'listLoop':
      nextIndex = playerIndex === filteredList.length - 1 ? 0 : playerIndex + 1
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

  // 随机模式上面已经提前返回（洗牌袋），这里只剩列表循环 / 顺序播放两条
  return {
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  }
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

  // 【第 69 轮第 5 条】随机模式走洗牌袋（见上面「随机播放（洗牌袋）」区块）：不参与下面的
  // 历史回放，也不按「已播」过滤池子 —— 用户第 3 条要求「自动播放时遵循随机规则」，
  // 而历史回放恰恰就是「随机播放总是偏重那几首」的病根（见区块注释）。
  const isRandom = settingState.setting['player.togglePlayMethod'] == 'random'

  if (!isRandom && playedList.length) { // 移除已播放列表内不存在原列表的歌曲
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
  let { filteredList, canPlayList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: true,
  })

  if (isRandom) {
    const musicInfo = takeShuffleNext(currentListId, canPlayList.length ? canPlayList : filteredList)
    if (!musicInfo) return handleToggleStop()
    await handlePlayNext({
      musicInfo,
      listId: currentListId,
      isTempPlay: false,
    })
    return
  }

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

