import {
  play as lrcPlay,
  setLyric as lrcSetLyric,
  pause as lrcPause,
  onLyricPlay as onPluginLyricPlay,
  setPlaybackRate as lrcSetPlaybackRate,
  toggleTranslation as lrcToggleTranslation,
  toggleRoma as lrcToggleRoma,
  init as lrcInit,
} from '@/plugins/lyric'
import { getPosition } from '@/plugins/player/utils'
import playerState from '@/store/player/state'
// import settingState from '@/store/setting/state'

/**
 * 取一次「可信的引擎位置」（秒）。
 * 供歌词装载链路复用：装载完成时把位置随原生时间轴一起提交，原生在同一次调用
 * 里重锚 + 仲裁出当前行，锁屏/灵动岛不会先显示旧行再跳。
 */
export const getReliableLyricPosition = async() => {
  const progressPosition = Math.max(playerState.progress.nowPlayTime, 0)
  const playerPosition = await getPosition().catch(() => progressPosition)

  // Right after switching songs, progress belongs to the new song and is reset
  // immediately, while native/player position may still transiently report the
  // previous song. In that window, always trust the new track progress.
  if (progressPosition <= 1) {
    if (playerPosition > 5) return progressPosition
    return Math.max(progressPosition, 0)
  }
  // 对齐上游 core/lyric.play()：lrc.play(getCurrentTime()) 无条件信任引擎当前时间。
  // 此前的「|引擎-进度|>2s 时偏好进度」分支会拿 seek 窗口期的 store 目标值覆盖引擎
  // 真实位置，属于旧轮询架构的补丁；重锚由引擎 playing 事件驱动时引擎位置即真相。
  if (playerPosition <= 0) return progressPosition
  return playerPosition
}

/**
 * init lyric
 */
export const init = async() => {
  return lrcInit()
}

/**
 * set lyric
 * @param lyric lyric str
 * @param translation lyric translation
 */
const handleSetLyric = async(lyric: string, translation = '', romalrc = '', lxLyric = '') => {
  // 本项目逐字歌词走独立参数：主歌词始终是标准 LRC，lxlrc 由歌词插件单独解析为
  // 逐字时间轴。参考分支把 lxlrc当作主歌词（它用 LxLyricPlayer 直接播），
  // 若照搬会让 lrc-file-parser 解析出带 <...> 标记的行，逐字与行文本都会错乱。
  lrcSetLyric(lyric, translation, romalrc, lxLyric)
}

/**
 * play lyric
 * @param time play time
 */
export const handlePlay = (time: number) => {
  lrcPlay(time)
}

/**
 * pause lyric
 */
export const pause = () => {
  lrcPause()
}

export const onLyricPlay = onPluginLyricPlay

// 行级同步自愈探针（透传插件层实现，消费方为 playProgress 的慢校准/快路径）
export { verifyLyricLineSync } from '@/plugins/lyric'

/**
 * stop lyric
 */
export const stop = () => {
  void handleSetLyric('')
}

/**
 * set playback rate
 * @param playbackRate playback rate
 */
export const setPlaybackRate = async(playbackRate: number) => {
  lrcSetPlaybackRate(playbackRate)
  if (playerState.isPlay) {
    setTimeout(() => {
      void getReliableLyricPosition().then((position) => {
        handlePlay(position * 1000)
      })
    })
  }
}

/**
 * toggle show translation
 * @param isShowTranslation is show translation
 */
export const toggleTranslation = async(isShowTranslation: boolean) => {
  lrcToggleTranslation(isShowTranslation)
  if (playerState.isPlay) play()
}

/**
 * toggle show roma lyric
 * @param isShowLyricRoma is show roma lyric
 */
export const toggleRoma = async(isShowLyricRoma: boolean) => {
  lrcToggleRoma(isShowLyricRoma)
  if (playerState.isPlay) play()
}

/**
 * 把歌词引擎推进到当前播放位置。
 * 返回本次使用的位置（秒）：调用方（iOS 原生化歌词链路）随时间轴一起提交给原生，
 * 让原生在同一次调用内完成重锚 + 行仲裁。
 */
export const play = async() => {
  const position = await getReliableLyricPosition()
  handlePlay(position * 1000)
  return position
}

export const seek = (time: number) => {
  handlePlay(time * 1000)
  if (!playerState.isPlay) {
    setTimeout(() => {
      pause()
    })
  }
}


/**
 * 装载歌词（解析 + 引擎对齐），并返回装载所用的引擎位置（秒，可能为 undefined）。
 * iOS 原生化歌词链路（core/init/player/lyric.ts 的 lyricUpdated 处理）在
 * `await setLyric()` 之后把该位置随整条时间轴一起提交，原生同调用内重锚 + 仲裁，
 * 消除「时间轴已换、卡片还是旧行/空行」的错行窗口。
 */
export const setLyric = async() => {
  if (!playerState.musicInfo.id) return undefined
  const musicInfo = playerState.musicInfo
  const source = (musicInfo as { source?: string }).source ?? ''
  if (musicInfo.lrc) {
    let tlrc = ''
    let rlrc = ''
    if (musicInfo.tlrc) tlrc = musicInfo.tlrc
    if (musicInfo.rlrc) rlrc = musicInfo.rlrc
    let lxlrc = ''
    // 咪咕/汽水的 lxlrc 格式异常，不进入逐字解析
    if (musicInfo.lxlrc && source != 'mg' && source != 'qs') {
      lxlrc = musicInfo.lxlrc
    }
    await handleSetLyric(musicInfo.lrc, tlrc, rlrc, lxlrc)
  }

  // 播放中：推进引擎时钟并返回它使用的位置；暂停中：只取位置、不动引擎
  // （推进解析器会让暂停期间歌词行自行前进）。
  if (playerState.isPlay) return play()
  return getReliableLyricPosition().catch(() => undefined)
}
