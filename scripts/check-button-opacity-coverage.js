/**
 * 「按钮透明度」(theme.buttonOpacity) 覆盖面回归。
 *
 * 用户原话：
 *   「例如推荐中，酷我音乐、酷狗音乐、企鹅音乐、每日推荐、歌单内的最新最热以及默认和
 *     下面内容等类似按钮部位，它的底面透明度不会因为设置中的按钮透明度来改变，
 *     这些按钮有很多，请恢复」
 *   「主题设置中 TAB 栏距离、按钮透明度、背景模糊度、背景图片不透明度的进度条背景
 *     透明度，需要通过按钮透明度来控制（目前不受影响）」
 *
 * 需求口径：0-100，100 = 不透明（默认），0 = 底面/边框全透明**只剩文字**。
 * 实现口径：只能改颜色自身的 alpha（applyOpacity(颜色, buttonOpacity)），
 *           **不能**用容器 style.opacity —— 那会把文字一起淡掉，与需求相反。
 *
 * 本脚本钉死四条不变量：
 *   A. 纯按钮令牌 c-button-background / -active / -selected **不允许**再被当作
 *      底色/边框色直接使用（必须走 applyOpacity）——这是「按钮透明度漏接」的机器可判定形式。
 *   B. 用了 applyOpacity / useSettingValue('theme.buttonOpacity') 的文件必须真的 import，
 *      且必须声明过 const buttonOpacity = useSettingValue('theme.buttonOpacity')。
 *   C. 用户点名的表面（推荐平台胶囊、每日推荐卡、歌单最新最热/默认标签、歌单详情三键、
 *      详情页操作栏、四个主题滑条）必须仍在接线状态。
 *   D. 反例自检：把任一接线拆掉，本脚本必须判不合格（防止脚本自己退化成永真）。
 *
 * 运行：node scripts/check-button-opacity-coverage.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// ---------------------------------------------------------------------------
// 扫描 src/ 下所有 ts/tsx/js
// ---------------------------------------------------------------------------
// 注意：本仓脚本跑在 Electron-as-node 迷你运行器里，readdirSync 不支持 withFileTypes，
// 一律用 readdirSync + statSync 判断目录。
const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(full)
  }
  return out
}

/**
 * 去掉注释但**保留行号**（块注释整段替换为同数量空白的换行），
 * 否则「文档注释里写的 applyOpacity(color, 100)」会被误判成写死常量。
 */
const stripComments = (t) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')

const SRC = path.join(ROOT, 'src')
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
const FILES = walk(SRC).map((f) => ({ path: rel(f), text: fs.readFileSync(f, 'utf8') }))
const byPath = {}
for (const f of FILES) byPath[f.path] = f.text

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

// A. 纯按钮令牌被直接当底色/边框色。
//    判定按「行」：去注释后只要某行出现 theme['c-button-background...'] 的**值引用**，
//    该行（或紧邻前后两行，容忍 applyOpacity( 换行书写）就必须出现 applyOpacity。
//    为什么按行而不是按 `xxx: theme[...]`：
//      三元分支 `backgroundColor: cond ? theme['c-button-background-active'] : theme['c-button-background']`
//      在 `backgroundColor:` 后面跟的是条件表达式，属性名正则抓不到 —— 正是 MusicAddModal /
//      MusicMultiAddModal 里 7 颗「歌单类型切换」按钮漏接的形态（第 3 批才发现）。
//    不会误报的地方：主题定义表 `'c-button-background': theme[...]` 是「键」不是值引用；
//    `Object.keys(theme).includes('c-button-background')` 是字符串字面量。
const RAW_BUTTON_TOKEN_LINE = /theme\['c-button-background(-active|-selected|-hover)?'\]/

