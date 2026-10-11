#!/usr/bin/env node
/**
 * sim-webdav-auto-cover-lyric.js —— WebDAV「扫描/刷新自动补在线封面」「播放自动补齐歌词」契约（第 27 轮）。
 *
 * 需求原话（2026-10-03 第 27 轮，附 WebDAV 列表截图：music 目录 325 首，扫描时间 2026/10/3 17:05:12，
 * 前 3 行有真封面、第 4 行起全是灰占位）：
 *   「WebDAV歌单，扫描和刷新还是不会加载在线封面，目前只有点击在线封面才能生成封面，
 *     改为自动补充在线封面，播放WebDAV的歌曲的歌词也要自动加载补齐。」
 *
 * 根因（第 25 轮只把「走得到在线匹配」补上了，但那条在线匹配本身在这里走不通）：
 *   core/music/local.ts 的 WebDAV 封面/歌词两条分支走的都是 utils.ts 里的
 *   getOnlineOtherSourcePicByLocal / getOnlineOtherSourceLyricByLocal，而这两个函数内部调的是
 *   apis('local')（src/utils/musicSdk/api-source.js）—— 只有用户加载了声明 local 源的自定义源脚本时
 *   global.lx.apis.local 才存在，否则 `Api is not found` 直接抛错（内置 apiList / api-source-info
 *   的 sources 都是空的）。于是：
 *     · 封面：抛错 → 落到 `if (isWebDAVMusic) return ''` → 列表永远灰占位；
 *     · 歌词：抛错 → 落到 `return buildLyricInfo({ lyric: '' })` → 播放时永远"无歌词"。
 *   而 ⋮ 菜单「从在线获取封面」是好的，因为那条路走的是 findMusic + 内置平台 getPic
 *   （WebDAVListAction.ts handleFetchWebDAVPicFromOnline）。本机没有编译/真机环境，
 *   「apis('local') 必抛错」这一点是读源码得出的结论、没有在 App 里跑过（已在改动清单里交代）。
 *
 * 本轮口径：
 *   条一（封面）
 *     ① core/music/local.ts getPicUrl 的 WebDAV 分支：自定义源那条走不通时，改用与普通本地音乐
 *        / ⋮ 菜单同一条链路 getOtherSourceByLocal（getOtherSource=findMusic 跨平台搜索 +
 *        内置平台 getPic，自带 歌名/歌手 互换、文件名拆分、模糊搜索多轮重试）；命中同样
 *        updateWebDAVMusicMeta + webdavPicUpdated 写回；onToggleSource 传空函数（不换源）。
 *     ② 顺带修掉一个短路 bug：原来 `return result.url` 是无条件的，自定义源匹配到歌却拿不到封面时
 *        返回空串也会 return，把兜底整条跳过 —— 现在空串继续往下走。
 *     ③ 列表页在「进列表 / 扫描完 / 扫描并下载 / 下拉刷新 / 播放后回填」这几处调用 prefetchCovers，
 *        按列表顺序预热前 MAX_PREFETCH_COVERS(=20) 首没封面的歌；三重收口：条数上限、
 *        已有 meta.picUrl 或内存缓存跳过、本会话已试过的 id 不重复补。
 *        请求仍走 core/music/coverUrl.ts 的同一份内存缓存 + MAX_CONCURRENT=4 全局队列，
 *        所以不会因为 325 首就打出 325 个在线匹配（第 25 轮删掉的批量 fetchWebDAVPic 不能回来）。
 *   条二（歌词）
 *     core/music/local.ts getLyricInfo 的 WebDAV 分支：同样用 getOtherSourceByLocal +
 *     getOnlineOtherSourceLyricInfo（内置平台 getLyric，existTimeExp 校验必须带时间轴）兜底，
 *     拿到后 saveLyric 落在 musicInfo.id 上（下次 getCachedLyricInfo 直接命中），
 *     全部失败才落回空歌词（不能直接抛，否则播放链路会炸）。
 *
 * 第 29 轮增量（需求原话：「WebDAV界面中，还是存在不自动加载在线封面的情况，要时刻关注
 * WebDAV列表，如果存在歌曲封面缺失或者未更新的情况，扫描或者打开列表时自动加载」
 *   + 「刷新列表后也要刷新封面是否最新或者缺失。」）：
 *   第 27 轮那套「预热前 20 首 + 本会话试过就不再补」的真实表现是：325 首里第 20 首往后
 *   永远靠行内 useCoverUrl，而它只要 meta.picUrl 非空就短路；一首歌在线匹配失败一次就被
 *   第 28 轮的失败备忘（webdavCoverSearchMisses）永久跳过。于是「封面缺失/未更新」永远补不上。
 *   本轮把列表页的预热升级成「整表巡检」，形状（不变量 C 新增 5 条）：
 *     · 巡检不再只看 meta.picUrl 空不空：picUrl 是 file:// 时校验封面文件还在不在
 *       （existsFile），文件被系统清掉就当「缺失」——失效封面作废内存缓存
 *       （invalidateCoverCache）、列表状态里清成空串（picUrl: '')，再走 fetchCoverUrl 重补；
 *     · 每轮巡检开始先 clearWebdavCoverMisses() 清掉跨轮的「搜过没结果」备忘，
 *       prefetchedCoverIds 也每轮清空，失败过的歌下一轮还会被补；
 *     · 整份列表都要走到：按 MAX_PREFETCH_COVERS 分批推进（`i += MAX_PREFETCH_COVERS`），
 *       不是只补前 20 首；
 *     · 下拉刷新 = 连「封面是不是最新的」都重查：forceCoverRefresh 置位后这批请求带
 *       isRefresh（coverUrl.ts 的 fetchCoverUrl(song, { isRefresh }) 会绕过内存缓存直查在线源）；
 *     · 行内兜底：Image 的 onError → handleCoverError 一次性自愈（作废缓存 + 清 picUrl +
 *       单首重补，同一 (id,url) 只重试一次，避免死图抖动刷请求）。
 *   请求量仍由 coverUrl.ts 的 4 并发全局队列 + local.ts 的 2 并发搜索闸 + 分批收口。
 *
 * 第 31 轮增量（需求原话：「WebDAV 还是存在不自动加载在线封面的情况，需要强化这个功能，
 * 点击扫描或者下滑刷新都会刷新该列表下所有歌曲的在线封面，**进入 WebDAV 歌单界面也是会
 * 刷新该列表下所有歌曲的在线封面**，请强化」）：
 *   · 进列表并入强制刷新：loadConfig（挂载 effect + 每次切页的导航 effect 都走它）也置位
 *     forceCoverRefresh —— 第 30 轮只把「扫描 / 下拉」接上了 force，进列表那一轮仍是
 *     isRefresh=false，内存里已有封面结果的歌被 getCachedCoverUrl 挡掉，「进来还是灰占位」；
 *   · 行内自愈改为加法式：单首重补不再调 prefetchCovers([target])（那是整轮巡检入口：
 *     clear 已试名单 + 清空全部失败备忘 + 轮次 +1，会把**正在飞的那一轮**判成过期整体中止，
 *     一首歌的行内失败就能掐死后面所有歌的补全），改走 WebDAVListAction.refreshWebdavCover
 *     （只作废这一首的内存缓存与失败备忘单曲版 clearWebdavCoverMiss、单取一次）。
 *   新增断言：loadConfig 三个形状、页面不许出现 prefetchCovers([...])、必须调用
 *   refreshWebdavCover；新增反例 c23–c25。
 *
 * 第 36 轮增量（需求原话：「加载在线封面应该持续刷新，直到刷新出来为止，目前存在越到后面的歌，
 * 封面越刷不出来的情况，然后不论是刷新、扫描、还是重新进入列表都不会再刷了，请修复这个问题，
 * 保证封面可以 100% 可以刷出」）：
 *   · 巡检「不会停」：① 删掉整轮作废标记（coverSweepToken）—— 它对在飞的那一轮是整轮掐死，
 *     而新的一轮又从表头重来，每次进列表/刷新/扫描都把进度清零，靠后的歌永远排不到；
 *     结果落地按 song.id 写回（setSongs 的 map 对不在列表的 id 天然空操作）。
 *     ② 一轮跑完还有没拿到封面的歌就自己安排续巡（15s / 5min 两档，按 isWebdavCoverKnownMiss
 *     区分「可能救得回来」与「确凿没结果」），不拿到就不停手。
 *   · 名额不再泄漏：getOtherSourceByLocal → findMusic 走 SDK 的 HTTP、SDK 内部没有超时，
 *     一首卡住就永不 settle，finally 里的 releaseWebdavCoverSearch() 永不执行 ——
 *     2 个名额漏光后模块级闸门再也不放行任何请求（「之后怎么刷都刷不出来」的真正成因）。
 *     现在整段搜索套 WEBDAV_COVER_SEARCH_TIMEOUT_MS（12s，短于 coverUrl.ts 的 15s 外层超时），
 *     并且只把「确凿跑完、没有任何候选给出封面」（err.message === 'source not found'）记进失败备忘；
 *     超时 / 异常算「这次没搜成」，留给续巡重试。
 *   本脚本新增不变量 E 与反例 f1–f10 钉住以上全部形状（含「注释锚点会漂移」这一坑：
 *   stripComments 会把整行 `//` 抹成空行，续巡分支的切片改用 sweep 之前最近的 `} else {`）。
 *
 * 第 42 轮第 2 条增量（需求原话：「发热严重，电量消耗快，减少发热量，减少电量消耗，特别是减少
 * 后台运行占用，优化整体代码，去除冗余代码无用代码」）：
 *   · 续巡是本页唯一「永久自我重排」的循环，而本页是惰性常驻页、退后台不卸载 —— iOS 上音频在
 *     后台播放时 JS 不被冻结，于是整夜都在「定时器到点 → 联网搜封面 → 解码图片 → 写 setState」。
 *     本轮给它上前后台门：退后台连已排的那一发也收掉（不只是不排新的），名单留在
 *     coverFollowupSongs 里；回前台取走名单立刻按 auto 模式补一发。后台一遍封面网络巡都不跑，
 *     前台的「持续刷新直到刷出来」照旧（不变量 F + 反例 g1–g4 钉住）。
 *   · 无进展退避：连续几轮「续巡过但失败名单没缩短」就按 2 倍退避（15s → 30s → …）封顶到
 *     长周期 5 分钟；用户触发的整轮巡检把退避计数清零（新一轮从头来）。原来「长短两档固定值」
 *     的三元表达式被这套退避取代 —— 同一个判据（两档 + 不许空转）的新形状，不变量 E 的锚点
 *     随之更新。
 *
 * 为什么必须靠契约脚本：这几条全是「形状 / 顺序 / 上限」而非类型 —— 把无条件 return 放回去、
 * 把兜底删掉、把 onToggleSource 换成真的换源、把空串 return 提到兜底之前、把上限改成整表、
 * 把去重删掉、把 fallback 挪到空歌词之后，或者把第 29 轮的 file:// 校验 / 失败备忘清空 /
 * 分批推进删掉，tsc/eslint 全是绿的，只在真机上表现为
 * 「扫完还是灰占位 / 播到某首还是无歌词 / 扫一次发几百个请求 / 封面挂了就再也回不来」。
 * 带反例自检（c1–c25 与 f1–f10、g1–g4）。
 *
 * 运行：node scripts/sim-webdav-auto-cover-lyric.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去块注释与整行 `//` 注释。不能用 src.replace(/\/\/[^\n]*/g, '')：
