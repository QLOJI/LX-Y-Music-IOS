import { Navigation } from 'react-native-navigation'
import { VERSION_MODAL, PACT_MODAL, SYNC_MODE_MODAL, ANNOUNCEMENT_MODAL } from './screenNames'
import themeState from '@/store/theme/state'
import syncState from '@/store/sync/state'
import syncActions from '@/store/sync/action'
import { raiseSyncModeOverlay } from '@/utils/nativeModules/utils'

const pendingOverlays = new Set<string>()

// 同步方式选择框的「去抖占位被占住」重来计数（见 showSyncModeModal 的说明）
let guardRetryCount = 0

// 同步方式选择框的「挂载复查」代次：每次 showSyncModeModal 递增；core/sync 在用户作答 /
// 取消 / 连接断开（closeSyncModeModal）时调用 cancelSyncModeModalRetries 使其作废，
// 避免复查把用户已经回答过的选择框重新弹出来（幽灵弹窗）。
let syncModeModalSeq = 0
export const cancelSyncModeModalRetries = () => {
  syncModeModalSeq += 1
  // 【第 34 轮第 1 条】作废的同时把「呈现去抖」占位也放掉。
  // pendingOverlays 的这道占位原本要等 500ms 的定时器自己过期，而它会**静默吞掉**
  // 紧跟着到来的下一个问题：服务端连着问「歌单同步方式」和「不喜欢列表同步方式」时，
  // 第二个问题进来时占位还在 ⇒ showSyncModeModal 直接 return ⇒ 那个问题永远没人回答、
  // Promise 永不 settle ⇒ 服务端一直等、客户端一直卡在 'Wait syncing...'。
  // 关掉一个选择框就说明上一个问题已经收尾，占位没有继续存在的理由。
  pendingOverlays.delete(SYNC_MODE_MODAL)
}

export const getStatusBarStyle = (isDark: boolean) => (isDark ? 'light' : 'dark')

// RNN dismissOverlay 偶发失败（重复 dismiss / 竞态时原生侧抛错且 Promise reject）。
// 透明 overlay 一旦残留，interceptTouchOutside: true 会拦截全屏触摸，
// 表现为整页点不动的“假死”，故失败时记录并重试一次。
export const dismissOverlay = async(compId: string) => {
  try {
    await Navigation.dismissOverlay(compId)
  } catch (err) {
    console.warn('[navigation] dismissOverlay failed, retrying:', compId, err)
    try {
      await Navigation.dismissOverlay(compId)
    } catch (retryErr) {
      console.error('[navigation] dismissOverlay retry failed:', compId, retryErr)
    }
  }
}

// pop 不带自定义转场：RNN iOS 的自定义转场被取消（如动画期间再次导航）或 JS 空闲时
// 永不调用 completeTransition，会把整个导航栈卡死。全 app 的 push/pop 统一走系统默认
// 动画，由 UIKit 处理打断，无此问题（详见 navigation.ts pushPlayDetailScreen 注释）。
export const pop = async(compId: string) => Navigation.pop(compId)
export const popToRoot = async(compId: string) => Navigation.popToRoot(compId)
export const popTo = async(compId: string) => Navigation.popTo(compId)

export const showPactModal = () => {
  if (pendingOverlays.has(PACT_MODAL)) return
  pendingOverlays.add(PACT_MODAL)
  setTimeout(() => pendingOverlays.delete(PACT_MODAL), 500)
  const theme = themeState.theme

  // overlay 展示失败必须兜底重试：协议弹窗是首次安装的「准入」弹窗，一旦静默失败
  // （窗口未就绪、转场竞态等），用户会在未同意协议的情况下直接使用，且要到下次启动才会再弹。
  // 重试间隔取去抖窗口之后（600ms），最多 3 次；成功时 Promise resolve，不再重试。
  const show = (attempt: number) => {
    const handleFail = (err: unknown) => {
      console.error('[Pact] showOverlay failed:', attempt, err)
      if (attempt >= 3) return
      setTimeout(() => { show(attempt + 1) }, 600)
    }
    try {
      void Navigation.showOverlay({
        component: {
          name: PACT_MODAL,
          options: {
            layout: {
              componentBackgroundColor: 'transparent',
            },
            overlay: {
              interceptTouchOutside: true,
            },
            statusBar: {
              drawBehind: true,
              visible: true,
              style: getStatusBarStyle(theme.isDark),
              backgroundColor: 'transparent',
            },
            navigationBar: {
              // visible: false,
              backgroundColor: theme['c-content-background'],
            },
            // animations: {

            //   showModal: {
            //     enter: {
            //       enabled: true,
            //       alpha: {
            //         from: 0,
            //         to: 1,
            //         duration: 300,
            //       },
            //     },
            //     exit: {
            //       enabled: true,
            //       alpha: {
            //         from: 1,
            //         to: 0,
            //         duration: 300,
            //       },
            //     },
            //   },
            // },
          },
        },
      }).catch(handleFail)
    } catch (err) {
      handleFail(err)
    }
  }
  show(1)
}