const checkRawButtonTokens = (files) => {
  const hits = []
  for (const f of files) {
    const lines = stripComments(f.text).split('\n')
    lines.forEach((line, i) => {
      if (!RAW_BUTTON_TOKEN_LINE.test(line)) return
      const around = [lines[i - 2], lines[i - 1], line, lines[i + 1], lines[i + 2]].join(' ')
      if (/applyOpacity\s*\(/.test(around)) return
      hits.push(`${f.path}:${i + 1}  ${line.trim().slice(0, 120)}`)
    })
  }
  return hits
}

// B. import / 声明完整性
const checkImports = (files) => {
  const hits = []
  for (const f of files) {
    const code = stripComments(f.text)
    const usesApply = /applyOpacity\s*\(/.test(code)
    const hasApplyImport = /import\s*\{[^}]*\bapplyOpacity\b[^}]*\}\s*from\s*'@\/utils\/colorOpacity'/.test(code)
    if (usesApply && !hasApplyImport) hits.push(`${f.path} 用了 applyOpacity 但没有 import { applyOpacity } from '@/utils/colorOpacity'`)

    const hasHookImport = /import\s*\{[^}]*\buseSettingValue\b[^}]*\}\s*from\s*'@\/store\/setting\/hook'/.test(code)
    const declares = /const\s+buttonOpacity\s*=\s*useSettingValue\(\s*'theme\.buttonOpacity'\s*\)/.test(code)
    // 只要用到 buttonOpacity 这个变量，就必须来自设置 hook（防「声明被改成常量 100」「在回调里用变量」）。
    // 先剔掉设置键字符串 'theme.buttonOpacity' —— 配置表 / 类型联合里出现的是键名，不是变量。
    const codeNoKey = code.replace(/['"]theme\.buttonOpacity['"]/g, '')
    if (/\bbuttonOpacity\b/.test(codeNoKey) && !declares) {
      hits.push(`${f.path} 用了 buttonOpacity 但没有 const buttonOpacity = useSettingValue('theme.buttonOpacity')（写死常量？或在回调里？）`)
    }
    if (/useSettingValue\(\s*'theme\.buttonOpacity'\s*\)/.test(code) && !hasHookImport) {
      hits.push(`${f.path} 用了 useSettingValue('theme.buttonOpacity') 但没有 import { useSettingValue } from '@/store/setting/hook'`)
    }

    // 反向：applyOpacity 第二个参数必须是 buttonOpacity 之类的透明度变量，不能是常量 100
    const applied = code.match(/applyOpacity\([^)]*,\s*([^)]*?)\)/g) || []
    for (const call of applied) {
      if (/,\s*\d+\s*\)\s*$/.test(call)) hits.push(`${f.path} applyOpacity 第二参写死为常量（不会随设置变化）：${call.slice(0, 100)}`)
    }
  }
  return hits
}

// C. 用户点名表面仍在接线
const REQUIRED = [
  ['src/components/home/PlatformChips.tsx', '推荐页平台胶囊（酷我/酷狗/企鹅）'],
  ['src/components/home/DailyRecommendCard.tsx', '每日推荐卡'],
  ['src/screens/Home/Views/SongList/HeaderBar/SortTab.tsx', '歌单「最新/最热/默认」排序'],
  ['src/screens/Home/Views/SongList/HeaderBar/TagRows.tsx', '歌单标签行'],
  ['src/screens/SonglistDetail/ActionBar.tsx', '歌单详情「播放全部/收藏歌单/返回」'],
  ['src/components/DetailActionBar.tsx', '详情页操作栏「播放全部/返回」'],
  ['src/screens/Home/Views/Setting/components/Slider.tsx', '主题设置四个滑条的轨道'],
  ['src/components/common/ButtonPrimary.tsx', '通用主按钮'],
  ['src/components/common/ConfirmAlert.tsx', '通用确认框'],
  ['src/components/MusicAddModal/MusicAddModal.tsx', '添加歌曲弹窗「本地/网易/QQ/酷狗歌单」四颗切换按钮'],
  ['src/components/MusicMultiAddModal/MusicMultiAddModal.tsx', '批量添加弹窗「本地/网易/QQ歌单」三颗切换按钮'],
  ['src/components/MusicAddModal/List.tsx', '「新建歌单」虚线按钮'],
  ['src/components/MusicMultiAddModal/List.tsx', '「新建歌单」虚线按钮'],
  ['src/screens/Home/Views/PlayHistory/index.tsx', '播放历史页日期栏与日期选择弹层按钮'],
]

const checkRequired = (files) => {
  const get = (p) => {
    const hit = files.find((f) => f.path === p)
    return hit && hit.text
  }
  const hits = []
  for (const [file, what] of REQUIRED) {
    const text = get(file)
    if (!text) { hits.push(`${what}：文件不存在 ${file}`); continue }
    const wired = /applyOpacity\([^)]*buttonOpacity\s*\)/.test(text) && /useSettingValue\(\s*'theme\.buttonOpacity'\s*\)/.test(text)
    if (!wired) hits.push(`${what}：${file} 未接 applyOpacity(..., buttonOpacity)`)
  }
  // 轨道这两条单独钉：底槽与填充都要跟着淡
  const slider = get('src/screens/Home/Views/Setting/components/Slider.tsx') || ''
  if (!/applyOpacity\(theme\['c-button-background'\]/.test(slider)) hits.push('四个滑条的轨道底色未随按钮透明度（Slider.tsx）')
  if (!/applyOpacity\(theme\['c-button-background-active'\]/.test(slider)) hits.push('四个滑条的已选填充未随按钮透明度（Slider.tsx）')
  // 胶囊/tab 类底色令牌同样要淡
  for (const file of ['src/components/home/PlatformChips.tsx', 'src/screens/Home/Views/SongList/HeaderBar/SortTab.tsx']) {
    const text = get(file) || ''
    if (!/applyOpacity\(/.test(text)) hits.push(`${file} 没有任何 applyOpacity 接线`)
  }
  return hits
}

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------
const assertions = []
let failed = 0

assertions.push({
  name: 'A 纯按钮令牌不再被直接当底色/边框色（必须走 applyOpacity）',
  hits: checkRawButtonTokens(FILES),
})
assertions.push({
  name: 'B applyOpacity / buttonOpacity 的 import 与声明完整',
  hits: checkImports(FILES),
})
assertions.push({
  name: 'C 用户点名的按钮表面仍在接线状态',
  hits: checkRequired(FILES),
})

// D. 反例自检
const tamperFiles = (targetPath, replace) => FILES.map((f) => (f.path === targetPath ? { ...f, text: replace(f.text) } : f))

const counterExamples = []
const CE = (name, files, fn, expectSubstr) => {
  const hits = fn(files)
  const ok = hits.some((h) => h.includes(expectSubstr))
  counterExamples.push({ name, ok, detail: hits.join('；') })
}

CE('C1 纯按钮令牌退回直接写死（通用主按钮）', tamperFiles('src/components/common/ButtonPrimary.tsx',
  (t) => t.replace(/backgroundColor: applyOpacity\(theme\['c-button-background'\], buttonOpacity\)/, "backgroundColor: theme['c-button-background']")),
checkRawButtonTokens, 'src/components/common/ButtonPrimary.tsx')

CE('C2 删掉 applyOpacity 的 import', tamperFiles('src/components/common/ConfirmAlert.tsx',
  (t) => t.replace(/^.*import\s*\{[^}]*applyOpacity[^}]*\}.*$/m, '')),
checkImports, 'ConfirmAlert.tsx 用了 applyOpacity 但没有 import')

