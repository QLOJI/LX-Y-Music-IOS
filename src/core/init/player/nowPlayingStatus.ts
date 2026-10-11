import { setNowPlayingStatusText } from '@/utils/nativeModules/nowPlaying'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { Platform } from 'react-native'

// 「显示蓝牙歌词」取值（与 init/player/lyric.ts 同口径：未初始化视为开）。
// 关闭时歌词区只留歌名·歌手，状态文案同样不占位（否则关掉歌词开关后「缓存中…」
// 还会顶在歌名下面，与开关语义自相矛盾）。取值函数而非模块级快照：设置页可随时切换。
const isShowBluetoothLyric = () => settingState.setting['player.isShowBluetoothLyric'] ?? true

// 【第 50 轮】锁屏 / 灵动岛歌词区状态文案。用户原话（第 50 轮第 1 条）：「锁屏和灵动岛
// 界面在歌词区域增加歌曲链接获取中、歌曲加载中、缓存中等状态显示，因为我发现刚开始播放
// 歌曲时，歌词区域是空白显示的，实际播放详情页的大歌词已经有歌词显示了或者歌曲还在加载，
// 这个需要实时反馈到歌词区域」。
//
// 数据源与详情页底部的 Status 完全同源：store/player/action.ts 的 setStatusText 唯一出口
// → global.state_event.playStateTextChanged；这里只做转发 + 开关门控，不改任何播放状态
// 语义（文案本身仍由播放链路按原节奏写入，state 自带同值去重）。
// 原生侧（AppDelegate.mm 的 LXSetNowPlayingStatusText）：非空 = 覆盖歌词区并让行仲裁
// 让位；空串 = 撤销覆盖、把当前歌词行立即仲裁回来。歌词区 = artist 字段，与歌词共用
// 同一行，故与「显示蓝牙歌词」开关同门控。
//
// 覆盖的状态（等，全部非空文案都会镜像）：歌曲链接获取中 / 歌曲加载中 / 缓存中 /
// URL 过期刷新中 / 服务器繁忙重试 / 切换其它来源 / 音频加载出错 / 歌词获取失败 等。
export const syncNowPlayingStatusText = () => {
  if (Platform.OS != 'ios') return
  const text = isShowBluetoothLyric() ? (playerState.statusText ?? '') : ''
  void setNowPlayingStatusText(text)
}

export default () => {
  if (Platform.OS != 'ios') return
  // 订阅唯一出口：状态一变化就转发（含「清空」，原生据此把当前歌词行仲裁回来）。
  global.state_event.on('playStateTextChanged', syncNowPlayingStatusText)
  // 首帧对齐：初始化时 state 里的残留文案（热重载 / 板块重挂载）不至于漏发。
  syncNowPlayingStatusText()
}
