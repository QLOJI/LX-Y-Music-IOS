/**
 * 「按钮圆角」(theme.buttonRadius) 接线覆盖面回归。
 *
 * 生效链路：theme.buttonRadius 是设置项（0 = 直角，100 = 半圆），useButtonRadius()
 * 订阅它并返回「按钮设计高度 → 半径」的换算函数。由于 createStyle 的样式在模块加载时
 * 固化，调用点必须再以**行内** style 覆盖 borderRadius 才能吃到设置：
 *
 *   const buttonRadius = useButtonRadius()                       // 订阅
 *   <View style={[styles.x, { borderRadius: buttonRadius(44) }]} // 行内覆盖(44 = 设计高度)
 *
 * 所以「设置里的按钮圆角能不能改到这个按钮」等价于「它所在文件有没有这套接线」。
 * 本脚本把这个要求变成可判定的不变量。
 *
 * 与同目录其它脚本的分工（本脚本不重复它们钉过的东西）：
 *   - sim-radius-tokens.js              钉设计令牌值（designRadius 4/4/8/12）与封面静态兜底值；
 *   - check-button-opacity-coverage.js  钉 theme.buttonOpacity 的接线面；
 *   - 本脚本                            只钉「按钮圆角的接线面」：import / 调用形态 / 行内覆盖 / 传参。
 *     C 段的 buttonRadius(70) 这类钉子是「接线传参」，不是 sim-radius-tokens.js 里的静态值。
 *
 * 四条不变量：
 *   A. 每个使用按钮底色令牌 c-button-background / -active / -selected 的 .tsx 文件，
 *      必须在本文件内接好 useButtonRadius（import + 调用 + 行内覆盖）。文件清单由扫描
 *      动态得出并逐个打印——新文件漏接、清单漂移都会被拦下。
 *      口径从严：令牌出现即视为「按钮族表面」；唯一的免检出口是 TOKEN_EXEMPT 里**具名**
 *      列出的文件（其令牌经复核不属本文件可控的按钮外观，理由写进名单并在代码里留注记）。
 *      绝不放开令牌判定本身：不在名单里的文件漏接一律照拦；名单条目一旦腐化（文件已
 *      不再用令牌）也会被反查拦下，逼着同步删除过期豁免。
 *   B. 每个调用 useButtonRadius() 的文件：import 必须在场且来自 '@/utils/buttonRadius'；
 *      每处调用都必须是 `const buttonRadius = useButtonRadius()` 形态、且声明行有缩进
 *      （去缩进 = 模块顶层 = 在组件外调用 hook，机器可判定）；import 了却一次不调 = 死 import，也拦。
 *   C. 用户点名的八类面（歌单封面 / 排行榜按钮 / 酷我音乐按钮 / 搜索页的搜索框 /
 *      搜索框下面的按钮 / 热门搜索下面的容器 / 历史搜索下面的容器 / 设置中所有的按钮）
 *      对应真实文件逐个断言接线在位，并钉住各点实际传参（buttonRadius(48) 等），
 *      防止「hook 还在、行内覆盖被删/被改数值」。
 *   D. 反例自检：10 条篡改（删 import / 删调用 / 删行内覆盖 / 挪出组件 / 来源改错 / 调用改名）
 *      必须被同一套函数拦下；**替换未命中同样判失败**（防反例老化成永真）。
 *
 * ⚠️ 纯静态断言：通过只说明这些调用点的接线文本在位；本工程没有 node/tsc/Xcode 工具链，
 *    不代表能编译、不代表真机观感正确。真机观感要用眼睛看。
 *
 * 运行：node scripts/check-button-radius-coverage.js
 * 退出码：不变量全过且反例全被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')

// 注意：本仓脚本跑在浏览器迷你运行器里，readdirSync 不支持 withFileTypes，
// 一律 readdirSync + statSync 判断目录；同步代码，只用 fs/path。
const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(full)
  }
  return out
}

// 去注释（块注释替换为等量空白，保留行号；行注释去掉但保留换行）。
// CRLF 归一到 LF，方便反例做整行替换。
const stripComments = (t) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
const FILES = walk(SRC).map((f) => ({
  path: rel(f),
  text: fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'),
}))

// ---------------------------------------------------------------------------
// 判定模式
// ---------------------------------------------------------------------------
// 按钮底色令牌：c-button-background 前缀已含 -active / -selected / -hover 各变体
const BUTTON_TOKEN = /c-button-background/
// 「行内覆盖」只认 borderRadius: buttonRadius(...) 这一种写法（静态 borderRadius 是兜底，不算接线）
const INLINE_OVERRIDE = /borderRadius:\s*buttonRadius\(/
const IMPORT_HOOK = /import\s*\{[^}]*\buseButtonRadius\b[^}]*\}\s*from\s*'@\/utils\/buttonRadius'/
const HOOK_CALL = /const\s+buttonRadius\s*=\s*useButtonRadius\(\s*\)/

// 具名豁免：这些 .tsx 里的按钮令牌**经逐行复核确认不属本文件可控的按钮外观**，
// 因而本文件无需接线。豁免必须「具名到文件 + 写明理由」，绝不放开令牌判定本身：
// 不在名单里的文件漏接一律照拦（见 D 段反例），名单条目腐化（文件已不再出现令牌）
// 亦判失败，逼着同步删除过期条目 —— 否则豁免会长期掩盖一个已改名/已删令牌的文件。
const TOKEN_EXEMPT = {
  'src/components/MetadataEditModal/ParseName.tsx':
    '令牌只出现在传给 ButtonPrimary 的 style 底色里，而 ButtonPrimary 只解构 disabled/size/onPress/children、该 style 整个被丢弃（底色与圆角都由 ButtonPrimary 自身按同一令牌 + buttonRadius(28) 重算）——本文件没有任何可控的按钮外观',
  'src/screens/Home/Views/Setting/components/Slider.tsx':
    '令牌只作滑条轨道/底槽 tint；轨道不是按钮族，其圆角属容器令牌（designRadius）管辖',
}

// A. 使用按钮令牌的 .tsx 文件 → 必须接线（import + 调用 + 行内覆盖）
const checkTokenFiles = (files) => {
  const rows = []
  const hits = []
  const seenExempt = new Set()
  for (const f of files) {
    if (!/\.tsx$/.test(f.path)) continue
    const code = stripComments(f.text)
    if (!BUTTON_TOKEN.test(code)) continue
    if (TOKEN_EXEMPT[f.path]) {
      seenExempt.add(f.path)
      rows.push({ path: f.path, ok: true, exempt: true, miss: `〔具名豁免〕${TOKEN_EXEMPT[f.path]}` })
      continue
    }
    const miss = []
    if (!IMPORT_HOOK.test(code)) miss.push("缺 import { useButtonRadius } from '@/utils/buttonRadius'")
    if (!HOOK_CALL.test(code)) miss.push('缺 const buttonRadius = useButtonRadius() 调用')
    if (!INLINE_OVERRIDE.test(code)) miss.push('缺 borderRadius: buttonRadius(...) 行内覆盖')
    const ok = miss.length === 0
    rows.push({ path: f.path, ok, miss: ok ? '' : miss.join('；') })
    if (!ok) hits.push(`${f.path}  —  ${miss.join('；')}`)
  }
  // 豁免腐化反查：列入名单却已扫不到令牌 → 失败（该条目已过期，必须同步删除）
  for (const p of Object.keys(TOKEN_EXEMPT)) {
    if (!seenExempt.has(p)) {
      hits.push(`具名豁免已过期：${p} 已不再使用按钮令牌，请从 TOKEN_EXEMPT 删除该条目`)
    }
  }
  return { rows, hits, total: rows.length }
}

// B. useButtonRadius() 调用面的 import 来源 / 调用形态 / 组件内位置
const checkHookUsage = (files) => {
  const hits = []
  for (const f of files) {
    // hook 定义文件自身不参与（它的函数声明也含 useButtonRadius(）
    if (/utils\/buttonRadius\.(ts|tsx|js)$/.test(f.path)) continue
    const code = stripComments(f.text)
    const occurrences = (code.match(/\buseButtonRadius\s*\(/g) || []).length
    const hasImport = IMPORT_HOOK.test(code)
    if (!occurrences && !hasImport) continue
    if (occurrences && !hasImport) {
      hits.push(`${f.path} 调用了 useButtonRadius() 但没有 import { useButtonRadius } from '@/utils/buttonRadius'（或来源不对）`)
      continue
    }
    if (hasImport && !occurrences) {
      hits.push(`${f.path} import 了 useButtonRadius 但一次都没调用（死 import？）`)
      continue
    }
    const declLines = code.split('\n').filter((l) => HOOK_CALL.test(l))
    const indented = declLines.filter((l) => /^[ \t]+/.test(l)).length
    if (declLines.length !== occurrences) {
      hits.push(`${f.path} 有调用不是 \`const buttonRadius = useButtonRadius()\` 形态（useButtonRadius() 出现 ${occurrences} 处，合规声明仅 ${declLines.length} 处）`)
    } else if (indented !== declLines.length) {
      hits.push(`${f.path} 的 useButtonRadius() 声明行没有缩进，疑似在组件外（hook 必须写在组件/自定义 hook 函数体内）`)
    }
  }
  return hits
}

// C. 用户点名的八类面 → 真实文件清单 + 中文说明（路径全部在本仓实存，接线已在位）
const REQUIRED = [
  ['src/components/home/PlaylistCard.tsx', '歌单封面：推荐页歌单卡片的封面（按卡片自身宽度折算半高 buttonRadius(width)）'],
  ['src/screens/SonglistDetail/Header.tsx', '歌单封面：歌单详情页顶部大封面（设计边长 70）'],
  ['src/screens/SonglistDetail/index.tsx', '歌单封面：歌单详情页收拢/小尺寸封面（设计边长 104）'],
  ['src/screens/Home/Views/Discovery/index.tsx', '排行榜按钮：推荐页「排行榜」区块的榜单卡片（卡高 ≈64）与同页历史按钮（42）'],
  ['src/components/home/PlatformChips.tsx', '酷我音乐按钮：推荐页平台胶囊（酷我/酷狗/企鹅等，高 ≈34）'],
  ['src/screens/Home/Views/Search/HeaderBar/index.tsx', '搜索页的搜索框：48pt 外层容器（同文件还有搜索平台胶囊 38）'],
  ['src/screens/Home/Views/Search/HeaderBar/SearchInput.tsx', '搜索页的搜索框：内部 40pt 输入框'],
  ['src/screens/Home/Views/Search/SearchTypeSelector.tsx', '搜索框下面的按钮：歌曲/歌单/歌手/专辑类型切换（高 36）'],
  ['src/screens/Home/Views/Search/BlankView/HotSearch.tsx', '热门搜索下面的容器：热门词条胶囊（高 44）'],
  ['src/screens/Home/Views/Search/BlankView/HistorySearch.tsx', '历史搜索下面的容器：历史词条胶囊（36）/ 行内删除钮（18）/ 清空历史钮（32）'],
  ['src/screens/Home/Views/Setting/components/Button.tsx', '设置中所有的按钮：动作按钮（设计高 40）'],
  ['src/screens/Home/Views/Setting/Vertical/Main.tsx', '设置中所有的按钮：竖屏分类入口行（设计高 56）'],
  ['src/screens/Home/Views/Setting/Vertical/NavList.tsx', '设置中所有的按钮：竖屏分类 Tab（高 40）'],
  ['src/screens/Home/Views/Setting/Horizontal/NavList.tsx', '设置中所有的按钮：横屏分类导航（高 44）'],
  ['src/screens/Home/Views/Setting/components/InputItem.tsx', '设置中所有的按钮：设置项输入框（高 36）'],
]

// C 的传参钉子：钩子还在但行内覆盖被删/改数值时立刻失败
const PINNED = [
  ['src/components/home/PlaylistCard.tsx', /buttonRadius\(\s*width\s*\)/, '歌单封面按自身宽度 buttonRadius(width)'],
  ['src/screens/SonglistDetail/Header.tsx', /buttonRadius\(\s*70\s*\)/, '歌单详情顶封 buttonRadius(70)'],
  ['src/screens/SonglistDetail/index.tsx', /buttonRadius\(\s*104\s*\)/, '歌单详情收拢封面 buttonRadius(104)'],
  // 榜单卡传参随宽窄两态取不同设计高度（窄 64 / 宽 72）。钉子必须把两态一起咬住：
  // 退化成单值（无论 64 还是 72）都说明某一态的高度口径又丢了，正则故意不接受裸 64。
  ['src/screens/Home/Views/Discovery/index.tsx', /buttonRadius\(\s*wide\s*\?\s*72\s*:\s*64\s*\)/, '榜单卡片 buttonRadius(wide ? 72 : 64)'],
  ['src/components/home/PlatformChips.tsx', /buttonRadius\(\s*34\s*\)/, '平台胶囊 buttonRadius(34)'],
  ['src/screens/Home/Views/Search/HeaderBar/index.tsx', /buttonRadius\(\s*48\s*\)/, '搜索框容器 buttonRadius(48)'],
  ['src/screens/Home/Views/Search/HeaderBar/index.tsx', /buttonRadius\(\s*38\s*\)/, '搜索平台胶囊 buttonRadius(38)'],
  ['src/screens/Home/Views/Search/HeaderBar/SearchInput.tsx', /buttonRadius\(\s*40\s*\)/, '搜索输入框 buttonRadius(40)'],
  ['src/screens/Home/Views/Search/SearchTypeSelector.tsx', /buttonRadius\(\s*36\s*\)/, '类型切换按钮 buttonRadius(36)'],
  ['src/screens/Home/Views/Search/BlankView/HotSearch.tsx', /buttonRadius\(\s*44\s*\)/, '热门词条按钮 buttonRadius(44)'],
  ['src/screens/Home/Views/Search/BlankView/HistorySearch.tsx', /buttonRadius\(\s*36\s*\)/, '历史词条按钮 buttonRadius(36)'],
  ['src/screens/Home/Views/Search/BlankView/HistorySearch.tsx', /buttonRadius\(\s*18\s*\)/, '历史行内删除钮 buttonRadius(18)'],
  ['src/screens/Home/Views/Search/BlankView/HistorySearch.tsx', /buttonRadius\(\s*32\s*\)/, '清空历史按钮 buttonRadius(32)'],
  ['src/screens/Home/Views/Setting/components/Button.tsx', /buttonRadius\(\s*40\s*\)/, '动作按钮 buttonRadius(40)'],
  ['src/screens/Home/Views/Setting/Vertical/Main.tsx', /buttonRadius\(\s*56\s*\)/, '分类入口 buttonRadius(56)'],
  ['src/screens/Home/Views/Setting/Vertical/NavList.tsx', /buttonRadius\(\s*40\s*\)/, '分类 Tab buttonRadius(40)'],
  ['src/screens/Home/Views/Setting/Horizontal/NavList.tsx', /buttonRadius\(\s*44\s*\)/, '横屏导航按钮 buttonRadius(44)'],
  ['src/screens/Home/Views/Setting/components/InputItem.tsx', /buttonRadius\(\s*36\s*\)/, '设置项输入框 buttonRadius(36)'],
]

const checkRequired = (files) => {
  const hits = []
  const get = (p) => {
    const hit = files.find((f) => f.path === p)
    return hit ? hit.text : null
  }
  for (const [file, what] of REQUIRED) {
    const text = get(file)
    if (!text) {
      hits.push(`${what}：文件不存在 ${file}`)
      continue
    }
    const code = stripComments(text)
    if (!IMPORT_HOOK.test(code)) hits.push(`${what}：${file} 缺 import`)
    if (!HOOK_CALL.test(code)) hits.push(`${what}：${file} 缺 const buttonRadius = useButtonRadius()`)
    if (!INLINE_OVERRIDE.test(code)) hits.push(`${what}：${file} 缺行内 borderRadius: buttonRadius(...)`)
  }
  for (const [file, re, what] of PINNED) {
    const text = get(file)
    if (!text || !re.test(stripComments(text))) hits.push(`传参钉子未命中：${what}（${file}）`)
  }
  return hits
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------
const assertions = []
let failed = 0

const aResult = checkTokenFiles(FILES)
assertions.push({
  name: `A 按钮令牌 .tsx 文件必须接线 useButtonRadius（import + 调用 + 行内覆盖）；扫描到 ${aResult.total} 个，逐个断言`,
  hits: aResult.hits,
  rows: aResult.rows,
})
assertions.push({
  name: 'B useButtonRadius() 必须 import 自 @/utils/buttonRadius、必须为 `const buttonRadius = useButtonRadius()` 形态且在组件内',
  hits: checkHookUsage(FILES),
})
assertions.push({
  name: `C 八类点名面 REQUIRED 清单（${REQUIRED.length} 文件）+ 传参钉子（${PINNED.length} 条）`,
  hits: checkRequired(FILES),
})

// ---------------------------------------------------------------------------
// 反例自检：接线被拆掉时必须拦下；替换未命中同样算失败（防反例老化）
// ---------------------------------------------------------------------------
const tamperFiles = (targetPath, patched) =>
  FILES.map((f) => (f.path === targetPath ? { ...f, text: patched } : f))

const counterExamples = []
const CE = (name, targetPath, mutate, fn, expectSubstr) => {
  const orig = FILES.find((f) => f.path === targetPath)
  const patched = orig ? mutate(orig.text) : ''
  if (!orig || patched === orig.text) {
    counterExamples.push({ name, ok: false, detail: `替换未命中（${targetPath} 源码已变，反例需同步）` })
    return
  }
  const hits = fn(tamperFiles(targetPath, patched))
  const match = hits.find((h) => h.includes(expectSubstr))
  counterExamples.push({
    name,
    ok: !!match,
    detail: match
      ? '被拦下：' + match
      : `未被任何不变量拦下（守卫无效；本次 hits=${hits.length}，均不含 ${expectSubstr}）`,
  })
}

CE(
  'D1 删掉 import（搜索类型切换按钮）',
  'src/screens/Home/Views/Search/SearchTypeSelector.tsx',
  (t) => t.replace("import { useButtonRadius } from '@/utils/buttonRadius'\n", ''),
  checkHookUsage,
  'src/screens/Home/Views/Search/SearchTypeSelector.tsx',
)
CE(
  'D2 删掉 useButtonRadius() 调用（确认框）',
  'src/components/common/ConfirmAlert.tsx',
  (t) => t.replace(/^[ \t]*const buttonRadius = useButtonRadius\(\)[ \t]*\n/m, ''),
  checkHookUsage,
  'src/components/common/ConfirmAlert.tsx',
)
CE(
  'D3 删掉行内覆盖（歌单封面）',
  'src/components/home/PlaylistCard.tsx',
  (t) => t.replace('{ borderRadius: buttonRadius(width) },', '{ borderRadius: 4 },'),
  checkRequired,
  'src/components/home/PlaylistCard.tsx',
)
CE(
  'D4 把 useButtonRadius() 挪出组件（热门搜索）',
  'src/screens/Home/Views/Search/BlankView/HotSearch.tsx',
  (t) => t.replace(/^[ \t]+const buttonRadius = useButtonRadius\(\)$/m, 'const buttonRadius = useButtonRadius()'),
  checkHookUsage,
  'src/screens/Home/Views/Search/BlankView/HotSearch.tsx',
)
CE(
  'D5 import 来源改错（设置动作按钮）',
  'src/screens/Home/Views/Setting/components/Button.tsx',
  (t) => t.replace("from '@/utils/buttonRadius'", "from '@/utils/buttonRadiusX'"),
  checkHookUsage,
  'src/screens/Home/Views/Setting/components/Button.tsx',
)
CE(
  'D6 删掉 REQUIRED 文件的调用（搜索输入框）',
  'src/screens/Home/Views/Search/HeaderBar/SearchInput.tsx',
  (t) => t.replace(/^[ \t]*const buttonRadius = useButtonRadius\(\)[ \t]*\n/m, ''),
  checkRequired,
  'src/screens/Home/Views/Search/HeaderBar/SearchInput.tsx',
)
CE(
  'D7 令牌文件的行内覆盖删掉（通用主按钮）',
  'src/components/common/ButtonPrimary.tsx',
  (t) => t.replace('borderRadius: buttonRadius(28)', 'borderRadius: 4'),
  (files) => checkTokenFiles(files).hits,
  'src/components/common/ButtonPrimary.tsx',
)
CE(
  'D8 令牌文件删掉全部调用（公告弹窗两个组件）',
  'src/navigation/components/AnnouncementModal.tsx',
  (t) => t.replace(/^[ \t]*const buttonRadius = useButtonRadius\(\)[ \t]*\n/gm, ''),
  (files) => checkTokenFiles(files).hits,
  'src/navigation/components/AnnouncementModal.tsx',
)
CE(
  'D9 令牌文件删掉 import（添加歌曲弹窗）',
  'src/components/MusicAddModal/MusicAddModal.tsx',
  (t) => t.replace("import { useButtonRadius } from '@/utils/buttonRadius'\n", ''),
  (files) => checkTokenFiles(files).hits,
  'src/components/MusicAddModal/MusicAddModal.tsx',
)
CE(
  'D10 调用改名（同步模式弹窗）',
  'src/navigation/components/SyncModeModal.tsx',
  (t) => t.replace(/const buttonRadius = useButtonRadius\(\)/g, 'const br = useButtonRadius()'),
  checkHookUsage,
  'src/navigation/components/SyncModeModal.tsx',
)
// 宽屏榜单卡两态高度退化成单值：钉子必须咬住「宽窄高度口径丢失」，
// 否则改回裸 64 会让宽屏变体的 72 分母无声消失。
CE(
  'D11 榜单卡传参退化成单值（宽屏变体高度口径丢失）',
  'src/screens/Home/Views/Discovery/index.tsx',
  (t) => t.replace('buttonRadius(wide ? 72 : 64)', 'buttonRadius(64)'),
  checkRequired,
  '榜单卡片',
)

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
console.log('='.repeat(92))
console.log('按钮圆角（theme.buttonRadius）接线覆盖面回归')
console.log('='.repeat(92))
console.log('  A 按钮令牌文件必须接线 useButtonRadius（import + 调用 + 行内覆盖）')
console.log('  B useButtonRadius() 必须来自 @/utils/buttonRadius、形态合规、写在组件内')
console.log('  C 八类点名面（歌单封面/排行榜/酷我/搜索框/搜索框下方/热门/历史/设置按钮）逐文件断言')
console.log('  （本脚本不重复 sim-radius-tokens.js 已钉的令牌值与封面静态值，只钉「接线」）')
console.log()

console.log('='.repeat(92))
console.log('断言')
console.log('='.repeat(92))
for (const a of assertions) {
  const ok = a.hits.length === 0
  if (!ok) failed++
  console.log(`  ${ok ? '✅' : '❌'}  ${a.name}`)
  if (a.rows) {
    for (const r of a.rows) {
      console.log(`        ${r.ok ? '·' : '✗'} ${r.path}${r.miss ? '  —  ' + r.miss : ''}`)
    }
  } else {
    for (const h of a.hits.slice(0, 40)) console.log(`        ${h}`)
    if (a.hits.length > 40) console.log(`        ...（共 ${a.hits.length} 处，已截断）`)
  }
}

console.log()
console.log('='.repeat(92))
console.log('反例自检（接线被拆掉时必须拦下；替换未命中同样算失败）')
console.log('='.repeat(92))
for (const c of counterExamples) {
  if (!c.ok) failed++
  console.log(`  ${c.ok ? '✅' : '❌'}  ${c.name}　← ${c.detail}`)
}

const aOk = assertions.filter((a) => a.hits.length === 0).length
const ceOk = counterExamples.filter((c) => c.ok).length
console.log()
console.log(`结果：断言 ${aOk}/${assertions.length} 通过；反例 ${ceOk}/${counterExamples.length} 拦下`)

process.exit(failed ? 1 : 0)
