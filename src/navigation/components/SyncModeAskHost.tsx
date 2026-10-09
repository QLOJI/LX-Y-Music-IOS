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
 *   · 常驻挂载在「用户可能在的那一屏」的视图树里（默认返回 null，不显示时零渲染零开销）：
 *     Home 屏（根屏，全程挂载）+ SettingDetail 屏（「数据同步」页所在的那张 push 屏，
 *     见 src/screens/SettingDetail/index.tsx，【第 45 轮第 2 条】新增的挂载点）；
 *   · core/sync.ts 在问句到期还没作答时（SYNC_MODE_FALLBACK_MS）把它打开
 *     （syncModeAskFallbackVisible），并把手上的 overlay 收掉，屏幕上永远只有一个选择框；
 *   · 呈现的按钮 / 文案与 overlay 那套是**同一份组件**（SyncModeModal 的
 *     ListModeModal / DislikeModeModal），作答走同一条 global.app_event.selectSyncMode，
 *     所以「用户答完 → resolve → 服务端继续同步」这条链路一个字都不用改。
 *
 * 层级：zIndex 200 —— 高于下载悬浮球（100）、底部 tab 栏（3）、各页头部（10），
 * 宿主那一屏在屏幕上时，这一层就一定盖在最上面（全屏绝对定位 + 半透明底，与 overlay 观感一致）。
 *
 * 【第 45 轮第 2 条】为什么多了一个挂载点：用户原话「数据同步中的同步服务地址功能，在第一次
 * 连接过程中，可以显示同步方式的弹窗了，但是弹出位置不对，这个弹窗应该在数据同步界面弹出
 * 显示」。根因与 SettingDetail 里三条登录弹窗注释记的那条平台事实相同 —— 一张 push 屏盖住
 * Home 后，Home 的整棵树就脱离窗口：问句触发时用户正停在「数据同步」（SettingDetail），
 * 弹窗只有等用户自己退回 Home 才画得出来（于是出现在设置页上）。把同一个组件也挂进
 * SettingDetail 的 PageContent 末尾，「用户在数据同步页点连接 → 1.5 秒后就在这一页看到
 * 选择框」。两份实例渲染的是同一份状态、点的是同一条作答链路；任一时刻只有最上面那屏的
 * 那一份可见，收尾时（作答 / 取消 / 断开 / 呈现失败）syncModeAskFallbackVisible 置回
 * false，两份一起卸载（handleSyncModeModalUnmounted 对兜底面已让行，见 core/sync.ts）。
 * 已知边界（如实写在这里）：用户停在**其它** push 屏（播放详情页等）时这一层仍不可见，
 * 那种情况下问句会一直等着（不误判、不超时），用户一回到挂载了宿主的屏就能看到并作答 ——
 * 这是**有意的取舍**：宁可等，也不许再把问句无声无息地判死。
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
