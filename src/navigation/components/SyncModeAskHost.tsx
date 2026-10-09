import { View } from 'react-native'

import { createStyle } from '@/utils/tools'
import syncState from '@/store/sync/state'
import { useSyncModeAskFallback } from '@/store/sync/hook'
import ModalContent from './ModalContent'
import { DislikeModeModal, ListModeModal } from './SyncModeModal'

/**
 * 【第 42 轮第 1 条】「同步方式」问句的**主树兜底面**（常驻在 Home 视图树里）。
 *
 * 用户第 42 轮原话：「同步服务地址的状态还是显示等待选择同步方式，最上层还是没有显示这个
 * 窗口，歌单也没有同步成功，请强制修复」。
 *
 * 为什么不能再押 overlay：第 36~39 轮把「一定会弹出来」全做在 RNN overlay 上（去抖、
 * 挂载复查、失败重试、窗口提层），用户看到的却始终是「状态停在等待选择同步方式、框子不出来」。
 * 这条症状能反推出的最强事实是「JS 侧以为挂上了」（否则 20 秒问句复查早就把问句判死、
 * 文案会变成「同步方式选择框未能显示」）——也就是 SyncModeModal 的挂载回调跑过，
 * 但 iOS 上那个独立 UIWindow 在这个工程里就是画不出来。JS 侧没有任何可靠信号能证明
 * 「overlay 真的在屏幕上」（onLayout 只能证明布局过，证明不了在屏幕上），再叠一层
 * 「挂载复查」也还是在赌同一个窗口。
 *
 * 所以本组件换一条**不依赖独立 UIWindow、也不经过 RNN 呈现通道**的路：
 *   · 常驻挂载在 Home 屏的视图树里（Home 是唯一根屏、全程挂载；「数据同步」页本身就在
 *     Home 的视图树内），默认返回 null —— 不显示时零渲染零开销；
 *   · core/sync.ts 在问句到期还没作答时（SYNC_MODE_FALLBACK_MS）把它打开
 *     （syncModeAskFallbackVisible），并把手上的 overlay 收掉，屏幕上永远只有一个选择框；
 *   · 呈现的按钮 / 文案与 overlay 那套是**同一份组件**（SyncModeModal 的
 *     ListModeModal / DislikeModeModal），作答走同一条 global.app_event.selectSyncMode，
 *     所以「用户答完 → resolve → 服务端继续同步」这条链路一个字都不用改。
 *
 * 层级：zIndex 200 —— 高于下载悬浮球（100）、底部 tab 栏（3）、各页头部（10），
 * 只要 Home 在屏幕上，这一层就一定盖在最上面（全屏绝对定位 + 半透明底，与 overlay 观感一致）。
 * 已知边界（如实写在这里）：Home 被 push 的原生页面盖住时（播放详情页等）Home 树脱离窗口，
 * 这一层自然也跟着不可见；那种情况下问句会一直等着（不误判、不超时），用户一回到 Home
 * 就能看到并作答 —— 这是**有意的取舍**：宁可等，也不许再把问句无声无息地判死。
 */
export default () => {
  const visible = useSyncModeAskFallback()

  // 不显示 / 问答类型不合法时返回 null：
  // 前者是常驻宿主的常态；后者对齐 SyncModeModal 的同款守卫 —— 一个「什么都没画」的
  // 全屏层会整片吃掉触摸（点哪都没反应），绝不许出现。
  if (!visible) return null
  if (syncState.type != 'list' && syncState.type != 'dislike') return null

  return (
    <View style={styles.root}>
      <ModalContent>
        {syncState.type == 'list' ? <ListModeModal /> : <DislikeModeModal />}
      </ModalContent>
    </View>
  )
}

const styles = createStyle({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // 盖过 Home 树里所有既有浮层（下载球 100 / 头部 10 / tab 栏 3）
    zIndex: 200,
  },
})
