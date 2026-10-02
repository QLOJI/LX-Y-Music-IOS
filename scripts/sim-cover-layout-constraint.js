/**
 * sim-cover-layout-constraint.js
 *
 * 「封面不得压到返回栏 / 歌名栏」的约束契约 + 「封面滑块 100%~150% 必须真的起作用」的回归契约
 * （竖屏播放页封面页布局）。
 *
 * 背景①（越界，用户报过）：「封面图片区域跑到其他区域，占到歌名区域和大歌词区域」。
 * 成因是两个刚性量相加后超出容器：
 *   ① 小歌词**至少渲染一行**（MiniLyric 的 fitRows = max(1, …)，分母是最坏行高
 *      worstRowHeight）——给它多少上限都不会少于一行；
 *   ② 封面是 flexShrink:0 的居中块 —— 被挤不会自己缩小，只会顶出 picContainer。
 *
 * 背景②（第 19 轮用户报）：「封面显示大小调节，目前只到了 100%，还有 100-150% 调节没有反应，
 * 目前看来，封面上下还有空间」+「小歌词部分区域还可以上下扩大一点」。
 * 成因是旧口径（见下）把 songInfoOffset 在算式里扣了**两次**，把封面区间与小歌词区间
 * 各压小了 2×offset（用户机型 40pt）；再叠加 Pic 里那条独立的「R/2」上限，
 * 用户机型上 100% 的自然直径(≈286)与 R/2(≈255.5) 就已经封顶 ⇒ 100%~150% 整段完全无变化。
 *
 * 现行算式（src/screens/PlayDetail/Vertical/VerticalNew.tsx 的合并 memo，第 19 轮重推）：
 *   M         = R − 2·containerPaddingH − paddingBottom − (SongInfo内容高 + marginBottom)
 *   封面区间  = max(M − 一行小歌词高, MIN_COVER_KEEP_RATIO × 自然直径)      ← 下传 Pic 的 coverRegionHeight
 *   封面直径  = min(自然直径, 封面区间)                                     ← Pic 的 getCoverSize 内部取
 *   小歌词上限 = max(0, M − 封面直径)
 *
 * 推导（y=0 取 picPageContainerNew 内容盒顶边；H = picContainer 高 = M − offset − 小歌词实际高）：
 *   封面在 picContainer 内居中于「扣掉 paddingTop=offset 后的区间」⇒
 *     顶端 = (H + offset − 直径)/2，底端 = (H + offset + 直径)/2
 *   不越区的充要条件是顶端不越过返回栏 ⇒ 直径 ≤ H + offset ⟺ **直径 ≤ M − 小歌词实际高**
 *   （offset 在 H 里是 −offset、在不等式里是 +offset，两边抵消 —— 旧口径各扣一次就是这里错的）。
 * 小歌词至少一行 ⇒ 只要 封面区间 = M − 一行高，就必然不越界。这就是本契约 C1 要钉的性质。
 *
 * 本脚本做三件事：
 *   A. 源码形态：算式必须与上面逐项一致；封面尺寸只有一个真值来源（VerticalNew 复用
 *      Pic 导出的 getCoverNaturalSize / getCoverSize，不得再抄一份基准公式）；旧口径
 *      （available − offset − 一行高 / 按固定 R/2 预留 / sizeCap 旁路）必须**不被写回**。
 *   B. 代数扫描：在 plausible 参数域上证明四条性质 ——
 *      C1 地板不绑定时**必然不越界**（clearance ≥ containerPaddingH）；
 *      C2 地板生效时的残余越界量有精确上界（模型恒等式）；
 *      C3 残余越界只来自地板（clearance < 0 ⇒ 地板生效）；
 *      C4 旧口径确实越界 / 确实让滑块上段失效（否则守卫是空转的），
 *         且新口径让「小歌词可用高度」恰好增加 2×offset。
 *
 *      诚实声明：本契约证明的是**几何与代数**，不是真机观感；参数域里的 R / 内容高都是
 *      估计区间，不是实测。旧口径的「残余越界」在第 19 轮之前由地板兜底（有意取舍），
 *      这里把它量化并钉住上界，不假装它是零。
 *
 * 运行：node scripts/sim-cover-layout-constraint.js
 * 退出码：A 段全过、反例全被拦下、B 段全过时为 0，否则 1。
 *
 * 边界：本脚本只证明「算式自洽 + 与源码同形」，**不证明真机观感**（无 node_modules、
 * 无模拟器）。
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

  // A1 封面尺寸只有一个真值来源：VerticalNew 复用 Pic 导出的两个函数，自己不再抄公式。
  //    历史 bug 就是「两处各写一份」漂移成 min(90% 屏宽, 66% 可用高) 的旧口径。
  {
    const imports = /import\s+Pic,\s*\{\s*getCoverSize,\s*getCoverNaturalSize\s*\}\s+from\s+'\.\/Pic'/.test(code)
    const naturalDecl = /const\s+coverNaturalSize\s*=\s*getCoverNaturalSize\(\s*winWidth,\s*winHeight,\s*statusBarHeight,\s*coverSize\s*\)/.test(code)
    const sizeCall = /getCoverSize\(\s*winWidth,\s*winHeight,\s*statusBarHeight,\s*coverSize,\s*band\s*\)/.test(code)
    const noCopy = !/\*\s*0\.65\b/.test(code) && !/0\.85\b/.test(code)
    const exported = /export const getCoverSize = \(/.test(pic) && /export const getCoverNaturalSize = \(/.test(pic)
    const singleBase = (stripComments(pic).match(/\*\s*0\.65\b/g) || []).length === 1 && (stripComments(pic).match(/0\.85\b/g) || []).length === 1
    push('A1 封面尺寸单一来源（VerticalNew 复用 Pic 的 getCoverNaturalSize/getCoverSize，无第二份基准公式）',
      imports && naturalDecl && sizeCall && noCopy && exported && singleBase,
      `import=${imports} 自然直径=${naturalDecl} 取尺寸=${sizeCall} VerticalNew 无副本=${noCopy} Pic 导出两个=${exported} Pic 内基准唯一=${singleBase}`)
  }

  // A2 封面区间（= 直径上限）= max(M − 一行小歌词高（带翻译的最坏情况）, 地板)。
  //    M 里**不含** songInfoOffset —— 这是第 19 轮修正的核心（offset 在几何上两端抵消）。
  {
    const MLine = /const\s+M\s*=\s*containerHeight\s*-\s*containerPaddingH\s*\*\s*2\s*-\s*\(isSmallWindow\s*\?\s*0\s*:\s*PAGE_BOTTOM_PADDING\)[\s\S]{0,80}?-\s*\(songInfoContent\s*\+\s*songInfoMarginBottom\)/.test(code)
    const bandLine = /const\s+band\s*=\s*Math\.max\(\s*M\s*-\s*getMiniLyricRowHeight\(true\),\s*coverNaturalSize\s*\*\s*MIN_COVER_KEEP_RATIO\s*,?\s*\)/.test(code)
    push('A2 封面区间 = max(M − 一行高, KEEP×自然直径)，且 M 里不含 songInfoOffset',
      MLine && bandLine, `M 定义=${MLine} 区间=${bandLine}`)
  }

  // A3 小歌词上限按**实际生效的封面直径**留白，且直接取 M − 直径（不再多扣 offset）：
  //    旧实现的两个偏差都来自「预留量 ≠ 实际封面尺寸」和「多扣一个 offset」。
  {
    const actual = /Math\.max\(\s*0,\s*M\s*-\s*getCoverSize\(winWidth,\s*winHeight,\s*statusBarHeight,\s*coverSize,\s*band\)\s*,?\s*\)/.test(code)
    push('A3 小歌词上限 = max(0, M − min(自然直径, 区间))（不再多扣 offset）', actual, `按实际直径=${actual}`)
  }

  // A4 区间值必须在 Pic 侧真的被用上，且 Pic 侧**不许**再有并列的第二条上限
  //    （旧的 sizeCap / R/2 都是「两条并列上限必然漂移」的来源，第 19 轮已删）。
  {
    const applied = /const\s+regionMax\s*=\s*coverRegionHeight\s*>\s*0\s*\?\s*coverRegionHeight\s*:\s*Infinity/.test(pic)
    const noHalfR = !/coverRegionHeight\s*\/\s*2/.test(pic)
    const noSizeCap = !/sizeCap/.test(pic) && !/sizeCap/.test(code)
    const propDefault = /coverRegionHeight\s*=\s*0\s*\}/.test(pic)
    push('A4 Pic 消费 coverRegionHeight（≤0 = 不施加），且不许再有 sizeCap / R÷2 并列上限',
      applied && noHalfR && noSizeCap && propDefault,
      `应用=${applied} 无 R÷2=${noHalfR} 无 sizeCap=${noSizeCap} 默认 0=${propDefault}`)
  }

  // A5 旧口径必须**不被写回**：源码里不许出现
  //    「available − songInfoOffset − 一行高」与「− Math.min(coverDiameter, cap) − songInfoOffset」
  //    这两个第 19 轮修掉的形状（注释已剥离，命中即实现里真的还有）。
  {
    const oldShape1 = /available\s*-\s*songInfoOffset\s*-\s*getMiniLyricRowHeight\(true\)/.test(code)
    const oldShape2 = /Math\.min\(coverDiameter,\s*cap\)\s*-\s*songInfoOffset/.test(code)
    const oldVar = /\bcoverDiameter\b/.test(code)
    push('A5 旧口径（offset 扣两次 / coverDiameter 变量）没有被写回',
      !oldShape1 && !oldShape2 && !oldVar,
      `旧上限形状=${oldShape1} 旧留白形状=${oldShape2} 旧变量=${oldVar}`)
  }

  // A6 首帧兜底必须在：实测未到时用解析估算（页面高 + SongInfo 内容高镜像）算区间，
  //    否则封面首帧会按「无上限」渲染再缩回来（入场跳变）。
  {
    const measured = /const\s+measured\s*=\s*pageHeight\s*>\s*0\s*&&\s*songInfoContentHeight\s*>\s*0/.test(code)
    const est = /const\s+containerHeight\s*=\s*measured\s*\?\s*pageHeight\s*:\s*estimatedPageHeight/.test(code)
    const estContent = /const\s+songInfoContent\s*=\s*measured\s*\?\s*songInfoContentHeight\s*:\s*estimateSongInfoContentHeight\(\)/.test(code)
    const mirror = /const\s+estimateSongInfoContentHeight\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,300}?row\(28\)[\s\S]{0,120}?row\(9\)[\s\S]{0,120}?row\(16\)[\s\S]{0,120}?row\(14\)/.test(code)
    const undef = /miniLyricMaxHeight:\s*measured\s*\n?\s*\?\s*Math\.max\(0,\s*M\s*-/.test(code)
    push('A6 首帧兜底：实测未到时用解析估算（含 SongInfo 内容高镜像），小歌词上限暂给 undefined',
      measured && est && estContent && mirror && undef,
      `measured=${measured} 页面高兜底=${est} 内容高兜底=${estContent} 镜像=${mirror} 歌词上限 undefined=${undef}`)
  }

  // A7 行高必须与 MiniLyric 内部**同源**（同一个 calcMetrics），且本脚本的档位模型
  //    必须与 MiniLyric 的 fitRows 逐字同形 —— 否则 B 段扫描的是另一个组件。
  //    块高与档位按**最坏情况**（worstRowHeight = 基础行高 + 有真翻译时的翻译槽）算。
  {
    const exported = /export const getMiniLyricRowHeight = \(hasTranslation: boolean\)/.test(mini)
    const sameSource = /const metrics = useMemo\(\(\) => calcMetrics\(\), \[\]\)/.test(mini)
    const worstRow = /const worstRowHeight = baseRowHeight \+ \(songHasTranslation \? translationSlot : 0\)/.test(mini)
    const fitRows = /Math\.max\(1, Math\.min\(MAX_WINDOW_ROWS, Math\.floor\(limit \/ worstRowHeight\)\)\)/.test(mini)
    push('A7 行高与 MiniLyric 同源、档位公式与 fitRows 同形',
      exported && sameSource && worstRow && fitRows,
      `导出=${exported} 同源=${sameSource} 最坏行高=${worstRow} fitRows 同形=${fitRows}`)
  }

  // A8 地板常量必须在 (0, 1) 内（0 = 不保护、≥1 = 地板反过来把封面撑爆）。
  {
    const m = /const\s+MIN_COVER_KEEP_RATIO\s*=\s*([\d.]+)/.exec(code)
    const v = m ? Number(m[1]) : NaN
    push('A8 MIN_COVER_KEEP_RATIO 落在 (0, 1)',
      Number.isFinite(v) && v > 0 && v < 1, `取到 ${m ? m[1] : '未找到'}`)
  }

  return out
}

/** 反例：篡改后必须被 A 段拦下 */
function tamperCases(src) {
  const anchors = [
    [/import\s+Pic,\s*\{\s*getCoverSize,\s*getCoverNaturalSize\s*\}\s+from\s+'\.\/Pic'/, 'getCoverNaturalSize 的 import'],
    [/const\s+band\s*=\s*Math\.max\(\s*M\s*-\s*getMiniLyricRowHeight\(true\),\s*coverNaturalSize\s*\*\s*MIN_COVER_KEEP_RATIO/, '封面区间 = M − 一行高'],
    [/Math\.max\(\s*0,\s*M\s*-\s*getCoverSize\(winWidth,\s*winHeight,\s*statusBarHeight,\s*coverSize,\s*band\)/, '小歌词上限 = M − 直径'],
    [/const\s+regionMax\s*=\s*coverRegionHeight\s*>\s*0\s*\?\s*coverRegionHeight\s*:\s*Infinity/, 'Pic 侧的区间应用'],
    [/Math\.max\(1, Math\.min\(MAX_WINDOW_ROWS, Math\.floor\(limit \/ worstRowHeight\)\)\)/, 'MiniLyric 的 fitRows 档位公式'],
  ]
  for (const [re, what] of anchors) {
    if (!re.test(src.verticalNew) && !re.test(src.verticalPic) && !re.test(src.mini)) {
      throw new Error(`反例锚点未命中（${what}）：源码已变，反例需同步`)
    }
  }
  return [
    {
      label: '① 封面区间退回旧口径（offset 扣两次 ⇒ 用户报的「100-150% 没反应」原样复现）',
      mutate: (s) => ({
        ...s,
        verticalNew: s.verticalNew.replace(
          /const\s+band\s*=\s*Math\.max\(\s*M\s*-\s*getMiniLyricRowHeight\(true\),\s*coverNaturalSize\s*\*\s*MIN_COVER_KEEP_RATIO\s*,?\s*\)/,
          'const band = Math.max(M - songInfoOffset - getMiniLyricRowHeight(true), coverNaturalSize * MIN_COVER_KEEP_RATIO)',
        ),
      }),
    },
    {
      label: '② 小歌词上限退回「再多扣一个 offset」',
      mutate: (s) => ({
        ...s,
        verticalNew: s.verticalNew.replace(
          /Math\.max\(\s*0,\s*M\s*-\s*getCoverSize\(winWidth,\s*winHeight,\s*statusBarHeight,\s*coverSize,\s*band\)\s*,?\s*\)/,
          'Math.max(0, M - getCoverSize(winWidth, winHeight, statusBarHeight, coverSize, band) - songInfoOffset)',
        ),
      }),
    },
    {
      label: '③ Pic 侧把区间又砍一半（R/2 老口径复活）',
      mutate: (s) => ({ ...s, verticalPic: s.verticalPic.replace('coverRegionHeight > 0 ? coverRegionHeight : Infinity', 'coverRegionHeight > 0 ? coverRegionHeight / 2 : Infinity') }),
    },
    {
      label: '④ Pic 侧忽略区间（算了也没用）',
      mutate: (s) => ({ ...s, verticalPic: s.verticalPic.replace('coverRegionHeight > 0 ? coverRegionHeight : Infinity', 'Infinity') }),
    },
    {
      label: '⑤ 首帧不再做解析估算（内容高直接吃实测 0 ⇒ 首帧按无上限渲染）',
      mutate: (s) => ({ ...s, verticalNew: s.verticalNew.replace('const songInfoContent = measured ? songInfoContentHeight : estimateSongInfoContentHeight()', 'const songInfoContent = songInfoContentHeight') }),
    },
    {
      label: '⑥ 档位分母改回基础行高（按非最坏行定档 ⇒ 本脚本的 rowH 模型与实现脱钩）',
      mutate: (s) => ({ ...s, mini: s.mini.replace('Math.floor(limit / worstRowHeight)', 'Math.floor(limit / baseRowHeight)') }),
    },
  ]
}

// ---------------------------------------------------------------------------
// B 段：代数扫描
// ---------------------------------------------------------------------------
const KEEP = Number((/const\s+MIN_COVER_KEEP_RATIO\s*=\s*([\d.]+)/.exec(stripComments(REAL.verticalNew)) ?? [])[1])
const MAX_ROWS = Number((/const\s+MAX_WINDOW_ROWS\s*=\s*(\d+)/.exec(stripComments(REAL.mini)) ?? [])[1])
const CP = 10 // containerPaddingH = scaleSizeW(10)，基准机型上就是 10
const EPS = 1e-6

// 现行算式（与 A2/A3 逐项对应；A 段保证源码就是这个形状）
const bandNew = (M, rowH, dia) => Math.max(M - rowH, KEEP * dia)
const sizeNew = (M, rowH, dia) => Math.min(dia, bandNew(M, rowH, dia))
const lyricMaxNew = (M, rowH, dia) => Math.max(0, M - sizeNew(M, rowH, dia))

// 旧算式（第 19 轮之前，A5 钉住它不许被写回）：
//   available = M − offset；封面尺寸还被 Pic 里独立的 R/2 再砍一刀；
//   小歌词上限按 min(自然, cap) 留白后**又多扣一个 offset**。
const capOld = (M, o, rowH, dia) => Math.max(M - o - o - rowH, KEEP * dia)
const sizeOld = (M, o, rowH, dia, R2) => Math.min(dia, R2, capOld(M, o, rowH, dia))
const lyricMaxOld = (M, o, rowH, dia) => Math.max(0, (M - o) - Math.min(dia, capOld(M, o, rowH, dia)) - o)

// MiniLyric 的档位（A7 钉住同形）：至少一行、至多 MAX_WINDOW_ROWS 行。
// 分母是**最坏行高** worstRowHeight，所以传进来的 rowH 必须是含翻译槽的那一行高。
const rowsOf = (limit, rowH) => Math.max(1, Math.min(MAX_ROWS, Math.floor(limit / rowH + EPS)))
const lyricHeight = (limit, rowH) => rowsOf(limit, rowH) * rowH

// 几何（见文件头推导）：H = M − o − 小歌词实际高；封面顶端 = (H + o − d)/2；
// 顶端不越过返回栏 ⟺ clearance ≥ 0（clearance 以返回栏底边为零点，容器还有 CP 的 padding）。
const clearanceOf = (M, o, rowH, limit, d) => {
  const L = lyricHeight(limit, rowH)
  const H = M - o - L
  return (H + o - d) / 2 + CP
}
const clearanceNew = (M, o, rowH, dia) => clearanceOf(M, o, rowH, lyricMaxNew(M, rowH, dia), sizeNew(M, rowH, dia))
const clearanceOld = (M, o, rowH, dia, R2) => clearanceOf(M, o, rowH, lyricMaxOld(M, o, rowH, dia), sizeOld(M, o, rowH, dia, R2))

function sweep() {
  const rows = []
  // 参数域（估计区间，不是实测）：
  //   M   封面+小歌词可用的竖直空间（= R − 2×padding − paddingBottom − 信息块内容高 − 下 margin）：
  //       小屏 SE ≈ 250 上下，大屏 ≈ 400 上下
  //   o   SongInfo 的 marginTop（= Pic 容器的 paddingTop）：小屏 inline 8 / 大屏 20，随字号最多 ×1.3
  //   rowH 一行小歌词高：fontSize 1.0 单行 ≈ 26、带翻译 ≈ 48；fontSize 1.3 带翻译 ≈ 63~80
  //   R2  R/2 = 旧口径的封面尺寸上限（R 是封面页容器实测高）：SE ≈ 192、用户机型 ≈ 255~294
  //   dia 自然封面直径（0.5/0.75/1.0/1.3/1.5 × min(0.65 屏宽, 0.5 可用高) 的展开）
  for (let M = 150; M <= 600; M += 1) {
    for (const o of [0, 8, 12, 20, 27]) {
      for (const rowH of [22, 26, 48, 63.4, 80]) {
        for (const R2 of [150, 192, 255.5, 288, 450]) {
          for (const ratio of [1.5, 1.3, 1, 0.75, 0.5]) {
            const dia = R2 * ratio
            rows.push({
              M, o, rowH, R2, dia,
              floorBound: M - rowH < KEEP * dia,
              new_: clearanceNew(M, o, rowH, dia),
              old_: clearanceOld(M, o, rowH, dia, R2),
            })
          }
        }
      }
    }
  }
  return rows
}

const stats = sweep()
// C1 地板不绑定 ⇒ 必然不越界，且余量 ≥ 容器自己的 padding（CP）
const unbound = stats.filter((r) => !r.floorBound)
const c1 = unbound.every((r) => r.new_ >= CP - EPS)
// 用 reduce 而不是 Math.min(...arr)：扫描点有十万量级，展开成实参会爆栈
//（实参上限受引擎调用栈约束，与数组长度无关）。
const c1Worst = unbound.reduce((m, r) => (r.new_ < m ? r.new_ : m), Infinity)
// C2 地板生效时的残余越界上界：clearance ≥ (M − rowH − d)/2 + CP（模型恒等式，d = min(dia, KEEP×dia) ≤ dia）
const c2 = stats.filter((r) => r.floorBound).every((r) => {
  const d = Math.min(r.dia, KEEP * r.dia)
  return r.new_ >= (r.M - r.rowH - d) / 2 + CP - EPS
})
const boundWorst = stats.filter((r) => r.floorBound).reduce((m, r) => Math.min(m, r.new_), 0)
// C3 残余越界只可能来自地板（不是算式漏洞）：clearance < 0 ⇒ 地板生效
const c3 = stats.every((r) => !(r.new_ < -EPS) || r.floorBound)
// C4a 旧口径确实越界（守卫不空转）。注意**不能**断言「新口径越界点更少」：
//     新口径的越界点全部落在地板档（C3），而地板档上新旧封面直径完全相同（C4a2），
//     差的只是小歌词预留多了 2×offset ⇒ 那一档上新的越界量与旧的同量级甚至略多。
//     这是「不越区的正常机型把封面放大」的必然代价（用户要的正是这个），由 C2 钉住上界。
const oldBad = stats.filter((r) => r.old_ < -EPS).length
const newBad = stats.filter((r) => r.new_ < -EPS).length
// C4a2 地板档上新旧封面直径完全相同（都 = 0.4×自然直径）：修的不是「封面大小」，是预留。
const c4a2 = stats.filter((r) => r.floorBound)
  .every((r) => Math.abs(sizeNew(r.M, r.rowH, r.dia) - sizeOld(r.M, r.o, r.rowH, r.dia, r.R2)) < EPS)
// C5a 非地板点（正常机型）上，新封面直径**从不小于**旧口径 —— 即这次调整对任何一台
//     「旧口径本来就不越界」的机型都只会变大，不会变小（滑块只涨不跌）。
const c5a = unbound.every((r) => sizeNew(r.M, r.rowH, r.dia) >= sizeOld(r.M, r.o, r.rowH, r.dia, r.R2) - EPS)
// C4b 「小歌词可用高度恰好增加 2×offset」：在两侧都没被上限/地板夹到的点上，是精确恒等式。
//     这条直接对应用户报的「小歌词部分区域还可以上下扩大一点」。
const twoO = stats.filter((r) => !r.floorBound && r.dia <= capOld(r.M, r.o, r.rowH, r.dia) && r.dia <= r.R2)
const c4b = twoO.every((r) => Math.abs(lyricMaxNew(r.M, r.rowH, r.dia) - lyricMaxOld(r.M, r.o, r.rowH, r.dia) - 2 * r.o) < EPS)
// C4c 滑块上段必须真的起作用：旧封面尺寸在 100%→150% 恒定（R/2 夹住），新的是斜坡。
//     用「旧口径在 100% 与 150% 两档尺寸相等」的点计数 —— 这些点正是用户说的「100-150% 没有反应」。
const sliderDead = stats.filter((r) => {
  const d100 = sizeOld(r.M, r.o, r.rowH, r.R2, r.R2)
  const d150 = sizeOld(r.M, r.o, r.rowH, r.R2 * 1.5, r.R2)
  return Math.abs(d150 - d100) < EPS
})
const c4c = sliderDead.length > 0 // 旧口径确实成片失效（供报告计数）
// 新口径在这些点上必须**要么恢复斜坡、要么已经顶到物理上限**（M − 一行高，再往上就越区），
// 不允许出现「离上限还有余量却不动」的第三种情况 —— 那才是用户报的「没有反应」。
const sliderAliveNew = sliderDead.filter((r) => {
  const d100 = sizeNew(r.M, r.rowH, r.R2)
  const d150 = sizeNew(r.M, r.rowH, r.R2 * 1.5)
  return d150 > d100 + EPS || d150 >= r.M - r.rowH - EPS
})

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

add('B 代数扫描', `C1 地板不绑定时必然不越界（${unbound.length} 个点，最差 clearance=${c1Worst.toFixed(2)}pt ≥ 容器 padding ${CP}pt）`, c1)
add('B 代数扫描', 'C2 地板生效时残余越界 ≥ (M − 一行高 − 直径)÷2 + padding（模型下界，恒等）', c2)
add('B 代数扫描', 'C3 残余越界只来自地板（clearance < 0 ⇒ 地板生效，不是算式漏洞）', c3)
add('B 代数扫描', `C4a 旧口径确实越界（${oldBad} 点，证明守卫不空转）；新口径越界 ${newBad} 点、全部在地板档（见 C2/C3）`, oldBad > 0)
add('B 代数扫描', `C4a2 地板档上新旧封面直径完全相同（${stats.filter((r) => r.floorBound).length} 个点，差的只是小歌词预留）`, c4a2)
add('B 代数扫描', `C5a 非地板点上新封面直径从不小于旧口径（${unbound.length} 点，滑块只涨不跌）`, c5a)
add('B 代数扫描',
  `C4b 小歌词可用高度恰好增加 2×offset（${twoO.length} 个两侧都没夹住的点，恒等）`,
  c4b, '对应用户报的「小歌词区域还可以上下扩大一点」')
add('B 代数扫描',
  `C4c 旧口径在 ${sliderDead.length} 个点上「100% 与 150% 尺寸完全相同」（滑块整段失效），这些点新口径 ${sliderAliveNew.length}/${sliderDead.length} 全部恢复斜坡或已顶到物理上限`,
  c4c && sliderAliveNew.length === sliderDead.length,
  '对应用户报的「100-150% 调节没有反应」；物理上限 = M − 一行高，顶到它就是真的不能再大（再大就越区）')

// 报表明细（帮助后续调参时看清边界）
console.log('竖屏封面页布局约束契约（sim-cover-layout-constraint）')
console.log(`参数：KEEP=${KEEP}（源码）· MAX_WINDOW_ROWS=${MAX_ROWS}（MiniLyric 源码）· 扫描点 ${stats.length}`)
console.log('')
console.log('用户机型（440×956：R≈511、M≈365、o=20、rowH=48（带翻译）、自然直径 286=R2×1.12）')
console.log('  档位    旧封面直径   新封面直径   旧小歌词可用   新小歌词可用')
const UM = { M: 365, o: 20, rowH: 48, R2: 255.5 }
for (const ratio of [0.5, 0.75, 1.0, 1.1, 1.2, 1.5]) {
  const dia = 286 * ratio
  const dOld = sizeOld(UM.M, UM.o, UM.rowH, dia, UM.R2)
  const dNew = sizeNew(UM.M, UM.rowH, dia)
  const lOld = lyricMaxOld(UM.M, UM.o, UM.rowH, dia)
  const lNew = lyricMaxNew(UM.M, UM.rowH, dia)
  console.log(
    `  ${String(Math.round(ratio * 100) + '%').padEnd(6)} ${dOld.toFixed(1).padStart(10)}pt ${dNew.toFixed(1).padStart(12)}pt ${lOld.toFixed(1).padStart(13)}pt ${lNew.toFixed(1).padStart(13)}pt`,
  )
}
console.log('  （旧口径约 89% 起就顶到 R/2=255.5pt 不再变化 ⇒ 用户报「100-150% 没有反应」；')
console.log('    新口径 100%(286pt) 起逐档上升、约 111% 触到 M − 一行高 = 317pt 才封顶，且两端各留 10pt 不越区）')
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
