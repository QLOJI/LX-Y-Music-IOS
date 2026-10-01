/**
 * sim-cover-layout-constraint.js
 *
 * 「封面不得压到歌名栏 / 大歌词」的约束契约（竖屏播放页封面页布局）。
 *
 * 背景（用户报的现象）：「封面图片区域跑到其他区域，占到歌名区域和大歌词区域」。
 * 成因是两个刚性量相加后超出容器：
 *   ① 小歌词**至少渲染一行**（MiniLyric 的 fitRows = max(1, …)，见 MiniLyric.tsx:181）——
 *      给它多少上限都不会少于一行；
 *   ② 封面是 flexShrink:0 的居中块 —— 被挤不会自己缩小，只会顶出 picContainer。
 * 只调「小歌词上限」而不动「封面尺寸」，大字号 + 翻译行的机型上仍会越界
 * （实测口径：375×667、130% 字体、带翻译行，越界约 9~13pt）。
 *
 * 现行算式（src/screens/PlayDetail/Vertical/VerticalNew.tsx 的合并 memo）：
 *   available = R − 2·containerPaddingH − paddingBottom − (songInfoOffset + 内容高 + marginBottom)
 *   coverSizeCap = max(available − songInfoOffset − 一行小歌词高, MIN_COVER_KEEP_RATIO × 自然直径)
 *   小歌词上限  = max(0, available − min(自然直径, coverSizeCap) − songInfoOffset)
 * 越界量 = size − (picContainer高 − songInfoOffset)，picContainer 是 flex:1 ⇒
 *   picContainer高 = available − 小歌词实际高（≥ 一行高）
 * ⇒ 只要 coverSizeCap 吃掉「一行高 + songInfoOffset」，封面就必然不越界；
 *   MIN_COVER_KEEP_RATIO 是地板（极限机型不把封面缩到看不见），地板生效时残余越界
 *   被压到 ≤ 40% 封面直径 —— 这是**有意取舍**，由本脚本量化并钉住上界。
 *
 * 本脚本做两件事：
 *   A. 源码形态：算式必须与上面逐项一致，且封面尺寸只有一个真值来源（VerticalNew 复用
 *      Pic 导出的 getCoverSize，不得再抄一份基准公式）。
 *   B. 代数扫描：在 plausible 参数域上证明四条性质 ——
 *      C1 地板不绑定时**恰好不越界**（clearance ≥ 0）；
 *      C2 任意情况下越界量 ≥ min(0, available − o − 一行高 − KEEP×直径)（界成立）；
 *      C3 残余越界只来自地板（clearance < 0 ⇒ 地板生效）；
 *      C4 旧算式确实会越界（否则守卫是空转的）。
 *
 *      诚实声明：新算式**并不**处处比旧大 —— 旧实现按固定 R/2 预留，50% 档白让出一大截
 *      （少显示小歌词行）；新算式按实际封面尺寸留白，这些点会多显示一行、clearance 相应变小。
 *      这是「按实际尺寸留白」这一修复目标的必然结果，不是什么副作用，C3b 只钉住
 *      「这些点仍然 ≥ 0」，即多显示的行永远不会把封面压到歌名上。
 *
 * 运行：node scripts/sim-cover-layout-constraint.js
 * 退出码：A 段 6 项断言全过、4 例反例全被拦下，且 B 段 6 项全过时为 0，否则 1。
 *
 * 边界：本脚本只证明「算式自洽 + 与源码同形」，**不证明真机观感**（无 node_modules、
 * 无模拟器；参数域里的 R / 内容高都是估计区间，不是实测）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
// 与 sim-cover-shape.js 同款：注释必须先去干净，否则「注释里提到过某写法」会被当成实现。
const stripComments = (t) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')

const VERTICAL_NEW = 'src/screens/PlayDetail/Vertical/VerticalNew.tsx'
const VERTICAL_PIC = 'src/screens/PlayDetail/Vertical/Pic.tsx'
const MINI = 'src/screens/PlayDetail/components/MiniLyric.tsx'

const REAL = {
  verticalNew: read(VERTICAL_NEW),
  verticalPic: read(VERTICAL_PIC),
  mini: read(MINI),
}

const results = []
const add = (group, name, ok, detail = '') => results.push({ group, name, ok, detail })

/** A 段：源码形态断言（对 src 求值，反例喂篡改后的源码进来跑同一套） */
function sourceAssertions(src, label) {
  const out = []
  const push = (n, ok, detail = '') => out.push({ name: `${label} · ${n}`, ok, detail })
  const code = stripComments(src.verticalNew)
  const pic = stripComments(src.verticalPic)
  const mini = stripComments(src.mini)

  // A1 封面尺寸只有一个真值来源：VerticalNew 复用 Pic 的 getCoverSize，自己不再抄公式。
  //    历史 bug 就是「两处各写一份」漂移成 min(90% 屏宽, 66% 可用高) 的旧口径。
  {
    const imports = /import\s+Pic,\s*\{\s*getCoverSize\s*\}\s+from\s+'\.\/Pic'/.test(code)
    const calls = /getCoverSize\(\s*winWidth,\s*winHeight,\s*statusBarHeight,\s*coverSize,\s*coverRegionHeight\s*\)/.test(code)
    const noCopy = !/\*\s*0\.65\b/.test(code) && !/0\.85\b/.test(code)
    const exported = /export const getCoverSize = \(/.test(pic)
    push('A1 封面尺寸单一来源（VerticalNew 复用 Pic 的 getCoverSize，无第二份基准公式）',
      imports && calls && noCopy && exported,
      `import=${imports} 调用=${calls} 无副本=${noCopy} Pic 导出=${exported}`)
  }

  // A2 尺寸上限算式：available − songInfoOffset − 一行小歌词高（带翻译的最坏情况），
  //    与地板 MIN_COVER_KEEP_RATIO 一起取 max。
  {
    const rowTerm = /available\s*-\s*songInfoOffset\s*-\s*getMiniLyricRowHeight\(true\)/.test(code)
    const withFloor = /Math\.max\(\s*available\s*-\s*songInfoOffset\s*-\s*getMiniLyricRowHeight\(true\),\s*coverDiameter\s*\*\s*MIN_COVER_KEEP_RATIO\s*,?\s*\)/.test(code)
    push('A2 上限 = max(available − offset − 一行高, KEEP×直径)',
      rowTerm && withFloor, `一行高项=${rowTerm} 取 max 带地板=${withFloor}`)
  }

  // A3 小歌词上限按**实际生效的封面尺寸**留白（不是固定的 R/2）：否则 50% 档白让出一大截、
  //    100% 档又预留不足（旧实现的两种偏差都来自「预留量 ≠ 实际封面尺寸」）。
  {
    const actual = /available\s*-\s*Math\.min\(coverDiameter,\s*cap\)\s*-\s*songInfoOffset/.test(code)
    push('A3 小歌词上限按 min(自然直径, 上限) 留白（不按固定 R/2 预留）', actual, `按实际尺寸=${actual}`)
  }

  // A4 这条上限必须在 Pic 侧真的被用上（否则 VerticalNew 算了个寂寞）。
  {
    const applied = /sizeCap\s*>\s*0\s*\?\s*Math\.min\(s,\s*sizeCap\)\s*:\s*s/.test(pic)
    const propDefault = /sizeCap\s*=\s*0\s*\}/.test(pic)
    const passed = /sizeCap=\{coverSizeCap\}/.test(code)
    push('A4 Pic 消费 sizeCap（0 = 不施加），VerticalNew 真的传了它',
      applied && propDefault && passed,
      `最小化应用=${applied} 默认 0=${propDefault} 下传=${passed}`)
  }

  // A5 行高必须与 MiniLyric 内部**同源**（同一个 calcMetrics），且本脚本的档位模型
  //    必须与 MiniLyric 的 fitRows 逐字同形 —— 否则 B 段扫描的是另一个组件。
  {
    const exported = /export const getMiniLyricRowHeight = \(hasTranslation: boolean\)/.test(mini)
    const sameSource = /const metrics = useMemo\(\(\) => calcMetrics\(\), \[\]\)/.test(mini)
    const fitRows = /Math\.max\(1, Math\.min\(MAX_WINDOW_ROWS, Math\.floor\(limit \/ rowHeight\)\)\)/.test(mini)
    push('A5 行高与 MiniLyric 同源、档位公式与 fitRows 同形',
      exported && sameSource && fitRows,
      `导出=${exported} 同源=${sameSource} fitRows 同形=${fitRows}`)
  }

  // A6 地板常量必须在 (0, 1) 内（0 = 不保护、≥1 = 地板反过来把封面撑爆）。
  {
    const m = /const\s+MIN_COVER_KEEP_RATIO\s*=\s*([\d.]+)/.exec(code)
    const v = m ? Number(m[1]) : NaN
    push('A6 MIN_COVER_KEEP_RATIO 落在 (0, 1)',
      Number.isFinite(v) && v > 0 && v < 1, `取到 ${m ? m[1] : '未找到'}`)
  }

  return out
}

