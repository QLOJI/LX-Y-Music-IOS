import TrackPlayer from 'react-native-track-player'
import { Platform } from 'react-native'
import settingState from '@/store/setting/state'
// 【第 48 轮】起播首发的时长兜底：元数据 interval 是**纯 JS 数据**，起播第 0 帧就已知，
// 不必等引擎上报（nativeFlac 流式路径的引擎时长恒为 0），见下方两处 duration 注释。
import { getMusicIntervalDuration } from '@/core/player/timeline'
import {
  getNativeFlacTrackId,
  resetNativeFlacPlayback,
  shouldUseNativeFlacPlayer,
  startNativeFlacPlayback,
} from '../nativeFlac'
import {
  clearTracks,
  ensureCurrentTrackMetadata,
  loadTrackPlayerResource,
} from '../trackPlayerCore'
// 【第 51 轮】起播 / 换歌的渐入预约（见 volumeFade.ts 头部第 51 轮说明）：
// 用户原话「播放和暂停时增加渐入渐出的效果」—— 点歌 / 换歌也是「播放开始」，
// 而且旧实现里恰恰是这条路声音最冲（新曲目一上来就是设定音量）。
import { armVolumeStartFadeIn } from '../volumeFade'

const resolveShouldAutoStart = (currentTrackIndex: number | null) => {
  if (currentTrackIndex != null) return true
  if (!global.lx.restorePlayInfo) return true
  global.lx.restorePlayInfo = null
  return false
}

export const loadPlaybackResource = async({
  musicInfo,
  url,
  time,
  quality,
}: {
  musicInfo: LX.Player.PlayMusic
  url: string
  time: number
  quality?: LX.Quality | null
}) => {
  const currentTrackIndex = await TrackPlayer.getCurrentTrack()
  const shouldAutoStart = resolveShouldAutoStart(currentTrackIndex)
  // 起播位置兜底（防御纵深）：正常上游只会传恢复进度或 0，但任何上游残留或非法值
  // （NaN/Infinity/负数）都不该变成一次 seek 或负值起播，非法一律兜成 0。
  // 注意只兜「非法值」，不能写成「非恢复就强制 0」——恢复曲本来就该从保存的非零进度起播。
  const startTime = Number.isFinite(time) && time > 0 ? time : 0

  if (Platform.OS == 'ios' && await shouldUseNativeFlacPlayer(musicInfo, url, quality)) {
    global.lx.playerStatus.ignoreTrackPlayerLifecycle = true
    try {
      try {
        await TrackPlayer.reset().catch(async() => {
          await TrackPlayer.stop().catch(() => {})
        })
        clearTracks()
        // 【第 51 轮】起播渐入预约：只在**真的要自动起播**时预约（恢复曲起播位置而保持
        // 暂停的那种不预约，否则会白白压 0 六秒）。预约成功就把引擎的起始增益一起传 0 ——
        // `openStreamingFlac` 那次调用会把传进去的音量直接交给原生引擎，不传 0 的话预约
        // 当场被覆盖（音量本来就在设定值上，斜波第一拍等于重复写同一个值）。
        const startFadeArmed = shouldAutoStart && armVolumeStartFadeIn()
        const playbackInfo = await startNativeFlacPlayback(musicInfo, url, startTime, shouldAutoStart, quality ?? null, startFadeArmed ? 0 : undefined)
        global.lx.playerTrackId = getNativeFlacTrackId()
        ensureCurrentTrackMetadata({
          title: ('progress' in musicInfo ? musicInfo.metadata.musicInfo.name : musicInfo.name) ?? 'Unknow',
          artist: ('progress' in musicInfo ? musicInfo.metadata.musicInfo.singer : musicInfo.singer) ?? 'Unknow',
          album: ('progress' in musicInfo ? musicInfo.metadata.musicInfo.meta.albumName : musicInfo.meta.albumName) ?? undefined,
          artwork: 'progress' in musicInfo
            ? (typeof musicInfo.metadata.musicInfo.meta.picUrl == 'string' ? musicInfo.metadata.musicInfo.meta.picUrl : undefined)
            : (typeof musicInfo.meta.picUrl == 'string' ? musicInfo.meta.picUrl : undefined),
          // 【第 48 轮】起播首发必须带上**真实总时长**（用户原话：「歌曲刚开始播放时，
          // 锁屏界面的歌曲进度、歌词、歌曲时间显示都不显示，要等到第一句歌词加载时，
          // 直接就跳到了 0:14 位置……确保锁屏界面的歌曲进度、歌词、歌曲时间实时显示
          // 没有延迟」）。nativeFlac 流式路径的引擎时长恒为 0，直接发出去系统就按
          // 「总时长未知」渲染：锁屏左右两侧 -:--、进度条整条不可拖。这里退回元数据
          // interval（纯 JS 数据，第 0 帧已知）；engine 真报了正时长时仍以 engine 为准
          //（seek 恢复曲的引擎时长可信）。
          duration: playbackInfo.duration > 0 ? playbackInfo.duration : getMusicIntervalDuration(musicInfo),
          elapsedTime: playbackInfo.position,
          playbackRate: settingState.setting['player.playbackRate'],
        })
        return
      } catch (err) {
        // nativeFlac 打开失败（本地文件被禁用 / 远程流打开失败 / 原生桥不可用）：
        // 回退 AVPlayer 播放同一资源——AVPlayer 承载所有音质，是全音质兜底路径，
        // 不让高音质 + 开关开时的 native 故障演变成整次播放失败。此时 TrackPlayer
        // 已被 reset、tracks 已清空，正好是 loadTrackPlayerResource 的标准前置
        // （正常 AVPlayer 换歌同样先 reset/clearTracks 再装载），从干净状态重建即可。
        await resetNativeFlacPlayback().catch(() => {})
        console.warn('nativeFlac open failed, fallback to AVPlayer:', err instanceof Error ? err.message : err)
      }
    } finally {
      global.lx.playerStatus.ignoreTrackPlayerLifecycle = false
    }
  }

  if (Platform.OS == 'ios') {
    await resetNativeFlacPlayback().catch(() => {})
  }

  // 【第 51 轮】AVPlayer(RNTP) 起播同样预约渐入：预约把两台引擎压到 0 之后，
  // `loadTrackPlayerResource` 里紧跟着的 `applyCurrentVolume()`（起播重贴音量）
  // 会因 isVolumeFadeActive() 让行，音量留在 0，'playing' 一到再由斜坡升上去。
  // 上面 nativeFlac 分支失败回落到这里时这次预约也仍然成立（等于把期限刷新一次）。
  if (shouldAutoStart) armVolumeStartFadeIn()
  const track = await loadTrackPlayerResource(musicInfo, url, startTime, shouldAutoStart)
  ensureCurrentTrackMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: typeof track.artwork == 'string' ? track.artwork : undefined,
    // 【第 48 轮】同 nativeFlac 分支：buildTracks 在 iOS 上不带 duration（引擎时长要等
    // load/seek 之后才稳定），首发直接发 undefined 同样让锁屏显示 -:--。元数据 interval
    // 兜底；引擎给出正时长时仍以引擎为准。
    duration: typeof track.duration == 'number' && track.duration > 0 ? track.duration : getMusicIntervalDuration(musicInfo),
    elapsedTime: startTime,
  })
}

