/**
 * B-6 契约：退出重进恢复到退出前所在界面（含页内子状态）
 *
 * 断言四组事实（全部从源码解析，注释先剥离再断言结构）：
 *
 *  A) 时序：读盘恢复必须先于 Home 挂载
 *     core/init/index.ts 里 await loadViewRestoreState()（在 initCommonState 之前），
 *     app.ts 里 pushHomeScreen 只在 await handleInit()（内部 await init()）之后发起。
 *  B) 一次性消费语义（core/viewRestore.ts）
 *     模块级 consumed 标记、pendingId 不匹配时不消耗、消费时先置位再返回、
 *     loadViewRestoreState 每次重置 consumed；读盘失败退化为默认值且绝不 reject。
 *  C) 落盘合并语义（utils/data.ts saveViewPrevDetail）
 *     discovery / songlist 按顶层键浅合并（存平台不能冲掉同层歌单详情）、
 *     合并基线在 then 内重读、playlist:null 是有效状态必须落盘、立即写盘不节流。
 *  D) 两端接线
 *     推荐页消费 nav_discovery（平台 + 页内歌单详情）且「排序变化重置」的既有语义
 *     在首次运行被跳过（否则会盖掉刚恢复的平台）；歌单页消费 nav_songlist；
 *     两处都在状态变化时落盘。反面边界：「我的」页不得消费恢复（需求明确只回主界面）。
 *
 * 运行：node scripts/sim-view-restore-b6.js
 */

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

// 注释里会大量提到被移除/被禁止的旧写法（如「playlist:null 必须落盘」），
// 结构断言必须在去注释后的源码上做。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const viewRestore = read('src/core/viewRestore.ts')
const viewRestoreCode = stripComments(viewRestore)
const initIndex = read('src/core/init/index.ts')
const appTs = read('src/app.ts')
const dataTs = stripComments(read('src/utils/data.ts'))
const discovery = stripComments(read('src/screens/Home/Views/Discovery/index.tsx'))
const songlistContent = stripComments(read('src/screens/Home/Views/SongList/Content.tsx'))

