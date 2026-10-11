/**
 * sim-nowplaying-lyric-arbitration.js
 *
 * 「锁屏 / 灵动岛歌词任何时刻都显示当前位置那一行」契约不变量。
 *
 * 背景（用户反馈）：锁屏界面与灵动岛界面的歌词会**短暂**显示成别的行（空行 / 上一句 /
 * 上一首的残留），随后才跳到当前行。根因是写 artist 的两条通路各自为政：
 *
 *   ① JS 逐行钩子：onLyricPlay → updateMetaData(artist) —— 直接写原生缓存；
 *   ② 原生 GCD 时钟：setNowPlayingLyrics → LXNowPlayingLyricStep —— 按锚点外推查行。
 *
 * 旧实现的 step 用「found == LXNowPlayingLyricIndex」短路（游标只由原生自己维护），
 * 于是 JS 刚写下的错行（装载窗口的 (-1,'') 空行、后台排队的陈旧行事件、debounce
 * 合并后的错行）会**留在卡片上直到下一次真实换行**才被纠正 = 用户看到的那段错行。
 *
 * 本契约把这个修复绑成不变量，覆盖四层：
 *   A. 原生 step：以 artist **实际文本**仲裁（一致→静默对齐；时钟落后→绝不回退文本；
 *      其余→立即改写当前行 + 刷新进度基线 + 重绘）；
 *   B. 原生装载原子化：setNowPlayingLyricLines 携带位置 → 同调用内重锚 + 仲裁；
 *      setNowPlayingInfo 在发布给系统**之前**仲裁；下拉/锁屏重绘前先仲裁；
 *   C. JS 装载窗口：窗口内丢弃逐行回调，装载完成时把位置随行一起提交；
 *   D. 位置快照缺失时不得发布 elapsedTime=0（会把原生锚点钉回第 0 行）。
 *
 * 【第 48 轮】用户原话（第 1 条）：「歌曲刚开始播放时，锁屏界面的歌曲进度、歌词、歌曲
 * 时间显示都不显示，要等到第一句歌词加载时，直接就跳到了 0:14 位置，请修复这个问题，
 * 确保锁屏界面的歌曲进度、歌词、歌曲时间实时显示没有延迟」。
 * C4 因此补一条：elapsedTime **字段任何时刻都要在**。第 47 轮「取不到带戳快照就整个不带
 * 这个字段」防的是「把 0 当真实位置、把锚点钉回第 0 行」，但系统对**缺字段**同样渲染
 * -:--（起播第 0 帧快照本来就没解析好），卡到第一句歌词发布才整块跳出。现在改成
 * 「带戳快照在 → 位置 + 戳；不在 → 退 JS 侧 nowPlayTime，不带戳（原生按『就是现在』
 * 处理，不外推、不回放）」——字段永远在，位置也不说谎。
 *
 * 并带反例自检（每条不变量都能拦下对应篡改——tsc/eslint 对这类「语义退化成旧行为」
 * 完全无感）。运行：node scripts/sim-nowplaying-lyric-arbitration.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const FILES = {
  appdel: 'ios/LxMusicMobile/AppDelegate.mm',
  nowPlaying: 'src/utils/nativeModules/nowPlaying.ts',
  coreLyric: 'src/core/lyric.ts',
  lyricInit: 'src/core/init/player/lyric.ts',
  playList: 'src/plugins/player/playList.ts',
}

const REAL = {}
for (const [k, p] of Object.entries(FILES)) REAL[k] = read(p)

/** 去注释：否则「被注释掉的防线」会被当成仍然存在 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 从源码抽出某个 C 函数【定义】体（按大括号配平）；跳过前置声明（`)` 后是 `;`）。 */
const extractCFunction = (src, signature) => {
  let searchFrom = 0
  for (;;) {
    const start = src.indexOf(signature, searchFrom)
    if (start < 0) return null
    const parenEnd = src.indexOf(')', start + signature.length - 1)
    if (parenEnd < 0) return null
    let i = parenEnd + 1
    while (i < src.length && /\s/.test(src[i])) i++
    if (src[i] === '{') {
      let depth = 0
      for (let j = i; j < src.length; j++) {
        const ch = src[j]
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) return src.slice(start, j + 1)
        }
      }
      return null
    }
    searchFrom = start + signature.length
  }
}

