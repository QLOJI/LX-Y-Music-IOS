import { Platform } from 'react-native'
import { parsePlayTime } from '@/utils/common'

/** 引擎时长与元数据时长的容许漂移（秒）：差值超过它就以元数据为准。 */
const durationDriftTolerance = 1.5

const isOnlineMusic = (musicInfo: LX.Player.PlayMusic | null | undefined) => {
  if (!musicInfo) return false
  return 'progress' in musicInfo ? true : musicInfo.source != 'local'
}

const getMusicInterval = (musicInfo: LX.Player.PlayMusic | null | undefined) => {
  if (!musicInfo) return null
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo.interval : musicInfo.interval
}

export const getMusicIntervalDuration = (musicInfo: LX.Player.PlayMusic | null | undefined) => {
  return parsePlayTime(getMusicInterval(musicInfo))
}

export const getTimelineDuration = (musicInfo: LX.Player.PlayMusic | null | undefined, playerDuration: number) => {
  const intervalDuration = getMusicIntervalDuration(musicInfo)
  if (!intervalDuration) return playerDuration

  // iOS 在线/高音质流在 load/seek 之后引擎上报的 duration 不稳定，恒用元数据时长
  // ——对齐 REF（lx-music-mobile-ios-adaptation）的 getTimelineDuration。
  //
  // 这里曾经反转成「引擎真实时长优先」，理由是元数据 interval 可能与文件不符
  // （泪海 Hi-Res FLAC：interval 03:30、实际 03:48）。反转后出现了它自己的反例：
  // 引擎在加载/seek 瞬间会上报偏小甚至无效的值，一旦采信，进度条末端总时长就
  // 小于歌曲实际可播时长 —— 表现为播到尾部时「左侧已播时间 > 右侧总时长」、
  // 进度条先于音频走完。需求以「实际时长不得超过进度条最后时间」为准，故回到
  // 元数据优先；引擎与元数据不一致且超出容许漂移时同样以元数据为准。
  if (Platform.OS == 'ios' && isOnlineMusic(musicInfo)) return intervalDuration

  if (!playerDuration || !Number.isFinite(playerDuration) || playerDuration <= 0) return intervalDuration
  return Math.abs(playerDuration - intervalDuration) > durationDriftTolerance ? intervalDuration : playerDuration
}
