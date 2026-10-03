#!/usr/bin/env node
/**
 * sim-webdav-menu-download-ladder.js —— WebDAV「下载还是不行」契约（第 28 轮）。
 *
 * 需求原话（2026-10-03 第 28 轮，附 [WebDAV] 过滤后的日志片段 +「这是第二次点击下载」）：
 *   「WebDAV的下载还是不行：
 *     17:27:19 getMusicUrl called {"isDownload":false,"source":"local","musicId":"webdav_/WebDav/music/
 *       Nothings Going to Change My Love For You - Westlife.flac"}
 *     17:27:29 getMusicUrl: WebDAV downloaded to local for playback {"musicId":"...Westlife.flac"}
 *     17:26:43 downloadFile: File not found on server: /WebDav/music/playlists.json 」
 *   随后补充：「downloadFile: File not found on server: /WebDav/music/playlists.json，这个有问题，
 *     歌曲我是直接歌名存在WebDAV里面的，直接获取直链下载链接就可以了」
 *
 * 根因（读源码得出，本机无编译/真机环境，没有在 App 里跑过 —— 已在改动清单如实交代）：
 *   ① 第 26 轮只把 core/download.ts（下载管理）接进了「直下 → 解析 302 直链 → 抛错」三级阶梯。
 *      WebDAVListAction.ts 的 handleWebDAVBatchDownload / handleWebDAVDownload 这两处**菜单下载**
 *      仍是裸的 `await downloadFile(getWebDAVDownloadUrl(x), path, { headers }).promise` ——
 *      同一份 URL，播放预下载（走阶梯）能成功、菜单下载（不走阶梯）就失败。
 *   ② 更致命的是「文件是否已下载」四处都只看 existsFile（核对用户日志后确认这就是「点了没反应」）：
 *      RNFS 的 downloadFile **直接写目标路径**，中断/取消/断网会在原地留一个半截文件，此后
 *      existsFile 永远为真 → 下载被静默跳过（用户日志里点完两次一行下载日志都没有，就是这个），
 *      播放也直接把这个坏文件交给播放器（「播一下就停」）。这四处是：
 *        · local.ts getMusicUrl 的用户已下载文件 · drive.ts downloadWebDAVMusic 的播放缓存
 *        · WebDAVListAction 的批量下载 · WebDAVListAction 的单曲下载
 *   ③ 单曲「下载」成功路径**零反馈**：不打日志、不弹提示、不写「下载列表」——用户判断成功的依据
 *      就是下载列表里有没有这首歌，所以即使下成功了他也只会说「下载还是不行」。
 *   ④ 「一首都没成功」时 handleWebDAVDownloadAndImport 直接 return、**不清 setLoadingText**：
 *      标题上「正在下载 0/N...」永久留着，而「扫描并下载」按钮的 disabled 条件里带
 *      `!!batchLoadingText` —— 从此整个下载功能点不动，只能重启 App。
 *   ⑤ 用户指着的那行 `downloadFile: File not found on server: /WebDav/music/playlists.json` 其实
 *      来自**歌单同步**（utils/webdav.ts downloadFile 探远端 playlists.json，首次同步远端本来就没有，
 *      紧接着就会上传本地状态），不是歌曲下载失败；原日志措辞让人必然误读，本轮改成自解释的写法。
 *   ⑥ 顺带收口第 27 轮埋的隐患：WebDAV 封面兜底搜索是按**列表每一行**触发的、无并发上限、失败不记账，
 *      325 首的列表一进页面就是几百个 findMusic（用户日志 17:25:14 那一片失败就是这么来的）。
 *
 * 为什么必须靠契约脚本：上面全是「形状 / 顺序 / 上限 / 调用点」而非类型 —— 把裸 downloadFile 放回来、
 * 把阶梯删掉、把半截文件判定退回 existsFile、把入口日志挪到权限判断之后、把 addListMusics 删掉、
 * 把 setLoadingText('') 删掉、把并发闸拆掉、把失败记账删掉，tsc/eslint 全绿，只在真机上表现为
 * 「点了没反应 / 播一下就停 / 按钮永久灰掉 / 一进列表几百个请求」。带反例自检。
 *
 * 运行：node scripts/sim-webdav-menu-download-ladder.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去块注释与整行 `//` 注释：本文件要看的代码里含 `// 这里原本是裸的 downloadFile(...)` 这类
// 说明性注释，朴素地删 `//[^\n]*` 会把 `file://${picPath}` 这种字符串字面量从中间切断。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const SRC = path.join(ROOT, 'src')

// ---------------------------------------------------------------------------
// 全仓文件表（条一的 sweep 用）
// ---------------------------------------------------------------------------
// 递归列出 src 下的 .ts/.tsx。
// 这里**故意不用** fs.readdirSync(dir, { withFileTypes: true }) + entry.isDirectory()：本仓库的 JS
// 契约运行器（浏览器里跑，fs 是 XHR 打的桩）对 readdirSync 的 withFileTypes 实现有 bug —— 它每个
// entry 的 isDirectory() 闭包共享同一个 var，目录列表里只要最后一项是目录，全部 entry 都会
// isDirectory()===true（实测 /src 下 app.ts 也返回 true），于是递归会一头扎进 /src/app.ts 报
// ENOENT。用「有没有扩展名」来区分文件/目录，两种环境下都对，也不依赖任何 isDirectory。
const listSrcFiles = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.' || name === '..') continue
    const full = path.join(dir, name)
    if (/\.(ts|tsx)$/.test(name)) {
      out.push(full)
      continue
    }
    if (!/\./.test(name)) {
      listSrcFiles(full, out)
      continue
    }
    // 带点又不是 .ts/.tsx：正常是 .json/.png 这类资源文件（跳过）。极少数情况可能是「名字里带点的
    // 目录」，那才用 statSync 兜一下 —— 只当正向补充信号，不依赖它来判断普通目录。
    try {
      if (fs.statSync(full).isDirectory()) listSrcFiles(full, out)
    } catch (e) {}
  }
  return out
}

const countOf = (haystack, needle) => haystack.split(needle).length - 1

// ---------------------------------------------------------------------------
// 切片工具（锚点漂移必须报 FAIL，不能静默放行）
// ---------------------------------------------------------------------------
const sliceBetween = (src, from, to) => {
  if (typeof src !== 'string') return null
  const i = src.indexOf(from)
  if (i < 0) return null
  const j = src.indexOf(to, i + from.length)
  if (j <= i) return null
  return src.slice(i, j)
}

// WebDAVListAction：批量下载 / 单曲下载 / 调用方「下载并导入」三个函数体
const batchFn = (code) => sliceBetween(code, 'export const handleWebDAVBatchDownload = async(', 'export const handleWebDAVDownloadAndImport = async(')
const singleFn = (code) => sliceBetween(code, 'export const handleWebDAVDownload = async(', 'export const handleFetchWebDAVPicFromOnline = async(')
const importFn = (code) => sliceBetween(code, 'export const handleWebDAVDownloadAndImport = async(', 'const getDefaultDownloadDir = () => {')

// drive.ts：完整性判定 helper / 播放缓存那一段
const stateHelper = (code) => sliceBetween(code, 'export const getWebDAVFileState = async(', '\n}\n')
const cacheRegion = (code) => sliceBetween(code, 'const filePath = `${cacheDir}/${stringMd5(remotePath)}.${ext}`', 'await mkdir(cacheDir)')

// local.ts：getMusicUrl 的 WebDAV 分支（到普通本地分支的 `if (!isRefresh) {` 为止）
const playbackBranch = (code) => sliceBetween(
  code,
  "const isWebDAV = 'webdav' in musicInfo.meta",
  '\n  if (!isRefresh) {\n    const path = await getLocalFilePath(musicInfo)',
)

// local.ts：getPicUrl 的 WebDAV 分支（沿用第 27 轮那套锚点：第一处 isWebDAVMusic 标记 → onToggleSource() 调用行）
const webdavPicOnly = (rawLocal) => {
  const branch = sliceBetween(
    rawLocal,
    "const isWebDAVMusic = 'webdav' in musicInfo.meta",
    'const getMusicFileLyric = async(filePath: string) => {',
  )
  if (!branch) return null
  const cut = branch.indexOf('\n  onToggleSource()\n')
  return cut < 0 ? null : branch.slice(0, cut)
}

// local.ts：封面搜索收敛闸那一段
const coverLimiter = (code) => sliceBetween(code, 'const WEBDAV_COVER_SEARCH_CONCURRENCY', 'const getOtherSourceByLocal = async <T>(')

const FILES = {
  action: 'src/screens/Home/Views/WebDAV/WebDAVListAction.ts',
  drive: 'src/core/webdavMusic/drive.ts',
  local: 'src/core/music/local.ts',
  download: 'src/core/download.ts',
  webdavUtil: 'src/utils/webdav.ts',
  page: 'src/screens/Home/Views/WebDAV/index.tsx',
}

const REAL = {}
for (const [key, file] of Object.entries(FILES)) REAL[key] = read(file)

// ---------------------------------------------------------------------------
// 不变量 ①（条一）：两处菜单下载都走统一阶梯 + 单曲下载有可见结果 + 调用方收拾状态
// ---------------------------------------------------------------------------
const menuLadderInvariants = (rawAction) => {
  const reasons = []
  const code = stripComments(rawAction)

  // 文件级：不能再出现裸的 RNFS downloadFile（第 26 轮的阶梯不能被绕开）
  const bare = countOf(code, 'downloadFile(')
  if (bare !== 0) {
    reasons.push('WebDAVListAction 里还有 ' + bare + ' 处裸的 downloadFile( 调用（绕过 302 直链阶梯）')
  }
  const ladderCalls = countOf(code, 'downloadWebDAVFile(')
  if (ladderCalls < 2) {
    reasons.push('downloadWebDAVFile( 调用点不足：只有 ' + ladderCalls + ' 处（批量 / 单曲各一处）')
  }

  // 导入面：阶梯 + 鉴权头 + 完整性判定都必须来自 drive（单一来源）
  const importLine = code.match(/^import \{[^}]*\} from '@\/core\/webdavMusic\/drive'$/m)
  if (!importLine) {
    reasons.push('没有从 @/core/webdavMusic/drive 导入（阶梯/鉴权头/完整性判定都在那里）')
  } else {
    for (const sym of ['downloadWebDAVFile', 'getWebDAVAuthHeaders', 'getWebDAVFileState']) {
      if (!importLine[0].includes(sym)) reasons.push('drive 的导入里缺 ' + sym)
    }
  }
  if (code.includes('btoa(') || code.includes("'Basic '")) {
    reasons.push('WebDAVListAction 又自建了一份 Basic Auth（应统一用 drive 的 getWebDAVAuthHeaders）')
  }
  if (code.includes('const getAuthHeaders')) {
    reasons.push('本地 getAuthHeaders 又回来了（两份鉴权头容易走偏，已经统一到 drive）')
  }

  const batch = batchFn(code)
  const single = singleFn(code)
  const pairs = [['批量', batch], ['单曲', single]]
  for (const [label, fn] of pairs) {
    if (!fn) {
      reasons.push(label + '下载函数切片失败（锚点漂移：export const handleWebDAV*）')
      continue
    }
    if (!fn.includes('downloadWebDAVFile(')) reasons.push(label + '下载没有走 downloadWebDAVFile（阶梯）')
    if (!fn.includes('getWebDAVAuthHeaders()')) reasons.push(label + '下载没有用 drive 的 getWebDAVAuthHeaders()')
    if (!fn.includes('{ headers }')) reasons.push(label + '下载没有把鉴权 headers 传给底层')
    if (!fn.includes('getWebDAVFileState(')) reasons.push(label + '下载没有做「半截文件」判定（getWebDAVFileState）')
    if (!fn.includes('unlink(')) reasons.push(label + '下载发现半截文件后没有删掉重下')
    if (fn.includes('existsFile(')) reasons.push(label + '下载里又出现了裸 existsFile（完整性判定必须走 getWebDAVFileState）')
    const mk = fn.indexOf('mkdir(')
    const dl = fn.indexOf('downloadWebDAVFile(')
    if (mk < 0 || dl < 0 || mk > dl) reasons.push(label + '下载没有先 mkdir 再下载')
  }

  if (batch) {
    // 入口日志必须排在权限检查之前：否则「权限不足」的提前 return 在日志里零痕迹
    const invoked = batch.indexOf(': invoked')
    const perm = batch.indexOf('requestStoragePermission()')
    if (invoked < 0) reasons.push('批量下载入口没有落日志（点了下载日志里什么都看不到）')
    else if (perm >= 0 && invoked > perm) reasons.push('批量下载的入口日志排在权限检查之后（权限不足时仍无痕迹）')
    if (!batch.includes('failures.push(')) reasons.push('批量下载没有逐首汇总失败原因')
    if (!batch.includes('toast(`下载失败：${failures[0]}`')) {
      reasons.push('批量全失败时没有把具体原因告诉用户（仍是一句笼统提示）')
    }
  }

  if (single) {
    if (!single.includes(': invoked')) reasons.push('单曲下载入口没有落日志')
    // 单曲下载成功必须进「下载列表」：用户判断下载成没成就看那里
    if (!single.includes('addListMusics(')) reasons.push('单曲下载成功后没有写进下载列表（用户看不到任何结果）')
    if (!single.includes('LIST_IDS.DOWNLOAD')) reasons.push('单曲下载写列表时用的不是 LIST_IDS.DOWNLOAD')
    if (!single.includes('buildLocalMusicInfoByFilePath(filePath)')) {
      reasons.push('单曲下载写列表用的不是 buildLocalMusicInfoByFilePath（缺 meta.filePath，播放会找不到文件）')
    }
    if (!single.includes('toast(justDownloaded') && !single.includes('toast(')) {
      reasons.push('单曲下载成功后没有任何提示')
    }
  }

  // 调用方：一首都没成功时必须清掉 loading text（否则按钮永久 disabled）
  const imp = importFn(code)
  if (!imp) {
    reasons.push('handleWebDAVDownloadAndImport 切片失败（锚点漂移）')
  } else {
    const zero = imp.indexOf('downloadedPaths.length === 0')
    if (zero < 0) {
      reasons.push('handleWebDAVDownloadAndImport 里没有「一首都没成功」的分支（切片或逻辑变了）')
    } else {
      const region = imp.slice(zero, zero + 600)
      if (!region.includes("setLoadingText('')")) {
        reasons.push('「一首都没成功」分支没有清 setLoadingText（标题卡住 + 扫描并下载按钮永久禁用）')
      }
      if (region.includes("toast('没有成功下载任何歌曲')")) {
        reasons.push('又把没有原因的笼统提示放回来了（且会和批量里的具体原因叠成两条 toast）')
      }
    }
  }

  // 前提校验：按钮 disabled 依赖 batchLoadingText —— 这条链变了就该回来复核上面的断言
  const page = stripComments(REAL.page)
  if (!page.includes('!!batchLoadingText')) {
    reasons.push('前提变了：index.tsx 的「扫描并下载」按钮 disabled 条件里没有 batchLoadingText，请复核 loading text 断言')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 ②（条二）：全仓不能再有「只 existsFile 就当已下载」的 WebDAV 判断
// ---------------------------------------------------------------------------
const completenessInvariants = (rawDrive, rawLocal, rawAction) => {
  const reasons = []
  const drive = stripComments(rawDrive)
  const local = stripComments(rawLocal)
  const action = stripComments(rawAction)

  // ① drive 里的三态判定：missing / incomplete / complete，带容差，拿不到期望大小就退回旧行为
  if (!/export type WebDAVFileState = 'missing' \| 'incomplete' \| 'complete'/.test(drive)) {
    reasons.push('drive 没有导出 WebDAVFileState 三态类型（本地文件的完整性口径必须唯一）')
  }
  const helper = stateHelper(drive)
  if (!helper) {
    reasons.push('getWebDAVFileState 切片失败（锚点漂移）')
  } else {
    for (const [needle, why] of [
      ["return 'missing'", '没有「文件不存在」这一态'],
      // 半截那一态是三元表达式里的 `: 'incomplete'`，不一定写成 return，按字面量断言
      ["'incomplete'", '没有「半截文件」这一态'],
      ["return 'complete'", '没有「完整」这一态'],
      ['existsFile(', '没有先判断文件存在'],
      ['expectedSize * 0.99', '没有按远端 size 做字节数容差判定'],
    ]) {
      if (!helper.includes(needle)) reasons.push('getWebDAVFileState ' + why)
    }
    if (!helper.includes("if (!expectedSize || expectedSize <= 0) return 'complete'")) {
      reasons.push('getWebDAVFileState 拿不到期望大小时没有退回「存在即完整」的旧行为（会误删好文件重下）')
    }
    if (!helper.includes('stat(')) reasons.push('getWebDAVFileState 没有用 stat 读实际字节数')
  }

  // ② 播放缓存：命中要三态判定 + 单独日志 + 半截先删
  const cache = cacheRegion(drive)
  if (!cache) {
    reasons.push('downloadWebDAVMusic 的缓存段切片失败（锚点漂移）')
  } else {
    if (!cache.includes('getWebDAVFileState(')) {
      reasons.push('播放缓存命中没有做完整性判定（半截缓存会被当成命中直接交给播放器）')
    }
    if (cache.includes('existsFile(')) reasons.push('播放缓存里又用回了裸 existsFile')
    if (!cache.includes("cacheState === 'incomplete'")) reasons.push('半截缓存没有识别出来')
    if (!cache.includes('unlink(')) reasons.push('半截缓存没有删掉重下')
    if (!cache.includes("webDAVLog.info('downloadWebDAVMusic: cache hit'")) {
      reasons.push('缓存命中没有单独日志（日志里分不出「命中缓存」和「真下载」）')
    }
  }

  // ③ 播放：用户的已下载文件必须先验完整性
  const play = playbackBranch(local)
  if (!play) {
    reasons.push('getMusicUrl 的 WebDAV 分支切片失败（锚点漂移）')
  } else {
    if (!play.includes('module.getWebDAVFileState(')) {
      reasons.push('播放用户的已下载文件前没有做完整性判定（半截文件会直接进播放器）')
    }
    if (play.includes('existsFile(')) reasons.push('播放分支里还有裸 existsFile')
    if (!play.includes("fileState === 'incomplete'")) reasons.push('半截下载文件没有识别出来')
    if (!play.includes('unlink(')) reasons.push('半截下载文件没有删掉（会一直挡着后面的预下载）')
    const loadCalls = countOf(play, 'loadWebDAVModule()')
    if (loadCalls !== 1) {
      reasons.push('WebDAV 播放分支里 loadWebDAVModule() 出现 ' + loadCalls + ' 次（重复 const module 声明会直接编译不过）')
    }
    if (!play.includes('downloadWebDAVMusic(')) reasons.push('播放分支没有预下载兜底')
  }

  // ④ 两处菜单下载已在不变量①里断言（getWebDAVFileState + unlink + 无 existsFile）
  const batch = batchFn(action)
  const single = singleFn(action)
  if (!batch || !single) {
    reasons.push('WebDAVListAction 两个下载函数切片失败（锚点漂移）')
  } else {
    if (batch.includes('existsFile(')) reasons.push('批量下载里还有裸 existsFile')
    if (single.includes('existsFile(')) reasons.push('单曲下载里还有裸 existsFile')
  }

  // ⑤ 全仓 sweep：任何 downloadFile 调用，其参数里不许直接出现 WebDAV 地址
  // 传进来的三份文本（可能被反例篡改）要盖回磁盘内容上：否则「在 action 里插一句裸 downloadFile」
  // 这种反例扫的是磁盘原文，永远扫不出来（见反例 c20）。
  const overrides = {
    [FILES.action]: rawAction,
    [FILES.drive]: rawDrive,
    [FILES.local]: rawLocal,
  }
  const sweepSrc = (full) => {
    const rel = path.relative(ROOT, full).replace(/\\/g, '/')
    const raw = overrides[rel] === undefined ? fs.readFileSync(full, 'utf8') : overrides[rel]
    return { rel, src: stripComments(raw.replace(/\r\n/g, '\n')) }
  }
  const offenders = []
  for (const full of listSrcFiles(SRC)) {
    const { rel, src } = sweepSrc(full)
    let idx = src.indexOf('downloadFile(')
    while (idx >= 0) {
      const before = src.slice(Math.max(0, idx - 12), idx)
      const isDefinition = /function\s+$/.test(before) || /const\s+$/.test(before)
      const isOtherObject = /\.$/.test(before) || /RNFS\./.test(src.slice(Math.max(0, idx - 6), idx))
      // 取这次调用的实参文本（配平括号）
      let depth = 0
      let end = -1
      for (let k = idx + 'downloadFile('.length - 1; k < src.length; k++) {
        const ch = src[k]
        if (ch === '(') depth++
        else if (ch === ')') {
          depth--
          if (depth === 0) { end = k; break }
        }
      }
      const args = end > 0 ? src.slice(idx, end + 1) : src.slice(idx, idx + 200)
      if (!isDefinition && !isOtherObject && /webdav|WebDAV|getWebDAVDownloadUrl/.test(args)) {
        offenders.push(rel + ':' + (src.slice(0, idx).split('\n').length) + ' → ' + args.replace(/\s+/g, ' ').slice(0, 90))
      }
      idx = src.indexOf('downloadFile(', idx + 1)
    }
  }
  if (offenders.length) {
    reasons.push('还有 downloadFile 直接拿 WebDAV 地址下载（应走 downloadWebDAVFile 阶梯）：' + offenders.join(' | '))
  }

  // 全仓 sweep：阶梯调用点不能少于 4 处（download.ts + drive.ts + 菜单两处）
  let ladderTotal = 0
  for (const full of listSrcFiles(SRC)) {
    ladderTotal += countOf(sweepSrc(full).src, 'downloadWebDAVFile(')
  }
  if (ladderTotal < 4) {
    reasons.push('全仓 downloadWebDAVFile( 调用点只有 ' + ladderTotal + ' 处（下载管理 / 播放预下载 / 菜单批量 / 菜单单曲）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 ③（条三）：日志必须自解释 —— 同步的 404 不许再被读成「歌曲下载失败」
// ---------------------------------------------------------------------------
const logInvariants = (rawUtil, rawDrive, rawLocal) => {
  const reasons = []
  const util = stripComments(rawUtil)
  if (util.includes('File not found on server')) {
    reasons.push('utils/webdav.ts 那句「File not found on server」又回来了（它属于歌单同步的首次探测，会被读成歌曲下载失败）')
  }
  if (!util.includes('[Sync] remote lists file not found')) {
    reasons.push('utils/webdav.ts 的同步 404 日志没有标明这是同步文件（不是歌曲下载）')
  }
  if (!util.includes('normal on first sync')) {
    reasons.push('utils/webdav.ts 的同步 404 日志没有说明「首次同步属正常」')
  }
  if (!util.includes('songs are downloaded via the music module')) {
    reasons.push('utils/webdav.ts 的同步 404 日志没有指出歌曲下载走的是音乐模块（用户就是在这里误读了）')
  }
  // 播放日志要能区分「命中缓存」与「真下载」
  const drive = stripComments(rawDrive)
  if (!drive.includes("'downloadWebDAVMusic: cache hit'")) {
    reasons.push('播放缓存命中没有日志（调用方那行 downloaded to local for playback 命中缓存时也照打，日志分不出真假下载）')
  }
  const local = stripComments(rawLocal)
  if (!local.includes('getMusicUrl: incomplete downloaded file removed')) {
    reasons.push('播放发现半截下载文件时的告警日志缺失（用户日志里会毫无痕迹）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 ④（条四）：封面兜底搜索的并发闸 + 失败记账（第 27 轮遗留的请求风暴）
// ---------------------------------------------------------------------------
const coverStormInvariants = (rawLocal) => {
  const reasons = []
  const code = stripComments(rawLocal)

  const limiter = coverLimiter(code)
  if (!limiter) {
    reasons.push('封面搜索收敛闸切片失败（锚点漂移：WEBDAV_COVER_SEARCH_CONCURRENCY）')
  } else {
    const m = limiter.match(/const WEBDAV_COVER_SEARCH_CONCURRENCY = (\d+)/)
    if (!m) reasons.push('没有 WEBDAV_COVER_SEARCH_CONCURRENCY 并发上限')
    else if (Number(m[1]) < 1 || Number(m[1]) > 4) {
      reasons.push('封面搜索并发上限不在 (0, 4] 内：' + m[1] + '（列表逐行触发，放大会打回请求风暴）')
    }
    if (!/const WEBDAV_COVER_MISS_CACHE_MAX = (\d+)/.test(limiter)) {
      reasons.push('失败备忘没有条数上限')
    } else {
      const max = Number(limiter.match(/const WEBDAV_COVER_MISS_CACHE_MAX = (\d+)/)[1])
      if (max < 10 || max > 1000) reasons.push('失败备忘上限不在 [10, 1000] 内：' + max)
    }
    if (!limiter.includes('new Set<string>()')) reasons.push('失败备忘不是 Set')
    if (!limiter.includes('webdavCoverSearchMisses.size >= WEBDAV_COVER_MISS_CACHE_MAX')) {
      reasons.push('失败备忘满了没有清空策略（会无限增长）')
    }
    if (!limiter.includes('acquireWebdavCoverSearch')) reasons.push('没有取并发名额的函数')
    if (!limiter.includes('releaseWebdavCoverSearch')) reasons.push('没有还并发名额的函数')
    if (!limiter.includes('webdavCoverSearchQueue.push(')) reasons.push('超限时没有排队')
    if (!limiter.includes('webdavCoverSearchQueue.shift()')) reasons.push('释放名额时没有把名额转交给排队者')
    // 记账必须真的写进 Set（光有 markWebdavCoverMiss(musicInfo) 这个调用点不够，
    // 函数体里不 add，下一轮照样重发 —— 见反例 c16）
    if (!limiter.includes('webdavCoverSearchMisses.add(')) {
      reasons.push('失败备忘没有记账（markWebdavCoverMiss 里没往 Set 里 add，刷新一次照样重发一整轮）')
    }
  }

  const branch = webdavPicOnly(code)
  if (!branch) {
    reasons.push('getPicUrl 的 WebDAV 分支切片失败（锚点漂移：isWebDAVMusic 标记 / onToggleSource() 行）')
    return reasons
  }
  // 能力不许回退：搜索兜底本身还在
  if (!branch.includes('getOtherSourceByLocal(musicInfo')) {
    reasons.push('WebDAV 封面搜索兜底被删了（第 27 轮的能力回退）')
  }
  const missCheck = branch.indexOf('webdavCoverSearchMisses.has(')
  const acquire = branch.indexOf('acquireWebdavCoverSearch()')
  if (missCheck < 0) {
    reasons.push('封面分支没有先查失败备忘（同一次会话里会反复重发必然失败的搜索）')
  } else if (acquire >= 0 && missCheck > acquire) {
    reasons.push('失败备忘的查询排在取并发名额之后（等于没省，照样排队照样搜）')
  }
  if (acquire < 0) reasons.push('封面搜索没有进并发闸')
  if (!branch.includes('releaseWebdavCoverSearch()')) reasons.push('并发名额没有归还')
  if (!/\} finally \{[\s\S]*releaseWebdavCoverSearch\(\)/.test(branch)) {
    reasons.push('并发名额没有在 finally 里归还（一次抛错就永久漏一个名额）')
  }
  if (!branch.includes('markWebdavCoverMiss(musicInfo)')) {
    reasons.push('搜索失败没有记账（下次进列表/刷新还会为同一首歌重发）')
  }
  if (!branch.includes("return ''")) {
    reasons.push('WebDAV 封面兜底失败后没有收口在空字符串（会把 undefined 抛给列表）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
const tamper = (src, from, to) => {
  if (!src.includes(from)) throw new Error('反例锚点未命中: ' + from.slice(0, 80))
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

  // c1 菜单下载又改成裸 downloadFile
  check('c1 菜单下载退回裸 downloadFile',
    menuLadderInvariants(tamper(REAL.action,
      '        const usedUrl = await downloadWebDAVFile(downloadUrl, filePath, { headers })',
      '        await downloadFile(downloadUrl, filePath, { headers }).promise\n        const usedUrl = downloadUrl')),
    'downloadWebDAVFile( 调用点不足')

  // c2 阶梯还在，但不再传 headers
  check('c2 下载不传鉴权 headers',
    menuLadderInvariants(tamper(REAL.action,
      '        const usedUrl = await downloadWebDAVFile(downloadUrl, filePath, { headers })',
      '        const usedUrl = await downloadWebDAVFile(downloadUrl, filePath, {})')),
    '没有把鉴权 headers 传给底层')

  // c3 半截文件判定退回 existsFile
  check('c3 批量下载退回 existsFile',
    menuLadderInvariants(tamper(REAL.action,
      '      const fileState = await getWebDAVFileState(filePath, musicInfo.meta.size)',
      '      const fileState = (await existsFile(filePath)) ? \'complete\' : \'missing\'')),
    'existsFile')

  // c4 半截文件不删
  check('c4 半截文件不删重下',
    menuLadderInvariants(tamper(REAL.action,
      '        await unlink(filePath).catch(() => {})\n      }\n\n      if (musicInfo.meta.filePath && !fileExists) {',
      '      }\n\n      if (musicInfo.meta.filePath && !fileExists) {')),
    '没有删掉重下')

  // c5 批量入口日志挪到权限检查之后
  check('c5 入口日志挪到权限检查之后',
    menuLadderInvariants(tamper(REAL.action,
      "  webDAVLog.info('handleWebDAVBatchDownload: invoked', { songCount: songs.length })",
      "  // invoked log moved\n  const __keep = songs.length")),
    '入口没有落日志')

  // c6 单曲下载删掉「写进下载列表」
  check('c6 单曲下载不写下载列表',
    menuLadderInvariants(tamper(REAL.action,
      '    await addListMusics(\n      LIST_IDS.DOWNLOAD,\n      [buildLocalMusicInfoByFilePath(filePath)],',
      '    await Promise.resolve([\n      LIST_IDS.DOWNLOAD,\n      [buildLocalMusicInfoByFilePath(filePath)],')),
    '没有写进下载列表')

  // c7 一首都没成功时不清 loading text
  check('c7 不清 loading text',
    menuLadderInvariants(tamper(REAL.action,
      "      webDAVLog.warn('handleWebDAVDownloadAndImport: nothing downloaded, clearing loading text')\n      setLoadingText('')",
      "      webDAVLog.warn('handleWebDAVDownloadAndImport: nothing downloaded')")),
    '没有清 setLoadingText')

  // c8 批量失败时又不给原因
  check('c8 全失败不给原因',
    menuLadderInvariants(tamper(REAL.action,
      '        toast(`下载失败：${failures[0]}`, \'long\')',
      '        toast(\'没有成功下载任何歌曲\', \'long\')')),
    '没有把具体原因告诉用户')

  // c9 drive 完整性判定退回「存在即完整」
  check('c9 完整性判定退回存在即完整',
    completenessInvariants(tamper(REAL.drive,
      "  if (!expectedSize || expectedSize <= 0) return 'complete'",
      '  if (!expectedSize || expectedSize <= 0) return false'),
    REAL.drive, REAL.action),
    '退回「存在即完整」')

  // c10 播放缓存退回裸 existsFile
  check('c10 播放缓存退回 existsFile',
    completenessInvariants(tamper(REAL.drive,
      '  const cacheState = await getWebDAVFileState(filePath, musicInfo.meta.size)',
      '  const cacheState = (await existsFile(filePath)) ? \'complete\' : \'missing\''),
    REAL.local, REAL.action),
    '没有做完整性判定')

  // c11 播放分支退回裸 existsFile
  check('c11 播放分支退回 existsFile',
    completenessInvariants(REAL.drive, tamper(REAL.local,
      '      const fileState = await module.getWebDAVFileState(webDAVMusicInfo.meta.filePath, webDAVMusicInfo.meta.size)',
      '      const fileState = (await existsFile(webDAVMusicInfo.meta.filePath)) ? \'complete\' : \'missing\''),
    REAL.action),
    'existsFile')

  // c12 播放分支重复声明 module（编译不过的那种写法）
  check('c12 播放分支重复声明 module',
    completenessInvariants(REAL.drive, tamper(REAL.local,
      '    const localPath = await module.downloadWebDAVMusic(webDAVMusicInfo)',
      '    const module = await loadWebDAVModule()\n    const localPath = await module.downloadWebDAVMusic(webDAVMusicInfo)'),
    REAL.action),
    '重复 const module')

  // c13 同步 404 日志改回误导措辞
  check('c13 同步日志改回误导措辞',
    logInvariants(tamper(REAL.webdavUtil,
      '[Sync] remote lists file not found (normal on first sync; songs are downloaded via the music module): ${path}',
      'downloadFile: File not found on server: ${path}'),
    REAL.drive, REAL.local),
    'File not found on server')

  // c14 缓存命中日志删掉（日志又分不出真假下载）
  check('c14 缓存命中日志删掉',
    logInvariants(REAL.webdavUtil, tamper(REAL.drive,
      "    webDAVLog.info('downloadWebDAVMusic: cache hit', { filePath })\n",
      ''), REAL.local),
    '缓存命中没有日志')

  // c15 并发闸上限放大（请求风暴回来）
  check('c15 并发上限放大',
    coverStormInvariants(tamper(REAL.local,
      'const WEBDAV_COVER_SEARCH_CONCURRENCY = 2',
      'const WEBDAV_COVER_SEARCH_CONCURRENCY = 200')),
    '并发上限不在 (0, 4] 内')

  // c16 失败备忘删掉（滚动一次又重发一轮）
  check('c16 失败备忘删掉',
    coverStormInvariants(tamper(REAL.local,
      '  webdavCoverSearchMisses.add(getWebdavCoverMissKey(musicInfo))',
      '  void getWebdavCoverMissKey(musicInfo)')),
    '没有记账')

  // c17 备忘查询排在取名额之后（等于没省）
  // 反例形态就是「把取名额提到查备忘前面」：锚点跟着第 28 轮最终结构（备忘判定是 if/else，
  // 取名额在 else 里），把 acquire 那一行挪到 if 之前。
  check('c17 备忘查询顺序反了',
    coverStormInvariants(tamper(REAL.local,
      "    if (webdavCoverSearchMisses.has(getWebdavCoverMissKey(musicInfo))) {\n      webDAVLog?.info('getPicUrl: WebDAV cover search skipped (known miss)', { musicId: musicInfo.id })\n    } else {\n      // 【第 28 轮】没搜过的进并发闸，最多 WEBDAV_COVER_SEARCH_CONCURRENCY 个搜索同时飞\n      await acquireWebdavCoverSearch()",
      '    await acquireWebdavCoverSearch()\n    if (webdavCoverSearchMisses.has(getWebdavCoverMissKey(musicInfo))) {\n      webDAVLog?.info(\'getPicUrl: WebDAV cover search skipped (known miss)\', { musicId: musicInfo.id })\n    } else {')),
    '排在取并发名额之后')

  // c18 finally 里不还名额
  check('c18 不还并发名额',
    coverStormInvariants(tamper(REAL.local,
      '      } finally {\n        releaseWebdavCoverSearch()\n      }',
      '      } catch (e) {\n        releaseWebdavCoverSearch()\n      }')),
    '归还')

  // c19 单曲下载不再把歌写进下载列表（用 buildLocalMusicInfo 冒充）
  check('c19 单曲写列表用了错的构造函数',
    menuLadderInvariants(tamper(REAL.action,
      '      [buildLocalMusicInfoByFilePath(filePath)],',
      '      [buildLocalMusicInfo(filePath, null, null)],')),
    '缺 meta.filePath')

  // c20 全仓 sweep：别处又出现「拿 WebDAV 地址裸下」
  check('c20 别处裸下 WebDAV 地址',
    completenessInvariants(REAL.drive, REAL.local, tamper(REAL.action,
      '        const downloadUrl = getWebDAVDownloadUrl(musicInfo)',
      '        const downloadUrl = getWebDAVDownloadUrl(musicInfo)\n        await downloadFile(getWebDAVDownloadUrl(musicInfo), filePath, { headers }).promise')),
    '还有 downloadFile 直接拿 WebDAV 地址下载')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-webdav-menu-download-ladder ===')
console.log('WebDAV 菜单下载：统一 302 直链阶梯（不再有裸 downloadFile）、半截文件不再当已下载、')
console.log('单曲下载写入下载列表、失败给原因、按钮不再被卡死的 loading text 锁住、')
console.log('同步日志不再冒充「歌曲下载失败」、封面兜底搜索有并发闸与失败记账（第 28 轮）')
console.log()

const checks = [
  ['条一 两处菜单下载走统一阶梯 + 单曲下载有可见结果 + 调用方清 loading text', () => menuLadderInvariants(REAL.action)],
  ['条二 全仓不再「只 existsFile 就当已下载」（三态判定统一在 drive）', () => completenessInvariants(REAL.drive, REAL.local, REAL.action)],
  ['条三 日志自解释：同步 404 ≠ 歌曲下载失败，缓存命中可区分', () => logInvariants(REAL.webdavUtil, REAL.drive, REAL.local)],
  ['条四 封面兜底搜索有并发闸 + 失败记账（第 27 轮遗留风暴收口）', () => coverStormInvariants(REAL.local)],
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
