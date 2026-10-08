import { cancelSyncModeModalRetries, dismissOverlay, onModalDismissed, showSyncModeModal } from '@/navigation'
import syncState from '@/store/sync/state'
import syncActions from '@/store/sync/action'

type RemoveListener = (() => void) | null
let removeEvent: RemoveListener

// 【第 34 轮第 1 条】是否正有一个「同步方式」问句等着用户作答。
// 用途：plugins/sync/client/client.ts 的握手看门狗据此区分「卡死」与「用户在考虑」——
// 用户还在看选择框时不能催、也不能算超时。
let syncModeSelecting = false
export const isSyncModeSelecting = () => syncModeSelecting

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
    syncModeSelecting = true
    syncActions.setServerInfo(serverName, type)
    // 【第 34 轮第 1 条】等待用户作答期间把状态文案写清楚。
    // 以前这段时间界面上一直挂着连接建立时那句 'Wait syncing...'，用户根本不知道
    // 是在等自己点选择框（第 34 轮原话「会有很长的 Wait syncing... 的提示」）；
    // 作答 / 取消 / 失败三条路径都会立刻改掉这行字。
    setSyncMessage('等待选择同步方式...')
    // 呈现失败（重试用尽 / 去抖占位久占）必须把这次问询 reject 掉：
    // 绝不能让服务端干等一个永远不会到来的回答，那正是「永久 Wait syncing...」的成因。
    showSyncModeModal(handleUnavailable)

    let settled = false
    const removeListeners = () => {
      // showSyncModeModal 的失败回调可能早于下面 removeListener 的赋值（异步路径下成立，
      // 但这里不做假设）—— 一律用可选调用，避免「undefined is not a function」
      removeListener?.()
      removeListener = null
      removeEvent = null
      syncModeSelecting = false
      global.app_event.off('selectSyncMode', handleSelectMode)
    }

    const handleSelectMode = ({ mode }: LX.Sync.ModeType) => {
      if (settled) return
      settled = true
      removeListeners()
      closeSyncModeModal()
      setSyncMessage('')
      resolve(mode as LX.Sync.ModeTypes[T])
    }

    function handleUnavailable() {
      if (settled) return
      settled = true
      removeListeners()
      setSyncMessage('同步方式选择框未能显示，已中止本次同步')
      reject(new Error('sync mode modal unavailable'))
    }

    removeEvent = () => {
      if (settled) return
      settled = true
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