export const showVersionModal = () => {
  if (pendingOverlays.has(VERSION_MODAL)) return
  pendingOverlays.add(VERSION_MODAL)
  setTimeout(() => pendingOverlays.delete(VERSION_MODAL), 500)
  const theme = themeState.theme

  // 与 showPactModal 对齐：overlay 展示失败必须兜底重试（窗口未就绪、转场竞态等都可能让
  // showOverlay 静默失败，透明 overlay 一旦残留，interceptTouchOutside 会拦截全屏触摸），
  // 失败时由 handleFail 统一接管、不留未捕获的 reject。重试间隔取去抖窗口之后（600ms），最多 3 次。
  const show = (attempt: number) => {
    const handleFail = (err: unknown) => {
      console.error('[Version] showOverlay failed:', attempt, err)
      if (attempt >= 3) return
      setTimeout(() => { show(attempt + 1) }, 600)
    }
    try {
      void Navigation.showOverlay({
        component: {
          name: VERSION_MODAL,
          options: {
            layout: {
              componentBackgroundColor: 'transparent',
            },
            overlay: {
              interceptTouchOutside: true,
            },
            statusBar: {
              drawBehind: true,
              visible: true,
              style: getStatusBarStyle(theme.isDark),
              backgroundColor: 'transparent',
            },
            navigationBar: {
              // visible: false,
              backgroundColor: theme['c-content-background'],
            },
            // animations: {

            //   showModal: {
            //     enter: {
            //       enabled: true,
            //       alpha: {
            //         from: 0,
            //         to: 1,
            //         duration: 300,
            //       },
            //     },
            //     exit: {
            //       enabled: true,
            //       alpha: {
            //         from: 1,
            //         to: 0,
            //         duration: 300,
            //       },
            //     },
            //   },
            // },
          },
        },
      }).catch(handleFail)
    } catch (err) {
      handleFail(err)
    }
  }
  show(1)
}

/**
 * 呈现服务端驱动的「同步方式」选择框。
 *
 * @param onUnavailable 【第 34 轮第 1 条】呈现彻底失败（重试次数用尽 / 去抖占位久占不放）时的
 *   回调。以前这种情况**什么都不做就 return**：用户既看不到任何提示，服务端的那个问句也永远
 *   等不到回答（core/sync.ts 的 Promise 永不 settle），客户端状态就永久停在 'Wait syncing...'
 *   （用户第 34 轮第 1 条实锤的日志：服务端已收到 88 首本地歌单、手里有 31 首远端歌单，
 *   正在等客户端回答同步方式，而客户端这边一声不吭）。现在把失败**回传**给调用方，
 *   由它 reject 掉那次问询 —— 服务端据此中止本次同步，界面给出明确状态。
 */
