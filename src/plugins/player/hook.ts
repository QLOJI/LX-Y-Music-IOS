import { useEffect, useState, useRef } from 'react'
import TrackPlayer, { State, Event } from 'react-native-track-player'
import {
  getNativeFlacBufferedPosition,
  getNativeFlacDuration,
  getNativeFlacPosition,
  isNativeFlacActive,
  onNativeFlacPlayerEvent,
} from './nativeFlac'
import { getUnifiedPlaybackState, onUnifiedPlayerEvent } from './engine'

/** Get current playback state and subsequent updatates  */
export const usePlaybackState = () => {
  const [state, setState] = useState(State.None)

  useEffect(() => {
    async function setPlayerState() {
      const unifiedState = await getUnifiedPlaybackState()
      switch (unifiedState) {
        case 'loading':
          setState(State.Connecting)
          break
        case 'buffering':
          setState(State.Buffering)
          break
        case 'playing':
          setState(State.Playing)
          break
        case 'paused':
          setState(State.Paused)
          break
        case 'stopped':
          setState(State.Stopped)
          break
        case 'idle':
        default:
          setState(State.None)
          break
      }
    }

    void setPlayerState()

    const removeUnifiedListener = onUnifiedPlayerEvent((event) => {
      if (event.type == 'ended') {
        setState(State.Stopped)
        return
      }
      if (event.type == 'error') {
        setState(State.Paused)
        return
      }
      if (event.type != 'state') return
      switch (event.state) {
        case 'loading':
          setState(State.Connecting)
          break
        case 'buffering':
          setState(State.Buffering)
          break
        case 'playing':
          setState(State.Playing)
          break
        case 'paused':
          setState(State.Paused)
          break
        case 'stopped':
          setState(State.Stopped)
          break
        case 'idle':
        default:
          setState(State.None)
          break
      }
    })

    return () => {
      removeUnifiedListener()
    }
  }, [])

  return state
}

/**
 * Attaches a handler to the given TrackPlayer events and performs cleanup on unmount
 * @param events - TrackPlayer events to subscribe to
 * @param handler - callback invoked when the event fires
 */
// export const useTrackPlayerEvents = (events, handler) => {
//   const savedHandler = useRef()

//   useEffect(() => {
//     savedHandler.current = handler
//   }, [handler])

//   useEffect(() => {
//     // eslint-disable-next-line no-undef
//     if (__DEV__) {
//       const allowedTypes = Object.values(Event)
//       const invalidTypes = events.filter(type => !allowedTypes.includes(type))
//       if (invalidTypes.length) {
//         console.warn(
//           'One or more of the events provided to useTrackPlayerEvents is ' +
//             `not a valid TrackPlayer event: ${invalidTypes.join("', '")}. ` +
//             'A list of available events can be found at ' +
//             'https://react-native-kit.github.io/react-native-track-player/documentation/#events',
//         )
//       }
//     }

//     const subs = events.map(event =>
//       TrackPlayer.addEventListener(event, payload => savedHandler.current({ ...payload, type: event })),
//     )

//     return () => subs.forEach(sub => sub.remove())
//   }, [events])
// }

const pollTrackPlayerStates = [
  State.Playing,
  State.Buffering,
] as const
/**
 * Poll for track progress for the given interval (in miliseconds)
 * @param updateInterval - ms interval
 */
export function useProgress(updateInterval: number) {
  const [state, setState] = useState({ position: 0, duration: 0, buffered: 0 })
  const playerState = usePlaybackState()
  const stateRef = useRef(state)
  const isUnmountedRef = useRef(true)
  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const getProgress = async() => {
    const [position, duration, buffered] = isNativeFlacActive()
      ? await Promise.all([
        getNativeFlacPosition(),
        getNativeFlacDuration(),
        getNativeFlacBufferedPosition(),
      ])
      : await Promise.all([
        TrackPlayer.getPosition(),
        TrackPlayer.getDuration(),
        TrackPlayer.getBufferedPosition(),
      ])
    // After the asynchronous code is executed, if the component has been uninstalled, do not update the status
    if (isUnmountedRef.current) return

    if (
      position === stateRef.current.position &&
      duration === stateRef.current.duration &&
      buffered === stateRef.current.buffered
    ) return

    const state = { position, duration, buffered }
    stateRef.current = state
    setState(state)
  }

  useEffect(() => {
    // @ts-expect-error
    if (!pollTrackPlayerStates.includes(playerState)) return

    void getProgress()

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const poll = setInterval(getProgress, updateInterval || 1000)
    return () => { clearInterval(poll) }
  }, [playerState, updateInterval])

  return state
}

