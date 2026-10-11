#!/usr/bin/env node
/**
 * sim-webdav-download-local-path.js —— WebDAV「下载失败（unsupported URL）」根因修复 +
 * 播放/下载直链算法完善的契约（用户第 26 轮）。
 *
 * 需求原话（2026-10-03 第 26 轮，附「下载管理」截图：最炫民族风 - 凤凰传奇 / MASTER / 16:52 / 错误 unsupported URL）：
 *   「如图一：WebDAV中的下载失败，这是下载的日志：…
 *     我的WebDAV路径是https://<host>/dav，用户名是<user>，密码<已隐去>，同步路径是WebDav/music，
 *     我的WebDAV配置的是302重定向获取，从我的连接中获取到直链下载或者播放，请完善WebDAV的播放和下载算法。」
 *
 * 根因（有日志与只读探测双向佐证）：
 *   core/download.ts:startDownload 此前对**所有**来源都做
 *     url = await getMusicUrl({ musicInfo, quality, isRefresh: true })
 *   然后无条件 downloadFile(url, …)。而 getMusicUrl 对 source='local' 的歌曲（含 WebDAV）
 *   返回的是**本地文件路径**（普通本地音乐=原文件；WebDAV=播放时已预下载到 Caches 的那份副本）——
 *   于是 RNFS 的 fromUrl 收到一个带 scheme 都没有的路径，iOS 上就是 NSURLErrorUnsupportedURL。
 *   日志完全对得上：16:52:13 播放路径先成功（「WebDAV downloaded to local for playback」），
 *   紧接着下载任务就报了 unsupported URL。
 *   探测也证明服务端/URL/鉴权都没问题：HEAD 200，GET + Range: bytes=0-99 → 206 且
 *   Content-Range 总长与日志里的 38038418 一致，文件 GET 未见 302。所以坏的是本地那一跳。
 *
 * 四条口径：
 *   条一 下载管理按来源分流，**任何无 scheme / file:// 的路径都不再进 downloadFile**：
 *        WebDAV → 远端直链（drive.ts 的三级阶梯 + Basic Auth）；普通本地音乐 → copyFile 复制；
 *        其他来源只要 getMusicUrl 回的是本地路径，也一律改走复制。
 *   条二 WebDAV 直链三级阶梯（drive.ts:downloadWebDAVFile）：① 直下 → ② 显式解析 302 之后的
 *        直链再下一次（用户的服务器就是「连接换直链」型）→ ③ 抛错。
 *        每次尝试前先删掉目标文件（失败留下的半截文件会被 existsFile 当成「已下载」向外返回）。
 *        播放预下载（downloadWebDAVMusic）与网盘内封面（fetchWebDAVPic）共用这一套。
 *   条三 远端直链全失败时，下载管理回退到「播放时已预下载到 Caches 的那份副本」——
 *        点下载不能白点；但只有拿到的确实是本地文件才复制，兜底也失败就原样抛错（不假装成功）。
 *   条四 下载成功后把**落盘路径**写回歌曲 meta（updateWebDAVMusicMeta(id, { filePath })），
 *        下次播放直接命中「本地已有该文件」的离线分支，不再为播放重新预下载一份。
 *        同时封面来源改用分发器 getPicPath（此前写死在线专用 getPicUrl，本地/WebDAV 歌曲
 *        在这一步永远拿不到封面、封面写入静默失败）。
 *
 * 为什么必须靠契约脚本：全是「形状」而非类型——把 downloadFile(url, …) 那一支挪回无条件执行、
 * 把三级阶梯砍成一级、把兜底复制删掉、把 //^https?:\/\// 的前置判断去掉，tsc/eslint 全绿，
 * 只在真机上表现为「下载管理里一点就 unsupported URL / 302 型网盘全下不动 / 断网后连兜底都没了」。
 * 带反例自检：对篡改后的源码跑同一套判断，必须被拦下。
 * 运行：node scripts/sim-webdav-download-local-path.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去整行 `//` 注释与块注释。
// 不能像别的脚本那样去「任意位置的 //」：本文件要断言的正则 `/^https?:\/\//i`
// 里就有一对连续斜杠，粗暴去注释会把这一行本身吃掉。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(line => /^\s*\/\//.test(line) ? '' : line)
  .join('\n')

const F = {
  download: 'src/core/download.ts',
  drive: 'src/core/webdavMusic/drive.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

const DL = stripComments(REAL.download)
const DRV = stripComments(REAL.drive)

const slice = (src, from, to) => {
  const a = src.indexOf(from)
  if (a < 0) return null
  const b = to ? src.indexOf(to, a + from.length) : src.length
  if (b < 0) return null
  return src.slice(a, b)
}

// ---------------------------------------------------------------------------
// 不变量 A（条一 + 条四前半）：download.ts 的来源分流与三条下载路径
// ---------------------------------------------------------------------------

const sourceTriageInvariants = (code) => {
  const reasons = []

  const def = code.match(/const isDownloadableUrl = .*?\n/)
  if (!def) {
    reasons.push('缺少 isDownloadableUrl 判断（无法区分「远端地址」与「本地路径」——用户报的 unsupported URL 的根源）')
  } else if (!/\/\^https\?:\\\/\\\/\/i\.test/.test(def[0])) {
    reasons.push('isDownloadableUrl 的判据不是 ^https?://（file:// 与无 scheme 的本地路径会被放行）')
  }

  const webdavInfo = code.match(/const isWebDAVMusicInfo = [\s\S]{0,200}?\n\n/)
  if (!webdavInfo) {
    reasons.push('缺少 isWebDAVMusicInfo 判断（WebDAV 歌曲与普通本地音乐无法分流）')
  } else if (!/source === 'local'/.test(webdavInfo[0]) || !/webdav/.test(webdavInfo[0])) {
    reasons.push('isWebDAVMusicInfo 的判据不是「source=local 且 meta.webdav」')
  }

  const triage = slice(code, "  let url = ''", 'const isBilibiliSource')
  if (!triage) {
    reasons.push('来源分流块抽取失败（锚点漂移：let url = \'\' / const isBilibiliSource）')
    return reasons
  }

  const webdavAt = triage.indexOf('} else if (isWebDAVMusicInfo(task.musicInfo)) {')
  if (webdavAt < 0) {
    reasons.push('没有 WebDAV 独立分支（WebDAV 歌曲会掉进 getMusicUrl，拿回本地路径再当 fromUrl 用）')
  } else {
    const seg = triage.slice(webdavAt, triage.indexOf('} else if (task.musicInfo.source === \'local\') {', webdavAt))
    if (!seg.includes('getWebDAVDownloadUrl(')) reasons.push('WebDAV 分支没有用 getWebDAVDownloadUrl 取远端直链')
    if (!seg.includes('getWebDAVAuthHeaders()')) reasons.push('WebDAV 分支没有带 Basic Auth headers（网盘会 401）')
  }

  const localAt = triage.indexOf("} else if (task.musicInfo.source === 'local') {")
  if (localAt < 0) {
    reasons.push('没有 source=local 的独立分支（普通本地音乐的「下载」会又去走网络请求）')
  } else if (!triage.slice(localAt).includes('localSourcePath = String((task.musicInfo.meta as any)?.filePath')) {
    reasons.push('本地分支没有从 meta.filePath 取本地源文件路径（会回落到 getMusicUrl 再绕一圈）')
  }

  const guardAt = triage.indexOf('if (!isDownloadableUrl(url)) {')
  if (guardAt < 0) {
    reasons.push('getMusicUrl 分支没有 isDownloadableUrl 兜底（任何来源回本地路径时仍会交给 downloadFile ⇒ unsupported URL）')
  } else {
    const guard = triage.slice(guardAt, guardAt + 320)
    if (!guard.includes('localSourcePath = url')) reasons.push('兜底分支没有把本地路径转给 localSourcePath（改走复制）')
  }

  return reasons
}

// transfer 块：`if (localSourcePath) {` → `downloadedFilePath = downloadFilePath`
const transferBlock = (code) => slice(code, '    if (localSourcePath) {', '    downloadedFilePath = downloadFilePath')

const transferInvariants = (code) => {
  const reasons = []

  const block = transferBlock(code)
  if (!block) {
    reasons.push('下载执行块抽取失败（锚点漂移：if (localSourcePath) { / downloadedFilePath = downloadFilePath）')
    return reasons
  }

  const iLocal = block.indexOf('if (localSourcePath) {')
  const iWebdav = block.indexOf('} else if (isWebDAVSource) {')
  const iPlain = block.lastIndexOf('} else {')
  if (iWebdav < 0) {
    reasons.push('没有 WebDAV 下载分支（WebDAV 会掉进普通 downloadFile ⇒ 又回到 unsupported URL / 不带鉴权）')
  }
  if (iPlain < 0) {
    reasons.push('没有普通下载分支（普通音源的下载链路不见了）')
  }
  if (iLocal >= 0 && iWebdav >= 0 && !(iLocal < iWebdav)) {
    reasons.push('本地复制分支不在 WebDAV 分支之前（无 scheme 的路径仍有机会先进 downloadFile）')
  }
  if (iWebdav >= 0 && iPlain >= 0 && !(iWebdav < iPlain)) {
    reasons.push('WebDAV 分支不在普通下载分支之前（分流顺序不对）')
  }

  if (iLocal >= 0) {
    const seg = block.slice(iLocal, iWebdav >= 0 ? iWebdav : block.length)
    if (!seg.includes('await copyFile(localSourcePath, downloadFilePath)')) {
      reasons.push('本地文件没有走 copyFile 复制（本地音乐的「下载」没有落地方式）')
    }
    if (/downloadFile\(/.test(seg)) {
      reasons.push('本地复制分支里出现了 downloadFile（本地路径被当 fromUrl ⇒ iOS NSURLErrorUnsupportedURL）')
    }
  }

  if (iWebdav >= 0 && iPlain >= 0) {
    const seg = block.slice(iWebdav, iPlain)
    if (!seg.includes('await downloadWebDAVFile(url, downloadFilePath')) {
      reasons.push('WebDAV 没有走 downloadWebDAVFile 的直链阶梯（302 型网盘下不动）')
    }
    if (/[^V]downloadFile\(/.test(seg)) {
      reasons.push('WebDAV 分支里出现了裸 downloadFile（丢掉了三级阶梯与半截文件清理）')
    }
    if (!seg.includes('currentDownloadTask = t')) {
      reasons.push('WebDAV 下载没有把底层 task 交回 currentDownloadTask（下载管理里的「取消」会失效）')
    }
    // 兜底：远端全失败 → 复制播放缓存里那份副本
    if (!seg.includes('const cachedPath = await getMusicUrl({')) {
      reasons.push('WebDAV 失败没有回退到播放缓存（远端直链全挂时点下载会直接失败）')
    } else if (!seg.includes('if (!cachedPath || isDownloadableUrl(cachedPath)) throw webdavError')) {
      reasons.push('WebDAV 兜底没有校验拿到的是本地文件（可能把 http 地址又当本地文件复制）')
    } else if (!seg.includes('await copyFile(cachedPath, downloadFilePath)')) {
      reasons.push('WebDAV 兜底没有真的复制缓存副本（兜底只是摆设）')
    }
  }

  if (iPlain >= 0) {
    const seg = block.slice(iPlain)
    if (!seg.includes('downloadFile(url, downloadFilePath')) {
      reasons.push('普通音源没有走 downloadFile（在线下载链路断了）')
    }
  }

  // 全局：downloadFile 的 fromUrl 只允许是「已判过 http(s) 的 url」或「已判过的封面来源」
  const firstArgs = []
  const re = /(^|[^A-Za-z0-9_$])downloadFile\(\s*([A-Za-z0-9_$.]+)/g
  let m
  while ((m = re.exec(code))) firstArgs.push(m[2])
  const allowed = new Set(['url', 'picSource'])
  const bad = [...new Set(firstArgs.filter(a => !allowed.has(a)))]
  if (firstArgs.length === 0) {
    reasons.push('整个文件里找不到 downloadFile 调用（锚点漂移）')
  } else if (bad.length) {
    reasons.push(`有 downloadFile 调用的 fromUrl 不是判过 http(s) 的变量：${bad.join('、')}`)
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B（条二）：drive.ts 的三级直链阶梯
// ---------------------------------------------------------------------------

const ladderInvariants = (code) => {
  const reasons = []

  // ① getWebDAVRemoteUrl：remotePath 已是完整 URL 时不许再拼 baseUrl
  const remoteUrl = slice(code, 'const getWebDAVRemoteUrl = (remoteFilePath: string): string => {', 'export const getWebDAVDownloadUrl')
  if (!remoteUrl) {
    reasons.push('getWebDAVRemoteUrl 抽取失败（锚点漂移）')
  } else {
    const passthroughAt = remoteUrl.search(/if \(\/\^https\?:\\\/\\\/\/i\.test\(remote\)\) return remote/)
    const baseUrlAt = remoteUrl.indexOf('const baseUrl =')
    if (passthroughAt < 0) {
      reasons.push('getWebDAVRemoteUrl 没有「remotePath 已是完整 URL 就直接返回」的前置判断（会拼成 host/dav/https://… 的必然 404 地址）')
    } else if (baseUrlAt >= 0 && passthroughAt > baseUrlAt) {
      reasons.push('完整 URL 的前置判断在 baseUrl 拼接之后（等于没判）')
    }
  }

  // ② resolveWebDAVDirectUrl：HEAD 优先 + GET/Range 兜底
  const resolveFn = slice(code, 'export const resolveWebDAVDirectUrl = async(', 'export const downloadWebDAVFile = async(')
  if (!resolveFn) {
    reasons.push('缺少 resolveWebDAVDirectUrl（302 型服务器的直链解析）')
  } else {
    if (!resolveFn.includes("method: 'HEAD'")) reasons.push('resolveWebDAVDirectUrl 没有先试 HEAD（会白拉一次 GET）')
    if (!/method: 'GET'/.test(resolveFn)) reasons.push('resolveWebDAVDirectUrl 缺少 GET 兜底（不支持 HEAD 的服务器只能用 405 收场）')
    if (!resolveFn.includes("Range: 'bytes=0-0'")) reasons.push('resolveWebDAVDirectUrl 的 GET 兜底没有带 Range（会把整首歌拉下来）')
    if (!resolveFn.includes('response.url !== url')) reasons.push('resolveWebDAVDirectUrl 没有比较最终 URL（拿不到跳转后的直链）')
  }

  // ③ downloadWebDAVFile：直下 → 解析直链再下 → 抛错；每次尝试前清半截文件
  const dlFn = slice(code, 'export const downloadWebDAVFile = async(', 'export const downloadWebDAVMusic = async(')
  if (!dlFn) {
    reasons.push('缺少 downloadWebDAVFile（统一直链下载入口）')
  } else {
    const cleanups = dlFn.split('await unlink(localPath).catch(() => {})').length - 1
    if (cleanups < 2) {
      reasons.push('downloadWebDAVFile 没有在每次尝试前清掉半截文件（失败留下的残文件会被 existsFile 当「已下载」）')
    }
    if (!dlFn.includes('const directUrl = await resolveWebDAVDirectUrl(url, headers)')) {
      reasons.push('downloadWebDAVFile 缺少二级阶梯（直下失败后没有解析 302 直链再试）')
    }
    if (!dlFn.includes('throw lastError ?? new Error(')) {
      reasons.push('downloadWebDAVFile 全失败时没有抛错（调用方会以为下载成功）')
    }
    if (!dlFn.includes('onTask?.(task)')) {
      reasons.push('downloadWebDAVFile 没有把底层 task 交回调用方（下载管理「取消」失效）')
    }
  }

  // ④ 播放预下载与网盘封面共用同一阶梯
  // downloadWebDAVMusic 是文件里最后一个导出，直接切到文件尾
  const musicFn = slice(code, 'export const downloadWebDAVMusic = async(')
  if (!musicFn) {
    reasons.push('downloadWebDAVMusic 抽取失败（锚点漂移）')
  } else if (!musicFn.includes('await downloadWebDAVFile(downloadUrl, filePath')) {
    reasons.push('播放预下载没有走统一直链阶梯（302 型网盘连播放都进不去）')
  } else if (/(^|[^A-Za-z0-9_$])downloadFile\(/.test(musicFn)) {
    reasons.push('播放预下载里出现了裸 downloadFile（绕过三级阶梯）')
  }

  const picFn = slice(code, 'export const fetchWebDAVPic = async(', 'export const fetchWebDAVLrc = async(')
  if (!picFn) {
    reasons.push('fetchWebDAVPic 抽取失败（锚点漂移）')
  } else if (!picFn.includes('await downloadWebDAVFile(url, localPath')) {
    reasons.push('网盘内封面没有走统一直链阶梯（302 型网盘封面永远取不到）')
  } else if (/(^|[^A-Za-z0-9_$])downloadFile\(/.test(picFn)) {
    reasons.push('网盘内封面里出现了裸 downloadFile（绕过三级阶梯）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C（条三 + 条四后半）：落盘路径写回 + 封面走分发器
// ---------------------------------------------------------------------------

const writeBackInvariants = (code) => {
  const reasons = []

  const writeBack = slice(code, '    if (isWebDAVSource) {', '    if (!isBilibiliSource) {')
  if (!writeBack) {
    reasons.push('缺少 WebDAV 落盘路径写回块（下次播放又要为播放预下载一份）')
  } else if (!writeBack.includes('await updateWebDAVMusicMeta(task.musicInfo.id, { filePath: downloadedFilePath })')) {
    reasons.push('WebDAV 下载成功后没有把落盘路径写回歌曲 meta')
  }

  const ext = code.match(/const urlExtension = getFileExtensionFromUrl\([^)]*\)/)
  if (!ext) {
    reasons.push('扩展名推导那行抽取失败（锚点漂移）')
  } else if (!ext[0].includes('url || localSourcePath')) {
    reasons.push('扩展名没有覆盖本地复制路径（本地 flac 会被按任务音质存成 .mp3 再重命名）')
  }

  if (/\bgetPicUrl\b/.test(code)) {
    reasons.push('download.ts 里又出现 getPicUrl（在线专用；本地/WebDAV 歌曲在这一步永远拿不到封面）')
  }
  if (!code.includes("import { getMusicUrl, getLyricInfo, getPicPath } from '@/core/music'")) {
    reasons.push('没有从分发器导入 getPicPath')
  }

  const metaFn = slice(code, 'const handleMetadata = async(task: DownloadTask, filePath: string) => {', 'export const retryMetadata = async')
  if (!metaFn) {
    reasons.push('handleMetadata 抽取失败（锚点漂移）')
  } else {
    if (!metaFn.includes('const picSource = await getPicPath({ musicInfo: task.musicInfo')) {
      reasons.push('下载后的封面写入没有走分发器 getPicPath')
    }
    if (!metaFn.includes('if (!picSource) throw new Error(')) {
      reasons.push('封面为空时没有提前失败（会拿空路径去复制/写入）')
    }
    if (!metaFn.includes('if (isDownloadableUrl(picSource)) {')) {
      reasons.push('封面来源没有区分 http(s) 与本地路径（file:// 会进 downloadFile）')
    }
    if (!metaFn.includes('await copyFile(picSource, tempPicPath)')) {
      reasons.push('本地 / file:// 封面没有走 copyFile')
    }
  }

  const retryFn = slice(code, 'export const retryMetadata = async(taskId: string) => {', 'export const retryTask =')
  if (!retryFn) {
    reasons.push('retryMetadata 抽取失败（锚点漂移）')
  } else {
    if (!retryFn.includes('const picSource = await getPicPath({ musicInfo: task.musicInfo')) {
      reasons.push('「重试元信息」的封面没有走分发器 getPicPath')
    }
    if (!retryFn.includes('await copyFile(picSource, picPath)')) {
      reasons.push('「重试元信息」的本地 / file:// 封面没有走 copyFile')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 反例（对篡改后的源码跑同一套判断，必须被拦下）
// ---------------------------------------------------------------------------

const tamper = (src, find, replace) => {
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find.slice(0, 60)}`)
  return src.split(find).join(replace)
}

const runCounterExamples = () => {
  const results = []
  const check = (name, fn, expectReasonSubstr) => {
    let reasons = []
    try {
      reasons = fn()
    } catch (e) {
      results.push({ name, ok: false, detail: `抛异常: ${e.message}` })
      return
    }
    const hit = reasons.some(r => r.includes(expectReasonSubstr))
    results.push({ name, ok: hit, detail: hit ? '已拦下' : `未拦下（reasons=${JSON.stringify(reasons)}）` })
  }

  // c1 本地复制分支被摘掉（本地音乐又回到「把本地路径交给 downloadFile」）
  check('c1 本地复制分支被摘掉', () => transferInvariants(stripComments(tamper(REAL.download,
    '    if (localSourcePath) {',
    '    if (false && localSourcePath) {'))),
  '下载执行块抽取失败')

  // c2 getMusicUrl 分支的 isDownloadableUrl 兜底没了（又变回无条件交给 downloadFile）
  check('c2 来源兜底判断被摘掉', () => sourceTriageInvariants(stripComments(tamper(REAL.download,
    '    if (!isDownloadableUrl(url)) {',
    '    if (!url) {'))),
  '没有 isDownloadableUrl 兜底')

  // c3 WebDAV 在来源分流里不再独立（掉进 getMusicUrl ⇒ 拿回本地路径）
  check('c3 WebDAV 分流被摘掉', () => sourceTriageInvariants(stripComments(tamper(REAL.download,
    '  } else if (isWebDAVMusicInfo(task.musicInfo)) {',
    '  } else if (false) {'))),
  '没有 WebDAV 独立分支')

  // c4 WebDAV 下载退回裸 downloadFile（丢掉三级阶梯 —— 用户截图里的写法）
  check('c4 WebDAV 退回裸 downloadFile', () => transferInvariants(stripComments(tamper(REAL.download,
    '        await downloadWebDAVFile(url, downloadFilePath, { headers, progress: onProgress }, (t) => {',
    '        const downloadTask = downloadFile(url, downloadFilePath, { headers, progress: onProgress }, (t) => {'))),
  'WebDAV 没有走 downloadWebDAVFile')

  // c5 WebDAV 兜底复制被删（远端全挂就直接失败）
  check('c5 WebDAV 兜底复制被删', () => transferInvariants(stripComments(tamper(REAL.download,
    '        const cachedPath = await getMusicUrl({',
    '        const cachedPath = \'\''))),
  '没有回退到播放缓存')

  // c6 落盘路径不写回（下次播放又为播放预下载一份）
  check('c6 落盘路径不写回', () => writeBackInvariants(stripComments(tamper(REAL.download,
    '        await updateWebDAVMusicMeta(task.musicInfo.id, { filePath: downloadedFilePath })',
    '        void isWebDAVSource'))),
  '没有把落盘路径写回歌曲 meta')

  // c7 直链阶梯砍成一级（302 型服务器下不动）
  check('c7 阶梯砍成一级', () => ladderInvariants(stripComments(tamper(REAL.drive,
    '  const directUrl = await resolveWebDAVDirectUrl(url, headers)',
    "  const directUrl = ''"))),
  '缺少二级阶梯')

  // c8 直链解析没有 GET 兜底（不支持 HEAD 的服务器 405 收场）
  check('c8 直链解析缺 GET 兜底', () => ladderInvariants(stripComments(tamper(REAL.drive,
    "      method: 'GET',",
    "      method: 'HEAD',"))),
  '缺少 GET 兜底')

  // c9 完整 URL 的前置判断被删（会拼出 host/dav/https://… 的 404 地址）
  check('c9 完整 URL 前置判断被删', () => ladderInvariants(stripComments(tamper(REAL.drive,
    '  if (/^https?:\\/\\//i.test(remote)) return remote',
    '  // removed'))),
  '没有「remotePath 已是完整 URL 就直接返回」')

  // c10 播放预下载绕过阶梯
  check('c10 播放预下载绕过阶梯', () => ladderInvariants(stripComments(tamper(REAL.drive,
    '  await downloadWebDAVFile(downloadUrl, filePath, { headers: getWebDAVAuthHeaders() })',
    '  await downloadFile(downloadUrl, filePath, { headers: getWebDAVAuthHeaders() })'))),
  '播放预下载没有走统一直链阶梯')

  // c11 网盘内封面绕过阶梯
  check('c11 网盘封面绕过阶梯', () => ladderInvariants(stripComments(tamper(REAL.drive,
    '    await downloadWebDAVFile(url, localPath, { headers: getWebDAVAuthHeaders() })',
    '    await downloadFile(url, localPath, { headers: getWebDAVAuthHeaders() })'))),
  '网盘内封面没有走统一直链阶梯')

  // c12 半截文件清理被删（失败残留被当成「已下载」）
  check('c12 半截文件清理被删', () => ladderInvariants(stripComments(tamper(REAL.drive,
    'await unlink(localPath).catch(() => {})',
    'void localPath'))),
  '没有在每次尝试前清掉半截文件')

  // c13 封面退回在线专用 getPicUrl（本地/WebDAV 歌曲拿不到封面）
  check('c13 封面退回 getPicUrl', () => writeBackInvariants(stripComments(tamper(REAL.download,
    '      const picSource = await getPicPath({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline })',
    '      const picSource = await getPicUrl({ musicInfo: task.musicInfo as LX.Music.MusicInfoOnline } as any)'))),
  '又出现 getPicUrl')

  // c14 本地 / file:// 封面没走复制（file:// 进 downloadFile）
  check('c14 本地封面没走复制', () => writeBackInvariants(stripComments(tamper(REAL.download,
    '        await copyFile(picSource, tempPicPath)',
    '        await downloadFile(picSource, tempPicPath)'))),
  '本地 / file:// 封面没有走 copyFile')

  // c15 扩展名推导退回只看 url（本地复制路径没有扩展名来源）
  check('c15 扩展名只看 url', () => writeBackInvariants(stripComments(tamper(REAL.download,
    '  const urlExtension = getFileExtensionFromUrl(url || localSourcePath)',
    '  const urlExtension = getFileExtensionFromUrl(url)'))),
  '扩展名没有覆盖本地复制路径')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-webdav-download-local-path ===')
console.log('WebDAV 下载不再把本地路径当 fromUrl（unsupported URL 根因）+ 直链三级阶梯（302 型服务器）+ 失败回退播放缓存 + 落盘路径写回（第 26 轮）')
console.log()

const checks = [
  ['条一 下载按来源分流：WebDAV 走远端直链、本地走复制，无 scheme 路径绝不进 downloadFile', () => [
    ...sourceTriageInvariants(DL),
    ...transferInvariants(DL),
  ]],
  ['条二 drive.ts 三级直链阶梯（直下 → 解析 302 直链 → 抛错），播放预下载与网盘封面共用', () => ladderInvariants(DRV)],
  ['条三/条四 WebDAV 失败回退播放缓存；成功后落盘路径写回 meta；封面改走分发器 getPicPath', () => writeBackInvariants(DL)],
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
    reasons.forEach(r => console.log('  FAIL ' + r))
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
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${passCount.length}/${checks.length}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
