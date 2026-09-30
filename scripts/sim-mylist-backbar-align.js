/**
 * 需求8 契约：「我的」列表进入详情后
 *
 *   A) 返回栏固定在上方（不随歌曲列表滚动）；
 *   B) 返回栏位置参数对齐「设置 → 基本设置」的返回按钮；
 *   C) 点击搜索后搜索框落在返回栏的同一槽位、且不做位移（无 translateY）；
 *   D) 点击取消后回到原列表界面（隐藏搜索栏/搜索结果、恢复返回栏）。
 *
 * 脚本从源码解析实际取值（不硬编码数字），复算「基本设置返回按钮」与「我的详情
 * 返回栏」两处的顶边 / 垂直中心 / 图标 glyph 左缘并比对；同时断言结构事实：
 * 三根横条共用同一个不滚动槽位、<List> 不再带 header（栏不在滚动内容里）、
 * 搜索栏/多选栏只有淡入淡出、取消路径恢复返回栏。
 *
 * 参照物（用户指定的对齐基准）——src/screens/SettingDetail/index.tsx：
 *   header 的 `paddingTop: statusBarHeight + designSpacing.sm`（内联，不缩放）
 *   + 返回按钮 44x44 + chevron-left size=20（createStyle 内，随字号缩放）。
 * 目标——src/screens/Home/Views/Mylist/MusicList/：
 *   index.tsx 的 fixedBar/barSlot 槽位、ActiveList.tsx 的行高与图标、
 *   ListSearchBar.tsx 的绝对铺满与取消按钮。
 *
 * 运行：node scripts/sim-mylist-backbar-align.js
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

// 结构断言必须在「去掉注释」的源码上做：这些文件的注释里会提到
// translateY / PageTopInset / ListHeaderComponent 等被移除的旧写法，
// 否则脚本会把「解释为什么删掉了它」的注释误判成「还在用」。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

// --- designSpacing tokens（只取 designSpacing 块，避免撞上 designRadius 的同名键）---
const tokensSrc = read('src/theme/DesignTokens.ts')
const spacingBlock = /designSpacing = \{([^}]*)\}/.exec(tokensSrc)
if (!spacingBlock) throw new Error('DesignTokens.ts 里找不到 designSpacing 块')
const tokens = {}
for (const m of spacingBlock[1].matchAll(/(\w+):\s*(\d+)/g)) tokens[m[1]] = Number(m[2])

/** 取某个 createStyle 样式块源码 */
const styleBlock = (src, name) => {
  const m = new RegExp(`${name}:\\s*\\{([^}]*)\\}`).exec(src)
  return m ? m[1] : null
}
/** 取样式块里的 `key: 数字` */
const numIn = (block, key) => {
  if (!block) return null
  const m = new RegExp(`${key}:\\s*(\\d+)`).exec(block)
  return m ? Number(m[1]) : null
}
/** 取样式块里的 `key: designSpacing.token` */
const tokenIn = (block, key) => {
  if (!block) return null
  const m = new RegExp(`${key}:\\s*designSpacing\\.(\\w+)`).exec(block)
  return m ? { token: m[1], value: tokens[m[1]] } : null
}

// ============================ 参照物：基本设置 ============================
const settingSrc = read('src/screens/SettingDetail/index.tsx')

const refHeaderBlock = styleBlock(settingSrc, 'header')
const refBtnBlock = styleBlock(settingSrc, 'backButton')
const refPadH = tokenIn(refHeaderBlock, 'paddingHorizontal')
const refPadB = tokenIn(refHeaderBlock, 'paddingBottom')
const refBtnW = numIn(refBtnBlock, 'width')
const refBtnH = numIn(refBtnBlock, 'height')

// header 的顶边公式（内联，写在 JSX 上）
const refPadTopMatch = /paddingTop:\s*statusBarHeight\s*\+\s*designSpacing\.(\w+)/.exec(settingSrc)
const refPadTop = refPadTopMatch ? { token: refPadTopMatch[1], value: tokens[refPadTopMatch[1]] } : null
const refIconSize = (/<Icon\s+name="chevron-left"\s+size=\{(\d+)\}/.exec(settingSrc) || [])[1]
const refUsesStatusbarHook = /useStatusbarHeight[^}]*\}\s*from\s*'@\/store\/common\/hook'/.test(settingSrc)

