/*
 * 「三个歌单页首帧不上下跳」契约模型（用户第 15 轮第 3 条）
 *
 * 现象：点击进入网易歌单 / QQ歌单 / 酷狗歌单，第一次进入时「歌单里面的整体都会向上跳动
 *       一下在下移」；要求内容不要上下跳，保持固定在上面要求的位置上。
 *
 * 机制（从源码里推出来的两条路径，本脚本把两条防线都钉住）：
 *   一、列表**先以 data=[] 挂载**、数据到了再补进去：空列表里只有页头那一格（QQ/酷狗
 *       的 tab 文案里数量也还是 0），数据到达后整块内容按最终高度重排/复位 —— 第一下
 *       跳动。当年同工程的「我的」页（Mylist/NewListUI）是同一套 ListHeaderComponent
 *       结构、却从来没有这个跳动，差别就在它当时把 FlatList 挂在 isLoading 闸门之后。
 *       【第 30 轮·图九】用户点名取消「我的」页那颗居中转圈后，它改成了「列表常挂 +
 *       静默刷新」—— 这条对照关系到此为止：三个歌单页的闸门不再以「我的」页为参照物，
 *       而是各自的 data=[] 空挂会整块重排（E 组已改成钉「参照物换了口径」本身）。
 *   二、网易歌单页的 RefreshControl 是 refreshing={loading}，而 loading 初值为 true：
 *       列表若在挂载帧就出现，iOS 的刷新控件会当场激活、把内容整体下压，首载结束
 *       （endRefreshing）时再回弹一次 —— 就是「向上跳一下再下移」那根弹簧。当年的
 *       「我的」页同样是 refreshing={isLoading}，但闸门保证列表挂载那一帧 isLoading
 *       已经是 false，所以它不跳；本页此前既没有闸门，又比 QQ/酷狗多这一条激活路径。
 *
 * 修法 = 本脚本钉住的四条不变量：
 *   A. 三个页面都有首载闸门 listReady（初值 false），FlatList 渲染在 listReady 之后；
 *      **不得**把闸门改成挂在 loading 上 —— 下拉刷新时列表必须留在原地，不能整块换成转圈。
 *   B. 闸门只在首次加载结束时打开，且与 setLoading(false) 相邻/同批落位：列表挂载那一帧
 *      loading 必为 false（刷新控件不可能在挂载帧被激活）。加载路径里每个 setLoading(false)
 *      都要有配对的 setListReady(true)，反向也一样 —— 删一个、或把它挪到加载开始处，
 *      都判红。
 *   C. 页头（PageTopInset + DetailPageTitle [+ tab]）抽成同一个 pageHeader 元素，并**固定
 *      在列表之外**：加载分支与就绪分支都是它的兄弟节点，两处几何完全相同 —— 从转圈切到
 *      列表时标题一动不动。
 *      第 16 轮第 2 / 7 条后收紧（用户：「第一次进入时，整体刷新歌单标题和歌单内容都会向
 *      上跳动并刷新，要求不向上刷新，去除这个动作并固定标题和内容」）：页头**不再**当
 *      ListHeaderComponent —— 挂在 ListHeaderComponent 里就等于放进可滚动内容，列表挂载 /
 *      换数据 / 下拉刷新时它会跟着内容一起位移，这正是「标题向上跳一下」的来源。现在它是
 *      FlatList 的兄弟节点、渲染在 listReady 闸门之前，`{pageHeader}` 全页恰一处。
 *      第 21 轮·图三/图四起，「tab 与标题同行三等分」（第 16 轮第 2 条）被用户的新要求取代：
 *      标题在上面、按钮在标题**下面**单独一行（共享组件 PillTabs，几何与 WebDAV 逐字同源）、
 *      按钮下面才是列表 —— 本脚本因此改钉「标题行不带 equalColumns + PillTabs 行在标题之后」，
 *      tab 文字为下划线留位而整体偏高（「不和标题文字在同一直线上」）的旧结构不再允许出现。
 *   D. 首载期间有居中占位（ActivityIndicator + loadingContainer）。【第 30 轮·图九】起
 *      「我的」页不再有这颗转圈（用户点名取消），三个歌单页仍保留 —— 它们的列表一挂载
 *      就是空的，没有占位就是整块空白；对照关系见 E 组。
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

// （第 21 轮删掉了 styleBlock(tabBar/tabItem) 块解析器：标题行内三等分的 tabBar/tabItem 样式
//  已随「按钮移到标题下面」一起消失，本脚本不再需要按块取 StyleSheet 条目。）

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

/** 【第 21 轮·图三/图四】pageHeader 的排布审计（标题行 / 按钮行的相对位置与形态）。
 *  WebDAV 布局 = 标题在上面（不带 equalColumns，tab 不再塞进标题行）、按钮（PillTabs）在
 *  标题**下面**。返回三个布尔量，真实断言与反例共用同一份判据（反例变异后必须为假）。 */
