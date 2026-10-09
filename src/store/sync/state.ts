interface InitState {
  status: LX.Sync.Status
  serverName: string
  type: keyof LX.Sync.ModeTypes
  syncModeComponentId: string
  /**
   * 【第 36 轮第 1 条】「同步方式」选择框是否**确实在屏幕上**（组件挂载置 true、卸载置 false）。
   *
   * 放在 store 里是为了让 navigation/utils.ts 与 core/sync.ts 读到同一个值而不是互相 import
   * （navigation 与 core/sync 本来就互相依赖，再加一条 import 会绕成环）。
   * 它不是渲染状态（不 emit syncStatusUpdated），只是给兜底逻辑看的判据：
   * syncModeComponentId 非空 ≠ 选择框还在屏幕上（原生收走 overlay 时 JS 卸载清理可能跑不到），
   * 只有这个标记能回答「用户此刻到底看不看得见那个框」。
   */
  syncModeModalVisible: boolean
  /**
   * 【第 42 轮第 1 条】「同步方式」问句是否已交给**主树兜底面**呈现（Home 视图树里的
   * SyncModeAskHost）。
   *
   * 为什么必须再开一条路：第 36~39 轮把「一定弹出来」全押在 RNN overlay 上（去抖、复查、
   * 重试、提层都做了），但用户第 42 轮的原话依旧是「同步服务地址的状态还是显示等待选择
   * 同步方式，最上层还是没有显示这个窗口」—— 前几轮能证到的是「JS 侧以为挂上了」
   * （syncModeModalVisible 为 true ⇒ 20 秒问句复查无限续期），而 iOS 上 overlay 的
   * 独立窗口在这个工程里就是画不出来。所以本轮的判据不再问 overlay「挂上没挂上」，
   * 只问**问句有没有结果**：到点还没作答，就把问句搬到主窗口的 React 树里画
   * （那条路不依赖任何独立 UIWindow，只要 Home 在屏幕上就一定能看见）。
   *
   * 这是渲染状态（由 syncModeAskFallbackUpdated 驱动），与 syncModeModalVisible 的分工：
   *   · syncModeModalVisible —— 「有一个呈现面接着」的兜底判据（提层复查 / 握手看门狗用）；
   *   · syncModeAskFallbackVisible —— 「主树兜底面就是当前呈现面」的渲染开关。
   */
  syncModeAskFallbackVisible: boolean
}
const state: InitState = {
  status: {
    status: false,
    message: '',
  },
  serverName: '',
  type: 'list',
  syncModeComponentId: '',
  syncModeModalVisible: false,
  syncModeAskFallbackVisible: false,
}

export default state
