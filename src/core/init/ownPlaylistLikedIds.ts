/**
 * 「自建歌单也算已在平台收藏」的 ID 收集器。
 *
 * 用户第 59 轮：我的列表里的「我喜欢」和自建歌单，其中的歌曲都应显示红色小红心
 *（在平台已经添加过）；cookie 失效时这些集合为空、红心保持空心。
 *
 * 平台「喜欢」接口只返回「我喜欢」里的歌，自建歌单的曲目要逐个歌单取：
 *  - 网易云：先按 uid 过滤出自建歌单（creator.userId === uid），再逐个取 trackIds；
 *  - QQ：getUserPlaylists() 返回的就是自建歌单（含 dirid 201 我喜欢），逐个取详情；
 *  - 酷狗：createdList 里的自建歌单（含我喜欢），逐个分页取歌曲。
 *
 * 全部容错：任何一个请求失败只丢那一份数据，绝不 reject，也不会清空已有集合。
 * 结果通过 addXxxLikedSongs 合并进现有集合（单次广播），不覆盖用户会话内的操作。
 */
import wyUserApi from '@/utils/musicSdk/wy/user'
import txUserApi from '@/utils/musicSdk/tx/user'
import { getPlaylistSongs as getKgPlaylistSongs } from '@/utils/musicSdk/kg/utils/api'

const addKeys = (target: Set<string>, keys: Array<unknown>) => {
  for (const key of keys) {
    if (key === undefined || key === null || key === '') continue
    target.add(String(key))
  }
}

/** 网易云：自建歌单（非收藏）的全部 trackId。 */
export const getWyOwnPlaylistSongIds = async(uid: string, cookie: string): Promise<string[]> => {
  const ids = new Set<string>()
  let playlists: any[] = []
  try {
    playlists = await wyUserApi.getUserPlaylists(uid, cookie)
  } catch {
    return []
  }
  for (const playlist of playlists) {
    const creatorId = playlist?.creator?.userId ?? playlist?.userId
    if (creatorId == null || String(creatorId) !== String(uid)) continue
    try {
      addKeys(ids, await wyUserApi.getPlaylistTrackIds(String(playlist.id), cookie))
    } catch {
      // 单个歌单失败不影响其它歌单
    }
  }
  return [...ids]
}

/** QQ：自建歌单里的全部歌曲键（id / songmid / strMediaMid，行内任一键命中即红心）。 */
export const getTxOwnPlaylistSongKeys = async(): Promise<string[]> => {
  const keys = new Set<string>()
  let playlists: any[] = []
  try {
    playlists = await txUserApi.getUserPlaylists()
  } catch {
    return []
  }
  for (const playlist of playlists) {
    try {
      const detail = await txUserApi.getPlaylistDetail(String(playlist.id))
      for (const song of detail?.songs ?? []) addKeys(keys, [song.id, song.songmid, song.strMediaMid])
    } catch {
      // 单个歌单失败不影响其它歌单
    }
  }
  return [...keys]
}

/** 酷狗：自建歌单里的全部歌曲键（hash / songmid / audio_id）。 */
export const getKgOwnPlaylistSongKeys = async(cookie: string): Promise<string[]> => {
  const keys = new Set<string>()
  let createdList: any[] = []
  try {
    const { getUserPlaylists } = await import('@/utils/musicSdk/kg/utils/api')
    const result = await getUserPlaylists(cookie)
    if (!result.success || !result.data) return []
    createdList = result.data.createdList || []
  } catch {
    return []
  }
  for (const playlist of createdList) {
    try {
      let page = 1
      const pageSize = 500
      let hasMore = true
      while (hasMore) {
        const songsResult = await getKgPlaylistSongs(cookie, playlist.id, page, pageSize)
        if (!songsResult.success || !songsResult.data?.list?.length) break
        for (const song of songsResult.data.list) addKeys(keys, [song.hash, song.songmid, song.audio_id])
        hasMore = songsResult.data.list.length === pageSize
        page++
      }
    } catch {
      // 单个歌单失败不影响其它歌单
    }
  }
  return [...keys]
}
