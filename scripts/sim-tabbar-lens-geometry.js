/**
 * 底部 Tab 栏液态透镜（药丸指示器）：静止几何对齐 + 形变规则回归。
 *
 * 背景（用户 2026-10-01 第 4 条）：
 *   「底部 tab 栏的椭圆位置偏了，没有和推荐、歌单、搜索、我的、设置中心对齐，
 *     而且在滑动过程中它的过程动画一会儿圆一会儿扁，规则应是滑动快就扁、速度慢就正常，
 *     滑到设置位置时它会有明显的抽搐和抖动。」
 *
 * 拆成两件互不相干的事，本脚本分别锁死：
 *
 *  ① **静止几何**（谁决定药丸停在哪）
 *     药丸中心 x = (index + 0.5) * barWidth / 5，槽宽 = barWidth / 5，
 *     tab 项 flex:1 均分同一条栏体 —— 两者由构造同一，**任何时刻都不该偏**。
 *     历史上唯一会偏的路径是「跟手/拖动结束后 React 没重发 x prop → 药丸停在手指
 *     离开的那一帧」，所以收尾必须有显式重锚（B 段不变量）。
 *     一旦栏体自己带了水平 padding、或 tab 项不是 flex:1（换成固定宽度），
 *     槽心与公式就会分叉成「偏一点」——D 段用数值模型把这个分叉量化。
 *
 *  ② **形变规则**（椭圆什么时候扁）
 *     需求给的规则是「快就扁、慢就正常」，即 |速度| 单调驱动、静止回正。
 *     上游实现用的是**加速度**（位置的二阶差分）：二阶差分除以 dt² 把采样噪声
 *     放大到能撞上限幅，而且减速阶段加速度与推进阶段反号 —— 于是药丸在运动过程里
 *     反复「圆→扁→圆→扁」（用户说的一会儿圆一会儿扁），点击切页时模型值瞬移
 *     还会喂出一个巨大假激励（抽搐）。现在改为速度驱动 + 跳变样本剔除（C 段）。
 *
 *  ③ **第 37 轮**（2026-10-09 用户第 1 条 + 新增样式）
 *     bug：「底部 tab 栏有个椭圆形气泡，在左右滑动切换界面时，会出现推荐、歌单、搜索、
 *     我的、设置的文字不在气泡正中心的情况，特别是在滑动界面不切换界面的时候，右滑一点，
 *     文字偏右，左滑一点，文字偏左，不滑动改成点击后，文字就在气泡正中心了。」
 *     → 第 35 轮只修了位置，漏了**状态**：那个「气泡」不是静止药丸，而是抬起的液态玻璃。
 *       跟手通道每一笔都 removeAllAnimations，把在途的点击弹簧打断成 finished == NO，
 *       而 completion 当时在 !finished 时直接 return → 落回被跳过、透镜永久停在抬起态。
 *       修法（B17-B20 / C19-C20）：① 收尾/复位写全部 force（跳过两头去重）；
 *       ② 被跟手打断的弹簧由 _followTookOver 补做落回；③ 让位条件收紧成「只在真拖动中
 *       让位」（arm 标志挂 8s 不再吞 pager 收尾）；④ endFollow 复位到 -1 哨兵。
 *     新增样式：「底部 tab 栏，长按后椭圆形气泡会变大，类似水珠的样式，功能和一起一样，
 *     只是多了这个样式。」→ 水珠 = 边长 1.45 × 栏高的正方形 bounds（长按 arm 时经
 *     droplet prop 下发），Swift 侧 min(w,h)/2 画成正圆、纵向溢出栏体（C16-C18 / D11）；
 *     为此栏体不再裁剪（A11，overflow: 'visible'），玻璃的圆角由宿主自己转发自持。
 *
 * 运行：node scripts/sim-tabbar-lens-geometry.js
 * 退出码：不变量全过且反例全被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  tabBar: 'src/components/layout/ModernTabBar.tsx',
  lensJs: 'src/components/common/LiquidLens.tsx',
  main: 'src/screens/Home/Vertical/Main.tsx',
  tokens: 'src/theme/DesignTokens.ts',
  lensSwift: 'ios/Vendor/LiquidGlassKit/Sources/LiquidLensView.swift',
  hostMm: 'ios/Vendor/LiquidGlassKit/Sources/LiquidGlassViewManager.mm',
}
const REAL = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, read(v)]))
const stripped = () => Object.fromEntries(Object.entries(REAL).map(([k, v]) => [k, stripComments(v)]))

let pass = 0
let fail = 0

// ---------------------------------------------------------------------------
// 取值工具
// ---------------------------------------------------------------------------

/** 取 `\n<缩进>key: {` … 同缩进 `}` 之间的样式块（注释已剔除）；找不到返回 null */
const styleBlock = (src, key) => {
  const s = stripComments(src)
  const m = new RegExp(`(?:^|\\n)([ \\t]*)${key}:\\s*\\{`, 'm').exec(s)
  if (!m) return null
  const start = m.index + m[0].length
  const end = s.indexOf(`\n${m[1]}}`, start)
  return end < 0 ? null : s.slice(start, end)
}

/** 读 `name: 123`（对象字面量里的数值，用于 designSpacing.lg 这类令牌） */
const fieldNumber = (src, name) => {
  const m = new RegExp(`(?:^|[{,\\n])\\s*${name}:\\s*(-?\\d+(?:\\.\\d+)?)\\b`, 'm').exec(stripComments(src))
  return m ? Number(m[1]) : null
}

/** 读 Swift 常量 `private let name: Type = 123` 的数值 */
const swiftNumber = (src, name) => {
  const m = new RegExp(`${name}\\s*:\\s*[A-Za-z]+\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\b`).exec(stripComments(src))
  return m ? Number(m[1]) : null
}