CE('C3 buttonOpacity 常量改成写死 100', tamperFiles('src/screens/SonglistDetail/ActionBar.tsx',
  (t) => t.replace(/const buttonOpacity = useSettingValue\('theme\.buttonOpacity'\)/, 'const buttonOpacity = 100')),
checkImports, '用了 buttonOpacity 但没有 const buttonOpacity')

CE('C4 平台胶囊整段拆掉接线（文件退化为不读设置）', tamperFiles('src/components/home/PlatformChips.tsx',
  (t) => t.replace(/const buttonOpacity = useSettingValue\('theme\.buttonOpacity'\)/, 'const buttonOpacity = 100')
    .replace(/applyOpacity\(([^,]+), buttonOpacity\)/g, '$1')),
checkRequired, '推荐页平台胶囊')

CE('C5 滑条轨道去掉按钮透明度（回到需求点名的缺陷）', tamperFiles('src/screens/Home/Views/Setting/components/Slider.tsx',
  (t) => t.replace(/applyOpacity\(theme\['c-button-background'\]/, "String(theme['c-button-background'])")),
checkRequired, '轨道底色未随按钮透明度')

CE('C6 applyOpacity 第二参写死常量', tamperFiles('src/components/DetailActionBar.tsx',
  (t) => t.replace(/applyOpacity\(theme\['c-primary'\], buttonOpacity\)/, "applyOpacity(theme['c-primary'], 100)")),
checkImports, '第二参写死为常量')

// C7 对应「第三批才发现的形态」：三元分支里的按钮令牌退回裸用（属性名正则抓不到，按行判定能抓）
CE('C7 三元分支里的按钮令牌退回裸用（歌单类型切换按钮）', tamperFiles('src/components/MusicAddModal/MusicAddModal.tsx',
  (t) => t.replace(/\? applyOpacity\(theme\['c-button-background-active'\], buttonOpacity\) : applyOpacity\(theme\['c-button-background'\], buttonOpacity\)/,
    "? theme['c-button-background-active'] : theme['c-button-background']")),
checkRawButtonTokens, 'MusicAddModal.tsx')

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
console.log('='.repeat(92))
console.log('按钮透明度（theme.buttonOpacity）覆盖面回归')
console.log('='.repeat(92))
console.log('  A 纯按钮令牌必须走 applyOpacity（不能直接当底色/边框色）')
console.log('  B import / const buttonOpacity 声明完整，且第二参不是写死常量')
console.log('  C 用户点名的表面（推荐胶囊 / 每日推荐 / 最新最热 / 歌单三键 / 详情栏 / 四个滑条）仍在接线')
console.log()

console.log('='.repeat(92))
console.log('断言')
console.log('='.repeat(92))
for (const a of assertions) {
  const ok = a.hits.length === 0
  if (!ok) failed++
  console.log(`  ${ok ? '✅' : '❌'}  ${a.name}`)
  for (const h of a.hits.slice(0, 40)) console.log(`        ${h}`)
  if (a.hits.length > 40) console.log(`        ...（共 ${a.hits.length} 处）`)
}

console.log()
console.log('='.repeat(92))
console.log('反例自检（接线被拆掉时必须拦下）')
console.log('='.repeat(92))
for (const c of counterExamples) {
  if (!c.ok) failed++
  console.log(`  ${c.ok ? '✅' : '❌'}  ${c.name}${c.ok ? ' —— 已拦下' : '   ← 没拦住：' + c.detail}`)
}

const okCount = assertions.filter((a) => a.hits.length === 0).length
const ceOk = counterExamples.filter((c) => c.ok).length
console.log()
console.log(`结果：断言 ${okCount}/${assertions.length} 通过；反例 ${ceOk}/${counterExamples.length} 拦下`)
process.exit(failed ? 1 : 0)