// ---------------------------------------------------------------------------
// A. 原生 step：以 artist 实际文本为准的行仲裁
// ---------------------------------------------------------------------------

const stepInvariants = (code, reasons) => {
  const step = extractCFunction(code, 'static void LXNowPlayingLyricStep(void)')
  if (!step) {
    reasons.push('未找到 LXNowPlayingLyricStep 定义（原生行仲裁缺失）')
    return
  }
  // ① 必须读 artist 实际文本并做「归属行」判定（不能只看 found 与游标）
  if (!/MPMediaItemPropertyArtist\]/.test(step)) {
    reasons.push('step 未读取当前 artist 文本：无法以实际显示内容仲裁（JS 写下的错行会留到下次换行）')
  }
  if (!/isEqualToString:\s*lineText/.test(step)) {
    reasons.push('step 未把 artist 与时间轴行文本逐一比对（缺「artist 落在哪一行」判定）')
  }
  // ② 时钟落后于 JS（artist 是更靠后的行）→ 保留文本、只推游标，绝不回退
  if (!/artistLine\s*>\s*found\s*\)\s*\{[\s\S]{0,120}?LXNowPlayingLyricIndex\s*=\s*artistLine;[\s\S]{0,40}?return;/.test(step)) {
    reasons.push('step 缺「时钟落后于 JS 时保留文本、推进游标」分支（回退文本 = 锁屏歌词跳回上一句）')
  }
  // ③ 一致 → 只对齐游标（静默，不重发不重绘）
  if (!/artistLine\s*==\s*found\s*\)\s*\{[\s\S]{0,120}?LXNowPlayingLyricIndex\s*=\s*found;/.test(step)) {
    reasons.push('step 缺「artist 已是当前行 → 只对齐游标」分支（会重复发布/重绘）')
  }
  // ④ 其余 → 立即改写当前行 + 刷新进度基线 + 重绘
  if (!/LXNowPlayingInfoCache\[MPMediaItemPropertyArtist\]\s*=\s*text;/.test(step)) {
    reasons.push('step 缺「立即改写 artist 为当前行」的落点')
  }
  if (!/LXNowPlayingInfoCache\[MPNowPlayingInfoPropertyElapsedPlaybackTime\]\s*=\s*@\(positionMs \/ 1000\.0\);/.test(step)) {
    reasons.push('step 改写当前行时未同步刷新进度基线（系统进度条会回拨/后跳）')
  }
  if (!/LXForceNowPlayingCardRepaint\(\);/.test(step)) {
    reasons.push('step 改写当前行后未强制重绘媒体卡片（系统不会实时刷新那一行）')
  }
  // ⑤ 前奏窗口：无当前行时，残留的「非时间轴文本」必须清掉
  if (!/if\s*\(found\s*<\s*0\)\s*\{/.test(step)) {
    reasons.push('step 缺「前奏（无当前行）」分支：上一首残留文本会稳定留在卡片上')
  }
  // ⑥ 暂停也要仲裁（不能 rate<=0 直接 return）：暂停中切歌 / 装载新时间轴时，
  //    卡片必须显示暂停点那一行，而不是上一首残留的句子
  if (!/if\s*\(fallbackRate\.doubleValue\s*<=\s*0\)\s*paused\s*=\s*YES;/.test(step)) {
    reasons.push('step 在真·暂停时直接返回、未走仲裁（暂停中切歌/换歌词源会把旧行留在锁屏上）')
  }
  if (!/double positionMs = paused/.test(step) || !/if\s*\(!paused && \[UIApplication sharedApplication\]\.applicationState == UIApplicationStateActive\)/.test(step)) {
    reasons.push('step 的暂停分支未把「停在锚点位置仲裁」与「不广播位置事件」分开（暂停位置会被外推/误广播）')
  }
}

// ---------------------------------------------------------------------------
// B. 原生装载原子化：同调用内重锚 + 仲裁
// ---------------------------------------------------------------------------