/** 反例：篡改后必须被 A 段拦下 */
function tamperCases(src) {
  const anchors = [
    [/import\s+Pic,\s*\{\s*getCoverSize\s*\}\s+from\s+'\.\/Pic'/, 'getCoverSize 的 import'],
    [/available\s*-\s*songInfoOffset\s*-\s*getMiniLyricRowHeight\(true\)/, '一行高项'],
    [/coverDiameter\s*\*\s*MIN_COVER_KEEP_RATIO/, '地板项'],
    [/available\s*-\s*Math\.min\(coverDiameter,\s*cap\)\s*-\s*songInfoOffset/, '按实际尺寸留白'],
    [/sizeCap > 0 \? Math\.min\(s, sizeCap\) : s/, 'Pic 侧的 sizeCap 应用'],
  ]
  for (const [re, what] of anchors) {
    if (!re.test(src.verticalNew) && !re.test(src.verticalPic)) {
      throw new Error(`反例锚点未命中（${what}）：源码已变，反例需同步`)
    }
  }
  return [
    {
      label: '① VerticalNew 又自带一份封面基准公式（脱离单一来源）',
      mutate: (s) => ({ ...s, verticalNew: s.verticalNew.replace('available - songInfoOffset - getMiniLyricRowHeight(true)', 'Math.min(winWidth * 0.65, 300) - songInfoOffset') }),
    },
    {
      label: '② 上限退回按固定 R/2 预留（用户报的越界原样复现）',
      mutate: (s) => ({
        ...s,
        verticalNew: s.verticalNew.replace(
          /Math\.max\(\s*available\s*-\s*songInfoOffset\s*-\s*getMiniLyricRowHeight\(true\),\s*coverDiameter\s*\*\s*MIN_COVER_KEEP_RATIO\s*,?\s*\)/,
          'Math.max(pageHeight / 2 + songInfoOffset)',
        ),
      }),
    },
    {
      label: '③ 小歌词上限改回固定预留（不按实际封面尺寸）',
      mutate: (s) => ({
        ...s,
        verticalNew: s.verticalNew.replace('available - Math.min(coverDiameter, cap) - songInfoOffset', 'available - pageHeight / 2 - songInfoOffset'),
      }),
    },
    {
      label: '④ Pic 忽略 sizeCap（上限算了也没用）',
      mutate: (s) => ({ ...s, verticalPic: s.verticalPic.replace('sizeCap > 0 ? Math.min(s, sizeCap) : s', 's') }),
    },
  ]
}

