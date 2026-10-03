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
 *   条二（下载按钮）
 *     ① hasConfig 改成响应式（useSettingValue('sync.webdav.url'/'sync.webdav.username')），
 *        不再是一次性快照；两个下载按钮的 disabled 里去掉 !hasConfig（未配置时按得动，
 *        由 handleBatchDownload 提示并跳配置页），不靠 disabled 静默吞点击；
 *     ② ⋮ 菜单 handleDownload：入口先落日志（分辨「没进回调」还是「进了回调静默失败」），
 *        并补上 .catch —— 出错一律落日志 + toast 具体原因；
 *     ③ 扫描并下载 handleBatchDownload：按下先落日志 + 把标题写成「准备扫描并下载…」，
 *        用户取消时清标题并落日志，尾部 .catch 清标题 + toast（「准备…」不会永远挂在那儿）；
 *     ④ WebDAVListAction.handleWebDAVDownload：入口日志提到函数第一行，整段「下载前的准备」
 *        套 try/catch（meta 缺字段时不再第一行就抛且无人接），半截文件先删再下。
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

  // ④ 刷新 = 连封面是不是最新都重查
  if (!body.includes('fetchCoverUrl(song, { isRefresh })')) {
    reasons.push('巡检没有把刷新标记透传给 fetchCoverUrl（刷新时不会复核封面是否最新）')
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
  if (!coverCode.includes('options?: { isRefresh?: boolean }')) {
    reasons.push('coverUrl.ts 的 fetchCoverUrl 不接受 isRefresh 选项（刷新复核没有入口）')
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

  const heal = slice(page, 'const coverErrorRetriedKeys = useRef(', 'const handleEditMetadata = useCallback(')
  if (!heal) {
    reasons.push('handleCoverError 切片失败（锚点漂移：coverErrorRetriedKeys / handleEditMetadata）')
    return reasons
  }
  if (!heal.includes('`${song.id}|${url}`')) {
    reasons.push('handleCoverError 没有按 (id|url) 组键（同一行不同 URL 会被误判成重试过）')
  }
  if (!heal.includes('if (coverErrorRetriedKeys.current.has(key)) return')) {
    reasons.push('handleCoverError 没有一次性守卫（换来的封面又挂就会无限重试，变成请求风暴）')
  }
  if (!heal.includes('coverErrorRetriedKeys.current.add(key)')) {
    reasons.push('handleCoverError 没有把重试过的键记下来（守卫形同虚设）')
  }
  if (!heal.includes('invalidateCoverCache(song)')) {
    reasons.push('handleCoverError 没有作废内存缓存（重补时还会拿到那张挂掉的图）')
  }
  if (!heal.includes('prefetchCovers([target])')) {
    reasons.push('handleCoverError 没有触发单首重补（清了 picUrl 却没人去补，行内会空占位）')
  }

  // 页面里 fetchCoverUrl( 只该出现在巡检那一处：别在渲染/自愈路径上新增逐首直调（绕开缓存与并发闸）
  const fetchCount = countOf(page, 'fetchCoverUrl(')
  if (fetchCount !== 1) {
    reasons.push(`页面里 fetchCoverUrl( 出现 ${fetchCount} 次（应当只有巡检那一处，自愈路径要走 prefetchCovers）`)
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

  // ② 两个下载按钮不能被 !hasConfig 禁用吞掉点击
  const disabledCount = countOf(page, 'disabled={loading || !!batchLoadingText}')
  if (disabledCount !== 2) {
    reasons.push(`两个下载按钮的 disabled={loading || !!batchLoadingText} 只出现 ${disabledCount} 次（未配置时按钮被禁用，按下去会被静默吞掉）`)
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
  check('c9 巡检不带刷新标记', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page, 'fetchCoverUrl(song, { isRefresh })', 'fetchCoverUrl(song)'),
  }),
  '刷新标记')

  // c10 下拉刷新没有置位刷新标记
  check('c10 刷新不置位标记', coverWatchInvariants({
    ...REAL,
    page: tamper(REAL.page, '    forceCoverRefresh.current = true', '    forceCoverRefresh.current = false'),
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

  // c15 自愈没有一次性守卫（死图会无限重试）
  check('c15 自愈没有一次性守卫', inlineHealInvariants({
    ...REAL,
    page: tamper(REAL.page, '    if (coverErrorRetriedKeys.current.has(key)) return', '    void key'),
  }),
  '没有一次性守卫')

  // c16 自愈清了 picUrl 却没人补
  check('c16 自愈不触发重补', inlineHealInvariants({
    ...REAL,
    page: tamper(REAL.page, '    prefetchCovers([target])', '    void target'),
  }),
  '没有触发单首重补')

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
    page: tamper(REAL.page, 'disabled={loading || !!batchLoadingText}', 'disabled={!hasConfig || loading || !!batchLoadingText}'),
  }),
  '只出现 1 次')

  // c20 ⋮ 菜单下载的 catch 被删（静默 reject）
  check('c20 菜单下载没有 catch', downloadButtonInvariants({
    ...REAL,
    page: tamper(REAL.page, '    }).catch((err: any) => {\n      // 【第 29 轮】原来这里没有 catch',
      '    })\n    if (false) { void (err: any)\n      // 原来这里没有 catch'),
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

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-webdav-cover-watch ===')
console.log('WebDAV：封面时刻关注（整表分批巡检 + 失效本地封面重补 + 每轮清备忘 + 刷新复核最新 + 行内 onError 自愈）')
console.log('        下载按钮按了有反应（响应式 hasConfig + 不被 disabled 吞 + 失败必有日志与提示）（第 29 轮）')
console.log()

const checks = [
  ['条一①-④ 巡检整表分批 / file:// 探活与重补 / 每轮清备忘与已试 id / 刷新带 isRefresh（coverUrl.ts + local.ts 同步）', () => coverWatchInvariants(REAL)],
  ['条一⑤ 行内 onError 自愈（一次性重试 + 清 picUrl + 单首重补，且不新增 fetchCoverUrl 直调点）', () => inlineHealInvariants(REAL)],
  ['条二 下载按钮按了有反应（响应式 hasConfig / 不再被 disabled 吞 / 入口日志与 catch / 半截文件先删）', () => downloadButtonInvariants(REAL)],
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