/** 扫 ios/Vendor/LiquidGlassKit/Sources 下所有源码（Swift / ObjC），用于「旧实现不得残留」类断言 */
const vendorSources = () => {
  const dir = path.join(ROOT, 'ios/Vendor/LiquidGlassKit/Sources')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => /\.(swift|m|mm|h)$/.test(f))
    .map((f) => ({ file: f, src: stripComments(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')) }))
}

// ---------------------------------------------------------------------------
// 不变量：源码 + 数值模型
// ---------------------------------------------------------------------------

const runSourceInvariants = () => {
  const out = []
  const push = (name, ok, detail = '') => out.push({ name, ok, detail })
  const S = stripped()
  const tab = S.tabBar
  const lens = S.lensSwift
  const host = S.hostMm
  const tokens = S.tokens

  const LG = fieldNumber(tokens, 'lg') // designSpacing.lg
  const GLASS_R = fieldNumber(tokens, 'glass')
  // tabBarBaseHeight 是顶层 `export const x = 56`，不是对象字段
  const barHMatch = /export const tabBarBaseHeight\s*=\s*(-?\d+(?:\.\d+)?)/.exec(tokens)
  const BAR_H = barHMatch ? Number(barHMatch[1]) : null

  const DEVICES = [
    { name: 'iPhone 16 Pro Max', w: 440, h: 956, pr: 3, fontScale: 1, fontSize: 1 },
    { name: 'iPhone SE', w: 320, h: 568, pr: 2, fontScale: 1, fontSize: 1 },
    { name: 'Pro Max·大字体1.3', w: 440, h: 956, pr: 3, fontScale: 1, fontSize: 1.3 },
    { name: 'iPad 1024×768', w: 1024, h: 768, pr: 2, fontScale: 1, fontSize: 1 },
  ]
  // 逐字抄自 src/utils/pixelRatio.ts（同 sim-collapsed-row-align.js，公式变了要一起改）
  const effScale = (d) => {
    const w = Math.min(d.w, d.h)
    const h = Math.max(d.w, d.h)
    return Math.min((w * d.pr) / 375, (h * d.pr) / 667, 3.1, 1.2 * d.pr)
  }
  const scaleSizeW = (size, d) => Math.floor((size * effScale(d)) / d.pr) * d.fontSize

  const TAB_N = 5
  // 栏体宽度：屏宽 − 两侧 wrapper 的 paddingHorizontal（createStyle 后 = scaleSizeW(lg)）
  const barWidthOf = (d) => d.w - 2 * scaleSizeW(LG, d)
  const slotOf = (d) => barWidthOf(d) / TAB_N
  const lensXOf = (d, i) => ((i + 0.5) * barWidthOf(d)) / TAB_N   // 与源码公式同形

  // ---------------- A. 静止几何：唯一真源 ----------------
  // 行尾锚定（\s*$）：子串断言挡不住「在后面继续做算术」的篡改（`... - 8` 仍含原串）
  push('A1 药丸中心公式 = ((activeIndex + 0.5) * barWidth) / TAB_IDS.length',
    /const lensX = barWidth > 0 \? \(\(activeIndex \+ 0\.5\) \* barWidth\) \/ TAB_IDS\.length : 0\s*$/m.test(tab))
  push('A2 药丸宽度 = 一个 tab 槽宽（barWidth / TAB_IDS.length）',
    /const lensPillWidth = barWidth \/ TAB_IDS\.length\s*$/m.test(tab))
  push('A3 activeIndex 由 TAB_IDS.findIndex 推导（不是全局导航序号）',
    /const activeIndex = Math\.max\(TAB_IDS\.findIndex\(\(tab\) => tab\.id === resolvedActiveId\), 0\)/.test(tab))

  // tab 项 flex:1 均分 —— 槽心 = (i+0.5)*barWidth/5 的**唯一**依据
  const itemBlock = styleBlock(tab, 'item') || ''
  push('A4 tab 项 flex:1 且无 margin/padding/gap（否则槽心 ≠ 公式）',
    /flex:\s*1\b/.test(itemBlock) && !/\b(margin|padding|gap)\w*\s*:/.test(itemBlock),
    itemBlock.replace(/\s+/g, ' ').trim().slice(0, 60))
  // 栏体自己带水平内边距时，flex 子项分的是「扣掉 padding 的宽度」，公式却用整宽 → 系统性偏移
  const barBlock = styleBlock(tab, 'bar') || ''
  push('A5 栏体无水平 padding（有则槽心与公式系统性分叉，D3 量化）',
    barBlock !== '' && !/padding(Horizontal|Left|Right)\s*:/.test(barBlock))
  push('A6 透镜宿主与 tab 项同一包含块（absoluteFill 铺满栏体）',
    tab.includes('const lensStyle = useMemo(() => StyleSheet.absoluteFill, [])') &&
    /<LiquidLens[\s\S]{0,240}?style=\{lensStyle\}[\s\S]{0,240}?x=\{lensX\}[\s\S]{0,240}?pillWidth=\{lensPillWidth\}/.test(tab))
  push('A7 栏宽取自 onLayout 实测（与槽心同源，不另算）',
    tab.includes('setBarWidth(e.nativeEvent.layout.width)') &&
    tab.includes('onLayout={handleLensBarLayout}'))
  const tabIds = /const TAB_IDS = \[([\s\S]*?)\] as const/.exec(tab)
  const idsOrder = tabIds ? (tabIds[1].match(/id:\s*'([^']+)'/g) || []).map((s) => s.replace(/.*'([^']+)'.*/, '$1')) : []
  push('A8 TAB_IDS 顺序 = 推荐/歌单/搜索/我的/设置（药丸槽位的地基）',
    idsOrder.join(',') === 'nav_discovery,nav_songlist,nav_search,nav_love,nav_setting',
    idsOrder.join(' > '))
  const mIds = /const TAB_PAGE_IDS = \[([^\]]*)\] as const/.exec(S.main)
  const pageIds = mIds ? (mIds[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)) : []
  push('A9 Main 的 TAB_PAGE_IDS 与 TAB_IDS 同序（滑到哪页 ↔ 药丸停哪槽）',
    pageIds.join(',') === idsOrder.join(','), pageIds.join(' > '))
  push('A10 子页面归父 tab 后再定位（否则 findIndex = -1 药丸跑到推荐位）',
    /const resolvedActiveId = CHILD_TAB_PARENT\[activeId\] \?\? activeId/.test(tab))
  // 【第 37 轮】栏体必须**不裁剪**：新增样式「长按后气泡长成水珠」要求透镜纵向溢出
  // 栏体上下边缘（透镜是栏体的兄弟子节点，栏体一裁就被削平成宽胶囊）。栏体圆角不靠
  // 这层裁剪：玻璃宿主自己把 RN 的 borderRadius 转发给玻璃容器与材质视图
  // （见 C21 的源码锚点），两处圆角本来就同 token（designRadius.glass）。
  // ⚠️ 也不能改成「给玻璃套一层裁剪 wrapper」：液态路径的捕获排除根 = 玻璃宿主的
  // superview，套 wrapper 会把 tab 图标/文字漏进捕获纹理（重影）。
  push('A11 栏体不裁剪（overflow: visible）+ 玻璃圆角自持（不靠父级裁剪，也不套 wrapper）',
    /overflow: 'visible'/.test(barBlock) && !/overflow: ?'hidden'/.test(barBlock) &&
    host.includes('_glassView.layer.cornerRadius = self.layer.cornerRadius') &&
    host.includes('_glassBacking.layer.cornerRadius = self.layer.cornerRadius'))

  // ---------------- B. 跟手会话收尾重锚 ----------------
  push('B1 跟手通道记录最后写入的 x（判定本次会话是否驱动过药丸）',
    tab.includes('const lastFollowXRef = useRef(-1)') &&
    tab.includes('lastFollowXRef.current = followX'))
  push('B2 重锚函数存在，且第一条语句就是「本次会话没驱动过 → 直接返回」',
    /const snapLensToRestingSlot = useCallback\(\(\) => \{\s*\n\s*if \(lastFollowXRef\.current < 0\) return\s*\n\s*lastFollowXRef\.current = -1\s*\n\s*lensRef\.current\?\.setFollowX\(resolveRestingSlotX\(\), true\)/.test(tab))
  // 【第 35 轮第 3 条】重锚目标从 lensXRef 换成 resolveRestingSlotX：见 B16。
  // 【第 37 轮第 1 条】重锚是**权威落位**，必须 force 写：见 B17。
  push('B3 重锚目标是「当前归属 tab 的槽心」（静止槽心公式），不是四舍五入的跟手落点',
    /return \(\(index \+ 0\.5\) \* width\) \/ TAB_IDS\.length/.test(tab) &&
    tab.includes('lensRef.current?.setFollowX(resolveRestingSlotX(), true)'))
  // 顺序：必须在 endFollow() 之前，否则 LiquidLens 的去重值已被复位，正常跟手也会多写一次原生
  const dragSub = /subscribePagerDrag\(\(dragging\) => \{([\s\S]*?)\n  \}\), \[/.exec(tab)
  const dragBody = dragSub ? dragSub[1] : ''
  push('B4 pager 会话结束时先重锚再 endFollow（顺序颠倒即多写一次原生、打断在途弹簧）',
    dragBody.indexOf('snapLensToRestingSlot()') >= 0 &&
    dragBody.indexOf('snapLensToRestingSlot()') < dragBody.indexOf('endFollow()'),
    dragBody.replace(/\s+/g, ' ').trim().slice(0, 90))
  push('B5 A-5 长按接管时作废跟手标记（避免被下一次 pager 收尾误消费）',
    /handleTabLongPress[\s\S]{0,600}?lastFollowXRef\.current = -1/.test(tab))
  push('B6 跟手写入走 setNativeProps（不触发 React 重渲染）+ 0.1pt 去重（B4 顺序的前提）+ force 可跳过该去重（第 37 轮第 1 条）',
    S.lensJs.includes('setNativeProps?.({ followX: nextX })') &&
    S.lensJs.includes('if (!force && Math.abs(nextX - lastFollowXRef.current) < 0.1) return'))

  // ---------------- B7-B12. 静止锚点自愈 + B-7 会话看门狗（2026-10-08 用户报「椭圆与其中
  //                  文字和图标没有中心对齐」） ----------------
  // 病根不是几何（A/D 段已证明静止几何逐点相等），而是**状态脱钩**：x prop 只在「值变化」
  // 时下发，跟手通道却把药丸中心写到任意位置 —— 任何一次丢收尾（pager 'idle' 被系统手势
  // 抢占 / 转场吞掉 / 退后台丢掉）都会把脱钩状态永久留在屏幕上，因为它永远不会自愈。
  // 补的两层：① 每次锚点输入变化重申静止位（走 x 通道，同位守卫保证零开销）；
  //           ② B-7 跟手会话自己的看门狗（A-5 早有两条，这条一直没有）。
  push('B7 LiquidLens 提供 setRestX 静止锚点自愈出口，且写的是 `x` 通道（followX 是 removeAllAnimations 直落，会把点击切页的淡入+抬起+弹簧打断成瞬移）',
    S.lensJs.includes('setRestX: (x: number) => void') &&
    /setRestX: \(nextX: number\) => \{[\s\S]{0,400}?setNativeProps\?\.\(\{ x: nextX \}\)/.test(S.lensJs))
  push('B8 锚点输入变化就重申静止位（挂载 / 切 tab / 子页面归属 / 栏宽 / 收起展开 / 液态开关），A-5 会话期间让位',
    /useEffect\(\(\) => \{\s*if \(!liquidGlassOn \|\| collapsed \|\| barWidth <= 0\) return\s*if \(dragArmedRef\.current \|\| draggingRef\.current\) return\s*lensRef\.current\?\.setRestX\(lensX\)\s*\}, \[lensX, resolvedActiveId, barWidth, collapsed, liquidGlassOn\]\)/.test(tab))
  push('B9 B-7 会话看门狗存在，且记账口径是「无新帧 4s」的 debounce（不是会话总时长；4000 = Main 的 2000ms 静默兜底的两倍，正常收尾轮不到它，只有整条收尾链都丢了才由它兜底）',
    tab.includes('const FOLLOW_SESSION_TIMEOUT_MS = 4000') &&
    tab.includes('const followWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)') &&
    /const armFollowWatchdog = useCallback\(\(\) => \{\s*if \(followWatchdogRef\.current\) clearTimeout\(followWatchdogRef\.current\)\s*followWatchdogRef\.current = setTimeout\(\(\) => \{\s*followWatchdogRef\.current = null\s*if \(dragArmedRef\.current \|\| draggingRef\.current\) return\s*closePagerFollowSession\(\)\s*\}, FOLLOW_SESSION_TIMEOUT_MS\)\s*\}, \[closePagerFollowSession\]\)/.test(tab))
  push('B10 记账三处齐全：跟手帧重新 arm / 会话开始 arm（与首帧顺序不保证）/ 正常收尾销毁；正常收尾同时收水珠（第 37 轮）',
    /lensRef\.current\?\.setFollowX\(followX\)\s*armFollowWatchdog\(\)/.test(tab) &&
    /if \(dragging\) \{[\s\S]{0,400}?armFollowWatchdog\(\)[\s\S]{0,400}?clearRestReassert\(\)\s*\} else \{\s*if \(followWatchdogRef\.current\) \{\s*clearTimeout\(followWatchdogRef\.current\)\s*followWatchdogRef\.current = null\s*\}\s*snapLensToRestingSlot\(\)\s*lensRef\.current\?\.setDroplet\(false\)\s*lensRef\.current\?\.endFollow\(\)\s*reassertRestingSlot\(\)/.test(tab))
  push('B11 兜底收尾 = 正常收尾同一套动作、同一顺序（锚回槽心 → 落回静止药丸 → 收水珠 → 复位跟手去重 → 重申静止位；顺序换了会打断在途弹簧）',
    /const closePagerFollowSession = useCallback\(\(\) => \{\s*snapLensToRestingSlot\(\)\s*lensRef\.current\?\.setLifted\(false\)\s*lensRef\.current\?\.setDroplet\(false\)\s*lensRef\.current\?\.endFollow\(\)\s*reassertRestingSlot\(\)\s*\}, \[snapLensToRestingSlot, reassertRestingSlot\]\)/.test(tab))
  push('B12 A-5 接管（长按 arm）与卸载清理都销毁看门狗（不留一次凭空触发的收尾 / 不在已卸载组件上跑）',
    /lastFollowXRef\.current = -1\s*if \(followWatchdogRef\.current\) \{\s*clearTimeout\(followWatchdogRef\.current\)\s*followWatchdogRef\.current = null\s*\}/.test(tab) &&
    /if \(pressOutTimerRef\.current\) \{ clearTimeout\(pressOutTimerRef\.current\); pressOutTimerRef\.current = null \}\s*if \(followWatchdogRef\.current\) \{ clearTimeout\(followWatchdogRef\.current\); followWatchdogRef\.current = null \}/.test(tab))

  // ---------------- B13-B16. 静止位重申（2026-10-08 第 35 轮第 3 条） ----------------
  // 用户原话：「当我左右滑动主界面时，底部 tab 的椭圆形水泡边缘与我的文字不是中心对齐，
  // 左边明显大点，如果我点击就不会有这个情况，只有滑动才会出现这个问题，不论在推荐、
  // 歌单、搜索、我的、设置都一样。」
  //
  // 静止几何本身没问题（A/D 段已证明逐点相等），错的是**收尾锚点读了一份迟到的值**：
  // 收尾（pager 'idle'）读的是 lensXRef.current，而它只在上方那个无依赖 useEffect 里刷新
  // —— 即「onPageSelected 引发的那次 React 提交跑完之后」。提交还没跑完就收尾 ⇒ 锚回**旧槽**；
  // 且「滑回同一个 tab」时 lensX 前后相等、x prop 不变，React 不会再下发任何东西
  // ⇒ 错位永不自愈。点击切页永远会改 lensX（换 tab）因此从不复现 —— 正是用户描述的
  // 「只有滑动才会、点一下就好」。修法：① 收尾改读「当下」的槽心（直读 store，
  // setNavActiveId 是同步写）；② 收尾后有界地重申几次，给迟到的那次提交留出落点。
  push('B13 静止槽心的「新鲜」取值源：直读 store 的 navActiveId（同步写，比 React 提交早一整个周期），公式与 lensX 同形，取不到时回退 lensXRef',
    tab.includes("import commonState from '@/store/common/state'") &&
    /const resolveRestingSlotX = useCallback\(\(\) => \{[\s\S]{0,1200}?const activeIdNow = commonState\.navActiveId[\s\S]{0,600}?return \(\(index \+ 0\.5\) \* width\) \/ TAB_IDS\.length[\s\S]{0,600}?\}, \[\]\)/.test(tab))
  push('B14 收尾后按**有界**延迟表重申静止位（每次现取目标：已对齐时被 LiquidLens 的 0.1pt 去重吞掉，零原生写入；不设无界循环）',
    tab.includes('const REST_REASSERT_DELAYS = [120, 360, 800, 1600]') &&
    /const clearRestReassert = useCallback\(\(\) => \{\s*for \(const timer of restReassertTimersRef\.current\) clearTimeout\(timer\)\s*restReassertTimersRef\.current = \[\]\s*\}, \[\]\)/.test(tab) &&
    /const reassertRestingSlot = useCallback\(\(\) => \{\s*clearRestReassert\(\)\s*for \(const delay of REST_REASSERT_DELAYS\) \{/.test(tab))
  push('B15 重申带两道让位守卫（拖动中让位、跟手会话让位；arm 未接管不再拦 —— 第 37 轮第 1 条）+ 两处清账（新一轮会话开始与卸载）',
    /if \(draggingRef\.current\) return\s*\n\s*if \(lastFollowXRef\.current >= 0\) return\s*\n\s*lensRef\.current\?\.setFollowX\(resolveRestingSlotX\(\), true\)/.test(tab) &&
    /if \(dragging\) \{[\s\S]{0,400}?clearRestReassert\(\)/.test(tab) &&
    /useEffect\(\(\) => clearRestReassert, \[clearRestReassert\]\)/.test(tab))
  push('B16 重锚不再读 lensXRef（迟一个提交的旧值就是「只有滑动才错位、点一下就好」的根因）',
    !/const snapLensToRestingSlot = useCallback\(\(\) => \{[\s\S]{0,400}?setFollowX\(lensXRef\.current\)/.test(tab))

  // ---------------- B17-B20. 第 37 轮第 1 条：气泡不居中 ----------------
  // 用户原话：「底部 tab 栏有个椭圆形气泡，在左右滑动切换界面时，会出现推荐、歌单、
  // 搜索、我的、设置的文字不在气泡正中心的情况，特别是在滑动界面不切换界面的时候，
  // 右滑一点，文字偏右，左滑一点，文字偏左，不滑动改成点击后，文字就在气泡正中心了。」
  //
  // 第 35 轮只修了「位置」（收尾重锚 + 有界重申），漏了「状态」——这个气泡根本不是静止
  // 药丸，而是**抬起的液态玻璃**：跟手通道每一笔都 [lens.layer removeAllAnimations]，
  // 把在途的点击弹簧打断成 finished == NO，而 completion 当时在 !finished 时直接
  // return ⇒「落回静止药丸」被整个跳过，透镜永久停在抬起玻璃态（宽度 ≠ 槽宽、边缘
  // 还带速度形变，文字自然不在它的正中心）。点一下之所以就好，是因为新弹簧的
  // completion（finished == YES）补做了落回。宿主侧的修复见 C19/C20。
  push('B17 收尾/复位写全是 force 写（跳过 JS 0.1pt 去重），逐帧跟手写保持普通去重',
    (tab.match(/setFollowX\([^;]{0,60}?, true\)/g) || []).length >= 6 &&
    /lensRef\.current\?\.setFollowX\(followX\)\s*armFollowWatchdog\(\)/.test(tab),
    `force 写 ${(tab.match(/setFollowX\([^;]{0,60}?, true\)/g) || []).length} 处`)
  push('B18 A-5 让位条件收紧成「只在真的拖动中让位」：抬起照旧丢弃，放下必须放行（arm 标志挂 8s 不再吞掉 pager 收尾）',
    /if \(dragging && dragArmedRef\.current\) return\s*\n\s*lensRef\.current\?\.setLifted\(dragging\)/.test(tab) &&
    !/if \(dragArmedRef\.current \|\| draggingRef\.current\) return\s*\n\s*lensRef\.current\?\.setLifted\(dragging\)/.test(tab))
  push('B19 水珠不跨会话存活：所有收尾路径都下发 setDroplet(false)（长按臂/会话收尾/拖动收尾/抬手回退/兜底收尾 ≥5 处），长按臂下发 setDroplet(true)',
    (tab.match(/setDroplet\(false\)/g) || []).length >= 5 &&
    /handleTabLongPress[\s\S]{0,2000}?setDroplet\(true\)/.test(tab),
    `setDroplet(false) ${(tab.match(/setDroplet\(false\)/g) || []).length} 处`)
  push('B20 LiquidLens 面：droplet prop/handle 齐全；endFollow 复位到 -1 哨兵（0 是合法坐标——最左槽左缘附近，不能拿它当「无会话」）',
    S.lensJs.includes('droplet?: boolean') &&
    /setDroplet: \(on: boolean\) => void/.test(S.lensJs) &&
    S.lensJs.includes('setNativeProps?.({ droplet: on })') &&
    /endFollow: \(\) => \{\s*lastFollowXRef\.current = -1\s*\}/.test(S.lensJs) &&
    !/endFollow: \(\) => \{\s*lastFollowXRef\.current = 0\s*\}/.test(S.lensJs) &&
    S.lensJs.includes('lastFollowXRef = useRef(-1)'))

  // ---------------- C. 原生形变：速度驱动 + 跳变剔除 ----------------
  const SW = ['sampleWindowDuration', 'speedScaleCoefficient', 'idleSpeedThreshold', 'maxScaleDeviation',
    'scaleSmoothingFactor', 'teleportDistance', 'maxSampleGap', 'sampleFreshness']
  const missing = SW.filter((k) => swiftNumber(lens, k) === null)
  push('C1 形变常量齐全（采样窗/速度系数/静止阈值/限幅/低通/跳变/断片/时效）',
    missing.length === 0, missing.length ? '缺：' + missing.join('、') : SW.map((k) => `${k}=${swiftNumber(lens, k)}`).join(' '))

  // 旧加速度实现不得在 vendor 源码里留任何残留（残留 = 两套驱动同时存在，症状会回来）
  const vendor = vendorSources()
  const dead = ['accelerationWindowDuration', 'accelerationScaleCoefficient', 'calculateAverageAcceleration',
    'applyAccelerationSize']
  const leftovers = []
  for (const f of vendor) for (const k of dead) if (f.src.includes(k)) leftovers.push(`${f.file}:${k}`)
  push('C2 加速度驱动已彻底移除（vendor 源码零残留）',
    leftovers.length === 0, leftovers.length ? leftovers.join('、') : `扫描 ${vendor.length} 个文件`)

  push('C3 位置采样取呈现值（模型值会让弹簧/跟手都看不见）',
    lens.includes('layer.presentation()?.position ?? layer.position'))
  push('C4 速度 = 最近两个真实样本的位移 / dt（不是二阶差分）',
    lens.includes('return (curr.position.x - prev.position.x) / dt'))
  push('C5 形变量恒 ≥ 0 且单调：max(0, min(maxScaleDeviation, (|v| − 阈值) × 系数))',
    /let target = max\(0, min\(maxScaleDeviation, scaleFactor\)\)/.test(lens) &&
    /let scaleFactor = \(magnitude - idleSpeedThreshold\) \* speedScaleCoefficient/.test(lens) &&
    lens.includes('let magnitude = abs(speed)'))
  push('C6 横纵反向等量形变（同号相反 → 只会「扁」，不会来回翻）',
    lens.includes('let scaleX = 1 + smoothedScale') && lens.includes('let scaleY = 1 - smoothedScale'))
  push('C7 低通指数平滑（把剩余尖峰限制在单帧系数比例内）',
    /smoothedScale \+= \(target - smoothedScale\) \* scaleSmoothingFactor/.test(lens))
  push('C8 跳变/断片样本整段作废（否则一次宿主重布局就能喂出巨大假速度）',
    lens.includes('dt > 0, dt <= maxSampleGap, dx <= teleportDistance') &&
    /positionHistory\.removeAll\(\)\s*\n\s*positionHistory\.append/.test(lens))
  push('C9 样本时效：最后一个样本过期即视为静止（手指停住必须回正）',
    lens.includes('guard time - curr.timestamp <= sampleFreshness else { return 0 }'))
  push('C10 形变 frame 取整保留（半像素栅格 = 椭圆内部黑线）',
    lens.includes('let newWidth = (bounds.width * scaleX).rounded()') &&
    lens.includes('let newHeight = (bounds.height * scaleY).rounded()'))
  push('C11 形变以 bounds 中心为中心（形变过程中中心不得漂移）',
    /x: \(\(bounds\.width - newWidth\) \/ 2\)\.rounded\(\)/.test(lens))
  push('C12 圆角随压扁收敛（shader 圆角 SDF 不钳制，不收敛即画成近矩形）',
    lens.includes('let halfShortSide = min(newWidth, newHeight) / 2') &&
    lens.includes('liquidGlassView.layer.cornerRadius = radius'))
  push('C13 停止跟踪时复位 frame 与圆角（回落淡出期间形状不残留）',
    /stopPositionTracking[\s\S]{0,900}?liquidGlassView\.frame = bounds[\s\S]{0,400}?layer\.cornerRadius/.test(lens))
  push('C14 静止药丸不参与形变（形变只作用于抬起玻璃）',
    !/applySpeedSize[\s\S]{0,1200}?restingPillView/.test(lens))
  // 宿主只在宽度变化时等比重映射 x（旋转），不会逐帧动 x —— 这是「偏了」的排除项
  push('C15 宿主 x 仅在宿主宽度变化时等比重映射（不会逐帧累积漂移）',
    host.includes('if (_hasX && _lastWidth > 0 && width > 0 && fabs(width - _lastWidth) > 0.5)') &&
    host.includes('_lastWidth = width;'))

  // ---------------- C16-C21. 第 37 轮：水珠造型 + 被打断的点击弹簧 ----------------
  // 新增样式需求（用户原话）：「如图二：底部 tab 栏，长按后椭圆形气泡会变大，类似水珠
  // 的样式，功能和一起一样，只是多了这个样式。」
  push('C16 水珠几何：边长 = kLGDropletScale × 栏高 的正方形 bounds，中心锁槽心（纵向溢出栏体上下各 (1.45−1)/2×栏高）',
    host.includes('static const CGFloat kLGDropletScale = 1.45') &&
    /if \(_droplet && height > 0\) \{[\s\S]{0,300}?CGFloat side = round\(height \* kLGDropletScale\);\s*_lens\.bounds = CGRectMake\(0, 0, side, side\);\s*_lens\.center = CGPointMake\(_x, height \/ 2\.0\);/.test(host))
  push('C17 水珠圆角必须走胶囊几何极限（override = -1 ⇒ 正方形 bounds 下 min(w,h)/2 = 正圆；沿用栏体圆角 28 会画成圆角方形，不是水珠）',
    /if \(_droplet\) \{[\s\S]{0,300}?setLensCornerRadius:-1\]/.test(host) &&
    lens.includes('cornerRadiusOverride >= 0'))
  push('C18 水珠开关幂等 + 带弹簧动画（同值直接 return，不重播）；透镜宿主保留 clipsToBounds = NO（越界是造型的一部分）',
    /-\s*\(void\)setDroplet:\(BOOL\)droplet \{\s*if \(_droplet == droplet\) return/.test(host) &&
    /\(void\)setDroplet:\(BOOL\)droplet \{[\s\S]{0,600}?usingSpringWithDamping/.test(host) &&
    host.includes('self.clipsToBounds = NO'))
  push('C19 被打断的点击弹簧必须补做落回：跟手一笔打断在途弹簧（finished == NO）时，completion 不能再直接 return（否则透镜永久停在抬起玻璃态 —— 就是用户报的那个「椭圆形气泡」）',
    host.includes('if (!finished && !self->_followTookOver) return;') &&
    (host.match(/_followTookOver/g) || []).length >= 4,
    `_followTookOver 出现 ${(host.match(/_followTookOver/g) || []).length} 次`)
  push('C20 followX 走 applyFollowX（无同位守卫、无条件落位）：守卫的判据「新目标 ≈ _x」在被跟手打断的弹簧上不成立，纠正写会被整体吞掉、错位就地固化',
    /RCT_CUSTOM_VIEW_PROPERTY\(followX,[\s\S]{0,300}?applyFollowX:\[json doubleValue\]/.test(host) &&
    /-\s*\(void\)applyFollowX:\(CGFloat\)x \{[\s\S]{0,900}?_lens\.center = CGPointMake\(x, self\.bounds\.size\.height \/ 2\.0\)/.test(host) &&
    /-\s*\(void\)applyFollowX:\(CGFloat\)x \{[\s\S]{0,300}?_followTookOver = YES;/.test(host))
  push('C21 玻璃圆角自持（栏体不裁剪的前提）：宿主 layoutSubviews 把 RN 下发的 layer.cornerRadius 转发给玻璃容器与材质视图；捕获排除根仍是宿主 superview（不套 wrapper）',
    /_glassView\.layer\.cornerRadius = self\.layer\.cornerRadius/.test(host) &&
    host.includes('container.clipsToBounds = YES') &&
    host.includes('[backing setCaptureExclusionView:self.superview]'))
  // 【第 37 轮补丁】取整必须走 C 函数：本文件曾写成 Swift 风格的 (…).rounded()，
  // ObjC++ 里 double 不是结构/类、没有成员函数，CI（LiquidGlassKit 目标 CompileC）
  // 实锤编译失败。这条同时钉两件事：正确的 round() 调用在场 + 全文件零 .rounded() 残留
  // （Swift 侧（LiquidLensView.swift）的 .rounded() 是合法 Swift 语法，不受本条约束）。
  push('C22 原生宿主取整必须用 C 函数 round()（Swift 风格 (x).rounded() 在 ObjC++ 编不过 —— 第 37 轮 CI 实锤）；全文件不许再有 .rounded() 残留',
    /\bround\(height \* kLGDropletScale\)/.test(host) &&
    !/\.rounded\s*\(/.test(host))

  // ---------------- D. 数值模型 ----------------
  push('D0 设计令牌可读（lg / tabBarBaseHeight / glass 三个数缺失则后面的几何断言全部失真）',
    LG !== null && BAR_H !== null && GLASS_R !== null,
    `lg=${LG} barHeight=${BAR_H} glassRadius=${GLASS_R}`)

  // D1：跨机型 × 5 个槽位，槽心（由 flex:1 布局推出）与透镜公式必须逐点相等
  {
    let worst = 0
    const rows = []
    for (const d of DEVICES) {
      const barW = barWidthOf(d)
      const itemW = barW / TAB_N            // flex:1，无 margin/gap
      for (let i = 0; i < TAB_N; i++) {
        const itemCenter = itemW * (i + 0.5)
        const diff = Math.abs(itemCenter - lensXOf(d, i))
        if (diff > worst) worst = diff
      }
      rows.push(`${d.name}: 栏宽 ${barW.toFixed(1)} 槽宽 ${itemW.toFixed(1)}`)
    }
    push(`D1 槽心 ≡ 药丸公式（${DEVICES.length} 机型 × ${TAB_N} 槽，最大偏差 ${worst}）`,
      worst < 1e-9, rows.join(' / '))
  }
  // D2：药丸不出栏，两端恰好与栏体边缘相切（设计使然：最左/最右与胶囊融为一体）
  {
    let bad = []
    for (const d of DEVICES) {
      const barW = barWidthOf(d)
      const w = slotOf(d)
      for (let i = 0; i < TAB_N; i++) {
        const x = lensXOf(d, i)
        if (x - w / 2 < -1e-9 || x + w / 2 > barW + 1e-9) bad.push(`${d.name}#${i}`)
      }
    }
    push('D2 药丸左右边缘恒在栏体内（端点相切，不越界）', bad.length === 0, bad.slice(0, 3).join('、'))
  }
  // D3 反证：栏体若带水平 padding，槽心与公式就系统性分叉 —— 这就是「偏了」的成因形态
  {
    const d = DEVICES[0]
    const barW = barWidthOf(d)
    const pad = 16
    const itemW = (barW - 2 * pad) / TAB_N
    let worst = 0
    for (let i = 0; i < TAB_N; i++) worst = Math.max(worst, Math.abs(pad + itemW * (i + 0.5) - lensXOf(d, i)))
    push(`D3 反证：栏体加 ${pad}pt 水平内边距 → 最偏 ${worst.toFixed(1)}pt（A5 不可省）`,
      worst > 0.5, `${DEVICES[0].name}`)
  }
  // D4 反证：tab 项若不是 flex:1 而是固定宽，槽心同样分叉
  {
    const d = DEVICES[0]
    const barW = barWidthOf(d)
    const fixedW = 60
    const free = barW - fixedW * TAB_N
    const centers = Array.from({ length: TAB_N }, (_, i) => free + fixedW * (i + 0.5))
    const worst = Math.max(...centers.map((c, i) => Math.abs(c - lensXOf(d, i))))
    push(`D4 反证：tab 项改固定宽 ${fixedW}pt → 最偏 ${worst.toFixed(1)}pt（A4 不可省）`,
      worst > 0.5, `${DEVICES[0].name}`)
  }
  // D5：形变量对 |v| 单调不减、有界、静止为 0
  {
    const idle = swiftNumber(lens, 'idleSpeedThreshold')
    const k = swiftNumber(lens, 'speedScaleCoefficient')
    const cap = swiftNumber(lens, 'maxScaleDeviation')
    const s = (v) => Math.max(0, Math.min(cap, (Math.abs(v) - idle) * k))
    const seq = [0, 50, idle, idle + 1, 300, 600, 1000, 1600, 3000, 8000]
    const vals = seq.map(s)
    let mono = true
    for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1] - 1e-12) mono = false
    const capped = Math.abs(vals[vals.length - 1] - cap) < 1e-12
    // 上限速度：|v| 达到 c 后不再增加形变
    const vCap = idle + cap / k
    push(`D5 形变对 |v| 单调不减、上界 ${cap}、静止（≤${idle}pt/s）为 0` +
      `（触顶速度 ≈${vCap.toFixed(0)}pt/s）`,
      mono && capped && vals[0] === 0 && vals[2] === 0, seq.map((v, i) => `${v}:${vals[i].toFixed(3)}`).join(' '))
  }
  // D6：同一条真实手势轨迹上，旧「加速度」方案会反复反号（用户说的「一会儿圆一会儿扁」），
  //     新「速度」方案恒 ≥0，且在减速段随 |v| 一起收（「速度慢就正常」）
  {
    const d = DEVICES[0]
    const span = lensXOf(d, 4) - lensXOf(d, 0)
    const T = 0.6                              // 一次长按拖动 / 横滑的典型时长
    const REST = 0.15                          // 手指停住后的静置段（写入停止，displayLink 仍在跑）
    const prof = (u) => u * u * (3 - 2 * u)    // smoothstep：前半程加速、后半程减速
    const xAt = (t) => lensXOf(d, 0) + span * prof(Math.min(1, t / T))
    const idle = swiftNumber(lens, 'idleSpeedThreshold')
    const kk = swiftNumber(lens, 'speedScaleCoefficient')
    const cap = swiftNumber(lens, 'maxScaleDeviation')
    const alpha = swiftNumber(lens, 'scaleSmoothingFactor')
    // ── 旧方案复算：逐字照抄被移除的 calculateAverageAcceleration + applyAccelerationSize
    const OLD_WIN = 0.3
    const OLD_K = 0.00005
    const OLD_MAX = 0.3
    const oldDeviation = (hist) => {
      const vel = []
      for (let i = 1; i < hist.length; i++) {
        const dt = hist[i].t - hist[i - 1].t
        if (dt <= 0) continue
        vel.push({ v: (hist[i].x - hist[i - 1].x) / dt, t: (hist[i].t + hist[i - 1].t) / 2 })
      }
      if (vel.length < 2) return 0
      let sum = 0
      let n = 0
      for (let i = 1; i < vel.length; i++) {
        const dt = vel[i].t - vel[i - 1].t
        if (dt <= 0) continue
        sum += (vel[i].v - vel[i - 1].v) / dt
        n++
      }
      const a = n ? sum / n : 0
      return Math.max(-OLD_MAX, Math.min(OLD_MAX, a * OLD_K))
    }
    // displayLink 逐帧（120Hz）：位置连续变化，样本也按位置变化逐个入表（与 Swift 同规则）
    const fresh = swiftNumber(lens, 'sampleFreshness')
    const tick = 1 / 120
    const samples = []
    const old = []
    const neu = []
    const speeds = []
    let s = 0
    for (let t = 0; t <= T + REST + 1e-9; t += tick) {
      const x = xAt(t)
      if (!samples.length || x !== samples[samples.length - 1].x) samples.push({ t, x })
      const win = samples.filter((sm) => sm.t >= t - OLD_WIN)
      old.push(oldDeviation(win))
      // 新方案：最近两个真实样本的速度（最后一个样本过期即视为静止），再指数低通
      let v = 0
      if (samples.length >= 2) {
        const cur = samples[samples.length - 1]
        const prv = samples[samples.length - 2]
        if (t - cur.t <= fresh) v = (cur.x - prv.x) / (cur.t - prv.t)
      }
      speeds.push(Math.abs(v))
      const target = Math.max(0, Math.min(cap, (Math.abs(v) - idle) * kk))
      s += (target - s) * alpha
      neu.push(s)
    }
    // 「可见形变」= 2% ≈ 1.6pt @本机型药丸宽；低于此值肉眼不可辨，不计入反号
    const VIS = 0.02
    const flips = (arr) => {
      let f = 0
      let prev = 0
      for (const s of arr) {
        const sign = Math.abs(s) >= VIS ? Math.sign(s) : 0
        if (sign !== 0 && prev !== 0 && sign !== prev) f++
        if (sign !== 0) prev = sign
      }
      return f
    }
    const oldFlips = flips(old)
    const newFlips = flips(neu)
    // 减速段（后半程）|v| 单调回落；新方案形变因为低通有一两帧滞后，峰值紧随 |v| 峰值，
    // 之后必须单调收（「速度慢就正常」），并且最终回到不可见（「停住就是圆的」）
    const half = Math.round((T / 2) / tick)
    let decelMono = true
    for (let i = half + 1; i < speeds.length; i++) if (speeds[i] > speeds[i - 1] + 1) decelMono = false
    const peakV = speeds.indexOf(Math.max(...speeds))
    let peakS = 0
    for (let i = 1; i < neu.length; i++) if (neu[i] > neu[peakS]) peakS = i
    let devMono = true
    for (let i = peakS + 1; i < neu.length; i++) if (neu[i] > neu[i - 1] + 1e-9) devMono = false
    const lag = peakS - peakV
    const tailQuiet = neu[neu.length - 1] < VIS
    const anyNegative = neu.some((s) => s < 0)
    push(`D6 同一条 ${T}s 手势轨迹（跨 ${span.toFixed(0)}pt）：旧加速度方案可见反号 ${oldFlips} 次` +
      `（=一会儿圆一会儿扁），新速度方案 ${newFlips} 次；减速段 |v| 单调回落=${decelMono}、` +
      `形变峰值滞后 ${lag} 帧后单调收=${devMono}、结束时回正=${tailQuiet}、从不为负=${!anyNegative}`,
      oldFlips >= 1 && newFlips === 0 && decelMono && devMono && tailQuiet && !anyNegative,
      `ticks=${neu.length} 峰值|v|=${Math.max(...speeds).toFixed(0)}pt/s ` +
      `旧峰值形变=${Math.max(...old.map(Math.abs)).toFixed(2)} 新峰值形变=${Math.max(...neu).toFixed(3)}`)
  }
  // D7：模型值瞬移（宿主重布局复位 frame / 点击弹簧的模型值跳变）不得产生假激励
  {
    const cap = swiftNumber(lens, 'maxScaleDeviation')
    const k = swiftNumber(lens, 'speedScaleCoefficient')
    const teleport = 200          // pt，一帧内的瞬移量
    const dt = 1 / 120
    const oldSpeed = teleport / dt
    const oldS = Math.min(cap, Math.max(0, (oldSpeed - swiftNumber(lens, 'idleSpeedThreshold')) * k))
    push(`D7 反证：一帧瞬移 ${teleport}pt 时旧路径得到 ${oldSpeed.toFixed(0)}pt/s → 形变直接触顶 ${oldS.toFixed(2)}` +
      `（抽搐的量化形式）；新路径被 teleportDistance=${swiftNumber(lens, 'teleportDistance')}pt 剔除 → 0`,
      oldS >= cap && teleport > swiftNumber(lens, 'teleportDistance'))
  }
  // D8：低通限幅 → 单帧形变增量 ≤ 系数 × 限幅，肉眼不可见的高频抖动被压掉
  {
    const cap = swiftNumber(lens, 'maxScaleDeviation')
    const a = swiftNumber(lens, 'scaleSmoothingFactor')
    const perFrame = a * cap
    const slot = slotOf(DEVICES[0])
    push(`D8 单帧形变增量 ≤ ${perFrame.toFixed(4)}（= 系数 ${a} × 限幅 ${cap}）` +
      `→ 单帧宽度变化 ≤ ${(perFrame * 100).toFixed(1)}% 药丸宽（${(perFrame * slot).toFixed(2)}pt @${DEVICES[0].name}）`,
      perFrame <= 0.05, `slot=${slot.toFixed(1)}pt`)
  }
  // D9：形变不移动中心（取整误差 ≤0.5pt）——「椭圆位置偏了」的形变侧守卫
  {
    let worst = 0
    for (const d of DEVICES) {
      const h = BAR_H                      // 栏体高（scaleSizeH 后 ≈ 同值或 ±1，取设计值即可量化）
      const w = slotOf(d)
      for (const s of [0, 0.05, 0.18]) {
        const nw = Math.round(w * (1 + s))
        const nh = Math.round(h * (1 - s))
        const fx = Math.round((w - nw) / 2)
        const fy = Math.round((h - nh) / 2)
        worst = Math.max(worst, Math.abs((fx + nw / 2) - w / 2), Math.abs((fy + nh / 2) - h / 2))
      }
    }
    push(`D9 形变不移动药丸中心（取整误差最大 ${worst}pt < 1）`, worst < 1)
  }
  // D10 反证：圆角不跟随压扁就会被画成近矩形（C12 不可省）
  {
    const cap = swiftNumber(lens, 'maxScaleDeviation')
    const nh = BAR_H * (1 - cap)
    const half = GLASS_R
    push(`D10 反证：最大压扁时高 ${nh.toFixed(1)}pt，静止圆角 ${half} > 短边一半 ${(nh / 2).toFixed(1)}` +
      `（shader 圆角不钳制 → 近矩形，C12 不可省）`,
      half > nh / 2)
  }

  // D11：水珠造型的量化 —— 直径 / 纵向溢出量 / 与静止药丸（槽宽 × 栏高）的关系
  {
    const m = /static const CGFloat kLGDropletScale = ([\d.]+)/.exec(host)
    const scale = m ? Number(m[1]) : 0
    const d = DEVICES[0]
    const side = Math.round(BAR_H * scale)
    const overflow = (side - BAR_H) / 2
    const slot = slotOf(d)
    push(`D11 水珠直径 = ${scale} × 栏高 ${BAR_H} = ${side}pt：比静止药丸高 ${(side - BAR_H).toFixed(1)}pt` +
      `（上下各溢出栏体 ${overflow.toFixed(1)}pt，长按造型一眼可辨）、比一个槽宽 ${slot.toFixed(1)}pt 宽 ${(side - slot).toFixed(1)}pt`,
      scale > 1.2 && scale < 2 && overflow >= 8 && side > slot * 0.9, d.name)
  }

  return out
}

// ---------------------------------------------------------------------------
// E. 反例自检：篡改源码后必须被拦下
// ---------------------------------------------------------------------------

const tamper = [
  {
    label: 'ModernTabBar 药丸公式去掉 +0.5（中心变成槽起点）',
    file: 'tabBar',
    mutate: (s) => s.replace('((activeIndex + 0.5) * barWidth) / TAB_IDS.length', '(activeIndex * barWidth) / TAB_IDS.length'),
  },
  {
    label: 'ModernTabBar 药丸宽度留边',
    file: 'tabBar',
    mutate: (s) => s.replace('const lensPillWidth = barWidth / TAB_IDS.length', 'const lensPillWidth = barWidth / TAB_IDS.length - 8'),
  },
  {
    label: 'ModernTabBar tab 项改固定宽度（不再 flex:1）',
    file: 'tabBar',
    mutate: (s) => s.replace('  item: {\n    flex: 1,\n', '  item: {\n    width: 60,\n'),
  },
  {
    label: 'ModernTabBar 栏体加水平内边距',
    file: 'tabBar',
    mutate: (s) => s.replace('  bar: {\n', '  bar: {\n    paddingHorizontal: 16,\n'),
  },
  {
    label: 'ModernTabBar 去掉会话收尾重锚调用',
    file: 'tabBar',
    mutate: (s) => s.replace('      snapLensToRestingSlot()\n', ''),
  },
  {
    label: 'ModernTabBar 去掉重锚的「未驱动过」守卫',
    file: 'tabBar',
    mutate: (s) => s.replace('    if (lastFollowXRef.current < 0) return\n', ''),
  },
  {
    label: 'ModernTabBar 跟手通道不再记账',
    file: 'tabBar',
    mutate: (s) => s.replace('    lastFollowXRef.current = followX\n', ''),
  },
  {
    label: 'ModernTabBar 长按接管不复位跟手标记',
    file: 'tabBar',
    mutate: (s) => s.replace('    lastFollowXRef.current = -1\n', ''),
  },
  {
    label: 'LiquidLensView 采样退回模型值',
    file: 'lensSwift',
    mutate: (s) => s.replace('return layer.presentation()?.position ?? layer.position', 'return layer.position'),
  },
  {
    label: 'LiquidLensView 形变恢复「有符号」钳制（会来回翻）',
    file: 'lensSwift',
    mutate: (s) => s.replace('let target = max(0, min(maxScaleDeviation, scaleFactor))', 'let target = max(-maxScaleDeviation, min(maxScaleDeviation, scaleFactor))'),
  },
  {
    label: 'LiquidLensView 去掉 frame 取整（黑线回来）',
    file: 'lensSwift',
    mutate: (s) => s.replace('let newWidth = (bounds.width * scaleX).rounded()', 'let newWidth = bounds.width * scaleX'),
  },
  {
    label: 'LiquidLensView 去掉跳变/断片剔除',
    file: 'lensSwift',
    mutate: (s) => s.replace('if dt > 0, dt <= maxSampleGap, dx <= teleportDistance {', 'if dt > 0 {'),
  },
  {
    label: 'LiquidLensView 圆角不跟随压扁',
    file: 'lensSwift',
    mutate: (s) => s.replace('let halfShortSide = min(newWidth, newHeight) / 2', 'let halfShortSide = min(bounds.width, bounds.height) / 2'),
  },
  {
    label: 'LiquidLensView 残留加速度驱动常量',
    file: 'lensSwift',
    mutate: (s) => s.replace('private let speedScaleCoefficient', 'private let accelerationScaleCoefficient'),
  },
  {
    label: 'ModernTabBar 拆掉静止锚点自愈（脱钩状态永不自愈）',
    file: 'tabBar',
    mutate: (s) => s.replace('    lensRef.current?.setRestX(lensX)\n', ''),
  },
  {
    label: 'ModernTabBar 自愈改走 followX 直落（点击切页的淡入+抬起+弹簧被打断成瞬移）',
    file: 'tabBar',
    mutate: (s) => s.replace('    lensRef.current?.setRestX(lensX)\n', '    lensRef.current?.setFollowX(lensX)\n'),
  },
  {
    label: 'ModernTabBar 自愈不查 A-5 会话（在用户按住拖动时把药丸抢回槽心）',
    file: 'tabBar',
    mutate: (s) => s.replace('    if (dragArmedRef.current || draggingRef.current) return\n    lensRef.current?.setRestX(lensX)', '    lensRef.current?.setRestX(lensX)'),
  },
  {
    label: 'LiquidLens 自愈出口改写 followX 通道（绕过同位守卫的弹簧语义）',
    file: 'lensJs',
    mutate: (s) => s.replace('setNativeProps?.({ x: nextX })', 'setNativeProps?.({ followX: nextX })'),
  },
  {
    label: 'ModernTabBar 看门狗超时不收尾（丢收尾的药丸永远停在半路）',
    file: 'tabBar',
    mutate: (s) => s.replace('      closePagerFollowSession()\n    }, FOLLOW_SESSION_TIMEOUT_MS)', '    }, FOLLOW_SESSION_TIMEOUT_MS)'),
  },
  {
    label: 'ModernTabBar 看门狗超时不让位 A-5（拖动中途被锚回槽心）',
    file: 'tabBar',
    mutate: (s) => s.replace('      if (dragArmedRef.current || draggingRef.current) return\n      closePagerFollowSession()', '      closePagerFollowSession()'),
  },
  {
    label: 'ModernTabBar 跟手帧不再重新记账（长会话被当成收尾丢失，药丸中途弹回）',
    file: 'tabBar',
    mutate: (s) => s.replace('    armFollowWatchdog()\n  }), [armFollowWatchdog])', '  }), [armFollowWatchdog])'),
  },
  {
    label: 'ModernTabBar 正常收尾不销毁看门狗（收尾后凭空多触发一次）',
    file: 'tabBar',
    mutate: (s) => s.replace('      if (followWatchdogRef.current) {\n        clearTimeout(followWatchdogRef.current)\n        followWatchdogRef.current = null\n      }\n      // 收尾重锚必须在 endFollow() 之前', '      // 收尾重锚必须在 endFollow() 之前'),
  },
  {
    label: 'ModernTabBar 卸载不清看门狗',
    file: 'tabBar',
    mutate: (s) => s.replace('    if (followWatchdogRef.current) { clearTimeout(followWatchdogRef.current); followWatchdogRef.current = null }\n  }, [])', '  }, [])'),
  },
  {
    label: 'ModernTabBar 重锚退回 lensXRef（迟一个提交的旧值 —— 第 35 轮第 3 条的原始 bug）',
    file: 'tabBar',
    mutate: (s) => s.replace('    lensRef.current?.setFollowX(resolveRestingSlotX(), true)\n  }, [resolveRestingSlotX])', '    lensRef.current?.setFollowX(lensXRef.current)\n  }, [resolveRestingSlotX])'),
  },
  {
    label: 'ModernTabBar 去掉收尾后的静止位重申（收尾拿到旧槽就再也不自愈）',
    file: 'tabBar',
    // 【第 35 轮第 3 条】锚点跨过中间那行中文注释 —— 只锚「endFollow + 重申」这一对，
    // 用 6 空格缩进 + 紧随的说明注释把范围锁在正常收尾分支里（兜底收尾那份是 4 空格）。
    mutate: (s) => s.replace('      lensRef.current?.endFollow()\n      // 【第 35 轮第 3 条】收尾之后再重申几次静止位（见 REST_REASSERT_DELAYS 注释）\n      reassertRestingSlot()', '      lensRef.current?.endFollow()'),
  },
  {
    label: 'ModernTabBar 重申不带让位守卫（手指按住 / 跟手会话中被拽回槽心）',
    file: 'tabBar',
    // 【第 35 轮第 3 条】锚点必须带上两道守卫各自上面的注释（源码里注释夹在中间），
    // 且首行 8 空格缩进 —— 4/6 空格的同名守卫在别处还有三份，纯单行锚点会打错地方。
    // 【第 37 轮第 1 条】第一道守卫的形状变成 `if (draggingRef.current) return`。
    mutate: (s) => s.replace('        if (draggingRef.current) return\n        // 新一轮 B-7 跟手已经开始（有帧驱动过药丸）：让位，别和手指抢位置\n        if (lastFollowXRef.current >= 0) return\n', ''),
  },
  {
    label: 'ModernTabBar 重申目标改读 lensXRef（重申本身就又变回迟到的值，等于没修）',
    file: 'tabBar',
    mutate: (s) => s.replace('        lensRef.current?.setFollowX(resolveRestingSlotX(), true)\n      }, delay))', '        lensRef.current?.setFollowX(lensXRef.current)\n      }, delay))'),
  },
  {
    label: 'ModernTabBar 收尾不再 force 写（被 JS 0.1pt 去重吞掉，纠正写落不到原生）',
    file: 'tabBar',
    mutate: (s) => s.replace('    lensRef.current?.setFollowX(resolveRestingSlotX(), true)\n  }, [resolveRestingSlotX])', '    lensRef.current?.setFollowX(resolveRestingSlotX())\n  }, [resolveRestingSlotX])'),
  },
  {
    label: 'LiquidLens force 标志失效（去重恢复成无条件吞写）',
    file: 'lensJs',
    mutate: (s) => s.replace('if (!force && Math.abs(nextX - lastFollowXRef.current) < 0.1) return', 'if (Math.abs(nextX - lastFollowXRef.current) < 0.1) return'),
  },
  {
    label: 'LiquidLens endFollow 复位回 0（0 是合法坐标，不能当「无会话」哨兵）',
    file: 'lensJs',
    mutate: (s) => s.replace('      lastFollowXRef.current = -1\n    },\n    setRestX', '      lastFollowXRef.current = 0\n    },\n    setRestX'),
  },
  {
    label: 'ModernTabBar 让位条件退回「arm 也算」（长按抬手事件丢失时吞掉 pager 收尾）',
    file: 'tabBar',
    mutate: (s) => s.replace('    if (draggingRef.current) return\n    if (dragging && dragArmedRef.current) return\n', '    if (dragArmedRef.current || draggingRef.current) return\n'),
  },
  {
    label: 'ModernTabBar 正常收尾不收水珠（长按造型挂在栏上）',
    file: 'tabBar',
    mutate: (s) => s.replace('      snapLensToRestingSlot()\n      lensRef.current?.setDroplet(false)\n      lensRef.current?.endFollow()', '      snapLensToRestingSlot()\n      lensRef.current?.endFollow()'),
  },
  {
    label: '宿主 completion 退回 if (!finished) return（跟手一笔就把药丸永久卡在抬起态）',
    file: 'hostMm',
    mutate: (s) => s.replace('if (!finished && !self->_followTookOver) return;', 'if (!finished) return;'),
  },
  {
    label: '宿主跟手落位走回 setTargetX（同位守卫吞掉「_x ≈ 槽心但显示停在别处」的纠正写）',
    file: 'hostMm',
    mutate: (s) => s.replace('  [view.lens.layer removeAllAnimations];\n  [view applyFollowX:[json doubleValue]];', '  [view.lens.layer removeAllAnimations];\n  [view setTargetX:[json doubleValue] animated:NO];'),
  },
  {
    label: '宿主水珠不再钳制圆角（沿用栏体 28 → 圆角方形，不是水珠）',
    file: 'hostMm',
    mutate: (s) => s.replace('      [lensCustom setLensCornerRadius:-1];', '      [lensCustom setLensCornerRadius:28];'),
  },
  {
    label: '宿主水珠边长缩回栏高（不再溢出，造型丢失）',
    file: 'hostMm',
    mutate: (s) => s.replace('static const CGFloat kLGDropletScale = 1.45', 'static const CGFloat kLGDropletScale = 1.0'),
  },
  {
    label: 'ModernTabBar 栏体退回裁剪（水珠被上下削平成宽胶囊）',
    file: 'tabBar',
    mutate: (s) => s.replace("    overflow: 'visible',\n", "    overflow: 'hidden',\n"),
  },
  {
    label: '宿主取整退回 Swift 风格 .rounded()（ObjC++ 编不过 —— 第 37 轮 CI 实锤）',
    file: 'hostMm',
    mutate: (s) => s.replace('round(height * kLGDropletScale)', '(height * kLGDropletScale).rounded()'),
  },
]

// ---------------------------------------------------------------------------

console.log('sim-tabbar-lens-geometry：底部 tab 栏透镜（静止对齐 + 形变规则）\n')

const results = []
const push = (name, ok, detail = '') => results.push({ name, ok, detail })

console.log('--- A/B/C/D. 源码不变量 + 数值模型 ---')
const baseline = runSourceInvariants()
for (const r of baseline) push(r.name, r.ok, r.detail)
// 基线已经失败的项不能算作「反例被拦下」——否则脚本自身坏掉时反例段会全部假通过
const baselineFailed = new Set(baseline.filter((r) => !r.ok).map((r) => r.name))

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
  const failed = runSourceInvariants().filter((r) => !r.ok && !baselineFailed.has(r.name))
  REAL[c.file] = saved
  push(`反例 ${c.label} 被拦下`, failed.length > 0,
    failed.length ? `命中：${failed.map((r) => r.name.split(' ')[0]).join('、')}` : '未被任何不变量拦下（守卫无效）')
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
