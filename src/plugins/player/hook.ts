import { useEffect, useState, useRef } from 'react'
import { AppState } from 'react-native'
import TrackPlayer, { State, Event } from 'react-native-track-player'
import {
  getNativeFlacBufferedPosition,
  getNativeFlacDuration,
  getNativeFlacPosition,
  isNativeFlacActive,
  onNativeFlacPlayerEvent,
} from './nativeFlac'
import { getUnifiedPlaybackState, onUnifiedPlayerEvent } from './engine'
// 前台判定复用工具函数（全应用只有这一处的语义来源，避免各自写一遍 currentState 比较）
import { isActive } from '@/utils/tools'

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

    // 【第 20 轮·耗电契约 ①（2026-10-03）】「该不该轮询」由播放状态机决定（Playing /
    // Buffering 才往下走，上面那行早退）；「现在能不能轮询」还要求 App 在前台。
    // 真正的 setInterval 与起表前的补测**只此一处**（syncItv），所以「退后台就不轮询」
    // 只需在这一个判定点成立，不必在每个分支各写一遍 —— 与同文件 useBufferProgress
    // 同一套写法（那边的「该不该轮询」是随播放事件变化的 wantPolling，这边是 effect
    // 依赖里的 playerState，效果等价：状态一变本 effect 重建，起表点重新过门）。
    // 背景：本 hook 每秒做 3 次原生桥往返（getPosition / getDuration /
    // getBufferedPosition，nativeFlac 路径同样 3 次）再 setState；音频后台播放时
    // 进程常驻，此前完全没有前台门，锁屏后仍整夜空转。同文件的 useBufferProgress 与
    // core/init/player/playProgress.ts 都有前台门（isActive / AppState 守卫），
    // 唯独这一处漏了 —— 现在三处同一口径。位置/时长/缓冲都是实测值，后台不需要推算，
    // 回前台重新测一次即可，状态无残留。
    let interval: ReturnType<typeof setInterval> | null = null
    const clearItv = () => {
      if (!interval) return
      clearInterval(interval)
      interval = null
    }
    const syncItv = () => {
      clearItv()
      if (!isActive()) return
      // 起表前先补一次实测（首帧 / 回前台立即有值，不用等一个周期）；它与
      // setInterval 共用同一道前台门 —— 后台一次桥往返都不发。
      void getProgress()
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      interval = setInterval(getProgress, updateInterval || 1000)
    }

    syncItv()

    // 前后台订阅：退到后台立即停表（省电）；回到前台补一次实测再起表。
    // 用跨行参数写法与 useBufferProgress 里的订阅区分，便于脚本与日志各自定位。
    const appStateSubscription = AppState.addEventListener(
      'change',
      (nextState) => {
        if (nextState === 'active') {
          syncItv()
        } else {
          clearItv()
        }
      },
    )

    return () => {
      clearItv()
      appStateSubscription.remove()
    }
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
    // 「该不该轮询」由播放状态机决定（Playing/Buffering 且还没缓冲完 → true）；
    // 「现在能不能轮询」还要求 App 在前台。两个条件分开记，回前台时才不会破坏
    // 「暂停不空转 / 缓冲满不空转」这两条既有口径（见下方 syncItv）。
    let wantPolling = false

    const clearItv = () => {
      if (!interval) return
      clearInterval(interval)
      interval = null
    }
    const resetBuffer = () => {
      clearItv()
      wantPolling = false
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
      if (buffered > 0 && buffered == duration) {
        // 整首缓冲完：停表，并把「该轮询」也置回 false ——
        // 否则退后台再回前台时会被 syncItv 重新拉起来，白转一整首。
        wantPolling = false
        clearItv()
      }
      if (buffered == preBuffered || isUnmounted) return
      preBuffered = buffered
      setProgress(duration ? (buffered / duration) : 0)
    }
    // 起表点**统一收敛到这一处**（2026-10-02 用户第 8 条）：以上所有「该轮询了」的
    // 分支只负责置 wantPolling，真正的 setInterval 只此一处 —— 于是「App 不在前台
    // 就不起表」只需要在这里判定一次，不需要在每个分支里各写一遍。
    // 背景：缓冲进度只有在前台的播放详情页才看得见，但锁屏后进程仍常驻（音频后台播放），
    // 此前是每秒一次原生桥往返 + setState 空转，原生 FLAC 路径还会一直轮询到整首歌缓冲完。
    const syncItv = () => {
      clearItv()
      if (!wantPolling || !isActive()) return
      interval = setInterval(updateBuffer, 1000)
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
          wantPolling = false
          syncItv()
          break
        case State.Playing:
          // 恢复播放：只有「还没缓冲完」才重建 1s 轮询——已缓冲到时长的曲目（本地/整文件就绪）
          // 不再每秒白唤醒一次 JS 线程；未缓冲完的会在缓冲完成时由 updateBuffer 内部自行停表。
          // duration 未知（<=0）时先轮询一次，等 updateBuffer 拿到时长后再判。
          wantPolling = duration <= 0 || preBuffered < duration
          syncItv()
          void updateBuffer()
          break
        case State.Buffering:
          // console.log('state', 'Buffering')
          duration = 0
          wantPolling = true
          syncItv()
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
              duration = event.duration ?? duration
              wantPolling = true
              syncItv()
              void updateBuffer()
              break
            case 'playing':
              // 开始/恢复播放：只有「还没缓冲完」才建 1s 轮询。此前无条件建表，
              // 而首个 updateBuffer 在 buffered 已到时长（本地 FLAC 常态）时又立刻把它清掉
              // ——每秒白唤醒一次 JS 线程。duration 未知时先按需轮询，拿到时长后再缩小到
              // 「buffered < duration」这一个条件。
              duration = event.duration ?? duration
              wantPolling = duration <= 0 || preBuffered < duration
              syncItv()
              void updateBuffer()
              break
            case 'paused':
              wantPolling = false
              syncItv()
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
          wantPolling = false
          syncItv()
          void updateBuffer()
          break
      }
    })

    // 前后台订阅（2026-10-02 用户第 8 条）：退到后台立即停表（省电）；回前台**补一次实测**
    // 再按需恢复 —— 缓冲进度是实测值（getBufferedPosition），不存在需要保存的
    // 「后台期间推算了多少」，所以回来只需重新测一次。
    // 这里绝不无条件起表：syncItv 会同时检查 wantPolling（暂停中 / 已缓冲满都不重启）。
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void updateBuffer()
        syncItv()
      } else {
        clearItv()
      }
    })

    void updateBuffer()
    if (isNativeFlacActive()) void updateBuffer()
    void TrackPlayer.getState().then((state) => {
      if (!isNativeFlacActive() && state == State.Buffering) {
        wantPolling = true
        syncItv()
      }
    })
    return () => {
      isUnmounted = true
      sub.remove()
      removeNativeFlacListener()
      appStateSubscription.remove()
      clearItv()
    }
  }, [])

  return progress
}
