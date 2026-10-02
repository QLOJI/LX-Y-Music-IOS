/*
 * 「三个歌单页首帧不上下跳」契约模型（用户第 15 轮第 3 条）
 *
 * 现象：点击进入网易歌单 / QQ歌单 / 酷狗歌单，第一次进入时「歌单里面的整体都会向上跳动
 *       一下在下移」；要求内容不要上下跳，保持固定在上面要求的位置上。
 *
 * 机制（从源码里推出来的两条路径，本脚本把两条防线都钉住）：
 *   一、列表**先以 data=[] 挂载**、数据到了再补进去：空列表里只有页头那一格（QQ/酷狗
 *       的 tab 文案里数量也还是 0），数据到达后整块内容按最终高度重排/复位 —— 第一下
 *       跳动。对照组就在本工程：「我的」页（Mylist/NewListUI）是同一套
 *       ListHeaderComponent 结构，但它的 FlatList 挂在 isLoading 之后（转圈 → 有数据
 *       才挂列表），从来没有这个跳动。三个歌单页此前缺的正是这道闸门。
 *   二、网易歌单页的 RefreshControl 是 refreshing={loading}，而 loading 初值为 true：
 *       列表若在挂载帧就出现，iOS 的刷新控件会当场激活、把内容整体下压，首载结束
 *       （endRefreshing）时再回弹一次 —— 就是「向上跳一下再下移」那根弹簧。「我的」页
 *       同样是 refreshing={isLoading}，但闸门保证列表挂载那一帧 isLoading 已经是 false，
 *       所以它不跳；本页此前既没有闸门，又比 QQ/酷狗多这一条激活路径。
 *
 * 修法 = 本脚本钉住的四条不变量：
 *   A. 三个页面都有首载闸门 listReady（初值 false），FlatList 渲染在 listReady 之后；
 *      **不得**把闸门改成挂在 loading 上 —— 下拉刷新时列表必须留在原地，不能整块换成转圈。
 *   B. 闸门只在首次加载结束时打开，且与 setLoading(false) 相邻/同批落位：列表挂载那一帧
 *      loading 必为 false（刷新控件不可能在挂载帧被激活）。加载路径里每个 setLoading(false)
 *      都要有配对的 setListReady(true)，反向也一样 —— 删一个、或把它挪到加载开始处，
 *      都判红。
 *   C. 页头（PageTopInset + DetailPageTitle [+ tab]）抽成同一个 pageHeader 元素：加载分支
 *      当普通兄弟节点、就绪分支当 ListHeaderComponent，两处几何完全相同 —— 从转圈切到
 *      列表时标题一动不动。不允许再退回「内联写在 ListHeaderComponent 里」（那样加载期间
 *      标题会晚一帧才出现、切过去时页头要重新落位）。
 *   D. 首载期间有居中占位（ActivityIndicator + loadingContainer），与「我的」页同一个口径。
 *
 * 本脚本是**静态源码解析**（正则 + 分片），钉住的是「结构还在不在」，证明不了真机上到底
 * 还跳不跳。每条断言都配了一个「改回旧实现就该判红」的反例，反例全部用当前源码做变异，
 * 防止断言写成永远为真的空壳。
 *
 * 运行：node scripts/sim-playlist-first-paint.js
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const results = []
let failed = 0
const check = (label, ok, detail) => {
  results.push({ label, ok: !!ok, detail })
  if (!ok) failed++
}

/** 去掉行注释：只给「不该出现」类断言用，避免注释里的字样造成假命中 */
const stripComments = (s) => s.split('\n').map((line) => {
  const at = line.indexOf('//')
  return at < 0 ? line : line.slice(0, at)
}).join('\n')

