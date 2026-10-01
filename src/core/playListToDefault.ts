import { LIST_IDS } from '@/config/constant'
import { overwriteListMusics } from '@/core/list'
import { playList } from '@/core/player/player'
import settingState from '@/store/setting/state'
import { getListMusicSync } from '@/utils/listManage'

// 运行态记录：试听列表(DEFAULT)「顶部这一段」当前对应哪份源列表、长度多少，
// 以及这一段开头歌曲的 id 序列（用于校验这一段是否仍完好）。
// 用途：
// - 同一份源列表内切歌 → 不重复写入，仅在已置顶的那一段里切换播放；
// - 同一份源列表在线端加载变长（或全量拉取完成）→ 只原位扩容顶部这一段；
// - 切到另一份源列表 → 新列表整份按顺序置顶，旧内容保留在其下（不清空）。
// （仅运行期标记，不参与持久化。冷启动后 topSourceId 为空，但下面的「前缀认领」分支
//   会用持久化在试听列表里的内容把顶部这一段重新认回来，不会因此重复叠一份。）
let topSourceId = ''
let topSourceLen = 0
let topSourceIds: string[] = []

/**
 * 供播放历史 / 网易云播放上报等归因逻辑查询「试听列表顶部的这一段来自哪份源列表、多长」。
 * 只有正在播放的歌曲位于 [0, len) 时才应把来源归给这份源列表（见 scrobble.ts / playHistory）。
 */
export const getTopSourceInfo = () => ({ id: topSourceId, len: topSourceLen })

const isListPrefix = (prefix: LX.Music.MusicInfo[], list: LX.Music.MusicInfo[]) => {
  if (prefix.length > list.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i].id != list[i].id) return false
  }
  return true
}

// 顶部这一段是否仍完好（备份恢复 / 同步 / 手动增删都可能改动试听列表）。
// 校验不过时一律走「整份置顶、旧内容原样保留」的安全分支：宁可重复，也不按过期长度切割丢歌。
const isStageIntact = (curList: LX.Music.MusicInfo[]) => {
  if (topSourceIds.length > curList.length) return false
  for (let i = 0; i < topSourceIds.length; i++) {
    if (topSourceIds[i] != curList[i].id) return false
  }
  return true
}

const claimStage = (stagedListId: string, list: LX.Music.MusicInfo[]) => {
  topSourceId = stagedListId
  topSourceLen = list.length
  topSourceIds = list.map(m => m.id)
}

/**
 * 把点击播放歌曲所在的在线源列表并入「试听列表(DEFAULT)」并从所选位置开始播放。
 * 搜索/排行榜/歌单详情页的点歌统一走这里（不使用临时列表）。
 * - 勾选「自动清空已播放列表」(player.isAutoCleanPlayedList)：每次都丢弃旧内容，
 *   把这份列表整份写入试听列表；
 * - 未勾选：不清空，试听列表顶部已是这份列表时仅切换播放；
 *   否则把这份列表整份按歌单顺序置于试听列表顶部，原有内容保留在其下。
 */
export const stageOnlineListToDefault = async(
  stagedListId: string,
  list: LX.Music.MusicInfoOnline[],
  index: number,
  force = false,
) => {
  const isAutoClean = settingState.setting['player.isAutoCleanPlayedList']
  const curList = getListMusicSync(LIST_IDS.DEFAULT)
  let newList: LX.Music.MusicInfo[]

  if (isAutoClean || force) {
    // 勾选「自动清空已播放列表」（或强制）：整体覆盖，旧内容丢弃
    newList = [...list]
  } else if (topSourceId == stagedListId) {
    if (isListPrefix(list, curList)) {
      // 该列表（或它靠前的部分）已经在顶部 → 不重复添加，仅切换播放
      await playList(LIST_IDS.DEFAULT, index)
      return
    }
    if (isStageIntact(curList)) {
      // 在线列表加载变长 / 内容刷新：只原位替换顶部这一段，保留其下旧内容
      const below = curList.slice(topSourceLen)
      newList = [...list, ...below]
    } else {
      // 顶部这一段已被备份恢复 / 同步 / 手动增删改动：不再按过期长度切割，
      // 整份置顶、旧内容原样保留，避免切片错位导致静默丢歌
      newList = [...list, ...curList]
    }
  } else if (isListPrefix(list, curList)) {
    // 顶部已经是这份列表，只是本次进程还没记录它：认领，不重复叠一份。
    // 最典型的就是**冷启动**——试听列表是持久化的，而 topSource* 只是运行期变量，
    // 重启后再点同一份歌单/榜单，若不做这次认领，同一份列表会在试听列表里整份出现两次
    // （旧的一份是上次退出前写进去的）。认领后 refreshDefaultList 也能正常原位扩容。
    // 只比对「列表 id 顺序」这一个前缀，命中即认为顶部就是它，语义上是安全的：
    // 重合的两份列表本来就无法区分，而认领的结果只是「不重复添加」，不会删改任何内容。
    claimStage(stagedListId, list)
    await playList(LIST_IDS.DEFAULT, index)
    return
  } else {
    // 换到一份新的源列表：不清空，把新列表整份按顺序置于旧内容顶部
    newList = [...list, ...curList]
  }

  await overwriteListMusics(LIST_IDS.DEFAULT, newList)
  claimStage(stagedListId, list)
  await playList(LIST_IDS.DEFAULT, index)
}

/**
 * 源列表全量（排行榜/歌单详情）拉取完成后，原位扩容试听列表顶部这一段。
 * 保持其下更早加入的旧内容不变；若当前顶部已不是这份列表、或顶部这一段已被
 * 改动（备份恢复/同步/手动增删），则跳过，避免切割错位覆盖。
 */
export const refreshDefaultList = async(stagedListId: string, list: LX.Music.MusicInfo[]) => {
  if (topSourceId != stagedListId) return
  const curList = getListMusicSync(LIST_IDS.DEFAULT)
  if (!isStageIntact(curList)) return
  const below = curList.slice(topSourceLen)
  await overwriteListMusics(LIST_IDS.DEFAULT, [...list, ...below])
  claimStage(stagedListId, list)
}
