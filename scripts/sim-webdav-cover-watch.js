#!/usr/bin/env node
/**
 * sim-webdav-cover-watch.js —— WebDAV「封面时刻关注（缺失/未更新自动补，刷新复核最新）」
 * 与「下载按钮按了有反应」契约（第 29 轮）。
 *
 * 需求原话（2026-10-03 第 29 轮）：
 *   「WebDAV界面中，还是存在不自动加载在线封面的情况，要时刻关注WebDAV列表，如果存在歌曲封面
 *     缺失或者未更新的情况，扫描或者打开列表时自动加载；而且WebDAV的下载按钮按了没反应，要修复。」
 *   （补充）「刷新列表后也要刷新封面是否最新或者缺失。」
 *
 * 根因（第 27/28 轮留下的三个口子叠在一起）：
 *   ① 第 27 轮的预热是「列表前 MAX_PREFETCH_COVERS(=20) 首」：325 首里第 21 首往后全靠行内
 *      useCoverUrl，而它只要 meta.picUrl 非空就短路 —— 「封面缺失」被当成「有封面」；
 *   ② 第 28 轮的失败备忘 webdavCoverSearchMisses 是会话级的：一首歌在线匹配失败一次，
 *      之后每次进列表/扫描/刷新都被 has() 跳过 —— 「未更新」的歌再也补不上；
 *   ③ 失效的本地封面（file:// 指向的缓存文件被系统清掉）留在 meta 里，行内照样短路，
 *      列表上就是永远的空占位；Image 也没有 onError 自愈，远程封面 404 后那一行就死在那儿。
 *   下载按钮那半：hasConfig 原来是 useMemo(..., [])（只在挂载那一刻读一次设置），两个头部按钮
 *   又是 disabled={!hasConfig || ...} —— 判定为 false 时按下去什么都不会发生，日志也一行没有；
 *   ⋮ 菜单那条路（handleDownload）当时也没有 catch，准备阶段抛错就整段静默 reject。
 *
 * 本轮口径：
 *   条一（封面）
 *     ① 列表页巡检升级为「整表分批」：MAX_PREFETCH_COVERS 仍是批大小，但用
 *        `i += MAX_PREFETCH_COVERS` 把整份列表推完，不再是「只补前 20 首」；
 *     ② 巡检先校验 file:// 封面文件还在不在（existsFile）：文件没了就当「缺失」——
 *        作废内存缓存（invalidateCoverCache）+ 把这一行的 picUrl 清成空串（否则行内短路）
 *        + 重走 fetchCoverUrl 补上；
 *     ③ 每轮巡检开始清空失败备忘（local.ts 的 clearWebdavCoverMisses）并清空
 *        prefetchedCoverIds（上一轮试过/确认查不到的，这一轮重新查）；
 *     ④ 下拉刷新是一次「连封面是不是最新的都重查」：forceCoverRefresh 置位后这批请求带
 *        isRefresh，coverUrl.ts 的 fetchCoverUrl 在 isRefresh 下不吃内存缓存，
 *        并把 isRefresh 透传给 local.ts 的在线匹配（复核「未更新」）；
 *     ⑤ 行内自愈：Image 的 onError → 列表页 handleCoverError，作废缓存 + 清 picUrl +
 *        单首重补；同一 (id,url) 只重试一次，防死图来回换造成请求风暴。
 *        【第 31 轮】单首重补的落点从 prefetchCovers([target]) 换成 WebDAVListAction 的
 *        refreshWebdavCover（加法式），见下。
 *   条二（下载按钮）
 *     ① hasConfig 改成响应式（useSettingValue('sync.webdav.url')/useSettingValue('sync.webdav.username')），
 *        不再是一次性快照；两个下载按钮的 disabled 里去掉 !hasConfig（未配置时按得动，
 *        由 handleBatchDownload 提示并跳配置页），不靠 disabled 静默吞点击；
 *     ② ⋮ 菜单 handleDownload：入口先落日志（分辨「没进回调」还是「进了回调静默失败」），
 *        并补上 .catch —— 出错一律落日志 + toast 具体原因；
 *     ③ 扫描并下载 handleBatchDownload：按下先落日志 + 把标题写成「准备扫描并下载…」，
 *        用户取消时清标题并落日志，尾部 .catch 清标题 + toast（「准备…」不会永远挂在那儿）；
 *     ④ WebDAVListAction.handleWebDAVDownload：入口日志提到函数第一行，整段「下载前的准备」
 *        套 try/catch（meta 缺字段时不再第一行就抛且无人接），半截文件先删再下。
 *
 * 第 30 轮补记（用户图五「下载按钮点了没反应，扫描并下载也没效果」）：
 *   两个头部下载按钮的 disabled 由 `loading || !!batchLoadingText` 收紧成 `loading`，页面
 *   不再调用 handleWebDAVBatchDownload / handleWebDAVDownloadAndImport —— 两个入口（⋮ 菜单
 *   的「下载」与头部「扫描并下载」）改走下载管理器（downloadMusicAsync / batchDownload）。
 *   于是本轮把不变量②的锚点换成 `disabled={loading}`，并新加一条「页面不许再出现
 *   batchLoadingText」的守卫（几百首的批量任务期间按钮长期灰着同样属于「按了没反应」）。
 *   老函数本体保留未删，其内部形状仍由 sim-webdav-menu-download-ladder.js 守着。
 *
 * 第 31 轮补记（用户图一「WebDAV 还是存在不自动加载在线封面的情况……进入 WebDAV 歌单界面
 * 也是会刷新该列表下所有歌曲的在线封面，请强化」）：
 *   ① 「进列表」并入强制刷新：loadConfig（挂载 + 每次切页两条入口都走它）也置位
 *      forceCoverRefresh。第 30 轮只把扫描/下拉接上了 force，入口没接 ⇒ 进来那一轮
 *      isRefresh=false，内存里有结果的歌被 getCachedCoverUrl 挡掉，「进来还是灰占位」照旧。
 *   ② 行内自愈改为加法式：原来的 prefetchCovers([target]) 是整轮巡检入口（clear 已试名单 +
 *      清空全部失败备忘 + 轮次 +1），在巡检推进中被行内失败触发时，会把**正在飞的那一轮**
 *      判成「上一轮过期」而整体中止 —— 一首歌的行内失败就能掐死后面所有歌的封面补全。
 *      现在走 refreshWebdavCover：只作废这一首的内存缓存与失败备忘（local.ts 新增单曲版
 *      clearWebdavCoverMiss）、单取一次；不碰轮次、不清别人进度。本脚本不变量⑤与反例 c27–c30
 *      钉住这条分工（含「不许出现 prefetchCovers( / clearWebdavCoverMisses(」）。
 *
 * 第 34 轮补记（用户图三「列表滑动到最后继续向上滑时会出现抽动……而且会出现加载在线封面
 * 因为一个或者几个刷新不出来而不会加载后面歌曲封面的情况，请保证全部加载出封面」）：
 *   两个症状，两个独立的病根，都在同一条链路上：
 *   ① 抽动 —— getItemLayout 报的行高比真实值小一个 marginBottom。卡片自身高 ITEM_HEIGHT，
 *      下面还挂着 styles.songItem.marginBottom = designSpacing.sm(12pt)，一个单元格占的是两者
 *      之和。FlatList 拿 length/offset 算「内容总高 / 可视窗口 / 滚动偏移」，逐行少 12pt 后
 *      到第 300 行就少 3600pt（≈ 42 行）—— removeClippedSubviews 在列表末尾按错的窗口卸载/
 *      回挂单元格，内容高度反复收缩，用户看到的就是「向上滑的过程中出现间断的向下滑」。
 *      本脚本不变量 D①③ 钉住 length 与 offset 同源、且来源就是 songItem 的实测几何。
 *   ② 后面不再加载 —— 两层堵死，缺任一层都复发：
 *      a) getPicPath 走音源 SDK 的 HTTP，SDK 内部没有超时：一首卡住就永不 settle，占死
 *         runWithLimit 的 4 个并发槽位之一（卡满 4 个 → 整列一首都不再加载）。所以在**入队任务
 *         的内部**套 withCoverTimeout(15s)：到点按「没拿到封面」resolve 空串，槽位释放
 *         （包在 runWithLimit 外面等于槽位照样被占死 —— 不变量 D② 钉的就是「包在里面」）。
 *      b) 整批的 `await Promise.all(tasks)` 等的是「这批都成功」：一个永不 settle 的任务让这一批
 *         永远返回不了，循环不再往下走，后面几百首一批都不推进。改成 allSettled（不变量 D④）。
 *
 * 第 36 轮补记（用户图一/图二：「加载在线封面应该持续刷新，直到刷新出来为止……不论是刷新、
 * 扫描、还是重新进入列表都不会再刷了，请修复这个问题，保证封面可以 100% 可以刷出」；
 * 「滑动到最底部时，如果再向上滑动，会出现间断的向下跳动」）：
 *   ① 抽动那条第 34 轮修得不彻底：它只让 getItemLayout 的**回报值**加上了 marginBottom，
 *      而卡片自身的 height / marginBottom 仍写在 createStyle 里 —— createStyle 的产物会被
 *      trasformeStyle 再乘一次 scaleSizeH（utils/tools.ts），@3x 机型上渲染值 68pt ≠ 回报值 66pt，
 *      逐行仍有 2pt 偏差，滑到末尾照旧跳。现在这两个纵向数值**写在行内 style**（不经二次换算），
 *      「渲染值 == 回报值」由构造保证。不变量 D① 改钉行内 style；反例 n36a 钉「不许把 height 放回
 *      createStyle」，n36b 钉「行内不许丢掉 height」。
 *   ② 行内自愈的一次性守卫改成「带冷却的持久重试」：第 29 轮的 Set 一次失败就把这一行判死
 *      （CDN 抖一下、图片刚换、网络刚切换都算永久失败），正是用户说的「刷不出来就再也不会刷了」。
 *      现在是 (id|url) 冷却窗口（COVER_ERROR_RETRY_COOLDOWN_MS），窗口外允许再自愈。
 *   续巡（跑完还有空封面就自己安排下一轮）由 sim-webdav-auto-cover-lyric.js 钉住，本脚本不重复。
 *
 * 第 39 轮第 2 条补记（用户图二：选 /music 点扫描、封面开始加载；再切 /music1 点扫描，封面
 * 「一首都不开始加载」。修好后要求「重新进入 WebDAV 界面、下滑刷新、点击扫描按钮都会重新
 * 自动刷新在线封面」）：
 *   病根在 coverUrl.ts：4 并发槽是全 App 共用的**单一 FIFO**，换目录前那份歌单（325 首）的
 *   整表巡检还在排队时，新歌单的任务全部落在它们后面 —— 屏幕上这批歌连请求都还没发出去。
 *   修法：等位任务分「插队 / 常规」两条队列（出队时插队优先），WebDAV 的整表巡检 / 可视列表
 *   巡检 / ⋮ 菜单单曲补图全部走插队通道；并发上限仍是 4（只改顺序，不加槽位）。
 *   本脚本新增不变量 E 与反例 p1–p6 钉住这条通道（含「其他页面口径零变化」的默认 false）。
 *
 * 为什么必须靠契约脚本：「整表分批 / 先探活再当缺失 / 每轮清备忘 / 刷新带 isRefresh /
 * onError 只重试一次 / 按钮不再被 disabled 吞掉 / 失败一定有日志和提示」全是形状与顺序，
 * 不是类型 —— 把 file:// 校验删掉、把清备忘删掉、把分批换回前 20 首、把 isRefresh 去掉、
 * 把 !hasConfig 放回 disabled、把 catch 删掉，tsc/eslint 全是绿的，只在真机上表现为
 * 「封面挂了就永远不回来 / 点下载什么都没发生」。带反例自检。
 *
 * 运行：node scripts/sim-webdav-cover-watch.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去块注释与整行 `//` 注释（不能按 `/\/\/[^\n]*/g` 朴素切：本文件要看 `'file://'` 这类字符串字面量）
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  page: 'src/screens/Home/Views/WebDAV/index.tsx',
  action: 'src/screens/Home/Views/WebDAV/WebDAVListAction.ts',
  local: 'src/core/music/local.ts',
  coverUrl: 'src/core/music/coverUrl.ts',
  // 【第 34 轮】行高数值模型的来源（不变量 D ③ 要拿真实令牌算「逐行少多少」）
  tokens: 'src/theme/DesignTokens.ts',
  constant: 'src/config/constant.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

const countOf = (haystack, needle) => haystack.split(needle).length - 1

const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  const end = src.indexOf(to, start + from.length)
  if (end <= start) return null
  return src.slice(start, end)
}

// ---------------------------------------------------------------------------
// 不变量 A（条一①–④）：列表页巡检 + coverUrl.ts isRefresh/作废缓存 + local.ts 清备忘
// ---------------------------------------------------------------------------

const coverWatchInvariants = (files) => {
  const reasons = []
  const page = stripComments(files.page)

  // 巡检实现体：`const prefetchedCoverIds = useRef(` → `const loadConfig = useCallback(`
  const body = slice(page, 'const prefetchedCoverIds = useRef(', 'const loadConfig = useCallback(')
  if (!body) {
    reasons.push('prefetchCovers 实现体切片失败（锚点漂移：prefetchedCoverIds / loadConfig）')
    return reasons
  }

  // ① 「有 picUrl」不再等于「有封面」：file:// 的必须探活
  if (!body.includes('if (song.meta.picUrl) {')) {
    reasons.push('巡检没有对「已有 meta.picUrl」做分支（失效的本地封面会被当成有封面，行内 useCoverUrl 还会短路）')
  } else {
    if (!body.includes("song.meta.picUrl.startsWith('file://')")) {
      reasons.push('巡检没有区分 file:// 本地封面（远程封面不能当已失效处理，本地封面必须探活）')
    }
    if (!body.includes('existsFile(')) {
      reasons.push('巡检没有校验 file:// 封面文件是否还在（被系统清掉后列表永远空占位）')
    }
    if (!body.includes('invalidateCoverCache(song)')) {
      reasons.push('失效的本地封面没有作废内存缓存（行内会继续拿到那张已经不存在的图）')
    }
    if (!body.includes("{ ...item, meta: { ...item.meta, picUrl: '' } }")) {
      reasons.push('失效的本地封面没有从列表状态里清掉（行内 useCoverUrl 仍会因为 picUrl 非空而短路）')
    }
  }

  // ② 每轮重来：失败备忘 + 已试 id 都清
  if (!body.includes('clearWebdavCoverMisses()')) {
    reasons.push('每轮巡检没有清空「搜过没结果」的失败备忘（封面缺失的歌不会再被自动补）')
  }
  if (!body.includes('prefetchedCoverIds.current.clear()')) {
    reasons.push('每轮巡检没有清空已试过的 id（上一轮试过的歌这一轮不再补）')
  }

  // ③ 整表分批推进（不是只补前 20 首）
  if (!body.includes('i += MAX_PREFETCH_COVERS')) {
    reasons.push('巡检没有按 MAX_PREFETCH_COVERS 分批推进整份列表（只补前 20 首，滚下去的歌没有封面也不补）')
  }

  // ④ 刷新 = 连封面是不是最新都重查（刷新标记一路透传到 coverUrl.ts 的 fetchCoverUrl）
  // 【第 38 轮第 1 条】页面里的取封面收敛成本页唯一漏斗 fetchCoverForSong；【第 39 轮第 2 条】
  // 漏斗再多带一个 highPriority（插队标记，见不变量 E），所以这里的锚点跟着漏斗的调用形状走。
  if (!body.includes('fetchCoverForSong(song, isRefresh, true)')) {
    reasons.push('巡检没有把刷新标记透传给取封面漏斗（刷新时不会复核封面是否最新）')
  }
  if (!body.includes('return fetchCoverUrl(song, { isRefresh, highPriority }).then((url) => {')) {
    reasons.push('取封面漏斗没有把 { isRefresh, highPriority } 透传给 fetchCoverUrl（刷新复核 / 插队通道一起断）')
  }
  if (!page.includes('const forceCoverRefresh = useRef(false)')) {
    reasons.push('列表页没有 forceCoverRefresh 刷新标记（刷新与普通进列表分不开，无法复核最新封面）')
  }
  const refresh = slice(page, 'const handleRefresh = useCallback(', '}, [songs, prefetchCovers])')
  if (!refresh) {
    reasons.push('handleRefresh 切片失败（锚点漂移：handleRefresh / deps）')
  } else if (!refresh.includes('forceCoverRefresh.current = true')) {
    reasons.push('下拉刷新没有置位 forceCoverRefresh（刷新后封面是否最新/缺失不会复核）')
  }

  // coverUrl.ts：作废缓存 + isRefresh 绕过缓存并透传给在线源
  const coverCode = stripComments(files.coverUrl)
  if (!coverCode.includes('export const invalidateCoverCache')) {
    reasons.push('coverUrl.ts 没有导出 invalidateCoverCache（失效封面无法作废内存缓存）')
  }
  if (!coverCode.includes('coverCache.delete(keyOf(song))')) {
    reasons.push('coverUrl.ts 的 invalidateCoverCache 没有真删缓存项（作废等于没作废）')
  }
  // 【第 39 轮第 2 条】选项从「只有 isRefresh」扩成「isRefresh + highPriority」：按签名切片看
  // 两个选项都在（不锚死具体排版，但少一个就判红 —— 刷新复核与插队各缺一边都不可）
  const coverOptions = slice(coverCode, 'export const fetchCoverUrl = async(', '): Promise<string> => {')
  if (!coverOptions || !coverOptions.includes('isRefresh?: boolean') || !coverOptions.includes('highPriority?: boolean')) {
    reasons.push('coverUrl.ts 的 fetchCoverUrl 选项里少了 isRefresh / highPriority（刷新复核或插队通道没有入口）')
  }
  if (!coverCode.includes('if (!options?.isRefresh) {')) {
    reasons.push('coverUrl.ts 的 fetchCoverUrl 在刷新时仍然先吃内存缓存（复核不到「未更新」）')
  }
  if (!coverCode.includes('isRefresh: options?.isRefresh === true')) {
    reasons.push('coverUrl.ts 没有把 isRefresh 透传给 getPicPath（在线源拿不到刷新标记）')
  }

  // local.ts：清失败备忘必须真清
  // （不能只查 `webdavCoverSearchMisses.clear()` 在文件里出现过 —— markWebdavCoverMiss 的
  //  超限清理那一行也是同样的文本，得切片到函数体里看）
  const localCode = stripComments(files.local)
  if (!localCode.includes('export const clearWebdavCoverMisses = () => {')) {
    reasons.push('local.ts 没有导出 clearWebdavCoverMisses（列表页无法每轮重查失败过的歌）')
  }
  const clearFn = slice(localCode, 'export const clearWebdavCoverMisses = () => {', '}')
  if (!clearFn || !clearFn.includes('webdavCoverSearchMisses.clear()')) {
    reasons.push('local.ts 的 clearWebdavCoverMisses 没有真清 Set（失败备忘还在）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B（条一⑤）：行内 onError 自愈（一次性重试，且不新增 fetchCoverUrl 直调点）
// ---------------------------------------------------------------------------

const inlineHealInvariants = (files) => {
  const reasons = []
  const page = stripComments(files.page)

  if (!page.includes("onError={(url) => { onCoverError(item, String(url)) }}")) {
    reasons.push('行内封面 Image 没有 onError 回调（远程封面 404 / 本地封面被清掉后那一行永远停在占位）')
  }
  if (!page.includes('onCoverError: (musicInfo: LX.WebDAV.MusicInfo, url: string) => void')) {
    reasons.push('SongItem 没有 onCoverError 属性（行内加载失败传不到列表页）')
  }
  if (!page.includes('onCoverError={handleCoverError}')) {
    reasons.push('列表行没有把 handleCoverError 接到 onCoverError（自愈链路断开）')
  }
  if (!page.includes('handlePlay, showMenu, handleCoverError,')) {
    reasons.push('renderSong 的依赖项里少了 handleCoverError（行渲染不会跟自愈回调更新）')
  }

  const heal = slice(page, 'const coverErrorRetriedAt = useRef(', 'const handleEditMetadata = useCallback(')
  if (!heal) {
    reasons.push('handleCoverError 切片失败（锚点漂移：coverErrorRetriedAt / handleEditMetadata）')
    return reasons
  }
  if (!heal.includes('`${song.id}|${url}`')) {
    reasons.push('handleCoverError 没有按 (id|url) 组键（同一行不同 URL 会被误判成重试过）')
  }
  // 【第 36 轮第 3 条】守卫从「一次性 Set」改成「带冷却的持久重试」：封面加载失败往往是暂时的
  // （CDN 抖一下 / 图片刚换 / 网络刚切换），一次失败就判死 = 用户说的「刷不出来就再也不会刷了」。
  // 但冷却仍是必须的：窗口内同一个 (id|url) 只能触发一次，否则死图会来回换造成请求风暴。
  if (!heal.includes('if (lastRetryAt && now - lastRetryAt < COVER_ERROR_RETRY_COOLDOWN_MS) return')) {
    reasons.push('handleCoverError 没有冷却守卫（同一张挂掉的图会被无限重试，变成请求风暴）')
  }
  if (!heal.includes('coverErrorRetriedAt.current.set(key, now)')) {
    reasons.push('handleCoverError 没有把这次的触发时刻记下来（冷却守卫形同虚设）')
  }
  if (heal.includes('useRef(new Set')) {
    reasons.push('handleCoverError 又退回一次性 Set（首次失败即判死：网络抖一下这一行就永远补不上，第 36 轮第 3 条的老毛病）')
  }
  const cooldown = Number((/const COVER_ERROR_RETRY_COOLDOWN_MS = (\d+)/.exec(page) ?? [])[1])
  if (!Number.isFinite(cooldown) || !(cooldown >= 1000 && cooldown <= 300000)) {
    reasons.push(`封面自愈冷却 ${cooldown}ms 不在合理区间 [1000, 300000]（太小死图来回换，太大等于没有持久重试）`)
  }
  // 【第 31 轮】自愈落点：refreshWebdavCover（加法式单曲补齐），且不许再借道整轮巡检入口。
  // prefetchCovers 一进来就 clear 已试名单 + 清空全部失败备忘 + 轮次 +1 —— 行内失败发生在
  // 巡检推进过程中，这一下会把正在飞的那一轮判成「上一轮过期」整体中止：一首歌的行内失败
  // 就能掐死后面所有歌的封面补全（用户第 31 轮报的「还是不自动加载在线封面」的另一半成因）。
  if (!heal.includes('refreshWebdavCover(song)')) {
    reasons.push('handleCoverError 没有触发单曲自愈（清了 picUrl 却没人去补，行内会空占位）')
  }
  if (heal.includes('prefetchCovers(')) {
    reasons.push('handleCoverError 仍借道整轮巡检入口 prefetchCovers（会把在飞的那一轮掐死，见第 31 轮说明）')
  }

  // 页面里 fetchCoverUrl( 只该出现在巡检那一处：别在渲染/自愈路径上新增逐首直调（绕开缓存与并发闸）
  const fetchCount = countOf(page, 'fetchCoverUrl(')
  if (fetchCount !== 1) {
    reasons.push(`页面里 fetchCoverUrl( 出现 ${fetchCount} 次（应当只有巡检那一处，自愈路径要走 refreshWebdavCover）`)
  }

  // 单曲自愈 helper 本体（WebDAVListAction.ts）：必须是「加法式」的
  const actionCode = stripComments(files.action)
  const healFn = slice(actionCode, 'export const refreshWebdavCover = async(', 'export const handleFetchWebDAVPicFromOnline = async(')
  if (!healFn) {
    reasons.push('WebDAVListAction 没有导出 refreshWebdavCover（行内自愈没有加法式实现）')
  } else {
    if (!healFn.includes('invalidateCoverCache(')) {
      reasons.push('refreshWebdavCover 没有作废这一首的内存缓存（重取还会拿到挂掉的那张）')
    }
    if (!healFn.includes('clearWebdavCoverMiss(')) {
      reasons.push('refreshWebdavCover 没有清这一首的失败备忘（搜过没结果的歌自愈会被直接跳过）')
    }
    if (!healFn.includes('isRefresh: true')) {
      reasons.push('refreshWebdavCover 没有带 isRefresh 重取（自愈只是再吃一遍缓存，换不到新图）')
    }
    if (!healFn.includes("picUrl: ''")) {
      reasons.push('refreshWebdavCover 没有把 picUrl 清空再取（local.ts 见 picUrl 直接返回，走不到在线兜底搜索）')
    }
    if (healFn.includes('prefetchCovers(')) {
      reasons.push('refreshWebdavCover 借道整轮巡检入口（会打断正在飞的那一轮）')
    }
    if (healFn.includes('clearWebdavCoverMisses(')) {
      reasons.push('refreshWebdavCover 清空了全部失败备忘（其他歌的巡检进度被重置，搜索风暴会回来）')
    }
  }

  // local.ts：单曲备忘清除必须只删自己那一条 key（整表清空会把别人的进度一起抹掉）
  const localCode = stripComments(files.local)
  if (!localCode.includes('export const clearWebdavCoverMiss = (')) {
    reasons.push('local.ts 没有导出单曲版 clearWebdavCoverMiss（自愈只能清整表，别的歌进度被重置）')
  }
  const missFn = slice(localCode, 'export const clearWebdavCoverMiss = (', '\n}')
  if (!missFn || !missFn.includes('webdavCoverSearchMisses.delete(getWebdavCoverMissKey(musicInfo))')) {
    reasons.push('local.ts 的 clearWebdavCoverMiss 没有按单曲 key 真删（这一首仍会被备忘跳过）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C（条二）：下载按钮按了有反应（响应式 hasConfig / 不被 disabled 吞 / 失败有日志与提示）
// ---------------------------------------------------------------------------

const downloadButtonInvariants = (files) => {
  const reasons = []
  const page = stripComments(files.page)

  // ① hasConfig 必须响应式
  if (!page.includes("useSettingValue('sync.webdav.url')")) {
    reasons.push('列表页没有订阅 sync.webdav.url（hasConfig 还是一次性快照，配置晚到时按钮永远点不动）')
  }
  if (!page.includes("useSettingValue('sync.webdav.username')")) {
    reasons.push('列表页没有订阅 sync.webdav.username（hasConfig 还是一次性快照）')
  }
  if (page.includes('settingState')) {
    reasons.push('列表页还在直接读 settingState（挂载时读一次的快照，配置变化不会跟上）')
  }

  // ② 两个下载按钮不能被禁用条件吞掉点击
  // 【第 30 轮】禁用条件从 `loading || !!batchLoadingText` 收紧成 `loading`：下载动作整段
  // 交给下载管理器了（见 sim-webdav-download-manager.js），页面不再持有「批量下载中」这个
  // 可以持续几分钟的状态 —— 拿它禁用按钮，几百首的批量任务期间两个按钮会一直灰着点不动，
  // 那同样属于「按了没反应」。这里同时把「未配置被禁用」和「又被批量状态长期禁用」两条堵上。
  const disabledCount = countOf(page, 'disabled={loading}')
  if (disabledCount !== 2) {
    reasons.push(`两个下载按钮的 disabled={loading} 只出现 ${disabledCount} 次（未配置时按钮被禁用、按下去被静默吞掉，或又被某个批量状态长期禁用）`)
  }
  if (page.includes('batchLoadingText')) {
    reasons.push('列表页又出现 batchLoadingText（第 30 轮起下载走下载管理器，页面不再持有批量下载状态；它一旦重新进 disabled，按钮会被长期灰掉）')
  }

  // ③ ⋮ 菜单下载：入口日志 + catch 落日志/toast
  const menuDownload = slice(page, 'const handleDownload = useCallback(', 'const handleFetchPicFromOnline = useCallback(')
  if (!menuDownload) {
    reasons.push('handleDownload 切片失败（锚点漂移：handleDownload / handleFetchPicFromOnline）')
  } else {
    if (!menuDownload.includes("webDAVLog.info('handleDownload: menu download pressed'")) {
      reasons.push("handleDownload 没有入口日志（分不清「没进回调」还是「进了回调静默失败」）")
    }
    if (!menuDownload.includes("webDAVLog.error('handleDownload: download failed'")) {
      reasons.push('handleDownload 的 .catch 没有落失败日志（下载失败在日志里一行都没有）')
    }
    if (!menuDownload.includes(".catch((err: any) => {")) {
      reasons.push('handleDownload 没有 catch（准备阶段抛错时整个 Promise 静默 reject，按了没反应）')
    }
    if (!menuDownload.includes("toast(`下载失败：${message}`, 'long')")) {
      reasons.push('handleDownload 失败时没有把具体原因告诉用户')
    }
  }

  // ④ 扫描并下载：入口日志在确认框之前 + 即时反馈 + 取消清标题 + 尾部 catch
  const batch = slice(page, 'const handleBatchDownload = useCallback(', 'const loadFolders = useCallback(')
  if (!batch) {
    reasons.push('handleBatchDownload 切片失败（锚点漂移：handleBatchDownload / loadFolders）')
  } else {
    const invokedAt = batch.indexOf("webDAVLog.info('handleBatchDownload: invoked'")
    const dialogAt = batch.indexOf('confirmDialog(')
    if (invokedAt < 0) {
      reasons.push("handleBatchDownload 没有入口日志（按了没反应时无从排查）")
    } else if (dialogAt >= 0 && invokedAt > dialogAt) {
      reasons.push('handleBatchDownload 的入口日志排在确认框之后（弹窗没出来时日志里一行都没有）')
    }
    if (!batch.includes("setScanText('准备扫描并下载…')")) {
      reasons.push('handleBatchDownload 按下没有即时可见反馈（弹窗若没弹出来就是「点了没反应」）')
    }
    if (!batch.includes("webDAVLog.info('handleBatchDownload: cancelled by user')")) {
      reasons.push('handleBatchDownload 用户取消时没有落日志（分不清取消还是没响应）')
    }
    if (!batch.includes("webDAVLog.error('handleBatchDownload: failed'")) {
      reasons.push('handleBatchDownload 尾部没有 catch 落日志（确认框失败会把「准备扫描并下载…」永远留在标题上）')
    }
    if (!batch.includes('if (!hasConfig) {')) {
      reasons.push('handleBatchDownload 没有「未配置 → 提示并跳配置页」的分支（未配置时按下去没反应）')
    }
  }

  // ⑤ WebDAVListAction：入口日志提到第一行 + 下载前准备套 try/catch + 半截文件先删
  const actionCode = stripComments(files.action)
  const fn = slice(actionCode, 'export const handleWebDAVDownload = async(', 'export const handleFetchWebDAVPicFromOnline = async(')
  if (!fn) {
    reasons.push('handleWebDAVDownload 切片失败（锚点漂移：handleWebDAVDownload / handleFetchWebDAVPicFromOnline）')
  } else {
    const logAt = fn.indexOf("webDAVLog.info('handleWebDAVDownload: invoked'")
    const prepAt = fn.indexOf('getDefaultDownloadDir()')
    if (logAt < 0) {
      reasons.push('handleWebDAVDownload 入口日志没提到函数第一行（meta 缺字段时第一行就抛、日志一行没有）')
    } else if (prepAt >= 0 && logAt > prepAt) {
      reasons.push('handleWebDAVDownload 的入口日志排在取文件名之后（meta 缺字段时抛错发生在日志之前）')
    }
    if (!fn.includes('try {')) {
      reasons.push('handleWebDAVDownload 的「下载前准备」没有 try/catch（缺字段/状态解析抛错时无人接）')
    }
    if (!fn.includes("webDAVLog.error('handleWebDAVDownload: prepare failed'")) {
      reasons.push('handleWebDAVDownload 准备阶段抛错时没有落日志 + 给原因（调用方 catch 之前就没有信息了）')
    }
    if (!fn.includes("toast(`下载失败：${message}`, 'long')")) {
      reasons.push('handleWebDAVDownload 准备阶段失败时没有把具体原因告诉用户')
    }
    if (!fn.includes("if (fileState === 'incomplete') {")) {
      reasons.push('handleWebDAVDownload 没有把半截文件当「没下过」处理（断点留下的半个文件会让点下载一直复用坏文件）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D（第 34 轮第 3 条）：末尾抽动（length/offset 与 songItem 实测几何同源）
//   + 封面「一个卡住就拖死后面全部」的两层闸（入队任务内部超时 + 批次 allSettled）
// ---------------------------------------------------------------------------

// 数值模型的落点（给主流程打印用）
const round34Numbers = { drift300: NaN, rows300: NaN, timeoutMs: NaN }

const round34ListInvariants = (files) => {
  const reasons = []
  const page = stripComments(files.page)
  const coverCode = stripComments(files.coverUrl)

  // ① 行高常量 = 卡片高 + 行下外边距（同一个来源，不许各算各的）；且这两个纵向数值必须写在
  //    **行内 style**：createStyle 的产物会被 trasformeStyle 再乘一次 scaleSizeH
  //    （utils/tools.ts:619-659），而 ITEM_HEIGHT 本身已经是 scaleSizeH 的结果 ——
  //    @3x 机型上渲染值 scaleSizeH(scaleSizeH(64)) = 68 ≠ getItemLayout 回报值 66，
  //    逐行 2pt、到第 300 行累计 600pt，FlatList 在末尾反复重算内容尺寸 → 向下跳动。
  //    行内写死即「渲染值 == 回报值」由构造保证（与其它歌曲列表同口径）。
  if (!page.includes('const ITEM_ROW_HEIGHT = ITEM_HEIGHT + designSpacing.sm')) {
    reasons.push('getItemLayout 的行高常量不是「卡片高 + 行下外边距」（少加 marginBottom → 逐行累计偏移，列表末尾抽动）')
  }
  const rowStyle = slice(page, '          ...styles.songItem,', '          backgroundColor: applyOpacity(')
  if (!rowStyle) {
    reasons.push('renderSong 行内 style 切片失败（锚点漂移：...styles.songItem / backgroundColor —— 实渲行高来源无法核对）')
  } else {
    if (!rowStyle.includes('height: ITEM_HEIGHT,')) {
      reasons.push('行内 style 没有带 height: ITEM_HEIGHT（退回 createStyle 后会被 trasformeStyle 二次 scaleSizeH，渲染值比 getItemLayout 回报值大 → 列表末尾向下跳动复发）')
    }
    if (!rowStyle.includes('marginBottom: designSpacing.sm,')) {
      reasons.push('行内 style 没有带 marginBottom: designSpacing.sm（行距被二次换算，实渲行高与回报行高不同源）')
    }
  }
  const songItem = slice(page, '  songItem: {', '  songItemLeft: {')
  if (!songItem) {
    reasons.push('styles.songItem 切片失败（锚点漂移：songItem / songItemLeft —— 行高来源无法核对）')
  } else {
    if (/(^|\n)\s*height\s*:/.test(songItem)) {
      reasons.push('createStyle 的 songItem 里又出现 height（纵向数值会被 trasformeStyle 再乘一次 scaleSizeH，渲染值 ≠ getItemLayout 回报值 → 末尾向下跳动）')
    }
    if (/(^|\n)\s*marginBottom\s*:/.test(songItem)) {
      reasons.push('createStyle 的 songItem 里又出现 marginBottom（行距被二次换算，实渲行高与回报行高不同源）')
    }
  }

  // ② getItemLayout：length 与 offset 同源，且都用实测行高
  const layout = slice(page, 'getItemLayout={(data, index) => ({', '})}')
  if (!layout) {
    reasons.push('getItemLayout 切片失败（锚点漂移）')
  } else {
    if (!layout.includes('length: ITEM_ROW_HEIGHT,')) {
      reasons.push('getItemLayout 的 length 不是实测行高 ITEM_ROW_HEIGHT（FlatList 认为的行高比真实值小）')
    }
    if (!layout.includes('offset: ITEM_ROW_HEIGHT * Math.floor(index / numColumns),')) {
      reasons.push('getItemLayout 的 offset 不是按实测行高逐行累计（与 length 不同源，滚动偏移整体偏小）')
    }
  }
  if (page.includes('length: ITEM_HEIGHT,')) {
    reasons.push('getItemLayout 又退回 length: ITEM_HEIGHT（第 34 轮第 3 条的老形状）')
  }
  if (!page.includes('removeClippedSubviews={true}')) {
    reasons.push('列表不再 removeClippedSubviews（本条抽动的触发条件变了，请复核本不变量是否还成立）')
  }

  // ③ 数值模型：逐行少多少、到第 300 行累计多少（量级不是半像素，抽动才看得见）
  const sm = (/export const designSpacing = \{[\s\S]*?\bsm: (\d+)/.exec(files.tokens ?? '') ?? [])[1]
  const item = (/export const LIST_ITEM_HEIGHT = (\d+)/.exec(files.constant ?? '') ?? [])[1]
  const smN = Number(sm)
  const itemN = Number(item)
  if (!Number.isFinite(smN) || smN <= 0) {
    reasons.push('designSpacing.sm 读不到或为 0：行高公式退化成 ITEM_HEIGHT，本契约变成空转（令牌丢失比写错更难发现）')
  } else if (!Number.isFinite(itemN) || itemN <= 0) {
    reasons.push('LIST_ITEM_HEIGHT 读不到（行高数值模型无法成立）')
  } else {
    const drift = smN * 300
    if (drift < itemN) {
      reasons.push(`行高错位量级过小（第 300 行累计 ${drift}pt）—— 与本契约的前提不符，请复核令牌`)
    }
    round34Numbers.drift300 = drift
    round34Numbers.rows300 = drift / (itemN + smN)
  }

  // ④ 分批推进用 allSettled（等「这批都结束」，不是「这批都成功」）
  const sweep = slice(page, 'const prefetchedCoverIds = useRef(', 'const loadConfig = useCallback(')
  if (!sweep) {
    reasons.push('巡检实现体切片失败（锚点漂移：prefetchedCoverIds / loadConfig）')
  } else {
    if (!sweep.includes('await Promise.allSettled(tasks)')) {
      reasons.push('批次之间不是 allSettled（一个永不 settle 的任务把这一批永久挂住，后面所有歌曲的封面全部不再加载）')
    }
    if (sweep.includes('await Promise.all(tasks)')) {
      reasons.push('巡检又用回 await Promise.all(tasks)（第 34 轮第 3 条的老形状）')
    }
  }

  // ⑤ 超时闸门：常量有界 + 包在入队任务内部 + 到点按「没拿到封面」落地 + 两条路径都清定时器
  const msMatch = /const COVER_FETCH_TIMEOUT_MS = (\d+)/.exec(coverCode)
  if (!msMatch) {
    reasons.push('coverUrl.ts 没有单张封面的获取超时（一首卡住就占死并发槽位，整列封面停摆）')
  } else {
    const ms = Number(msMatch[1])
    round34Numbers.timeoutMs = ms
    if (!(ms >= 3000 && ms <= 60000)) {
      reasons.push(`封面超时 ${ms}ms 不在合理区间 [3000, 60000]（太小把慢网全判成没封面，太大等于没有超时）`)
    }
  }
  if (!coverCode.includes('const withCoverTimeout = (p: Promise<string>, ms: number): Promise<string> =>')) {
    reasons.push('coverUrl.ts 没有 withCoverTimeout 助手（超时后的落地口径无处可查）')
  } else {
    const helper = slice(coverCode, 'const withCoverTimeout = (p: Promise<string>, ms: number): Promise<string> =>', 'interface CoverSong')
    if (!helper) {
      reasons.push('withCoverTimeout 切片失败（锚点漂移）')
    } else {
      if (!helper.includes("resolve('')")) {
        reasons.push('withCoverTimeout 超时后不按「没拿到封面」返回空串（抛出去/挂着不落地，整批与槽位一起卡住）')
      }
      if (/\breject\b/.test(helper)) {
        reasons.push('withCoverTimeout 里出现了 reject（超时必须静默落地成空串，不许把失败往上抛）')
      }
      // 超时那一条分支单独看：整个助手别处有 resolve('') 不算数（失败分支本来就有），
      // 只有「到点」这条路径必须自己落地成空串、且不许 throw/reject。
      const timeoutBranch = slice(helper, 'const timer = setTimeout(() => {', '}, ms)')
      if (!timeoutBranch) {
        reasons.push('withCoverTimeout 的超时分支切片失败（锚点漂移：setTimeout / ms）')
      } else {
        if (!timeoutBranch.includes("resolve('')")) {
          reasons.push('withCoverTimeout 的超时分支不返回空串（到点了还往上抛/挂着不落地，整批与槽位一起卡住）')
        }
        if (/\bthrow\b|\breject\b/.test(timeoutBranch)) {
          reasons.push('withCoverTimeout 的超时分支里出现 throw/reject（超时必须静默落地成空串，不许把失败往上抛）')
        }
      }
      const clearCount = countOf(helper, 'clearTimeout(timer)')
      if (clearCount < 2) {
        reasons.push(`withCoverTimeout 只在 ${clearCount} 条路径上清定时器（成功 / 失败两条路径都要清，否则每张封面都留一个 15 秒定时器）`)
      }
    }
  }
  // 包在**入队任务的内部**：只有任务自己 settle，runWithLimit 的 finally 才会让出槽位
  // 【第 39 轮第 2 条】入队调用多了一个 isPriority 实参（插队标记），任务本体（async() => 的
  // 第一句就是 withCoverTimeout）不变 —— 锚点跟着新排版走，钉的仍是「超时在任务内部」。
  if (!/const task = runWithLimit\(\s*\n\s*async\(\) =>\s*\n\s*withCoverTimeout\(/.test(coverCode)) {
    reasons.push('超时没包在 runWithLimit 的任务内部（包在外面 = 槽位仍被永不 settle 的任务占死，并发被逐个吃光）')
  }
  if (!coverCode.includes('getPicPath({ musicInfo: song as LX.Music.MusicInfo, isRefresh: options?.isRefresh === true })')) {
    reasons.push('入队任务里取封面的调用形状变了（isRefresh 透传或入参形状需复核）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 E（第 39 轮第 2 条）：WebDAV 取封面走「插队通道」
//
//   用户原话：「在配置中选择当前目录 music，点击列表中的扫描按钮，在线封面开始加载，当我再点击
//   配置中选择当前目录 music1，点击列表中的扫描按钮，在线封面无法自动开始加载，请修复，修复后，
//   重新进入 WebDAV 界面、下滑刷新、点击扫描按钮，都会重新自动刷新在线封面，使封面 100% 显示」。
//
//   病根：coverUrl.ts 的 MAX_CONCURRENT=4 是**全 App 共用**的单一 FIFO —— 换目录之前那份歌单
//   （325 首）的整表巡检还在排队，新歌单的任务全部排在它们后面。屏幕上这批歌连请求都还没发出去，
//   观感就是「点了扫描，在线封面一首都不开始加载」。
//
//   修法：等位任务分「插队 / 常规」两条队列，出队时插队队优先；WebDAV 页的所有取封面
//   （整表巡检 / 可视列表巡检 / ⋮ 菜单单曲补图）都走插队通道 —— 它们代表用户此刻盯着看的列表。
//   并发上限仍是 4：插队只改**出队顺序**，不许靠放大并发来「变快」（第 34 轮那套
//   「入队任务内部超时 + 批次 allSettled」仍是唯一的堵死防线，见不变量 D）。
// ---------------------------------------------------------------------------

const priorityLaneInvariants = (files) => {
  const reasons = []
  const page = stripComments(files.page)
  const coverCode = stripComments(files.coverUrl)
  const actionCode = stripComments(files.action)

  // ① coverUrl.ts：两条队列 + 出队插队优先 + 入队按标记分流 + 并发上限不变
  if (!coverCode.includes('const priorityTaskQueue: Array<() => void> = []')) {
    reasons.push('coverUrl.ts 没有插队队列（换目录后的新歌单仍排在旧歌单几百个任务后面 → 封面一首都不开始加载）')
  }
  if (!coverCode.includes('priorityTaskQueue.shift() ?? taskQueue.shift()')) {
    reasons.push('出队没有「插队队列优先」（两条队列都在，出队还是先进先出 = 没插队）')
  }
  if (!/const runWithLimit = async\(fn: \(\) => Promise<string>, isPriority = false\): Promise<string> => \{/.test(coverCode)) {
    reasons.push('runWithLimit 没有 isPriority 形参（调用方无处标记插队任务）')
  }
  if (!coverCode.includes('(isPriority ? priorityTaskQueue : taskQueue).push(execute)')) {
    reasons.push('入队没有按标记分流到两条队列（所有任务仍挤在一条 FIFO 上）')
  }
  if (!coverCode.includes('const MAX_CONCURRENT = 4')) {
    reasons.push('并发上限不再是 4（插队只该改出队顺序，不许靠放大并发来「变快」）')
  }

  // ② 页面：整表巡检 / 可视列表巡检都走插队；漏斗把 highPriority 透传给 fetchCoverUrl
  if (!page.includes('const fetchCoverForSong = useCallback((song: LX.WebDAV.MusicInfo, isRefresh: boolean, highPriority = false) => {')) {
    reasons.push('取封面漏斗没有 highPriority 参数（页面里的取封面无处标记插队）')
  }
  if (!page.includes('return fetchCoverUrl(song, { isRefresh, highPriority }).then((url) => {')) {
    reasons.push('漏斗没有把 highPriority 透传给 fetchCoverUrl（插队标记在半路丢了）')
  }
  if (!page.includes('fetchCoverForSong(song, isRefresh, true)')) {
    reasons.push('整表巡检没有走插队通道（它正是把 4 个槽位占满好几分钟的那一批，新歌单排在它后面）')
  }
  if (!page.includes('void fetchCoverForSong(song, false, true)')) {
    reasons.push('可视列表巡检没有走插队通道（屏幕上这几十首仍排在旧歌单几百首后面）')
  }

  // ③ ⋮ 菜单单曲补图（第 31 轮的加法式自愈）：也走插队
  if (!actionCode.includes('fetchCoverUrl(target, { isRefresh: true, highPriority: true })')) {
    reasons.push('refreshWebdavCover 单曲补图没有走插队通道（对着这一首点的「从在线获取封面」还要排旧歌单的队）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------

const tamper = (src, from, to) => {
  if (!src.includes(from)) throw new Error('反例锚点未命中: ' + from.slice(0, 70))
  return src.replace(from, to)
}

const runCounterExamples = () => {
  const results = []
  const check = (name, reasons, expectKeyword) => {
    const hit = reasons.some((r) => r.includes(expectKeyword))
    results.push({
      name,
      ok: hit,
      detail: hit ? '已拦下' : '未拦下（缺失期望理由：' + expectKeyword + '）',
    })
  }

  // ---- 条一：巡检 ----

  // c1 巡检退回「有 picUrl 就当有封面」（第 27 轮的老样子）
  check('c1 有 picUrl 就不再探活', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page, '        if (song.meta.picUrl) {\n', '        if (song.meta.picUrl) continue\n'),
  }),
  '已有 meta.picUrl')

  // c2 不区分 file://（远程封面也被当成「可能失效」，或本地封面不探活）
  check('c2 不区分 file:// 本地封面', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page, "          if (!song.meta.picUrl.startsWith('file://')) continue", '          continue'),
  }),
  '没有区分 file://')

  // c3 不校验封面文件是否还在
  check('c3 不校验封面文件还在不在', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page,
      "          const alive = await existsFile(song.meta.picUrl.replace('file://', '')).catch(() => false)",
      '          const alive = true'),
  }),
  '校验 file:// 封面文件是否还在')

  // c4 失效封面不作废内存缓存
  check('c4 失效封面不作废缓存', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page, '          invalidateCoverCache(song)', '          void song'),
  }),
  '作废内存缓存')

  // c5 失效封面不清列表状态里的 picUrl
  check('c5 失效封面不清 picUrl', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page,
      "            item.id === rawSong.id ? { ...item, meta: { ...item.meta, picUrl: '' } } : item,",
      '            item.id === rawSong.id ? { ...item } : item,'),
  }),
  '从列表状态里清掉')

  // c6 每轮不清失败备忘
  check('c6 不清失败备忘', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page, '    clearWebdavCoverMisses()', '    void 0'),
  }),
  '失败备忘')

  // c7 每轮不清已试过的 id
  check('c7 不清已试 id', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page, '    prefetchedCoverIds.current.clear()', '    void 0'),
  }),
  '已试过的 id')

  // c8 巡检退回「只补前 20 首」
  check('c8 不再分批推进整表', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '      for (let i = 0; i < queue.length; i += MAX_PREFETCH_COVERS) {',
      '      for (const item of queue) {'),
  }),
  '分批推进整份列表')

  // c9 巡检不带 isRefresh（刷新不复核最新）
  // 【第 38/39 轮】锚点跟着页面漏斗 fetchCoverForSong 的调用形状走（它内部才是 fetchCoverUrl）
  check('c9 巡检不带刷新标记', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page, 'fetchCoverForSong(song, isRefresh, true)', 'fetchCoverForSong(song, false, true)'),
  }),
  '刷新标记')

  // c10 下拉刷新没有置位刷新标记
  // 【第 31 轮】锚点从单行 `    forceCoverRefresh.current = true` 扩成两行：loadConfig（进列表）
  // 从本轮起也置位同一个标记，而 tamper 是 String.replace（只替第一处）—— 单行锚点会被
  // 文本更靠前的 loadConfig 那一处抢走，替完 handleRefresh 还是原样，c10 就成了假通过。
  // 带上后面那行 `void Promise.all(` 后锚点唯一（loadConfig 后面那行是 prefetchCovers(songs)）。
  check('c10 刷新不置位标记', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '    forceCoverRefresh.current = true\n    void Promise.all(',
      '    forceCoverRefresh.current = false\n    void Promise.all('),
  }),
  '没有置位 forceCoverRefresh')

  // c11 coverUrl.ts 刷新时仍吃内存缓存
  check('c11 刷新仍吃缓存', coverWatchInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl, 'if (!options?.isRefresh) {', 'if (true) {'),
  }),
  '仍然先吃内存缓存')

  // c12 coverUrl.ts 作废缓存没真删
  check('c12 作废缓存没真删', coverWatchInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl, 'coverCache.delete(keyOf(song))', 'void 0'),
  }),
  '没有真删缓存项')

  // c13 local.ts 清备忘没真清
  check('c13 清备忘没真清', coverWatchInvariants({
    ...REAL,
    local: tamper(REAL.local, '  webdavCoverSearchMisses.clear()', '  void 0'),
  }),
  '没有真清 Set')

  // ---- 条一：行内自愈 ----

  // c14 行内 Image 没有 onError
  check('c14 行内没有 onError', inlineHealInvariants({
    ...REAL,
    page: tamper(REAL.page, '                onError={(url) => { onCoverError(item, String(url)) }}\n', ''),
  }),
  '没有 onError 回调')

  // c15 自愈没有冷却守卫（死图会无限重试）
  check('c15 自愈没有冷却守卫', inlineHealInvariants({
    ...REAL,
    page: tamper(REAL.page, '    if (lastRetryAt && now - lastRetryAt < COVER_ERROR_RETRY_COOLDOWN_MS) return', '    void key'),
  }),
  '没有冷却守卫')

  // n36a 自愈又退回一次性 Set（首次失败即判死 —— 第 36 轮第 3 条要修的正是这个）
  check('n36a 自愈退回一次性 Set', inlineHealInvariants({
    ...REAL,
    page: tamper(REAL.page,
      'const coverErrorRetriedAt = useRef(new Map<string, number>())',
      'const coverErrorRetriedAt = useRef(new Set<string>())'),
  }),
  '又退回一次性 Set')

  // n36b 冷却窗口被改成毫秒级（死图来回换造成请求风暴）
  check('n36b 冷却窗口超界', inlineHealInvariants({
    ...REAL,
    page: tamper(REAL.page, 'const COVER_ERROR_RETRY_COOLDOWN_MS = 30000', 'const COVER_ERROR_RETRY_COOLDOWN_MS = 5'),
  }),
  '不在合理区间')

  // c16 自愈清了 picUrl 却没人补
  check('c16 自愈不触发重补', inlineHealInvariants({
    ...REAL,
    page: tamper(REAL.page, '    void refreshWebdavCover(song).then((newPicUrl) => {', '    void song'),
  }),
  '没有触发单曲自愈')

  // c27 自愈又借道整轮巡检入口（会把正在飞的那一轮判成过期、整体中止）
  check('c27 自愈借道整轮巡检', inlineHealInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '    void refreshWebdavCover(song).then((newPicUrl) => {',
      '    prefetchCovers([song])\n    void Promise.resolve().then((newPicUrl: string) => {'),
  }),
  '仍借道整轮巡检入口')

  // c28 自愈不带 isRefresh（只是再吃一遍缓存，换不到新图）
  check('c28 自愈不带刷新标记', inlineHealInvariants({
    ...REAL,
    action: tamper(REAL.action, 'fetchCoverUrl(target, { isRefresh: true, highPriority: true })', 'fetchCoverUrl(target)'),
  }),
  '没有带 isRefresh')

  // c29 自愈把全部失败备忘一起清掉（其他歌的进度被重置，第 28 轮搜索风暴回来）
  check('c29 自愈清空全部备忘', inlineHealInvariants({
    ...REAL,
    action: tamper(REAL.action, '  clearWebdavCoverMiss(song)', '  clearWebdavCoverMisses()'),
  }),
  '清空了全部失败备忘')

  // c30 单曲失败备忘没有真删（锚点带 key 函数：整表 clear() 那处是另一个名字）
  check('c30 单曲备忘没真删', inlineHealInvariants({
    ...REAL,
    local: tamper(REAL.local, '  webdavCoverSearchMisses.delete(getWebdavCoverMissKey(musicInfo))', '  void musicInfo'),
  }),
  '没有按单曲 key 真删')

  // c31 自愈不清 picUrl 就直接取（local.ts 见 picUrl 直接返回，走不到在线兜底搜索）
  check('c31 自愈不清 picUrl', inlineHealInvariants({
    ...REAL,
    action: tamper(REAL.action, "const target = { ...song, meta: { ...song.meta, picUrl: '' } }", 'const target = song'),
  }),
  '没有把 picUrl 清空再取')

  // c17 渲染/自愈路径上新增 fetchCoverUrl 直调（绕开缓存与并发闸）
  check('c17 页面新增 fetchCoverUrl 直调', inlineHealInvariants({
    ...REAL,
    page: tamper(REAL.page, '  const prefetchedCoverIds = useRef(',
      '  void fetchCoverUrl({ source: \'local\', name: \'\', singer: \'\' })\n  const prefetchedCoverIds = useRef('),
  }),
  '出现 2 次')

  // ---- 条二：下载按钮 ----

  // c18 hasConfig 退回一次性快照
  check('c18 hasConfig 退回快照', downloadButtonInvariants({
    ...REAL,
    page: tamper(REAL.page, "  const webdavUrl = useSettingValue('sync.webdav.url')", "  const webdavUrl = ''"),
  }),
  '一次性快照')

  // c19 两个按钮又把 !hasConfig 放回 disabled
  check('c19 未配置时按钮被禁用', downloadButtonInvariants({
    ...REAL,
    page: tamper(REAL.page, 'disabled={loading}', 'disabled={!hasConfig || loading}'),
  }),
  '只出现 1 次')

  // c26 页面又拿批量状态（batchLoadingText 这类）长期禁用按钮
  check('c26 又被批量状态禁用', downloadButtonInvariants({
    ...REAL,
    page: tamper(REAL.page, 'disabled={loading}', 'disabled={loading || !!batchLoadingText}'),
  }),
  'batchLoadingText')

  // c20 ⋮ 菜单下载的 catch 被删（静默 reject）
  check('c20 菜单下载没有 catch', downloadButtonInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '    void downloadMusicAsync(info.musicInfo).catch((err: any) => {',
      '    void downloadMusicAsync(info.musicInfo)\n    if (false) {'),
  }),
  '没有 catch')

  // c21 扫描并下载没有入口日志
  check('c21 批量下载没入口日志', downloadButtonInvariants({
    ...REAL,
    page: tamper(REAL.page, "    webDAVLog.info('handleBatchDownload: invoked', { hasConfig })", '    void 0'),
  }),
  '没有入口日志')

  // c22 扫描并下载按下没有即时反馈
  check('c22 批量下载无即时反馈', downloadButtonInvariants({
    ...REAL,
    page: tamper(REAL.page, "    setScanText('准备扫描并下载…')", '    void 0'),
  }),
  '没有即时可见反馈')

  // c23 handleWebDAVDownload 入口日志挪到取文件名之后
  check('c23 入口日志挪到准备之后', downloadButtonInvariants({
    ...REAL,
    action: tamper(REAL.action,
      "  webDAVLog.info('handleWebDAVDownload: invoked', { musicId: musicInfo?.id, fileName: musicInfo?.meta?.fileName })",
      '  void musicInfo'),
  }),
  '入口日志没提到函数第一行')

  // c24 handleWebDAVDownload 准备阶段抛错没人接
  check('c24 准备阶段没有兜底', downloadButtonInvariants({
    ...REAL,
    action: tamper(REAL.action, "    webDAVLog.error('handleWebDAVDownload: prepare failed', { message, error })", '    void message'),
  }),
  '准备阶段抛错时没有落日志')

  // c25 半截文件不再先删（锚点带上 `const exists = ...` 那一行：
  //     批量函数里同样有 `if (fileState === 'incomplete') {`，纯 2 空格锚点会命中前面那处）
  check('c25 半截文件不先删', downloadButtonInvariants({
    ...REAL,
    action: tamper(REAL.action,
      "  const exists = fileState === 'complete'\n  if (fileState === 'incomplete') {",
      "  const exists = fileState === 'complete'\n  if (false) {"),
  }),
  '半截文件')

  // ---- 第 34 轮第 3 条：末尾抽动 + 封面全量加载 ----

  // n34a length 退回卡片高（少算 marginBottom）
  check('n34a getItemLayout 的 length 退回 ITEM_HEIGHT', round34ListInvariants({
    ...REAL,
    page: tamper(REAL.page, '          length: ITEM_ROW_HEIGHT,', '          length: ITEM_HEIGHT,'),
  }),
  'length 不是实测行高')

  // n34b offset 与 length 不同源（滚动偏移整体偏小）
  check('n34b offset 仍按卡片高累计', round34ListInvariants({
    ...REAL,
    page: tamper(REAL.page,
      'offset: ITEM_ROW_HEIGHT * Math.floor(index / numColumns),',
      'offset: ITEM_HEIGHT * Math.floor(index / numColumns),'),
  }),
  'offset 不是按实测行高逐行累计')

  // n34c 行高常量少加一个行距
  check('n34c 行高常量少加 marginBottom', round34ListInvariants({
    ...REAL,
    page: tamper(REAL.page,
      'const ITEM_ROW_HEIGHT = ITEM_HEIGHT + designSpacing.sm',
      'const ITEM_ROW_HEIGHT = ITEM_HEIGHT'),
  }),
  '行高常量不是')

  // n34d 行距令牌归零（公式还在、数值退化，契约变成空转）
  check('n34d designSpacing.sm 归零', round34ListInvariants({
    ...REAL,
    tokens: tamper(REAL.tokens, '  sm: 12,', '  sm: 0,'),
  }),
  '契约变成空转')

  // n34e 分批退回 Promise.all（一个卡住拖死后面全部）
  check('n34e 批次退回 Promise.all', round34ListInvariants({
    ...REAL,
    page: tamper(REAL.page, '        await Promise.allSettled(tasks)', '        await Promise.all(tasks)'),
  }),
  'allSettled')

  // n34f 超时挪到 runWithLimit 外面（槽位照样被永不 settle 的任务占死）
  // 【第 39 轮第 2 条】入队调用多了一个 isPriority 实参，锚点只取「任务本体那三行」——
  // 替完之后的余下实参（插队标记）在静态检查里没有意义，语义仍是「超时跑到队外」。
  check('n34f 超时挪到入队之外', round34ListInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl,
      '  const task = runWithLimit(\n    async() =>\n      withCoverTimeout(',
      '  const task = withCoverTimeout(runWithLimit(async() => '),
  }),
  '没包在 runWithLimit 的任务内部')

  // n34g 超时往上抛（不再落地成空串）
  check('n34g 超时往上抛', round34ListInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl,
      "    const timer = setTimeout(() => {\n      if (settled) return\n      settled = true\n      resolve('')",
      "    const timer = setTimeout(() => {\n      if (settled) return\n      settled = true\n      throw new Error('cover timeout')"),
  }),
  '不许把失败往上抛')

  // n34h 成功路径不清定时器
  check('n34h 成功路径不清定时器', round34ListInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl,
      '    p.then(\n      (value) => {\n        if (settled) return\n        settled = true\n        clearTimeout(timer)',
      '    p.then(\n      (value) => {\n        if (settled) return\n        settled = true'),
  }),
  '条路径上清定时器')

  // n34i 超时常量归零（setTimeout(…, 0) → 每张封面都立刻判成没封面）
  check('n34i 超时常量归零', round34ListInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl, 'const COVER_FETCH_TIMEOUT_MS = 15000', 'const COVER_FETCH_TIMEOUT_MS = 0'),
  }),
  '不在合理区间')

  // n34j 超时常量整行删掉
  check('n34j 没有超时常量', round34ListInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl, 'const COVER_FETCH_TIMEOUT_MS = 15000\n\n', ''),
  }),
  '没有单张封面的获取超时')

  // ---- 第 36 轮第 4 条：行高数值必须留在行内 style ----

  // n36c 行高数值又放回 createStyle（二次 scaleSizeH，渲染值 ≠ 回报值，末尾照旧跳）
  check('n36c 行高放回 createStyle', round34ListInvariants({
    ...REAL,
    page: tamper(REAL.page, '  songItem: {\n',
      '  songItem: {\n    height: ITEM_HEIGHT,\n    marginBottom: designSpacing.sm,\n'),
  }),
  'createStyle 的 songItem 里又出现')

  // n36d 行内 style 丢掉 height（实渲行高与 getItemLayout 回报值不同源）
  check('n36d 行内丢掉 height', round34ListInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '          height: ITEM_HEIGHT,\n          marginBottom: designSpacing.sm,\n', ''),
  }),
  '行内 style 没有带 height')

  // ---- 第 39 轮第 2 条：取封面插队通道 ----

  // p1 出队退回单队列 FIFO（两条队列形同虚设）
  check('p1 出队不再插队优先', priorityLaneInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl, 'priorityTaskQueue.shift() ?? taskQueue.shift()', 'taskQueue.shift()'),
  }),
  '插队队列优先')

  // p2 入队不再按标记分流（插队任务照样落进常规队尾）
  check('p2 入队不分流', priorityLaneInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl, '(isPriority ? priorityTaskQueue : taskQueue).push(execute)', 'taskQueue.push(execute)'),
  }),
  '按标记分流')

  // p3 整表巡检不插队（换目录后再扫描，新歌单排在旧歌单几百个任务后面 —— 用户第 39 轮第 2 条原症状）
  check('p3 整表巡检不插队', priorityLaneInvariants({
    ...REAL,
    page: tamper(REAL.page, 'fetchCoverForSong(song, isRefresh, true)', 'fetchCoverForSong(song, isRefresh)'),
  }),
  '整表巡检没有走插队通道')

  // p4 可视列表巡检不插队（屏幕上这几十首仍排在旧歌单后面）
  check('p4 可视巡检不插队', priorityLaneInvariants({
    ...REAL,
    page: tamper(REAL.page, 'void fetchCoverForSong(song, false, true)', 'void fetchCoverForSong(song, false)'),
  }),
  '可视列表巡检没有走插队通道')

  // p5 单曲补图不插队（对着这一首点的「从在线获取封面」还要排旧歌单的队）
  check('p5 单曲补图不插队', priorityLaneInvariants({
    ...REAL,
    action: tamper(REAL.action, 'fetchCoverUrl(target, { isRefresh: true, highPriority: true })', 'fetchCoverUrl(target, { isRefresh: true })'),
  }),
  '单曲补图没有走插队通道')

  // p6 并发上限被放大来「变快」（插队只该改顺序；槽位口径是第 34 轮两层闸之一）
  check('p6 并发上限被改', priorityLaneInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl, 'const MAX_CONCURRENT = 4', 'const MAX_CONCURRENT = 12'),
  }),
  '并发上限不再是 4')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-webdav-cover-watch ===')
console.log('WebDAV：封面时刻关注（整表分批巡检 + 失效本地封面重补 + 每轮清备忘 + 刷新复核最新 + 行内 onError 自愈）')
console.log('        下载按钮按了有反应（响应式 hasConfig + 不被 disabled 吞 + 失败必有日志与提示）（第 29 轮）')
console.log('        末尾抽动（getItemLayout 与 songItem 几何同源）+ 封面全量加载（入队任务内部超时 + 批次 allSettled）（第 34 轮第 3 条）')
console.log('        末尾抽动（行高数值写在行内 style，渲染值 == 回报值）+ 行内自愈带冷却持久重试（第 36 轮第 3/4 条）')
console.log('        取封面插队通道（两条队列出队插队优先；WebDAV 整表巡检 / 可视巡检 / 单曲补图全走插队）（第 39 轮第 2 条）')
console.log()

const checks = [
  ['条一①-④ 巡检整表分批 / file:// 探活与重补 / 每轮清备忘与已试 id / 刷新带 isRefresh（coverUrl.ts + local.ts 同步）', () => coverWatchInvariants(REAL)],
  ['条一⑤ 行内 onError 自愈（一次性重试 + 清 picUrl + 单首重补，且不新增 fetchCoverUrl 直调点）', () => inlineHealInvariants(REAL)],
  ['条二 下载按钮按了有反应（响应式 hasConfig / 不再被 disabled 吞 / 入口日志与 catch / 半截文件先删）', () => downloadButtonInvariants(REAL)],
  ['第 34 轮第 3 条 末尾抽动（getItemLayout 的 length/offset 与 songItem 实测几何同源）+ 封面全量加载（入队任务内部 15s 超时落地成空串 + 批次 allSettled）', () => round34ListInvariants(REAL)],
  ['第 39 轮第 2 条 取封面插队通道（两条队列出队插队优先 / WebDAV 三条取封面路线全走插队 / 并发上限不变）', () => priorityLaneInvariants(REAL)],
]

let invOk = true
const passCount = []
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    passCount.push(name)
    console.log(`\n[${name}]\n  PASS`)
  } else {
    invOk = false
    console.log(`\n[${name}]`)
    ;[...new Set(reasons)].forEach((r) => console.log('  FAIL ' + r))
  }
}

console.log(`\n[数值模型·第 34 轮第 3 条] 单张封面超时 ${round34Numbers.timeoutMs}ms；行高错位：第 300 行累计少报 ${round34Numbers.drift300}pt（≈ ${Number(round34Numbers.rows300).toFixed(1)} 行）`)

console.log('\n[反例自检]')
const ceResults = runCounterExamples()
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.detail}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${passCount.length}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
