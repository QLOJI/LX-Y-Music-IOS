import { cancelSyncModeModalRetries, dismissOverlay, onModalDismissed, showSyncModeModal } from '@/navigation'
import syncState from '@/store/sync/state'
import syncActions from '@/store/sync/action'

type RemoveListener = (() => void) | null
let removeEvent: RemoveListener

export const setSyncStatus = (status: LX.Sync.Status) => {
  syncActions.setStatus(status)
}

export const setSyncMessage = (message: LX.Sync.Status['message']) => {
  syncActions.setMessage(message)
}

export const setSyncModeComponentId = (id: string) => {
  syncActions.setSyncModeComponentId(id)
}

const closeSyncModeModal = () => {
  if (syncState.syncModeComponentId) {
    void dismissOverlay(syncState.syncModeComponentId)
    syncActions.setSyncModeComponentId('')
  }
  // 无论此刻有没有 componentId，都让 showSyncModeModal 里还没到点的「挂载复查」作废 ——
  // 用户已作答 / 取消 / 连接断开后若复查还活着，会把选择框重新弹出来（幽灵弹窗）。
  cancelSyncModeModalRetries()
}
export const selectSyncMode = async <T extends keyof LX.Sync.ModeTypes>(
  serverName: string,
  type: T,
) =>
  new Promise<LX.Sync.ModeTypes[T]>((resolve, reject) => {
    removeSyncModeEvent()
    syncActions.setServerInfo(serverName, type)
    showSyncModeModal()

    const removeListeners = () => {
      removeListener!()
      removeListener = null
      removeEvent = null
      global.app_event.off('selectSyncMode', handleSelectMode)
    }

    const handleSelectMode = ({ mode }: LX.Sync.ModeType) => {
      removeListeners()
      closeSyncModeModal()
      resolve(mode as LX.Sync.ModeTypes[T])
    }

    removeEvent = () => {
      removeListeners()
      reject(new Error('cancel'))
    }

    global.app_event.on('selectSyncMode', handleSelectMode)

    let removeListener: RemoveListener = onModalDismissed(syncState.syncModeComponentId, () => {
      syncActions.setSyncModeComponentId('')
      removeEvent?.()
    })
  })

export const removeSyncModeEvent = () => {
  if (!removeEvent) return
  removeEvent()
  removeEvent = null
  closeSyncModeModal()
}
