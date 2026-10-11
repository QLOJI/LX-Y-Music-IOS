/**
 * sim-collapsed-row-align.js
 *
 * 「收起态迷你播放器与左下角圆钮共线（同排同高）」契约。
 * 对应需求（用户点名重点、前几轮均未修好）：滑动形态迷你播放器与左侧圆钮不共线。
 *
 * 同排是三件事，缺一不可：
 *   ① 同一条底边 —— 两边 bottom 必须取**同一个数**；
 *   ② 同一个高度 —— 圆钮边长必须 = 收起态胶囊的实际高度；
 *   ③ 同一个包含块 —— 绝对定位的 inset 不能被父级 padding 二次偏移。
 *
 * 历史三轮恰好各踩一条：
 *   · 两边各写一遍 `safeAreaBottom + 4`（公式同源但**计算两次、订阅两次**）：
 *     任何一次漏读（订阅时序 / 测量时序）就分叉成「播放器还在展开位、圆钮已在左下角」。
 *     → 现在只在 tabBarCollapse.useCollapsedRowGeometry 里算一次，两个消费方取**同一个对象**。
 *   · 圆钮尺寸改成「实测的展开态胶囊高」（pillSize，首帧兜底 scaleSizeW(56)≈57），
 *     但收起态胶囊的**高度是内容撑出来的**（wrapper 只给了 bottom / paddingLeft）。
 *     左让位把可用宽度压窄后，标题/副标题多占一行、或字体档位让行盒长高一两 pt，
 *     胶囊就比圆钮高 —— 底边齐、顶边不齐，看起来就是「不共线 / 高出圆钮」。
 *     它本来就不是个常数，**调数值永远追不上**。→ 收起态把胶囊高度钉死成 pillSize
 *     （PlayerBar 的 `effectiveCollapsed && { height: pillSize }`），内容超高由
 *     overflow:hidden 裁掉，等高由构造保证。
 *   · 圆钮图层的父级带 paddingBottom：RN 0.73 默认不启用 Yoga 的
 *     AbsolutePositioningIncorrect 修复，「父级 padding + 绝对子节点 bottom」会叠加着
 *     再偏移一次（偏移量恰好等于被反复调的那个值）。→ 圆钮移进无 padding 的独立图层
 *     （pillLayer）。
 *
 * 本脚本把这三条钉死：
 *   A 段：tabBarCollapse —— 收起行几何的**唯一来源**（四个量只在这一处算）；
 *   B 段：DesignTokens —— 底边/间距**同源**（复用常量）而非「碰巧同值」；
 *   C 段：PlayerBar —— 只消费 collapsedRow + 高度钳制 + 裁切配套；
 *   D 段：ModernTabBar —— 圆钮消费同一对象 + left/bottom 不得经过 createStyle 倍率；
 *   E 段：数值模型 —— 按 pixelRatio.ts 的真实公式复算，多设备 × 多字体 × 多内容高度下
 *        两边矩形恒等；并反证「去掉钳制」「把 left/bottom 挪进 createStyle」为何必然错位；
 *   F 段：反例自检 —— 篡改后的源码必须被同一套不变量拦下。
 *
 * ⚠️ 本脚本是**静态断言 + 数值模型**：通过只说明这些表达式读出来是对的、且在模型下
 *    两边恒等；不代表能编译、更不代表真机观感符合预期（本工程无编译工具链）。
 *
 * 运行：node scripts/sim-collapsed-row-align.js
 * 退出码：不变量全过且反例全被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const F = {
  collapse: 'src/utils/tabBarCollapse.ts',
  tokens: 'src/theme/DesignTokens.ts',
  playerBar: 'src/components/player/PlayerBar/index.tsx',
  tabBar: 'src/components/layout/ModernTabBar.tsx',
}
const REAL = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, read(v)]))
// 每次都从 REAL 现取现剥：F 段的反例会临时改写 REAL，不变量必须看到改写后的源码
const stripped = () => Object.fromEntries(Object.entries(REAL).map(([k, v]) => [k, stripComments(v)]))

let pass = 0, fail = 0

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

const count = (src, needle) => src.split(needle).length - 1

/** 读 `export const name = 123` 的数值；值是标识符时递归解别名（collapsedPillGap = bottomFloatGap） */
const constNumber = (src, name, depth = 0) => {
  if (depth > 4) return null
  const s = stripComments(src)
  const num = new RegExp(`export const ${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\b`, 'm').exec(s)
  if (num) return Number(num[1])
  const alias = new RegExp(`export const ${name}\\s*=\\s*([A-Za-z_$][\\w$]*)`, 'm').exec(s)
  return alias ? constNumber(src, alias[1], depth + 1) : null
}

