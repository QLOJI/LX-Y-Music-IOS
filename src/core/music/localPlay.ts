/**
 * 本地与下载 · 专用播放接口
 *
 * 供「本地与下载」页面的本地音乐与下载音乐使用，不走自定义源管理
 * （apis('local') / getOtherSource 换源链路）。
 *
 * 链路设计：
 * - 播放：优先本地文件（离线可用）；本地缺失且有网络时，走软件内置平台
 *   直连接口（网易 cookie 直连、B 站直连）自动回退获取播放链接。
 * - 歌词：离线读内嵌歌词 / 同名 .lrc；有网络时通过内置平台接口
 *   （kw/kg/tx/wy/mg）逐平台回退匹配。
 * - 封面：meta 缓存 → 本地内嵌封面 → 内置平台接口逐平台回退。
 */
import musicSdk, { searchMusic } from '@/utils/musicSdk'
import wySdk from '@/utils/musicSdk/wy'
import bilibiliSdk from '@/utils/musicSdk/bilibili'
import { existsFile, readFile } from '@/utils/fs'
import { readPic, readLyric } from '@/utils/localMediaMetadata'
import { buildLyricInfo, getCachedLyricInfo, getOtherSource, getOnlineOtherSourceLyricInfo } from './utils'
import { getOtherSourceByLocal } from './local'
import { saveLyric } from '@/utils/data'

export interface LocalPlayTarget {
  name: string
  singer: string
  // 本地文件路径（下载文件或本地音频），离线播放与本地歌词/封面来源
  filePath?: string
  // 已缓存的封面
  picUrl?: string | null
  // 期望音质（下载任务自带，本地音乐可空）
  quality?: LX.Quality
  // 【第 31 轮】原始条目（本地文件 MusicInfoLocal / 下载任务 ListItem）：
  // 在线歌词匹配的输入（歌名-歌手拆反时靠它走多轮重试），匹配成功后也按它的 id 落库缓存
  musicInfo?: LX.Music.MusicInfo | LX.Download.ListItem
}

// 内置直连 URL 平台回退顺序：网易（cookie 直连）→ B 站（直连）
const URL_SOURCES = ['wy', 'bilibili'] as const
// 歌词/封面可用的内置平台回退顺序：企鹅 → 网易 → 酷狗 → 酷我 → 咪咕
const META_SOURCES = ['tx', 'wy', 'kg', 'kw', 'mg'] as const
// 跨平台匹配优先级（数字越小越优先）：企鹅 → 网易 → 酷狗 → 酷我 → 咪咕
const SOURCE_PRIORITY: Record<string, number> = {
  tx: 0,
  wy: 1,
  kg: 2,
  kw: 3,
  mg: 4,
}
const SOURCE_PRIORITY_FALLBACK = META_SOURCES.length
const URL_QUALITYS: LX.Quality[] = ['320k', '128k']