// 本文件要看的两处都含 `file://${picPath}` 这类字符串字面量，会被那条朴素规则从中间切断。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  page: 'src/screens/Home/Views/WebDAV/index.tsx',
  local: 'src/core/music/local.ts',
  coverUrl: 'src/core/music/coverUrl.ts',
  utils: 'src/core/music/utils.ts',
  apiSource: 'src/utils/musicSdk/api-source.js',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

const countOf = (haystack, needle) => haystack.split(needle).length - 1

// 取 from 之后、下一个 to 之前的片段（锚点漂移返回 null，由调用方报 FAIL）
const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  const end = src.indexOf(to, start + from.length)
  if (end <= start) return null
  return src.slice(start, end)
}

// ---------------------------------------------------------------------------
// 切片工具（锚点漂移必须报 FAIL，不能静默放行）
// ---------------------------------------------------------------------------

// getPicUrl 的整个 WebDAV 分支：它自己的 isWebDAVMusic 标记 → 下一个顶层函数。
// local.ts 里 `const isWebDAVMusic = 'webdav' in musicInfo.meta` 出现两次（getPicUrl / getLyricInfo），
// indexOf 取到的是前者；末尾用 `const getMusicFileLyric =` 做边界。
const webdavPicBranch = (rawLocal) => {
  const start = rawLocal.indexOf("const isWebDAVMusic = 'webdav' in musicInfo.meta")
  const end = rawLocal.indexOf('const getMusicFileLyric = async(filePath: string) => {')
  if (start < 0 || end <= start) return null
  return rawLocal.slice(start, end)
}

// 再往里切一层：只留 WebDAV 那一段，把后面「普通本地音乐走自定义源换源回退」那段切掉
// （否则 `getOtherSourceByLocal` / `getOnlineOtherSourcePicUrl` 这些字眼在普通本地分支里本来就有，
//  会让「WebDAV 有没有兜底」这个判断假通过）。
const webdavPicOnly = (rawLocal) => {
  const branch = webdavPicBranch(rawLocal)
  if (!branch) return null
  const cut = branch.indexOf('\n  onToggleSource()\n')
  if (cut < 0) return null
  return branch.slice(0, cut)
}

// getLyricInfo 的 WebDAV 分支：第二处 isWebDAVMusic 标记 → 该 if 块结束后"普通本地音乐"那段起点。
// 末尾锚点必须带换行 + 正好 4 个空格：local.ts 里 `const playerLyricInfo = await getPlayerLyric(musicInfo)`
// 出现两次，WebDAV 分支里那次是 6 空格缩进，前面的裸 4 空格写法会命中 6 空格那一行（前缀匹配），
// 切片就缩成 4 行，导致整组判断假失败。
const webdavLyricBranch = (rawLocal) => {
  const first = rawLocal.indexOf("const isWebDAVMusic = 'webdav' in musicInfo.meta")
  const start = rawLocal.indexOf("const isWebDAVMusic = 'webdav' in musicInfo.meta", first + 1)
  const end = rawLocal.indexOf('\n    const playerLyricInfo = await getPlayerLyric(musicInfo)')
  if (start < 0 || first < 0 || end <= start) return null
  return rawLocal.slice(start, end)
}

// 列表页 prefetchCovers 的实现体：`const prefetchedCoverIds = useRef(` → `const loadConfig = useCallback(`
const prefetchBody = (rawPage) => {
  const start = rawPage.indexOf('const prefetchedCoverIds = useRef(')
  const end = rawPage.indexOf('const loadConfig = useCallback(')
  if (start < 0 || end <= start) return null
  return rawPage.slice(start, end)
}

// ---------------------------------------------------------------------------
// 不变量 A（条一）：WebDAV 封面兜底 + 空串不再短路 + 结果写回
// ---------------------------------------------------------------------------

