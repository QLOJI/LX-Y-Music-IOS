/**
 * 需求8 契约：「我的」列表进入详情后
 *
 *   A) 返回栏固定在上方（不随歌曲列表滚动）；
 *   B) 返回栏位置参数对齐「设置 → 基本设置」的返回按钮；
 *   C) 点击搜索后搜索框落在返回栏的同一槽位、且不做位移（无 translateY）；
 *   D) 点击取消后回到原列表界面（隐藏搜索栏/搜索结果、恢复返回栏）；
 *   E) 【第 16 轮第 4 条 + 第 19 轮第 3 条】返回栏里显示当前列表名，且两种状态共用同一处
 *      标题实现：返回按钮（箭头）在左端、搜索与封面开关两个按钮在右端、标题恒在栏正中。
 *      第 16 轮只在返回态显示（用户原话「不然我都不知道进哪个列表了」）；第 19 轮第 3 条把
 *      非返回态也并过来 —— 用户原话「搜索和显示/关闭封面显示按钮应该在右端，返回按钮在
 *      左端，中心是标题」。第 20 轮第 9 条再把「整栏点击 → 返回」收窄到左端箭头：行根
 *      onPress 在返回态置空（onBack ? undefined : showList），返回只由箭头自己的
 *      TouchableOpacity（currentListBack，槽位左右内边距 12/10 从 Icon 挪到它身上）承担
 *      —— 用户原话「我点击顶部的列表标题也会返回我的主界面，只保留点击左上角的返回才会
 *      返回我的主界面，点击顶部的列表标题不会返回」。glyph 几何逐像素不变（[12, 32]）。
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

// --- ActiveList.tsx：返回栏行高 / 箭头槽 ---
// 【第 20 轮第 9 条】箭头槽位包了一层 TouchableOpacity（currentListBack）：左右内边距
// 12/10 从 Icon 的 style 挪到槽上，glyph 落点公式不变（外框 12 + 槽位 12 = 24）。
const currentListBlock = styleBlock(activeCode, 'currentList')
const backSlotBlock = styleBlock(activeCode, 'currentListBack')
const myBarH = numIn(currentListBlock, 'height')
const mySlotPadLeft = numIn(backSlotBlock, 'paddingLeft')
const mySlotPadRight = numIn(backSlotBlock, 'paddingRight')
const mySlotFullHeight = /height:\s*'100%'/.test(backSlotBlock || '')
// glyph 左内边距全文件只能写一处（槽位上）：Icon 上若再叠一份，脚本按单处复算的
// glyph 左缘就会与实际渲染分叉 —— 单处计数把这种「复算假通过」堵掉。
const glyphPadSites = (activeCode.match(/paddingLeft:\s*12\b/g) || []).length
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
const myGlyphLeft = (myPadH ? myPadH.value : NaN) + (mySlotPadLeft || 0)

console.log('='.repeat(96))
console.log('需求8 契约：「我的」详情返回栏 ↔「设置 → 基本设置」返回按钮 对齐模型（摘自源码，单位 pt）')
console.log('='.repeat(96))
console.log(`  DesignTokens: ${Object.entries(tokens).map(([k, v]) => `${k}=${v}`).join(' ')}`)
console.log(`  样例机身原生状态栏 ${RAW_SB}pt → useStatusbarHeight() = ${S}pt（内部已含 +6，两处都不得再加）`)
console.log()
console.log(`  基本设置 返回按钮：顶边 = ${S} + ${refPadTop && refPadTop.value} = ${refTop}   高 ${refBtnH}   中心 y=${refCenter}   图标 glyph 左缘 = ${refPadH && refPadH.value} + (${refBtnW}-${refIconSize})/2 = ${refGlyphLeft}`)
console.log(`  我的详情 返回栏  ：顶边 = ${S} + ${alignConst && alignConst.value} = ${myTop}   高 ${myBarH}   中心 y=${myCenter}   图标 glyph 左缘 = ${myPadH && myPadH.value} + ${mySlotPadLeft} = ${myGlyphLeft}`)
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
check('箭头槽左内边距 = 按钮内图标留白 (44-20)/2 = 12（glyph 左缘与设置页重合）',
  mySlotPadLeft === (refBtnW - Number(refIconSize)) / 2, `${mySlotPadLeft} vs ${(refBtnW - Number(refIconSize)) / 2}`)
check('箭头槽右内边距沿用 10（glyph 占位 [12, 32] 与旧实现逐像素相同）',
  mySlotPadRight === 10, `paddingRight=${mySlotPadRight}`)
check('箭头槽命中区吃满行高 44（height: 100%），且 glyph 左内边距全文件只写一处（不叠在 Icon 上）',
  mySlotFullHeight && glyphPadSites === 1, `height100=${mySlotFullHeight} 全文件 paddingLeft:12 ${glyphPadSites} 处`)
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

// —— E) 【第 16 轮第 4 条 + 第 19 轮第 3 条 + 第 20 轮第 9 条】栏正中显示列表名；
//        左端箭头（独占返回）、右端两个按钮 ——
// 结构断言全部在去注释后的源码上做，且整组写成「源码 → 事实」的纯函数，
// 反例用当前源码变异后重跑整组（任一条判红即算拦下）。
const eFacts = (raw) => {
  const code = stripComments(raw)
  const nameBlock = styleBlock(code, 'currentListName')
  const nameTextBlock = styleBlock(code, 'currentListNameText')
  const btnBlock = styleBlock(code, 'currentListBtns')
  const spacerBlock = styleBlock(code, 'currentListSpacer')
  // 返回栏那一行的 JSX：三段定位（左箭头 / 中标题 / 右按钮）的先后顺序都在这段里看。
  // 起止不能各取「第一个 <TouchableOpacity …>」：行里现在还嵌着三个 TouchableOpacity
  // （箭头槽 + 两个按钮），非贪婪匹配到第一个 </TouchableOpacity> 就断了。
  // 起 = 行根标签（onPress + onLongPress={onScrollToTop} 的组合为行根独有），
  // 止 = 文件里最后一个 </TouchableOpacity>（本行自己的）。行根 onPress 的具体值由
  // E11 单独断言，不拿它当寻址锚 —— 换回旧值时寻址失败会把 E1/E9/E10 一起拖红，
  // 反例就分不清坏的是哪种结构。
  const rowStartMatch = /<TouchableOpacity\s+onPress=\{[^}]*\}\s+onLongPress=\{onScrollToTop\}/.exec(code)
  const iRowStart = rowStartMatch ? rowStartMatch.index : -1
  const iRowEnd = code.lastIndexOf('</TouchableOpacity>')
  const rowJsx = iRowStart > -1 && iRowEnd > iRowStart ? code.slice(iRowStart, iRowEnd) : null
  // 【第 20 轮第 9 条】左端箭头槽 = currentListBack（包着 Icon 的 TouchableOpacity）
  const iBackSlot = rowJsx ? rowJsx.indexOf('styles.currentListBack') : -1
  const iName = rowJsx ? rowJsx.indexOf('styles.currentListName') : -1
  const iSpacer = rowJsx ? rowJsx.indexOf('styles.currentListSpacer') : -1
  const iBtn = rowJsx ? rowJsx.indexOf('styles.currentListBtns') : -1
  return {
    code,
    rowJsx,
    nameBlock,
    nameTextBlock,
    btnBlock,
    spacerBlock,
    btnCount: rowJsx ? (rowJsx.match(/styles\.currentListBtns/g) || []).length : 0,
    nameViewTag: (/<View style=\{styles\.currentListName\}([^>]*)>/.exec(code) || [])[1] || null,
    // 两种状态共用同一处标题实现（第 19 轮第 3 条）：居中名无条件渲染 —— 行内没有
    // 「onBack ? (…)」这种把标题切成分叉的写法（箭头方向/尺寸是值三元，不带括号不分叉），
    // 旧的非返回态行内文字 currentListText 在全文件里已不存在。
    titleAlwaysRendered: !!rowJsx && iName > -1 && !/currentListText/.test(code) &&
      !/onBack\s*\?[\s\S]{0,80}?\(/.test(rowJsx),
    // 左端箭头：箭头槽排在标题容器之前（行内第一个元素）
    iconLeft: iBackSlot > -1 && iBackSlot < iName,
    // 【第 20 轮第 9 条】返回收窄到左端箭头：行根 onPress 在返回态置空（点标题 /
    // 整栏不再返回），箭头槽自己的 onPress 才接返回（非返回态退化为开列表）；
    // 长按整栏滚动到顶部保留在行根（onLongPress，不受影响）。
    rowPressGuarded: /onPress=\{onBack \? undefined : showList\}/.test(code) &&
      /style=\{styles\.currentListBack\}[\s\S]{0,80}?onPress=\{onBack \|\| showList\}/.test(code),
    // 右端按钮：两个按钮都排在标题容器之后，且中间有 flex:1 弹性占位把按钮顶到栏尾
    btnsRight: iName > -1 && iBtn > iName && iSpacer > iName && iSpacer < iBtn && !!spacerBlock &&
      /flex:\s*1/.test(spacerBlock),
    idHook: /const currentListId = useActiveListId\(\)/.test(code),
    nameMemo: /const currentListName = useMemo\(\(\) => \{[\s\S]{0,700}?\}, \[currentListId\]\)/.test(code),
    nameI18n: /global\.i18n\.t\('list_name_temp'\)/.test(code) &&
      /global\.i18n\.t\('list_name_default'\)/.test(code) &&
      /global\.i18n\.t\('list_name_love'\)/.test(code),
    nameFromAllList: /listState\.allList\.find\(\(l\) => l\.id === currentListId\)\?\.name/.test(code),
    nameRendered: /style=\{styles\.currentListName\}[\s\S]{0,160}?\{currentListName\}/.test(code),
    nameTextLines: /<Text style=\{styles\.currentListNameText\} numberOfLines=\{1\}/.test(code),
    rowCenter: /alignItems:\s*'center'/.test(styleBlock(code, 'currentList') || ''),
  }
}
const E_FACTS = eFacts(activeSrc)
const eMinPad = (numIn(E_FACTS.btnBlock, 'width') || 0) * 2 + (numIn(styleBlock(activeCode, 'currentList'), 'paddingRight') || 0)

const GROUP_E = [
  ['E1 两种状态共用同一处标题实现（居中名无条件渲染；旧的行内文字 currentListText 已删）',
    (f) => f.titleAlwaysRendered],
  ['E2 名称取自当前激活列表（useActiveListId + memo 依赖 currentListId），内置列表走 i18n、自建/收藏查 allList',
    (f) => f.idHook && f.nameMemo && f.nameI18n && f.nameFromAllList],
  ['E3 居中容器里真的渲染了 currentListName（不是空壳）', (f) => f.nameRendered],
  ['E4 名称容器绝对定位横向铺满整栏（left/right: 0）+ alignItems: center（水平居中不靠两边留白凑）',
    (f) => !!f.nameBlock && /position:\s*'absolute'/.test(f.nameBlock) &&
      /left:\s*0/.test(f.nameBlock) && /right:\s*0/.test(f.nameBlock) &&
      /alignItems:\s*'center'/.test(f.nameBlock)],
  ['E5 垂直居中交给行（currentList 仍 alignItems: center），名称自身不写 top/bottom（两套居中不打架）',
    (f) => f.rowCenter && !!f.nameBlock &&
      !/(^|[^a-zA-Z])top:/.test(f.nameBlock) && !/(^|[^a-zA-Z])bottom:/.test(f.nameBlock)],
  [`E6 左右内边距对称且 ≥ 两侧遮挡宽度（2×按钮 46 + 容器 2 = ${eMinPad}），名称不被按钮挤压、也不压按钮`,
    (f) => {
      const l = numIn(f.nameBlock, 'paddingLeft')
      const r = numIn(f.nameBlock, 'paddingRight')
      return l != null && l === r && l >= eMinPad
    }],
  ['E7 长名截断（numberOfLines={1}，容器 textAlign: center）',
    (f) => f.nameTextLines && !!f.nameTextBlock && /textAlign:\s*'center'/.test(f.nameTextBlock)],
  ['E8 名称容器不拦截触摸（pointerEvents="none"）：点标题穿透到整行，由行根 onPress 决定行为（返回态置空 → 不返回）',
    (f) => !!f.nameViewTag && /pointerEvents="none"/.test(f.nameViewTag)],
  ['E9 左端箭头：箭头槽（currentListBack）是行内第一个元素、排在标题容器之前（返回态 chevron-left / 非返回态 chevron-right，位置不动）',
    (f) => f.iconLeft],
  ['E10 右端按钮：两个 46pt 图标按钮都排在标题容器之后，中间隔一个 flex:1 弹性占位顶到栏尾',
    (f) => f.btnsRight && f.btnCount === 2],
  ['E11 【第 20 轮第 9 条】返回只由左端箭头承担：行根 onPress 返回态置空（onBack ? undefined : showList），箭头槽 onPress={onBack || showList}（非返回态仍点整行开列表）',
    (f) => f.rowPressGuarded],
]
const eRes = GROUP_E.map(([label, fn]) => ({ label, ok: !!fn(E_FACTS) }))

const mutE = (from, to) => {
  const out = activeSrc.replace(from, to)
  return { src: out, changed: out !== activeSrc }
}
const caughtE = (src) => GROUP_E.some(([, fn]) => !fn(eFacts(src)))
// m6: 退回第 16 轮的旧写法（标题分叉：返回态居中名、非返回态行内文字）
const m6 = mutE('<View style={styles.currentListName} pointerEvents="none">',
  '{onBack ? (<View style={styles.currentListName} pointerEvents="none">) : (<Text style={styles.currentListText}>{currentListName}</Text>)}')
// m7: 名称来源不查 allList（自建 / 收藏 / 同步列表名全空）
const m7 = mutE("listState.allList.find((l) => l.id === currentListId)?.name ?? ''", "''")
// m8: 左右内边距不对称（名称偏左压住返回箭头）
const m8 = mutE('paddingLeft: 96,\n    paddingRight: 96,', 'paddingLeft: 12,\n    paddingRight: 96,')
// m9: 名称容器改回参与 flex 布局（被两侧按钮挤压，长名把按钮推走）
const m9 = mutE("position: 'absolute',\n    left: 0,\n    right: 0,", 'flex: 1,')
// m10: 去掉截断（长名换行把 44 的行高撑变形）
const m10 = mutE('<Text style={styles.currentListNameText} numberOfLines={1}', '<Text style={styles.currentListNameText}')
// m11: 去掉 pointerEvents（点击被文本吞掉，返回失灵）
const m11 = mutE('<View style={styles.currentListName} pointerEvents="none">', '<View style={styles.currentListName}>')
// m12: 拿掉弹性占位（两个按钮跟着箭头挤到左边，「按钮在右端」没了）
const m12 = mutE('        <View style={styles.currentListSpacer} />\n', '')
// m13: 行根 onPress 退回第 19 轮写法（返回态也触发返回 —— 点列表标题就返回，
// 正是第 20 轮第 9 条要修的那个 bug）
const m13 = mutE('onPress={onBack ? undefined : showList}', 'onPress={onBack || showList}')

// E 组断言用源码复算出的 barSlot 遮挡宽度，标签里已带 E1..E10 前缀，不再单独打分组标题
for (const r of eRes) check(r.label, r.ok)
check(`反例 m6：退回旧的分叉写法（非返回态改行内文字），被 E 判红`, m6.changed && caughtE(m6.src))
check(`反例 m7：名称来源不查 allList（列表名空），被 E 判红`, m7.changed && caughtE(m7.src))
check(`反例 m8：左右内边距不对称（名称偏左压箭头），被 E 判红`, m8.changed && caughtE(m8.src))
check(`反例 m9：名称容器改回 flex 参与布局（被按钮挤压），被 E 判红`, m9.changed && caughtE(m9.src))
check(`反例 m10：去掉 numberOfLines（长名换行撑变形），被 E 判红`, m10.changed && caughtE(m10.src))
check(`反例 m11：去掉 pointerEvents（点名称不返回），被 E 判红`, m11.changed && caughtE(m11.src))
check(`反例 m12：拿掉弹性占位（按钮挤到左边，不在右端），被 E 判红`, m12.changed && caughtE(m12.src))
check(`反例 m13：行根 onPress 退回 onBack || showList（点标题又返回），被 E 判红`, m13.changed && caughtE(m13.src))

console.log()
const pad = Math.max(...results.map((r) => r.label.length))
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