const nativeAtomicInvariants = (code, reasons) => {
  // B1 setNowPlayingLyricLines 接受可空位置参数并在同调用内重锚 + 仲裁
  const setLines = extractCFunction(code, 'static void LXSetNowPlayingLyricLines(')
  if (!setLines) {
    reasons.push('未找到 LXSetNowPlayingLyricLines 定义')
  } else {
    if (!/NSNumber\s*\*\s*positionMs/.test(setLines)) {
      reasons.push('LXSetNowPlayingLyricLines 未接受位置参数（装载后要等下一拍才可能显示当前行）')
    }
    if (!/if\s*\(positionMs\s*!=\s*nil\)\s*\{[\s\S]{0,160}?LXReanchorNowPlayingLyric\(positionMs\.doubleValue/.test(setLines)) {
      reasons.push('LXSetNowPlayingLyricLines 未在装载同刻按传入位置重锚（锚点仍指向旧歌/旧位置）')
    }
    if (!/if\s*\(LXNowPlayingLyricLines\.count\s*>\s*0\)\s*LXNowPlayingLyricStep\(\);/.test(setLines)) {
      reasons.push('LXSetNowPlayingLyricLines 未在同调用内仲裁当前行（装载窗口的错行会被画到卡片上）')
    }
    if (!/LXSyncNowPlayingLyricTimer\(\);/.test(setLines)) {
      reasons.push('LXSetNowPlayingLyricLines 未走时钟统一守卫（暂停态可能误开 8.3Hz 时钟）')
    }
  }

  // B2 setNowPlayingInfo：在把缓存发布给系统之前仲裁（系统一次都不该看到错行）
  const setInfo = extractCFunction(code, 'static void LXSetNowPlayingInfo(')
  if (!setInfo) {
    reasons.push('未找到 LXSetNowPlayingInfo 定义')
  } else {
    const syncAt = setInfo.indexOf('LXSyncNowPlayingLyricTimer();')
    const arbitrateAt = setInfo.indexOf('LXNowPlayingLyricStep();')
    const applyAt = setInfo.search(/if\s*\(metadata\[@"artwork"\]\s*!=\s*nil\)/)
    if (arbitrateAt < 0) {
      reasons.push('LXSetNowPlayingInfo 未在发布前仲裁（JS 逐行写入的错行会先落到系统卡片上）')
    } else {
      if (syncAt >= 0 && arbitrateAt < syncAt) {
        reasons.push('LXSetNowPlayingInfo 的仲裁调用出现在时钟守卫之前（顺序不对：锚点未刷新就仲裁）')
      }
      if (applyAt < 0 || arbitrateAt > applyAt) {
        reasons.push('LXSetNowPlayingInfo 的仲裁调用不在 LXApplyNowPlayingInfo/artwork 发布分支之前（系统会先看到错行）')
      }
    }
  }

  // B3 下拉/锁屏重绘前先仲裁（用户第一眼就是当前行）
  const redraw = extractCFunction(code, 'static void LXQueueNowPlayingLyricRedraw(void)')
  if (!redraw) {
    reasons.push('未找到 LXQueueNowPlayingLyricRedraw 定义')
  } else {
    const stepAt = redraw.indexOf('LXNowPlayingLyricStep();')
    const repaintAt = redraw.indexOf('LXForceNowPlayingCardRepaint();')
    if (stepAt < 0 || repaintAt < 0 || stepAt > repaintAt) {
      reasons.push('LXQueueNowPlayingLyricRedraw 未在重绘前仲裁（下拉/锁屏第一眼是旧行）')
    }
  }

  // B4 RCT 入口透传位置（老调用传 nil 仍兼容）
  if (!/setNowPlayingLyrics:\(NSArray \*\)lines\s+positionMs:\(NSNumber \*\)positionMs\s+snapshotAtMs:\(NSNumber \*\)snapshotAtMs\s+ageMs:\(NSNumber \*\)ageMs/.test(code)) {
    reasons.push('RCT setNowPlayingLyrics 未接受 positionMs/snapshotAtMs/ageMs（JS 的位置快照传不到原生）')
  }
  if (!/LXSetNowPlayingLyricLines\(lines \?: @\[\], positionMs, snapshotAtMs, ageMs\);/.test(code)) {
    reasons.push('RCT setNowPlayingLyrics 未把位置参数透传给 LXSetNowPlayingLyricLines')
  }
}

// ---------------------------------------------------------------------------
// C. JS：透传 + 装载窗口门控
// ---------------------------------------------------------------------------

const jsInvariants = (files, reasons) => {
  const nowPlaying = stripComments(files.nowPlaying)
  // C1 原生模块声明与调用都带三个可选参数
  if (!/setNowPlayingLyrics\?:\s*\(\s*lines: NowPlayingLyricLine\[\],\s*positionMs\?: number,\s*snapshotAtMs\?: number,\s*ageMs\?: number,?\s*\)\s*=> Promise<void>/.test(nowPlaying)) {
    reasons.push('nowPlaying.ts 未声明 setNowPlayingLyrics 的位置参数（类型层就传不出位置）')
  }
  if (!/setNowPlayingLyrics\?\.\(lines, positionMs, snapshotAtMs, ageMs\)/.test(nowPlaying)) {
    reasons.push('nowPlaying.ts 未把位置参数透传给原生方法')
  }

  const coreLyric = stripComments(files.coreLyric)
  // C2 core/lyric：位置可复用 + setLyric 返回装载位置
  if (!/export const getReliableLyricPosition\s*=/.test(coreLyric)) {
    reasons.push('core/lyric 未导出 getReliableLyricPosition（装载链路拿不到可信位置）')
  }
  if (!/export const play = async\(\)\s*=>\s*\{[\s\S]{0,160}?return position/.test(coreLyric)) {
    reasons.push('core/lyric 的 play() 未返回它使用的位置（setLyric 无法把位置交给原生）')
  }
  if (!/export const setLyric = async\(\)\s*=>\s*\{/.test(coreLyric) ||
      !/if \(playerState\.isPlay\) return play\(\)/.test(coreLyric) ||
      !/return getReliableLyricPosition\(\)\.catch\(\(\) => undefined\)/.test(coreLyric)) {
    reasons.push('core/lyric 的 setLyric() 未返回装载位置（暂停/播放两条路径都要给位置）')
  }

  const lyricInit = stripComments(files.lyricInit)
  // C3 装载窗口：窗口内丢弃逐行回调 + 装载完成随行提交位置
  if (!/let lyricLoading = 0/.test(lyricInit)) {
    reasons.push('init/player/lyric.ts 缺装载窗口计数器（装载期间解析器的空行/陈旧行会照发 artist）')
  }
  if (!/if \(lyricLoading > 0\) return/.test(lyricInit)) {
    reasons.push('逐行钩子未在装载窗口内早退（窗口内的空行/陈旧行仍会写 artist）')
  }
  if (!/lyricLoading \+= 1/.test(lyricInit) || !/lyricLoading -= 1/.test(lyricInit)) {
    reasons.push('装载窗口未成对开关（漏开=错行照发；漏关=歌词永久停更）')
  }
  if (!/await setNowPlayingLyrics\(lines, lyricPosition\)/.test(lyricInit)) {
    reasons.push('lyricUpdated 未把装载位置随行提交给原生（原生只能等下一拍外推）')
  }
  // 窗口结束回填 JS 侧行状态（判据与原生一致：最后一行 time ≤ 位置）
  if (!/realCurrentLyric = positionMs >= \(lines\[0\]\?\.time \?\? 0\)/.test(lyricInit)) {
    reasons.push('装载窗口结束时未回填 JS 侧当前行（后续 pause/调速重发会带上一首的旧行）')
  }

  const playList = stripComments(files.playList)
  // C4 快照缺失不得发 elapsedTime=0，且 elapsedTime 字段**任何时刻都要在**（第 48 轮）
  // 用户原话（第 48 轮第 1 条）：「歌曲刚开始播放时，锁屏界面的歌曲进度、歌词、歌曲时间
  // 显示都不显示，要等到第一句歌词加载时，直接就跳到了 0:14 位置……确保锁屏界面的歌曲
  // 进度、歌词、歌曲时间实时显示没有延迟」。
  // 第 47 轮那条「取不到带戳快照就整个不带 elapsedTime 字段」防的是「把 0 当真实位置、
  // 钉回第 0 行」，但系统对**缺字段**同样渲染 -:--：起播第 0 帧快照本来就没解析好，
  // 卡在 -:-- 一直等到第一句歌词发布为止 —— 正是用户那张图。本轮改成带回退位置
  // （JS 侧 nowPlayTime，不带快照戳，原生按「就是现在」处理）：字段永远在，位置不说谎。
  if (/elapsedTime:\s*stamped\?\.position \?\? 0/.test(playList)) {
    reasons.push('playList 在位置快照缺失时仍发布 elapsedTime: 0（原生锚点被钉回第 0 行 = 歌词跳回开头）')
  }
  if (!/stamped[\s\S]{0,80}?\{\s*elapsedTime: stamped\.position/.test(playList)) {
    reasons.push('playList 未在快照存在时随带 elapsedTime 与快照戳发布')
  }
  if (!/:\s*\{\s*elapsedTime: elapsedSeconds\s*\}/.test(playList)) {
    reasons.push('playList 快照缺失时的 elapsedTime 回退分支没了（该分支保证 elapsedTime 字段永远在；缺字段 ⇒ 锁屏/灵动岛渲染 -:--：起播第 0 帧快照还没解析好，正是用户第 48 轮第 1 条那张图）')
  }
}

// ---------------------------------------------------------------------------
// D. 仲裁决策模型（复刻原生 step 的决策表）
//
// 源真值在 AppDelegate.mm 的两个分支里；本模型只覆盖「artist 文本归属 + found」
// 的决策表（位置外推公式由 sim-lyric-anchor-sync.js 单独钉）。改动原生仲裁时必须
// 同步这里——两边不一致 = 契约失效。
// ---------------------------------------------------------------------------

const arbitrate = (lines, artist, found) => {
  let artistLine = -1
  if (artist != null && artist.length > 0) {
    const i = lines.findIndex((l) => l.text === artist)
    if (i >= 0) artistLine = i
  }
  if (artistLine >= 0 && artistLine > found) return { action: 'keep', index: artistLine }
  if (found < 0) {
    if (artistLine >= 0 || artist == null || artist.length === 0) return { action: 'keep', index: -1 }
    return { action: 'clear', index: -1 }
  }
  const text = lines[found].text
  if (!text) return { action: 'keep', index: null }
  if (artistLine === found) return { action: 'align', index: found }
  return { action: 'rewrite', index: found, text }
}

const LINES = [
  { time: 0, text: 'A' },
  { time: 1000, text: 'B' },
  { time: 2000, text: 'C' },
  { time: 3000, text: 'D' },
]

const MODEL_CASES = [
  ['装载窗口：artist 被写成空行', () => arbitrate(LINES, '', 1), (r) => r.action === 'rewrite' && r.text === 'B'],
  ['装载窗口：前奏（found<0）且 artist 空', () => arbitrate(LINES, '', -1), (r) => r.action === 'keep' && r.index === -1],
  ['上一首残留（不是时间轴任何一行）', () => arbitrate(LINES, '上一首的句子', 2), (r) => r.action === 'rewrite' && r.text === 'C'],
  ['前奏 + 上一首残留', () => arbitrate(LINES, '上一首的句子', -1), (r) => r.action === 'clear'],
  ['前奏 + 已是未来行（JS 抢跑）', () => arbitrate(LINES, 'A', -1), (r) => r.action === 'keep' && r.index === 0],
  ['JS 抢跑（时钟落后一行）', () => arbitrate(LINES, 'C', 1), (r) => r.action === 'keep' && r.index === 2],
  ['已是当前行 → 静默对齐', () => arbitrate(LINES, 'B', 1), (r) => r.action === 'align' && r.index === 1],
  ['JS 落后（陈旧行）→ 立即改写', () => arbitrate(LINES, 'A', 2), (r) => r.action === 'rewrite' && r.text === 'C'],
  ['重复文本取首个命中行', () => arbitrate([{ time: 0, text: 'X' }, { time: 500, text: 'X' }], 'X', 0), (r) => r.action === 'align' && r.index === 0],
]

const modelInvariants = () => {
  const reasons = []
  for (const [name, run, ok] of MODEL_CASES) {
    let r
    try {
      r = run()
    } catch (e) {
      reasons.push(`模型场景「${name}」抛异常：${e.message}`)
      continue
    }
    if (!ok(r)) reasons.push(`模型场景「${name}」判定不符：${JSON.stringify(r)}`)
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 反例：篡改真源码后必须被拦下
// ---------------------------------------------------------------------------

const tamper = (src, find, replace) => {
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find}`)
  return src.replace(find, replace)
}

const runCounterExamples = () => {
  const results = []
  const check = (name, fn, expectSubstr) => {
    let reasons = []
    try {
      reasons = fn()
    } catch (e) {
      results.push({ name, ok: false, detail: `抛异常: ${e.message}` })
      return
    }
    const hit = reasons.some((r) => r.includes(expectSubstr))
    results.push({ name, ok: hit, detail: hit ? '已拦下' : `未拦下（reasons=${JSON.stringify(reasons)}）` })
  }

  const nativeReasons = (src) => {
    const code = stripComments(src)
    const reasons = []
    stepInvariants(code, reasons)
    nativeAtomicInvariants(code, reasons)
    return reasons
  }
  const jsReasons = (over = {}) => {
    const files = { ...REAL, ...over }
    const reasons = []
    jsInvariants(files, reasons)
    return reasons
  }

  // N1 去掉「时钟落后不回退」分支 → 回退保护必须报
  check('N1 去掉不回退分支', () => nativeReasons(tamper(REAL.appdel,
    'if (artistLine >= 0 && artistLine > found) {',
    'if (false) {')), '时钟落后')

  // N2 去掉 artist 归属行判定 → 「以 artist 文本仲裁」必须报
  check('N2 去掉 artist 归属行判定', () => nativeReasons(tamper(REAL.appdel,
    'if ([lineText isKindOfClass:[NSString class]] && [currentArtist isEqualToString:lineText]) {',
    'if (false) {')), 'artist 落在哪一行')

  // N3 去掉「一致 → 静默对齐」分支
  check('N3 去掉一致对齐分支', () => nativeReasons(tamper(REAL.appdel,
    'if (artistLine == found) {',
    'if (false) {')), '只对齐游标')

  // N4 装载不再同调用仲裁
  check('N4 装载不同刻仲裁', () => nativeReasons(tamper(REAL.appdel,
    'if (LXNowPlayingLyricLines.count > 0) LXNowPlayingLyricStep();',
    '')), '未在同调用内仲裁')

  // N5 发布前不仲裁（退化成「系统先看到错行」）
  check('N5 发布前不仲裁', () => nativeReasons(tamper(REAL.appdel,
    'if (artist != nil) LXNowPlayingLyricStep();',
    '')), '发布前仲裁')

  // N6 下拉重绘前不仲裁
  check('N6 重绘前不仲裁', () => nativeReasons(tamper(REAL.appdel,
    'LXNowPlayingLyricStep();\n  LXForceNowPlayingCardRepaint();',
    'LXForceNowPlayingCardRepaint();')), '重绘前仲裁')

  // N7 RCT 位置参数被删
  check('N7 RCT 位置参数被删', () => nativeReasons(tamper(REAL.appdel,
    'setNowPlayingLyrics:(NSArray *)lines positionMs:(NSNumber *)positionMs snapshotAtMs:(NSNumber *)snapshotAtMs ageMs:(NSNumber *)ageMs ',
    'setNowPlayingLyrics:(NSArray *)lines ')), '未接受 positionMs')

  // J1 nowPlaying.ts 不再透传位置
  check('J1 透传层丢位置', () => jsReasons({
    nowPlaying: tamper(REAL.nowPlaying,
      'setNowPlayingLyrics?.(lines, positionMs, snapshotAtMs, ageMs)',
      'setNowPlayingLyrics?.(lines)'),
  }), '未把位置参数透传')

  // J2 装载窗口不再丢弃逐行回调
  check('J2 装载窗口未门控', () => jsReasons({
    lyricInit: tamper(REAL.lyricInit, 'if (lyricLoading > 0) return', '// window removed'),
  }), '未在装载窗口内早退')

  // J3 lyricUpdated 不再提交位置
  check('J3 装载位置未提交', () => jsReasons({
    lyricInit: tamper(REAL.lyricInit,
      'await setNowPlayingLyrics(lines, lyricPosition)',
      'await setNowPlayingLyrics(lines)'),
  }), '未把装载位置随行提交')

  // J4 core/lyric 的 setLyric 不再返回位置
  check('J4 setLyric 不返回位置', () => jsReasons({
    coreLyric: tamper(REAL.coreLyric,
      'if (playerState.isPlay) return play()',
      'if (playerState.isPlay) play()'),
  }), '未返回装载位置')

  // N8 暂停时直接 return（退回旧行为：暂停中切歌留着上一首的行）
  check('N8 暂停时跳过仲裁', () => nativeReasons(tamper(REAL.appdel,
    'if (fallbackRate.doubleValue <= 0) paused = YES;',
    'if (fallbackRate.doubleValue <= 0) return;')), '暂停时直接返回')

  // J5 playList 快照缺失又发 0（旧行为回归；第 48 轮新形状：elapsedFields 三元式）
  check('J5 快照缺失发 0', () => jsReasons({
    playList: tamper(REAL.playList,
      'const elapsedFields = stamped\n    ? { elapsedTime: stamped.position, ...elapsedSnapshotFields(stamped) }\n    : { elapsedTime: elapsedSeconds }',
      'const elapsedFields = { elapsedTime: stamped?.position ?? 0, ...(stamped ? elapsedSnapshotFields(stamped) : {}) }'),
  }), 'elapsedTime: 0')

  // J5b 第 48 轮：回退分支被删（快照缺失时整个不发 elapsedTime）→ 报「回退分支没了」
  check('J5b 快照缺失回退分支被删', () => jsReasons({
    playList: tamper(REAL.playList,
      ': { elapsedTime: elapsedSeconds }',
      ': {}'),
  }), '回退分支没了')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const nativeCode = stripComments(REAL.appdel)
const nativeReasons = []
stepInvariants(nativeCode, nativeReasons)
nativeAtomicInvariants(nativeCode, nativeReasons)

const jsReasons = []
jsInvariants(REAL, jsReasons)

const modelReasons = modelInvariants()

console.log('=== sim-nowplaying-lyric-arbitration ===')

console.log('\n[A. 原生行仲裁：以 artist 实际文本为准]')
{
  const only = []
  stepInvariants(nativeCode, only)
  if (!only.length) console.log('  PASS artist 归属判定 / 不回退 / 静默对齐 / 立即改写+刷新基线+重绘 / 前奏清理 / 暂停仍仲裁')
  else only.forEach((r) => console.log('  FAIL ' + r))
}

console.log('\n[B. 原生装载原子化：同调用内重锚 + 仲裁]')
{
  const only = []
  nativeAtomicInvariants(nativeCode, only)
  if (!only.length) console.log('  PASS setNowPlayingLyricLines / setNowPlayingInfo / Redraw / RCT 四处均同调用仲裁')
  else only.forEach((r) => console.log('  FAIL ' + r))
}

console.log('\n[C. JS 侧：位置透传 + 装载窗口门控 + 快照缺失不发 0]')
if (!jsReasons.length) console.log('  PASS nowPlaying.ts / core/lyric / init·lyric / playList 四处贯通')
else jsReasons.forEach((r) => console.log('  FAIL ' + r))

console.log('\n[D. 仲裁决策模型（9 个场景）]')
if (!modelReasons.length) console.log(`  PASS ${MODEL_CASES.length} 个场景判定全部符合预期`)
else modelReasons.forEach((r) => console.log('  FAIL ' + r))

console.log('\n[反例自检]')
const ceResults = runCounterExamples()
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.ok ? '已拦下' : `未拦下（${r.detail}）`}`)
  if (!r.ok) ceAllOk = false
}

const allOk = !nativeReasons.length && !jsReasons.length && !modelReasons.length && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${!nativeReasons.length && !jsReasons.length && !modelReasons.length ? '4/4' : '有失败'}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
