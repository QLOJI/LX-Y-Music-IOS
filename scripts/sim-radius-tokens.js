/**
 * sim-radius-tokens.js
 *
 * 「倒角二次下调」契约（需求 6：所有容器和歌曲封面的倒角尺寸减小一点，参考 REF 的倒角参数）。
 *
 * REF（lx-music-mobile-ios-adaptation，只读参考工程）全工程只有**一个**圆角常量：
 *   theme/Typography.js → `export const BorderRadius = { normal: 4 }`
 * 歌曲封面 / 卡片 / 输入框 / 菜单一律取它；只有 Popup 顶角给到 8。
 * 本工程上一轮把 designRadius.md 从 18 收到 8，观感仍明显比 REF 圆，故本轮直接落到 REF 值：
 *   sm 6 → 4、md 8 → 4（46 处引用走令牌，改一处全局生效）、lg 12 → 8、xl 16 → 12。
 * 另有 7 处封面/遮罩是**写字面量**的（不经令牌），必须逐个跟着落到 4，否则令牌与实值分叉：
 * 令牌一调，写死的那些封面就留在旧值上「独立地圆」。
 *
 * 本脚本 A 段钉令牌（含 REF 对齐值、梯度不倒挂、glass 不得随本轮下调）；
 * B 段把 7 个字面量封面点逐个解析求值，要求全部 = 4；
 * C 段要求「覆盖层跟随令牌」而不是再写一个数字（遮罩圆角与它覆盖的封面必须同源）；
 * D 段是反例自检——篡改后的源码必须被同一套不变量拦下。
 *
 * ⚠️ 本脚本是**静态断言**：通过只说明这些值/表达式读出来是对的，
 *    不代表能编译、更不代表真机观感符合预期（本工程无编译工具链）。
 *
 * 运行：node scripts/sim-radius-tokens.js
 * 退出码：不变量全过且反例全被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  tokens: 'src/theme/DesignTokens.ts',
  legacy: 'src/theme/Typography.js',
  download: 'src/screens/DownloadManager/ListItem.tsx',
  album: 'src/screens/ArtistDetail/AlbumListItem.tsx',
  subAlbums: 'src/screens/Home/Views/SubscribedAlbums/ListItem.tsx',
  recSongs: 'src/screens/Home/Views/DailyRec/TXDailyRec/RecSongs.tsx',
  recPlaylists: 'src/screens/Home/Views/DailyRec/TXDailyRec/RecPlaylists.tsx',
  kgPlaylist: 'src/screens/Home/Views/KgPlaylist/ListItem.tsx',
  artistHeader: 'src/screens/ArtistDetail/Header.tsx',
  similarArtists: 'src/screens/ArtistDetail/SimilarArtistsModal.tsx',
}
const REAL = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, read(v)]))

/** REF 的唯一圆角常量（theme/Typography.js 里的转录值），本轮所有封面/容器都对齐它 */
const REF_NORMAL_RADIUS = 4

let pass = 0, fail = 0

// ---------------------------------------------------------------------------
// 取值工具
// ---------------------------------------------------------------------------

/** 取 `designRadius` 对象块（`export const designRadius = {` … `} as const`） */
const radiusTokenBlock = (src) => {
  const s = stripComments(src)
  const i = s.indexOf('export const designRadius = {')
  if (i < 0) return null
  const j = s.indexOf('} as const', i)
  return j < 0 ? null : s.slice(i, j)
}

/** 从令牌块里读一个 token 的数值（sm / md / lg / xl / glass / pill） */
const readToken = (block, name) => {
  if (block == null) return null
  const m = block.match(new RegExp(`(?:^|\\n)\\s*${name}:\\s*(-?\\d+(?:\\.\\d+)?)`, 'm'))
  return m ? Number(m[1]) : null
}

