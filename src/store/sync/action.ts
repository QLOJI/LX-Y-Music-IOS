import state from './state'

export default {
  setStatus(info: LX.Sync.Status) {
    state.status.status = info.status
    state.status.message = info.message

    global.state_event.syncStatusUpdated({ ...state.status })
  },
  setMessage(message: LX.Sync.Status['message']) {
    state.status.message = message

    global.state_event.syncStatusUpdated({ ...state.status })
  },
  setServerInfo(name: string, type: keyof LX.Sync.ModeTypes) {
    state.serverName = name
    state.type = type
  },
  setSyncModeComponentId(id: string) {
    state.syncModeComponentId = id
  },
  /**
   * 【第 42 轮第 1 条】主树兜底面（SyncModeAskHost）的显示开关。
   * 这是**渲染状态**：必须 emit，否则 Home 树里那个常驻宿主不知道自己该画出来了。
   */
  setSyncModeAskFallbackVisible(visible: boolean) {
    if (state.syncModeAskFallbackVisible == visible) return
    state.syncModeAskFallbackVisible = visible
    global.state_event.syncModeAskFallbackUpdated(visible)
  },
}