export const showSyncModeModal = (onUnavailable?: () => void) => {
  // 【第 38 轮第 2 条】进入本次呈现时的代次快照：下面去抖分支排队重来时用它判「这次请求
  // 是不是已经过期」。任何一条收尾路径（作答 / 取消 / 断开 / 新一轮呈现）都会同步递增
  // syncModeModalSeq（handleSelectMode → closeSyncModeModal → cancelSyncModeModalRetries；
  // 新一轮呈现自己在下面 ++），所以「代次变了」= 用户那边已经有结果了。
  const entrySeq = syncModeModalSeq
  if (pendingOverlays.has(SYNC_MODE_MODAL)) {
    // 去抖窗口里又来了一个呈现请求：不能静默吞掉（上面的历史 bug 就是它造成的）。
    // 等窗口过期再自己重来一次；连试 3 次仍然占着，就按「呈现不可用」上报。
    if (guardRetryCount < 3) {
      guardRetryCount += 1
      setTimeout(() => {
        // 【第 38 轮第 2 条】等窗口这段时间里用户已经作答 / 取消 / 断开了（代次递增）——
        // 这次呈现请求作废，绝不能再补弹一个「幽灵选择框」（用户会看到一个自己早已
        // 回答过的问题，而且它会顶掉新一轮问句的呈现）。旧写法没有这道检查。
        if (syncModeModalSeq !== entrySeq) return
        showSyncModeModal(onUnavailable)
      }, 600)
      return
    }
    console.error('[SyncMode] overlay debounce occupied, give up')
    guardRetryCount = 0
    onUnavailable?.()
    return
  }
  guardRetryCount = 0
  pendingOverlays.add(SYNC_MODE_MODAL)
  setTimeout(() => pendingOverlays.delete(SYNC_MODE_MODAL), 500)
  const theme = themeState.theme

  // 服务端驱动的「列表同步方式」选择框：连接码验证成功后由服务端询问，客户端负责弹出。
  // 一旦弹不出来，同步会永远卡在等用户选择上（selectSyncMode 的 Promise 不 settle），
  // 所以呈现要做到「确认真的挂载了」为止。失败路径有二：
  //  ① showOverlay 直接 reject（转场竞态、窗口未就绪等）——由 .catch 接管；
  //  ② iOS 上呈现时机撞上原生 Modal（连接码输入框）正在关闭：RNN 会把 overlay 挂在那个
  //     正在消失的宿主 VC 之上，随它一起消失，而 Promise 仍然 resolve —— 只监听 reject
  //     会漏掉这种静默失败（用户第 15 轮第 1 条：验证成功后选择框不弹出）。
  // 故 resolve 之后再延时复查 SyncModeModal 挂载时写回的 componentId（挂载判据）：
  // 仍为空说明没挂上 → 重试呈现；已挂上 → 停手，绝不叠第二个（overlay 是
  // interceptTouchOutside: true 的全屏透明层，叠层残留会拦截整页触摸）。
  // 复查前先比代次：用户在复查到点前已作答 / 取消（closeSyncModeModal 递增代次）就作废，
  // 不再重试，否则会弹出用户已经回答过的「幽灵弹窗」。
  const verifyDelay = 1000
  const retryDelay = 700
  const maxAttempts = 5
  const seq = ++syncModeModalSeq
  // 【第 38 轮第 2 条】本轮呈现（含重试）是否已经**真的**把 overlay 推出去过。
  // 用来区分 present() 入口那个「已经有选择框在屏幕上」判据的两种来源：见下面的长注释。
  let presentedThisRound = false

  const handleFail = (attempt: number, err: unknown) => {
    console.error('[SyncMode] showOverlay failed:', attempt, err)
    if (attempt >= maxAttempts) {
      // 【第 34 轮第 1 条】重试用尽 = 这个问题再也问不出来了。以前这里直接 return，
      // 于是「弹不出来」和「永远等待」在界面上长得一模一样（用户第 34 轮第 1 条的
      // 'Wait syncing...'）。现在上报给调用方（core/sync.ts 会 reject 掉这次问询）。
      console.error('[SyncMode] give up presenting overlay, attempts =', attempt)
      onUnavailable?.()
      return
    }
    setTimeout(() => {
      // 重试窗口内用户已作答 / 取消 / 断开（或又来了新一轮呈现）—— 作废，不再重试。
      // 少了这道检查，作废发生在 700ms 窗口里时仍会把用户已经离开的选择框补弹出来。
      if (seq !== syncModeModalSeq) return
      present(attempt + 1)
    }, retryDelay)
  }

  const present = (attempt: number) => {
    // 【第 35 轮第 2 条】已经有一个活着的选择框就绝不再呈现第二个。
    //
    // 上面的「挂载复查」是**延时 1000ms** 才看的：挂载慢一点（原生 Modal 正在淡出、
    // 桥接繁忙）就会先判「没挂上」→ 700ms 后 present(attempt + 1)。若第一次其实已经挂上，
    // 第二次呈现的副本会在挂载时发现 store 里是别人的 id，调用 dismissOverlay 把**第一个**
    // 关掉 —— 两个都不在了是可能的（第二个还没挂稳就被后续重试顶掉），表现正是用户第 35 轮
    // 第 2 条看到的「状态写着等待选择同步方式，选择框却迟迟不出现」。
    // 复查已挂上就停手这条判据（下一段的 if）保持不变，这里只是把同样的判据前移到呈现入口，
    // 让「重试」永远只能补一个**真的不存在**的选择框。
    //
    // 【第 36 轮第 1 条】「有 id」不等于「选择框在屏幕上」—— id 是「组件挂载时写回、
    // 卸载清理时清掉」的：原生把 overlay 收走却没跑到 JS 卸载清理时，这个 id 就是一条
    // **残留**，此后每一次呈现都在这里静默 return：不呈现、不重试、不上报失败，
    // 问句与状态文案一起永久悬着。用户第 36 轮第 1 条看到的三件事（状态一直
    // 「等待选择同步方式」、选择框不弹、也等不到「已连接」）正是这条静默死路的连锁反应。
    // 判据改用「确实在屏幕上」（由 SyncModeModal 挂载 / 卸载维护）。
    if (syncState.syncModeModalVisible) {
      // 【第 38 轮第 2 条】这条判据本身是对的（不许叠第二个 overlay），但旧写法是
      // **无条件静默 return** —— 于是它同时成了一个死路：标记只要因为任何一种
      // 「原生把选择框收走、JS 侧的卸载清理没跑到」而残留成 true，本轮每一次
      // present()（含 5 次重试）都在这里无声返回：不呈现、不重试、不上报失败，
      // core/sync.ts 的 20 秒问句复查又因为 isSyncModeModalVisible() 为 true 而无限续期
      // ⇒ 服务端的问句永远等不到回答、状态文案永远钉在「等待选择同步方式...」
      // （用户第 38 轮第 2 条：状态只会显示等待选择同步方式，弹不出选择窗口）。
      //
      // 现在把两种来源分开：
      //   · presentedThisRound 为 true = 本轮自己刚把 overlay 推出去过（挂载复查到点前的
      //     去抖重入 / 复查失败后的重试）—— 真的可能已经在屏幕上了，静默停手是正解；
      //   · 否则 = 上一轮留下的陈旧标记。走到这里说明本轮已经过
      //     selectSyncMode → removeSyncModeEvent → closeSyncModeModal（它先摘标记、
      //     再 dismissOverlay 掉手里的 id），上一轮的选择框必然已经被要求关闭 ——
      //     标记与事实不符，就地纠正（清标记 + 清 id）后照常呈现，绝不静默 return。
      if (presentedThisRound) return
      console.warn('[SyncMode] stale syncModeModalVisible, reset before presenting')
      syncState.syncModeModalVisible = false
    }
    if (syncState.syncModeComponentId) {
      // 不在屏幕上却留着 id = 残留，先清掉再照常呈现（绝不静默 return）
      console.warn('[SyncMode] stale syncModeComponentId, clear before presenting:', syncState.syncModeComponentId)
      syncActions.setSyncModeComponentId('')
    }
    // 从这里开始算「本轮真的推过 overlay 了」：上面的挂载复查（1000ms）与失败重试
    // （700ms）都只在 presentedThisRound 为 true 之后才可能重入 present()，
    // 于是重入时那道 visible 判据对「本轮已推、可能已挂上」和「上一轮残留」给出不同结论。
    presentedThisRound = true
    try {
      void Navigation.showOverlay({
        component: {
          name: SYNC_MODE_MODAL,
          options: {
            layout: {
              componentBackgroundColor: 'transparent',
            },
            overlay: {
              interceptTouchOutside: true,
            },
            statusBar: {
              drawBehind: true,
              visible: true,
              style: getStatusBarStyle(theme.isDark),
              backgroundColor: 'transparent',
            },
            navigationBar: {
              // visible: false,
              backgroundColor: theme['c-content-background'],
            },
            // animations: {

            //   showModal: {
            //     enter: {
            //       enabled: true,
            //       alpha: {
            //         from: 0,
            //         to: 1,
            //         duration: 300,
            //       },
            //     },
            //     exit: {
            //       enabled: true,
            //       alpha: {
            //         from: 1,
            //         to: 0,
            //         duration: 300,
            //       },
            //     },
            //   },
            // },
          },
        },
      })
        .then(() => {
          // 【第 39 轮第 1 条】overlay 已推给原生：立刻把浮层窗口提到最上层。
          // 选择框所在的 RNN overlay 是独立 UIWindow，windowLevel 与主窗口同为
          // UIWindowLevelNormal —— 主窗口被 makeKeyAndVisible（或后建的原生面板窗口出现）时
          // 它会被压到下面，表现为「状态一直停在等待选择同步方式...、屏幕上却什么都没有」。
          // 这里是**第一时间**的提层（组件挂载时还会再提一次，并在存活期间持续提，
          // 详见 SyncModeModal 的 OVERLAY_RAISE_INTERVAL_MS 说明）。提层幂等、旧构建下安全降级。
          raiseSyncModeOverlay()
          setTimeout(() => {
            // 已被作答 / 取消（或新一轮 show）作废 —— 什么都不做
            // （这条不是静默死路：作废只可能来自「这次问句已经有结果」或「更新的呈现接手了」，
            //   两种情况都有别人负责收尾）
            if (seq !== syncModeModalSeq) return
            // 【第 36 轮第 1 条】判据同上：看「在不在屏幕上」，不看 id —— 残留 id 会让
            // 复查误判成「已挂载」而停止重试，选择框就再也不会出现。
            if (syncState.syncModeModalVisible) return
            handleFail(attempt, new Error('overlay not mounted'))
          }, verifyDelay)
        })
        .catch((err) => {
          handleFail(attempt, err)
        })
    } catch (err) {
      handleFail(attempt, err)
    }
  }
  present(1)
}

