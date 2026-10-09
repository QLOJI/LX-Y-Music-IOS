import { getPicPath } from './index'
import { getCachedQsCover, fetchQsCover } from './qsCover'

/**
 * 列表项封面动态获取。
 *
 * 问题背景：cookie 登录平台歌单、WebDAV 同步、备份导入的歌曲，其 meta.picUrl 常为空，
 * 列表直接用静态 meta.picUrl 就显示无封面；而播放时 player.ts 会调 getPicPath 动态
 * 获取（在线接口/本地内嵌/网盘封面），所以「播放有封面、列表无封面」。
 *
 * 这里把同一套动态获取逻辑下沉到列表层：meta.picUrl 为空时按需调用 getPicPath
 * （内部已按 source 分发：在线 / webdav / 本地 / qs），结果按「歌名|歌手」缓存，
 * 并带并发上限，避免列表逐行触发请求打爆接口。
 */
const coverCache = new Map<string, string>()
const coverInflight = new Map<string, Promise<string>>()

const MAX_CONCURRENT = 4

/**
 * 【第 39 轮第 2 条】等位队列拆成「插队 / 常规」两条 —— 治「换了当前目录再点扫描，
 * 新歌单的封面一首都不开始加载」。
 *
 * 病根是**全局单一 FIFO 队列 + 单首耗时很长**：本文件是整份 App 的封面入口（本地歌单、
 * 播放列表、WebDAV……共用这 4 个并发槽），而 WebDAV 里一首歌的取封面要走
 * 「网盘同目录封面 → 内嵌 → 在线跨平台搜索」整条链（local.ts 的在线搜索另有 2 并发闸 +
 * 12 秒上限）。用户在 /music 目录点了扫描 → 325 首整表巡检把这 4 个槽位**占满好几分钟**；
 * 这时他切到 /music1 再点扫描，新歌单的 325 首只能排在旧歌单的几百个任务**后面** ——
 * 屏幕上这批歌的封面连请求都还没发出去，看起来就是「点了扫描，在线封面无法自动开始加载」。
 *
 * 修法：等位任务分两条队列，「插队队列永远优先出队」。WebDAV 列表页（整表巡检 + 可视列表
 * 巡检 + ⋮ 菜单单曲补图）全部走插队通道 —— 它们代表**用户此刻正盯着看的那份列表**；
 * 旧目录剩下的常规任务不丢，等插队队列空了自然继续（结果回写按歌曲 id 落地，不影响新列表）。
 * 只让 4 个并发槽的**出队顺序**变化，并发上限 / 在飞去重 / 15 秒超时口径全部照旧。
 */
let activeCount = 0
const taskQueue: Array<() => void> = []
const priorityTaskQueue: Array<() => void> = []

// 出队：插队队列优先；两条都空则没人接手（当前任务的 finally 就到此为止）
const takeNextTask = (): (() => void) | undefined =>
  priorityTaskQueue.shift() ?? taskQueue.shift()

const runWithLimit = async(fn: () => Promise<string>, isPriority = false): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const execute = (): void => {
      activeCount++
      fn()
        .then(resolve, reject)
        .finally(() => {
          activeCount--
          const next = takeNextTask()
          if (next) next()
        })
    }
    if (activeCount < MAX_CONCURRENT) execute()
    else (isPriority ? priorityTaskQueue : taskQueue).push(execute)
  })
}

/**
 * 【第 34 轮第 3 条】单张封面的获取超时（用户原话「会出现加载在线封面因为一个或者几个
 * 刷新不出来而不会加载后面歌曲封面的情况，请保证全部加载出封面，如果个别几个加载不出来就算了」）。
 *
 * 病根：getPicPath 走的是「音源 SDK 起 HTTP 请求 → 拿 URL」这条路，SDK 内部没有任何超时，
 * 只要某一首的请求在底层卡住（服务器半死、TCP 连上不回包），它返回的 Promise 就永不 settle。
 * 于是：
 *   ① 这个 key 的 coverInflight 永远留着 —— 该行封面永远转圈；
 *   ② 更糟的是 runWithLimit 的并发槽位被它占死（4 个槽位卡掉 1 个就少 25% 吞吐，
 *      卡满 4 个则整份列表的封面全部停摆，后面几百首一首都不会再加载）；
 *   ③ WebDAV 列表的 prefetchCovers 里 `await Promise.all(tasks)` 等的是整批任务，
 *      一个不 settle 的任务会把整轮巡检永久卡在那一批上。
 * 「个别几个加载不出来就算了」的工程含义就是：到点按「没拿到封面」返回空串，
 * 让 inflight 落地、让槽位释放、让后面的歌曲继续排队 —— 宁可这一行没封面，也不许堵死整列。
 */