// ---------------------------------------------------------------------------
// B 段：代数扫描
// ---------------------------------------------------------------------------
const KEEP = Number((/const\s+MIN_COVER_KEEP_RATIO\s*=\s*([\d.]+)/.exec(stripComments(REAL.verticalNew)) ?? [])[1])
const MAX_ROWS = Number((/const\s+MAX_WINDOW_ROWS\s*=\s*(\d+)/.exec(stripComments(REAL.mini)) ?? [])[1])
const EPS = 1e-6

// 现行算式（与 A2/A3 逐项对应；A 段保证源码就是这个形状）
const capOf = (M0, o, rowH, dia) => Math.max(M0 - o - rowH, KEEP * dia)
const sizeNew = (M0, o, rowH, dia) => Math.min(dia, capOf(M0, o, rowH, dia))
const limitNew = (M0, o, rowH, dia) => Math.max(0, M0 - sizeNew(M0, o, rowH, dia) - o)
// 旧算式：小歌词上限按固定 R/2 预留，封面尺寸不受它约束
const limitOld = (M0, o, R2) => Math.max(0, M0 - (R2 + o))

// MiniLyric.tsx:181 的档位（A5 钉住同形）：至少一行、至多 MAX_WINDOW_ROWS 行
const rowsOf = (limit, rowH) => Math.max(1, Math.min(MAX_ROWS, Math.floor(limit / rowH + EPS)))
const lyricHeight = (limit, rowH) => rowsOf(limit, rowH) * rowH