/**
 * 取源码里所有名为 `key` 的样式块（`\n<缩进>key: {` … 同一缩进 `},`）。
 * 支持嵌套（ArtistDetail/AlbumListItem 的 artwork 缩进是 4 而不是 2），
 * 也支持同名多块（该文件 gridStyles / listStyles 各有一个 artwork）。
 */
const styleBlocks = (src, key) => {
  const s = stripComments(src)
  const out = []
  const re = new RegExp(`\\n([ \\t]*)${key}: \\{`, 'g')
  let m
  while ((m = re.exec(s))) {
    const close = s.indexOf(`\n${m[1]}},`, m.index)
    if (close < 0) continue
    out.push(s.slice(m.index, close))
  }
  return out
}

/** 读样式块里的 borderRadius 表达式原文（可能是一串数字，也可能是 designRadius.xx） */
const radiusExpr = (block) => {
  const m = block == null ? null : block.match(/borderRadius:\s*([^,\n]+)/)
  return m ? m[1].trim() : null
}

/** 把表达式求值：字面量数字 → 数值；designRadius.xx → 令牌值；其余（表达式/变量）→ null */
const evalRadius = (expr, tokens) => {
  if (expr == null) return null
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr)
  const m = expr.match(/^designRadius\.([A-Za-z_$][\w$]*)$/)
  if (m) return tokens == null ? null : readToken(tokens, m[1])
  return null
}

const fmtExpr = (expr) => (expr == null ? '（无 borderRadius）' : expr)

// ---------------------------------------------------------------------------
// A/B/C. 不变量（对 REAL 的**当前内容**求值；反例把篡改后的源码换进 REAL 再跑同一套函数）
// ---------------------------------------------------------------------------

/** 7 个写字面量的封面点：文件 → 样式名（同一个样式名出现多块时要求全部合规） */
const COVER_SITES = [
  { file: 'download', key: 'artwork', min: 1, label: '下载管理 · 歌曲封面' },
  { file: 'album', key: 'artwork', min: 2, label: '歌手页 · 专辑封面（gridStyles + listStyles）' },
  { file: 'subAlbums', key: 'artwork', min: 1, label: '收藏专辑 · 封面' },
  { file: 'recSongs', key: 'cover', min: 1, label: '每日推荐 · 歌曲封面' },
  { file: 'recPlaylists', key: 'cover', min: 1, label: '每日推荐 · 歌单封面' },
  { file: 'kgPlaylist', key: 'cover', min: 1, label: '酷狗歌单 · 封面' },
]

/** 「必须跟随令牌而不是硬编码」的样式：遮罩/占位必须与它覆盖的封面同源 */
const TOKEN_BOUND_SITES = [
  { file: 'kgPlaylist', key: 'cover', label: '酷狗歌单 · cover' },
  { file: 'kgPlaylist', key: 'favoritesOverlay', label: '酷狗歌单 · 收藏遮罩' },
  { file: 'kgPlaylist', key: 'favoritesPlaceholder', label: '酷狗歌单 · 收藏占位' },
]

