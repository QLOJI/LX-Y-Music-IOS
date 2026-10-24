import { getPositionStamped, elapsedSnapshotFields } from '@/plugins/player/utils'
import { updateMetaData } from '@/plugins/player'
import { isPlaybackConfirmed } from '@/core/player/playbackGate'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { pauseNowPlaying, playNowPlaying, stopNowPlaying } from '@/utils/nativeModules/nowPlaying'

// 带快照时间信息的位置：elapsedTimeSnapshotAt/elapsedTimeAgeMs 随发布透传，
// 原生歌词时钟重锚时据此把锚点回放到快照时刻（修灵动岛/控制中心歌词恒定滞后）
const getElapsedTime = async(confirmed: boolean) => {
  // 【第 188 轮】未确认在播时不读引擎快照（可能是 seek 目标/外推超前值），
  // 直接用 UI 进度；锁屏时钟由 rate 0 冻结，等引擎出声再对齐。
  if (!confirmed) return { elapsedTime: playerState.progress.nowPlayTime }
  const stamped = await getPositionStamped().catch(() => null)
  if (!stamped) return { elapsedTime: playerState.progress.nowPlayTime }
  return { elapsedTime: stamped.position, ...elapsedSnapshotFields(stamped) }
}

export const syncNowPlayingState = async(type: 'play' | 'pause' | 'stop') => {
  const confirmed = type == 'play' && isPlaybackConfirmed()
  const elapsed = type == 'stop'
    ? { elapsedTime: 0 }
    : await getElapsedTime(confirmed)

  if (type == 'play') {
    await playNowPlaying({
      ...elapsed,
      playbackRate: confirmed ? settingState.setting['player.playbackRate'] : 0,
    }).catch(() => {})
    return
  }

  if (type == 'pause') {
    await pauseNowPlaying({
      ...elapsed,
      playbackRate: 0,
    }).catch(() => {})
    return
  }

  await stopNowPlaying({
    ...elapsed,
    playbackRate: 0,
  }).catch(() => {})
}

export const syncNowPlayingMetadata = (force = false) => {
  if (!playerState.playMusicInfo.musicInfo) return
  void updateMetaData(playerState.musicInfo, playerState.isPlay, playerState.lastLyric, force)
}
