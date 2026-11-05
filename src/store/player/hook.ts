import { isActive } from '@/utils/tools'
import { useEffect, useState } from 'react'
import state, { type InitState } from './state'

export const usePlayerMusicInfo = () => {
  const [value, update] = useState(state.musicInfo)

  useEffect(() => {
    global.state_event.on('playerMusicInfoChanged', update)
    return () => {
      global.state_event.off('playerMusicInfoChanged', update)
    }
  }, [])

  return value
}

export const usePlayMusicInfo = () => {
  const [value, update] = useState(state.playMusicInfo)

  useEffect(() => {
    global.state_event.on('playMusicInfoChanged', update)
    return () => {
      global.state_event.off('playMusicInfoChanged', update)
    }
  }, [])

  return value
}

export const usePlayInfo = () => {
  const [value, update] = useState(state.playInfo)

  useEffect(() => {
    global.state_event.on('playInfoChanged', update)
    return () => {
      global.state_event.off('playInfoChanged', update)
    }
  }, [])

  return value
}

export const useStatusText = () => {
  const [value, update] = useState(state.statusText)

  useEffect(() => {
    global.state_event.on('playStateTextChanged', update)
    return () => {
      global.state_event.off('playStateTextChanged', update)
    }
  }, [])

  return value
}

export const useIsPlay = () => {
  const [value, update] = useState(state.isPlay)

  useEffect(() => {
    global.state_event.on('playStateChanged', update)
    return () => {
      global.state_event.off('playStateChanged', update)
    }
  }, [])

  return value
}

export const useTempPlayList = () => {
  const [value, update] = useState(state.tempPlayList)

  useEffect(() => {
    global.state_event.on('playTempPlayListChanged', update)
    return () => {
      global.state_event.off('playTempPlayListChanged', update)
    }
  }, [])

  return value
}

/** 【第 203 轮】当前**实际播放**音质（降级后是达成档），供详情页音质标与弹层订阅。 */
export const usePlayerQuality = () => {
  const [quality, setQuality] = useState<InitState['quality']>(state.quality)
  useEffect(() => {
    const handleUpdate = () => { setQuality(state.quality) }
    global.state_event.on('playQualityChanged', handleUpdate)
    handleUpdate()
    return () => {
      global.state_event.off('playQualityChanged', handleUpdate)
    }
  }, [])
  return quality
}

export const useProgress = (autoUpdate = true) => {
  const [value, update] = useState(state.progress)

  useEffect(() => {
    if (!autoUpdate) return
    const handleUpdate = (progress: InitState['progress']) => {
      if (isActive()) update(progress)
    }
    update(state.progress)
    global.state_event.on('playProgressChanged', handleUpdate)
    return () => {
      global.state_event.off('playProgressChanged', handleUpdate)
    }
  }, [autoUpdate])

  return value
}
