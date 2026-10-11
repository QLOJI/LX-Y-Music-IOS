/**
 * sim-mylist-swipe-back.js
 *
 * 「我的列表右滑返回我的主界面」契约不变量（第 20 轮·图四后半，2026-10-03）。
 *
 * 用户原话：「我的列表中，例如试听列表、我的收藏及其他同步列表中，增加右滑返回的功能，
 * 返回到我的主界面」。
 *
 * 这件事要三条同时成立，缺一条用户侧就是「这功能好像不存在」，或者更糟：
 *   ① 边缘手势带够宽、够灵敏 —— SwipeBackArea 原来是「带宽 12pt + 认领阈值 dx>12」：
 *      带太窄手指落不进去，阈值又不比带宽容多少（要横着走满一个带宽才认领），
 *      而且底下的原生 PagerView / ScrollView 会先把手势抢走；
 *   ② 手势真的落得到这一层 —— 覆盖层底下就是首页 PagerView，浮层可见且正停在「我的」页
 *      时必须把 pager 横滑锁掉（NewListUI 发 changeHomePageScrollEnabled(false)，
 *      Vertical/Main.tsx 消费），并且**离开时必须交还 true** —— 锁漏放的话五个 tab 页
 *      会直到杀进程都滑不动（P0 级，本仓 DrawerLayoutFixed 有过同类教训）；
 *   ③ 返回动作沿用页面既有入口 —— onBack 必须是 handleBackToList（与左上角返回按钮
 *      同一个函数，含 250ms 防误触窗口），不另起一套关闭逻辑。
 *
 * 本脚本从源码抽取真实写法做断言，并带反例自检（tsc/eslint 对「带宽回退」「锁漏放」
 * 这类问题完全无感）。运行：node scripts/sim-mylist-swipe-back.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const SWIPE = 'src/components/common/SwipeBackArea.tsx'
const NEW_LIST = 'src/screens/Home/Views/Mylist/NewListUI.tsx'
const MAIN = 'src/screens/Home/Vertical/Main.tsx'

const REAL_SWIPE = read(SWIPE)
const REAL_LIST = read(NEW_LIST)
const REAL_MAIN = read(MAIN)

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const count = (src, needle) => src.split(needle).length - 1

// ---------------------------------------------------------------------------
// 不变量 A：手势带本身（宽度 / 认领阈值 / 触发阈值 / 不吞点击）
// ---------------------------------------------------------------------------

const swipeInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // ① 手势带宽度：放宽到 20pt（≈ iOS 系统边缘返回带），样式里用常量不写字面量
  const band = code.match(/const EDGE_BAND_WIDTH = (\d+)/)
  if (!band) {
    reasons.push('未找到 EDGE_BAND_WIDTH（锚点漂移，先修脚本锚点）')
  } else {
    const w = Number(band[1])
    if (!(w >= 14 && w <= 24)) {
      reasons.push(`手势带宽度 = ${w}pt，不在 [14, 24] —— 12pt 太窄（≈4mm），手指很难稳稳落在带内`)
    }
  }
  if (!/width: EDGE_BAND_WIDTH/.test(code)) {
    reasons.push('手势带样式宽度没有引用 EDGE_BAND_WIDTH（宽度有两个来源，改一处不生效）')
  }

  // ② 认领阈值：必须明显小于旧值 12（旧组合「带宽 12 + 阈值 12」抢不过原生 pan）
  const claim = code.match(/const CLAIM_MIN_DX = (\d+)/)
  if (!claim) {
    reasons.push('未找到 CLAIM_MIN_DX')
  } else {
    const v = Number(claim[1])
    if (!(v >= 2 && v < 12)) {
      reasons.push(`接管手势的最小横向位移 = ${v}pt，不在 [2, 12) —— 旧值 12 要「横着走满一个带宽」才认领`)
    }
  }

  // ③ 触发阈值：松手判定仍在，且给足回弹余量
  const trigger = code.match(/const TRIGGER_MIN_DX = (\d+)/)
  if (!trigger) {
    reasons.push('未找到 TRIGGER_MIN_DX')
  } else {
    const v = Number(trigger[1])
    if (!(v >= 20 && v <= 80)) {
      reasons.push(`触发返回的最小横向位移 = ${v}pt，不在 [20, 80]`)
    }
    if (claim && !(v > Number(claim[1]))) {
      reasons.push('触发阈值不大于认领阈值（认领即触发，轻微横滑就误返回）')
    }
  }

  // ④ 认领规则两份都在（ShouldSet 与 ShouldSetCapture），且都是「横向 > 纵向 2 倍」
  const rule = 'dx > CLAIM_MIN_DX && Math.abs(dx) > Math.abs(dy) * 2'
  if (count(code, rule) !== 2) {
    reasons.push(
      `横向优先的认领规则出现 ${count(code, rule)} 处（应为 2：ShouldSet 与 ShouldSetCapture 各一份，少一份会被原生 pager / ScrollView 抢走手势）`,
    )
  }

  // ⑤ 单击永远不认领（落在带内的按钮照常可点）
  if (!/onStartShouldSetPanResponder: \(\) => false/.test(code)) {
    reasons.push('单击认领没有被显式拒绝（onStartShouldSetPanResponder 不再返回 false ⇒ 带内按钮点击被吞）')
  }

  // ⑥ 松手判定唯一，且遵守 enabled 门
  const releases = count(code, 'onBackRef.current()')
  if (releases !== 1) reasons.push(`onBackRef.current() 出现 ${releases} 处（应恰好 1：唯一触发点）`)
  if (!/if \(enabledRef\.current && dx > TRIGGER_MIN_DX\) onBackRef\.current\(\)/.test(code)) {
    reasons.push('触发条件不是「enabledRef.current && dx > TRIGGER_MIN_DX」（enabled=false 的实例也会触发返回）')
  }

  // ⑦ 手势层自身必须仍是事件目标（'box-none' 会让 PanResponder 收不到事件，横滑返回直接失效）
  if (!/pointerEvents=\{enabled \? 'auto' : 'none'\}/.test(code)) {
    reasons.push("pointerEvents 不是 enabled ? 'auto' : 'none'（box-none / none 会让本层收不到手势）")
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：我的页覆盖层（右滑入口 + 首页 pager 横滑锁 + 交还）
// ---------------------------------------------------------------------------

const listInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // ① 浮层可见性与横滑锁定义在组件前段（横屏早退之前）—— 条件分支里调 Hook 是硬伤
  const overlayIdx = code.indexOf('const isDetailOverlayVisible =')
  const earlyReturnIdx = code.indexOf('if (isHorizontal) {')
  if (overlayIdx < 0) {
    reasons.push('未找到 isDetailOverlayVisible 定义')
  } else if (earlyReturnIdx >= 0 && overlayIdx > earlyReturnIdx) {
    reasons.push('isDetailOverlayVisible / 横滑锁被放到了横屏早退之后（条件式 Hook，横竖屏切换会崩）')
  }

  // ② 锁条件 = 浮层可见 且 停在「我的」页（少了 nav_love 门会把别的 tab 页一起锁死）
  if (!/const shouldLockHomePager = isDetailOverlayVisible && navActiveId === 'nav_love'/.test(code)) {
    reasons.push("横滑锁条件不是「isDetailOverlayVisible && navActiveId === 'nav_love'」")
  }
  if (count(code, 'const navActiveId = useNavActiveId()') !== 1) {
    reasons.push(`useNavActiveId() 调用出现 ${count(code, 'const navActiveId = useNavActiveId()')} 处（应恰好 1）`)
  }
  if (!/import\s*\{[^}]*\buseNavActiveId\b[^}]*\}\s*from\s*'@\/store\/common\/hook'/.test(code)) {
    reasons.push('useNavActiveId 不是从 @/store/common/hook 导入的')
  }

  // ③ 发事件用同一个布尔取反（写死 false ⇒ 收起浮层后首页横滑永远回不来）
  if (!/changeHomePageScrollEnabled\?\.\(!shouldLockHomePager\)/.test(code)) {
    reasons.push('发事件不是 !shouldLockHomePager（写死 false ⇒ 收起浮层 / 切 tab 后首页横滑永远回不来）')
  }

  // ④ cleanup 在锁着时交还 true（依赖变化与卸载都执行；锁漏放 = 五个 tab 页直到杀进程都滑不动）
  if (!/if \(shouldLockHomePager\) global\.app_event\.changeHomePageScrollEnabled\?\.\(true\)/.test(code)) {
    reasons.push('cleanup 没有在锁着时交还 true（锁漏放，首页横滑会永久失效）')
  }
  if (!/\}, \[shouldLockHomePager\]\)/.test(code)) {
    reasons.push('横滑锁 effect 的依赖没有收敛到 [shouldLockHomePager]')
  }

  // ⑤ 覆盖层里有且只有一处右滑返回，且与左上角返回共用 handleBackToList
  const swipeUses = count(code, '<SwipeBackArea onBack={handleBackToList} />')
  if (swipeUses !== 1) {
    reasons.push(`覆盖层里的 <SwipeBackArea onBack={handleBackToList} /> 出现 ${swipeUses} 处（应恰好 1）`)
  }
  const handlerUses = count(code, 'onBack={handleBackToList}')
  if (handlerUses !== 2) {
    reasons.push(`onBack={handleBackToList} 出现 ${handlerUses} 处（应为 2：MusicList 的左上角返回 + SwipeBackArea 的右滑，共用同一个关闭函数）`)
  }

  // ⑥ 防误触窗口仍在（覆盖层全新挂载时，迟到的手势 release 余波不会把它关掉）
  if (!/Date\.now\(\) - openedAtRef\.current < 250/.test(code)) {
    reasons.push('handleBackToList 的 250ms 防误触窗口被改动/删除')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：首页 pager 的消费端（锁必须真的能拦住横滑）
// ---------------------------------------------------------------------------

const mainInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // ① 监听唯一且成对退订
  if (count(code, "global.app_event.on('changeHomePageScrollEnabled', handleScrollEnabled)") !== 1) {
    reasons.push('changeHomePageScrollEnabled 的监听不是恰好一处')
  }
  if (count(code, "global.app_event.off('changeHomePageScrollEnabled', handleScrollEnabled)") !== 1) {
    reasons.push('监听的退订缺失（重挂载会叠出第二份回调，锁语义被复制）')
  }
  if (!/setDrawerScrollEnabled\(enabled\)/.test(code)) {
    reasons.push('回调没有把开关写进 state（锁到不了 pager）')
  }

  // ② 锁因子参与 pager 的 scrollEnabled（否则锁与手势带都在，pager 根本不看这个开关）
  if (!/const pagerScrollEnabled = drawerScrollEnabled && !tabBarDragActive/.test(code)) {
    reasons.push('pagerScrollEnabled 不再由 drawerScrollEnabled（横滑锁）参与换算')
  }
  if (count(code, 'scrollEnabled={pagerScrollEnabled}') < 1) {
    reasons.push('PagerView 没有消费 pagerScrollEnabled（锁发得再对也没人听）')
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

  // m1 手势带回退到 12pt（老带宽）→ 报「手势带宽度」
  check('m1 手势带回退到 12pt', () =>
    swipeInvariants(tamper(REAL_SWIPE, 'const EDGE_BAND_WIDTH = 20', 'const EDGE_BAND_WIDTH = 12')),
  '手势带宽度')

  // m2 认领阈值抬回 12（等于旧值，抢不过原生 pan）→ 报「接管手势的最小横向位移」
  check('m2 认领阈值抬回 12pt', () =>
    swipeInvariants(tamper(REAL_SWIPE, 'const CLAIM_MIN_DX = 8', 'const CLAIM_MIN_DX = 12')),
  '接管手势的最小横向位移')

  // m3 单击也开始认领（带内按钮点击被吞）→ 报「单击认领」
  check('m3 单击也认领（onStartShouldSetPanResponder 放宽）', () =>
    swipeInvariants(tamper(REAL_SWIPE, 'onStartShouldSetPanResponder: () => false', 'onStartShouldSetPanResponder: () => true')),
  '单击认领')

  // m4 松手判定丢掉 enabled 门（enabled=false 的实例也会触发返回）→ 报「触发条件」
  check('m4 松手判定丢掉 enabled 门', () =>
    swipeInvariants(tamper(REAL_SWIPE,
      'if (enabledRef.current && dx > TRIGGER_MIN_DX) onBackRef.current()',
      'if (dx > TRIGGER_MIN_DX) onBackRef.current()')),
  '触发条件')

  // m5 Capture 分支的认领规则被摘（只剩一份，会被原生层抢走手势）→ 报「认领规则」
  check('m5 摘掉 Capture 分支的认领规则', () =>
    swipeInvariants(tamper(REAL_SWIPE,
      '      onMoveShouldSetPanResponderCapture: (_event, { dx, dy }) =>\n        dx > CLAIM_MIN_DX && Math.abs(dx) > Math.abs(dy) * 2,\n',
      '')),
  '认领规则')

  // m6 锁条件丢掉 nav_love 门（别的 tab 页也被锁住）→ 报「nav_love」
  check('m6 锁条件丢掉 nav_love 门', () =>
    listInvariants(tamper(REAL_LIST,
      "const shouldLockHomePager = isDetailOverlayVisible && navActiveId === 'nav_love'",
      'const shouldLockHomePager = isDetailOverlayVisible')),
  "'nav_love'")

  // m7 cleanup 不交还 true（锁漏放，首页横滑永久失效）→ 报「交还」
  check('m7 cleanup 不交还 true（锁漏放）', () =>
    listInvariants(tamper(REAL_LIST,
      '      if (shouldLockHomePager) global.app_event.changeHomePageScrollEnabled?.(true)\n',
      '')),
  '交还')

  // m8 发事件写死 false（收起浮层后横滑也回不来）→ 报「写死 false」
  check('m8 发事件写死 false', () =>
    listInvariants(tamper(REAL_LIST,
      'changeHomePageScrollEnabled?.(!shouldLockHomePager)',
      'changeHomePageScrollEnabled?.(false)')),
  '写死 false')

  // m9 覆盖层里摘掉 SwipeBackArea（右滑返回不存在）→ 报「SwipeBackArea」
  check('m9 覆盖层摘掉右滑返回', () =>
    listInvariants(tamper(REAL_LIST,
      '          <SwipeBackArea onBack={handleBackToList} />\n',
      '')),
  'SwipeBackArea')

  // m10 首页监听被删（锁到不了 pager）→ 报「监听」
  check('m10 首页侧监听被删', () =>
    mainInvariants(tamper(REAL_MAIN,
      "    global.app_event.on('changeHomePageScrollEnabled', handleScrollEnabled)\n",
      '')),
  '监听')

  // m11 pagerScrollEnabled 去掉横滑锁因子（锁无效）→ 报「不再由 drawerScrollEnabled」
  check('m11 pager 开关去掉横滑锁因子', () =>
    mainInvariants(tamper(REAL_MAIN,
      'const pagerScrollEnabled = drawerScrollEnabled && !tabBarDragActive',
      'const pagerScrollEnabled = !tabBarDragActive')),
  '不再由 drawerScrollEnabled')

  // m12 PagerView 不消费 pagerScrollEnabled → 报「没有消费」
  check('m12 PagerView 不消费开关', () =>
    mainInvariants(tamper(REAL_MAIN,
      'scrollEnabled={pagerScrollEnabled}',
      'scrollEnabled={true}')),
  '没有消费')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-mylist-swipe-back ===')

const sections = [
  ['手势带（SwipeBackArea：20pt 带宽 / 8pt 认领 / 40pt 触发 / 不吞点击）', () => swipeInvariants(REAL_SWIPE)],
  ['我的页覆盖层（右滑入口 + pager 横滑锁 + 离开交还）', () => listInvariants(REAL_LIST)],
  ['首页 pager 消费端（Vertical/Main.tsx：监听成对 + 开关参与 scrollEnabled）', () => mainInvariants(REAL_MAIN)],
]

let invOk = true
for (const [name, fn] of sections) {
  const reasons = fn()
  console.log(`\n[${name}]`)
  if (reasons.length === 0) {
    console.log('  PASS')
  } else {
    invOk = false
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
console.log(
  `\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${invOk ? `${sections.length}/${sections.length}` : `0/${sections.length}`}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`,
)
process.exit(allOk ? 0 : 1)