// ============================ A) 时序 ============================
check('core/init 里 await loadViewRestoreState（走 withTimeout 兜住存储 I/O 卡死）',
  /await\s+withTimeout\(\s*loadViewRestoreState\(\)/.test(initIndex),
  '')

const idxRestore = initIndex.indexOf('loadViewRestoreState()')
const idxCommonState = initIndex.indexOf('initCommonState(')
check('恢复读盘早于 initCommonState（状态未就绪前先落待恢复缓存）',
  idxRestore > -1 && idxCommonState > -1 && idxRestore < idxCommonState,
  `restore@${idxRestore} common@${idxCommonState}`)

check('app.ts：pushHomeScreen 在 await handleInit() 之后，且 init() 被 await（先恢复后挂载）',
  /await\s+handleInit\(\)[\s\S]{0,200}?pushHomeScreen\(\)/.test(appTs) &&
  /handlePushedHomeScreen\s*=\s*await\s+init\(\)/.test(appTs),
  '')

check('loadViewRestoreState 有 try/catch（读盘失败退化为默认值，绝不 reject）',
  /export\s+const\s+loadViewRestoreState[\s\S]*?try\s*\{[\s\S]*?catch\s*\{/.test(viewRestoreCode),
  '')

// ============================ B) 一次性消费 ============================
check('consumed 是模块级标记（进程级，横竖屏卸载重挂载不重复消费）',
  /^let\s+consumed\s*=\s*false\s*$/m.test(viewRestoreCode),
  '')

check('consumeViewRestore：id 不匹配时不消耗（先判断、后置位）',
  /if\s*\(\s*consumed\s*\|\|\s*pendingId\s*!==\s*id\s*\)\s*return\s+null/.test(viewRestoreCode),
  '')

const consumeBody = /export\s+const\s+consumeViewRestore[\s\S]*?\n\}/.exec(viewRestoreCode)
check('consumeViewRestore：consumed = true 在 return 之前（消费即置位）',
  !!consumeBody && /consumed\s*=\s*true[\s\S]*?return\s+pendingDetail/.test(consumeBody[0]),
  '')

check('loadViewRestoreState 重置 consumed = false（同一次启动只服务首挂的那一个界面）',
  /consumed\s*=\s*false/.test(viewRestoreCode.slice(viewRestoreCode.indexOf('loadViewRestoreState'))),
  '')

check('loadViewRestoreState 末尾 setNavActiveId(id)（顶层 id 恢复的唯一写入口）',
  /setNavActiveId\(\s*id\s*\)/.test(viewRestoreCode),
  '')

check('「不恢复」边界在模块头写明（搜索页 / 我的页详情 / 播放历史浮层）',
  /不恢复/.test(viewRestore) && /nav_play_history/.test(viewRestore) && /我的/.test(viewRestore),
  '')

// ============================ C) 落盘合并语义 ============================
check('saveViewPrevDetail：discovery / songlist 按顶层键浅合并（存平台不冲掉歌单详情）',
  /discovery:\s*patch\.discovery\s*\?\s*\{\s*\.\.\.base\.discovery,\s*\.\.\.patch\.discovery\s*\}/.test(dataTs) &&
  /songlist:\s*patch\.songlist\s*\?\s*\{\s*\.\.\.base\.songlist,\s*\.\.\.patch\.songlist\s*\}/.test(dataTs),
  '')

check('合并基线在 then 内重读（同一 tick 连续保存不互相冲掉）',
  /const\s+base\s*=\s*viewPrevDetail\s*\?\?\s*\{\}/.test(dataTs) &&
  /\.then\(\s*\(\s*\)\s*=>\s*\{[\s\S]{0,200}?const\s+base/.test(dataTs),
  '')

check('playlist:null 是有效状态：patch 含 playlist 时不因 null 被过滤',
  !/playlist\s*&&/.test(dataTs) && !/\?\s*patch\.discovery\.playlist\s*:/.test(dataTs),
  '')

check('立即写盘不节流（saveViewPrevDetail 本体不是 throttle 包装）',
  /export\s+const\s+saveViewPrevDetail\s*=\s*\(patch/.test(dataTs) &&
  !/saveViewPrevDetail\s*=\s*throttle/.test(dataTs),
  '')

// ============================ D) 消费端：推荐页 ============================
check('推荐页导入 consumeViewRestore + saveViewPrevDetail',
  /from\s+'@\/core\/viewRestore'/.test(discovery) && /saveViewPrevDetail/.test(discovery),
  '')

check('推荐页消费 nav_discovery',
  /consumeViewRestore\(\s*'nav_discovery'\s*\)/.test(discovery),
  '')

check('selectedSource 惰性初始化：恢复值仍在可用平台内才采用，否则回落第一位/’kw’',
  /useState<Source>\(\(\)\s*=>\s*\{[\s\S]{0,400}?restoredDiscoveryRef\.current\?\.source[\s\S]{0,200}?orderedSources\.includes\([\s\S]{0,200}?orderedSources\[0\][\s\S]{0,80}?'kw'/.test(discovery),
  '')

check('selectedPlaylist 惰性初始化自恢复值（不是直接 null）',
  /useState<ListInfoItem\s*\|\s*null>\(\s*\(\)\s*=>\s*restoredDiscoveryRef\.current\?\.playlist\s*\?\?\s*null/.test(discovery),
  '')

check('「排序变化跟随第一位」保留，但首次运行只做失效回落、不重置（否则盖掉恢复的平台）',
  /isFirstOrderEffectRef\.current[\s\S]{0,300}?return/.test(discovery) &&
  /isFirstOrderEffectRef[\s\S]{0,600}?const\s+first\s*=\s*orderedSources\[0\]/.test(discovery),
  '')

check('推荐页落盘：{ discovery: { source, playlist } }，依赖 [selectedSource, selectedPlaylist]',
  /saveViewPrevDetail\(\{\s*discovery:\s*\{\s*source:\s*selectedSource,\s*playlist:\s*selectedPlaylist\s*\}\s*\}\)/.test(discovery) &&
  /\},\s*\[selectedSource,\s*selectedPlaylist\]\)/.test(discovery),
  '')

// ============================ D) 消费端：歌单页 ============================
check('歌单页消费 nav_songlist（一次性），并保留 selectedList 状态',
  /consumeViewRestore\(\s*'nav_songlist'\s*\)/.test(songlistContent) &&
  /restoredDetailRef\.current\?\.songlist\?\.playlist/.test(songlistContent),
  '')

check('歌单页落盘：{ songlist: { playlist: selectedList } }（关闭详情存 null）',
  /saveViewPrevDetail\(\{\s*songlist:\s*\{\s*playlist:\s*selectedList\s*\}\s*\}\)/.test(songlistContent),
  '')

// ============================ 反面边界：「我的」页不恢复 ============================
const mylistDir = path.join(ROOT, 'src/screens/Home/Views/Mylist')
const mylistFiles = []
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full)
    else if (/\.tsx?$/.test(name)) mylistFiles.push(full)
  }
}
walk(mylistDir)
const mylistLeak = mylistFiles.filter((f) => /consumeViewRestore|saveViewPrevDetail/.test(fs.readFileSync(f, 'utf8')))
check('「我的」页不做页内恢复（需求明确：只回主界面，禁止扩大恢复范围）',
  mylistLeak.length === 0,
  mylistLeak.length ? mylistLeak.map((f) => path.relative(ROOT, f)).join(', ') : `扫描 ${mylistFiles.length} 个文件`)

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