// export const showToast = (text) => {
//   Navigation.showOverlay({
//     component: {
//       name: TOAST_SCREEN,
//     },
//   })
// }

export const showAnnouncementModal = () => {
  if (pendingOverlays.has(ANNOUNCEMENT_MODAL)) return
  pendingOverlays.add(ANNOUNCEMENT_MODAL)
  setTimeout(() => pendingOverlays.delete(ANNOUNCEMENT_MODAL), 500)
  console.log('[Announcement] showAnnouncementModal called')
  const theme = themeState.theme
  console.log('[Announcement] Theme loaded:', !!theme)

  // 与 showPactModal 对齐：overlay 展示失败必须兜底重试（窗口未就绪、转场竞态等都可能让
  // showOverlay 静默失败，透明 overlay 一旦残留，interceptTouchOutside 会拦截全屏触摸），
  // 失败时由 handleFail 统一接管、不留未捕获的 reject。重试间隔取去抖窗口之后（600ms），最多 3 次。
  const show = (attempt: number) => {
    const handleFail = (err: unknown) => {
      console.error('[Announcement] showOverlay failed:', attempt, err)
      if (attempt >= 3) return
      setTimeout(() => { show(attempt + 1) }, 600)
    }
    try {
      void Navigation.showOverlay({
        component: {
          name: ANNOUNCEMENT_MODAL,
          options: {
            layout: {
              componentBackgroundColor: 'transparent',
            },
            overlay: {
              interceptTouchOutside: true,
            },
            statusBar: {
              drawBehind: true,
              visible: true,
              style: getStatusBarStyle(theme.isDark),
              backgroundColor: 'transparent',
            },
            navigationBar: {
              backgroundColor: theme['c-content-background'],
            },
          },
        },
      }).then(() => {
        console.log('[Announcement] Overlay shown successfully')
      }).catch(handleFail)
    } catch (err) {
      handleFail(err)
    }
  }
  show(1)
}
