#!/usr/bin/env node
/**
 * sim-cover-url-type-guard.js —— 「封面 URL 必须是字符串」契约（第 32 轮）。
 *
 * 需求原话（2026-10-04 第 32 轮，附 App 内致命错误框截图）：
 *   「图一：在WebDAV界面，向下滑动列表时，突然报错，疑似和加载在线封面有关，请修复。」
 *   截图内容：
 *     Error: Fatal: TypeError TaskQueue: Error with task : undefined is not a function
 *     Stack: TypeError: undefined is not a function at anonymous
 *            at renderWithHooks / beginWork$1 / performUnitOfWork / workLoopSync /
 *            renderRootSync / performSyncWorkOnRoot
 *
 * 根因（读源码得到，链路完整）：
 *   ① React 栈里 renderWithHooks 紧贴 anonymous ⇒ 抛错点是**某个函数组件的渲染体本身**，
 *      不是它调用的助手函数。封面链路里只有一处能在渲染体里抛出这句话：
 *      src/components/common/Image.tsx 的
 *          url?.startsWith('/')
 *      可选链只在 url 为 null/undefined 时短路；url 若是**非空对象**，`url.startsWith`
 *      求值为 undefined 再被调用 ⇒ Hermes 报「undefined is not a function」。而且只有
 *      「向下滑动列表」时才会挂载新行（FlatList initialNumToRender=20 + windowSize=5 +
 *      removeClippedSubviews），所以是滚到某一行才炸 —— 与用户描述完全一致。
 *   ② 那个对象从哪来：src/utils/musicSdk/mg/pic.js 的 getPic 是 async 包 async，
 *      `return this.getPicUrl(songId)` 返回的是 httpFetch 的请求对象 `{ promise, cancelHttp }`
 *      （不是 requestObj.promise）。而 src/core/music/utils.ts 的
 *      getOnlineOtherSourcePicUrl / handleGetOnlinePicUrl / getOnlineOtherSourcePicByLocal
 *      都是裸 `reqPromise.then((url: string) => ...)` —— 把请求对象原样当成 URL 字符串带走。
 *      同文件 core/music/localPlay.ts 的 resolveSdkResult 早就为这个问题存在，注释里点名
 *      「mg.getPic 返回 { promise, cancelHttp } 请求对象」，但那三条封面链路没用它。
 *   ③ 于是这个对象一路流进：coverUrl.ts 内存缓存 → WebDAV 歌曲 meta.picUrl
 *      （updateWebDAVMusicMeta 落盘，JSON.stringify 成 `{"picUrl":{"promise":{}}}`）→
 *      webdavPicUpdated 广播 → 列表行 <Image url>。下一次进列表读回来还是对象，
 *      滚到那一行就炸；而且坏数据已经写进配置，不修的话永远炸同一行。
 *
 * 本轮口径（每一处都是「非字符串 = 没拿到封面」，绝不把脏值往外传）：
 *   条一 Image.tsx 渲染体不再对非字符串调 startsWith：只认 number（require 资源 id）、
 *        string（URL），其余走空占位（EmptyPic）。resolveAssetSource 的返回值也允许为 null。
 *   条二 生产端收口：utils.ts 新增 resolvePicUrl（与 localPlay.ts 的 resolveSdkResult 同口径：
 *        解包 thenable / `{ promise }` 最多三层 + **只放行字符串**），三条封面链路全部改道；
 *        meta.picUrl 缓存命中那条也加 typeof 守卫。
 *   条三 缓存与 hook 收口：coverUrl.ts、qsCover.ts 只缓存/只返回字符串；
 *        useCoverUrl 的初值与 effect 只认字符串 meta.picUrl。
 *   条四 落盘与状态边界收口：drive.ts 的 updateWebDAVMusicMeta 拒绝落非字符串 picUrl；
 *        normalizeWebDAVMusicInfo 在 getWebDAVConfig 读盘时清掉历史脏 picUrl（坏数据自愈）；
 *        WebDAV 列表页 webdavPicUpdated 订阅只接受字符串。
 *
 * 为什么必须靠契约脚本：这一整类全是「类型/形状」，tsc/eslint 在类型标注（`as Promise<string>`、
 * `{ url: string }`）的掩护下全绿，只有真机滚到那一行才炸。反过来，谁把守卫删了、把裸 then 放回去、
 * 或者把 mg 那条链路的请求对象又透传出来，脚本立刻红。带反例自检（c1–c15）。
 *
 * 运行：node scripts/sim-cover-url-type-guard.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去块注释与整行 `//` 注释：本脚本要看的多处（'file://' + url、`{ promise, cancelHttp }`）
// 含 `//` 字符，不能用朴素的 replace(/\/\/[^\n]*/g, '') 从中间切断。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const F = {
  image: 'src/components/common/Image.tsx',
  utils: 'src/core/music/utils.ts',
  local: 'src/core/music/local.ts',
  localPlay: 'src/core/music/localPlay.ts',
  coverUrl: 'src/core/music/coverUrl.ts',
  qsCover: 'src/core/music/qsCover.ts',
  useCoverUrl: 'src/utils/hooks/useCoverUrl.ts',
  drive: 'src/core/webdavMusic/drive.ts',
  page: 'src/screens/Home/Views/WebDAV/index.tsx',
  mgPic: 'src/utils/musicSdk/mg/pic.js',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

const countOf = (haystack, needle) => haystack.split(needle).length - 1

// 切一段：from（含）→ to（不含）。任一锚点找不到返回 null，由调用方报 FAIL（锚点漂移必须显式失败）
const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  if (to == null) return src.slice(start)
  const end = src.indexOf(to, start + from.length)
  if (end < 0) return null
  return src.slice(start, end)
}

