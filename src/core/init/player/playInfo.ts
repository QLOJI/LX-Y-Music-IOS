import { getPlayInfo } from '@/utils/data'
import { getSavedPlaybackProgress } from '@/utils/nativeModules/utils'
import { getListMusics } from '@/core/list'
import { playList, play } from '@/core/player/player'


export default async(setting: LX.AppSetting) => {
  const info = await getPlayInfo()
  global.lx.restorePlayInfo = null
  if (!info?.listId || info.index < 0) return

  const list = await getListMusics(info.listId)
  if (!list[info.index]) return
  // 【第 101 轮】用**原生记录**覆盖「最后进度」：那份与锁屏进度条同源、在后台也每 1Hz 更新，
  // 强杀前最后一次写入就是杀之前的真实位置（JS 那几次落盘在「暂停后退出 / 强杀」时本来就停了）。
  // 认歌靠时长：与 JS 记录的 maxTime 相差 ≤2s 才算同一首，否则保留 JS 那份。
  if (info.maxTime > 0) {
    const nativeProgress = await getSavedPlaybackProgress()
    if (nativeProgress && Math.abs(nativeProgress.duration - info.maxTime) <= 2 && nativeProgress.time > 0) {
      info.time = Math.min(nativeProgress.time, nativeProgress.duration)
    }
  }
  global.lx.restorePlayInfo = info

  await playList(info.listId, info.index)

  if (setting['player.startupAutoPlay']) setTimeout(play)


  //   log.warn('Restore Play Info failed: ', JSON.stringify(info2, null, 2))

  //   return
  // }

  // }

}