// 越界量 = size − (picContainer高 − o)；picContainer高 = M0 − 小歌词实际高
const clearanceNew = (M0, o, rowH, dia) => M0 - lyricHeight(limitNew(M0, o, rowH, dia), rowH) - o - sizeNew(M0, o, rowH, dia)
const clearanceOld = (M0, o, rowH, dia, R2) => M0 - lyricHeight(limitOld(M0, o, R2), rowH) - o - dia

function sweep() {
  const rows = []
  // 参数域（估计区间，不是实测）：
  //   M0  封面+小歌词可用的竖直空间：小屏 SE ≈ 250 上下，大屏 ≈ 400 上下
  //   o   SongInfo 的 marginTop（= Pic 容器的 paddingTop）：小屏 inline 8 / 大屏 20，随字号最多 ×1.3
  //   rowH 一行小歌词高：fontSize 1.0 单行 ≈ 22~26、带翻译 ≈ 48；fontSize 1.3 带翻译 ≈ 63~80
  //   R2  R/2 = 封面尺寸上限（R 是封面页容器实测高）：SE ≈ 192、用户机型 ≈ 288
  //   dia 自然封面直径 ≤ R2（50% / 75% / 100% 三档）
  for (let M0 = 150; M0 <= 600; M0 += 1) {
    for (const o of [0, 8, 12, 20, 27]) {
      for (const rowH of [22, 26, 48, 63.4, 80]) {
        for (const R2 of [200, 288, 384, 450]) {
          for (const ratio of [1, 0.75, 0.5]) {
            const dia = R2 * ratio
            rows.push({
              M0, o, rowH, R2, dia,
              floorBound: M0 - o - rowH < KEEP * dia,
              new_: clearanceNew(M0, o, rowH, dia),
              old_: clearanceOld(M0, o, rowH, dia, R2),
            })
          }
        }
      }
    }
  }
  return rows
}

const stats = sweep()
// C1 地板不绑定 ⇒ 恰好不越界
const unbound = stats.filter((r) => !r.floorBound)
const c1 = unbound.every((r) => r.new_ >= -EPS)
// 用 reduce 而不是 Math.min(...arr)：扫描点有十万量级，展开成实参会爆栈
//（实参上限受引擎调用栈约束，与数组长度无关）。
const c1Worst = unbound.reduce((m, r) => (r.new_ < m ? r.new_ : m), Infinity)
// C2 界：越界量 ≥ min(0, M0 − o − rowH − KEEP×dia)
const c2 = stats.every((r) => r.new_ >= Math.min(0, r.M0 - r.o - r.rowH - KEEP * r.dia) - EPS)
// 地板生效时的残余越界上界 ≤ KEEP×直径
const c2b = stats.every((r) => r.new_ >= -KEEP * r.dia - EPS)
// C3 残余越界只可能来自地板（不是算式漏洞）：clearance < 0 ⇒ 地板生效。
//    反面：新算式**不保证**处处不比旧大 —— 旧实现按固定 R/2 预留时会把空间白让出去
//    （少显示小歌词行），新算式按实际封面尺寸留白后，这些点会多显示一行小歌词、
//    clearance 相应变小。这是 D2 的修复目标，不是回归；但必须钉住它不会越过 0：
//    「相对旧算式变差」的每一个点仍 ≥ 0（多显示的行永远不会把封面压到歌名上）。
const c3 = stats.every((r) => !(r.new_ < -EPS) || r.floorBound)
const worse = stats.filter((r) => r.new_ < r.old_ - 1e-6)
const c3b = worse.every((r) => r.new_ >= -EPS)
const worseWorst = worse.reduce((m, r) => Math.min(m, r.new_), 0)
const improved = stats.filter((r) => r.new_ > r.old_ + 1e-6).length
// C4 旧算式确实会越界（记住：旧实现是按 R/2 预留 + 封面不受上限约束）
const oldBad = stats.filter((r) => r.old_ < -EPS).length
const newBad = stats.filter((r) => r.new_ < -EPS).length

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const label = '竖屏封面页布局'
for (const r of sourceAssertions(REAL, label)) add('A 源码形态', r.name, r.ok, r.detail)

