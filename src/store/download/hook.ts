import { useEffect, useRef, useState } from 'react'
import state from './state'

/**
 * 下载任务列表（响应式）。
 *
 * enabled=false 时（页面被压栈页盖住 / 不在当前 tab / 退后台）不再 setState：
 * 下载进度回调是 250ms 一次，整页列表跟着重渲染在不可见时纯属耗电。
 * 重新可见时补一拍快照，隐藏期间错过的事件不会留下陈旧列表。
 */
export const useDownloadTasks = (enabled = true) => {
  const [tasks, setTasks] = useState([...state.tasks])
  // 初值取 enabled：正常首次挂载（可见）不额外多渲染一拍；
  // 「挂载时就不可见，之后才可见」也能在第一次可见时补同步。
  const wasEnabledRef = useRef(enabled)

  useEffect(() => {
    if (!enabled) {
      wasEnabledRef.current = false
      return
    }
    const handleUpdate = () => {
      setTasks([...state.tasks])
    }
    if (!wasEnabledRef.current) handleUpdate()
    wasEnabledRef.current = true
    global.app_event.on('download_list_changed', handleUpdate)
    return () => {
      global.app_event.off('download_list_changed', handleUpdate)
    }
  }, [enabled])

  return tasks
}
