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
 * 为什么必须靠契约脚本：这几条全是「形状 / 顺序 / 上限」而非类型 —— 把无条件 return 放回去、
 * 把兜底删掉、把 onToggleSource 换成真的换源、把空串 return 提到兜底之前、把上限改成整表、
 * 把去重删掉、把 fallback 挪到空歌词之后，tsc/eslint 全是绿的，只在真机上表现为
 * 「扫完还是灰占位 / 播放还是无歌词 / 扫一次发几百个请求」。带反例自检。
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
  if (!body.includes('started >= MAX_PREFETCH_COVERS')) {
    reasons.push('预热循环没有条数上限判断（会把整份曲库都发出去）')
  }
  if (!body.includes('if (prefetchedCoverIds.current.has(song.id)) continue')) {
    reasons.push('预热没有按 song.id 去重（扫描/刷新/进列表来回切会重复补同一首）')
  }
  if (!body.includes('prefetchedCoverIds.current.add(song.id)')) {
    reasons.push('预热没有把试过的 song.id 记下来（失败的首歌每次进列表都会重搜一遍）')
  }
  if (!body.includes('if (song.meta.picUrl) continue')) {
    reasons.push('预热没有跳过已有 meta.picUrl 的歌（第 25 轮写回过的封面会被重复匹配）')
  }
  if (!body.includes('if (getCachedCoverUrl(song)) continue')) {
    reasons.push('预热没有跳过内存缓存里已有封面的歌（同一首歌重复发在线匹配）')
  }
  if (!body.includes('fetchCoverUrl(song)')) {
    reasons.push('预热没有走 coverUrl.ts 的 fetchCoverUrl（会被绕开 4 并发全局队列与内存缓存）')
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
  if (countOf(code, 'prefetchCovers(') < 5) {
    reasons.push(`预热调用点不足：prefetchCovers( 只有 ${countOf(code, 'prefetchCovers(')} 处（进列表/扫描/扫描并下载/刷新/播放回填 至少 5 处）`)
  }

  // 第 25 轮删掉的整表批量下载不能回来，也不能再引 fetchWebDAVPic 做封面
  if (code.includes('fetchWebDAVPic')) {
    reasons.push('页面里又出现了 fetchWebDAVPic（第 25 轮已删除的整表批量下载）')
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
  check('c2 封面删掉搜索兜底', webdavCoverFallbackInvariants(tamper(REAL.local,
    '    const matchedUrl = await getOtherSourceByLocal(musicInfo, async(otherSource) => {',
    '    const matchedUrl = await Promise.resolve(\'\') && await (async(otherSource: any) => {')),
  '缺少 getOtherSourceByLocal')

  // c3 封面兜底改成真的换源
  check('c3 封面兜底换源', webdavCoverFallbackInvariants(tamper(REAL.local,
    '        onToggleSource: () => {},\n        isRefresh,\n      })\n      // 空串当失败处理',
    '        onToggleSource,\n        isRefresh,\n      })\n      // 空串当失败处理')),
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

  // c7 预热没有上限
  check('c7 预热无上限', prefetchInvariants(tamper(REAL.page,
    '      if (started >= MAX_PREFETCH_COVERS) break',
    '      // no bound')),
  '没有条数上限')

  // c8 预热没有 id 去重
  check('c8 预热无去重', prefetchInvariants(tamper(REAL.page,
    '      if (prefetchedCoverIds.current.has(song.id)) continue',
    '      // no dedup')),
  '没有按 song.id 去重')

  // c9 预热又跑起整表批量下载
  check('c9 预热改回整表批量', prefetchInvariants(tamper(REAL.page,
    '      if (getCachedCoverUrl(song)) continue',
    '      void fetchWebDAVPic(song)\n      if (getCachedCoverUrl(song)) continue')),
  'fetchWebDAVPic')

  // c10 预热跳过缓存查询（每首相隔重复发）
  check('c10 预热不看内存缓存', prefetchInvariants(tamper(REAL.page,
    '      if (getCachedCoverUrl(song)) continue',
    '      // no cache check')),
  '内存缓存')

  // c11 预热上限被放大成整表
  check('c11 预热上限放大到整表', prefetchInvariants(tamper(REAL.page,
    'const MAX_PREFETCH_COVERS = 20',
    'const MAX_PREFETCH_COVERS = 5000')),
  '不在 (0, 50] 内')

  // c12 少了「扫描」那一处调用点（锚点取 toast 那行，保证命中 handleScan 而不是「扫描并下载」里同名那次）
  // 期望理由只能是条数那条：两处调用点的文本都是 `prefetchCovers(scannedSongs)`，
  // 删掉一处后锚点检查仍能命中另一处，所以这里断言的是调用点计数。
  check('c12 少一处预热调用点', prefetchInvariants(tamper(REAL.page,
    "          toast(`扫描完成：${config.songs.length} 首`)\n          // 【第 27 轮】扫描完立刻自动补在线封面（有上限，见 MAX_PREFETCH_COVERS）\n          prefetchCovers(scannedSongs)",
    "          toast(`扫描完成：${config.songs.length} 首`)")),
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

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-webdav-auto-cover-lyric ===')
console.log('WebDAV：扫描/刷新自动补在线封面（有界预热 + 走搜索兜底并写回）+ 播放自动补齐歌词（第 27 轮）')
console.log()

const checks = [
  ['条一① 封面兜底走 getOtherSourceByLocal + 内置平台 getPic，不换源，命中写回 meta + 广播；空封面不再无条件 return，空返回收口在兜底之后', () => webdavCoverFallbackInvariants(REAL.local)],
  ['条一③ 列表页预热有界（≤50 / 去重 / 跳缓存）+ 预热点齐全 + 没回退成整表批量', () => prefetchInvariants(REAL.page)],
  ['条二 WebDAV 歌词兜底 + saveLyric + 空歌词仍是最后收口', () => webdavLyricFallbackInvariants(REAL.local)],
  ['兜底链路复核：helper 走 searchMusic/内置平台接口，内置 apiList 仍为空，并发上限仍是 4', () => helperInvariants(REAL)],
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
