import {
  createList,
  removeUserList,
  getListMusics,
  overwriteListMusics,
  updateUserList,
} from '@/core/list'
import { stageOnlineListToDefault } from '@/core/playListToDefault'
import listState from '@/store/list/state'
import settingState from '@/store/setting/state'
import { toast } from '@/utils/tools.ts'

export const handlePlay = async(list: LX.Music.MusicInfoOnline[], index = 0) => {
  // 每日推荐整份写入试听列表(DEFAULT)，不再走临时列表：勾选「自动清空已播放列表」时
  // 整份覆盖旧内容，未勾选时整份置顶、旧内容保留（语义见 core/playListToDefault.ts）。
  // 这样长按迷你播放器封面能落到「我的」页的试听列表卡片上。
  await stageOnlineListToDefault('dailyrec_wy', [...list], index)
}

/**
 * Get logical date based on 7 AM boundary
 * @returns {Date} Calculated date object
 */
const getLogicalDateForPlaylist = (): Date => {
  const now = new Date()
  if (now.getHours() < 7) {
    now.setDate(now.getDate() - 1)
  }
  return now
}

/**
 * Auto-save daily recommendations to my list
 * @param songList Daily recommendation song list
 */
export const autoSaveDailyPlaylist = async(songList: LX.Music.MusicInfoOnline[]) => {
  if (!settingState.setting['list.isAutoSaveDailyRec']) return
  if (!songList.length) return

  const logicalDate = getLogicalDateForPlaylist()
  const month = (logicalDate.getMonth() + 1).toString().padStart(2, '0')
  const day = logicalDate.getDate().toString().padStart(2, '0')
  const playlistName = `${month}_${day}_daily`

  const existingPlaylist = listState.userList.find(p => p.name === playlistName)

  if (existingPlaylist) {
    const existingSongs = await getListMusics(existingPlaylist.id)
    if (existingSongs.length && existingSongs[0].id === songList[0].id) {
      console.log(`歌单 ${playlistName} 无需更新，跳过保存。`)
      return
    }
    console.log(`歌单 ${playlistName} 内容已更新，执行覆盖操作。`)
    await overwriteListMusics(existingPlaylist.id, songList)
    await updateUserList([{ ...existingPlaylist, locationUpdateTime: Date.now() }])
    toast(`已自动更新每日推荐: ${playlistName}`)
  } else {
    const dailyPlaylists = listState.userList.filter(p => /\d{2}_\d{2}_daily/.test(p.name))
    if (dailyPlaylists.length >= 15) {
      dailyPlaylists.sort((a, b) => a.name.localeCompare(b.name))
      const oldestPlaylist = dailyPlaylists[0]
      if (oldestPlaylist) {
        await removeUserList([oldestPlaylist.id])
      }
    }
    try {
      await createList({
        name: playlistName,
        list: songList,
      })
      toast(`已自动保存每日推荐: ${playlistName}`)
    } catch (error: any) {
      toast(`自动保存每日推荐失败: ${error.message}`)
      console.error('自动保存每日推荐失败:', error)
    }
  }
}
