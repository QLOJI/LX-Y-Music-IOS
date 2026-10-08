import { cancelSyncModeModalRetries, dismissOverlay, onAnyModalDismissed, showSyncModeModal } from '@/navigation'
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
    // 【第 35 轮第 2 条】呈现调用移到本执行体**最末**（见函数尾部）：showSyncModeModal 在
    // 「去抖占位被占满」时会**同步**回调 handleUnavailable，而 handleUnavailable 要调用下面
    // 才初始化的 removeListeners —— 放这一行在前面就是一个 TDZ（Cannot access
    // 'removeListeners' before initialization）。先把手脚都接好再呈现。

    let settled = false
    let removeDismissListener: RemoveListener = null
    const removeListeners = () => {
      // showSyncModeModal 的失败回调可能早于下面 removeListener 的赋值（异步路径下成立，
      // 但这里不做假设）—— 一律用可选调用，避免「undefined is not a function」
      removeListener?.()
      removeListener = null
      removeDismissListener?.()
      removeDismissListener = null
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

    let removeListener: RemoveListener = null

    // 【第 35 轮第 2 条】「选择框被关掉」的兜底看门狗。
    //
    // 用户原话：「同步状态显示等待选择同步方式...，但是迟迟没有弹出选择窗口，而且选择一次后，
    // 后面就不会显示了」。第 34 轮这里写的是
    //   onModalDismissed(syncState.syncModeComponentId, …)
    // —— 而 overlay 的 componentId 只有 SyncModeModal **挂载之后**才写回 store，这一行却在
    // 挂载之前执行，闭包到的是空串 ''。onModalDismissed 是「id 在注册时闭包进去、只对该 id
    // 生效」的语义（src/navigation/event.ts），于是这个看门狗**一次都不会触发**：
    // 选择框被任何非作答路径关掉（点外面、宿主 VC 消失、系统收走）时，
    //   · 这次问询的 Promise 永不 settle —— 服务端一直等；
    //   · syncModeSelecting 一直是 true —— 第 34 轮的握手看门狗把它当成「用户在考虑」，
    //     既不催也不超时；
    //   · 状态文案就永远钉在「等待选择同步方式...」。
    // 换成 onAnyModalDismissed：触发时把「被关掉的那个 componentId」交回来，与**当下**的
    // store 值比对，天然免疫「注册早于挂载」。自己作答/取消关掉的路径不会误判——
    // closeSyncModeModal 会先清空 store 里的 id，比对随即失败（且 settled 已经是 true）。
    removeDismissListener = onAnyModalDismissed((dismissedId) => {
      if (settled) return
      if (!syncState.syncModeComponentId || dismissedId != syncState.syncModeComponentId) return
      syncActions.setSyncModeComponentId('')
      // 状态文案也要跟着改：旧路径下这里一声不吭，那行字会一直停在
      // 「等待选择同步方式...」（用户第 35 轮第 2 条看到的正是这一行）。
      setSyncMessage('同步方式选择已取消，本次同步已中止')
      removeEvent?.()
    })

    // 手脚接好之后再呈现（handleUnavailable 可能被同步调用，见上方说明）
    showSyncModeModal(handleUnavailable)
  })

/**
 * 【第 35 轮第 2 条】选择框组件自己报告「我不在屏幕上了」（SyncModeModal 卸载清理里调用）。
 *
 * 为什么不能只靠 RNN 的弹窗关闭事件：overlay 的 componentId 只有组件挂载后才知道，
 * 而「卸载」与「原生关闭事件到达 JS」的先后顺序不保证 —— 卸载清理会先把 store 里的 id
 * 清成空串，等事件到达时已经无从比对，看门狗就漏掉这一路。组件直接回调没有这个竞态。
 *
 * 判据只用 syncModeSelecting：它只在「确实有一个问句在等」时为 true，而作答 / 取消 /
 * 呈现失败三条收尾路径都会把它置回 false（removeListeners）。所以用户点了选项、我们再
 * 关掉选择框时，这里不会被误当成「用户跑了」。
 */
export const handleSyncModeModalUnmounted = () => {
  if (!syncModeSelecting) return
  // 状态文案必须跟着改：旧路径下这里一声不吭，那行字会一直停在「等待选择同步方式...」
  setSyncMessage('同步方式选择已取消，本次同步已中止')
  // 走既有的取消通路：置 settled、撤监听、reject('cancel')，服务端据此中止本次同步
  removeSyncModeEvent()
}

export const removeSyncModeEvent = () => {
  if (!removeEvent) return
  removeEvent()
  removeEvent = null
  closeSyncModeModal()
}