const webdavCoverFallbackInvariants = (rawLocal) => {
  const reasons = []
  const code = stripComments(rawLocal)
  const branch = webdavPicOnly(code)
  if (!branch) {
    reasons.push('getPicUrl 的 WebDAV 分支切片失败（锚点漂移：isWebDAVMusic 标记 / onToggleSource() 行）')
    return reasons
  }

  // ① 自定义源那条路还在（第 25 轮的能力不能回退）
  if (!branch.includes('getOnlineOtherSourcePicByLocal(')) {
    reasons.push('WebDAV 封面分支里没有 getOnlineOtherSourcePicByLocal（第 25 轮的在线匹配被删了）')
  }

  // ② 空串不再无条件短路 —— 这是「扫描/刷新补不上封面」的第二个坑
  if (!branch.includes('if (result.url) return result.url')) {
    reasons.push('自定义源匹配结果没有按「非空才 return」处理（空串会提前 return，下面的兜底整条被跳过）')
  }
  if (/\n\s*return result\.url/.test(branch)) {
    reasons.push('WebDAV 分支里还有无条件 `return result.url`（空封面会短路掉搜索兜底）')
  }

  // ③ 搜索兜底必须存在，且走的是与 ⋮ 菜单 / 普通本地音乐同一个 helper
  const fallbackAt = branch.indexOf('getOtherSourceByLocal(')
  if (fallbackAt < 0) {
    reasons.push('WebDAV 封面缺少 getOtherSourceByLocal 搜索兜底（apis(\'local\') 没有自定义源时必抛错，只有这条路能用）')
  }
  if (!branch.includes('getOnlineOtherSourcePicUrl(')) {
    reasons.push('WebDAV 封面兜底没有用内置平台的 getOnlineOtherSourcePicUrl（map 不到平台 getPic）')
  }
  if (branch.includes('apis(')) {
    reasons.push('WebDAV 封面分支里又直接调了 apis(...)（就是它抛 Api is not found 的）')
  }

  // ④ 兜底不许换源
  if (!/getOnlineOtherSourcePicUrl\(\{[\s\S]{0,200}?onToggleSource:\s*\(\)\s*=>\s*\{\}/.test(branch)) {
    reasons.push('兜底传给 getOnlineOtherSourcePicUrl 的 onToggleSource 不是空函数（WebDAV 歌曲会被换源）')
  }

  // ⑤ 兜底命中要写回 meta + 广播（= 第 25 轮的「存入缓存」，列表行 / 试听列表同源）
  if (!branch.includes('updateWebDAVMusicMeta(musicInfo.id, { picUrl: matchedUrl })')) {
    reasons.push('搜索兜底匹配到的封面没有写回 updateWebDAVMusicMeta(id, { picUrl })（下次进列表还得重发、试听列表也没封面）')
  }
  if (!branch.includes('appEvent.webdavPicUpdated(musicInfo.id, matchedUrl)')) {
    reasons.push('搜索兜底匹配到的封面没有广播 webdavPicUpdated（已渲染的行不会立刻换图）')
  }

  // ⑥ 收口顺序：兜底 → 空返回。空返回必须只有一处、且在兜底之后
  const emptyAt = branch.indexOf("return ''")
  if (emptyAt < 0) {
    reasons.push('WebDAV 封面分支缺少最后那句空返回（没匹配到封面时会往下掉进普通本地分支）')
  } else {
    if (countOf(branch, "return ''") > 1) {
      reasons.push('WebDAV 封面分支里出现多处 return \'\'（可能有提前收口把兜底跳过了）')
    }
    if (fallbackAt >= 0 && emptyAt < fallbackAt) {
      reasons.push('空返回排在搜索兜底之前（兜底够不着，等于没补）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B（条二）：WebDAV 歌词兜底 + 缓存落盘 + 空歌词仍是最后收口
// ---------------------------------------------------------------------------

const webdavLyricFallbackInvariants = (rawLocal) => {
  const reasons = []
  const code = stripComments(rawLocal)
  const branch = webdavLyricBranch(code)
  if (!branch) {
    reasons.push('getLyricInfo 的 WebDAV 分支切片失败（锚点漂移：第二处 isWebDAVMusic / playerLyricInfo）')
    return reasons
  }

  if (!branch.includes('getOnlineOtherSourceLyricByLocal(')) {
    reasons.push('WebDAV 歌词分支里没有 getOnlineOtherSourceLyricByLocal（第 25 轮的在线匹配被删了）')
  }

  const fallbackAt = branch.indexOf('getOtherSourceByLocal(')
  if (fallbackAt < 0) {
    reasons.push('WebDAV 歌词缺少 getOtherSourceByLocal 搜索兜底（apis(\'local\') 没有自定义源时必抛错，只有这条路能用）')
  }
  if (!branch.includes('getOnlineOtherSourceLyricInfo(')) {
    reasons.push('WebDAV 歌词兜底没有用内置平台的 getOnlineOtherSourceLyricInfo')
  }
  if (branch.includes('apis(')) {
    reasons.push('WebDAV 歌词分支里又直接调了 apis(...)（就是它抛 Api is not found 的）')
  }
  if (!/getOnlineOtherSourceLyricInfo\(\{[\s\S]{0,200}?onToggleSource:\s*\(\)\s*=>\s*\{\}/.test(branch)) {
    reasons.push('兜底传给 getOnlineOtherSourceLyricInfo 的 onToggleSource 不是空函数（WebDAV 歌曲会被换源）')
  }
  if (!branch.includes('saveLyric(musicInfo, matchedLyric)')) {
    reasons.push('搜索兜底拿到的歌词没有 saveLyric(musicInfo, …)（换一首再播 / 进试听列表还得重搜）')
  }
  if (!branch.includes('if (!isFromCache) void saveLyric(')) {
    reasons.push('兜底没有按 isFromCache 决定是否落盘（命中缓存时会白写一次）')
  }

  const emptyAt = branch.indexOf("return buildLyricInfo({ lyric: '' })")
  if (emptyAt < 0) {
    reasons.push('WebDAV 歌词分支缺少最后的空歌词收口（全部匹配失败时会抛错，播放链路直接炸）')
  } else if (fallbackAt >= 0 && emptyAt < fallbackAt) {
    reasons.push('空歌词排在搜索兜底之前（播放时永远"无歌词"，兜底够不着）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C（条一③）：列表页预热有界 + 去重 + 仍走 coverUrl.ts 的缓存/队列
// ---------------------------------------------------------------------------

const prefetchInvariants = (rawPage) => {
  const reasons = []
  const code = stripComments(rawPage)
  const body = prefetchBody(code)
  if (!body) {
    reasons.push('prefetchCovers 实现体切片失败（锚点漂移：prefetchedCoverIds / loadConfig）')
    return reasons
  }

  const boundMatch = /const MAX_PREFETCH_COVERS = (\d+)/.exec(code)
  if (!boundMatch) {
    reasons.push('缺少 MAX_PREFETCH_COVERS 常量（预热没有条数上限）')
  } else {
    const n = Number(boundMatch[1])
    if (!(n > 0 && n <= 50)) {
      reasons.push(`MAX_PREFETCH_COVERS=${n} 不在 (0, 50] 内（扫描 325 首时会变成一次批量请求风暴）`)
    }
  }
  // 【第 36 轮第 3 条】批大小必须就是 MAX_PREFETCH_COVERS：第 27 轮的 `started >= MAX_PREFETCH_COVERS`
  // 计数上限（只补前 20 首）已经删掉 —— 现在的口径是「整表都要走到，靠分批 + 并发闸收口」，
  // 所以这里改钉「一批切多少」（切整段 = 一次把 queue 全发出去，扫描 325 首就是请求风暴）。
  if (!body.includes('queue.slice(i, i + MAX_PREFETCH_COVERS)')) {
    reasons.push('巡检的批大小不是 MAX_PREFETCH_COVERS（一次把整份曲库发出去会打成请求风暴；或分批写法被改得不是「每批 20 首」）')
  }
  if (!body.includes('if (prefetchedCoverIds.current.has(song.id)) continue')) {
    reasons.push('预热没有按 song.id 去重（扫描/刷新/进列表来回切会重复补同一首）')
  }
  if (!body.includes('prefetchedCoverIds.current.add(song.id)')) {
    reasons.push('预热没有把试过的 song.id 记下来（失败的首歌每次进列表都会重搜一遍）')
  }
  // 【第 29 轮】「有 meta.picUrl 就跳过」改成「先校验本地封面文件还在不在」：
  // file:// 封面文件会被系统清理，留着那个 picUrl 反而让行内 useCoverUrl 短路成空占位。
  if (!body.includes('if (song.meta.picUrl) {')) {
    reasons.push('巡检没有对「已有 meta.picUrl」做分支（本地封面文件失效时会被当成有封面，行内 useCoverUrl 还会短路）')
  } else {
    if (!body.includes('existsFile(')) {
      reasons.push('巡检没有校验 file:// 封面文件是否还在（被系统清掉后列表永远空占位）')
    }
    if (!body.includes('invalidateCoverCache(song)')) {
      reasons.push('失效的本地封面没有作废内存缓存（行内会继续拿到那张已经不存在的图）')
    }
    if (!body.includes("picUrl: ''")) {
      reasons.push('失效的本地封面没有从列表状态里清掉（行内 useCoverUrl 仍会因为 picUrl 非空而短路）')
    }
  }
  // 【第 30 轮】跳过内存缓存只在「非刷新」时成立：下拉刷新与点「扫描」都是 isRefresh，
  // 那时**不能**被内存缓存挡住，否则用户点一次扫描也复核不到「封面是否最新」（见下面的
  // fetchCoverUrl(song, { isRefresh }) 断言）。
  if (!body.includes('if (!isRefresh && getCachedCoverUrl(song)) continue')) {
    reasons.push('预热没有跳过内存缓存里已有封面的歌（同一首歌重复发在线匹配），或刷新时也被缓存挡住（复核不到封面是否最新）')
  }
  if (!body.includes('fetchCoverUrl(song,')) {
    reasons.push('预热没有走 coverUrl.ts 的 fetchCoverUrl（会被绕开 4 并发全局队列与内存缓存）')
  }
  // 【第 29 轮】整份列表都要巡检到（第 27 轮只补前 20 首，滚下去的歌全靠行内），
  // 分批发而不是一次全量：批大小就是 MAX_PREFETCH_COVERS。
  if (!body.includes('i += MAX_PREFETCH_COVERS')) {
    reasons.push('巡检没有按 MAX_PREFETCH_COVERS 分批推进整份列表（第 27 轮的「只补前 20 首」漏掉了后面的歌）')
  }
  // 【第 29 轮】失败备忘必须每轮清空，否则一首歌失败一次就再也不会被补上
  if (!body.includes('clearWebdavCoverMisses()')) {
    reasons.push('每轮巡检没有清空「搜过没结果」的失败备忘（封面缺失的歌不会再被自动补）')
  }
  if (/\bgetPicPath\s*\(/.test(body)) {
    reasons.push('预热直接调了 getPicPath（绕开 coverUrl.ts 的缓存/在飞去重/并发上限）')
  }

  // 预热只该出现在这几个回调里（loadConfig / 扫描 / 扫描并下载 / 下拉刷新 / 播放后回填），
  // 不能在渲染路径上无界地跑：整页 fetchCoverUrl 出现次数必须是 1（= 预热那一次）。
  const fetchCoverCount = countOf(code, 'fetchCoverUrl(')
  if (fetchCoverCount !== 1) {
    reasons.push(`页面里 fetchCoverUrl( 出现 ${fetchCoverCount} 次（应当只有预热那一处，多出来的多半是渲染路径上的逐首直调）`)
  }
  for (const anchor of [
    'prefetchCovers(songs)',
    'prefetchCovers(config.songs ?? [])',
    'prefetchCovers(scannedSongs)',
    'prefetchCovers(updatedSongs)',
  ]) {
    if (!code.includes(anchor)) {
      reasons.push(`缺少预热调用点 ${anchor}（进列表 / 下拉刷新 / 扫描 / 播放回填 里少了一处）`)
    }
  }
  // 第 29 轮曾把行内 onError 自愈也算一个调用点（handleCoverError → prefetchCovers([target])），下限提到 6。
  // 【第 31 轮】自愈不再借道 prefetchCovers，改走 WebDAVListAction.refreshWebdavCover（加法式
  // 单曲补齐，见 sim-webdav-cover-watch.js 不变量⑤）：prefetchCovers 一进来就清已试名单 +
  // 清空全部失败备忘 + 轮次 +1，而行内失败发生在**巡检推进过程中**，这一下会把正在飞的那一轮
  // 判成「上一轮过期」整体中止 —— 一首歌的行内失败就能掐死后面所有歌的封面补全。所以：
  //   ① 计数下限回到 5：进列表 / 扫描 / 扫描并下载 / 下拉刷新 / 播放回填（实现体那一处仍计入）；
  //   ② 页面里不许再出现单首形式的 prefetchCovers([...])；
  //   ③ 页面必须走 refreshWebdavCover（行内封面挂了得有人补）。
  // 【第 36 轮第 3 条】下限从 5 提到 6：多出来的一处是巡检自己的续巡入口
  // `prefetchCovers(failed, { auto: true })` —— 它就是「持续刷新，直到刷出来为止」的落点，
  // 少一处都说明某条入口断了（定义那一处是 `const prefetchCovers = useCallback(`，不含 `(`，不计入）。
  // 【第 42 轮第 2 条】下限再提到 7：回前台的补账入口 `prefetchCovers(pending, { auto: true })`
  // —— 退后台把已排期的续巡收掉了，这一处就是「回前台立刻补一发」的落点；删了它后台那道门
  // 就变成「一退后台就永久停」。
  if (countOf(code, 'prefetchCovers(') < 7) {
    reasons.push(`预热调用点不足：prefetchCovers( 只有 ${countOf(code, 'prefetchCovers(')} 处（进列表/扫描/扫描并下载/刷新/播放回填 + 续巡 + 回前台补发 共 7 处）`)
  }
  if (code.includes('prefetchCovers([')) {
    reasons.push('页面里又出现单首形式的 prefetchCovers([...])（行内自愈不许再借整轮巡检入口：会打断在飞的那一轮）')
  }
  if (!code.includes('refreshWebdavCover(')) {
    reasons.push('页面没有走单曲自愈 helper refreshWebdavCover（行内封面加载失败后没人补）')
  }

  // 【第 31 轮·图一】进列表（loadConfig：挂载 effect + 每次切页的导航 effect 都走它）并入强制
  // 刷新，否则内存里已有封面结果的歌会被上面的 getCachedCoverUrl 挡掉 —— 用户的「进入 WebDAV
  // 歌单界面也是会刷新该列表下所有歌曲的在线封面」就落空。切片到 loadConfig 本体再断言。
  const loadStart = code.indexOf('const loadConfig = useCallback(')
  const loadEnd = code.indexOf('}, [prefetchCovers])', loadStart)
  if (loadStart < 0 || loadEnd <= loadStart) {
    reasons.push('loadConfig 切片失败（锚点漂移：loadConfig / deps）')
  } else {
    const loadBody = code.slice(loadStart, loadEnd)
    if (!loadBody.includes('forceCoverRefresh.current = true')) {
      reasons.push('进列表没有置位 forceCoverRefresh（进入 WebDAV 歌单界面时封面不复核最新/缺失）')
    }
    if (!loadBody.includes('prefetchCovers(songs)')) {
      reasons.push('loadConfig 没有起一轮封面巡检（进列表后不自动补封面）')
    }
  }

  // 第 25 轮删掉的整表批量下载不能回来，也不能再引 fetchWebDAVPic 做封面
  if (code.includes('fetchWebDAVPic')) {
    reasons.push('页面里又出现了 fetchWebDAVPic（第 25 轮已删除的整表批量下载）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 E（第 36 轮第 3 条）：巡检「不会停」（去掉整轮作废 + 跑完自续巡）
//   + 名额不再泄漏（搜索套超时 + 超时/异常不记失败备忘）
// ---------------------------------------------------------------------------

const followupSweepInvariants = (files) => {
  const reasons = []
  const page = stripComments(files.page)
  const localCode = stripComments(files.local)
  const coverCode = stripComments(files.coverUrl)

  // ① 整轮作废标记不许回来：它对在飞的那一轮是「整轮掐死」，而新的一轮又从表头重来 ——
  //    每次进列表 / 刷新 / 扫描都把进度清零，靠后的歌永远排不到（用户原话「越到后面的歌，
  //    封面越刷不出来」）。结果落地已改成按 song.id 写回（map 对不在列表的 id 天然空操作）。
  if (/\bcoverSweepToken\b/.test(page) || /\bsweepToken\b/.test(page)) {
    reasons.push('巡检又出现轮次作废标记 sweepToken / coverSweepToken（在飞的那一轮会被整轮掐死，而新一轮从表头重来 —— 靠后的歌永远排不到）')
  }

  const body = prefetchBody(page)
  if (!body) {
    reasons.push('prefetchCovers 实现体切片失败（锚点漂移：prefetchedCoverIds / loadConfig）')
    return reasons
  }

  // ② 跑完还有没拿到封面的歌 → 自己安排续巡（用户原话「持续刷新，直到刷新出来为止」）
  if (!body.includes('prefetchCovers(failed, { auto: true })')) {
    reasons.push('巡检跑完不安排续巡（失败 / 超时的歌没有第二次机会，用户不动手就永远停在灰占位）')
  }
  if (!body.includes('const hasRetryable = failed.some(song => !isWebdavCoverKnownMiss(song))')) {
    reasons.push('续巡没有按「确凿没结果 / 可能救得回来」分级（要么对查不到的歌无限空转，要么把暂时失败判死）')
  }
  // 【第 42 轮第 2 条】节奏从「两档固定值」升级成「两档 + 无进展退避」：短周期起步
  // （COVER_FOLLOWUP_SHORT_MS）→ 每轮没进展翻倍 → 封顶 COVER_FOLLOWUP_LONG_MS；
  // 确凿没结果的直接走长周期。判据还是同一个（长短两档 + 不许空转），只是形状换了，
  // 原三元表达式的锚点随之更新成下面四条。
  if (!body.includes('const backoff = Math.min(COVER_FOLLOWUP_SHORT_MS * Math.pow(2, round), COVER_FOLLOWUP_LONG_MS)')) {
    reasons.push('续巡没有「短周期起步 → 无进展翻倍 → 封顶长周期」的退避（几首永远拿不到封面的歌会把链路钉在最短周期上空转）')
  }
  if (!body.includes('const delay = hasRetryable ? backoff : COVER_FOLLOWUP_LONG_MS')) {
    reasons.push('续巡节奏没有按「确凿没结果 / 可能救得回来」分档（backoff 起点必须来自 COVER_FOLLOWUP_SHORT_MS，确凿没结果的走 COVER_FOLLOWUP_LONG_MS）')
  }
  if (!body.includes('coverFollowupRounds.current = round + 1')) {
    reasons.push('续巡退避轮数不推进（backoff 永远停在第 0 轮 = 短周期空转，退避形同虚设）')
  }
  if (!body.includes('if (failed.length < coverFollowupLastCount.current) coverFollowupRounds.current = 0')) {
    reasons.push('续巡名单在缩短也不回缩退避（救得回来的歌被一并拖在长间隔上）')
  }
  // ③ 续巡只重查没拿到的那批：先把这些 id 从已试名单里摘掉，否则上面那道 has() 去重
  //    会把这批整批跳过 —— 「再也不重试」换个地方原样复现。
  if (!body.includes('for (const song of list) prefetchedCoverIds.current.delete(song.id)')) {
    reasons.push('续巡没有把待重查的 id 从已试名单里摘掉（去重会把这批整批跳过 —— 「再也不重试」换个地方复现）')
  }
  // ④ 续巡不许清「搜过没结果」的备忘：那是确凿结论，也是长短两档节奏的判据。
  //    切片用「sweep 之前最近的那个 `} else {`」—— 不能锚注释（本脚本的 stripComments 会把
  //    整行 `//` 注释抹成空行，锚注释必然漂移）。
  const sweepAt = page.indexOf('const sweep = async()')
  const elseAt = sweepAt < 0 ? -1 : page.lastIndexOf('    } else {', sweepAt)
  if (sweepAt < 0 || elseAt < 0) {
    reasons.push('续巡分支切片失败（锚点漂移：} else { / const sweep）')
  } else {
    const autoBranch = page.slice(elseAt, sweepAt)
    if (autoBranch.includes('clearWebdavCoverMisses()')) {
      reasons.push('续巡把「搜过没结果」的备忘一起清了（确凿结论丢失：长短周期判据失效 + 搜索风暴回来）')
    }
    if (!autoBranch.includes('prefetchedCoverIds.current.delete(song.id)')) {
      reasons.push('续巡没有把待重查的 id 从已试名单里摘掉（去重会把这批整批跳过 —— 「再也不重试」换个地方复现）')
    }
  }
  // ⑤ 同一时刻只挂一个续巡定时器，停表只有一个收口（第 42 轮第 2 条把内联 clearTimeout 收成
  //    cancelCoverFollowup：新一轮巡检 / 卸载 / 退后台三处都走它）。判据仍是「真的停表」——
  //    收口本体必须 clearTimeout + 置空，新一轮巡检开头必须先调它并把旧名单清掉。
  if (!page.includes('  const cancelCoverFollowup = useCallback(() => {\n    if (coverFollowupTimer.current) {\n      clearTimeout(coverFollowupTimer.current)\n      coverFollowupTimer.current = null\n    }\n  }, [])')) {
    reasons.push('cancelCoverFollowup 不是「clearTimeout + 置空」的单一收口（停表能力被掏空：卸载/退后台拿到的可能是个空壳）')
  }
  const prefetchHead = slice(body, 'const isAuto = options?.auto === true', 'if (!isAuto) {')
  if (!prefetchHead) {
    reasons.push('prefetchCovers 开头切片失败（锚点漂移：isAuto / if (!isAuto) {）')
  } else {
    if (!prefetchHead.includes('cancelCoverFollowup()')) {
      reasons.push('新一轮巡检没有先清掉旧的续巡定时器（多个定时器叠着跑，越滚越多）')
    }
    if (!prefetchHead.includes('coverFollowupSongs.current = null')) {
      reasons.push('新一轮巡检没有清掉旧的续巡名单（旧名单跨轮串台：回前台会把一批已经作废的歌又补一遍）')
    }
  }
  const unmount = slice(page, '  useEffect(() => () => {\n    cancelCoverFollowup()', '  }, [cancelCoverFollowup])')
  if (!unmount) {
    reasons.push('页面卸载没有收续巡（离开 WebDAV 后定时器还在跑，回调落在已卸载的组件上）')
  } else if (!unmount.includes('coverFollowupSongs.current = null')) {
    reasons.push('页面卸载没有清掉续巡名单（下一次挂载之前的前后台切换会跑一份没人看的巡检）')
  }
  // ⑥ 常量有界：短周期是「秒级重试」、长周期是「确凿失败的兜底」，都不许退化成 0 / 无限大
  const shortMs = Number((/const COVER_FOLLOWUP_SHORT_MS = (\d+)/.exec(page) ?? [])[1])
  const longMs = Number((/const COVER_FOLLOWUP_LONG_MS = (\d+)/.exec(page) ?? [])[1])
  if (!(shortMs >= 3000 && shortMs <= 120000)) {
    reasons.push(`续巡短周期 ${shortMs}ms 不在 [3000, 120000]（太小变成请求风暴，太大等于不重试）`)
  }
  if (!(longMs >= shortMs && longMs <= 1800000)) {
    reasons.push(`续巡长周期 ${longMs}ms 不合理（必须 ≥ 短周期且 ≤ 30 分钟，否则确凿没结果的歌要么被无限空转要么被彻底放弃）`)
  }
  if (!page.includes("import { clearWebdavCoverMisses, isWebdavCoverKnownMiss } from '@/core/music/local'")) {
    reasons.push('列表页没有引 isWebdavCoverKnownMiss（续巡的节奏分级拿不到「确凿没结果」这个判据）')
  }
  if (!localCode.includes('export const isWebdavCoverKnownMiss = (musicInfo: LX.Music.MusicInfoLocal) =>')) {
    reasons.push('local.ts 没有导出 isWebdavCoverKnownMiss（续巡无从区分「确凿没结果」与「这次没搜成」）')
  }

  // ⑦ 名额泄漏的两道修（local.ts）：搜索套 12 秒上限 + 超时/异常不记失败备忘。
  //    病根：findMusic 走音源 SDK 的 HTTP、SDK 内部没有超时，一首卡住就永不 settle，
  //    finally 里的 release 永不执行；2 个名额漏光后模块级闸门再也不放行任何请求 ——
  //    之后**每一次**封面兜底都永远排在 acquireWebdavCoverSearch() 上，界面上就是
  //    「后面的歌封面全刷不出来，而且刷新、扫描、重新进列表都不再刷了」。
  const searchMs = Number((/const WEBDAV_COVER_SEARCH_TIMEOUT_MS = (\d+)/.exec(localCode) ?? [])[1])
  if (!Number.isFinite(searchMs) || searchMs <= 0) {
    reasons.push('local.ts 没有 WEBDAV_COVER_SEARCH_TIMEOUT_MS（卡死的搜索会永久占住并发名额 —— 两个名额漏光后全表封面永久停摆）')
  } else {
    const outerMs = Number((/const COVER_FETCH_TIMEOUT_MS = (\d+)/.exec(coverCode) ?? [])[1])
    if (Number.isFinite(outerMs) && searchMs >= outerMs) {
      reasons.push(`搜索上限 ${searchMs}ms 不短于外层封面超时 ${outerMs}ms（外层早把这一首放弃了，这边还占着名额干一份已经被丢弃的活）`)
    }
  }
  if (!localCode.includes('const withWebdavCoverSearchTimeout = (')) {
    reasons.push('local.ts 没有 withWebdavCoverSearchTimeout（搜索没有时长上限，名额会漏光）')
  } else {
    // 切片末尾锚「下一个顶层声明」：不能锚 `/**`（块注释已被 stripComments 抹掉）
    const helper = slice(localCode, 'const withWebdavCoverSearchTimeout = (', 'export const getOtherSourceByLocal = async <T>(')
    if (!helper) {
      reasons.push('withWebdavCoverSearchTimeout 切片失败（锚点漂移）')
    } else {
      const timeoutBranch = slice(helper, 'const timer = setTimeout(() => {', '}, WEBDAV_COVER_SEARCH_TIMEOUT_MS)')
      if (!timeoutBranch || !timeoutBranch.includes("resolve({ url: '', definitive: false })")) {
        reasons.push('搜索超时分支不按「这次没搜成」落地（超时要能放行名额、并把这次失败留给续巡重试）')
      } else if (/\bthrow\b|\breject\b/.test(timeoutBranch)) {
        reasons.push('搜索超时分支里出现 throw/reject（超时必须静默落地，名额才放得掉）')
      }
      if (countOf(helper, 'clearTimeout(timer)') < 2) {
        reasons.push(`withWebdavCoverSearchTimeout 只在 ${countOf(helper, 'clearTimeout(timer)')} 条路径上清定时器（成功 / 失败两条路径都要清）`)
      }
    }
  }
  const picBranch = webdavPicOnly(localCode)
  if (!picBranch) {
    reasons.push('getPicUrl 的 WebDAV 分支切片失败（锚点漂移：isWebDAVMusic 标记 / onToggleSource() 行）')
  } else {
    if (!picBranch.includes("err?.message === 'source not found'")) {
      reasons.push('「确凿没有结果」与「超时/异常」没有分开（一次网络抖动就把这首歌判死刑，续巡也不会再试）')
    }
    const markBranch = slice(picBranch, 'if (searchResult.definitive) {', '} finally {')
    if (!markBranch) {
      reasons.push('失败备忘的落地分支切片失败（锚点漂移：if (searchResult.definitive) / } finally）')
    } else {
      if (!markBranch.includes('markWebdavCoverMiss(musicInfo)')) {
        reasons.push('确凿没结果的歌没有记失败备忘（每次进列表都会为它重发整轮搜索）')
      }
      if (!markBranch.includes('webDAVLog?.warn(')) {
        reasons.push('非确凿失败没有落日志（「这次没搜成」为什么被重试，日志里查不到）')
      }
    }
    if (!picBranch.includes('} finally {\n        releaseWebdavCoverSearch()')) {
      reasons.push('并发名额不是在 finally 里放行的（任何一条提前 return / 抛错都会泄漏名额 —— 漏两个全表停摆）')
    }
    if (!picBranch.includes('await acquireWebdavCoverSearch()')) {
      reasons.push('封面兜底搜索不再进并发闸（几百行同时发搜索，第 28 轮的风暴回来）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 F（第 42 轮第 2 条）：封面续巡的前后台门（减后台耗电 / 减发热）
//   病根：本页是惰性常驻页、续巡只在「还有歌没拿到封面」时才排期、全程没有前后台判断 ——
//   iOS 上音频在后台播放时 JS 线程不被冻结，于是整夜都在「定时器到点 → 联网搜封面 →
//   解码图片 → 写 setState」（用户原话「发热严重，电量消耗快……减少后台运行占用」）。
//   口径：退后台把**已排期的那一发也收掉**（只拦新排期不够 —— 已排的那一发照样到点联网），
//        名单留在 coverFollowupSongs 里；回前台取走名单立刻按 auto 模式补发。
// ---------------------------------------------------------------------------

const followupPowerInvariants = (files) => {
  const reasons = []
  const page = stripComments(files.page)
  const body = prefetchBody(page)
  if (!body) {
    reasons.push('prefetchCovers 实现体切片失败（锚点漂移：prefetchedCoverIds / loadConfig）')
    return reasons
  }

  // ① 退后台不排期（本轮耗电主开关）。早退必须排在「名单落地」之后 ——
  //    否则名单没留，回前台补发无账可还，「持续刷新」被后台一收就永久停。
  const gateAt = body.indexOf("if (AppState.currentState !== 'active') return")
  const storeAt = body.indexOf('coverFollowupSongs.current = failed')
  if (gateAt < 0) {
    reasons.push('续巡排期没有前台闸门（iOS 后台播放音频时 JS 不被冻结：退后台仍每轮联网搜封面、解码图片、写 setState —— 整夜发热耗电）')
  } else if (storeAt < 0 || gateAt < storeAt) {
    reasons.push('退后台的早退排在续巡名单落地之前（名单没留，回前台补发无账可还 —— 「持续刷新」被后台一收就永久停）')
  }

  // ② 前后台门：退后台收已排期的那一发；回前台「取走名单 → 清名单 → 立刻补发」。
  const appGate = slice(page, "AppState.addEventListener('change', (next) => {", 'sub.remove()')
  if (!appGate) {
    reasons.push('封面续巡的前后台门切片失败（锚点漂移：AppState.addEventListener / sub.remove）')
  } else {
    if (!/if \(next !== 'active'\) \{[\s\S]{0,240}?cancelCoverFollowup\(\)/.test(appGate)) {
      reasons.push('退后台没有收掉已排期的那一发续巡（「减少后台运行占用」要求后台一遍封面网络巡都不跑；只拦新排期不够 —— 已排的那一发照样到点联网）')
    }
    if (!/const pending = coverFollowupSongs\.current[\s\S]{0,200}?coverFollowupSongs\.current = null[\s\S]{0,200}?prefetchCovers\(pending, \{ auto: true \}\)/.test(appGate)) {
      reasons.push('回前台没有「取走名单 → 清名单 → 立刻补发」的补账（退后台收掉的欠账没人还：切一次后台回来，这首的封面就永远等不到下一轮）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：兜底用的 helper 本身必须是「搜索 + 内置平台接口」那条（防换回自定义源）
// ---------------------------------------------------------------------------

const helperInvariants = (files) => {
  const reasons = []
  const localCode = stripComments(files.local)

  if (!localCode.includes('const getOtherSourceByLocal = async <T>(')) {
    reasons.push('core/music/local.ts 里没有 getOtherSourceByLocal（封面/歌词的兜底都挂在它上面）')
  }
  const helperStart = localCode.indexOf('const getOtherSourceByLocal = async <T>(')
  const helperEnd = localCode.indexOf('export const getMusicUrl = async({', helperStart)
  if (helperEnd <= helperStart) {
    reasons.push('getOtherSourceByLocal 切片失败（锚点漂移：下一个顶层声明 export const getMusicUrl）')
  }
  const helperBody = helperStart < 0 || helperEnd <= helperStart ? '' : localCode.slice(helperStart, helperEnd)
  if (!helperBody.includes('getOtherSource(')) {
    reasons.push('getOtherSourceByLocal 没有调 getOtherSource（跨平台搜索那一步）')
  }
  if (!helperBody.includes('searchMusic(')) {
    reasons.push('getOtherSourceByLocal 没有 searchMusic 模糊搜索兜底（文件名匹配不上时就全空）')
  }
  if (helperBody.includes('apis(')) {
    reasons.push('getOtherSourceByLocal 里出现了 apis(...)（就是抛 Api is not found 的那条自定义源链路）')
  }

  // 交叉印证根因：内置 apiList 为空、且只有 common.apiSource 以 user_api 开头时才走 global.lx.apis
  // ⇒ 普通设置下 apis('local') 必抛 Api is not found，封面/歌词的自定义源链路必失败。
  // 这三条一旦不成立（比如以后内置源里真有 local 了），说明根因前提变了，本契约要重新核对。
  const apiInfo = stripComments(files.apiSource)
  if (!/const apiList = \{\s*\}/.test(apiInfo)) {
    reasons.push('musicSdk/api-source.js 的内置 apiList 不再是空对象（内置源列表变了，需重新核对「apis(\'local\') 必抛错」这个前提）')
  }
  if (!apiInfo.includes("throw new Error('Api is not found')")) {
    reasons.push('api-source.js 不再在缺 api 时抛 Api is not found（根因前提变了，需重新核对）')
  }
  if (!apiInfo.includes('global.lx.apis[source]')) {
    reasons.push('api-source.js 不再从 global.lx.apis 取自定义源（根因前提变了，需重新核对）')
  }

  // 兜底最终落到内置平台接口上，而不是又绕回自定义源
  const utilsCode = stripComments(files.utils)
  if (!utilsCode.includes('musicSdk[musicInfo.source].getPic')) {
    reasons.push('utils.ts 的 getOnlineOtherSourcePicUrl 不再调 musicSdk[source].getPic（内置平台封面接口）')
  }
  if (!utilsCode.includes('musicSdk[musicInfo.source].getLyric')) {
    reasons.push('utils.ts 的 getOnlineOtherSourceLyricInfo 不再调 musicSdk[source].getLyric（内置平台歌词接口）')
  }
  if (!utilsCode.includes('existTimeExp.test(lyricInfo.lyric)')) {
    reasons.push('utils.ts 的歌词匹配不再校验时间轴（会拿纯文本歌词覆盖掉有轴歌词）')
  }

  // 预热必须仍受 coverUrl.ts 的并发上限约束
  const coverCode = stripComments(files.coverUrl)
  if (!coverCode.includes('const MAX_CONCURRENT = 4')) {
    reasons.push('coverUrl.ts 的 MAX_CONCURRENT 不是 4（预热的并发上限变了，需重新评估请求量）')
  }
  if (!coverCode.includes('if (inflight) return inflight')) {
    reasons.push('coverUrl.ts 去掉了在飞去重（预热与行内 useCoverUrl 会对同一首歌发两次请求）')
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

  // c1 封面又变成无条件 return（空串短路掉兜底）
  check('c1 空封面又无条件 return', webdavCoverFallbackInvariants(tamper(REAL.local,
    '    if (result.url) return result.url',
    '    return result.url')),
  '无条件')

  // c2 封面删掉搜索兜底
  // 锚点 = 「10 格缩进的 getOtherSourceByLocal 调用」：第 36 轮把整段搜索包进了
  // withWebdavCoverSearchTimeout(...)，调用点缩进变成 10 格、前面也不再是 `const matchedUrl = await`。
  // 文件里 `getOtherSourceByLocal(musicInfo, async(otherSource) => {` 共 3 处（行内封面兜底 /
  // 普通本地换源 / 歌词兜底），只有这一处是 10 格缩进 —— 锚进缩进才打得准。
  check('c2 封面删掉搜索兜底', webdavCoverFallbackInvariants(tamper(REAL.local,
    '          getOtherSourceByLocal(musicInfo, async(otherSource) => {',
    '          Promise.resolve(musicInfo).then(async(otherSource: any) => {')),
  '缺少 getOtherSourceByLocal')

  // c3 封面兜底改成真的换源
  // 锚点只取「14 格缩进的 musicInfos/onToggleSource/isRefresh」这一小段：歌词那段同样的三行是
  // 10 格缩进、行内封面兜底那段是 6 格，靠缩进区分。（第 36 轮把整段包进
  // withWebdavCoverSearchTimeout 后又深了一层，12 格 → 14 格。）
  check('c3 封面兜底换源', webdavCoverFallbackInvariants(tamper(REAL.local,
    '              musicInfos: [...otherSource],\n              onToggleSource: () => {},\n              isRefresh,\n            })',
    '              musicInfos: [...otherSource],\n              onToggleSource,\n              isRefresh,\n            })')),
  '不是空函数')

  // c4 封面兜底不写回 meta
  check('c4 封面兜底不写回', webdavCoverFallbackInvariants(tamper(REAL.local,
    'await module.updateWebDAVMusicMeta(musicInfo.id, { picUrl: matchedUrl })',
    'await module.updateWebDAVMusicMeta(musicInfo.id, {})')),
  '没有写回')

  // c5 空返回被提到兜底之前
  check('c5 空返回排在兜底之前', webdavCoverFallbackInvariants(tamper(REAL.local,
    '    if (result.url) return result.url',
    "    if (isWebDAVMusic) return ''\n    if (result.url) return result.url")),
  '空返回排在搜索兜底之前')

  // c6 封面兜底不广播
  check('c6 封面兜底不广播', webdavCoverFallbackInvariants(tamper(REAL.local,
    'appEvent.webdavPicUpdated(musicInfo.id, matchedUrl)',
    'void matchedUrl')),
  '没有广播')

  // c7 巡检一次把整批全发出去（第 36 轮：第 27 轮的 `started >= MAX_PREFETCH_COVERS` 计数上限
  //    已按新口径删除，改钉「一批切多少」）
  check('c7 巡检一批全发出去', prefetchInvariants(tamper(REAL.page,
    'queue.slice(i, i + MAX_PREFETCH_COVERS)',
    'queue.slice(i)')),
  '批大小不是 MAX_PREFETCH_COVERS')

  // c8 预热没有 id 去重
  check('c8 预热无去重', prefetchInvariants(tamper(REAL.page,
    '        if (prefetchedCoverIds.current.has(song.id)) continue',
    '        // no dedup')),
  '没有按 song.id 去重')

  // c9 预热又跑起整表批量下载
  check('c9 预热改回整表批量', prefetchInvariants(tamper(REAL.page,
    '        if (!isRefresh && getCachedCoverUrl(song)) continue',
    '        void fetchWebDAVPic(song)\n        if (!isRefresh && getCachedCoverUrl(song)) continue')),
  'fetchWebDAVPic')

  // c10 预热跳过缓存查询（每首相隔重复发）
  check('c10 预热不看内存缓存', prefetchInvariants(tamper(REAL.page,
    '        if (!isRefresh && getCachedCoverUrl(song)) continue',
    '        // no cache check')),
  '内存缓存')

  // c10b 刷新时也被内存缓存挡住（点一次扫描复核不到封面是否最新）
  check('c10b 刷新被缓存挡住', prefetchInvariants(tamper(REAL.page,
    '        if (!isRefresh && getCachedCoverUrl(song)) continue',
    '        if (getCachedCoverUrl(song)) continue')),
  '刷新时也被缓存挡住')

  // c11 预热上限被放大成整表
  check('c11 预热上限放大到整表', prefetchInvariants(tamper(REAL.page,
    'const MAX_PREFETCH_COVERS = 20',
    'const MAX_PREFETCH_COVERS = 5000')),
  '不在 (0, 50] 内')

  // c12 少了「扫描」那一处调用点。两处调用点的文本都是 `prefetchCovers(scannedSongs)`
  // （handleScan 与「扫描并下载」），靠后缀把锚点钉在 handleScan 那处（第 30 轮后它后面紧跟
  // `})` + `.catch(`，而「扫描并下载」那处后面是空行 + `if (scannedSongs.length === 0)`）。
  // 删掉一处后锚点检查仍能命中另一处，所以这里断言的是调用点计数。
  check('c12 少一处预热调用点', prefetchInvariants(tamper(REAL.page,
    '          forceCoverRefresh.current = true\n          prefetchCovers(scannedSongs)\n        })\n        .catch((err: any) => {',
    '          forceCoverRefresh.current = true\n        })\n        .catch((err: any) => {')),
  '预热调用点不足')

  // c13 歌词又落回空死胡同（兜底被删）
  check('c13 歌词删掉兜底', webdavLyricFallbackInvariants(tamper(REAL.local,
    '      const matchedLyricInfo = await getOtherSourceByLocal(musicInfo, async(otherSource) => {',
    '      const matchedLyricInfo = await Promise.resolve(null) && (async(otherSource: any) => {')),
  '缺少 getOtherSourceByLocal')

  // c14 歌词兜底不落盘
  check('c14 歌词兜底不落盘', webdavLyricFallbackInvariants(tamper(REAL.local,
    '        if (!isFromCache) void saveLyric(musicInfo, matchedLyric)',
    '        void matchedLyric')),
  'saveLyric')

  // c15 空歌词被提到兜底之前
  check('c15 空歌词排在兜底之前', webdavLyricFallbackInvariants(tamper(REAL.local,
    "      const matchedLyricInfo = await getOtherSourceByLocal(musicInfo, async(otherSource) => {",
    "      return buildLyricInfo({ lyric: '' })\n      const matchedLyricInfo = await getOtherSourceByLocal(musicInfo, async(otherSource) => {")),
  '空歌词排在搜索兜底之前')

  // c16 歌词兜底空手时直接抛（播放链路会炸）
  check('c16 空歌词收口被删', webdavLyricFallbackInvariants(tamper(REAL.local,
    "      // 云盘（WebDAV）不走自定义源换源，搜索兜底也空就返回空歌词\n      return buildLyricInfo({ lyric: '' })",
    '      return matchedLyricInfo')),
  '缺少最后的空歌词收口')

  // c17 兜底 helper 被换回自定义源链路
  check('c17 helper 换回自定义源', helperInvariants({
    ...REAL,
    local: tamper(REAL.local,
      '  const fuzzyResults = await searchMusic({',
      '  const fuzzyResults = await apis(\'local\').searchMusic({'),
  }),
  'apis(')

  // ---- 第 29 轮新增反例：封面巡检（整表 / 失效本地封面 / 失败备忘）----

  // c18 巡检退回第 27 轮「有 picUrl 就跳过」（失效的本地封面被当成有封面，行内还短路）
  check('c18 巡检不校验本地封面', prefetchInvariants(tamper(REAL.page,
    '        if (song.meta.picUrl) {\n',
    '        if (song.meta.picUrl) continue\n')),
  '本地封面文件失效')

  // c19 巡检不校验封面文件是否存在（file:// 一律当成有封面）
  check('c19 巡检不查文件在不在', prefetchInvariants(tamper(REAL.page,
    '          const alive = await existsFile(song.meta.picUrl.replace(\'file://\', \'\')).catch(() => false)',
    '          const alive = true')),
  '校验 file:// 封面文件是否还在')

  // c20 失效封面不作废内存缓存（行内会一直拿到那张已经不存在的图）
  check('c20 失效封面不作废缓存', prefetchInvariants(tamper(REAL.page,
    '          invalidateCoverCache(song)',
    '          void song')),
  '作废内存缓存')

  // c21 巡检不清失败备忘（封面缺失的歌永远不再被自动补）
  check('c21 巡检不清失败备忘', prefetchInvariants(tamper(REAL.page,
    '    clearWebdavCoverMisses()',
    '    void 0')),
  '失败备忘')

  // c22 巡检退回「只补前 N 首」（整表一把梭 / 滚下去的歌没有封面也不补）
  check('c22 巡检不再分批推进整表', prefetchInvariants(tamper(REAL.page,
    '      for (let i = 0; i < queue.length; i += MAX_PREFETCH_COVERS) {',
    '      for (const song of queue) {')),
  '分批推进整份列表')

  // ---- 第 31 轮新增反例：进列表强制刷新 + 自愈不借整轮巡检入口 ----

  // c23 进列表那一轮不再是强制刷新（内存里有封面结果的歌被缓存挡掉：进来还是灰占位/老封面）
  check('c23 进列表不强制刷新', prefetchInvariants(tamper(REAL.page,
    '      forceCoverRefresh.current = true\n      prefetchCovers(songs)',
    '      prefetchCovers(songs)')),
  '进列表没有置位 forceCoverRefresh')

  // c24 自愈又借道整轮巡检入口（会把正在飞的那一轮判成过期整体中止）
  check('c24 自愈借道整轮巡检', prefetchInvariants(tamper(REAL.page,
    '    void refreshWebdavCover(song).then((newPicUrl) => {',
    '    void prefetchCovers([song]).then((newPicUrl) => {')),
  '单首形式的 prefetchCovers')

  // c25 自愈 helper 被删（清了 picUrl 却没人去补）
  check('c25 自愈 helper 被删', prefetchInvariants(tamper(REAL.page,
    '    void refreshWebdavCover(song).then((newPicUrl) => {',
    '    void Promise.resolve(song).then((newPicUrl) => {')),
  'refreshWebdavCover')

  // ---- 第 36 轮第 3 条：巡检不会停（去掉整轮作废 + 跑完自续巡）+ 名额不再泄漏 ----

  // f1 轮次作废标记回来（在飞的那一轮被整轮掐死，新一轮从表头重来）
  check('f1 轮次作废标记回来', followupSweepInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '  const prefetchedCoverIds = useRef(new Set<string>())',
      '  const prefetchedCoverIds = useRef(new Set<string>())\n  const coverSweepToken = useRef(0)'),
  }),
  '轮次作废标记')

  // f2 跑完不再续巡（失败/超时的歌没有第二次机会）
  check('f2 跑完不续巡', followupSweepInvariants({
    ...REAL,
    page: tamper(REAL.page, '        prefetchCovers(failed, { auto: true })', '        void failed'),
  }),
  '不安排续巡')

  // f3 续巡把确凿没结果的备忘一起清了（判据失效 + 搜索风暴）
  check('f3 续巡清掉备忘', followupSweepInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '      for (const song of list) prefetchedCoverIds.current.delete(song.id)',
      '      clearWebdavCoverMisses()\n      for (const song of list) prefetchedCoverIds.current.delete(song.id)'),
  }),
  '备忘一起清')

  // f4 续巡不摘已试名单（去重把这批整批跳过 —— 换汤不换药）
  check('f4 续巡不摘已试名单', followupSweepInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '      for (const song of list) prefetchedCoverIds.current.delete(song.id)',
      '      void list'),
  }),
  '已试名单里摘掉')

  // f5 卸载不收定时器（离开 WebDAV 后定时器还在跑）。
  //    第 42 轮第 2 条起卸载走 cancelCoverFollowup 单一收口，锚点换成新的卸载 effect 形状。
  check('f5 卸载不收定时器', followupSweepInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '  useEffect(() => () => {\n    cancelCoverFollowup()\n    coverFollowupSongs.current = null\n  }, [cancelCoverFollowup])',
      '  useEffect(() => () => {}, [cancelCoverFollowup])'),
  }),
  '卸载没有收续巡')

  // f6 续巡短周期被改成毫秒级（请求风暴）
  check('f6 续巡短周期超界', followupSweepInvariants({
    ...REAL,
    page: tamper(REAL.page, 'const COVER_FOLLOWUP_SHORT_MS = 15000', 'const COVER_FOLLOWUP_SHORT_MS = 5'),
  }),
  '短周期')

  // f7 搜索上限被删（名额漏光后全表封面永久停摆）
  check('f7 搜索上限被删', followupSweepInvariants({
    ...REAL,
    local: tamper(REAL.local, 'const WEBDAV_COVER_SEARCH_TIMEOUT_MS = 12000\n', ''),
  }),
  '没有 WEBDAV_COVER_SEARCH_TIMEOUT_MS')

  // f8 搜索上限不再短于外层封面超时（占着名额干已被丢弃的活）
  check('f8 搜索上限不短于外层', followupSweepInvariants({
    ...REAL,
    local: tamper(REAL.local, 'const WEBDAV_COVER_SEARCH_TIMEOUT_MS = 12000', 'const WEBDAV_COVER_SEARCH_TIMEOUT_MS = 60000'),
  }),
  '不短于外层封面超时')

  // f9 超时/异常也记失败备忘（一次抖动就把这首判死刑）
  check('f9 超时也记备忘', followupSweepInvariants({
    ...REAL,
    local: tamper(REAL.local,
      "              const definitive = err?.message === 'source not found'",
      '              const definitive = true'),
  }),
  '判死刑')

  // f10 名额不在 finally 里放行（任何一条提前 return / 抛错都泄漏名额）
  check('f10 名额不在 finally 放行', followupSweepInvariants({
    ...REAL,
    local: tamper(REAL.local,
      '      } finally {\n        releaseWebdavCoverSearch()',
      '      }\n      if (true) {\n        releaseWebdavCoverSearch()'),
  }),
  'finally 里放行')

  // ---- 第 42 轮第 2 条：封面续巡的前后台门（后台耗电 / 发热） ----

  // g1 退后台照排（闸门被删）
  check('g1 退后台照排', followupPowerInvariants({
    ...REAL,
    page: tamper(REAL.page, "      if (AppState.currentState !== 'active') return\n", ''),
  }),
  '没有前台闸门')

  // g2 在名单落地之前又塞了一道早退（名单没留，回前台无账可还）
  check('g2 早退插到名单落地之前', followupPowerInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '      const hasRetryable = failed.some(song => !isWebdavCoverKnownMiss(song))',
      "      if (AppState.currentState !== 'active') return\n      const hasRetryable = failed.some(song => !isWebdavCoverKnownMiss(song))"),
  }),
  '名单落地之前')

  // g3 退后台只拦新排期、不收已排的那一发（已排的那发照样到点联网）
  check('g3 退后台不收已排期的那一发', followupPowerInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '        cancelCoverFollowup()\n        return\n      }',
      '        return\n      }'),
  }),
  '退后台没有收掉')

  // g4 回前台不补发（欠账没人还）
  check('g4 回前台不补发', followupPowerInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '      coverFollowupSongs.current = null\n      prefetchCovers(pending, { auto: true })',
      '      void pending'),
  }),
  '回前台没有')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-webdav-auto-cover-lyric ===')
console.log('WebDAV：扫描/刷新/进列表自动巡检封面（整表分批 + 失效本地封面重补 + 失败备忘每轮清空）+ 播放自动补齐歌词（第 27 轮起，第 29 轮加强；第 42 轮给续巡加前后台门与无进展退避）')
console.log()

const checks = [
  ['条一① 封面兜底走 getOtherSourceByLocal + 内置平台 getPic，不换源，命中写回 meta + 广播；空封面不再无条件 return，空返回收口在兜底之后', () => webdavCoverFallbackInvariants(REAL.local)],
  ['条一③ 列表页巡检（整表分批 ≤50 / 每轮清失败备忘 / file:// 失效封面重补 / 跳缓存）+ 预热点齐全 + 没回退成整表批量下载', () => prefetchInvariants(REAL.page)],
  ['条二 WebDAV 歌词兜底 + saveLyric + 空歌词仍是最后收口', () => webdavLyricFallbackInvariants(REAL.local)],
  ['兜底链路复核：helper 走 searchMusic/内置平台接口，内置 apiList 仍为空，并发上限仍是 4', () => helperInvariants(REAL)],
  ['第 36 轮第 3 条 巡检不会停（无轮次作废 / 跑完按失败性质分档退避续巡 / 续巡只重查没拿到的那批并摘掉已试 id）+ 名额不再泄漏（搜索套 12s 上限且短于外层超时 / 超时异常不记备忘 / finally 放行）', () => followupSweepInvariants(REAL)],
  ['第 42 轮第 2 条 封面续巡的前后台门（退后台把已排期的那一发也收掉、名单留着 / 回前台取名单立刻补发）+ 单一停表收口（新一轮先收旧的、卸载收干净）', () => followupPowerInvariants(REAL)],
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