function runSourceInvariants() {
  const out = []
  const add = (n, ok, detail = '') => out.push({ name: n, ok, detail })

  const tokenBlock = radiusTokenBlock(REAL.tokens)
  const t = {
    sm: readToken(tokenBlock, 'sm'),
    md: readToken(tokenBlock, 'md'),
    lg: readToken(tokenBlock, 'lg'),
    xl: readToken(tokenBlock, 'xl'),
    glass: readToken(tokenBlock, 'glass'),
    pill: readToken(tokenBlock, 'pill'),
  }

  // ---- A. 令牌 ----
  add('A1: designRadius 解析出 6 个 token', tokenBlock != null && Object.values(t).every((v) => v != null),
    `sm=${t.sm} md=${t.md} lg=${t.lg} xl=${t.xl} glass=${t.glass} pill=${t.pill}`)
  add('A2: sm = md = REF 唯一圆角常量 4（sm 与 md 同值不是笔误，见令牌注释）',
    t.sm === REF_NORMAL_RADIUS && t.md === REF_NORMAL_RADIUS,
    `sm=${t.sm} md=${t.md} 期望 ${REF_NORMAL_RADIUS}`)
  add('A3: lg = 8（= REF 的 Popup 顶角）、xl = 12', t.lg === 8 && t.xl === 12, `lg=${t.lg} xl=${t.xl}`)
  add('A4: 梯度不倒挂（sm ≤ md ≤ lg ≤ xl < glass ≤ pill）',
    t.sm <= t.md && t.md <= t.lg && t.lg <= t.xl && t.xl < t.glass && t.glass <= t.pill)
  add('A5: glass 不随本轮下调（= 28，与原生透镜胶囊半高绑定）', t.glass === 28, `glass=${t.glass}`)
  add('A6: 遗留令牌 Typography.js 的 BorderRadius.normal 仍 = 4（common/Image 等消费者的兜底）',
    new RegExp(`export const BorderRadius = \\{\\s*normal: ${REF_NORMAL_RADIUS},?\\s*\\}`).test(stripComments(REAL.legacy)))

  // ---- B. 7 个字面量封面点逐个求值 ----
  for (const site of COVER_SITES) {
    const blocks = styleBlocks(REAL[site.file], site.key)
    const exprs = blocks.map(radiusExpr)
    const vals = exprs.map((e) => evalRadius(e, tokenBlock))
    const hit = blocks.length >= site.min
    const allRef = hit && vals.every((v) => v === REF_NORMAL_RADIUS)
    add(`B${COVER_SITES.indexOf(site) + 1}: ${site.label} 圆角 = ${REF_NORMAL_RADIUS}`,
      allRef, `${blocks.length} 处：${exprs.map(fmtExpr).join(' / ')}${allRef ? '' : `（解析值 ${vals.join('/')}）`}`)
  }

  // ---- C. 覆盖层跟随令牌 ----
  const kgCover = styleBlocks(REAL.kgPlaylist, 'cover').map((b) => radiusExpr(b))
  for (const site of TOKEN_BOUND_SITES) {
    const exprs = styleBlocks(REAL[site.file], site.key).map((b) => radiusExpr(b))
    const isToken = exprs.length > 0 && exprs.every((e) => e != null && /^designRadius\./.test(e))
    add(`C: ${site.label} 取自 designRadius 令牌（不写字面量，令牌一改即同步）`,
      isToken, exprs.map(fmtExpr).join(' / '))
  }
  // 遮罩必须与它覆盖的封面解析出同值
  {
    const cov = evalRadius(kgCover[0], tokenBlock)
    const ovs = styleBlocks(REAL.kgPlaylist, 'favoritesOverlay').map((b) => evalRadius(radiusExpr(b), tokenBlock))
    add('C: favoritesOverlay 与它覆盖的 cover 解析值相同（不同源就会在四角错位）',
      cov != null && ovs.length > 0 && ovs.every((v) => v === cov),
      `cover=${cov} overlay=${ovs.join('/')}`)
  }

  // ---- D. 未列入「下调范围」的圆角不得被顺手改小 ----
  // 头像既不是容器也不是封面：圆角一旦跟着降到 4 就不再是圆形了。
  {
    const blk = styleBlocks(REAL.artistHeader, 'avatar')[0]
    const side = blk == null ? null : Number((blk.match(/width:\s*(\d+)/) || [])[1])
    const r = evalRadius(radiusExpr(blk), tokenBlock)
    add('D1: 歌手页头像圆角仍接近半圆（≥ 短边的 0.85，未被本轮下调波及）',
      side != null && r != null && r >= side / 2 * 0.85 && r <= side / 2,
      `宽 ${side} 圆角 ${r}`)
  }
  {
    const blk = styleBlocks(REAL.similarArtists, 'avatar')[0]
    const side = blk == null ? null : Number((blk.match(/width:\s*(\d+)/) || [])[1])
    const r = evalRadius(radiusExpr(blk), tokenBlock)
    add('D2: 相似歌手头像恰为圆形（圆角 = 短边一半，未被本轮下调波及）',
      side != null && r != null && r === side / 2, `宽 ${side} 圆角 ${r}`)
  }

  return out
}