// ============================ 目标：我的详情 ============================
const MYLIST_DIR = 'src/screens/Home/Views/Mylist/MusicList/'
const listSrc = read(MYLIST_DIR + 'index.tsx')
const activeSrc = read(MYLIST_DIR + 'ActiveList.tsx')
const searchSrc = read(MYLIST_DIR + 'ListSearchBar.tsx')
const multiSrc = read(MYLIST_DIR + 'MultipleModeBar.tsx')
const listCode = stripComments(listSrc)
const activeCode = stripComments(activeSrc)
const searchCode = stripComments(searchSrc)
const multiCode = stripComments(multiSrc)

// --- index.tsx：固定槽位 ---
const alignConstMatch = /BAR_SLOT_ALIGN_PADDING_TOP\s*=\s*designSpacing\.(\w+)/.exec(listCode)
const alignConst = alignConstMatch ? { token: alignConstMatch[1], value: tokens[alignConstMatch[1]] } : null
const barPadTopMatch = /paddingTop:\s*statusBarHeight\s*\+\s*BAR_SLOT_ALIGN_PADDING_TOP/.exec(listCode)
const myUsesStatusbarHook = /useStatusbarHeight[^}]*\}\s*from\s*'@\/store\/common\/hook'/.test(listCode)
// 顶边必须内联：createStyle 会按字号缩放 paddingTop，与基本设置的内联写法不一致
const fixedBarBlock = styleBlock(listCode, 'fixedBar')
const barSlotBlock = styleBlock(listCode, 'barSlot')
const myPadH = tokenIn(fixedBarBlock, 'paddingHorizontal')
const myPadB = tokenIn(fixedBarBlock, 'paddingBottom')

// 结构：槽位在列表区之前；三条栏按 ActiveList → MultipleModeBar → ListSearchBar 都落在槽位里
const iFixedBar = listCode.indexOf('styles.fixedBar')
const iActiveBar = listCode.indexOf('ref={activeListRef}')
const iMultiBar = listCode.indexOf('ref={multipleModeBarRef}')
const iSearchBar = listCode.indexOf('ref={listSearchBarRef}')
const iListArea = listCode.indexOf('onLayout={onLayout}')

// 返回栏不再作为 FlatList 的 header（否则随列表滚动、且顶边由 PageTopInset 决定）
const listTag = /<List\b[\s\S]*?\/>/.exec(listCode)
const listHasHeaderProp = !!listTag && /\bheader=/.test(listTag[0])

// --- ActiveList.tsx：返回栏行高 / 图标 ---
const currentListBlock = styleBlock(activeCode, 'currentList')
const iconBlock = styleBlock(activeCode, 'currentListIcon')
const myBarH = numIn(currentListBlock, 'height')
const myIconPadLeft = numIn(iconBlock, 'paddingLeft')
const myIconSizeB = (/size=\{onBack \? (\d+) : \d+\}/.exec(activeCode) || [])[1]
const myIconNameExpr = /name=\{onBack \? 'chevron-left' : 'chevron-right'\}/.test(activeCode)

// --- ListSearchBar.tsx / MultipleModeBar.tsx：同槽位 + 只淡入淡出 ---
const searchContainer = styleBlock(searchCode, 'container')
const multiContainer = styleBlock(multiCode, 'container')
const absFill = (block) => !!block &&
  /position:\s*'absolute'/.test(block) && /top:\s*0/.test(block) && /height:\s*'100%'/.test(block)
const searchHasTranslate = /translateY/.test(searchCode)
const multiHasTranslate = /translateY/.test(multiCode)
const cancelWired = /<TouchableOpacity\s+onPress=\{onExitSearch\}/.test(searchCode)

