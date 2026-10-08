import { type EmitterSubscription } from 'react-native'
import { Navigation } from 'react-native-navigation'

export const onModalDismissed = (id: string, handler: () => void) => {
  let modalDismissedListener: EmitterSubscription | null =
    Navigation.events().registerModalDismissedListener(({ componentId, modalsDismissed: _modalsDismissed }) => {
      if (componentId != id || !modalDismissedListener) return
      handler()
      modalDismissedListener.remove()
      modalDismissedListener = null
    })
  return () => {
    if (!modalDismissedListener) return
    modalDismissedListener.remove()
    modalDismissedListener = null
  }
}

/**
 * 【第 35 轮第 2 条】「任意弹窗被关掉」的单次订阅，回调参数是**被关掉那个弹窗的
 * componentId**（onModalDismissed 是在注册时把 id 闭包进去的，只对那一个 id 生效）。
 *
 * 为什么需要它：overlay 的 componentId 由 RNN 在呈现时生成，**呈现发起方拿不到** ——
 * 拿到的只有「组件挂载后自己写回 store」的那个值。所以「等某次问询被用户/系统关掉」
 * 这种订阅，在**发起问询的当下**根本写不出正确的 id。core/sync.ts 第 34 轮的写法
 * `onModalDismissed(syncState.syncModeComponentId, …)` 正是踩了这个坑：那行代码在
 * 选择框挂载之前执行，闭包到的是空串，于是这个「兜底看门狗」永远不会触发
 * （用户第 35 轮实锤：状态一直停在「等待选择同步方式...」，选择框却已经不在屏幕上）。
 *
 * 口径：订阅时不做任何 id 假设，触发时把它交给调用方判断 —— 调用方在**触发那一刻**
 * 读 store 里的当前 id 做比对，天然免疫「注册早于挂载」。
 * 这是持续性订阅（不自动摘除），调用方拿到返回值自行在收尾时调用。
 */
export const onAnyModalDismissed = (handler: (componentId: string) => void) => {
  const modalDismissedListener: EmitterSubscription =
    Navigation.events().registerModalDismissedListener(({ componentId }) => {
      if (!componentId) return
      handler(componentId)
    })
  return () => {
    modalDismissedListener.remove()
  }
}