const cleanName = (name: string): string => {
  const cleaned = (name || '')
    .replace(/\s*[【(（[].*?[\]】)）]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || name
}

interface SongCandidate {
  source: string
  songmid: string
  name: string
  singer: string
  interval?: string | number
  img?: string
  [key: string]: any
}

/**
 * 统一解包各音源 SDK 的返回值。
 *
 * 各平台的 getLyric / getPic 返回值并不统一：有的直接返回 Promise（如 wy.getPic、
 * kg.getPic、kw.getPic），有的返回 `{ promise, cancelHttp }` 请求对象（如 tx/wy/kg/kw/mg
 * 的 getLyric、mg.getPic）。若直接 `await` 请求对象，因为它不是 thenable，
 * await 会原样返回该对象，导致：
 * - 歌词：`lyricInfo.lyric` 恒为 undefined —— 所有候选都被跳过，最终返回空歌词；
 * - 封面：返回的是对象而非 URL 字符串，图片加载失败。
 * 这里最多解包 3 层，兼顾「Promise 里再包一层请求对象」的情况。
 */
const resolveSdkResult = async <T = any>(result: unknown): Promise<T | null> => {
  try {
    let value: any = result
    for (let i = 0; i < 3; i++) {
      if (value == null) return null
      if (typeof value.then === 'function') {
        value = await value
        continue
      }
      if (value.promise && typeof value.promise.then === 'function') {
        value = await value.promise
        continue
      }
      break
    }
    return (value ?? null) as T | null
  } catch {
    return null
  }
}

// 按歌名+歌手在内置平台搜索候选（跨平台），歌名完全匹配优先
const searchCandidates = async(name: string, singer: string): Promise<SongCandidate[]> => {
  const result: SongCandidate[] = []

  // 注意：searchMusic 是 musicSdk 的【命名导出】，不是默认导出的成员。
  // 之前写成 musicSdk.searchMusic(...) 会得到 undefined，调用即抛 TypeError，
  // 导致候选列表恒为空 —— 汽水的封面/歌词/播放匹配全部失败。
  const lists = (await searchMusic({
    name: cleanName(name),
    singer: singer || '',
    // qs 无 musicSearch，本就不会返回；显式传入以防后续为汽水接入搜索后被重复查询
    source: 'qs',
    limit: 10,
  }).catch(() => [])) as any[]

  for (const list of lists) {
    const source = list.source as string
    if (!source || !META_SOURCES.includes(source as any)) continue
    for (const item of list.list ?? []) {
      result.push({ ...item, source })
    }
  }

  const target = cleanName(name).toLowerCase()
  result.sort((a, b) => {
    const aMatch = (a.name || '').toLowerCase() === target ? 0 : 1
    const bMatch = (b.name || '').toLowerCase() === target ? 0 : 1
    // 1) 歌名完全匹配优先（跨平台匹配的首要依据）
    if (aMatch !== bMatch) return aMatch - bMatch
    // 2) 匹配度相同时按平台优先级：企鹅 → 网易 → 酷狗 → 酷我 → 咪咕
    // 注：musicSdk.searchMusic 返回顺序由 sources 数组决定，不受 META_SOURCES 控制，
    // 因此这里必须显式按优先级排序，否则平台顺序不稳定。
    const aPriority = SOURCE_PRIORITY[a.source] ?? SOURCE_PRIORITY_FALLBACK
    const bPriority = SOURCE_PRIORITY[b.source] ?? SOURCE_PRIORITY_FALLBACK
    return aPriority - bPriority
  })
  return result
}

const searchBilibili = async(name: string, singer: string): Promise<SongCandidate | null> => {
  const keyword = `${cleanName(name)} ${singer || ''}`.trim()
  try {
    const result = (await bilibiliSdk.musicSearch.search(keyword, 1, 10).catch(() => null))
    const first = result?.list?.[0]
    if (!first?.songmid) return null
    return { ...first, source: 'bilibili' }
  } catch {
    return null
  }
}

// 内置平台获取播放 URL：
// 1) 优先走音源脚本（musicSdk[source].getMusicUrl，覆盖 tx/wy/kg/kw/mg），
//    这是汽水歌曲跨平台匹配播放的主链路（有导入音源脚本时）；
// 2) 回退 wy cookie 直连 + bilibili 直连（无音源脚本时兜底）。
const getOnlineUrl = async(
  target: LocalPlayTarget,
  candidates: SongCandidate[],
): Promise<string> => {
  const qualitys = target.quality && URL_QUALITYS.includes(target.quality)
    ? [target.quality, ...URL_QUALITYS.filter(q => q !== target.quality)]
    : URL_QUALITYS

  // 1. 音源脚本（按 searchCandidates 已排好的平台优先级依次尝试）
  for (const candidate of candidates) {
    const sdk = (musicSdk as any)[candidate.source]
    if (!sdk?.getMusicUrl || !candidate.songmid) continue
    for (const quality of qualitys) {
      try {
        const result = await resolveSdkResult<{ url?: string }>(sdk.getMusicUrl(candidate, quality))
        if (result?.url) return result.url
      } catch {}
    }
  }

  // 2. 回退 wy cookie 直连 / bilibili 直连
  for (const source of URL_SOURCES) {
    if (source === 'wy') {
      const wyCandidate = candidates.find(c => c.source === 'wy' && c.songmid)
      if (!wyCandidate) continue
      for (const quality of qualitys) {
        try {
          const result: any = await (wySdk.cookie.getMusicUrl(wyCandidate as any, quality) as any).promise
          if (result?.url) return result.url
        } catch {}
      }
    } else {
      const bilibiliCandidate =
        candidates.find(c => c.source === 'bilibili' && c.songmid) ??
        (await searchBilibili(target.name, target.singer))
      if (!bilibiliCandidate) continue
      try {
        const result: any = await (bilibiliSdk.getMusicUrl(bilibiliCandidate as any, '128k') as any).promise
        if (result?.url) return result.url
      } catch {}
    }
  }
  throw new Error('无法从内置平台获取播放链接')
}

export const getMusicUrl = async({
  target,
  isRefresh = false,
}: {
  target: LocalPlayTarget
  isRefresh?: boolean
}): Promise<string> => {
  // 1. 本地文件（离线可用）
  if (!isRefresh && target.filePath) {
    try {
      if (await existsFile(target.filePath)) return target.filePath
    } catch {}
  }

  // 2. 内置平台直连回退
  const candidates = await searchCandidates(target.name, target.singer)
  return getOnlineUrl(target, candidates)
}

const readSidecarLyric = async(filePath: string): Promise<string | null> => {
  if (!filePath) return null
  const base = filePath.substring(0, filePath.lastIndexOf('.'))
  if (!base) return null
  for (const ext of ['.lrc', '.LRC']) {
    try {
      if (await existsFile(`${base}${ext}`)) {
        const content = await readFile(`${base}${ext}`)
        if (content) return content
      }
    } catch {}
  }
  return null
}

/**
 * 【第 31 轮】本地/下载条目的跨平台在线歌词匹配（用户报「这些 local 歌曲没有自动获取歌词」）。
 *
 * 与 WebDAV 的歌词兜底同一条链路（见 local.ts getLyricInfo 的 WebDAV 分支）：
 *   · 本地文件走 local.ts 的 getOtherSourceByLocal —— 原样 / 歌名里「歌名-歌手」两种拆法 /
 *     文件名两种拆法 / 只按歌名模糊，共 6 轮重试。本地条目的 name/singer 是文件名派生的
 *     （parseFileName 把「歌手 - 歌名」拆成 name=左、singer=右，可能是反的），
 *     只有这条链路会反复换组合重搜 —— 旧的单轮 searchMusic 搜不到就永远空歌词；
 *   · 下载任务条目自带原始在线歌名/歌手（metadata.musicInfo），直接 getOtherSource 搜。
 * 候选交给 getOnlineOtherSourceLyricInfo：歌词必须带时间轴（existTimeExp）才算命中，
 * 逐候选重试；成功后 saveLyric 按条目 id 落库，下次播放 getCachedLyricInfo 直接命中。
 */
const matchOnlineLyric = async(
  originInfo: LX.Music.MusicInfo | LX.Download.ListItem,
  isRefresh: boolean,
): Promise<LX.Player.LyricInfo | null> => {
  const tryMatch = async(otherSource: LX.Music.MusicInfoOnline[]) => {
    if (!otherSource.length) throw new Error('empty other source')
    const { lyricInfo, isFromCache } = await getOnlineOtherSourceLyricInfo({
      musicInfos: [...otherSource],
      onToggleSource: () => {},
      isRefresh,
    })
    if (!lyricInfo?.lyric) throw new Error('empty lyric')
    if (!isFromCache) void saveLyric(originInfo as LX.Music.MusicInfo, lyricInfo as LX.Music.LyricInfo)
    return buildLyricInfo(lyricInfo)
  }
  // 本地文件：歌名/歌手可能是文件名拆反的，走多轮拆分重试
  if (!('progress' in originInfo) && (originInfo as LX.Music.MusicInfo).source === 'local') {
    return getOtherSourceByLocal(originInfo as LX.Music.MusicInfoLocal, tryMatch)
  }
  // 下载任务 / 汽水：条目本身带着歌名歌手，直接搜
  return tryMatch(await getOtherSource(originInfo))
}

export const getLyricInfo = async({
  target,
  isRefresh = false,
}: {
  target: LocalPlayTarget
  isRefresh?: boolean
}): Promise<LX.Player.LyricInfo> => {
  // 1. 离线来源：内嵌歌词 → 同名 .lrc
  if (target.filePath) {
    const embedded = await readLyric(target.filePath).catch(() => null)
    if (embedded) return buildLyricInfo({ lyric: embedded })
    const sidecar = await readSidecarLyric(target.filePath)
    if (sidecar) return buildLyricInfo({ lyric: sidecar })
  }

  const originInfo = target.musicInfo
  if (originInfo) {
    // 2. 已落库的在线歌词（上一次匹配写过 / 用户在歌词页编辑过），刷新时跳过
    if (!isRefresh) {
      const cached = await getCachedLyricInfo(originInfo as LX.Music.MusicInfo).catch(() => null)
      if (cached?.lyric) return buildLyricInfo(cached)
    }

    // 3. 跨平台在线匹配（多轮重试 + 时间轴校验 + 落库）
    const matched = await matchOnlineLyric(originInfo, isRefresh).catch(() => null)
    if (matched) return matched
  }

  // 4. 轻量兜底：只按「歌名 歌手」在搜索结果上逐候选取歌词
  const candidates = await searchCandidates(target.name, target.singer)
  for (const candidate of candidates) {
    const sdk = (musicSdk as any)[candidate.source]
    if (!sdk?.getLyric || !candidate.songmid) continue
    const lyricInfo = await resolveSdkResult<{ lyric?: string }>(sdk.getLyric(candidate))
    if (lyricInfo?.lyric) return buildLyricInfo(lyricInfo as LX.Player.LyricInfo)
  }

  return buildLyricInfo({ lyric: '' })
}

export const getPicUrl = async({
  target,
  isRefresh = false,
}: {
  target: LocalPlayTarget
  isRefresh?: boolean
}): Promise<string> => {
  // 1. 本地内嵌/sidecar 封面（优先本地文件，离线可用）
  if (target.filePath) {
    try {
      if (await existsFile(target.filePath)) {
        const picPath = await readPic(target.filePath).catch(() => null)
        if (picPath) return picPath.startsWith('/') ? `file://${picPath}` : picPath
      }
    } catch {}
  }

  // 2. meta 缓存
  if (!isRefresh && target.picUrl) return target.picUrl

  // 3. 内置平台逐平台回退（搜索结果自带 img 兜底）
  const candidates = await searchCandidates(target.name, target.singer)
  for (const candidate of candidates) {
    const sdk = (musicSdk as any)[candidate.source]
    if (!candidate.songmid) continue
    if (sdk?.getPic) {
      const pic = await resolveSdkResult<string>(sdk.getPic(candidate))
      // 必须是非空字符串：请求对象未解包时会得到 object，直接返回会让图片加载失败
      if (typeof pic === 'string' && pic) return pic
    }
    if (candidate.img) return candidate.img
  }
  return ''
}