const headerLayout = (code, navId) => {
  const header = sliceBy(code, 'const pageHeader = (', '\n  )\n')
  if (header == null) return { title: false, noEqualColumns: false, pillsBelowTitle: false }
  const iTitle = header.indexOf(`<DetailPageTitle title={t('${navId}')}`)
  const iPills = header.indexOf('<PillTabs')
  return {
    title: iTitle >= 0,
    noEqualColumns: iTitle >= 0 &&
      !new RegExp(`<DetailPageTitle title=\\{t\\('${navId}'\\)\\}[^>]*equalColumns`).test(header),
    pillsBelowTitle: iPills >= 0 && iTitle >= 0 && iPills > iTitle,
  }
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
// 三等分（第 16 轮第 2 条）的实现在共享组件里：equalColumns ⇒ 标题 flex:1。
// 三个页面只是调用方，单独读一份钉住「title 那一份真的占满 1 份」。
const detailTitleSrc = stripComments(read('src/components/common/DetailPageTitle.tsx'))
const pageChecks = PAGES.map((p) => {
  const src = read(p.file)
  pageSrc[p.navId] = src
  const code = stripComments(src)
  const loadSlice = sliceBy(src, p.loadFrom, p.loadTo)
  const audit = loadSlice ? auditGatePair(loadSlice) : null
  // pageHeader 分片：`const pageHeader = (` 到该字面量收尾的 `)` ——
  // 这段里必须同时有 PageTopInset 和 DetailPageTitle，才谈得上「两条分支同一份、同一几何」
  const headerSlice = sliceBy(src, 'const pageHeader = (', '\n  )\n')
  // 平台页（自带切换按钮）：酷狗歌单 / QQ歌单在标题下面挂一行 PillTabs；网易歌单页没有。
  // 【第 21 轮·图三/图四】起 tab 不再塞进标题行（旧 renderTab / equalColumns 写法），改成
  // 标题下面单独一行的共享组件 PillTabs —— WebDAV 布局「标题 → 按钮 → 列表」。
  const hasTabs = /<PillTabs/.test(code)
  const layout = headerLayout(code, p.navId)
  const iHeaderRef = code.indexOf('{pageHeader}')
  const iGate = code.indexOf('{listReady ? (')
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
    // C 组：页头抽成同一份元素，且固定在列表之外（第 16 轮第 2/7 条）
    headerConst: /const pageHeader = \(/.test(code),
    headerRefCount: (src.match(/\{pageHeader\}/g) || []).length,
    headerOutsideGate: iHeaderRef >= 0 && iGate >= 0 && iHeaderRef < iGate,
    headerNotInList: !/ListHeaderComponent=\{[^}]*pageHeader/.test(code),
    noInlineHeader: !/ListHeaderComponent=\{\s*<>/.test(code),
    headerGeometry: headerSlice != null &&
      /<PageTopInset \/>/.test(headerSlice) &&
      new RegExp(`<DetailPageTitle title=\\{t\\('${p.navId}'\\)\\}`).test(headerSlice),
    hasTabs,
    // 【第 21 轮·图三/图四】排布：标题行不带 equalColumns（tab 不再塞回标题行）；
    // 有按钮的页面 PillTabs 必须在标题**下面**（标题 → 按钮 → 列表）
    titleNoEqualColumns: layout.noEqualColumns,
    pillsBelowTitle: !hasTabs || layout.pillsBelowTitle,
    // D 组：首载期间居中占位
    spinner: /<ActivityIndicator color=\{theme\['c-primary-font'\]\} size="large" \/>/.test(code),
    loadingContainer: /styles\.loadingContainer/.test(code),
    loadingContainerCentered: /loadingContainer:\s*\{[\s\S]{0,120}?flex:\s*1[\s\S]{0,160}?justifyContent:\s*'center'/.test(code),
  }
})

// —— E. 参照物口径（第 30 轮·图九起）：「我的」页（NewListUI）那颗居中转圈已被用户点名
// 取消（「只保留下滑刷新，每次从其他页面返回进入我的页面都会刷新一次」），改成「列表常挂 +
// 静默刷新」。三个歌单页的闸门因此不再拿它当对照物；这组断言反过来钉住「参照物确实换了
// 口径」，防止有人照着上面的老注释把中心转圈加回去。
const myListSrc = read('src/screens/Home/Views/Mylist/NewListUI.tsx')
const auditMyList = (src) => {
  const code = stripComments(src)
  return {
    // 旧口径三件套（状态 isLoading + 渲染分支 + 样式 loadingContainer）必须一件都不剩
    noIsLoading: !code.includes('isLoading'),
    noCenteredSpin: !code.includes('ActivityIndicator') && !code.includes('loadingContainer'),
    // 列表不再被任何「转圈分支」替换：FlatList 常挂，唯一的旁路是 hasError 错误态
    listAlwaysMounted: /<FlatList/.test(code) && /\{hasError \? \(/.test(code),
    // 刷新动画只认用户下拉：refreshing 初值 false，由 onRefresh 那一刻置位
    pullOnlyRefresh: /refreshing=\{refreshing\}/.test(code) && /onRefresh=\{\(\) => \{ setRefreshing\(true\)/.test(code),
    // 回到本页就静默刷新的两条入口：
    //   ① tab 切回 / 子页返回（首页 pager 把它统一落回 nav_love）
    //   ② home 这个 Navigation 页面整页重新出现
    navRefresh: code.includes("global.state_event.on('navActiveIdUpdated'") && code.includes("'nav_love'"),
    appearRefresh: code.includes('registerComponentDidAppearListener') && code.includes('void refreshListInfo()'),
  }
}
const myListRef = auditMyList(myListSrc)

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
// m4: 页头被搬回列表里（ListHeaderComponent）—— 页头重新落进可滚动内容，
//     列表挂载 / 换数据 / 下拉刷新时标题跟着位移 = 本轮修掉的「向上跳一下」复发
const m4 = pageOf('nav_my_playlist').replace(
  '            data={playlists}',
  '            ListHeaderComponent={pageHeader}\n            data={playlists}',
)
const m4Caught = m4 !== pageOf('nav_my_playlist') && /ListHeaderComponent=\{[^}]*pageHeader/.test(stripComments(m4))
// m5: 顶层那份页头被删（加载分支重新变成「没有页头」，标题晚一帧才出现）
const m5 = pageOf('nav_tx_playlist').replace('        {pageHeader}\n', '')
const m5Caught = m5 !== pageOf('nav_tx_playlist') && (m5.match(/\{pageHeader\}/g) || []).length !== 1
// m5b: 页头挪到闸门里面（就绪分支才渲染）—— 加载期间没有标题，切过去时页头重新落位
const m5b = pageOf('nav_kg_playlist').replace(
  '        {pageHeader}\n        {listReady ? (',
  '        {listReady ? (\n          <>\n            {pageHeader}',
)
const m5bCaught = m5b !== pageOf('nav_kg_playlist') && (() => {
  const code = stripComments(m5b)
  const iHeaderRef = code.indexOf('{pageHeader}')
  const iGate = code.indexOf('{listReady ? (')
  return iHeaderRef >= 0 && iGate >= 0 && !(iHeaderRef < iGate)
})()
// m5c: 标题行又挂上 equalColumns（tab 塞回标题行 = 图三/图四那条老缺陷回潮）
const m5c = pageOf('nav_tx_playlist').replace(
  "<DetailPageTitle title={t('nav_tx_playlist')} />",
  "<DetailPageTitle title={t('nav_tx_playlist')} equalColumns>",
)
const m5cCaught = m5c !== pageOf('nav_tx_playlist') &&
  !headerLayout(stripComments(m5c), 'nav_tx_playlist').noEqualColumns
// m5d: PillTabs 行被搬到标题**上面**（顺序反了 —— 用户点名「标题在上面、按钮在标题栏下面」）
const m5d = pageOf('nav_kg_playlist')
  .replace("      <DetailPageTitle title={t('nav_kg_playlist')} />\n", '')
  .replace('    </>\n  )\n  return (', "      <DetailPageTitle title={t('nav_kg_playlist')} />\n    </>\n  )\n  return (")
const m5dCaught = m5d !== pageOf('nav_kg_playlist') && (() => {
  const l = headerLayout(stripComments(m5d), 'nav_kg_playlist')
  return !(l.title && l.pillsBelowTitle)
})()
// m6: 首载占位去掉转圈（只剩页头，整块空白）
const m6 = pageOf('nav_kg_playlist').replace(/<ActivityIndicator color=\{theme\['c-primary-font'\]\} size="large" \/>/, '')
const m6Caught = m6 !== pageOf('nav_kg_playlist') && !/<ActivityIndicator color=\{theme\['c-primary-font'\]\} size="large" \/>/.test(stripComments(m6))
// m7: 参照物「我的」页被改回「中心转圈」闸门（第 30 轮·图九 回潮）——旧三件套又冒出来
const m7 = myListSrc.replace(
  '      {hasError ? (',
  "      {isLoading ? (\n        <View style={styles.loadingContainer}>\n          <ActivityIndicator color={theme['c-primary-font']} size=\"large\" />\n        </View>\n      ) : hasError ? (",
)
const m7Caught = m7 !== myListSrc &&
  !(auditMyList(m7).noIsLoading && auditMyList(m7).noCenteredSpin)
// m8: 参照物「我的」页的 tab 级静默刷新入口被删（切走再切回来不再刷新），被 E 判红
const m8 = myListSrc.replace("    global.state_event.on('navActiveIdUpdated', handleNavChange)\n", '')
const m8Caught = m8 !== myListSrc && !auditMyList(m8).navRefresh
// m9: 下拉刷新被改成跟着静默加载转（refreshing={fetching}）——「只认用户下拉」失效
const m9 = myListSrc.replace('refreshing={refreshing}', 'refreshing={fetching}')
const m9Caught = m9 !== myListSrc && !auditMyList(m9).pullOnlyRefresh

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
    c.headerOutsideGate ? '页头固定在外✅' : '页头固定在外❌',
    c.headerNotInList ? '不在列表内✅' : '不在列表内❌',
    c.headerGeometry ? '两分支同几何✅' : '两分支同几何❌',
    c.spinner ? '占位✅' : '占位❌',
    c.audit ? `闸门配对 ${c.audit.closes}/${c.audit.opens}` : '闸门配对 —',
  ].join(' ')
  console.log(`  ${c.page.name.padEnd(8)} ${c.page.navId.padEnd(22)} ${flags}`)
}
console.log(`  参照物「我的」 ${'nav_love'.padEnd(22)} ${myListRef.noIsLoading && myListRef.noCenteredSpin ? '无中心转圈✅' : '无中心转圈❌'} ${myListRef.pullOnlyRefresh ? '下拉才转✅' : '下拉才转❌'} ${myListRef.navRefresh ? '回页静默刷✅' : '回页静默刷❌'}`)
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
  check(`${c.page.name}：页头抽成同一个 pageHeader 元素，且全页恰渲染一处`, c.headerConst && c.headerRefCount === 1, `引用 ${c.headerRefCount} 处`)
  check(`${c.page.name}：页头固定在列表之外（{pageHeader} 在 listReady 闸门之前）`, c.headerOutsideGate)
  check(`${c.page.name}：页头不再进列表（没有 ListHeaderComponent={pageHeader}）`, c.headerNotInList)
  check(`${c.page.name}：pageHeader 里同时有 PageTopInset 与 <DetailPageTitle title={t('${c.page.navId}')}`, c.headerGeometry)
  check(`${c.page.name}：不再内联 ListHeaderComponent={<>…</>}`, c.noInlineHeader)
}
// C 续：【第 21 轮·图三/图四】按钮改到标题下面（WebDAV 布局）—— 只对带按钮的平台页适用。
// 老的第 16 轮第 2 条「标题行内三等分」已被这一轮的用户要求取代：tab 文字为下划线留位而
// 整体偏高，正是「标题右边的按钮中文字不和标题文字在同一直线上」的根因，故不再断言
// equalColumns，改钉「标题行无 equalColumns + PillTabs 在标题之后」。
for (const c of pageChecks) {
  if (!c.hasTabs) continue
  check(`${c.page.name}：标题行不带 equalColumns（tab 不再塞进标题行）`, c.titleNoEqualColumns)
  check(`${c.page.name}：PillTabs 行在标题下面（标题 → 按钮 → 列表，WebDAV 布局）`, c.pillsBelowTitle)
}
check('共享组件 DetailPageTitle：titleEqual（弹性等分）仍在（其它页面的原行为不受影响）',
  /titleEqual:\s*\{[\s\S]{0,40}?flex:\s*1/.test(detailTitleSrc))
// D
for (const c of pageChecks) {
  check(`${c.page.name}：首载占位是居中 ActivityIndicator`, c.spinner && c.loadingContainer)
  check(`${c.page.name}：loadingContainer 居中（flex:1 + justifyContent:'center'）`, c.loadingContainerCentered)
}
// E
check('参照物「我的」页（第 30 轮·图九）：中心刷新动画已取消（isLoading / ActivityIndicator / loadingContainer 三件套一件不剩）',
  myListRef.noIsLoading && myListRef.noCenteredSpin)
check('参照物「我的」页：列表常挂（FlatList 不再被居中转圈分支替换），旁路只剩 hasError 错误态', myListRef.listAlwaysMounted)
check('参照物「我的」页：刷新动画只认用户下拉（refreshing={refreshing} + onRefresh 才置位）', myListRef.pullOnlyRefresh)
check('参照物「我的」页：回到本页就静默刷新（navActiveIdUpdated→nav_love 与 componentDidAppear 两条入口都在）',
  myListRef.navRefresh && myListRef.appearRefresh)
console.log()

// 反例
neg('反例 m1：删掉网易歌单 finally 里的 setListReady(true)（闸门永不开），被 B 判红', m1Caught)
neg('反例 m2：把闸门挪到加载开始处（列表又空挂），被 B 判红', m2Caught)
neg('反例 m3：闸门改挂 loading（下拉刷新整块换转圈），被 A 判红', m3Caught)
neg('反例 m4：页头被搬回 ListHeaderComponent（又落进可滚动内容 = 向上跳复发），被 C 判红', m4Caught)
neg('反例 m5：顶层那份页头被删（加载分支没有页头），被 C 判红', m5Caught)
neg('反例 m5b：页头挪到 listReady 闸门里面（加载期间没有标题），被 C 判红', m5bCaught)
neg('反例 m5c：标题行又挂 equalColumns（tab 塞回标题行，图三/图四老缺陷回潮），被 C 判红', m5cCaught)
neg('反例 m5d：PillTabs 行搬到标题上面（违反「标题在上面、按钮在标题下面」），被 C 判红', m5dCaught)
neg('反例 m6：去掉首载占位的 ActivityIndicator，被 D 判红', m6Caught)
neg('反例 m7：参照物「我的」页被改回中心转圈闸门（第 30 轮·图九 回潮），被 E 判红', m7Caught)
neg('反例 m8：参照物「我的」页的 tab 级静默刷新入口被删（切回本页不再刷新），被 E 判红', m8Caught)
neg('反例 m9：下拉刷新改成 refreshing={fetching}（静默加载也转圈），被 E 判红', m9Caught)

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