// ---------------------------------------------------------------------------
// 不变量 A（条一）：Image.tsx 渲染体只对 string 调 startsWith
// ---------------------------------------------------------------------------
const imageGuardInvariants = (files) => {
  const reasons = []
  const code = stripComments(files.image)

  if (code.includes('url?.startsWith(')) {
    reasons.push('Image.tsx 又对 url 用了可选链 `url?.startsWith(`：url 是非空对象时 startsWith 是 undefined，'
      + '被调用即抛渲染期致命错误（Fatal: TypeError undefined is not a function）')
  }
  if (!code.includes('typeof url == \'string\'')) {
    reasons.push('Image.tsx 没有把 url 收窄成 string（非字符串必须当"没有封面"走空占位）')
  }
  if (!code.includes('resolveAssetSource(url)?.uri')) {
    reasons.push('Image.tsx 的 require 资源 id 分支没有容错：resolveAssetSource 返回 null 时 `.uri` 会抛')
  }
  if (!code.includes('typeof url == \'number\'')) {
    reasons.push('Image.tsx 不再区分 number（require 资源 id）与 string 两种合法形状')
  }
  // 合法形状之外必须落到"空"：只有 string 分支里允许出现 startsWith('/')
  if (countOf(code, ".startsWith('/')") !== 1) {
    reasons.push('Image.tsx 里 startsWith(\'/\') 的出现次数不是 1（要么守卫被绕过，要么出现了第二处未收窄的调用）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B（条二）：utils.ts 三条封面链路统一走 resolvePicUrl（解包 + 只放行字符串）
// ---------------------------------------------------------------------------
const producerGuardInvariants = (files) => {
  const reasons = []
  const code = stripComments(files.utils)

  const helper = slice(code, 'export const resolvePicUrl = async(value: unknown): Promise<string> => {', 'const cleanFileName =')
  if (!helper) {
    reasons.push('utils.ts 缺少 resolvePicUrl（封面 URL 的统一解包 + 字符串收口）')
  } else {
    if (!helper.includes('typeof v.then === \'function\'')) {
      reasons.push('resolvePicUrl 不解包 thenable（音源 SDK 直接返回 Promise 的那些平台会被误判成空）')
    }
    if (!helper.includes('v.promise && typeof v.promise.then === \'function\'')) {
      reasons.push('resolvePicUrl 不解包 `{ promise, cancelHttp }` 请求对象（mg.getPic 的形状，读得出来是对象）')
    }
    if (!helper.includes('return typeof v === \'string\' ? v : \'\'')) {
      reasons.push('resolvePicUrl 没有"只放行字符串"（非字符串必须当空串，否则请求对象又会被当 URL 传出去）')
    }
  }

  const otherSource = slice(code, 'export const getOnlineOtherSourcePicUrl = async({', 'export const handleGetOnlinePicUrl = async({')
  if (!otherSource) {
    reasons.push('utils.ts 的 getOnlineOtherSourcePicUrl 切片失败（锚点漂移）')
  } else if (!otherSource.includes('resolvePicUrl(reqPromise)')) {
    reasons.push('getOnlineOtherSourcePicUrl 又在裸 `reqPromise.then(...)` 上取 url（第 32 轮修的那个对象透传点）')
  }

  const handlePic = slice(code, 'export const handleGetOnlinePicUrl = async({', 'export const getOnlineOtherSourceLyricInfo = async({')
  if (!handlePic) {
    reasons.push('utils.ts 的 handleGetOnlinePicUrl 切片失败（锚点漂移）')
  } else if (!handlePic.includes('resolvePicUrl(reqPromise)')) {
    reasons.push('handleGetOnlinePicUrl 又在裸 `reqPromise.then(...)` 上取 url（⋮ 菜单「从在线获取封面」那条链路）')
  }

  const byLocal = slice(code, 'export const getOnlineOtherSourcePicByLocal = async(', 'export const TRY_QUALITYS_LIST')
  if (!byLocal) {
    reasons.push('utils.ts 的 getOnlineOtherSourcePicByLocal 切片失败（锚点漂移）')
  } else {
    if (!byLocal.includes('resolvePicUrl(reqPromise)')) {
      reasons.push('getOnlineOtherSourcePicByLocal 没有走 resolvePicUrl（自定义源脚本的返回值同样可能是请求对象）')
    }
    if (byLocal.includes('.getPic(oldMusicInfo).promise')) {
      reasons.push('getOnlineOtherSourcePicByLocal 又在外面自己取 `.promise`：脚本返回纯 Promise/字符串时它是 undefined，'
        + '`undefined.then` 同样是 undefined is not a function')
    }
  }

  if (!code.includes('typeof musicInfo.meta.picUrl === \'string\' && musicInfo.meta.picUrl && !isRefresh')) {
    reasons.push('getOnlineOtherSourcePicUrl 的 meta.picUrl 缓存命中分支没有 typeof 守卫（历史脏值会被原样当 URL 返回）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C（条二续）：local.ts 的 WebDAV 封面分支不把非字符串往外带
// ---------------------------------------------------------------------------
const localGuardInvariants = (files) => {
  const reasons = []
  const code = stripComments(files.local)

  // 沿用第 27/31 轮的锚点：WebDAV 封面分支 = 第一处 isWebDAVMusic 标记 → 该函数结束
  const start = code.indexOf("const isWebDAVMusic = 'webdav' in musicInfo.meta")
  const end = code.indexOf('const getMusicFileLyric = async(filePath: string) => {')
  if (start < 0 || end <= start) {
    reasons.push('local.ts 的 getPicUrl WebDAV 分支切片失败（锚点漂移：isWebDAVMusic 标记 / getMusicFileLyric）')
    return reasons
  }
  const branch = code.slice(start, end)

  if (!branch.includes("if (typeof result.url !== 'string') result.url = ''")) {
    reasons.push('getOnlineOtherSourcePicByLocal 拿到的 url 没有就地收口成字符串（会写进 meta 落盘 / 广播给列表行）')
  }
  if (countOf(branch, 'typeof musicInfo.meta.picUrl === \'string\'') < 2) {
    reasons.push('WebDAV 分支里对 meta.picUrl 的 typeof 守卫不足两处：'
      + '一处要拦住 `.startsWith(\'file://\')`（对象上调用直接抛），一处要拦住把它当封面返回')
  }
  if (countOf(branch, 'typeof pic === \'string\'') < 2) {
    reasons.push('内嵌封面（extractPic）与同级 readPic 的返回值没有 typeof 守卫（非字符串会流进 startsWith / return）')
  }
  // 第 27 轮的形状不能回退（另有 sim-webdav-auto-cover-lyric / row-opacity 两个脚本盯着，这里只做联保）
  if (!branch.includes('if (result.url) return result.url')) {
    reasons.push('WebDAV 封面分支的空返回收口不在了（空串会把下面的搜索兜底整条短路掉）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D（条三）：缓存（coverUrl.ts / qsCover.ts）只存字符串
// ---------------------------------------------------------------------------
const cacheGuardInvariants = (files) => {
  const reasons = []
  const cover = stripComments(files.coverUrl)
  const qs = stripComments(files.qsCover)

  if (!cover.includes('typeof cached === \'string\' ? cached : \'\'')) {
    reasons.push('coverUrl.ts 的 getCachedCoverUrl 会把非字符串缓存值返回给列表行')
  }
  if (!cover.includes('if (typeof url !== \'string\') return \'\'')) {
    reasons.push('coverUrl.ts 的 fetchCoverUrl 把 getPicPath 的返回值直接入缓存/返回（类型标注挡不住运行期对象）')
  }
  if (!qs.includes('typeof cached === \'string\' ? cached : \'\'')) {
    reasons.push('qsCover.ts 的 getCachedQsCover 会把非字符串缓存值返回给列表行')
  }
  if (!qs.includes('if (typeof url !== \'string\') return \'\'')) {
    reasons.push('qsCover.ts 的 fetchQsCover 把跨平台匹配结果直接入缓存/返回')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 E（条三续）：useCoverUrl 只认字符串 meta.picUrl
// ---------------------------------------------------------------------------
const hookGuardInvariants = (files) => {
  const reasons = []
  const code = stripComments(files.useCoverUrl)

  if (!code.includes('typeof item.meta?.picUrl === \'string\' ? item.meta.picUrl : \'\'')) {
    reasons.push('useCoverUrl 没有把 meta.picUrl 收窄成字符串（对象会被 setUrl 进 state，最终喂给 <Image url>)')
  }
  if (code.includes('item.meta?.picUrl ?? ')) {
    reasons.push('useCoverUrl 又用 `item.meta?.picUrl ?? ...`（?? 只挡 null/undefined，挡不住对象）')
  }
  if (!code.includes('typeof pic === \'string\' && pic')) {
    reasons.push('useCoverUrl 的 fetchCoverUrl 结果没有 typeof 守卫')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 F（条四）：落盘与状态边界只接受字符串
// ---------------------------------------------------------------------------
const persistGuardInvariants = (files) => {
  const reasons = []
  const drive = stripComments(files.drive)
  const page = stripComments(files.page)

  const updateFn = slice(drive, 'export const updateWebDAVMusicMeta = async(', 'export const fetchWebDAVPic = async(')
  if (!updateFn) {
    reasons.push('drive.ts 的 updateWebDAVMusicMeta 切片失败（锚点漂移）')
  } else if (!updateFn.includes('if (typeof update.picUrl === \'string\') song.meta.picUrl = update.picUrl')) {
    reasons.push('updateWebDAVMusicMeta 会把非字符串 picUrl 落盘（JSON 里变成 {"picUrl":{"promise":{}}}，'
      + '下次进列表读回来就炸同一行）')
  }

  const normalizeFn = slice(drive, 'export const normalizeWebDAVMusicInfo = (musicInfo: LX.WebDAV.MusicInfo) => {', 'const scanFolder = async(')
  if (!normalizeFn) {
    reasons.push('drive.ts 的 normalizeWebDAVMusicInfo 切片失败（锚点漂移）')
  } else if (!normalizeFn.includes('typeof musicInfo.meta.picUrl !== \'string\'')) {
    reasons.push('normalizeWebDAVMusicInfo 不再清理历史脏 picUrl（getWebDAVConfig 读盘时的一次性自愈没了，'
      + '已经写坏的配置会一直炸）')
  }

  if (!page.includes('if (typeof picUrl !== \'string\') return')) {
    reasons.push('WebDAV 列表页 webdavPicUpdated 订阅没有收窄 picUrl（状态边界是脏值进渲染的最后一道门）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 G：上游形状留证 —— mg.getPic 仍然返回请求对象（说明为什么必须有收口）
// ---------------------------------------------------------------------------
const upstreamShapeInvariants = (files) => {
  const reasons = []
  const code = stripComments(files.mgPic)
  if (!code.includes('return requestObj')) {
    reasons.push('mg/pic.js 不再返回请求对象（上游形状变了，请重新评估本契约是否还需要那么多守卫）')
  }
  if (!stripComments(files.localPlay).includes('resolveSdkResult')) {
    reasons.push('localPlay.ts 的同口径解包器 resolveSdkResult 不在了（两套口径必须并存，别只留一套）')
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

const tamperAll = (src, from, to) => {
  if (!src.includes(from)) throw new Error('反例锚点未命中: ' + from.slice(0, 70))
  return src.split(from).join(to)
}

const runCounterExamples = () => {
  const results = []
  const check = (name, reasons, expectKeyword) => {
    const hit = reasons.some((r) => r.includes(expectKeyword))
    results.push({ name, ok: hit, detail: hit ? '已拦下' : '未拦下（缺失期望理由：' + expectKeyword + '）' })
  }

  // c1 Image.tsx 退回可选链（本次崩溃的原始写法）
  check('c1 Image 退回 url?.startsWith', imageGuardInvariants({
    ...REAL,
    image: tamper(REAL.image, "typeof url == 'string'\n      ? url.startsWith('/') ? 'file://' + url : url\n      : undefined",
      "url?.startsWith('/')\n        ? 'file://' + url\n        : url"),
  }), '可选链')

  // c1b 丢掉 require 资源 id 分支（专辑图那种 number 形状会被当空占位）
  check('c1b 丢掉 number 分支', imageGuardInvariants({
    ...REAL,
    image: tamper(REAL.image,
      "typeof url == 'number'\n    ? _Image.resolveAssetSource(url)?.uri\n    : typeof url == 'string'",
      "typeof url == 'string'"),
  }), 'number')

  // c2 require 资源 id 分支不容错
  check('c2 资源 id 分支不容 null', imageGuardInvariants({
    ...REAL,
    image: tamper(REAL.image, 'resolveAssetSource(url)?.uri', 'resolveAssetSource(url).uri'),
  }), 'resolveAssetSource')

  // c3 getOnlineOtherSourcePicUrl 退回裸 then
  check('c3 在线匹配退回裸 then', producerGuardInvariants({
    ...REAL,
    utils: tamper(REAL.utils,
      '  return resolvePicUrl(reqPromise)\n    .then((url: string) => {\n      return { musicInfo, url, isFromCache: false }\n    })',
      '  return reqPromise\n    .then((url: string) => {\n      return { musicInfo, url, isFromCache: false }\n    })'),
  }), '裸')

  // c4 解包器放行对象
  check('c4 解包器放行非字符串', producerGuardInvariants({
    ...REAL,
    utils: tamper(REAL.utils, "return typeof v === 'string' ? v : ''", 'return v as any'),
  }), '只放行字符串')

  // c5 缓存命中分支的守卫被删
  check('c5 meta.picUrl 缓存命中无守卫', producerGuardInvariants({
    ...REAL,
    utils: tamper(REAL.utils,
      "if (typeof musicInfo.meta.picUrl === 'string' && musicInfo.meta.picUrl && !isRefresh)",
      'if (musicInfo.meta.picUrl && !isRefresh)'),
  }), '缓存命中分支')

  // c6 自定义源链路自己取 .promise
  check('c6 自定义源链路自己 .promise', producerGuardInvariants({
    ...REAL,
    utils: tamper(REAL.utils,
      'reqPromise = apis(\'local\').getPic(oldMusicInfo)',
      'reqPromise = apis(\'local\').getPic(oldMusicInfo).promise'),
  }), '.promise')

  // c7 local.ts 的 url 收口被删
  check('c7 在线匹配 url 不收口', localGuardInvariants({
    ...REAL,
    local: tamper(REAL.local, "    if (typeof result.url !== 'string') result.url = ''\n", ''),
  }), '就地收口')

  // c8 local.ts 的 meta.picUrl 守卫被删（两处都删）
  check('c8 meta.picUrl 守卫被删', localGuardInvariants({
    ...REAL,
    local: tamperAll(REAL.local, 'typeof musicInfo.meta.picUrl === \'string\' && musicInfo.meta.picUrl', 'musicInfo.meta.picUrl'),
  }), 'typeof 守卫不足两处')

  // c9 内嵌封面守卫被删
  check('c9 内嵌封面无守卫', localGuardInvariants({
    ...REAL,
    local: tamperAll(REAL.local, "typeof pic === 'string' && pic", 'pic'),
  }), '内嵌封面')

  // c10 coverUrl 缓存收口被删
  check('c10 coverUrl 缓存放行脏值', cacheGuardInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl, "typeof cached === 'string' ? cached : ''", "cached ?? ''"),
  }), 'coverUrl.ts 的 getCachedCoverUrl')

  // c11 coverUrl 入缓存收口被删
  check('c11 coverUrl 入缓存放行脏值', cacheGuardInvariants({
    ...REAL,
    coverUrl: tamper(REAL.coverUrl, "      if (typeof url !== 'string') return ''\n", ''),
  }), 'fetchCoverUrl')

  // c12 qsCover 入缓存收口被删
  check('c12 qsCover 入缓存放行脏值', cacheGuardInvariants({
    ...REAL,
    qsCover: tamper(REAL.qsCover, "      if (typeof url !== 'string') return ''\n", ''),
  }), 'fetchQsCover')

  // c13 useCoverUrl 退回 ?? 写法
  check('c13 useCoverUrl 退回 ??', hookGuardInvariants({
    ...REAL,
    useCoverUrl: tamper(REAL.useCoverUrl,
      "typeof item.meta?.picUrl === 'string' ? item.meta.picUrl : ''",
      'item.meta?.picUrl ??'),
  }), 'useCoverUrl')

  // c14 落盘守卫被删
  check('c14 落盘放行非字符串', persistGuardInvariants({
    ...REAL,
    drive: tamper(REAL.drive, "    if (typeof update.picUrl === 'string') song.meta.picUrl = update.picUrl",
      '    song.meta.picUrl = update.picUrl'),
  }), 'updateWebDAVMusicMeta')

  // c15 读盘自愈被删
  check('c15 读盘不自愈脏数据', persistGuardInvariants({
    ...REAL,
    drive: tamper(REAL.drive, "  if (musicInfo.meta.picUrl !== undefined && musicInfo.meta.picUrl !== null && typeof musicInfo.meta.picUrl !== 'string') {\n    musicInfo.meta.picUrl = ''\n  }\n", ''),
  }), 'normalizeWebDAVMusicInfo')

  // c16 状态边界收口被删
  check('c16 广播订阅无收口', persistGuardInvariants({
    ...REAL,
    page: tamper(REAL.page, "      if (typeof picUrl !== 'string') return\n", ''),
  }), 'webdavPicUpdated')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-cover-url-type-guard ===')
console.log('封面 URL 必须收口成字符串：Image 渲染体只对 string 调 startsWith；'
  + '音源 SDK 的请求对象不许当 URL 传出去（第 32 轮 WebDAV 列表下滑 Fatal 修复）')
console.log()

const checks = [
  ['条一 Image.tsx 渲染体：只认 number/string，其余空占位；不对非字符串调 startsWith', () => imageGuardInvariants(REAL)],
  ['条二 utils.ts：resolvePicUrl 解包 + 只放行字符串，三条封面链路全部改道', () => producerGuardInvariants(REAL)],
  ['条二续 local.ts：WebDAV 封面分支的 result.url / meta.picUrl / 内嵌封面全部收口', () => localGuardInvariants(REAL)],
  ['条三 缓存：coverUrl.ts / qsCover.ts 只存字符串、只返回字符串', () => cacheGuardInvariants(REAL)],
  ['条三续 useCoverUrl：meta.picUrl 初值与 effect 只认字符串', () => hookGuardInvariants(REAL)],
  ['条四 落盘与状态边界：updateWebDAVMusicMeta 拒收 + normalizeWebDAVMusicInfo 读盘自愈 + 列表页订阅收口', () => persistGuardInvariants(REAL)],
  ['上游形状留证：mg.getPic 仍返回请求对象；localPlay.ts 的 resolveSdkResult 仍在（两套口径并存）', () => upstreamShapeInvariants(REAL)],
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
