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

// 【第 36 轮第 1 条】选择框「确实在屏幕上」的标记（SyncModeModal 挂载时置位、卸载时清零）。
//
// 为什么要有它：以前只有一个「有问句在等」的标记（syncModeSelecting），而它**只在问句
// 收尾时**才会回到 false。于是「选择框根本没弹出来」和「用户正在看选择框」在代码眼里
// 长得一模一样 —— 所有兜底逻辑都以为一切正常，谁都不吭声：
//   · showSyncModeModal 的重试入口见到 store 里还留着 id 就直接 return（静默死路）；
//   · client.ts 的握手看门狗以为用户在看选择框，60 秒到了也不提醒；
//   · 状态文案永远钉在「等待选择同步方式...」。
// 用户第 36 轮第 1 条看到的正是这三件事同时发生。有了「在不在屏幕上」这个独立信号，
// 三条兜底就有了判据：不在屏幕上的问句，必须被重新呈现、或者被明确地终止。
// 标记本体放在 store/sync/state.ts（navigation/utils.ts 要用同一个值，见那里的说明）
export const isSyncModeModalVisible = () => syncState.syncModeModalVisible
/** SyncModeModal 挂载时调用（选择框确实画到屏幕上了） */
export const markSyncModeModalVisible = () => { syncState.syncModeModalVisible = true }
/** SyncModeModal 卸载时调用（不管是被作答、被系统收走、还是宿主消失） */
export const markSyncModeModalHidden = () => { syncState.syncModeModalVisible = false }

// 问句的「最后一道保障」复查间隔：到期时若选择框仍不在屏幕上，就明确终止这次问句，
// 绝不让 Promise 与状态文案一起悬着（服务端 message2call 自己的超时是 120s，这里必须更短）。
const SYNC_MODE_ASK_CHECK_MS = 20000