/** 首载路径分片：三个页面的「首次加载」代码块（不含下拉刷新 onRefresh） */
const PAGES = [
  {
    name: '网易歌单',
    file: 'src/screens/Home/Views/MyPlaylist/index.tsx',
    navId: 'nav_my_playlist',
    loadFrom: 'const lastLoadKeyRef',
    loadTo: '}, [cookie, uid])',
  },
  {
    name: 'QQ歌单',
    file: 'src/screens/Home/Views/TxPlaylist/index.tsx',
    navId: 'nav_tx_playlist',
    loadFrom: 'const fetchPlaylists = useCallback(',
    loadTo: '}, [fetchCreatedPlaylists, fetchCollectedPlaylists])',
  },
  {
    name: '酷狗歌单',
    file: 'src/screens/Home/Views/KgPlaylist/index.tsx',
    navId: 'nav_kg_playlist',
    loadFrom: 'const fetchPlaylists = useCallback(',
    loadTo: '}, [kgCookie, t])',
  },
]

const sliceBy = (code, from, to) => {
  const a = code.indexOf(from)
  if (a < 0) return null
  const b = code.indexOf(to, a)
  if (b < 0) return null
  return code.slice(a, b + to.length)
}

/**
 * 闸门配对审计：加载路径里 setListReady(true) 与 setLoading(false) 必须一一配对
 * （±2 行以内算同批）。返回未配对的闭合/开启位置 —— 任一非空即判红。
 */
const auditGatePair = (slice) => {
  const lines = slice.split('\n')
  const opens = []
  const closes = []
  lines.forEach((line, i) => {
    if (/setListReady\(true\)/.test(line)) opens.push(i)
    if (/setLoading\(false\)/.test(line)) closes.push(i)
  })
  const near = (a, b) => Math.abs(a - b) <= 2
  return {
    opens: opens.length,
    closes: closes.length,
    unpairedOpen: opens.filter((i) => !closes.some((j) => near(i, j))),
    unpairedClose: closes.filter((i) => !opens.some((j) => near(i, j))),
    lines,
  }
}

