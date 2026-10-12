// import { LIST_ID_LOVE } from '@/config/constant'

import { syncNowPlayingMetadata, syncNowPlayingState } from '@/core/player/nowPlaying'
import playerState from '@/store/player/state'

export default () => {
  // const setVisibleDesktopLyric = useCommit('setVisibleDesktopLyric')
  // const setLockDesktopLyric = useCommit('setLockDesktopLyric')

  const buttons = {
    empty: true,
    collect: false,
    play: false,
    prev: true,
    next: true,
    lrc: false,
    lockLrc: false,
  }
  let syncedDurationMusicId: string | null = null
  const setButtons = () => {
    // setPlayerAction(buttons)
    if (!playerState.playMusicInfo.musicInfo) return
    syncNowPlayingMetadata()
  }
  const syncPlaybackRate = () => {
    if (!playerState.playMusicInfo.musicInfo) return
    if (playerState.isPlay) {
      void syncNowPlayingState('play')
    } else if (!playerState.isPlay && buttons.play) {
      void syncNowPlayingState('pause')
    }
  }

  const handlePlay = () => {
    void (async() => {
      await syncNowPlayingState('play')
      // if (buttons.empty) buttons.empty = false
      if (buttons.play) return
      buttons.play = true
      setButtons()
    })()
  }
  const handlePause = () => {
    void (async() => {
      await syncNowPlayingState('pause')
      // if (buttons.empty) buttons.empty = false
      if (!buttons.play) return
      buttons.play = false
      setButtons()
    })()
  }
  const handleStop = () => {
    void syncNowPlayingState('stop')
    buttons.play = false
    setButtons()
  }
  const handleSetPlayInfo = () => {
    if (!playerState.playMusicInfo.musicInfo) return
    syncedDurationMusicId = null
    syncNowPlayingMetadata(true)
  }
  const handlePlayProgressChanged: typeof global.state_event.playProgressChanged = (progress) => {
    const musicId = playerState.playMusicInfo.musicInfo?.id
    if (!musicId || progress.maxPlayTime <= 0) return
    if (syncedDurationMusicId == musicId) return
    syncedDurationMusicId = musicId
    syncNowPlayingMetadata(true)
  }
  const handleConfigUpdated: typeof global.state_event.configUpdated = (keys) => {
    if (!keys.includes('player.playbackRate')) return
    syncPlaybackRate()
  }
  global.app_event.on('play', handlePlay)
  global.app_event.on('pause', handlePause)
  global.app_event.on('error', handlePause)
  global.app_event.on('stop', handleStop)
  global.app_event.on('musicToggled', handleSetPlayInfo)
  global.state_event.on('configUpdated', handleConfigUpdated)
  global.state_event.on('playProgressChanged', handlePlayProgressChanged)
  // window.app_event.on(eventTaskbarNames.setTaskbarThumbnailClip, handleSetTaskbarThumbnailClip)
  // window.app_event.on('myListMusicUpdate', throttleListChange)

  return async() => {
    setButtons()
  }
}
