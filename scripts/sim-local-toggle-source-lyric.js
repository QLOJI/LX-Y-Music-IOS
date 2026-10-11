#!/usr/bin/env node
/**
 * sim-local-toggle-source-lyric.js —— 「试听列表里的 local/下载条目：换源不再崩、能按歌名换源、
 * 自动获取在线歌词」契约（第 31 轮）。
 *
 * 需求原话（2026-10-03 第 31 轮，随 RN 红屏截图一起报的）：
 *   「又发现bug：1、播放本地与下载歌曲时，在试听列表选择local歌曲，选择歌曲换源后弹出报错，
 *     local歌曲可以按照歌名来换源修复。」
 *   「而且这些local歌曲，没有自动获取歌词，需要修补」
 *
 * 崩溃现场：`Fatal: TypeError Cannot read property 'albumName' of undefined`，栈落在 SourceDetail。
 * 根因（两条叠在一起）：
 *   ① 试听列表（LIST_IDS.DEFAULT）里混着**不是标准 MusicInfo** 的条目 ——
 *      LocalDownload 的 taskToPlayItem 是 `{ id, isComplate, status, progress, metadata: {...} }`，
 *      没有 name/singer/meta：播放「本地与下载」里的下载歌曲后，选中换源时 SourceDetail 读
 *      `info.meta.albumName` 直接抛；localFileToPlayItem 有 meta，但 name/singer 由文件名派生
 *      （parseFileName 把「歌手 - 歌名」拆成 name=左、singer=右，常常是反的），按原样搜什么都搜不到。
 *   ② 同一类未加可选链的解引用还在多处（试听列表搜索行、重复歌曲弹窗、我的列表按专辑排序）。
 * 歌词那头：普通本地/下载条目的歌词走 core/music/localPlay.getLyricInfo，而它的在线匹配只有
 * 一轮 `searchMusic(歌名, 歌手)` —— 文件名把歌名/歌手拆反时这一轮搜不到就返回空歌词，永远不会
 * 像 WebDAV 那样换组合重搜，用户看到的就是「这些 local 歌曲没有自动获取歌词」。
 *
 * 本轮口径：
 *   条一（换源不崩 + 能搜到）
 *     ① listAction 新增 normalizeToggleInfo：从 metadata.musicInfo 抠出真正的歌曲信息，补齐
 *        name/singer/source/meta（albumName 空串兜底、filePath 三处来源归一）。**只用于展示与
 *        搜索**：确认换源仍拿原始条目（handleToggleSource 靠原始 id 在列表里定位旧项）。
 *     ② 渲染处一律 meta?.albumName（SourceDetail 4 处 + 列表行 + 试听列表搜索行 + 重复歌曲弹窗
 *        + 我列表专辑排序）。
 *     ③ 搜索候选 getToggleSearchCandidates：本地/下载条目按 ①原样 → ②歌名歌手对调 →
 *        ③文件名整段/两种拆法 → ④只按歌名搜 逐组试（上限 5 组），上一组一个结果都没有才试下一组；
 *        在线歌曲只有一组候选，行为不变。结果列表过滤 toNewMusicInfo 的 null。
 *     ④ loadData 入参设防：Empty 的「重新加载」把点击事件当 selectInfo 传进来，不能直接读
 *        event.musicInfo。
 *   条二（自动获取歌词）
 *     ⑤ localPlay.getLyricInfo 升级成与 WebDAV 同一条链路：内嵌 → 同名 .lrc →
 *        getCachedLyricInfo（已落库）→ matchOnlineLyric（本地文件走 local.ts 导出的
 *        getOtherSourceByLocal 多轮拆分重试；下载任务/汽水走 getOtherSource 跨平台搜索；
 *        候选交给 getOnlineOtherSourceLyricInfo 做 existTimeExp 时间轴校验，成功后 saveLyric
 *        按条目 id 落库）→ 旧的轻量兜底 → 空歌词。
 *     ⑥ index.ts 把原条目（musicInfo）透传进 target：落库/读缓存按 id，多轮拆分按文件名。
 *
 * 为什么必须靠契约脚本：「内层条目怎么抠、哪些渲染点的可选链、候选分几组什么顺序、确认换源
 * 用哪份对象、歌词链路的先后与落库」全是形状与顺序，不是类型 —— 把 normalizeToggleInfo 换成
 * 直传原始条目、把候选组删成一组、把 .filter(Boolean) 删掉、把 getOtherSourceByLocal 那段删掉、
 * 把 saveLyric 删掉，tsc/eslint 全是绿的，真机上就是「换源红屏 / 搜不到 / 永远没有歌词」。
 * 带反例自检。
 *
 * 运行：node scripts/sim-local-toggle-source-lyric.js
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
  listAction: 'src/screens/Home/Views/Mylist/MusicList/listAction.ts',
  modal: 'src/screens/Home/Views/Mylist/MusicList/MusicToggleModal.tsx',
  listSearch: 'src/screens/Home/Views/Mylist/MusicList/ListMusicSearch.tsx',
  dup: 'src/screens/Home/Views/Mylist/MyList/DuplicateMusic.tsx',
  mylistUtils: 'src/screens/Home/Views/Mylist/MyList/utils.ts',
  localPlay: 'src/core/music/localPlay.ts',
  musicIndex: 'src/core/music/index.ts',
  local: 'src/core/music/local.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

const slice = (src, from, to) => {
  const start = src.indexOf(from)
  if (start < 0) return null
  const end = src.indexOf(to, start + from.length)
  if (end <= start) return null
  return src.slice(start, end)
}

// ---------------------------------------------------------------------------
// 不变量 A（条一）：换源不崩（规整条目 / 可选链 / 原始条目确认）+ 能按歌名换源（候选组）
// ---------------------------------------------------------------------------

const toggleCrashInvariants = (files) => {
  const reasons = []
  const la = files.listAction
  const laCode = stripComments(la)
  const modal = files.modal
  const modalCode = stripComments(modal)

  // ① 规整函数：下载任务条目要能抠出 metadata.musicInfo，且补齐三个必经字段
  const helpers = slice(la, 'export const normalizeToggleInfo = (', 'export const handleToggleSource = async(')
  if (!helpers) {
    reasons.push('换源辅助函数切片失败（锚点漂移：normalizeToggleInfo / handleToggleSource）')
    return reasons
  }
  if (!helpers.includes('raw.metadata?.musicInfo ?? raw.musicInfo ?? raw')) {
    reasons.push('normalizeToggleInfo 没有从 metadata.musicInfo 抠出真正的歌曲信息（下载任务条目没有 name/singer/meta，SourceDetail 读 undefined.albumName 必崩）')
  }
  if (!helpers.includes("albumName: meta.albumName ?? ''")) {
    reasons.push('normalizeToggleInfo 没有给 meta.albumName 兜底空串（meta 缺失时 SourceDetail 的渲染分支全靠这层兜底）')
  }
  if (!helpers.includes('filePath: meta.filePath ?? raw.filePath ?? raw.metadata?.filePath ?? meta.songId')) {
    reasons.push('normalizeToggleInfo 没有把三处分散的文件路径（meta.filePath / 条目 filePath / metadata.filePath）归一（换源搜索与歌词拆分都靠它拿到文件名）')
  }

  // ② 展示用规整条目，确认换源仍用原始条目
  if (!modalCode.includes('info={normalizeToggleInfo(infoRef.current.musicInfo)}')) {
    reasons.push('SourceDetail 没有拿到规整后的条目（下载任务条目进 SourceDetail 读 info.meta.albumName 就是那条 Fatal）')
  }
  if (!modalCode.includes('handleToggleSource(infoRef.current.listId, infoRef.current.musicInfo, musicInfo)')) {
    reasons.push('确认换源没有继续用原始条目（handleToggleSource 靠原始 id 在列表里定位旧项，传规整后的内层 id 会找不到）')
  }

  // ③ 渲染处一律可选链：guard 位置出现 `.meta.albumName ?` / `==` / `.localeCompare` 就是没兜住
  const renderFiles = {
    'MusicToggleModal.tsx': modalCode,
    'ListMusicSearch.tsx': stripComments(files.listSearch),
    'DuplicateMusic.tsx': stripComments(files.dup),
    'MyList/utils.ts': stripComments(files.mylistUtils),
    'MusicList/listAction.ts': laCode,
  }
  for (const [key, code] of Object.entries(renderFiles)) {
    for (const bad of ['.meta.albumName ?', '.meta.albumName ==', '.meta.albumName.localeCompare']) {
      if (code.includes(bad)) {
        reasons.push(`${key} 里还有未加可选链的「${bad}」（列表里混着下载任务条目时读 meta 就是 undefined → 红屏 Fatal）`)
      }
    }
  }
  if (!modalCode.includes('info.meta?.albumName ? (')) {
    reasons.push('SourceDetail 的专辑名渲染没有改成 info.meta?.albumName（本轮崩溃点之一）')
  }
  if (!renderFiles['ListMusicSearch.tsx'].includes("item.meta?.albumName ? ` (${item.meta.albumName})` : ''")) {
    reasons.push('ListMusicSearch 的搜索结果行没有改成可选链形式（试听列表里搜同一首歌会踩同一个坑）')
  }
  if (!renderFiles['DuplicateMusic.tsx'].includes('info.musicInfo.meta?.albumName ? (')) {
    reasons.push('DuplicateMusic 的专辑名渲染没有改成可选链形式（重复歌曲弹窗里同样会炸）')
  }
  if (!renderFiles['MyList/utils.ts'].includes('const aAlbum = a.meta?.albumName') ||
      !renderFiles['MyList/utils.ts'].includes('const bAlbum = b.meta?.albumName')) {
    reasons.push('MyList/utils.ts 的专辑排序没有先取可选链局部变量（按专辑排序时对下载任务条目解引用会炸）')
  }

  // ④ 候选组：本地/下载条目要多组重试，在线歌曲保持单组
  if (!helpers.includes('export const getToggleSearchCandidates = (')) {
    reasons.push('listAction 没有导出 getToggleSearchCandidates（换源搜索还是单组，本地歌曲拆反了就搜不到）')
  }
  if (!helpers.includes("return [{ name, singer }]")) {
    reasons.push('getToggleSearchCandidates 对在线歌曲没有保持单组候选（在线行为会跟着变）')
  }
  if (!helpers.includes('push(singer, name)')) {
    reasons.push('候选组没有「歌名/歌手对调」那一组（parseFileName 把「歌手 - 歌名」拆反时就靠它）')
  }
  if (!helpers.includes("push(name, '')")) {
    reasons.push('候选组没有「只按歌名搜」的兜底组（用户明确要求 local 歌曲能按歌名换源）')
  }
  if (!helpers.includes('candidates.slice(0, 5)')) {
    reasons.push('候选组没有上限（本地歌曲会退化成十几轮全平台搜索）')
  }

  // ⑤ loadData：入参设防 + 逐组回退 + 过滤 null
  const loadData = slice(modal, '  const loadData = useCallback(', '  useImperativeHandle(ref, () => ({')
  if (!loadData) {
    reasons.push('loadData 切片失败（锚点漂移：loadData / useImperativeHandle）')
  } else {
    if (!loadData.includes('selectInfo?.musicInfo ? selectInfo : infoRef.current')) {
      reasons.push('loadData 的入参没有设防（Empty 的「重新加载」把点击事件当 selectInfo 传进来，读 event.musicInfo 直接抛）')
    }
    if (!loadData.includes('getToggleSearchCandidates(target.musicInfo)')) {
      reasons.push('loadData 没有用 getToggleSearchCandidates 组候选（本地歌曲只有一组搜索，拆反了就永远搜不到）')
    }
    if (!loadData.includes('if (!candidates.length) {')) {
      reasons.push('loadData 没有处理候选组为空的情况（歌名歌手都空时会 candidate.name 抛错）')
    }
    if (!loadData.includes('return searchNext(index + 1)')) {
      reasons.push('候选组没有逐组回退（第一组没结果就停在空列表，本次修复等于没做）')
    }
    if (!loadData.includes('.filter(Boolean)')) {
      reasons.push('搜索结果没有过滤 toNewMusicInfo 的 null（缺 .filter(Boolean)，缺 songmid 的条目会在 FlatList 渲染时炸）')
    }
  }

  // ⑥ 换源定位旧项仍按原始 id
  const toggle = slice(la, 'export const handleToggleSource = async(', 'export const handleDownload = async(')
  if (!toggle || !toggle.includes('const oldId = musicInfo.id')) {
    reasons.push('handleToggleSource 没有按原始 id 定位旧项（换源替换会找不到原来的条目）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B（条二）：本地/下载条目自动获取在线歌词（多轮匹配 + 时间轴校验 + 落库 + 缓存）
// ---------------------------------------------------------------------------

const localLyricInvariants = (files) => {
  const reasons = []
  const lp = files.localPlay
  const lpCode = stripComments(lp)

  if (!lpCode.includes("import { getOtherSourceByLocal } from './local'")) {
    reasons.push('localPlay 没有复用 local.ts 的多轮匹配（getOtherSourceByLocal），本地文件名拆反时搜不到就是空歌词')
  }
  if (!lpCode.includes('musicInfo?: LX.Music.MusicInfo | LX.Download.ListItem')) {
    reasons.push('LocalPlayTarget 没有带原始条目（匹配成功后没法按 id 落库，也没法做文件名拆分重搜）')
  }

  const match = slice(lp, 'const matchOnlineLyric = async(', 'export const getLyricInfo = async({')
  if (!match) {
    reasons.push('matchOnlineLyric 切片失败（锚点漂移：matchOnlineLyric / getLyricInfo）')
  } else {
    if (!match.includes('getOtherSourceByLocal(originInfo as LX.Music.MusicInfoLocal, tryMatch)')) {
      reasons.push('本地文件没有走 local.ts 的多轮拆分匹配（getOtherSourceByLocal）——「歌手 - 歌名」拆反时只有这条路能搜到')
    }
    if (!match.includes('return tryMatch(await getOtherSource(originInfo))')) {
      reasons.push('下载任务/汽水条目没有走 getOtherSource 跨平台搜索（这两个条目的歌名歌手本来就是对的，别绕远路）')
    }
    if (!match.includes('getOnlineOtherSourceLyricInfo({')) {
      reasons.push('候选没有交给 getOnlineOtherSourceLyricInfo（没有 existTimeExp 时间轴校验，纯文本歌词会被当成命中）')
    }
    if (!match.includes('musicInfos: [...otherSource],')) {
      reasons.push('候选列表没有拷贝就传进去（getOnlineOtherSourceLyricInfo 会 shift 掉原数组）')
    }
    if (!match.includes('onToggleSource: () => {}')) {
      reasons.push('匹配过程传了真实的换源回调（本地/下载链路不走自定义源换源，回调会把播放器切到别的源）')
    }
    if (!match.includes('if (!isFromCache) void saveLyric(')) {
      reasons.push('匹配成功的歌词没有落库（每次都重搜，下次播放还是慢慢等 / 刷新前一直空）')
    }
  }

  const lyric = slice(lp, 'export const getLyricInfo = async({', 'export const getPicUrl = async({')
  if (!lyric) {
    reasons.push('localPlay.getLyricInfo 切片失败（锚点漂移：getLyricInfo / getPicUrl）')
  } else {
    const ordered = [
      ['readLyric(', '内嵌歌词'],
      ['readSidecarLyric(', '同名 .lrc'],
      ['getCachedLyricInfo(', '已落库歌词缓存'],
      ['matchOnlineLyric(', '跨平台在线匹配'],
      ['searchCandidates(', '轻量兜底搜索'],
      ["buildLyricInfo({ lyric: '' })", '空歌词兜底'],
    ]
    let lastAt = -1
    let broken = false
    for (const [needle, label] of ordered) {
      const at = lyric.indexOf(needle)
      if (at < 0 || at < lastAt) {
        broken = true
        reasons.push(`localPlay.getLyricInfo 的取歌词顺序不对：${label}（${needle}）缺失或排错位（离线优先、在线匹配次之、空歌词最后）`)
        break
      }
      lastAt = at
    }
    if (!broken && !lyric.includes('const originInfo = target.musicInfo')) {
      reasons.push('localPlay.getLyricInfo 没有从 target 取原始条目（多轮匹配与落库都拿不到入口）')
    }
  }

  if (!stripComments(files.local).includes('export const getOtherSourceByLocal = async <T>(')) {
    reasons.push('local.ts 没有导出 getOtherSourceByLocal（localPlay 复用不了，只能各写一份多轮匹配）')
  }

  const idx = files.musicIndex
  const target = slice(idx, 'const getTaskTarget = (', 'export const getMusicUrl = async({')
  if (!target || !target.includes('\n    musicInfo,\n')) {
    reasons.push('getTaskTarget 没有把下载任务原条目带进 target（下载歌曲的歌词匹配与落库都拿不到 id/文件名）')
  }
  if (!idx.includes('// 本地文件条目：在线歌词匹配多轮重试 + 按 id 落库都要用它\n        musicInfo,')) {
    reasons.push('index.ts 的本地歌词分支没有带 musicInfo（普通本地歌曲仍走单轮搜索）')
  }
  if (!idx.includes('        picUrl: null,\n        musicInfo,')) {
    reasons.push('index.ts 的汽水歌词分支没有带 musicInfo')
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

// 同一段写法在文件里出现多次时（例如 normalizeToggleInfo 的三个规整函数），
// 只改第一处不足以破坏不变量 —— 反例要把全部出现一起改回旧实现
const tamperAll = (src, from, to) => {
  if (!src.includes(from)) throw new Error('反例锚点未命中: ' + from.slice(0, 70))
  return src.split(from).join(to)
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

  // c1 SourceDetail 直传原始条目（第 31 轮之前的写法）
  check('c1 SourceDetail 直传原始条目', toggleCrashInvariants({
    ...REAL,
    modal: tamper(REAL.modal, 'info={normalizeToggleInfo(infoRef.current.musicInfo)}', 'info={infoRef.current.musicInfo}'),
  }),
  'SourceDetail')

  // c2 规整函数不抠 metadata.musicInfo（同一写法在 listAction 里出现三处，反例必须一起改）
  check('c2 不抠 metadata.musicInfo', toggleCrashInvariants({
    ...REAL,
    listAction: tamperAll(REAL.listAction, 'const inner = (raw.metadata?.musicInfo ?? raw.musicInfo ?? raw) as any', 'const inner = raw as any'),
  }),
  'metadata.musicInfo')

  // c3 albumName 不兜底
  check('c3 albumName 不兜底', toggleCrashInvariants({
    ...REAL,
    listAction: tamper(REAL.listAction, "albumName: meta.albumName ?? '',", 'albumName: meta.albumName as any,'),
  }),
  '兜底空串')

  // c4 filePath 不归一
  check('c4 filePath 不归一', toggleCrashInvariants({
    ...REAL,
    listAction: tamper(REAL.listAction,
      'filePath: meta.filePath ?? raw.filePath ?? raw.metadata?.filePath ?? meta.songId,',
      'filePath: meta.filePath,'),
  }),
  '三处分散的文件路径')

  // c5 单轮搜索（候选组没了）
  check('c5 退回单轮搜索', toggleCrashInvariants({
    ...REAL,
    modal: tamper(REAL.modal,
      'const candidates = getToggleSearchCandidates(target.musicInfo)',
      'const candidates = [{ name: target.musicInfo.name, singer: target.musicInfo.singer }]'),
  }),
  'getToggleSearchCandidates')

  // c6 候选组不逐组回退
  check('c6 不逐组回退', toggleCrashInvariants({
    ...REAL,
    modal: tamper(REAL.modal,
      '        if (!tags.length && index + 1 < candidates.length) return searchNext(index + 1)',
      '        if (false) return searchNext(index)'),
  }),
  '逐组回退')

  // c7 不过滤 toNewMusicInfo 的 null
  check('c7 不过滤 null', toggleCrashInvariants({
    ...REAL,
    modal: tamper(REAL.modal,
      'const list = s.list.map(info => toNewMusicInfo(info)).filter(Boolean) as LX.Music.MusicInfoOnline[]',
      'const list = s.list.map(info => toNewMusicInfo(info)) as LX.Music.MusicInfoOnline[]'),
  }),
  'filter(Boolean)')

  // c8 loadData 入参不设防（Empty 重新加载把事件当参数）
  check('c8 入参不设防', toggleCrashInvariants({
    ...REAL,
    modal: tamper(REAL.modal,
      'const target = selectInfo?.musicInfo ? selectInfo : infoRef.current',
      'const target = selectInfo as SelectInfo'),
  }),
  '重新加载')

  // c9 ListMusicSearch 可选链回退
  check('c9 ListMusicSearch 可选链回退', toggleCrashInvariants({
    ...REAL,
    listSearch: tamper(REAL.listSearch,
      "{item.singer}{item.meta?.albumName ? ` (${item.meta.albumName})` : ''}",
      '{item.singer} ({item.meta.albumName})'),
  }),
  'ListMusicSearch')

  // c10 我列表专辑排序可选链回退（升降序两个分支各有一处，反例必须一起改）
  check('c10 专辑排序可选链回退', toggleCrashInvariants({
    ...REAL,
    mylistUtils: tamperAll(REAL.mylistUtils, 'const aAlbum = a.meta?.albumName', 'const aAlbum = a.meta.albumName as any'),
  }),
  '专辑排序')

  // c11 确认换源改用规整条目（原始 id 丢了）
  check('c11 确认换源用规整条目', toggleCrashInvariants({
    ...REAL,
    modal: tamper(REAL.modal,
      'handleToggleSource(infoRef.current.listId, infoRef.current.musicInfo, musicInfo)',
      'handleToggleSource(infoRef.current.listId, normalizeToggleInfo(infoRef.current.musicInfo), musicInfo)'),
  }),
  '原始条目')

  // c12 本地歌词不走多轮拆分匹配
  check('c12 本地歌词不走多轮匹配', localLyricInvariants({
    ...REAL,
    localPlay: tamper(REAL.localPlay,
      'return getOtherSourceByLocal(originInfo as LX.Music.MusicInfoLocal, tryMatch)',
      'return tryMatch(await getOtherSource(originInfo))'),
  }),
  'getOtherSourceByLocal')

  // c13 匹配成功不落库
  check('c13 匹配不落库', localLyricInvariants({
    ...REAL,
    localPlay: tamper(REAL.localPlay,
      'if (!isFromCache) void saveLyric(originInfo as LX.Music.MusicInfo, lyricInfo as LX.Music.LyricInfo)',
      'if (false) void 0'),
  }),
  '落库')

  // c14 不读已落库缓存
  check('c14 不读歌词缓存', localLyricInvariants({
    ...REAL,
    localPlay: tamper(REAL.localPlay,
      'const cached = await getCachedLyricInfo(originInfo as LX.Music.MusicInfo).catch(() => null)',
      'const cached: any = null'),
  }),
  'getCachedLyricInfo')

  // c15 候选不交给时间轴校验
  check('c15 跳过时间轴校验', localLyricInvariants({
    ...REAL,
    localPlay: tamper(REAL.localPlay,
      '    const { lyricInfo, isFromCache } = await getOnlineOtherSourceLyricInfo({',
      '    const { lyricInfo, isFromCache } = await searchCandidates({'),
  }),
  'getOnlineOtherSourceLyricInfo')

  // c16 index.ts 本地歌词分支不带 musicInfo
  check('c16 本地分支不带 musicInfo', localLyricInvariants({
    ...REAL,
    musicIndex: tamper(REAL.musicIndex,
      '        // 本地文件条目：在线歌词匹配多轮重试 + 按 id 落库都要用它\n        musicInfo,\n',
      ''),
  }),
  'index.ts')

  // c17 getTaskTarget 不带原条目
  check('c17 getTaskTarget 不带原条目', localLyricInvariants({
    ...REAL,
    musicIndex: tamper(REAL.musicIndex,
      "    quality: 'quality' in musicInfo ? (musicInfo as any).quality : undefined,\n    // 【第 31 轮】原文条目：在线歌词匹配与落库（saveLyric/getCachedLyricInfo）都用它\n    musicInfo,",
      "    quality: 'quality' in musicInfo ? (musicInfo as any).quality : undefined,"),
  }),
  'getTaskTarget')

  // c18 local.ts 不再导出多轮匹配
  check('c18 多轮匹配不再导出', localLyricInvariants({
    ...REAL,
    local: tamper(REAL.local, 'export const getOtherSourceByLocal = async <T>(', 'const getOtherSourceByLocal = async <T>('),
  }),
  'local.ts 没有导出')

  // c19 离线歌词优先级被拆（内嵌歌词那步删掉）
  check('c19 内嵌歌词那步删掉', localLyricInvariants({
    ...REAL,
    localPlay: tamper(REAL.localPlay,
      'const embedded = await readLyric(target.filePath).catch(() => null)',
      'const embedded = null'),
  }),
  '取歌词顺序')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-local-toggle-source-lyric ===')
console.log('试听列表 local/下载条目：换源不崩（规整条目 + 可选链 + 原始条目确认）')
console.log('                          能按歌名换源（候选组逐组回退 + 过滤 null）')
console.log('                          自动获取在线歌词（多轮拆分匹配 + 时间轴校验 + 落库缓存）（第 31 轮）')
console.log()

const checks = [
  ['条一 换源不崩 + 能按歌名换源（normalizeToggleInfo / meta 可选链 / 候选组 / loadData 回退与过滤）', () => toggleCrashInvariants(REAL)],
  ['条二 本地/下载条目自动获取在线歌词（内嵌→sidecar→缓存→多轮匹配→落库→兜底 的顺序与形状）', () => localLyricInvariants(REAL)],
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