// --- index.tsx：取消后恢复原列表 ---
const exitBody = (/const handleExitSearch = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\)/.exec(listCode) || [])[1] || ''
const exitHidesSearch = /listSearchBarRef\.current\?\.hide\(\)/.test(exitBody)
const exitRestoresBar = /activeListRef\.current\?\.setVisibleBar\(true\)/.test(exitBody)

// ============================ 数值复算 ============================
// 样例机身：原生状态栏 59pt（iPhone 15/16 Pro 类），useStatusbarHeight 内部已含 +6
const RAW_SB = 59
const S = RAW_SB + 6

const refTop = refPadTop ? S + refPadTop.value : NaN
const refCenter = refTop + (refBtnH || 0) / 2
const refGlyphLeft = (refPadH ? refPadH.value : NaN) + ((refBtnW || 0) - Number(refIconSize)) / 2

const myTop = alignConst ? S + alignConst.value : NaN
const myCenter = myTop + (myBarH || 0) / 2
const myGlyphLeft = (myPadH ? myPadH.value : NaN) + (myIconPadLeft || 0)

console.log('='.repeat(96))
console.log('需求8 契约：「我的」详情返回栏 ↔「设置 → 基本设置」返回按钮 对齐模型（摘自源码，单位 pt）')
console.log('='.repeat(96))
console.log(`  DesignTokens: ${Object.entries(tokens).map(([k, v]) => `${k}=${v}`).join(' ')}`)
console.log(`  样例机身原生状态栏 ${RAW_SB}pt → useStatusbarHeight() = ${S}pt（内部已含 +6，两处都不得再加）`)
console.log()
console.log(`  基本设置 返回按钮：顶边 = ${S} + ${refPadTop && refPadTop.value} = ${refTop}   高 ${refBtnH}   中心 y=${refCenter}   图标 glyph 左缘 = ${refPadH && refPadH.value} + (${refBtnW}-${refIconSize})/2 = ${refGlyphLeft}`)
console.log(`  我的详情 返回栏  ：顶边 = ${S} + ${alignConst && alignConst.value} = ${myTop}   高 ${myBarH}   中心 y=${myCenter}   图标 glyph 左缘 = ${myPadH && myPadH.value} + ${myIconPadLeft} = ${myGlyphLeft}`)
console.log()
console.log(`  槽位下缘间隙（fixedBar.paddingBottom）= ${myPadB && myPadB.value}（基本设置 header.paddingBottom = ${refPadB && refPadB.value}，同源）`)
console.log()

console.log('='.repeat(96))
console.log('断言')
console.log('='.repeat(96))

// —— 参照物解析成功 ——
check('基本设置 header.paddingTop 内联公式解析成功（statusBarHeight + designSpacing.*）', !!refPadTop,
  refPadTop ? `${refPadTop.token}=${refPadTop.value}` : '未匹配')
check('基本设置返回按钮 44x44 解析成功', refBtnW === 44 && refBtnH === 44, `w=${refBtnW} h=${refBtnH}`)
check('基本设置返回按钮图标 chevron-left size=20', Number(refIconSize) === 20, `size=${refIconSize}`)
check('基本设置使用 useStatusbarHeight（顶边含全局 +6 偏移）', refUsesStatusbarHook, '')

// —— A) 返回栏固定在上方 ——
check('固定槽位在歌曲列表区之前（不随 FlatList 滚动）', iFixedBar > -1 && iListArea > -1 && iFixedBar < iListArea,
  `fixedBar@${iFixedBar} listArea@${iListArea}`)
check('三根横条都渲染在同一个槽位内（ActiveList → MultipleModeBar → ListSearchBar）',
  iActiveBar > -1 && iActiveBar < iMultiBar && iMultiBar < iSearchBar && iSearchBar < iListArea,
  `active@${iActiveBar} multi@${iMultiBar} search@${iSearchBar} listArea@${iListArea}`)
check('返回栏已从 <List> 的 header 中移除（不再随内容滚走）',
  !!listTag && !listHasHeaderProp && !/PageTopInset/.test(listCode) && !/ListHeaderComponent/.test(listCode),
  listHasHeaderProp ? '仍存在 header=' : '无 header/PageTopInset/ListHeaderComponent')

