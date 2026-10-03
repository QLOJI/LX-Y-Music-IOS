#!/usr/bin/env node
/**
 * sim-webdav-row-opacity-cover-lyric.js —— WebDAV 歌曲行的「底色透明度 / 在线封面进缓存并在试听列表同样显示 /
 * 歌词同一路数」契约（用户第 25 轮·图一）。
 *
 * 需求原话（2026-10-03 第 25 轮，附 WebDAV 列表截图：music 目录 325 首，整列封面都是灰占位）：
 *   「图一：WebDAV的歌曲栏背景透明度没有受到控制，点击播放后才有透明度；
 *     还有扫描和进入列表界面时，同时加载在线封面，点击播放后自动匹配歌词。」
 * 同日补充（澄清第二条与第三条的落点）：
 *   「同时加载在线封面，将封面存入缓存，在试听列表中也同样显示，歌词也一样」
 *
 * 四条口径：
 *   条一 行底色/边框**任何状态**都受「按钮透明度」(theme.buttonOpacity) 控制。
 *        此前只有 isPlaying 那一支套了 applyOpacity，未播放行写死不透明的
 *        theme['c-content-background'] —— 与第 22 轮「本地与下载」列表同一个 bug
 *        （当时的原话是「点击歌曲后才正常显示」，见 sim-localdownload-row-opacity.js）。
 *   条二 封面：列表行走**逐行按需**链路（useCoverUrl → core/music/coverUrl.ts 的缓存 + 并发队列），
 *        并删掉原先「进列表 / 扫描完 / 播放后」对整份列表跑 4 worker 的 fetchWebDAVPic 批量下载
 *        （325 首 = 325 次请求）。只有真正渲染出来的行才发请求，并发上限仍在 coverUrl.ts
 *        （MAX_CONCURRENT=4），扫描/进列表没有批量风暴。
 *   条三 封面要**够得着在线匹配**并把结果**写回歌曲 meta 落盘**（= 「存入缓存」）：
 *        core/music/local.ts 的 WebDAV 分支此前在「网盘内没有封面文件」时直接 `return ''`，
 *        根本走不到下面的 getOnlineOtherSourcePicByLocal —— 这才是截图里整列灰占位的根因。
 *        现在落到在线匹配，命中后 updateWebDAVMusicMeta(musicId, { picUrl }) + webdavPicUpdated 广播，
 *        与既有「已下载音频的内嵌封面」那条写回路径同口径。
 *   条四 试听列表（Mylist/MusicList）与 WebDAV 列表**同一套按需链路**（同样 useCoverUrl），
 *        所以同一首歌在试听列表里也显示同一张封面；歌词同一路数——播放时自动匹配并
 *        saveLyric 落缓存（缓存 key = musicInfo.id，两侧同一 id ⇒ 试听列表里播同一首直接命中）。
 *        歌词这一侧本轮为**复核**（链路此前已具备），这里把两侧口径都锁进契约防回潮。
 *
 * 为什么必须靠契约脚本：这几条全是「形状」而非类型——把底色换回不透明的主题色、
 * 把 useCoverUrl 换回 item.meta.picUrl、把 `return ''` 放回在线匹配之前、把批量 fetchWebDAVPic
 * 放回来，tsc/eslint 全是绿的，只在真机上表现为「只有正在播的那行半透明 / 列表永远没有封面 /
 * 一进列表就发几百个请求 / 试听列表里同一首歌没封面」。
 * 带反例自检：对篡改后的源码跑同一套判断，必须被拦下。
 * 运行：node scripts/sim-webdav-row-opacity-cover-lyric.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  page: 'src/screens/Home/Views/WebDAV/index.tsx',
  mylist: 'src/screens/Home/Views/Mylist/MusicList/ListItem.tsx',
  player: 'src/core/player/player.ts',
  local: 'src/core/music/local.ts',
  music: 'src/core/music/index.ts',
  data: 'src/utils/data.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// 歌曲行组件体：`const SongItem = memo(` → 页面组件 `export default memo(() => {`。
// 这一段之外还有配置页/文件列表页/搜索栏等别的行型，不能整文件判。
const songRowBody = (raw) => {
  const start = raw.indexOf('const SongItem = memo(')
  const end = raw.indexOf('export default memo(() => {')
  if (start < 0 || end <= start) return null
  return raw.slice(start, end)
}

// getPicUrl 的 WebDAV 分支：从它自己的 isWebDAVMusic 标记起，到歌词工具函数为止。
// （local.ts 里 `const isWebDAVMusic = ...` 出现两次：getPicUrl 与 getLyricInfo，
//   indexOf 取到的是前者；末尾用下一个顶层函数做边界。）
const webdavPicBranch = (rawLocal) => {
  const start = rawLocal.indexOf("const isWebDAVMusic = 'webdav' in musicInfo.meta")
  const end = rawLocal.indexOf('const getMusicFileLyric = async(filePath: string) => {')
  if (start < 0 || end <= start) return null
  return rawLocal.slice(start, end)
}

// ---------------------------------------------------------------------------
// 不变量 A（条一）：卡片底色与边框，两态都走 applyOpacity(…, buttonOpacity)
// ---------------------------------------------------------------------------

const rowOpacityInvariants = (rawPage) => {
  const reasons = []
  const code = stripComments(rawPage)
  const row = songRowBody(code)
  if (!row) {
    reasons.push('SongItem 组件体抽取失败（锚点漂移：const SongItem = memo( / export default memo）')
    return reasons
  }

  if (!row.includes("useSettingValue('theme.buttonOpacity')")) {
    reasons.push('歌曲行未订阅 theme.buttonOpacity（改透明度设置后行底色不会立即跟随，要点一次播放才刷新）')
  }

  const bgAt = row.indexOf('backgroundColor: applyOpacity(')
  const borderAt = row.indexOf('borderColor: applyOpacity(')
  if (bgAt < 0) {
    reasons.push('歌曲行底色未走 applyOpacity(…, buttonOpacity)（用户报的「背景透明度没有受到控制」的根因写法）')
  } else if (!row.slice(bgAt, bgAt + 260).includes("theme['c-content-background']")) {
    reasons.push('未播放行的底色没有包在同一个 applyOpacity 里（只有播放中那支受控 ⇒ 点击播放后才有透明度）')
  }
  if (borderAt < 0) {
    reasons.push('歌曲行边框未走 applyOpacity(…, buttonOpacity)（边框不透明，卡片轮廓仍是实心的）')
  } else if (!row.slice(borderAt, borderAt + 260).includes("theme['c-border-background']")) {
    reasons.push('未播放行的边框没有包在同一个 applyOpacity 里（与底色口径不一致）')
  }

  const naked = /(backgroundColor|borderColor):\s*theme\[/.exec(row)
  if (naked) {
    reasons.push(`行内还有未包 applyOpacity 的 ${naked[1]}（不透明分支会让这一态脱离「按钮透明度」）`)
  }
  if (/\n\s+opacity:/.test(row)) {
    reasons.push('歌曲行用了容器 opacity（文字与图标会跟着一起淡，必须只改颜色 alpha）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B（条二）：封面逐行按需 + 页内没有全表批量下载
// ---------------------------------------------------------------------------

const coverInvariants = (rawPage) => {
  const reasons = []
  const code = stripComments(rawPage)
  const row = songRowBody(code)
  if (!row) {
    reasons.push('SongItem 组件体抽取失败（锚点漂移：const SongItem = memo( / export default memo）')
    return reasons
  }

  if (!code.includes("import useCoverUrl from '@/utils/hooks/useCoverUrl'")) {
    reasons.push('WebDAV 页未引入逐行封面 hook useCoverUrl（与其他歌曲列表不是同一套按需链路）')
  }
  if (!row.includes('useCoverUrl(item)')) {
    reasons.push('歌曲行没有按需取封面（useCoverUrl(item)）⇒ 行内只能吃静态 meta.picUrl，网盘里没有封面文件就永远是灰占位')
  }
  if (!row.includes('url={coverUrl}')) {
    reasons.push('行内封面没有用 hook 的返回值（url={coverUrl}）⇒ 按需取到的封面渲染不出来')
  }
  if (/url=\{item\.meta\.picUrl/.test(row)) {
    reasons.push('行内封面又直接读静态 meta.picUrl（绕过了按需链路：网盘内封面 / 内嵌封面 / 在线匹配都拿不到）')
  }

  if (code.includes('fetchWebDAVPic')) {
    reasons.push('页内又出现 fetchWebDAVPic（整表批量下载网盘封面的老写法：进列表/扫描时就发几百个请求）')
  }
  if (code.includes('syncSongsCover')) {
    reasons.push('页内又出现 syncSongsCover（全表封面同步的批量函数，已由逐行按需取代）')
  }
  if (/Array\.from\(\{\s*length:\s*4\s*\}/.test(code)) {
    reasons.push('页内又出现 4 worker 的并发批处理（全表封面下载风暴的写法）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C（条三）：WebDAV 封面链路必须够得着在线匹配，并把结果写回 meta 落盘
// ---------------------------------------------------------------------------

const webdavCoverPersistInvariants = (rawLocal) => {
  const reasons = []
  const branch = webdavPicBranch(stripComments(rawLocal))
  if (!branch) {
    reasons.push('getPicUrl 的 WebDAV 分支抽取失败（锚点漂移：isWebDAVMusic / getMusicFileLyric）')
    return reasons
  }

  const onlineAt = branch.indexOf('const result = await getOnlineOtherSourcePicByLocal(musicInfo)')
  if (onlineAt < 0) {
    reasons.push('WebDAV 封面链路没有在线匹配（getOnlineOtherSourcePicByLocal）')
  } else {
    // 在线匹配之前不许出现提前返回：老代码在这里 `return ''`，于是网盘里没有封面文件时
    // 整条在线匹配永远不可达（用户截图：325 首全是灰占位）。
    const before = branch.slice(0, onlineAt)
    if (before.includes("return ''")) {
      reasons.push("在线匹配之前还有 `return ''`（网盘内没有封面文件时提前返回 ⇒ 在线封面永远拿不到，列表整列灰占位）")
    }
  }

  if (!branch.includes('updateWebDAVMusicMeta(musicInfo.id, { picUrl: result.url })')) {
    reasons.push('在线匹配到的封面没有写回歌曲 meta（= 没「存入缓存」：下次进列表 / 试听列表里同一首歌还得重匹配一遍）')
  }
  if (!branch.includes('appEvent.webdavPicUpdated(musicInfo.id, result.url)')) {
    reasons.push('写回封面后没有广播 webdavPicUpdated（WebDAV 列表行不会立刻换成在线封面）')
  }
  // 与既有「内嵌封面写回」同口径：两条路都走 updateWebDAVMusicMeta + 广播
  if (!branch.includes('updateWebDAVMusicMeta(musicInfo.id, { picUrl })')) {
    reasons.push('已下载音频的内嵌封面写回路径丢失（updateWebDAVMusicMeta(..., { picUrl })）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D（条四）：试听列表同一套按需链路；歌词同一套缓存（按 id）
// ---------------------------------------------------------------------------

const sharedListAndLyricInvariants = (raw) => {
  const reasons = []

  const mylist = stripComments(raw.mylist)
  const player = stripComments(raw.player)
  const local = stripComments(raw.local)
  const music = stripComments(raw.music)
  const data = stripComments(raw.data)
  const page = stripComments(raw.page)

  // ① 试听列表（Mylist/MusicList）与 WebDAV 列表同一套按需封面链路
  if (!mylist.includes("import useCoverUrl from '@/utils/hooks/useCoverUrl'")) {
    reasons.push('试听列表行未引入 useCoverUrl（与 WebDAV 列表不是同一套按需封面链路）')
  }
  if (!mylist.includes('useCoverUrl(info)')) {
    reasons.push('试听列表行没有按需取封面（useCoverUrl(info)）⇒ WebDAV 歌曲在试听列表里没有封面')
  }
  if (!mylist.includes('url={coverUrl}')) {
    reasons.push('试听列表行封面没有用 hook 的返回值（url={coverUrl}）')
  }

  // ② 播放链路：player.ts 切曲/恢复播放都拉歌词
  const playCalls = (player.match(/getLyricInfo\(\{\s*musicInfo\s*\}\)/g) ?? []).length
  if (playCalls < 2) {
    reasons.push(`player.ts 里播放时拉歌词的调用只剩 ${playCalls} 处（应 ≥2：恢复播放 + 切曲 debouncePlay）⇒ 点击播放后不会自动匹配歌词`)
  }

  // ③ 分发：source=local 且 meta.webdav 的歌曲必须走本地歌词链路（不是在线音源链路）
  if (!music.includes('return getLocalLyricInfo({ musicInfo, isRefresh, onToggleSource })')) {
    reasons.push('core/music/index.ts 未把 WebDAV 歌曲分发到 getLocalLyricInfo（歌词会走错链路，拿不到网盘内 .lrc 与在线匹配）')
  }

  // ④ WebDAV 歌词链路：网盘内同名 .lrc → 缓存 → 内嵌 → 在线匹配并落缓存
  if (!local.includes('fetchWebDAVLrc(musicInfo as LX.WebDAV.MusicInfo)')) {
    reasons.push('WebDAV 歌词链路缺少「网盘内同名 .lrc」这一步')
  }
  if (!local.includes('getOnlineOtherSourceLyricByLocal(musicInfo, isRefresh)')) {
    reasons.push('WebDAV 歌词链路缺少「在线匹配」这一步（点击播放后匹配不到歌词的根因）')
  }
  if (!local.includes('saveLyric(musicInfo, lyricInfo)')) {
    reasons.push('在线匹配到的歌词没有写回缓存（每次播放都要重新匹配一遍）')
  }

  // ⑤ 歌词缓存 key = musicInfo.id：两侧同一 id ⇒ 在 WebDAV 里匹配到的歌词，试听列表播同一首直接命中
  const saveBy = 'saveData(`${storageDataPrefix.lyric}${musicInfo.id}`, lyricInfo)'
  const readBy = 'getData<LX.Music.LyricInfo>(`${storageDataPrefix.lyric}${musicInfo.id}`)'
  if (!data.includes(saveBy)) {
    reasons.push('歌词缓存不是按 musicInfo.id 落盘（saveLyric）：换到试听列表播同一首就命中不了')
  }
  if (!data.includes(readBy)) {
    reasons.push('歌词缓存不是按 musicInfo.id 读取（getLyric）：试听列表里拿不到 WebDAV 页匹配过的歌词')
  }
  if (!local.includes('getCachedLyricInfo(musicInfo)')) {
    reasons.push('WebDAV 歌词链路没有查缓存（getCachedLyricInfo）：每次播放都会重新匹配')
  }

  // ⑥ 反向：扫描/进列表不许拉歌词（歌词只在播放时匹配，避免又是批量网络请求）
  if (page.includes('getLyricInfo')) {
    reasons.push('WebDAV 列表页里出现了 getLyricInfo（扫描/进列表开始拉歌词 ⇒ 又变成批量请求；歌词只该在播放时匹配）')
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

  // c1 未播放行底色退回不透明（= 第 25 轮用户截图里那个写法：只有播放中那一支包了 applyOpacity）
  check('c1 未播放行退回不透明底色', () => rowOpacityInvariants(tamper(REAL.page,
    "          backgroundColor: applyOpacity(\n            isPlaying ? theme['c-primary-background-hover'] : theme['c-content-background'],\n            buttonOpacity,\n          ),",
    "          backgroundColor: isPlaying\n            ? applyOpacity(theme['c-primary-background-hover'], buttonOpacity)\n            : theme['c-content-background'],")),
  '歌曲行底色未走 applyOpacity')

  // c1b 底色还在 wrapper 里，但未播放那一态换成了脱离主题/字面的颜色（半受控）
  check('c1b 未播放底色换成字面色', () => rowOpacityInvariants(tamper(REAL.page,
    "            isPlaying ? theme['c-primary-background-hover'] : theme['c-content-background'],",
    "            isPlaying ? theme['c-primary-background-hover'] : '#2b2b2b',")),
  '未播放行的底色没有包在同一个 applyOpacity 里')

  // c2 未播放行边框退回不透明
  check('c2 未播放行边框退回不透明', () => rowOpacityInvariants(tamper(REAL.page,
    "          borderColor: applyOpacity(\n            isPlaying ? theme['c-primary-background-active'] : theme['c-border-background'],\n            buttonOpacity,\n          ),",
    "          borderColor: isPlaying ? theme['c-primary-background-active'] : theme['c-border-background'],")),
  '歌曲行边框未走 applyOpacity')

  // c2b 边框还在 wrapper 里，未播放那一态换成别的主题键
  check('c2b 未播放边框换主题键', () => rowOpacityInvariants(tamper(REAL.page,
    "            isPlaying ? theme['c-primary-background-active'] : theme['c-border-background'],",
    "            isPlaying ? theme['c-primary-background-active'] : theme['c-border'],")),
  '未播放行的边框没有包在同一个 applyOpacity 里')

  // c3 行不再订阅「按钮透明度」（写死 100）
  check('c3 行不再订阅按钮透明度', () => rowOpacityInvariants(tamper(REAL.page,
    "    const buttonOpacity = useSettingValue('theme.buttonOpacity')\n    // 「按钮圆角」",
    "    const buttonOpacity = 100\n    // 「按钮圆角」")),
  '歌曲行未订阅 theme.buttonOpacity')

  // c4 改用容器 opacity 淡出（文字与图标会一起淡）
  check('c4 改用容器 opacity', () => rowOpacityInvariants(tamper(REAL.page,
    '          ...styles.songItem,\n          width: rowWidth,',
    '          ...styles.songItem,\n          width: rowWidth,\n          opacity: buttonOpacity / 100,')),
  '歌曲行用了容器 opacity')

  // c5 行封面退回静态 meta.picUrl（按需链路被绕过）
  check('c5 封面退回静态 picUrl', () => coverInvariants(tamper(REAL.page,
    'url={coverUrl}',
    "url={item.meta.picUrl ?? ''}")),
  '行内封面又直接读静态 meta.picUrl')

  // c6 全表批量封面下载回潮（4 worker + fetchWebDAVPic）
  check('c6 全表批量封面回潮', () => coverInvariants(tamper(REAL.page,
    '  const loadConfig = useCallback(async() => {',
    "  const syncSongsCover = async(list: LX.WebDAV.MusicInfo[]) => {\n    const workers = Array.from({ length: 4 }, async() => {\n      for (const song of list) await fetchWebDAVPic(song)\n    })\n    await Promise.all(workers)\n  }\n\n  const loadConfig = useCallback(async() => {")),
  '又出现 fetchWebDAVPic')

  // c7 WebDAV 封面又提前返回（在线匹配不可达）
  check('c7 在线匹配前又提前返回', () => webdavCoverPersistInvariants(tamper(REAL.local,
    "      webDAVLog?.info('getPicUrl: no pan cover found, try online match')",
    "      webDAVLog?.info('getPicUrl: no pan cover found, return empty')\n      return ''")),
  '在线匹配之前还有')

  // c8 在线匹配到的封面不写回（不「存入缓存」）
  check('c8 在线封面不写回 meta', () => webdavCoverPersistInvariants(tamper(REAL.local,
    'updateWebDAVMusicMeta(musicInfo.id, { picUrl: result.url })',
    'updateWebDAVMusicMeta(musicInfo.id, {})')),
  '在线匹配到的封面没有写回歌曲 meta')

  // c9 试听列表行退回静态 picUrl（与 WebDAV 列表不再同源）
  check('c9 试听列表退回静态 picUrl', () => sharedListAndLyricInvariants({
    ...REAL,
    mylist: tamper(REAL.mylist, 'url={coverUrl}', "url={(info.meta as any).picUrl ?? ''}"),
  }),
  '试听列表行封面没有用 hook 的返回值')

  // c10 WebDAV 歌词链路去掉在线匹配
  check('c10 歌词去掉在线匹配', () => sharedListAndLyricInvariants({
    ...REAL,
    local: tamper(REAL.local,
      'return await getOnlineOtherSourceLyricByLocal(musicInfo, isRefresh).then(',
      'return await Promise.resolve({ lyricInfo: { lyric: "" }, isFromCache: true }).then('),
  }),
  'WebDAV 歌词链路缺少「在线匹配」这一步')

  // c11 播放时不再拉歌词（player.ts）
  check('c11 播放不再拉歌词', () => sharedListAndLyricInvariants({
    ...REAL,
    player: tamper(REAL.player,
      '  void getLyricInfo({ musicInfo }).then((lyricInfo) => {\n    if (musicInfo.id != playMusicInfo.musicInfo?.id) return',
      '  void Promise.resolve({ lyric: "" }).then((lyricInfo) => {\n    if (musicInfo.id != playMusicInfo.musicInfo?.id) return'),
  }),
  'player.ts 里播放时拉歌词的调用只剩 1 处')

  // c12 列表页开始批量拉歌词
  check('c12 列表页批量拉歌词', () => sharedListAndLyricInvariants({
    ...REAL,
    page: tamper(REAL.page,
      '  const loadConfig = useCallback(async() => {',
      '  const warmLyric = async(list: any[]) => { for (const s of list) await getLyricInfo({ musicInfo: s }) }\n\n  const loadConfig = useCallback(async() => {'),
  }),
  'WebDAV 列表页里出现了 getLyricInfo')

  // c13 歌词缓存不再按 id 落盘（换到试听列表就命中不了）
  check('c13 歌词缓存改成按歌名', () => sharedListAndLyricInvariants({
    ...REAL,
    data: tamper(REAL.data,
      'saveData(`${storageDataPrefix.lyric}${musicInfo.id}`, lyricInfo)',
      'saveData(`${storageDataPrefix.lyric}${musicInfo.name}`, lyricInfo)'),
  }),
  '歌词缓存不是按 musicInfo.id 落盘')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-webdav-row-opacity-cover-lyric ===')
console.log('WebDAV 歌曲行：底色/边框受「按钮透明度」控制 + 封面逐行按需(含在线匹配并写回缓存) + 试听列表同源 + 歌词同路数（第 25 轮）')
console.log()

const checks = [
  ['条一 行底色与边框两态都走 applyOpacity(…, buttonOpacity)，不用容器 opacity', () => rowOpacityInvariants(REAL.page)],
  ['条二 封面逐行按需（useCoverUrl），页内没有全表批量下载', () => coverInvariants(REAL.page)],
  ['条三 WebDAV 封面够得着在线匹配，且匹配结果写回 meta + 广播（存入缓存）', () => webdavCoverPersistInvariants(REAL.local)],
  ['条四 试听列表同一套按需封面链路；歌词播放时匹配 + 按 id 缓存；扫描/进列表不拉歌词', () => sharedListAndLyricInvariants(REAL)],
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
