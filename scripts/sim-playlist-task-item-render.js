#!/usr/bin/env node
/**
 * sim-playlist-task-item-render.js —— 「下载 / 本地歌曲在试听列表里不许把整页渲染打崩」
 * （用户第 22 轮·图三/图四）。
 *
 * 需求原话（2026-10-03）：
 *   「当我播放本地与下载中的音乐时，长按迷你播放器栏和进入试听列表时，就会报错，如图，
 *     正常情况下，长按迷你播放器栏它会跳转到播放列表，点击进入试听列表也不会报错，请修复。」
 *
 * 根因：LocalDownload 的 taskToPlayItem 把下载任务包成播放项（判据 'progress' in item，
 * 显示数据挂在 item.metadata.musicInfo）后 stage 进默认试听列表；Mylist/MusicList/ListItem
 * 此前直接读 item.source / item.name / item.singer —— 任务项上这些都是 undefined，
 * 徽标那行 `item.source.toUpperCase()` 在渲染期直接抛
 * `TypeError: Cannot read property 'toUpperCase' of undefined`，整页崩。
 * 播放器内核刻意保留任务结构（'progress' in musicInfo 是歌词/封面/URL 的判据），
 * 所以防线放在 UI：显示取 info = 任务项的 metadata.musicInfo，回传仍用原始 item。
 *
 * 收敛结果：
 *   一、Mylist/MusicList/ListItem 统一「显示用信息」归一化（'progress' in item →
 *       metadata.musicInfo），展示 / 点赞 / 音质 / API 支持判断全部读 info；
 *   二、onPress / onLongPress / onShowMenu 仍回传原始 item（播放链路要继续拿任务结构）；
 *   三、全仓所有 `.source.toUpperCase()` 都必须有存在性守卫（? / &&）——
 *       这类数据可以缺 source，一个徽标不能把整页打崩（同一类崩溃的防复发）。
 *
 * 带反例自检（这类回归 tsc 无感：item.source 类型上标为 string，运行时才崩）。
 * 运行：node scripts/sim-playlist-task-item-render.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const MylistListItem = 'src/screens/Home/Views/Mylist/MusicList/ListItem.tsx'
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// ---------------------------------------------------------------------------
// 不变量 A：Mylist/MusicList/ListItem 的任务项归一化
// ---------------------------------------------------------------------------

const mylistInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // ① 归一化本体：'progress' in item → metadata.musicInfo 兜底 item
  if (!/const info: LX\.Music\.MusicInfo = 'progress' in item\s*\n\s*\? \(\(item as unknown as LX\.Download\.ListItem\)\.metadata\?\.musicInfo \?\? item\)\s*\n\s*: item/.test(code)) {
    reasons.push("缺少「下载任务项 → 显示用信息」归一化（const info = 'progress' in item ? metadata.musicInfo ?? item : item）")
  }

  // ② 展示字段全部读 info（item 上这些字段是 undefined）
  for (const [needle, label] of [
    ['useCoverUrl(info)', '封面'],
    ['{info.name}', '歌名'],
    ['info.alias', '副标题'],
    ['info.interval', '时长'],
    ['useQualityTag(info, qualityShowHighest)', '音质小标'],
    ['useAssertApiSupport(info.source)', 'API 支持判断'],
  ]) {
    if (!code.includes(needle)) reasons.push(`展示字段未改读 info（${label}：缺 ${needle}）`)
  }
  // 歌手：singer 常量由 info 拼出
  if (!/const singer = `\$\{info\.singer\}/.test(code)) {
    reasons.push('歌手未改读 info（singer 常量仍拼 item.singer）')
  }

  // ③ 徽标必须带存在性守卫（用户报的崩溃点就是这行）
  if (!code.includes('{info.source ? <Badge>{info.source.toUpperCase()}</Badge> : null}')) {
    reasons.push('source 徽标未带存在性守卫（缺 source 的数据会在 .toUpperCase() 处整页崩）')
  }

  // ④ 点赞 / 高亮判断读 info，且 item 的展示字段不再被直接消费
  if (!code.includes("const showLikeButton = info.source === 'wy' || info.source === 'tx' || info.source === 'kg'")) {
    reasons.push('点赞按钮显隐未改读 info.source')
  }
  if (code.includes('item.source') || code.includes('item.meta')) {
    reasons.push('仍直接消费 item.source / item.meta（任务项上为 undefined，渲染期会崩）')
  }

  // ⑤ 回调仍回传原始 item（播放链路要拿任务结构，不能把 info 传出去）
  for (const [needle, label] of [
    ['onPress(item, index)', 'onPress'],
    ['onLongPress(item, index)', 'onLongPress'],
    ['onShowMenu(item, index, {', 'onShowMenu'],
  ]) {
    if (!code.includes(needle)) reasons.push(`回调未回传原始 item（${label} 传的是 info，播放链路拿不到任务结构）`)
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：全仓 `.source.toUpperCase()` 必须有存在性守卫（防复发）
// ---------------------------------------------------------------------------

// 逐文件数：`.source.toUpperCase()` 出现次数 ≤ 同文件里 `source ?` / `source &&` 守卫次数。
// SongList 的写法是卡片级守卫（return item.source ? (...) : 占位），守卫与用法不在同一行，
// 所以按文件计数而不是按行计数。
const upperOccurrences = (code) => (code.match(/\.source\.toUpperCase\(\)/g) ?? []).length
const sourceGuards = (code) => (code.match(/\bsource \?/g) ?? []).length + (code.match(/\bsource &&/g) ?? []).length

const listSrcEntries = () => {
  const out = []
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(ROOT, rel))) {
      const childRel = `${rel}/${name}`
      if (/\.(ts|tsx)$/.test(name)) {
        out.push({ file: childRel, content: read(childRel) })
      } else if (fs.statSync(path.join(ROOT, childRel)).isDirectory()) {
        walk(childRel)
      }
    }
  }
  walk('src')
  return out
}

const srcScanInvariants = (entries) => {
  const reasons = []
  for (const { file, content } of entries) {
    const code = stripComments(content)
    const occ = upperOccurrences(code)
    if (occ === 0) continue
    const guards = sourceGuards(code)
    if (guards < occ) {
      reasons.push(`${file}：.source.toUpperCase() 出现 ${occ} 处、存在性守卫只有 ${guards} 处 —— 缺 source 的数据会整页崩`)
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 反例（对篡改后的源码跑同一套判断，必须被拦下）
// ---------------------------------------------------------------------------

const tamper = (src, find, replace) => {
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find.slice(0, 60)}`)
  return src.replace(find, replace)
}

const REAL = read(MylistListItem)

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

  // c1 拆掉归一化（退回直接读 item）
  check('c1 拆掉任务项归一化', () => mylistInvariants(tamper(REAL,
    "    const info: LX.Music.MusicInfo = 'progress' in item\n      ? ((item as unknown as LX.Download.ListItem).metadata?.musicInfo ?? item)\n      : item\n",
    '')),
  '缺少「下载任务项 → 显示用信息」归一化')

  // c2 徽标退回无守卫写法（用户报的崩溃点原文）
  check('c2 徽标退回 .toUpperCase() 无守卫', () => mylistInvariants(tamper(REAL,
    '{info.source ? <Badge>{info.source.toUpperCase()}</Badge> : null}',
    '{<Badge>{info.source.toUpperCase()}</Badge>}')),
  'source 徽标未带存在性守卫')

  // c3 全仓扫描：又冒出无守卫的 .source.toUpperCase()
  check('c3 新文件又写无守卫 .source.toUpperCase()', () => srcScanInvariants([
    { file: 'src/fake/newList.tsx', content: '<Badge>{item.source.toUpperCase()}</Badge>\n' },
  ]), '缺 source 的数据会整页崩')

  // c4 回调把 info 传出去（播放链路拿不到任务结构）
  check('c4 回调改传 info', () => mylistInvariants(tamper(REAL,
    'onPress(item, index)', 'onPress(info, index)')),
  '回调未回传原始 item')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-playlist-task-item-render ===')
console.log('下载/本地任务项在试听列表的渲染防线（第 22 轮·图三/图四）')
console.log()

const checks = [
  ['Mylist/MusicList/ListItem 任务项归一化', () => mylistInvariants(REAL)],
  ['全 src 扫描（.source.toUpperCase() 全带守卫）', () => srcScanInvariants(listSrcEntries())],
]

let invOk = true
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
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
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