const COVER_FETCH_TIMEOUT_MS = 15000

/** 给封面任务套超时：超时按「没拿到封面」返回空串（原 Promise 的后续 settle 被忽略）。 */
const withCoverTimeout = (p: Promise<string>, ms: number): Promise<string> =>
  new Promise<string>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve('')
    }, ms)
    p.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve('')
      },
    )
  })

interface CoverSong { source: string, name: string, singer: string }

const keyOf = (song: CoverSong): string =>
  `${song.source}|${song.name}|${song.singer}`

export const getCachedCoverUrl = (song: CoverSong): string => {
  if (song.source === 'qs') return getCachedQsCover(song as LX.Music.MusicInfoOnline)
  const cached = coverCache.get(keyOf(song))
  // 只认字符串：脏值（例如音源 SDK getPic 没解包就返回的请求对象）绝不能从这里流回列表行，
  // 否则会进 <Image url> 触发渲染期 TypeError（详见 utils.ts resolvePicUrl 注释）
  return typeof cached === 'string' ? cached : ''
}

/**
 * 【第 29 轮】作废某首歌的内存封面缓存。
 * 缓存 key 是「source|歌名|歌手」，存的是上次拿到的 URL —— 这个 URL 可能已经失效
 * （本地封面文件被系统清掉、远程封面 404）。作废后下一次 fetchCoverUrl 会重新走 getPicPath。
 */
export const invalidateCoverCache = (song: CoverSong): void => {
  coverCache.delete(keyOf(song))
}

export const fetchCoverUrl = async(
  song: CoverSong,
  options?: {
    isRefresh?: boolean
    /**
     * 【第 39 轮第 2 条】入「插队队列」：出队时优先于所有常规任务（见上方两条队列的说明）。
     * WebDAV 列表页那一批调用点（整表巡检 / 可视列表巡检 / 菜单单曲补图）全部传 true ——
     * 它们代表用户此刻正看着的那份列表，不该排在任何旧列表的几百个任务后面。
     */
    highPriority?: boolean
  },
): Promise<string> => {
  // qs 源沿用既有跨平台匹配逻辑（含其独立缓存）
  if (song.source === 'qs') return fetchQsCover(song as LX.Music.MusicInfoOnline)

  const key = keyOf(song)
  // 【第 29 轮】isRefresh = 列表刷新时的「封面是不是最新的」复核：不能被内存缓存直接短路，
  // 重新走一遍 getPicPath（会被 local.ts 透传给在线源的 isRefresh），拿到新结果再覆盖缓存。
  // 其余路径照旧先吃缓存。在飞去重不分模式：同一首同时在飞就复用那个 Promise。
  if (!options?.isRefresh) {
    const cached = coverCache.get(key)
    if (cached) return cached
  }
  const inflight = coverInflight.get(key)
  if (inflight) return inflight

  // 【第 34 轮第 3 条】超时包在**入队任务的内部**：只有任务真的 settle 了，runWithLimit 的
  // finally 才会跑、槽位才会让给下一个任务（包在外面等于槽位照样被占死）。
  const task = runWithLimit(
    async() =>
      withCoverTimeout(
        getPicPath({ musicInfo: song as LX.Music.MusicInfo, isRefresh: options?.isRefresh === true }),
        COVER_FETCH_TIMEOUT_MS,
      ),
    // 【第 39 轮第 2 条】插队标记透传到队列（默认 false ⇒ 其他页面口径零变化）
    options?.highPriority === true,
  )
    .then((url) => {
      // getPicPath 的类型标的是 string，但运行期它会把上游（音源 SDK / 网盘 meta）拿到的值原样带出来：
      // 非字符串一律按「没拿到封面」处理，既不入缓存也不往外传（见 utils.ts resolvePicUrl 注释）。
      if (typeof url !== 'string') return ''
      if (url) coverCache.set(key, url)
      return url
    })
    .catch(() => '')
    .finally(() => {
      coverInflight.delete(key)
    })
  coverInflight.set(key, task)
  return task
}