const pageSrc = {}
const pageChecks = PAGES.map((p) => {
  const src = read(p.file)
  pageSrc[p.navId] = src
  const code = stripComments(src)
  const loadSlice = sliceBy(src, p.loadFrom, p.loadTo)
  const audit = loadSlice ? auditGatePair(loadSlice) : null
  // pageHeader 分片：从 `const pageHeader = (` 到把它交给列表的那一行 ——
  // 这段里必须同时有 PageTopInset 和 DetailPageTitle，才谈得上「两条分支同一几何」
  const headerSlice = sliceBy(src, 'const pageHeader = (', 'ListHeaderComponent={pageHeader}')
  return {
    page: p,
    src,
    // A 组：闸门存在、初值 false、盯的是 listReady 不是 loading
    gateState: /const \[listReady, setListReady\] = useState\(false\)/.test(code),
    gateUsed: /listReady \? \(/.test(code),
    gateNotKeyedOnLoading: !/\{!loading\s*\?/.test(code),
    singleList: (src.match(/<FlatList/g) || []).length === 1,
    // B 组：闸门只在加载结束时开，且与 setLoading(false) 配对
    loadSlice: loadSlice,
    audit,
    // C 组：页头抽成同一份元素
    headerConst: /const pageHeader = \(/.test(code),
    headerInList: /ListHeaderComponent=\{pageHeader\}/.test(code),
    headerRefCount: (src.match(/\{pageHeader\}/g) || []).length,
    noInlineHeader: !/ListHeaderComponent=\{\s*<>/.test(code),
    headerGeometry: headerSlice != null &&
      /<PageTopInset \/>/.test(headerSlice) &&
      new RegExp(`<DetailPageTitle title=\\{t\\('${p.navId}'\\)\\}`).test(headerSlice),
    // D 组：首载期间居中占位
    spinner: /<ActivityIndicator color=\{theme\['c-primary-font'\]\} size="large" \/>/.test(code),
    loadingContainer: /styles\.loadingContainer/.test(code),
    loadingContainerCentered: /loadingContainer:\s*\{[\s\S]{0,120}?flex:\s*1[\s\S]{0,160}?justifyContent:\s*'center'/.test(code),
  }
})

// —— E. 参照物：「我的」页（NewListUI）必须保持「先转圈、有数据才挂列表」的同款口径 ——
// 三个歌单页的注释与断言都拿它当对照，它要是变回「列表照挂、只是空着」，这组断言的前提就塌了。
const myListSrc = read('src/screens/Home/Views/Mylist/NewListUI.tsx')
const myListCode = stripComments(myListSrc)
const myListGateIdx = myListCode.indexOf('isLoading ? (')
const myListListIdx = myListCode.indexOf('<FlatList')
const myListRef = {
  gate: myListGateIdx >= 0,
  spinnerBeforeList: myListGateIdx >= 0 && myListListIdx > myListGateIdx,
  loadingContainer: /loadingContainer/.test(myListCode),
}

// —— 反例（全部用当前源码变异，必须被上面某一组判红）——
const neg = (label, ok) => {
  results.push({ label, ok: !!ok })
  if (!ok) failed++
}
const pageOf = (navId) => pageSrc[navId]
// m1: 网易歌单把 finally 里的 setListReady(true) 删掉（闸门永远不开 → 页面卡在转圈）
const m1 = pageOf('nav_my_playlist').replace(
  'setLoading(false)\n        setListReady(true)\n      })',
  'setLoading(false)\n      })',
)
const m1Slice = sliceBy(m1, 'const lastLoadKeyRef', '}, [cookie, uid])')
const m1Caught = m1 !== pageOf('nav_my_playlist') && m1Slice != null &&
  auditGatePair(m1Slice).unpairedClose.length > 0
// m2: QQ 把闸门挪到加载开始处（列表又变成空挂 → 数据到达时整块重排）
const m2 = pageOf('nav_tx_playlist').replace(
  'setLoading(true)\n      }',
  'setLoading(true)\n        setListReady(true)\n      }',
)
const m2Slice = sliceBy(m2, 'const fetchPlaylists = useCallback(', '}, [fetchCreatedPlaylists, fetchCollectedPlaylists])')
const m2Caught = m2 !== pageOf('nav_tx_playlist') && m2Slice != null &&
  auditGatePair(m2Slice).unpairedOpen.length > 0
// m3: 闸门改挂在 loading 上（下拉刷新会整块换成转圈）
const m3 = pageOf('nav_kg_playlist').replace('{listReady ? (', '{!loading ? (')
const m3Caught = m3 !== pageOf('nav_kg_playlist') && /\{!loading\s*\?/.test(stripComments(m3))
// m4: 加载分支把页头删掉（标题晚一帧才出现，切过去时页头要重新落位）
const m4 = pageOf('nav_my_playlist').replace('{pageHeader}\n            <View style={styles.loadingContainer}>', '<View style={styles.loadingContainer}>')
const m4Caught = m4 !== pageOf('nav_my_playlist') && (m4.match(/\{pageHeader\}/g) || []).length < 2
// m5: 页头退回内联在 ListHeaderComponent 里（加载期间没有页头）
const m5 = pageOf('nav_tx_playlist').replace('ListHeaderComponent={pageHeader}', 'ListHeaderComponent={<>\n              <PageTopInset />\n            </>}')
const m5Caught = m5 !== pageOf('nav_tx_playlist') && !/ListHeaderComponent=\{pageHeader\}/.test(m5)
// m6: 首载占位去掉转圈（只剩页头，整块空白）
const m6 = pageOf('nav_kg_playlist').replace(/<ActivityIndicator color=\{theme\['c-primary-font'\]\} size="large" \/>/, '')
const m6Caught = m6 !== pageOf('nav_kg_playlist') && !/<ActivityIndicator color=\{theme\['c-primary-font'\]\} size="large" \/>/.test(stripComments(m6))
// m7: 参照物「我的」页退回「列表照挂」——闸门那段结构被拆掉
const m7 = myListSrc.replace('isLoading ? (', 'true ? (')
const m7Caught = m7 !== myListSrc && m7.indexOf('isLoading ? (') < 0

// —— 输出 ——
console.log('='.repeat(92))
console.log('「三个歌单页首帧不上下跳」契约模型（摘自源码，静态解析）')
console.log('='.repeat(92))
for (const c of pageChecks) {
  const flags = [
    c.gateState ? '闸门✅' : '闸门❌',
    c.gateUsed ? '列表在闸门后✅' : '列表在闸门后❌',
    c.gateNotKeyedOnLoading ? '不挂loading✅' : '不挂loading❌',
    c.headerConst ? '页头常量化✅' : '页头常量化❌',
    c.headerInList ? '页头入列✅' : '页头入列❌',
    c.headerGeometry ? '两分支同几何✅' : '两分支同几何❌',
    c.spinner ? '占位✅' : '占位❌',
    c.audit ? `闸门配对 ${c.audit.closes}/${c.audit.opens}` : '闸门配对 —',
  ].join(' ')
  console.log(`  ${c.page.name.padEnd(8)} ${c.page.navId.padEnd(22)} ${flags}`)
}
console.log(`  参照物「我的」 ${'nav_love'.padEnd(22)} ${myListRef.gate ? '转圈门✅' : '转圈门❌'} ${myListRef.spinnerBeforeList ? '列表在门后✅' : '列表在门后❌'} ${myListRef.loadingContainer ? '占位样式✅' : '占位样式❌'}`)
console.log()

// A
for (const c of pageChecks) {
  check(`${c.page.name}：有首载闸门 listReady（初值 false）`, c.gateState)
  check(`${c.page.name}：FlatList 渲染在 listReady 之后`, c.gateUsed && c.singleList)
  check(`${c.page.name}：闸门不挂在 loading 上（下拉刷新时列表留在原地）`, c.gateNotKeyedOnLoading)
}
// B
for (const c of pageChecks) {
  check(`${c.page.name}：首载路径可定位（${c.page.loadFrom} … ${c.page.loadTo}）`, c.loadSlice != null)
  check(`${c.page.name}：加载路径里 setListReady(true) 与 setLoading(false) 一一配对（同批落位）`,
    c.audit != null && c.audit.opens > 0 && c.audit.unpairedOpen.length === 0 && c.audit.unpairedClose.length === 0,
    c.audit ? `开 ${c.audit.opens} / 关 ${c.audit.closes}，未配对 ${c.audit.unpairedOpen.length + c.audit.unpairedClose.length}` : '分片失败')
}
// C
for (const c of pageChecks) {
  check(`${c.page.name}：页头抽成同一个 pageHeader 元素`, c.headerConst && c.headerInList)
  check(`${c.page.name}：加载分支与列表分支共用 pageHeader（引用 ≥ 2 处）`, c.headerRefCount >= 2, `引用 ${c.headerRefCount} 处`)
  check(`${c.page.name}：pageHeader 里同时有 PageTopInset 与 <DetailPageTitle title={t('${c.page.navId}')}`, c.headerGeometry)
  check(`${c.page.name}：不再内联 ListHeaderComponent={<>…</>}`, c.noInlineHeader)
}
// D
for (const c of pageChecks) {
  check(`${c.page.name}：首载占位是居中 ActivityIndicator`, c.spinner && c.loadingContainer)
  check(`${c.page.name}：loadingContainer 居中（flex:1 + justifyContent:'center'）`, c.loadingContainerCentered)
}
// E
check('参照物「我的」页：FlatList 仍在 isLoading 闸门之后（转圈 → 有数据才挂列表）', myListRef.gate && myListRef.spinnerBeforeList)
check('参照物「我的」页：占位样式仍为 loadingContainer', myListRef.loadingContainer)
console.log()

// 反例
neg('反例 m1：删掉网易歌单 finally 里的 setListReady(true)（闸门永不开），被 B 判红', m1Caught)
neg('反例 m2：把闸门挪到加载开始处（列表又空挂），被 B 判红', m2Caught)
neg('反例 m3：闸门改挂 loading（下拉刷新整块换转圈），被 A 判红', m3Caught)
neg('反例 m4：加载分支删掉 {pageHeader}（标题晚一帧、页头重新落位），被 C 判红', m4Caught)
neg('反例 m5：页头退回内联在 ListHeaderComponent 里，被 C 判红', m5Caught)
neg('反例 m6：去掉首载占位的 ActivityIndicator，被 D 判红', m6Caught)
neg('反例 m7：参照物「我的」页闸门被拆（本脚本的前提塌掉），被 E 判红', m7Caught)

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
