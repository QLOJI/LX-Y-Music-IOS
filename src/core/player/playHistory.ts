import { LIST_IDS } from '@/config/constant'
import { markListsChanged } from '@/core/sync/webdavSync'
import { getPlayHistory, savePlayHistory } from '@/utils/data'

const MAX_HISTORY_SIZE = 5000
const MAX_HISTORY_TIME = 31 * 24 * 60 * 60 * 1000

interface AddPlayHistoryParams {
  musicInfo: LX.Music.MusicInfo
  playTime: number
  maxTime: number
  listId: string | null
}

let addPlayHistoryQueue = Promise.resolve()

const getHistoryDay = (time: number) => {
  const date = new Date(time)
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

export const resolvePlayHistorySource = (listId: string | null): LX.Player.PlayHistorySource => {
  if (!listId) return 'List'

  const sourceListId = listId
  // 搜索点歌整份写入试听列表后，来源 id 形如 search__<source>__<关键词>（见 Search/MusicList）。
  if (sourceListId === 'search' || sourceListId.startsWith('search__')) return 'Search'
  // 未能归因到具体源列表的试听列表播放，维持迁移前的观感
  if (sourceListId === LIST_IDS.DEFAULT) return 'Search'
  if (sourceListId.startsWith('dailyrec_') || sourceListId === 'heartbeat' || sourceListId === 'similar_songs_list') return 'Rec'
  if (sourceListId.startsWith('artist_detail_') || sourceListId.startsWith('album_')) return 'Detail'
  return 'List'
}

const addPlayHistoryInternal = async({
  musicInfo,
  playTime,
  maxTime,
  listId,
}: AddPlayHistoryParams) => {
  const playedAt = Date.now()
  const day = getHistoryDay(playedAt)
  const history = await getPlayHistory()
  const existedIndex = history.findIndex(
    item => item.musicInfo.id === musicInfo.id && getHistoryDay(item.playedAt) === day,
  )

  const source = resolvePlayHistorySource(listId)
  const item: LX.Player.PlayHistoryItem = {
    id: `${musicInfo.id}_${playedAt}`,
    musicInfo,
    playedAt,
    playTime,
    maxTime,
    listId,
    source,
  }

  if (existedIndex > -1) history.splice(existedIndex, 1)
  history.unshift(item)
  for (let index = history.length - 1; index > -1; index--) {
    if (history[index].playedAt < playedAt - MAX_HISTORY_TIME) history.splice(index, 1)
  }
  if (history.length > MAX_HISTORY_SIZE) history.splice(MAX_HISTORY_SIZE)

  await savePlayHistory(history)
  global.app_event.playHistoryUpdated()
  markListsChanged()
}

export const addPlayHistory = async(params: AddPlayHistoryParams) => {
  const nextTask = addPlayHistoryQueue.catch(() => {}).then(async() => addPlayHistoryInternal(params))
  addPlayHistoryQueue = nextTask.then(() => undefined, () => undefined)
  return nextTask
}

export const getPlayHistoryByRange = async(startTime: number, endTime: number) => {
  const history = await getPlayHistory()
  return history.filter(item => item.playedAt >= startTime && item.playedAt <= endTime)
}

const removePlayHistoryInternal = async(ids: string[]): Promise<number> => {
  const removeIds = new Set(ids)
  const history = await getPlayHistory()
  const nextHistory = history.filter(item => !removeIds.has(item.id))
  // 一条都没删掉时不能静默 return：调用方（OnlineList 的 handleRemoveMusic）拿不到任何
  // 信号，只能一律 toast「移除成功」，用户看到的就是「点了移除、提示成功、列表纹丝不动」——
  // 这正是「播放历史移除不了」最直观的表现。改为回传实际删除条数，由调用方决定提示什么。
  const removedCount = history.length - nextHistory.length
  if (removedCount === 0) return 0
  await savePlayHistory(nextHistory)
  global.app_event.playHistoryUpdated()
  markListsChanged()
  return removedCount
}

/**
 * 按记录 id 删除播放历史。
 *
 * 此前只有追加（addPlayHistory）与按范围查询，**没有删除**，导致播放历史页行菜单
 * 里的「移除」走 OnlineList 的通用分支时无处可去（见 OnlineList handleRemoveMusic）。
 * 与 addPlayHistory 保持同一套落盘 + 事件 + 同步标记语义，删除后 WebDAV 已开启时
 * 会被标记为待上传，不会被远端旧数据合并回来。
 *
 * 与 addPlayHistory 共用同一条写入队列：二者都是「读全量 → 改 → 整表落盘」，
 * 交错执行会拿旧快照互相覆盖（表现为刚删掉的记录重进又出现，或刚播放的记录丢失）。
 */
export const removePlayHistory = async(ids: string[]): Promise<number> => {
  if (!ids.length) return 0
  const nextTask = addPlayHistoryQueue.catch(() => {}).then(async() => removePlayHistoryInternal(ids))
  addPlayHistoryQueue = nextTask.then(() => undefined, () => undefined)
  return nextTask
}
