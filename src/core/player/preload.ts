import { getMusicUrl, getLyricInfo } from '@/core/music'
import { getNextPlayMusicInfo } from '@/core/player/player'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { preloadLog } from '@/utils/preloadLog'

let isPreloading = false

const preloadNextMusic = async() => {
  if (isPreloading) return
  if (!settingState.setting['player.isEnableAudioPreload']) return

  const currentMusicInfo = playerState.playMusicInfo.musicInfo
  if (!currentMusicInfo) {
    preloadLog.info('No current music info, skipping preload')
    return
  }

  // 用户第 15 轮第 4 条：预加载只在当前歌曲「播到最后 10 秒」才开始，不再起播 / 切歌瞬间就
  // 取下一首。本函数由 controller 在 playing / musicToggled 时调用（起播、暂停恢复、切歌都算），
  // 时间闸必须放在函数内部，否则每次起播都会抢带宽（第 11 轮只收窄了进度驱动的
  // init/player/preloadNextMusic.ts，漏了这里，所以用户仍能看到一起播就取下一首）。
  // 真正进入最后 10 秒的触发由 init/player/preloadNextMusic.ts 的进度监听负责
  // （它会在暖链完成后回调 startPreload）。口径与那边一致：总长 ≤ 10s 的极短音频不预取，
  // 避免一开播就触发。
  const { nowPlayTime, maxPlayTime } = playerState.progress
  if (!(maxPlayTime > 10 && maxPlayTime - nowPlayTime < 10)) {
    preloadLog.info(
      `Not in last 10s (${Math.round(nowPlayTime)}/${Math.round(maxPlayTime)}), skipping preload`,
    )
    return
  }

  isPreloading = true
  preloadLog.info('========== Preload Start ==========')

  try {
    const nextPlayMusicInfo = await getNextPlayMusicInfo()
    if (!nextPlayMusicInfo) {
      preloadLog.info('No next song to preload')
      return
    }

    const musicInfo = nextPlayMusicInfo.musicInfo
    if ('progress' in musicInfo) {
      preloadLog.info('Skipping download item, not preloading')
      return
    }

    preloadLog.info(`Target: "${musicInfo.name}" - "${musicInfo.singer}" (source: ${musicInfo.source}, id: ${musicInfo.id})`)

    let success = false
    let currentInfo = musicInfo
    let tryCount = 0
    const maxTries = 5

    while (!success && tryCount < maxTries) {
      try {
        preloadLog.info(`Attempt ${tryCount + 1}/${maxTries} for "${currentInfo.name}" from "${currentInfo.source}"`)

        const url = await getMusicUrl({
          musicInfo: currentInfo,
          isRefresh: false,
          allowToggleSource: true,
          onToggleSource: (mInfo) => {
            if (mInfo) {
              preloadLog.info(`Source toggled to "${mInfo.source}" for "${mInfo.name}"`)
              currentInfo = mInfo
            }
          },
        })

        success = true
        preloadLog.info(`Success! URL cached for "${currentInfo.name}" (length: ${url?.length || 0})`)
        // 预取歌词：缓存歌词，切歌后歌词立即就绪，与音频真实位置实时同步，
        // 避免切歌瞬间歌词异步加载造成的「歌词滞后于音频」。
        void getLyricInfo({ musicInfo: currentInfo, isRefresh: false }).catch(() => {})
      } catch (err: any) {
        preloadLog.error(`Failed attempt ${tryCount + 1} for "${currentInfo.name}": ${err?.message || err}`)

        if (tryCount < maxTries - 1) {
          const nextInfo = await getNextPlayMusicInfo()
          if (nextInfo && !('progress' in nextInfo.musicInfo)) {
            preloadLog.info(`Fallback to next song: "${nextInfo.musicInfo.name}"`)
            currentInfo = nextInfo.musicInfo
          } else {
            preloadLog.info('No more songs available for fallback')
            break
          }
        }
      }

      tryCount++
    }

    if (!success) {
      preloadLog.warn(`All ${tryCount} attempts failed, no URL cached`)
    }
  } catch (err: any) {
    preloadLog.error(`Unexpected error: ${err?.message || err}`)
  } finally {
    isPreloading = false
    preloadLog.info('========== Preload End ==========')
  }
}

export const startPreload = () => {
  if (!settingState.setting['player.isEnableAudioPreload']) return
  preloadLog.init()
  void preloadNextMusic()
}

export const stopPreload = () => {
  isPreloading = false
}