// ---------------------------------------------------------------------------
// 不变量
// ---------------------------------------------------------------------------

const runSourceInvariants = () => {
  const out = []
  const push = (name, ok, detail = '') => out.push({ name, ok, detail })
  const S = stripped()
  const col = S.collapse
  const tok = S.tokens
  const bar = S.playerBar
  const tab = S.tabBar

  // ---------------- A. tabBarCollapse：收起行几何的唯一来源 ----------------
  {
    const iface = /export interface CollapsedRowGeometry \{([\s\S]*?)\n\}/.exec(col)
    const keys = ['size', 'bottom', 'roundLeft', 'playerLeft']
    push('A1 CollapsedRowGeometry 四量齐全',
      iface != null && keys.every((k) => new RegExp(`\\b${k}:\\s*number`).test(iface[1])),
      iface == null ? '找不到接口定义' : keys.filter((k) => !new RegExp(`\\b${k}:\\s*number`).test(iface[1])).join('、') || '')

    push('A2 尺寸 = getCollapsedPillSize(实测)',
      col.includes('const size = getCollapsedPillSize(measured)'))
    push('A3 底边 = collapsedFloatBottom(safeAreaBottom)',
      col.includes('bottom: collapsedFloatBottom(safeAreaBottom),'))
    push('A4 左缘 = scaleSizeW(designSpacing.lg)（与 tab 栏/播放器展开态同基准）',
      col.includes('const roundLeft = scaleSizeW(designSpacing.lg)'))
    push('A5 播放器让位 = 圆钮左缘 + 尺寸 + collapsedPillGap',
      col.includes('playerLeft: roundLeft + size + collapsedPillGap,'))
    push('A6 几何对象由 memo 一并产出（四个量同一次计算）',
      /return useMemo\(\(\) => \(\{[\s\S]*?bottom: collapsedFloatBottom\(safeAreaBottom\)[\s\S]*?playerLeft: roundLeft \+ size \+ collapsedPillGap,[\s\S]*?\}\), \[size, safeAreaBottom, roundLeft\]\)/.test(col))
    push('A7 尺寸兜底只能取 token：measuredHeight > 0 ? measuredHeight : scaleSizeW(tabBarBaseHeight)',
      col.includes('measuredHeight > 0 ? measuredHeight : scaleSizeW(tabBarBaseHeight)'))
    // 55（某次实测值）/ 57（scaleSizeW(56) 被写死的值）是历史包袱：写死就会在字体档位变化时与 token 分叉
    push('A8 不得写死圆钮尺寸（历史值 55 / 57）',
      !/\b(55|57)\b/.test(col), (/\b(55|57)\b/.exec(col) || [''])[0])
    push('A9 几何 hook 读取共享 store（safeAreaBottom + 实测高度）',
      col.includes('const safeAreaBottom = useSafeAreaBottom()') &&
      col.includes('const measured = useMiniPlayerHeight()'))
    // 「只算一次」的实质：消费方不得自己调用推导函数
    push('A10 消费方不得各自调用 getCollapsedPillSize',
      count(bar, 'getCollapsedPillSize(') === 0 && count(tab, 'getCollapsedPillSize(') === 0)
    push('A11 消费方不得自己推导让位（+ collapsedPillGap 只出现在 tabBarCollapse）',
      count(bar, '+ collapsedPillGap') === 0 && count(tab, '+ collapsedPillGap') === 0)
  }

  // ---------------- B. DesignTokens：底边/间距同源 ----------------
  const bottomFloatGap = constNumber(tok, 'bottomFloatGap')
  const collapsedPillGap = constNumber(tok, 'collapsedPillGap')
  {
    push('B1 bottomFloatGap = 4（裸值，不乘 fontSize）',
      bottomFloatGap === 4, String(bottomFloatGap))
    push('B2 collapsedFloatBottom(safeAreaBottom) = safeAreaBottom + bottomFloatGap',
      /\(safeAreaBottom: number\): number =>\s*safeAreaBottom \+ bottomFloatGap\s*$/m.test(tok))
    push('B3 collapsedPillGap = bottomFloatGap（复用常量，不是碰巧同值）',
      /export const collapsedPillGap\s*=\s*bottomFloatGap\b/.test(tok))
    push('B4 tabBarBaseHeight = 56（与 tab 栏 height 同 token）',
      constNumber(tok, 'tabBarBaseHeight') === 56)
    push('B5 collapsedFloatBottom 函数体只有这一项加数（不得另加常量）',
      !/safeAreaBottom \+ bottomFloatGap \+/.test(tok))
    push('B6 收起态间距解析值 = 底缝值（同一条行是的整体）',
      collapsedPillGap === bottomFloatGap, `gap=${collapsedPillGap} bottomGap=${bottomFloatGap}`)
  }

  // ---------------- C. PlayerBar：消费同一几何 + 高度钳制 ----------------
  {
    push('C1 从 tabBarCollapse 取用收起行几何',
      /import \{[^}]*useCollapsedRowGeometry[^}]*\} from '@\/utils\/tabBarCollapse'/.test(bar))
    push('C2 const collapsedRow = useCollapsedRowGeometry()',
      bar.includes('const collapsedRow = useCollapsedRowGeometry()'))
    push('C3 pillSize = collapsedRow.size',
      bar.includes('const pillSize = collapsedRow.size'))
    push('C4 收起态底边 = collapsedRow.bottom',
      bar.includes('const bottomCollapsed = collapsedRow.bottom'))
    push('C5 收起态左让位 = collapsedRow.playerLeft',
      bar.includes('const paddingLeftCollapsed = collapsedRow.playerLeft'))
    // 本契约的核心：
    push('C6 收起态把胶囊高度钉死成 pillSize（同排同高的构造保证）',
      bar.includes('effectiveCollapsed && { height: pillSize }'))
    push('C7 钳制配套：container 必须 overflow:hidden（超出部分裁掉，不许顶开高度）',
      (styleBlock(bar, 'container') || '').includes("overflow: 'hidden'"))
    push('C8 bottom 插值 [展开, 收起] 两端都用几何对象',
      bar.includes('outputRange: [bottomExpanded, bottomCollapsed],'))
    push('C9 paddingLeft 插值 [展开, 收起] = [圆钮左缘, 播放器让位]',
      bar.includes('outputRange: [collapsedRow.roundLeft, paddingLeftCollapsed],'))
    push('C10 展开态左内边距与圆钮左缘同基准（designSpacing.lg）',
      (styleBlock(bar, 'wrapper') || '').includes('paddingHorizontal: designSpacing.lg'))
    push('C11 不得写死胶囊尺寸（历史值 55 / 57）',
      !/\b(55|57)\b/.test(bar))
    push('C12 收起动画 220ms + Easing.out(Easing.quad)',
      bar.includes('duration: 220,') && bar.includes('easing: Easing.out(Easing.quad),'))
    push('C13 收起态不上报高度（基准只能是展开态）',
      /if \(effectiveCollapsed\) return\s*\n\s*setMiniPlayerHeight\(e\.nativeEvent\.layout\.height\)/.test(bar))
  }

  // ---------------- D. ModernTabBar：圆钮侧 ----------------
  {
    push('D1 圆钮消费同一个几何对象',
      tab.includes('const collapsedRow = useCollapsedRowGeometry()') &&
      tab.includes('const pillSize = collapsedRow.size') &&
      tab.includes('const floatBottom = collapsedRow.bottom'))
    push('D2 圆钮 left/bottom/宽/高全部内联取几何（left=roundLeft，bottom=collapsedRow.bottom）',
      tab.includes('left: collapsedRow.roundLeft,') &&
      tab.includes('bottom: collapsedRow.bottom,') &&
      tab.includes('width: pillSize,') &&
      tab.includes('height: pillSize,'))
    // createStyle 把 left/right/top/bottom 交给 setSpText（另一套倍率），字体一变就与 24 基准分叉
    const wrapperBlock = styleBlock(tab, 'pillWrapper') || ''
    push('D3 pillWrapper 样式块不得含 left/bottom/宽/高（会被 setSpText 换一套倍率）',
      !/(^|\n)\s*(left|right|top|bottom|width|height)\s*:/.test(wrapperBlock),
      wrapperBlock.trim().slice(0, 60))
    // 圆钮必须整个落在图层 bounds 内：绝对子节点超出父级 bounds 时命中测试依赖 RN 的扩展行为
    push('D4 pillLayer 内联高度 = floatBottom + pillSize（圆钮不出 bounds）',
      tab.includes('style={[styles.pillLayer, { height: floatBottom + pillSize }]}'))
    const layerBlock = styleBlock(tab, 'pillLayer') || ''
    push('D5 pillLayer 不得有 padding / margin（RN 0.73 会与绝对 inset 叠加偏移）',
      !/(^|\n)\s*(padding|margin)[A-Za-z]*\s*:/.test(layerBlock),
      layerBlock.trim().slice(0, 60))
    push('D6 圆钮不得自己算底边（collapsedFloatBottom 只属于 tabBarCollapse）',
      count(tab, 'collapsedFloatBottom(') === 0)
    push('D7 收起动画与播放器同档：220ms + Easing.out(Easing.quad)',
      tab.includes('duration: 220,') && tab.includes('easing: Easing.out(Easing.quad),'))
  }

  // ---------------- E. 数值模型 ----------------
  for (const r of modelInvariants(bottomFloatGap, collapsedPillGap)) push(r.name, r.ok, r.detail)

  return out
}

