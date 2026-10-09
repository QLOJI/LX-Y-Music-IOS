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
}

export default state