for (const c of tamperCases(REAL)) {
  const patched = c.mutate(REAL)
  const changed = Object.keys(patched).some((k) => patched[k] !== REAL[k])
  if (!changed) {
    add('A 反例', `反例 ${c.label}`, false, '替换未命中：源码已变，反例失效需同步')
    continue
  }
  const failed = sourceAssertions(patched, label).filter((r) => !r.ok)
  add('A 反例', `反例 ${c.label} 被拦下`, failed.length > 0,
    failed.length ? `命中：${failed.map((r) => r.name.split('· ')[1].split('（')[0]).join('、')}` : '未被任何断言拦下（守卫无效）')
}

add('B 代数扫描', `C1 地板不绑定时恰好不越界（${unbound.length} 个点，最差 clearance=${c1Worst.toFixed(2)}pt）`, c1)
add('B 代数扫描', 'C2 越界量下界 = min(0, M0 − o − 一行高 − KEEP×直径)', c2)
add('B 代数扫描', `C2b 地板生效时残余越界 ≤ KEEP×直径（= ${(KEEP * 100).toFixed(0)}% 封面直径）`, c2b)
add('B 代数扫描', 'C3 残余越界只来自地板（clearance < 0 ⇒ 地板生效，不是算式漏洞）', c3)
add('B 代数扫描',
  `C3b 相对旧算式「变小」的 ${worse.length} 个点仍全部 ≥ 0（多显示的行不会把封面压到歌名上）`,
  c3b, worse.length ? `这些点最差 clearance=${worseWorst.toFixed(2)}pt` : '')
add('B 代数扫描', `C4 旧算式确实会越界（${oldBad} 点），新算式远少（${newBad} 点）`, oldBad > 0 && newBad < oldBad)

// 报表明细（帮助后续调参时看清边界）
console.log('竖屏封面页布局约束契约（sim-cover-layout-constraint）')
console.log(`参数：KEEP=${KEEP}（源码）· MAX_WINDOW_ROWS=${MAX_ROWS}（MiniLyric 源码）· 扫描点 ${stats.length}`)
console.log('')
console.log('旧 vs 新（SE 375×667、130% 字体、带翻译行：R2=192、o=8、一行高 63.4）')
console.log('  M0   旧 clearance   新 clearance   新封面直径')
for (const M0 of [220, 240, 260, 280, 300, 340]) {
  const o = 8, rowH = 63.4, R2 = 192, dia = R2
  console.log(
    `  ${String(M0).padEnd(5)} ${clearanceOld(M0, o, rowH, dia, R2).toFixed(1).padStart(9)}pt ${clearanceNew(M0, o, rowH, dia).toFixed(1).padStart(12)}pt ${sizeNew(M0, o, rowH, dia).toFixed(1).padStart(11)}`,
  )
}
console.log('  （clearance < 0 = 封面压到歌名栏；旧算式在这一带为负，新算式抬到 0 或由地板兜底）')
console.log('')

let pass = 0
let fail = 0
let lastGroup = ''
for (const r of results) {
  if (r.group !== lastGroup) {
    console.log(`\n--- ${r.group} ---`)
    lastGroup = r.group
  }
  if (r.ok) {
    pass++
    console.log(`  PASS  ${r.name}`)
  } else {
    fail++
    console.log(`  FAIL  ${r.name}`)
  }
  if (r.detail) console.log(`        ${r.detail}`)
}

console.log('\n' + '='.repeat(70))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