// ---------------------------------------------------------------------------
// E 段实现：真实缩放公式 + 收起行矩形
// ---------------------------------------------------------------------------

const DEVICES = [
  { name: 'iPhone 16 Pro Max', w: 440, h: 956, pr: 3, fontScale: 1, fontSize: 1 },
  { name: 'iPhone SE', w: 320, h: 568, pr: 2, fontScale: 1, fontSize: 1 },
  { name: 'Pro Max·大字体1.3', w: 440, h: 956, pr: 3, fontScale: 1, fontSize: 1.3 },
  { name: 'iPad 1024×768', w: 1024, h: 768, pr: 2, fontScale: 1, fontSize: 1 },
]

/** scaleSizeW/H 的有效倍率（逐字抄自 src/utils/pixelRatio.ts，公式变了这里要一起改） */
const effScale = (d) => {
  const w = Math.min(d.w, d.h)
  const h = Math.max(d.w, d.h)
  return Math.min((w * d.pr) / 375, (h * d.pr) / 667, 3.1, 1.2 * d.pr)
}
const scaleSizeW = (size, d) => Math.floor((size * effScale(d)) / d.pr) * d.fontSize
/** setSpText 走的是另一套倍率（<=1.3，且不封顶 pixelRatio）——就是 D3 要躲开的那一套 */
const setSpText = (size, d) => {
  const w = Math.min(d.w, d.h)
  const h = Math.max(d.w, d.h)
  return Math.floor((size * Math.min(w / 375, h / 667, 1.3)) / d.fontScale) * d.fontSize
}

