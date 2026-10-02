import { connectServer } from '@/plugins/sync'
import { updateSetting } from '@/core/common'
import { getSyncHost } from '@/plugins/sync/data'
import { syncPendingChangesOnStartup } from '@/core/sync/webdavSync.ts'

export default async(setting: LX.AppSetting) => {
  // 冷启动不再无条件同步一次歌单：只有本地攒着未同步的歌单操作时才补同步。
  // 用户反馈（第 19 轮第 5 条）「启用同步后，退出后，每次返回软件都会马上同步一次」，
  // 源头就是这里每次启动都直接 triggerWebDAVSync()。
  if (setting['sync.webdav.url']) {
    void syncPendingChangesOnStartup()
  }
  if (!setting['sync.enable']) return

  const host = await getSyncHost()
  // console.log(host)
  if (!host) {
    updateSetting({ 'sync.enable': false })
    return
  }
  // 冷启动自动连接：静默连接，不弹 "Sync connected" toast（手动/重连仍会弹）。
  void connectServer(host, undefined, { silent: true })
}
