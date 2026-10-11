import { NativeModules, Platform } from 'react-native'

interface NowPlayingInfoMetadata {
  title?: string
  artist?: string
  album?: string
  artwork?: string
  duration?: number
  elapsedTime?: number
  playbackRate?: number
  /** elapsedTime 快照的原生时钟戳（CACurrentMediaTime 毫秒）：歌词时钟重锚回放用，不进系统 info */
  elapsedTimeSnapshotAt?: number
  /** elapsedTime 快照的墙钟年龄（毫秒，无原生戳时的回放补偿），不进系统 info */
  elapsedTimeAgeMs?: number
}

interface NowPlayingStateOptions {
  elapsedTime?: number
  playbackRate?: number
}

export interface NowPlayingLyricLine {
  /** 行起始时间（ms） */
  time: number
  text: string
}

interface NativeNowPlayingModule {
  updateNowPlayingInfo?: (metadata: NowPlayingInfoMetadata) => Promise<void>
  playNowPlaying?: (options?: NowPlayingStateOptions) => Promise<void>
  pauseNowPlaying?: (options?: NowPlayingStateOptions) => Promise<void>
  stopNowPlaying?: (options?: NowPlayingStateOptions) => Promise<void>
  clearNowPlayingInfo?: () => Promise<void>
  setNowPlayingLyrics?: (
    lines: NowPlayingLyricLine[],
    positionMs?: number,
    snapshotAtMs?: number,
    ageMs?: number,
  ) => Promise<void>
  /** 引擎真实位置回传，重锚原生歌词/位置时钟（AppDelegate.mm 的 RCT_REMAP_METHOD 同名导出）。
   * snapshotAtMs：快照的原生时钟戳（CACurrentMediaTime 毫秒，精确回放锚点时刻）；
   * ageMs：快照墙钟年龄（无原生戳时原生以「now − 年龄」回放）。两者都缺省 = 旧行为。 */
  reanchorNowPlayingLyric?: (positionMs: number, snapshotAtMs?: number, ageMs?: number) => Promise<void>
  /** 【第 50 轮】卡片歌词区状态文案（「歌曲链接获取中 / 歌曲加载中 / 缓存中…」）。
   * 非空 = 覆盖歌词区并让行仲裁让位；空串 = 撤销覆盖、恢复当前歌词行。 */
  setNowPlayingStatusText?: (text: string) => Promise<void>
  /** 【第 50 轮】逐行快速通路：把当前歌词行直接写进卡片歌词区（取消换行延迟）。
   * 与 JS 逐行钩子（详情页大歌词）同一个事件触发，不走元数据发布管线。 */
  setNowPlayingCurrentLine?: (text: string) => Promise<void>
}

const NowPlayingModule = NativeModules.NowPlayingModule as NativeNowPlayingModule | undefined

const hasMethod = <K extends keyof NativeNowPlayingModule>(method: K) => {
  return Platform.OS == 'ios' && typeof NowPlayingModule?.[method] == 'function'
}

// 【第 34 轮第 2 条】第 33 轮第 4 条在这里做过一版「勾选『与其他应用同时播放』就整条抑制
// 元数据发布」的实现（原话「勾选后，退出灵动岛占用」），代价是**锁屏播放器也一起消失**
// —— 同一个 Now Playing 会话既是锁屏卡片也是灵动岛播放器的来源，公开 API 无法只关其中一个
//（第 33 轮交付物里已把这条例外写明）。本轮用户把需求改了：勾选后要「显示锁屏播放器界面」
// 且「还是保留同时播放功能」，于是抑制这条路径整体撤掉 —— 元数据照常发布，
// 勾选态下锁屏播放器回来；「前台不显示灵动岛播放器 / 切后台灵动岛与锁屏都显示」
// 本来就由系统按前后台自动决定，不需要（也不能）由代码开关。
// 元数据发布是唯一出口，play / pause / stop / 歌词 / 重锚五个桥与音频会话分类一概不动：
// 原生那条时钟（LXNowPlayingLyricStep）同时承担「前台 4Hz 位置事件 → JS 进度条」的枢纽职责。
export const updateNowPlayingInfo = async(metadata: NowPlayingInfoMetadata) => {
  if (!hasMethod('updateNowPlayingInfo')) return
  return NowPlayingModule?.updateNowPlayingInfo?.(metadata)
}

