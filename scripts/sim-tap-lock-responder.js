/**
 * sim-tap-lock-responder.js —— 「点击锁死」responder 契约守卫（用户第 4 条）
 *
 * 现象（本轮用户原话）：「切回一个界面（推荐/歌单/搜索/我的/设置），会出现点击锁死、
 * 无法点击，但是可以滑动，滑动后就可以点击」。
 *
 * 机制（RN responder 语义）：每一次新的按压都必须先把 responder 从当前持有者手里
 * 拿过来（setResponder → 对持有者调 onResponderTerminationRequest）。持有者回
 * false 就整屏「点不动」；而 UIScrollView 的平移是**原生手势**、根本不经过
 * responder，所以「列表还能滑」；再滑一下会触发 UIKit 的 touch cancel → RN 释放
 * responder → 又能点了。即：**一个泄漏的、无条件拒绝让出的 responder** 正是这个
 * 现象的唯一成因形态，而本仓四处 PanResponder 都写着 `() => false`（注释原话
 * 「一旦接管就不再释放给外层」）——只差一次 release/terminate 丢失（本仓多处注释
 * 记录过这种丢失，各处的看门狗就是为此加的）就能把整屏锁死。
 *
 * 本脚本的契约：
 *   A) 全仓不得存在「无条件拒绝让出 responder」的写法——拒绝必须以「本组件正处于
 *      拖动会话中」为条件，这样任何泄漏的 responder 都会被下一次按压立即顶掉，
 *      自愈不再需要用户先滑一下；
 *   B) 每个拒绝站点引用的会话 ref 必须同时存在置位与复位（否则条件恒真）；
 *   C) Main.tsx 里 pager 私有闩锁（lib 的 isScrolling，被用作移动阶段的 capture）
 *      的自愈点必须齐备，且**受控**（真实手势会话期间不得抹平）；
 *   D) 语义模拟：无条件拒绝 ⇒ 按压被拒；条件拒绝 + 会话已结束 ⇒ 按压被接受；
 *      原生滑动（touch cancel）⇒ 泄漏的 responder 被释放（解释用户看到的「滑动后
 *      又能点」），并给出反例自检。
 *
 * 运行：node scripts/sim-tap-lock-responder.js
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

// 判断必须在「去掉注释」的源码上做：本轮的修复说明里就会引用老写法
// （`onPanResponderTerminationRequest: () => false`），否则脚本会把「解释为什么
// 改掉它」的注释误判成「还在用」。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  // `//` 前面是 `:`（http://）或转义反斜杠时不算注释，避免把 URL 截断
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')

const TERMINATION_RE = /onPanResponderTerminationRequest\s*:\s*([^,\n]+)/g

// 无条件拒绝：`() => false` / `function () { return false }` 这类字面量
const isUnconditionalRefusal = (expr) => {
  const e = String(expr).trim()
  if (!/false\s*\}?\s*$/.test(e) && !/^false$/.test(e)) return false
  // 只要整段表达式里出现 `?` / `&&` / `.current`，就说明它不是字面量 false
  if (/[?&|]|\.current|\.current\b/.test(e)) return false
  return /false/.test(e)
}

// 遍历源码目录。
// 注意（2026-10-02 实测）：本仓的契约脚本既可 `node` 直跑，也可经
// `python run.py` 在 headless 浏览器沙箱里跑（CI 口径）。沙箱的 fs 垫片把
// `readdirSync(dir, { withFileTypes: true })` 的 entry.isDirectory() 实现成了
// **闭包共享变量**（垫片里 `var isDir` 是函数作用域，所有 entry 共用一个），
// 于是每个 entry 都回报「最后一项」的目录性 —— 全都被判成目录，递归进去就
// 报 `ENOENT: scandir '/src/app.ts'`。所以这里**不信任 withFileTypes**：
// 用「扩展名 ⇒ 源码文件，否则按目录递归、失败即跳过」的判定，两个平台都成立。
const SRC_RE = /\.(tsx|ts|jsx|js)$/
const IGNORED_DIRS = new Set(['node_modules', '.git', 'Pods', 'build', 'DerivedData'])
// ---------------------------------------------------------------------------
// 0) responder 最小模型（A/C 的极性判定与 D 的场景模拟共用）
//
// RN 语义（务必逐字记住，写反了就是灾难）：新按压要先把 responder 从当前持有者手里
// 拿过来 —— RN 对持有者调 onResponderTerminationRequest，**返回 false = 拒绝让出**，
// 返回 true = 让出。被拒则这一次按压作废（onPress 不触发，onPressIn 都不给）。
// 所以：
//   老写法 `() => false`            = 永久拒绝 ⇒ 一次泄漏就整屏点不动（用户第 4 条）
//   错误修法 `() => ref.current`    = 拖动中**让出**、平时死锁 ⇒ 极性整个反了
//   正确写法 `() => !ref.current`   = 拖动中拒绝（保住拖动语义），平时让出（可被顶掉）
// ---------------------------------------------------------------------------
const createWorld = () => ({ responder: null, presses: 0, terminations: 0 })
const press = (world, holder) => {
  if (world.responder && world.responder !== holder) {
    world.terminations++
    if (world.responder.onTerminationRequest() === false) return false // 拒绝让出 ⇒ 按压被吞
  }
  world.responder = holder
  world.presses++
  return true
}
// 任何触摸结束（release/terminate 到达）都会释放 responder
const touchEnd = (world) => { world.responder = null }
// 原生滚动开始：UIKit 取消 content view 内的触摸 ⇒ RN 收到 touchCancel ⇒ 释放 responder
const nativeScrollBegin = (world) => { world.responder = null }
// 普通视图（歌曲行 / 按钮）默认让出
const plainView = () => ({ onTerminationRequest: () => true })

// 把源码里解析出来的表达式变成可执行 handler：`!isLockedRef.current` → 取入参的取反。
// 这样极性判定是**按行为**做的（真的把表达式跑一遍），而不是按文本模式猜——写反极性的
// 修法（`() => ref.current`）文本上「引用了会话 ref」，只有真跑才抓得住。
const handlerFromExpr = (expr, refName) => {
  const body = expr.replace(new RegExp(`${refName.replace(/\$/g, '\\$')}\\.current`, 'g'), 'ref')
  // 表达式本身是**回调**（`() => xxxRef.current`），所以要把它建起来再**调用一次**
  // 取返回值 —— 直接 `return (${body})` 只会把箭头函数本身返回出来，那玩意儿永远
  // 不等于 false，模型会误判成「一直让出」，极性判定就成了摆设。
  // eslint-disable-next-line no-new-func
  const fn = new Function('ref', `const h = (${body}); return typeof h === 'function' ? h({}, {}) : h`)
  return (current) => fn(current)
}

const srcFiles = []
const walk = (dir, depth) => {
  if (depth > 12) return
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    return // 不是目录（或不可读）—— 沙箱里对文件发的是 404，正常跳过
  }
  for (const name of names) {
    if (name.startsWith('.') || IGNORED_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (SRC_RE.test(name)) srcFiles.push(full)
    else walk(full, depth + 1)
  }
}
walk(path.join(ROOT, 'src'), 0)
srcFiles.push(path.join(ROOT, 'dependencies-patch.js'))

// ---------------------------------------------------------------------------
// A) 全仓不得存在无条件拒绝让出 responder 的写法
// ---------------------------------------------------------------------------

const offenders = []
const sites = []
let scanned = 0
for (const file of srcFiles) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    continue
  }
  // 目录列表页（沙箱里对「其实是目录的名字」发 GET 会拿到 HTML）：不是源码，跳过
  if (/^\s*<!DOCTYPE|Directory listing for/i.test(raw.slice(0, 200))) continue
  scanned++
  const code = stripComments(raw)
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  let m
  TERMINATION_RE.lastIndex = 0
  while ((m = TERMINATION_RE.exec(code)) !== null) {
    const expr = m[1].trim()
    const entry = { file: rel, expr }
    sites.push(entry)
    if (isUnconditionalRefusal(expr)) offenders.push(entry)
  }
}

console.log('\n[A] 拒绝让出 responder 的写法必须带「拖动会话中」条件')

check(
  '全仓不存在 `onPanResponderTerminationRequest: () => false` 这类无条件拒绝',
  offenders.length === 0,
  offenders.length ? offenders.map((o) => `${o.file} → ${o.expr}`).join('; ') : `扫描 ${scanned} 个源文件`,
)
check(
  '每一处拒绝都引用了一个会话 ref（`xxxRef.current`，即「仅拖动中拒绝」）',
  sites.length > 0 && sites.every((s) => /\.current/.test(s.expr)),
  sites.length ? sites.map((s) => `${s.file}: ${s.expr}`).join('; ') : '未找到任何站点',
)

// 反例自检：老写法（本轮改掉的四处）必须被判为违规
{
  const legacy = [
    '() => false',
    'function () { return false }',
  ]
  check('反例自检：无条件字面量 false 被判定为违规（老写法确实是「永久持有」）',
    legacy.every((e) => isUnconditionalRefusal(e)))
  const conditional = [
    '() => draggingRef.current',
    '() => isActivatedRef.current && !cancelled',
    '() => isLockedRef.current',
  ]
  check('反例自检：会话条件式写法不被误判（含 ?. / && 形式）',
    conditional.every((e) => !isUnconditionalRefusal(e)))
}

// ---------------------------------------------------------------------------
// A2) 极性（本仓最容易被写反的一环）
//     既然「返回 false = 拒绝让出」，那「仅拖动会话中拒绝」就必须写成 `!xxxRef.current`。
//     这里把每个站点**源码里的表达式**真的跑一遍，看两种状态下的行为：
//       ① 会话进行中 → 必须拒绝（否则拖动中途被父级 PagerView/ScrollView 抢走，
//          release 不来、seek 被丢 —— 正是当初写 `() => false` 要防的那件事）
//       ② 会话已结束（泄漏残留）→ 必须让出（否则就是用户第 4 条的「点击锁死」）
//     只满足一条 = 极性写反或没改，两条都满足才算「仅拖动中拒绝」。
// ---------------------------------------------------------------------------

console.log('\n[A2] 极性：会话中拒绝让出、会话外让出（两种状态都必须成立）')

for (const site of sites) {
  const refName = (site.expr.match(/([A-Za-z_$][\w$]*Ref)\.current/) || [])[1]
  if (!refName) {
    check(`${site.file} 的拒绝表达式能解析出会话 ref`, false, site.expr)
    continue
  }
  let evaluate
  try {
    evaluate = handlerFromExpr(site.expr, refName)
  } catch (e) {
    check(`${site.file} 的拒绝表达式可求值`, false, `${site.expr} → ${e.message}`)
    continue
  }
  const holder = {
    name: site.file,
    active: false,
    onTerminationRequest: () => evaluate(holder.active),
  }

  // ① 会话进行中：ref = true → 必须拒绝让出
  holder.active = true
  const wIn = createWorld()
  press(wIn, holder)
  const refusedInSession = press(wIn, plainView()) === false

  // ② 会话结束（含「泄漏后看门狗把会话标记复位」）：ref = false → 必须让出
  holder.active = false
  const wIdle = createWorld()
  press(wIdle, holder)
  const releasedWhenIdle = press(wIdle, plainView()) === true

  check(`${site.file} → ${site.expr}：会话中拒绝 + 会话外让出`,
    refusedInSession && releasedWhenIdle,
    `会话中拒绝=${refusedInSession} 会话外让出=${releasedWhenIdle}`)
}

// 反例自检：三种写法在同一个模型下的行为必须互不相同，否则说明模型没有区分力
{
  const behaviorOf = (expr) => {
    const evaluate = handlerFromExpr(expr, 'rRef')
    const holder = { active: false, onTerminationRequest: () => evaluate(holder.active) }
    holder.active = true
    const w1 = createWorld(); press(w1, holder)
    const inSession = press(w1, plainView()) === false
    holder.active = false
    const w2 = createWorld(); press(w2, holder)
    const idle = press(w2, plainView()) === true
    return `${inSession ? '拒绝' : '让出'}/${idle ? '让出' : '拒绝'}`
  }
  const legacy = behaviorOf('() => false')          // 永久拒绝
  const inverted = behaviorOf('() => rRef.current') // 极性写反
  const correct = behaviorOf('() => !rRef.current') // 正确
  check('反例自检：永久拒绝 / 极性写反 / 正确写法 三者在模型下行为各不相同',
    legacy === '拒绝/拒绝' && inverted === '让出/拒绝' && correct === '拒绝/让出',
    `永久拒绝=${legacy} 写反=${inverted} 正确=${correct}`)
}

// ---------------------------------------------------------------------------
// B) 会话 ref 必须既可置位也可复位（否则条件恒真 = 等于老写法）
// ---------------------------------------------------------------------------

console.log('\n[B] 被引用的会话 ref 必须有置位与复位')

const sessionRefs = [...new Set(
  sites.map((s) => (s.expr.match(/([A-Za-z_$][\w$]*Ref)\.current/) || [])[1]).filter(Boolean),
)]
check('能解析出所有会话 ref 名', sessionRefs.length > 0, sessionRefs.join(', '))

for (const ref of sessionRefs) {
  const users = sites.filter((s) => s.expr.includes(`${ref}.current`)).map((s) => s.file)
  const files = [...new Set(users)].map((rel) => path.join(ROOT, rel))
  const bodies = files.map((f) => {
    try { return stripComments(fs.readFileSync(f, 'utf8')) } catch (e) { return '' }
  })
  const setTrue = bodies.some((b) => new RegExp(`${ref}\\.current\\s*=\\s*true`).test(b))
  const setFalse = bodies.some((b) => new RegExp(`${ref}\\.current\\s*=\\s*false`).test(b))
  check(`${ref} 既被置位也被复位（条件不会恒真）`, setTrue && setFalse,
    `置位=${setTrue} 复位=${setFalse} ← ${users.join(', ')}`)
}

// 复位点必须覆盖 release 与 terminate 两条收尾路径（只覆盖一条 = 另一条丢失事件就永久锁死）
{
  const responderFiles = [...new Set(sites.filter((s) => /Ref\.current/.test(s.expr)).map((s) => s.file))]
  for (const rel of responderFiles) {
    const code = stripComments(read(rel))
    const hasRelease = /onPanResponderRelease\s*:/.test(code)
    const hasTerminate = /onPanResponderTerminate\s*:/.test(code)
    check(`${rel} 同时实现 onPanResponderRelease 与 onPanResponderTerminate（两条收尾路径都复位）`,
      hasRelease && hasTerminate, `release=${hasRelease} terminate=${hasTerminate}`)
  }
}

// ---------------------------------------------------------------------------
// C) Main.tsx：pager 私有闩锁的自愈点齐备且受控
// ---------------------------------------------------------------------------

console.log('\n[C] Main.tsx 的 pager 私有闩锁自愈点')

const mainSrc = stripComments(read('src/screens/Home/Vertical/Main.tsx'))
check('存在 clearNativePagerScrolling（唯一写入点，抹平库私有 isScrolling）',
  /clearNativePagerScrolling\s*=\s*useCallback/.test(mainSrc))
check('存在受控入口 healPagerScrollLatch，且体内有「无手势会话」守卫',
  /healPagerScrollLatch\s*=\s*useCallback/.test(mainSrc) &&
  /if\s*\(\s*pagerDragSessionRef\.current\s*\)\s*return/.test(
    (mainSrc.match(/healPagerScrollLatch\s*=\s*useCallback\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[/) || [''])[0],
  ))
check('会话收尾（endPagerDragSession）里保留无条件清理',
  /endPagerDragSession\s*=\s*useCallback/.test(mainSrc) &&
  /endPagerDragSession[\s\S]{0,700}clearNativePagerScrolling\(\)/.test(mainSrc))

const countCalls = (name) => (mainSrc.match(new RegExp(`${name}\\(\\)`, 'g')) || []).length
check('onPageSelected 里落点确定即自愈（手势/程序化切页都覆盖）',
  /onPageSelected\s*=\s*useCallback[\s\S]*?healPagerScrollLatch\(\)/.test(mainSrc))
check('navActiveIdUpdated 的切页路径里自愈（点 tab / 点卡片 / 落点回流）',
  /navActiveIdUpdated[\s\S]*?healPagerScrollLatch\(\)/.test(mainSrc))
check('周期心跳里有自愈（覆盖面最广的一道，残留最多存活一个周期）',
  new RegExp(`setInterval\\(heartbeat|setInterval\\([^)]*${'healPagerScrollLatch'}[^)]*\\)`).test(mainSrc) &&
  /const heartbeat = \(\) => \{[\s\S]*?healPagerScrollLatch\(\)/.test(mainSrc))
check('回前台（AppState → active）仍兜底清理', /state !== 'active'[\s\S]{0,200}clearNativePagerScrolling\(\)/.test(mainSrc))
check(`healPagerScrollLatch 至少 3 个调用点（当前 ${countCalls('healPagerScrollLatch')} 处，含定义外调用）`,
  countCalls('healPagerScrollLatch') >= 3)

// 反例自检：没有守卫的版本必须被判为不安全（会话中抹平会让横滑被列表抢走）
{
  const unsafe = read('src/screens/Home/Vertical/Main.tsx').includes('__never__')
  const guardOk = /if\s*\(\s*pagerDragSessionRef\.current\s*\)\s*return/.test(
    (mainSrc.match(/healPagerScrollLatch\s*=\s*useCallback\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[/) || [''])[0],
  )
  check('反例自检：无守卫的 healPagerScrollLatch 会被判为不安全（受控入口不是摆设）',
    guardOk && !unsafe)
}

// ---------------------------------------------------------------------------
// D) 语义模拟：泄漏的 responder 如何造成「点不动」，以及三种修复路径
// ---------------------------------------------------------------------------

console.log('\n[D] responder 语义模拟（按压需要拿到 responder）')

// 老写法：无条件 `() => false`（模型见第 0 节）
const legacyHolder = {
  name: 'tabbar(legacy)',
  active: false,
  onTerminationRequest: () => false,
}
// 正确写法：只在拖动会话中拒绝 —— 注意是 `!active`（会话中返回 false = 拒绝让出）
const fixedHolder = {
  name: 'tabbar(fixed)',
  active: false,
  onTerminationRequest: () => !fixedHolder.active,
}

// 泄漏：一次拖动会话的收尾事件丢失（release/terminate 都没到），responder 留在栏体上
const leak = (holder) => {
  const w = createWorld()
  holder.active = true
  press(w, holder) // 长按 arm 后移动 → grant，成为 responder
  holder.active = true // 会话标记也泄漏（本仓看门狗会在 8s/3s 后复位它）
  return w
}

{
  const w = leak(legacyHolder)
  const songRow = plainView()
  const rejected = press(w, songRow)
  check('老写法：泄漏后点歌曲行 → 按压被吞（用户报的「点击锁死」）',
    rejected === false && w.presses === 1 && w.terminations === 1,
    `press返回=${rejected} presses=${w.presses} terminations=${w.terminations}`)

  // 滑动（原生滚动）会释放它 —— 这正是用户说的「滑动后就可以点击了」
  nativeScrollBegin(w)
  const afterScroll = press(w, songRow)
  check('老写法：滑一下 → UIKit touch cancel 释放 responder → 又能点了（症状逐字吻合）',
    afterScroll === true && w.presses === 2,
    `press返回=${afterScroll} presses=${w.presses}`)
}

{
  const w = leak(fixedHolder)
  fixedHolder.active = false // 会话标记复位（看门狗 / 收尾回调任一到）
  const songRow = plainView()
  check('新写法：即使收尾事件丢失，会话复位后下一次按压直接顶掉残留 responder',
    press(w, songRow) === true)
}

{
  // 反例：拖动会话**仍在进行**时，新写法依然拒绝（不能被别的视图抢走，语义不退化）
  const w = createWorld()
  fixedHolder.active = true
  press(w, fixedHolder)
  const other = plainView()
  check('反例：拖动会话进行中 → 仍然拒绝让出（拖动语义不退化）',
    press(w, other) === false)
  fixedHolder.active = false
  touchEnd(w)
  check('反例：会话结束 + 触摸收尾 → 恢复可被抢占', press(w, other) === true)
}

console.log()
const pad = Math.max(...results.map((r) => r.label.length))
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'}  ${r.label}${r.detail ? `   [${r.detail}]` : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
