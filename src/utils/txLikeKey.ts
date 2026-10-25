// QQ 音乐的「喜欢」在各种列表里可能只带其中一部分标识：
//   数字 songId（meta.id）、songmid（meta.songmid / 每日推荐的 meta.songId）、
//   strMediaMid、或 tx_ 前缀的列表 id。
// 行内红心、点击写入、启动时拉的「我喜欢」集合必须用同一套标识，否则会出现
//「平台已经加进我喜欢，App 里红心还是空的」。这里把候选键统一收口。

interface TxSongLike {
  id?: string | number
  meta?: {
    id?: string | number
    songId?: string | number
    songmid?: string | number
    mid?: string | number
    strMediaMid?: string | number
  } | null
}

const normalize = (value: unknown): string => {
  if (value === undefined || value === null) return ''
  const str = String(value).trim()
  return str === 'undefined' || str === 'null' ? '' : str
}

/** 一首歌的全部候选喜欢键（任何一个命中都算已喜欢）。 */
export const getTxLikeKeys = (song: TxSongLike): string[] => {
  const meta = song.meta ?? {}
  const keys = new Set<string>()
  const add = (value: unknown) => {
    const str = normalize(value)
    if (str) keys.add(str)
  }
  add(meta.id)
  add(meta.songId)
  add(meta.songmid)
  add(meta.mid)
  add(meta.strMediaMid)
  const rawId = normalize(song.id)
  if (rawId.startsWith('tx_')) add(rawId.slice(3))
  add(rawId)
  return Array.from(keys)
}

/** 发给 QQ 接口的标识：优先数字 songId（接口直接支持），否则按 mid 解析。 */
export const getTxLikeTarget = (song: TxSongLike): string => {
  const meta = song.meta ?? {}
  const numericId = normalize(meta.id)
  if (numericId && /^\d+$/.test(numericId)) return numericId
  const rawMid = normalize(meta.songmid) ||
    normalize(meta.mid) ||
    normalize(meta.songId) ||
    normalize(meta.strMediaMid) ||
    normalize(song.id)
  return rawMid.startsWith('tx_') ? rawMid.slice(3) : rawMid
}