// ---------------------------------------------------------------------------
// E. 反例：篡改后的源码必须被同一套不变量拦下
// ---------------------------------------------------------------------------

const tamper = [
  {
    label: '① md 令牌从 4 退回 8（所有走令牌的封面一起变圆）',
    file: 'tokens',
    mutate: (s) => s.replace(/(\n  md: )4(,)/, '$18$2'),
  },
  {
    label: '② sm 令牌调到 8（出现 sm > md 的倒挂）',
    file: 'tokens',
    mutate: (s) => s.replace(/(\n  sm: )4(,)/, '$18$2'),
  },
  {
    label: '③ glass 从 28 降到 12（与原生透镜胶囊半高脱钩）',
    file: 'tokens',
    mutate: (s) => s.replace(/(\n  glass: )28(,)/, '$112$2'),
  },
  {
    label: '④ 每日推荐 · 歌曲封面写回 6（单点回退，与令牌分叉）',
    file: 'recSongs',
    mutate: (s) => s.replace('    // 歌单封面：对齐 REF 的封面圆角（4），与 designRadius.md 同值\n    borderRadius: 4,',
      '    borderRadius: 6,'),
  },
  {
    label: '⑤ favoritesOverlay 改回写死 8（遮罩与封面脱钩，令牌一改就错位）',
    file: 'kgPlaylist',
    // 注意：styleBlocks 返回的是**去注释后**的切片，不能拿它回原文做替换；
    // 这里直接在原文里定位 favoritesOverlay 段（该文件另有 3 处同值的 designRadius.md，不能全局替换）。
    mutate: (s) => {
      const i = s.indexOf('favoritesOverlay: {')
      const j = i < 0 ? -1 : s.indexOf('borderRadius: designRadius.md', i)
      return j < 0 ? s : s.slice(0, j) + 'borderRadius: 8' + s.slice(j + 'borderRadius: designRadius.md'.length)
    },
  },
  {
    label: '⑥ 遗留令牌 Typography.js 的 normal 调到 8（与 designRadius 分叉）',
    file: 'legacy',
    mutate: (s) => s.replace(/(export const BorderRadius = \{\s*\n\s*normal: )4(,)/, '$18$2'),
  },
  {
    label: '⑦ 歌手页头像顺手降到 4（圆形头像变圆角方块）',
    file: 'artistHeader',
    mutate: (s) => s.replace('    borderRadius: 40,', '    borderRadius: 4,'),
  },
]

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

console.log('sim-radius-tokens：倒角下调（对齐 REF BorderRadius.normal = 4）\n')

const results = []
const push = (name, ok, detail = '') => results.push({ name, ok, detail })

console.log('--- A/B/C/D. 源码不变量 ---')
for (const r of runSourceInvariants()) push(r.name, r.ok, r.detail)

console.log('\n--- E. 反例自检 ---')
for (const c of tamper) {
  const src = REAL[c.file]
  const patched = c.mutate(src)
  if (patched === src) {
    push(`反例 ${c.label}`, false, '替换未命中：源码已变，反例失效需同步')
    continue
  }
  const saved = REAL[c.file]
  REAL[c.file] = patched
  const failed = runSourceInvariants().filter((r) => !r.ok)
  REAL[c.file] = saved
  push(`反例 ${c.label} 被拦下`, failed.length > 0,
    failed.length ? `命中：${failed.map((r) => r.name.split(':')[0]).join('、')}` : '未被任何不变量拦下（守卫无效）')
}

for (const r of results) {
  if (r.ok) {
    pass++
    console.log(`  PASS  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
  }
}

console.log('\n' + '='.repeat(70))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