// 【第 42 轮第 1 条】主树兜底面（SyncModeAskHost）的接管期限（毫秒）。
//
// 第 36~39 轮把「选择框一定会弹出来」全押在 RNN overlay 上（去抖、挂载复查、失败重试、
// 窗口提层都做了），用户第 42 轮的原话却依旧是「状态还是显示等待选择同步方式，最上层还是
// 没有显示这个窗口」。前面几轮能证到的最强事实只有一条：**JS 侧以为挂上了** —— 问句的文案
// 永远停在「等待选择同步方式...」，说明 20 秒问句复查每次都读到「在屏幕上」而无限续期，
// 也就是 SyncModeModal 的挂载回调确实跑过；可 iOS 上那个独立 UIWindow 在这个工程里就是
// 画不出来（overlay 是不是被压层、窗口是不是根本没进层，JS 侧无从判断）。
//
// 所以本轮换判据：不再问 overlay「挂上没挂上」，只问**问句有没有结果** —— 到期还没作答，
// 就地换面：把同一个选择框搬到**主窗口的 React 树**里画（Home 视图树的 SyncModeAskHost）。
// 那条路不依赖任何独立 UIWindow、不经过 RNN 的呈现通道，只要 Home 在屏幕上就一定看得见
// （「数据同步」页本身就在 Home 的视图树里）。
const SYNC_MODE_FALLBACK_MS = 1500

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
  // 【第 36 轮第 1 条】我们主动关掉选择框时，先摘掉「在屏幕上」的标记：
  // 卸载回调要等原生走完才到 JS，中间这段时间里它已经不算「在屏幕上」了。
  markSyncModeModalHidden()
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

    // 【第 36 轮第 1 条】最后一道保障：问句必须有结果（用户在问句里读到的那几行状态，
    // 不能永远停住）。
    //
    // 为什么单靠既有兜底还不够：这个问句的收尾路径有六条（作答 / 呈现失败 / 用户取消 /
    // 弹窗被系统收走 / 连接断开 / 组件卸载），但每一条都要靠一个**外部信号**才能到齐 ——
    // 原生转场事件、卸载回调、socket close…… 只要有一条信号没送到（iOS 上 overlay 被
    // 宿主 VC 带走却没跑到 JS 卸载清理，就是这类），这次问句就永远没有结果：
    //   · 服务端一直等我们回答（用户看到「一直等待选择同步方式」）；
    //   · 同步永远不 finished()，状态栏也永远到不了「已连接」。
    // 所以这里不看信号、只看事实：到点了选择框还不在屏幕上，就当场把它结束掉，
    // 由 handleUnavailable 给出明确文案（服务端据此中止本次同步，界面不再悬着）。
    // 选择框**在屏幕上**时一直续期 —— 用户在看、在思考，属于合理的长等待。
    let askGuardTimer: ReturnType<typeof setTimeout> | null = null
    const clearAskGuard = () => {
      if (askGuardTimer) {
        clearTimeout(askGuardTimer)
        askGuardTimer = null
      }
    }
    const armAskGuard = () => {
      askGuardTimer = setTimeout(() => {
        askGuardTimer = null
        if (settled) return
        if (isSyncModeModalVisible()) {
          armAskGuard()
          return
        }
        handleUnavailable()
      }, SYNC_MODE_ASK_CHECK_MS)
    }

    // 【第 42 轮第 1 条】主树兜底面的接管期限 + 接管动作。
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    const clearFallbackTimer = () => {
      if (fallbackTimer) {
        clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
    }
    /**
     * 到期还没等到作答 ⇒ 把问句交给主树兜底面呈现（同一个选择框组件，换一个宿主）。
     * 顺序是有讲究的：**先**立接管判据，**再**去拆 overlay ——
     *   · setSyncModeAskFallbackVisible(true)：Home 树里的宿主据此画出来，并且
     *     handleSyncModeModalUnmounted 与 onAnyModalDismissed 两条卸载通路都靠它让行
     *     （否则我们主动拆 overlay 引发的卸载回调会把这次问句按「用户取消」杀掉 ——
     *     那正是第 34~39 轮反复踩的那颗雷）；
     *   · markSyncModeModalVisible()：兜底面同样算「选择框在屏幕上」，20 秒问句复查与
     *     client.ts 的 60 秒握手看门狗据此让行（用户在看、在思考，属于合理的长等待）；
     *   · cancelSyncModeModalRetries()：让 showSyncModeModal 里还没到点的挂载复查作废，
     *     免得它把 overlay 重新弹到兜底面上；
     *   · 最后才拆 overlay：先清 store 里的 id（看门狗与卸载身份比对随即无从命中），
     *     再 dismissOverlay —— 屏幕上永远只有一个选择框。
     */
    const handOverToFallback = () => {
      syncActions.setSyncModeAskFallbackVisible(true)
      markSyncModeModalVisible()
      cancelSyncModeModalRetries()
      const id = syncState.syncModeComponentId
      if (id) {
        syncActions.setSyncModeComponentId('')
        void dismissOverlay(id)
      }
      console.log('[SyncMode] ask handed over to in-tree fallback surface')
    }

    const removeListeners = () => {
      // showSyncModeModal 的失败回调可能早于下面 removeListener 的赋值（异步路径下成立，
      // 但这里不做假设）—— 一律用可选调用，避免「undefined is not a function」
      removeListener?.()
      removeListener = null
      removeDismissListener?.()
      removeDismissListener = null
      removeEvent = null
      syncModeSelecting = false
      // 【第 36 轮第 1 条】问句有了结果，最后一道保障的复查就撤掉
      clearAskGuard()
      // 【第 42 轮第 1 条】问句有了结果，主树兜底面的接管期限与兜底面本身一起收掉
      // （作答 / 取消 / 断开 / 呈现失败四条路径都从这里过，兜底面绝不残留）
      clearFallbackTimer()
      syncActions.setSyncModeAskFallbackVisible(false)
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
      // 【第 42 轮第 1 条】主树兜底面接管后，overlay 的关闭事件是**我们自己**拆出来的，
      // 不是用户把框点走了 —— 让行（兜底面上那个框还活着、还能作答）。
      if (syncState.syncModeAskFallbackVisible) return
      if (!syncState.syncModeComponentId || dismissedId != syncState.syncModeComponentId) return
      syncActions.setSyncModeComponentId('')
      // 状态文案也要跟着改：旧路径下这里一声不吭，那行字会一直停在
      // 「等待选择同步方式...」（用户第 35 轮第 2 条看到的正是这一行）。
      setSyncMessage('同步方式选择已取消，本次同步已中止')
      removeEvent?.()
    })

    // 手脚接好之后再呈现（handleUnavailable 可能被同步调用，见上方说明）
    // 【第 36 轮第 1 条】呈现的同时把「最后一道保障」点起来
    armAskGuard()
    showSyncModeModal(handleUnavailable)
    // 【第 42 轮第 1 条】呈现之后同时点起**主树兜底面**的接管期限（说明见 SYNC_MODE_FALLBACK_MS）。
    // 放在 showSyncModeModal 之后：它可能**同步**回调 handleUnavailable（去抖占满那条路），
    // 那种情况下 removeListeners 已经跑过 —— 这里再点起来的定时器由回调开头的 settled 判据拦下。
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null
      if (settled) return
      handOverToFallback()
    }, SYNC_MODE_FALLBACK_MS)
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
export const handleSyncModeModalUnmounted = (componentId?: string) => {
  // 【第 38 轮第 2 条】身份比对必须**排在摘标记之前**（旧写法是先无条件
  // markSyncModeModalHidden，再比对 —— 顺序反了）。
  //
  // 反了会怎样：新一轮问句已经把自己的选择框换上去了，上一个选择框姗姗来迟的卸载回调
  // 到 JS 时，第一句就把**新**选择框的「在屏幕上」标记清成 false。连锁反应有三步：
  //   ① navigation/utils.ts 的挂载复查（1000ms 到点读这个标记）读到 false ⇒ 判「没挂上」
  //      ⇒ 700ms 后再 present 一个 overlay，盖在那个活着的选择框上面；第二个挂载时发现
  //      store 里是别人的 id，会把第一个 dismissOverlay 掉 —— 屏幕上两个都没了（或者
  //      闪一下就没），正是用户读到的「选择框迟迟不出现」；
  //   ② core/sync.ts 的 20 秒问句复查也会因为标记为 false 而把这次问句判死
  //      （文案变成「同步方式选择框未能显示，已中止本次同步」）；
  //   ③ client.ts 的握手看门狗同一判据。
  // 现在：不是自己人的卸载回调，整个忽略 —— 标记、文案、问句全都不动。
  //
  // 只有「消失的正是当前问句的那个选择框」才算取消。传了 componentId 才比对
  // （不传 = 调用方只是要报告消失，见下）；比对的两个值都非空才作数，
  // 作答路径清空 id 的先后顺序不影响（closeSyncModeModal 先清 id 再 dismiss，
  // 于是它引发的卸载回调会落到「store id 为空」这一支，由下面的 syncModeSelecting 接管）。
  // 【第 42 轮第 1 条】主树兜底面已经接管时，这条卸载回调整个忽略 —— 它不是「用户跑了」，
  // 而是**我们自己**在接管时主动拆掉的 overlay（handOverToFallback，见那里的顺序说明）：
  // 标记、文案、问句一概不动，用户接着在兜底面上作答。
  if (syncState.syncModeAskFallbackVisible) return
  if (componentId && syncState.syncModeComponentId && componentId != syncState.syncModeComponentId) return
  // 比对通过（自己人，或调用方没带 id）：它下一秒就要被原生拆掉了，属于**已经**不在屏幕上。
  markSyncModeModalHidden()
  if (!syncModeSelecting) return
  // 状态文案必须跟着改：旧路径下这里一声不吭，那行字会一直停在「等待选择同步方式...」
  setSyncMessage('同步方式选择已取消，本次同步已中止')
  // 走既有的取消通路：置 settled、撤监听、reject('cancel')，服务端据此中止本次同步
  removeSyncModeEvent()
}

export const removeSyncModeEvent = () => {
  // 【第 36 轮第 1 条】以前是 `if (!removeEvent) return` —— 只要没有在途问句，
  // 连选择框都不收。连接断开 / 切开关这类路径于是在屏幕上留下一个仍然活着的选择框
  // （下一次问句的呈现发现 store 里还留着它的 id，就直接不弹了）。
  // 现在无论有没有在途问句都把选择框收干净（closeSyncModeModal 对空 id 是安全的）。
  if (removeEvent) {
    removeEvent()
    removeEvent = null
  }
  closeSyncModeModal()
}