// —— B) 位置参数对齐基本设置 ——
check('顶边公式与基本设置同源且已内联（paddingTop: statusBarHeight + BAR_SLOT_ALIGN_PADDING_TOP）',
  !!barPadTopMatch && !!alignConst, alignConst ? `BAR_SLOT_ALIGN_PADDING_TOP=designSpacing.${alignConst.token}(${alignConst.value})` : '未匹配')
check('槽位外框不允许在 createStyle 里写 paddingTop（会被字号缩放，与设置页内联值分叉）',
  !!fixedBarBlock && !/paddingTop/.test(fixedBarBlock),
  !fixedBarBlock ? '找不到 fixedBar 块' : (/paddingTop/.test(fixedBarBlock) ? 'fixedBar 内含 paddingTop' : '无 paddingTop'))
check('槽位外框水平内边距 = 基本设置 header.paddingHorizontal（同 token 同值）',
  !!myPadH && !!refPadH && myPadH.token === refPadH.token && myPadH.value === refPadH.value,
  `我的=${myPadH && myPadH.token} 设置=${refPadH && refPadH.token}`)
check('槽位外框下内边距 = 基本设置 header.paddingBottom（同 token 同值）',
  !!myPadB && !!refPadB && myPadB.token === refPadB.token && myPadB.value === refPadB.value,
  `我的=${myPadB && myPadB.token} 设置=${refPadB && refPadB.token}`)
check('槽位本体为相对定位（绝对铺满的两根替换栏以它为基准）', !!barSlotBlock && /position:\s*'relative'/.test(barSlotBlock), '')
check('返回栏行高 = 基本设置返回按钮高度（44）', myBarH === refBtnH, `我的=${myBarH} 设置=${refBtnH}`)
check('返回栏图标 = chevron-left（返回态）且尺寸与设置页一致（20）', myIconNameExpr && Number(myIconSizeB) === Number(refIconSize),
  `我的=${myIconSizeB} 设置=${refIconSize}`)
check('图标左内边距 = 按钮内图标留白 (44-20)/2 = 12（glyph 左缘与设置页重合）',
  myIconPadLeft === (refBtnW - Number(refIconSize)) / 2, `${myIconPadLeft} vs ${(refBtnW - Number(refIconSize)) / 2}`)
check('我的详情使用 useStatusbarHeight 且不再叠加 +6（避免两处各加一次而错位）',
  myUsesStatusbarHook && !/STATUSBAR_TOP_OFFSET/.test(listCode) && !/statusBarHeight\s*\+\s*6\b/.test(listCode), '')
check(`【核心】返回按钮顶边一致（均 ${refTop}pt）`, myTop === refTop, `我的=${myTop} 设置=${refTop}`)
check(`【核心】返回按钮垂直中心一致（均 ${refCenter}pt）`, myCenter === refCenter, `我的=${myCenter} 设置=${refCenter}`)
check(`【核心】图标 glyph 左缘一致（均 ${refGlyphLeft}pt）`, myGlyphLeft === refGlyphLeft, `我的=${myGlyphLeft} 设置=${refGlyphLeft}`)

// —— C) 搜索框同槽位、不位移 ——
check('搜索栏绝对铺满槽位（top:0 / height:100%），与返回栏同一位置', absFill(searchContainer), '')
check('搜索栏无 translateY / transform 位移（只做原地淡入淡出）', !searchHasTranslate, searchHasTranslate ? '发现 translateY' : '')
check('多选栏绝对铺满槽位（top:0 / height:100%）且无位移', absFill(multiContainer) && !multiHasTranslate,
  multiHasTranslate ? '发现 translateY' : '')

// —— D) 取消后返回原列表 ——
check('取消按钮 onPress 接到 onExitSearch', cancelWired, '')
check('handleExitSearch 隐藏搜索结果与搜索栏、并恢复返回栏（原列表界面）',
  exitHidesSearch && exitRestoresBar, `hide=${exitHidesSearch} restore=${exitRestoresBar}`)

console.log()
const pad = Math.max(...results.map((r) => r.label.length))
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