export function useBufferProgress() {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let isUnmounted = false
    let preBuffered = 0
    let duration = 0
    let interval: ReturnType<typeof setInterval> | null = null

    const clearItv = () => {
      if (!interval) return
      clearInterval(interval)
      interval = null
    }
    const resetBuffer = () => {
      clearItv()
      preBuffered = 0
      duration = 0
      if (!isUnmounted) setProgress(0)
    }
    const updateBuffer = async() => {
      const buffered = await (isNativeFlacActive()
        ? Promise.all([
          getNativeFlacBufferedPosition(),
          duration ? Promise.resolve(duration) : getNativeFlacDuration(),
        ]).then(([buffered, _duration]) => {
          duration = _duration
          return buffered
        })
        : (duration ? TrackPlayer.getBufferedPosition() : Promise.all([TrackPlayer.getBufferedPosition(), TrackPlayer.getDuration()]).then(([buffered, _duration]) => {
            duration = _duration
            return buffered
          })))
      // console.log('updateBuffer', buffered, duration, buffered > 0, buffered == duration)
      // After the asynchronous code is executed, if the component has been uninstalled, do not update the status
      if (buffered > 0 && buffered == duration) clearItv()
      if (buffered == preBuffered || isUnmounted) return
      preBuffered = buffered
      setProgress(duration ? (buffered / duration) : 0)
    }

    const sub = TrackPlayer.addEventListener(Event.PlaybackState, data => {
      if (isNativeFlacActive()) return
      switch (data.state) {
        case State.None:
          // console.log('state', 'None')
          setProgress(0)
          break
        // case State.Ready:
        //   console.log('state', 'Ready')
        //   break
        // case State.Stopped:
        //   console.log('state', 'Stopped')
        //   break
        case State.Paused:
          // 暂停：缓冲不会自行推进，却仍每秒 getBufferedPosition + setProgress 空转（发热来源之一）。
          // 直接清掉轮询；恢复播放时由 Playing 分支按「还没缓冲完才轮询」重建。
          clearItv()
          break
        case State.Playing:
          // 恢复播放：只有「还没缓冲完」才重建 1s 轮询——已缓冲到时长的曲目（本地/整文件就绪）
          // 不再每秒白唤醒一次 JS 线程；未缓冲完的会在缓冲完成时由 updateBuffer 内部自行停表。
          // duration 未知（<=0）时先轮询一次，等 updateBuffer 拿到时长后再判。
          if (duration <= 0 || preBuffered < duration) {
            clearItv()
            interval = setInterval(updateBuffer, 1000)
            void updateBuffer()
          }
          break
        case State.Buffering:
          // console.log('state', 'Buffering')
          clearItv()
          duration = 0
          interval = setInterval(updateBuffer, 1000)
          void updateBuffer()
          break
        // case State.Connecting:
        //   console.log('state', 'Connecting')
        //   break
        // default:
        //   console.log('playback-state', data)
        //   break
      }
    })
    const removeNativeFlacListener = onNativeFlacPlayerEvent((event) => {
      switch (event.type) {
        case 'state':
          switch (event.state) {
            case 'loading':
            case 'buffering':
              clearItv()
              duration = event.duration ?? duration
              interval = setInterval(updateBuffer, 1000)
              void updateBuffer()
              break
            case 'playing':
              // 开始/恢复播放：只有「还没缓冲完」才建 1s 轮询。此前无条件建表，
              // 而首个 updateBuffer 在 buffered 已到时长（本地 FLAC 常态）时又立刻把它清掉
              // ——每秒白唤醒一次 JS 线程。duration 未知时先按需轮询，拿到时长后再缩小到
              // 「buffered < duration」这一个条件。
              clearItv()
              duration = event.duration ?? duration
              if (duration <= 0 || preBuffered < duration) interval = setInterval(updateBuffer, 1000)
              void updateBuffer()
              break
            case 'paused':
              clearItv()
              void updateBuffer()
              break
            case 'idle':
            case 'stopped':
              resetBuffer()
              break
          }
          break
        case 'ended':
          resetBuffer()
          break
        case 'error':
          clearItv()
          void updateBuffer()
          break
      }
    })

    void updateBuffer()
    if (isNativeFlacActive()) void updateBuffer()
    void TrackPlayer.getState().then((state) => {
      if (!isNativeFlacActive() && state == State.Buffering) interval = setInterval(updateBuffer, 1000)
    })
    return () => {
      isUnmounted = true
      sub.remove()
      removeNativeFlacListener()
      clearItv()
    }
  }, [])

  return progress
}
