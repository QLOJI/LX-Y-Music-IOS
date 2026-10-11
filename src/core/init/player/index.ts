import initPlayer from './player'
import initPlayInfo from './playInfo'
import initPlayStatus from './playStatus'
import initWatchList from './watchList'
import initPlayProgress from './playProgress'
import initPreloadNextMusic from './preloadNextMusic'
import initPlayHistory from './playHistory'
import initLyric from './lyric'
import initNowPlayingStatus from './nowPlayingStatus'
import initRemoteCommand from './remoteCommand'
import { bootLog } from '@/utils/bootLog'

export default async(setting: LX.AppSetting) => {
  bootLog('Core player init...')
  await initPlayer(setting)
  bootLog('Core player done.')
  bootLog('Lyric init...')
  await initLyric(setting)
  bootLog('Lyric done.')
  // 【第 50 轮】卡片歌词区状态文案（歌曲链接获取中 / 歌曲加载中 / 缓存中…）：
  // 与详情页状态条同源的转发器，锁屏 / 灵动岛歌词区不再在起播阶段空着。
  initNowPlayingStatus()
  bootLog('Now playing status init...')
  bootLog('Play info init...')
  void initPlayInfo(setting)
    .then(() => { bootLog('Play info done.') })
    .catch((err: any) => { bootLog('Play info failed:', err?.stack ?? err?.message ?? err) })
  initPlayStatus()
  initWatchList()
  initPlayProgress()
  initPreloadNextMusic()
  // 本项目独有：播放历史记录。参考分支没有该模块，这里保留挂载，
  // 否则「播放历史」页面将不再产生任何记录。
  initPlayHistory()
  initRemoteCommand()
  bootLog('Player listeners done.')
}
