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

  // ---------------- B. 跟手会话收尾重锚 ----------------
  push('B1 跟手通道记录最后写入的 x（判定本次会话是否驱动过药丸）',
    tab.includes('const lastFollowXRef = useRef(-1)') &&
    tab.includes('lastFollowXRef.current = followX'))
  push('B2 重锚函数存在，且第一条语句就是「本次会话没驱动过 → 直接返回」',
    /const snapLensToRestingSlot = useCallback\(\(\) => \{\s*\n\s*if \(lastFollowXRef\.current < 0\) return\s*\n\s*lastFollowXRef\.current = -1\s*\n\s*lensRef\.current\?\.setFollowX\(lensXRef\.current\)/.test(tab))
  push('B3 重锚目标是「当前归属 tab 的槽心」（lensXRef），不是四舍五入的跟手落点',
    tab.includes('lensRef.current?.setFollowX(lensXRef.current)'))
  // 顺序：必须在 endFollow() 之前，否则 LiquidLens 的去重值已被复位，正常跟手也会多写一次原生
  const dragSub = /subscribePagerDrag\(\(dragging\) => \{([\s\S]*?)\n  \}\), \[/.exec(tab)
  const dragBody = dragSub ? dragSub[1] : ''
  push('B4 pager 会话结束时先重锚再 endFollow（顺序颠倒即多写一次原生、打断在途弹簧）',
    dragBody.indexOf('snapLensToRestingSlot()') >= 0 &&
    dragBody.indexOf('snapLensToRestingSlot()') < dragBody.indexOf('endFollow()'),
    dragBody.replace(/\s+/g, ' ').trim().slice(0, 90))
  push('B5 A-5 长按接管时作废跟手标记（避免被下一次 pager 收尾误消费）',
    /handleTabLongPress[\s\S]{0,600}?lastFollowXRef\.current = -1/.test(tab))
  push('B6 跟手写入走 setNativeProps（不触发 React 重渲染）+ 0.1pt 去重（B4 顺序的前提）',
    S.lensJs.includes('setNativeProps?.({ followX: nextX })') &&
    S.lensJs.includes('if (Math.abs(nextX - lastFollowXRef.current) < 0.1) return'))

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
  push('B9 B-7 会话看门狗存在，且记账口径是「无新帧 12s」的 debounce（不是会话总时长：按住不动时 pager 会停止发帧，阈值太小会误判成收尾丢失）',
    tab.includes('const FOLLOW_SESSION_TIMEOUT_MS = 12000') &&
    tab.includes('const followWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)') &&
    /const armFollowWatchdog = useCallback\(\(\) => \{\s*if \(followWatchdogRef\.current\) clearTimeout\(followWatchdogRef\.current\)\s*followWatchdogRef\.current = setTimeout\(\(\) => \{\s*followWatchdogRef\.current = null\s*if \(dragArmedRef\.current \|\| draggingRef\.current\) return\s*closePagerFollowSession\(\)\s*\}, FOLLOW_SESSION_TIMEOUT_MS\)\s*\}, \[closePagerFollowSession\]\)/.test(tab))
  push('B10 记账三处齐全：跟手帧重新 arm / 会话开始 arm（与首帧顺序不保证）/ 正常收尾销毁',
    /lensRef\.current\?\.setFollowX\(followX\)\s*armFollowWatchdog\(\)/.test(tab) &&
    /if \(dragging\) \{[\s\S]{0,300}?armFollowWatchdog\(\)\s*\} else \{\s*if \(followWatchdogRef\.current\) \{\s*clearTimeout\(followWatchdogRef\.current\)\s*followWatchdogRef\.current = null\s*\}\s*snapLensToRestingSlot\(\)/.test(tab))
  push('B11 兜底收尾 = 正常收尾同一套动作、同一顺序（锚回槽心 → 落回静止药丸 → 复位跟手去重；顺序换了会打断在途弹簧）',
    /const closePagerFollowSession = useCallback\(\(\) => \{\s*snapLensToRestingSlot\(\)\s*lensRef\.current\?\.setLifted\(false\)\s*lensRef\.current\?\.endFollow\(\)\s*\}, \[snapLensToRestingSlot\]\)/.test(tab))
  push('B12 A-5 接管（长按 arm）与卸载清理都销毁看门狗（不留一次凭空触发的收尾 / 不在已卸载组件上跑）',
    /lastFollowXRef\.current = -1\s*if \(followWatchdogRef\.current\) \{\s*clearTimeout\(followWatchdogRef\.current\)\s*followWatchdogRef\.current = null\s*\}/.test(tab) &&
    /if \(pressOutTimerRef\.current\) \{ clearTimeout\(pressOutTimerRef\.current\); pressOutTimerRef\.current = null \}\s*if \(followWatchdogRef\.current\) \{ clearTimeout\(followWatchdogRef\.current\); followWatchdogRef\.current = null \}/.test(tab))

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
