import { useEffect, useState } from 'react'
import state from './state'

export const useStatus = () => {
  const [value, update] = useState(state.status)

  useEffect(() => {
    global.state_event.on('syncStatusUpdated', update)
    return () => {
      global.state_event.off('syncStatusUpdated', update)
    }
  }, [])

  return value
}

/**
 * 【第 42 轮第 1 条】主树兜底面（Home 树里的 SyncModeAskHost）的显示开关。
 * 常驻宿主默认返回 null、只在为 true 时画选择框 —— 订阅的是专用事件，
 * 不会被同步心跳（syncStatusUpdated）带着反复重渲染。
 */
export const useSyncModeAskFallback = () => {
  const [value, update] = useState(state.syncModeAskFallbackVisible)

  useEffect(() => {
    global.state_event.on('syncModeAskFallbackUpdated', update)
    return () => {
      global.state_event.off('syncModeAskFallbackUpdated', update)
    }
  }, [])

  return value
}
