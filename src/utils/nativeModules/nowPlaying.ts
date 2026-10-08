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
}

const NowPlayingModule = NativeModules.NowPlayingModule as NativeNowPlayingModule | undefined

const hasMethod = <K extends keyof NativeNowPlayingModule>(method: K) => {
  return Platform.OS == 'ios' && typeof NowPlayingModule?.[method] == 'function'
}

// 【第 33 轮第 4 条】「与其他应用同时播放」勾选期间**退出灵动岛 / 锁屏卡片占用**：
// 只抑制元数据发布这一个出口；play / pause / stop / 歌词 / 重锚五个桥一律照旧 ——
// 原生那条时钟（LXNowPlayingLyricStep）同时承担「前台 4Hz 位置事件 → JS 进度条」的
// 枢纽职责，砍掉状态桥会让前台进度条失去唯一驱动源。
// 元数据不发布 ⇒ 原生 info 缓存保持为空 ⇒ 系统不再展示本应用的播放卡片（第 24 轮
// 实机反馈里的「勾选后卡片消失」现象在本轮由需求反转为**期望**：用户第 33 轮第 4 条
// 原话「勾选后，退出灵动岛占用」）。
let nowPlayingInfoSuppressed = false

/** 【第 33 轮第 4 条】切换「与其他应用同时播放」时由 plugins/player/index.ts 下发 */
export const setNowPlayingInfoSuppressed = (suppressed: boolean) => {
  nowPlayingInfoSuppressed = suppressed
}

export const updateNowPlayingInfo = async(metadata: NowPlayingInfoMetadata) => {
  // 【第 33 轮第 4 条】勾选期间不发：卡片已在切换的那一刻清掉，这里保证它不再被建回来
  //（取消勾选由 syncPlayWithOthersEnabled 按当前曲目重新发布）。
  if (nowPlayingInfoSuppressed) return
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