/**
 * 收起行两边的上下缘（同源模型的复算）。
 * `laidOutHeight` = 内容**自然**撑出的高度（标题/副标题换行、字体档位都会影响它）。
 *  · clamped=true （现状）：容器显式 height = pillSize，渲染高度与内容**无关**，
 *    更高的内容由 overflow:hidden 裁掉（不参与布局）；
 *  · clamped=false（历史缺陷）：容器没有高度，渲染高度 = 内容自然高度。
 */
const rowOf = (safeAreaBottom, measured, d, laidOutHeight, clamped) => {
  const size = measured > 0 ? measured : scaleSizeW(56, d)
  const bottom = safeAreaBottom + 4
  const rendered = clamped ? size : laidOutHeight
  return { size, bottom, buttonTop: bottom + size, pillTop: bottom + rendered, rendered }
}

const modelInvariants = (bottomFloatGap, collapsedPillGap) => {
  const out = []
  const push = (name, ok, detail = '') => out.push({ name, ok, detail })

  // E1：钳制语义锁 —— 显式 height=pillSize 后渲染高度与内容无关，两边上下缘恒等
  {
    const bad = []
    let cases = 0
    let worst = 0
    for (const d of DEVICES) {
      for (const safe of [0, 20, 34]) {
        for (const measured of [0, 41, 55, 68]) {
          const probe = rowOf(safe, measured, d, 0, true)
          // 内容自然高度：比 pillSize 矮 / 恰好相等 / 高一两 pt / 高很多，全都要齐平
          for (const laid of [probe.size - 20, probe.size - 6, probe.size, probe.size + 1, probe.size + 30, 200]) {
            const r = rowOf(safe, measured, d, Math.max(1, laid), true)
            cases++
            const delta = r.pillTop - r.buttonTop
            worst = Math.max(worst, Math.abs(delta))
            if (Math.abs(delta) > 1e-9) bad.push(`${d.name} safe=${safe} measured=${measured} laidOut=${laid}`)
          }
        }
      }
    }
    push('E1 钳制语义：渲染高度恒 = pillSize（内容撑多高都不参与布局）⇒ 两边上下缘恒等',
      bad.length === 0,
      `${cases} 组用例，最大偏差 ${worst}${bad.length ? '  反例：' + bad.slice(0, 3).join('; ') : ''}`)
  }

  // E2：反证 —— 去掉钳制后高度由内容决定，内容一旦超过 pillSize 顶边必然高出（这不是调参能修的）
  {
    const d = DEVICES[0]
    const tall = rowOf(34, 41, d, 68, false)   // 左让位压窄宽度 → 标题多占一行 → 内容 68
    const exact = rowOf(34, 41, d, 41, false)  // 内容恰好等于 pillSize 时无差异 → 不是「总能看出来」
    push('E2 无钳制时渲染高度 = 内容高度，内容 > pillSize 即顶边高出（钳制不可省）',
      tall.pillTop - tall.buttonTop > 0 && Math.abs(exact.pillTop - exact.buttonTop) < 1e-9,
      `内容 68 → 高出 ${tall.pillTop - tall.buttonTop}pt；内容 41 → 恰好齐平（缺陷只在换行/字体档位下显形）`)
  }

  // E3：兜底值与实测值不是同一个数 —— 两边若各取一个来源，必然错位
  {
    const rows = DEVICES.map((d) => `${d.name}: 兜底 ${scaleSizeW(56, d)}`)
    const diffs = DEVICES.map((d) => Math.abs(scaleSizeW(56, d) - 41))
    push('E3 首帧兜底 scaleSizeW(56) ≠ 实测值（两边各取一源即错位，故必须同源）',
      diffs.some((v) => v > 0.5), rows.join(' / '))
  }

  // E4：left/bottom 若走 createStyle(setSpText) 会偏离 24 基准多少
  {
    const rows = DEVICES.map((d) => {
      const correct = scaleSizeW(24, d)
      const wrong = setSpText(24, d)
      return `${d.name}: ${correct} vs ${wrong}（差 ${wrong - correct}）`
    })
    const proMax = DEVICES[0]
    const delta = setSpText(24, proMax) - scaleSizeW(24, proMax)
    push('E4 left/bottom 不能走 createStyle：代表机型上 setSpText(24) ≠ scaleSizeW(24)',
      delta !== 0, rows.join(' / '))
  }

  // E5：让位间距恒等于 collapsedPillGap
  {
    const bad = []
    for (const d of DEVICES) {
      for (const measured of [0, 41, 55]) {
        const size = measured > 0 ? measured : scaleSizeW(56, d)
        const roundLeft = scaleSizeW(24, d)
        const playerLeft = roundLeft + size + collapsedPillGap
        if (Math.abs((playerLeft - (roundLeft + size)) - collapsedPillGap) > 1e-9) bad.push(d.name)
      }
    }
    push('E5 胶囊左缘 − 圆钮右缘 ≡ collapsedPillGap',
      bad.length === 0, `gap=${collapsedPillGap}（同 bottomFloatGap=${bottomFloatGap}）`)
  }

  return out
}

