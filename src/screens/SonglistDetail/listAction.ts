import { createList } from '@/core/list'
import { getListDetail, getListDetailAll } from '@/core/songlist'
import { refreshDefaultList, stageOnlineListToDefault } from '@/core/playListToDefault'
import listState from '@/store/list/state'
import syncSourceList from '@/core/syncSourceList'
import { confirmDialog, toMD5, toast } from '@/utils/tools'
import { type Source } from '@/store/songlist/state'

const getListId = (id: string, source: LX.OnlineSource) => `${source}__${id}`

export const handlePlay = async(
  id: string,
  source: Source,
  list?: LX.Music.MusicInfoOnline[],
  index = 0,
) => {
  const listId = getListId(id, source)
  let isPlayingList = false
  if (!list?.length) {
    try {
      list = (await getListDetail(id, source, 1)).list
    } catch (err) {
      console.error('[handlePlay] 获取歌单详情失败:', err)
      toast('获取歌单失败，请稍后重试')
      return
    }
  }
  if (list?.length) {
    try {
      // 点歌把歌单整份写入试听列表(DEFAULT)；是否清空旧内容由 player.isAutoCleanPlayedList 决定
      await stageOnlineListToDefault(listId, [...list], index)
      isPlayingList = true
    } catch (err) {
      // 原先 setTempList 抛错会变成未捕获拒绝（静默），表现为「点了没反应」
      console.error('[handlePlay] 播放失败:', err)
      toast('播放失败，请重试')
      return
    }
  }
  try {
    const fullList = await getListDetailAll(source, id)
    if (!fullList.length) return
    if (isPlayingList) {
      if (fullList.length > (list?.length ?? 0)) {
        console.log(`[handlePlay] 完整歌单已加载：${fullList.length} 首，更新试听列表顶部`)
        // 仅当试听列表顶部仍是这份歌单时才会生效（playListToDefault 内部校验），
        // 取代原先的 listState.tempListMeta.id == listId 守卫
        await refreshDefaultList(listId, [...fullList])
      }
    } else {
      await stageOnlineListToDefault(listId, [...fullList], index)
    }
  } catch (err) {
    console.error('[handlePlay] 获取完整歌单失败:', err)
    if (!isPlayingList) {
      toast('获取歌单失败，请稍后重试')
    }
  }
}

export const handleCollect = async(id: string, source: Source, name: string) => {
  const listId = getListId(id, source)

  const targetList = listState.userList.find((l) => l.sourceListId == listId)
  if (targetList) {
    const confirm = await confirmDialog({
      message: global.i18n.t('duplicate_list_tip', { name: targetList.name }),
      cancelButtonText: global.i18n.t('list_import_part_button_cancel'),
      confirmButtonText: global.i18n.t('confirm_button_text'),
    })
    if (!confirm) return
    void syncSourceList(targetList)
    return
  }

  // 收藏需要拉取完整歌单（逐页请求），耗时可能较长：
  // 点击后立即提示进行中，结束时明确反馈成功/失败，避免长时间无响应的观感
  toast('收藏中...')
  try {
    const list = await getListDetailAll(source, id)
    await createList({
      name,
      id: `${source}_${toMD5(listId)}`,
      list,
      source,
      sourceListId: id,
    })
    toast(global.i18n.t('collect_success'))
  } catch (err: any) {
    toast(`收藏失败：${err?.message || '请稍后重试'}`)
  }
}
