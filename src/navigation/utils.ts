import { Navigation } from 'react-native-navigation'
import { VERSION_MODAL, PACT_MODAL, SYNC_MODE_MODAL, ANNOUNCEMENT_MODAL } from './screenNames'
import themeState from '@/store/theme/state'
import syncState from '@/store/sync/state'

const pendingOverlays = new Set<string>()

// 同步方式选择框的「挂载复查」代次：每次 showSyncModeModal 递增；core/sync 在用户作答 /
// 取消 / 连接断开（closeSyncModeModal）时调用 cancelSyncModeModalRetries 使其作废，
// 避免复查把用户已经回答过的选择框重新弹出来（幽灵弹窗）。
let syncModeModalSeq = 0
export const cancelSyncModeModalRetries = () => {
  syncModeModalSeq += 1
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

export const showSyncModeModal = () => {
  if (pendingOverlays.has(SYNC_MODE_MODAL)) return
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

  const handleFail = (attempt: number, err: unknown) => {
    console.error('[SyncMode] showOverlay failed:', attempt, err)
    if (attempt >= maxAttempts) return
    setTimeout(() => {
      // 重试窗口内用户已作答 / 取消 / 断开（或又来了新一轮呈现）—— 作废，不再重试。
      // 少了这道检查，作废发生在 700ms 窗口里时仍会把用户已经离开的选择框补弹出来。
      if (seq !== syncModeModalSeq) return
      present(attempt + 1)
    }, retryDelay)
  }

  const present = (attempt: number) => {
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
          setTimeout(() => {
            // 已被作答 / 取消（或新一轮 show）作废 —— 什么都不做
            if (seq !== syncModeModalSeq) return
            if (syncState.syncModeComponentId) return
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