// ---------------------------------------------------------------------------
// F. 反例自检：篡改源码后必须被拦下
// ---------------------------------------------------------------------------

const tamper = [
  {
    label: 'PlayerBar 去掉收起态高度钳制',
    file: 'playerBar',
    mutate: (s) => s.replace('effectiveCollapsed && { height: pillSize }', 'effectiveCollapsed && {}'),
  },
  {
    label: 'PlayerBar 手写收起态底边',
    file: 'playerBar',
    mutate: (s) => s.replace('const bottomCollapsed = collapsedRow.bottom', 'const bottomCollapsed = safeAreaBottom + 4'),
  },
  {
    label: 'PlayerBar 手写收起态左让位',
    file: 'playerBar',
    mutate: (s) => s.replace('const paddingLeftCollapsed = collapsedRow.playerLeft', 'const paddingLeftCollapsed = 69'),
  },
  {
    label: 'PlayerBar 去掉 container 的 overflow:hidden',
    file: 'playerBar',
    mutate: (s) => s.replace("    overflow: 'hidden',", ''),
  },
  {
    label: 'ModernTabBar 圆钮 left 改写字面量',
    file: 'tabBar',
    mutate: (s) => s.replace('left: collapsedRow.roundLeft,', 'left: 24,'),
  },
  {
    label: 'ModernTabBar 圆钮 bottom 改写字面量',
    file: 'tabBar',
    mutate: (s) => s.replace('bottom: collapsedRow.bottom,', 'bottom: 38,'),
  },
  {
    label: 'ModernTabBar 给 pillLayer 加 padding',
    file: 'tabBar',
    mutate: (s) => s.replace('  pillLayer: {\n    position:', '  pillLayer: {\n    paddingBottom: 4,\n    position:'),
  },
  {
    label: 'ModernTabBar 把 left/bottom 挪进 pillWrapper 样式块',
    file: 'tabBar',
    mutate: (s) => s.replace('  pillWrapper: {\n    position:', '  pillWrapper: {\n    left: 24,\n    bottom: 38,\n    position:'),
  },
  {
    label: 'DesignTokens 收起间距写死 12',
    file: 'tokens',
    mutate: (s) => s.replace('export const collapsedPillGap = bottomFloatGap', 'export const collapsedPillGap = 12'),
  },
  {
    label: 'DesignTokens 收起底边另加常量',
    file: 'tokens',
    mutate: (s) => s.replace('=> safeAreaBottom + bottomFloatGap\n', '=> safeAreaBottom + bottomFloatGap + 10\n'),
  },
  {
    // 注意狙击点必须落在**代码**上：文件顶部的说明注释里也写着 scaleSizeW(tabBarBaseHeight)
    // （第一版反例就是打中注释、被 stripComments 抹掉，从而「未被拦下」——这正是本段存在的意义）
    label: 'tabBarCollapse 尺寸兜底写死 57',
    file: 'collapse',
    mutate: (s) => s.replace('? measuredHeight : scaleSizeW(tabBarBaseHeight)', '? measuredHeight : 57'),
  },
]

// ---------------------------------------------------------------------------

console.log('sim-collapsed-row-align：收起态迷你播放器与圆钮共线（同排同高）\n')

const results = []
const push = (name, ok, detail = '') => results.push({ name, ok, detail })

console.log('--- A/B/C/D. 源码不变量 ---')
console.log('--- E. 数值模型（按 pixelRatio.ts 真实公式复算）---')
for (const r of runSourceInvariants()) push(r.name, r.ok, r.detail)

console.log('\n--- F. 反例自检 ---')
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