export const playNowPlaying = async(options: NowPlayingStateOptions = {}) => {
  if (!hasMethod('playNowPlaying')) return
  return NowPlayingModule?.playNowPlaying?.(options)
}

export const pauseNowPlaying = async(options: NowPlayingStateOptions = {}) => {
  if (!hasMethod('pauseNowPlaying')) return
  return NowPlayingModule?.pauseNowPlaying?.(options)
}

export const stopNowPlaying = async(options: NowPlayingStateOptions = {}) => {
  if (!hasMethod('stopNowPlaying')) return
  return NowPlayingModule?.stopNowPlaying?.(options)
}

export const clearNowPlayingInfo = async() => {
  if (!hasMethod('clearNowPlayingInfo')) return
  return NowPlayingModule?.clearNowPlayingInfo?.()
}

/** 歌词时间轴交给原生：原生 GCD 时钟直接驱动控制中心歌词（不依赖 JS 定时器）。
 * positionMs / snapshotAtMs / ageMs（可选）：装载同刻的引擎位置快照，原生在
 * 同一次调用内重锚 + 仲裁出当前行，锁屏/灵动岛不会先显示旧行再跳 —— 缺省时
 * 原生退回按缓存位置重锚（老调用兼容）。 */
export const setNowPlayingLyrics = async(
  lines: NowPlayingLyricLine[],
  positionMs?: number,
  snapshotAtMs?: number,
  ageMs?: number,
) => {
  if (!hasMethod('setNowPlayingLyrics')) return
  return NowPlayingModule?.setNowPlayingLyrics?.(lines, positionMs, snapshotAtMs, ageMs)
}

/** 引擎真实位置回传：重锚原生歌词/位置时钟（慢速校准 tick 调用）。
 * 时间补偿参数见接口注释——缺失时原生按旧行为把锚点钉在「现在」 */
export const reanchorNowPlayingLyric = async(positionMs: number, snapshotAtMs?: number, ageMs?: number) => {
  if (!hasMethod('reanchorNowPlayingLyric')) return
  return NowPlayingModule?.reanchorNowPlayingLyric?.(positionMs, snapshotAtMs, ageMs)
}

/** 【第 50 轮】把播放状态文案推给系统媒体卡片的歌词区（「歌曲链接获取中 / 歌曲加载中 /
 * 缓存中…」）。数据源与详情页底部状态条**完全同源**：store/player/action.ts 的 setStatusText
 * → global.state_event.playStateTextChanged → 转发器 core/init/player/nowPlayingStatus.ts
 * （受「显示蓝牙歌词」开关门控，与该字段的歌词用途一致）。
 * 状态非空时原生把它覆盖到歌词区（优先于时间轴行与逐行通路），传空串撤销覆盖、
 * 把当前歌词行立即仲裁回来。 */
export const setNowPlayingStatusText = async(text: string) => {
  if (!hasMethod('setNowPlayingStatusText')) return
  return NowPlayingModule?.setNowPlayingStatusText?.(text)
}

/** 【第 50 轮】逐行快速通路（取消换行延迟）：JS 逐行钩子（详情页大歌词的同一个
 * onLyricPlay 事件）把当前行直接写进卡片歌词区，不等元数据发布管线的桥往返。
 * 原生时钟仍是行权威（0.05s 内仲裁纠偏）；文本未变时原生直接跳过（幂等）。 */
export const setNowPlayingCurrentLine = async(text: string) => {
  if (!hasMethod('setNowPlayingCurrentLine')) return
  return NowPlayingModule?.setNowPlayingCurrentLine?.(text)
}
