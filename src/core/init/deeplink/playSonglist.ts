import { refreshDefaultList, stageOnlineListToDefault } from '@/core/playListToDefault'
import { getListDetail, getListDetailAll } from '@/core/songlist'

const getListPlayIndex = (list: LX.Music.MusicInfoOnline[], index?: number) => {
  if (index == null) {
    index = 1
  } else {
    if (index < 1) index = 1
    else if (index > list.length) index = list.length
  }
  return index - 1
}

const playSongListDetail = async(source: LX.OnlineSource, link: string, playIndex?: number) => {
  // console.log(source, link, playIndex)
  if (link == null) return
  let isPlayingList = false
  const id = decodeURIComponent(link)
  const playListId = `${source}__${decodeURIComponent(link)}`
  let list = (await getListDetail(id, source, 1)).list
  // 整份写入试听列表(DEFAULT)，不再走临时列表（见 core/list.ts playOnlineList 的说明）：
  // 这样从外部链接起播后，长按迷你播放器封面能落到「我的」页的试听列表卡片上。
  if (list.length && (playIndex == null || list.length > playIndex)) {
    isPlayingList = true
    await stageOnlineListToDefault(playListId, [...list], getListPlayIndex(list, playIndex))
  }
  list = await getListDetailAll(source, id)
  if (isPlayingList) {
    // 播放中：只把试听列表顶部这一段原位扩容；顶部已不是这份歌单时 refreshDefaultList
    // 内部会自行跳过（原实现比对的是 listState.tempListMeta.id == id，而 playListId 带
    // `${source}__` 前缀，该判断永远不成立，等于没校验）。
    await refreshDefaultList(playListId, [...list])
  } else if (list.length) {
    await stageOnlineListToDefault(playListId, [...list], getListPlayIndex(list, playIndex))
  }
}
export const playSonglist = async(source: LX.OnlineSource, link: string, playIndex?: number) => {
  try {
    await playSongListDetail(source, link, playIndex)
  } catch (err) {
    console.error(err)
    throw new Error('Get play list failed.')
  }
}
