/**
 * sim-setting-search-consistency.js
 *
 * 第 20 轮「搜索浮层 / 设置页一致性」契约不变量（2026-10-03），覆盖用户 9 张截图里
 * 没有独立脚本兜底的 6 条：图四（搜索）、图五/图六（来源测试行）、图七（历史地址按钮）、
 * 图八（音质两页统一）、第 5 条（我的页列表显示开关）。
 *
 * 每条都对应一个「改回去也照样能编译、只有真机/肉眼才发现」的坑：
 *   · 图四圆角：SearchTipList 行内 buttonRadius(40) + overflow 裁剪；静态样式表里不能有
 *     兜底 borderRadius（会被行内覆盖、又让「0 = 直角」的刻度失效）；
 *   · 图四字号：输入框行内 fontSize 必须「设计字号 × 字体大小设置」（和联想浮层同口径），
 *     不能回到 styles.input 的写死值（StyleSheet 在模块加载时固化，不吃缩放）；
 *   · 图五/六：来源测试行 checkboxRow 顶部对齐（卡片自带下边距，居中会把卡片抬高 4pt）
 *     + 两行都允许换行（大字号下不裁切）；
 *   · 图七：历史地址按钮去掉 marginLeft、上边距与整行卡一致；
 *   · 图八：音质列表/文案/选中态归一只有一份真源（qualityOptions），两页不许再各写一份；
 *   · 第 5 条：我的页列表显示多出 WebDAV / 本地与下载两项，FeatureGrid 按同一开关过滤。
 *
 * 运行：node scripts/sim-setting-search-consistency.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const TIP = 'src/components/SearchTipList/index.tsx'
const INPUT = 'src/screens/Home/Views/Search/HeaderBar/SearchInput.tsx'
const SOURCE_TEST = 'src/screens/Home/Views/Setting/settings/Basic/SourceTest.tsx'
const HISTORY = 'src/screens/Home/Views/Setting/settings/Sync/History.tsx'
const OPTIONS = 'src/screens/Home/Views/Setting/settings/qualityOptions.ts'
const PLAY = 'src/screens/Home/Views/Setting/settings/Player/PlayHighQuality.tsx'
const DOWN = 'src/screens/Home/Views/Setting/settings/Download/DownloadQuality.tsx'
const MYLIST_VIS = 'src/screens/Home/Views/Setting/settings/List/MyListVisibility.tsx'
const FEATURE_GRID = 'src/components/home/FeatureGrid.tsx'
const MUSIC_UTILS = 'src/core/music/utils.ts'

const REAL = {
  TIP: read(TIP),
  INPUT: read(INPUT),
  SOURCE_TEST: read(SOURCE_TEST),
  HISTORY: read(HISTORY),
  OPTIONS: read(OPTIONS),
  PLAY: read(PLAY),
  DOWN: read(DOWN),
  MYLIST_VIS: read(MYLIST_VIS),
  FEATURE_GRID: read(FEATURE_GRID),
  MUSIC_UTILS: read(MUSIC_UTILS),
}

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const count = (src, needle) => src.split(needle).length - 1

/** 从源码里按大括号配对抠出一个样式块（注释先剥掉，避免注释里的词误命中）。 */
const styleBlock = (src, name) => {
  const anchor = `\n  ${name}: {`
  const start = src.indexOf(anchor)
  if (start < 0) return null
  let depth = 0
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(start, j + 1)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// S1 图四：搜索联想浮层圆角
// ---------------------------------------------------------------------------

const tipRadiusInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  if (!/import \{ useButtonRadius \} from '@\/utils\/buttonRadius'/.test(code)) {
    reasons.push('SearchTipList 没有引入 useButtonRadius（圆角不跟「按钮圆角」设置走）')
  }
  if (count(code, 'const buttonRadius = useButtonRadius()') !== 1) {
    reasons.push('useButtonRadius() 调用不是恰好一处')
  }
  if (count(code, 'borderRadius: buttonRadius(40)') !== 1) {
    reasons.push('行内圆角不是恰好一处 buttonRadius(40)（40 是与 SearchInput 输入框一致的设计高度基准）')
  }
  const container = styleBlock(code, 'container')
  if (!container) {
    reasons.push('未找到 styles.container 样式块（锚点漂移）')
  } else {
    if (/borderRadius/.test(container)) {
      reasons.push('静态样式表里出现了 borderRadius 兜底值（应该是行内 buttonRadius(40) 唯一来源，0 = 直角刻度）')
    }
    if (!/overflow: 'hidden'/.test(container)) {
      reasons.push("styles.container 缺少 overflow: 'hidden'（列表首/末行底色会在圆角外露出直角）")
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// S2 图四：搜索输入框字号
// ---------------------------------------------------------------------------

const inputFontInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  if (!/\buseFontSize\b/.test(code) || !/from '@\/store\/common\/hook'/.test(code)) {
    reasons.push('SearchInput 没有订阅 useFontSize（字号不随「字体大小」设置缩放）')
  }
  if (count(code, 'const fontSizeValue = useFontSize()') !== 1) {
    reasons.push('useFontSize() 调用不是恰好一处')
  }
  if (!/fontSize: getTextSize\(designTypography\.body\) \* fontSizeValue/.test(code)) {
    reasons.push('行内 fontSize 不是「getTextSize(designTypography.body) * fontSizeValue」（与联想浮层不同口径）')
  }
  if (!/\bgetTextSize\b/.test(code)) {
    reasons.push('没有用 getTextSize 换算设计字号')
  }
  const input = styleBlock(code, 'input')
  if (!input) {
    reasons.push('未找到 styles.input 样式块（锚点漂移）')
  } else if (/fontSize/.test(input)) {
    reasons.push('静态样式表里不能出现 fontSize（模块加载时固化、且调用方 style 优先会覆盖 Input 内部的 setSpText）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// S3 图五/六：来源测试行（顶部对齐 + 换行）
// ---------------------------------------------------------------------------

const sourceTestInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  const buttonRow = styleBlock(code, 'buttonRow')
  if (!buttonRow) {
    reasons.push('未找到 styles.buttonRow 样式块（锚点漂移）')
  } else if (!/flexWrap: 'wrap'/.test(buttonRow)) {
    reasons.push("buttonRow 缺少 flexWrap: 'wrap'（大字号下「常见问题」被挤出容器右缘）")
  }

  const checkboxRow = styleBlock(code, 'checkboxRow')
  if (!checkboxRow) {
    reasons.push('未找到 styles.checkboxRow 样式块（锚点漂移）')
  } else {
    if (!/alignItems: 'flex-start'/.test(checkboxRow)) {
      reasons.push("checkboxRow 不是顶部对齐（alignItems: 'flex-start'）—— 卡片自带下边距，居中会把两张卡片整体抬高 4pt")
    }
    if (/alignItems: 'center'/.test(checkboxRow)) {
      reasons.push('checkboxRow 回到了居中对齐（顶边差 4pt 的老毛病）')
    }
    if (!/flexWrap: 'wrap'/.test(checkboxRow)) {
      reasons.push("checkboxRow 缺少 flexWrap: 'wrap'（大字号下勾选框文字被逐字竖排挤压）")
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// S4 图七：历史地址按钮左对齐
// ---------------------------------------------------------------------------

const historyBtnInvariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  const btn = styleBlock(code, 'btn')
  if (!btn) {
    reasons.push('未找到 styles.btn 样式块（锚点漂移）')
    return reasons
  }
  if (/marginLeft/.test(btn)) {
    reasons.push('历史地址按钮又带回 marginLeft（比同页其它行多缩进、视觉上吊在中间）')
  }
  if (!/marginTop: designSpacing\.xs/.test(btn)) {
    reasons.push('上边距不是与整行卡一致的 designSpacing.xs')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// S5 图八：音质列表/文案的唯一真源
// ---------------------------------------------------------------------------

// 界面固定 6 项、自高到低。TRY_QUALITYS_LIST 增删档位时这里会红 —— 是有意的
// 「刻意更新」闸：改真源可以，但必须同时来改这张表和 qualityOptions 的文案表。
const EXPECTED_VISIBLE = ['128k', '320k', 'flac', 'flac24bit', 'atmos', 'master']
const EXPECTED_LABELS = {
  '128k': '128K',
  '320k': '320K',
  flac: 'Flac',
  flac24bit: '24bitFlac',
  atmos: 'Atmos',
  master: 'Master',
}

/** 用真源码里的 TRY_QUALITYS_LIST 重算「界面可见列表」模型。 */
const buildQualityModel = (utilsSrc, optionsCode) => {
  const m = utilsSrc.match(/export const TRY_QUALITYS_LIST = \[([^\]]*)\]/)
  const baseList = m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : []
  const filtersAtmosPlus = optionsCode.includes("q !== 'atmos_plus'")
  const filtersHires = optionsCode.includes("q !== 'hires'")
  const reverses = /\.reverse\(\)/.test(optionsCode)
  let visible = [...baseList, '128k']
  if (filtersAtmosPlus) visible = visible.filter(q => q !== 'atmos_plus')
  if (filtersHires) visible = visible.filter(q => q !== 'hires')
  if (reverses) visible.reverse()
  return { baseList, visible }
}

const qualityInvariants = () => {
  const reasons = []
  const optionsCode = stripComments(REAL.OPTIONS)
  const utilsCode = stripComments(REAL.MUSIC_UTILS)

  const { baseList, visible } = buildQualityModel(utilsCode, optionsCode)

  if (baseList.length === 0) {
    reasons.push('未从 src/core/music/utils.ts 解析到 TRY_QUALITYS_LIST（锚点漂移）')
  }
  if (!optionsCode.includes("q !== 'atmos_plus'") || !optionsCode.includes("q !== 'hires'")) {
    reasons.push("getVisibleQualityList 的过滤条件被削弱（atmos_plus / hires 必须都被隐藏）")
  }
  if (!/\.reverse\(\)/.test(optionsCode)) {
    reasons.push('可见列表没有保持「自高到低」的 reverse 顺序')
  }
  if (visible.join(',') !== EXPECTED_VISIBLE.join(',')) {
    reasons.push(`可见档位模型 = [${visible.join(', ')}]，与约定的 6 项 [${EXPECTED_VISIBLE.join(', ')}] 不符`)
  }

  // 文案表：逐项核对（缺一项真机上就是一个空标签）
  const labelsBlock = optionsCode.match(/QUALITY_LABELS[^=]*= \{([\s\S]*?)\n\}/)
  const labels = {}
  if (labelsBlock) {
    for (const mm of labelsBlock[1].matchAll(/(?:'([^']+)'|([A-Za-z][A-Za-z0-9]*))\s*:\s*'([^']+)'/g)) {
      labels[mm[1] ?? mm[2]] = mm[3]
    }
  } else {
    reasons.push('未找到 QUALITY_LABELS 表')
  }
  for (const q of EXPECTED_VISIBLE) {
    const want = EXPECTED_LABELS[q]
    if (labels[q] === undefined) reasons.push(`可见档位 ${q} 没有固定文案（真机上该行标签为空）`)
    else if (labels[q] !== want) reasons.push(`档位 ${q} 文案 = "${labels[q]}"，约定为 "${want}"`)
  }
  if (!/hires:\s*'flac24bit'/.test(optionsCode)) {
    reasons.push("存量值 'hires' 的选中态归一丢失（QUALITY_ACTIVE_ALIAS 必须把 hires 显示为 flac24bit，否则一项都不选中）")
  }
  if (!/QUALITY_LABELS\[q\] \?\? t\(q\)/.test(optionsCode)) {
    reasons.push('getQualityLabel 的「固定表优先、未收录退回 i18n」实现被改动')
  }

  // 两个消费页：只许从真源取，不许再各写一份
  // 写入 key 只认 updateSetting 那一处（订阅读取用的同一个字符串在 useSettingValue 里，
  // 两处都是对的，按「调用形式」而不是「字符串出现次数」来查）。
  const pages = [
    ['PlayHighQuality（播放音质）', stripComments(REAL.PLAY), "updateSetting({ 'player.playQuality': id })"],
    ['DownloadQuality（下载音质）', stripComments(REAL.DOWN), "updateSetting({ 'download.quality': id })"],
  ]
  for (const [name, code, writeKey] of pages) {
    const importOk = /import \{ QUALITY_ACTIVE_ALIAS, getQualityLabel, getVisibleQualityList \} from '\.\.\/qualityOptions'/.test(code)
    if (!importOk) reasons.push(`${name} 没有从 ../qualityOptions 引入三个符号（唯一真源断开）`)
    if (code.includes('TRY_QUALITYS_LIST')) {
      reasons.push(`${name} 直接引用了 TRY_QUALITYS_LIST（自己拼列表 = 未过滤 + 与真源漂移）`)
    }
    if (code.includes('QUALITY_LABELS')) {
      reasons.push(`${name} 直接引用了 QUALITY_LABELS（文案必须走 getQualityLabel）`)
    }
    if (code.includes("'hires'")) {
      reasons.push(`${name} 里出现字面量 'hires'（归一规则只许在 qualityOptions 里）`)
    }
    if (count(code, 'getVisibleQualityList()') !== 1) {
      reasons.push(`${name} 调用 getVisibleQualityList() 不是恰好一处`)
    }
    if (count(code, 'getQualityLabel(q, t)') !== 1) {
      reasons.push(`${name} 调用 getQualityLabel(q, t) 不是恰好一处`)
    }
    if (!/\(QUALITY_ACTIVE_ALIAS\[q\] \?\? q\) == id/.test(code)) {
      reasons.push(`${name} 的选中态没有走 QUALITY_ACTIVE_ALIAS 归一`)
    }
    if (count(code, writeKey) !== 1) {
      reasons.push(`${name} 的写入 key 不是恰好一处 ${writeKey}`)
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// S6 第 5 条：我的页列表显示（WebDAV / 本地与下载）
// ---------------------------------------------------------------------------

const MYLIST_IDS = [
  'nav_my_playlist',
  'nav_kg_playlist',
  'nav_tx_playlist',
  'nav_followed_artists',
  'nav_subscribed_albums',
  'nav_webdav',
  'nav_local_download',
]

const myListVisibilityInvariants = () => {
  const reasons = []
  const code = stripComments(REAL.MYLIST_VIS)
  const gridCode = stripComments(REAL.FEATURE_GRID)

  const block = code.match(/PLATFORM_ITEM_IDS = \[([\s\S]*?)\]/)
  const ids = block ? [...block[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : []
  for (const id of MYLIST_IDS) {
    if (!ids.includes(id)) {
      reasons.push(`我的页列表显示缺少 '${id}'（勾选列表里没有这一项）`)
    }
  }

  if (!/const myListVisibility = useSettingValue\('list\.myListVisibility'\)/.test(gridCode)) {
    reasons.push('FeatureGrid 没有订阅 list.myListVisibility（开关拨了没人听）')
  }
  if (count(gridCode, '(myListVisibility[menu.id] ?? true)') !== 1) {
    reasons.push('FeatureGrid 的过滤项不是恰好一处 (myListVisibility[menu.id] ?? true)（默认 true = 没配置过也要显示）')
  }
  if (!/\[navStatus, showBackBtn, showExitBtn, wyCookie, kgCookie, txCookie, myListVisibility\]/.test(gridCode)) {
    reasons.push('myListVisibility 不在 FeatureGrid 的 useMemo 依赖里（开关变化不会重算）')
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

  // m1 浮层行内圆角被摘（回到直角/无处可改）
  check('m1 浮层行内圆角被摘', () =>
    tipRadiusInvariants(tamper(REAL.TIP, 'borderRadius: buttonRadius(40),', '')),
  '行内圆角')

  // m2 浮层静态样式表里塞回 borderRadius 兜底
  check('m2 浮层静态样式表塞回 borderRadius', () =>
    tipRadiusInvariants(tamper(REAL.TIP, "    maxHeight: '80%',", "    maxHeight: '80%',\n    borderRadius: 12,")),
  '静态样式表里出现了 borderRadius')

  // m3 输入框行内字号丢掉缩放因子（回到「设计字号 × 1」）
  check('m3 输入框字号丢掉缩放', () =>
    inputFontInvariants(tamper(REAL.INPUT,
      '{ fontSize: getTextSize(designTypography.body) * fontSizeValue }',
      '{ fontSize: designTypography.body }')),
  '口径')

  // m4 输入框静态样式表塞回 fontSize
  check('m4 输入框静态样式表塞回 fontSize', () =>
    inputFontInvariants(tamper(REAL.INPUT, '    paddingRight: 10,', '    paddingRight: 10,\n    fontSize: designTypography.body,')),
  '不能出现 fontSize')

  // m5 checkboxRow 回到居中对齐（顶边差 4pt 回归）
  check('m5 来源测试行回到居中', () =>
    sourceTestInvariants(tamper(REAL.SOURCE_TEST,
      "    alignItems: 'flex-start',\n    gap: designSpacing.xs,",
      "    alignItems: 'center',\n    gap: designSpacing.xs,")),
  '顶部对齐')

  // m6 checkboxRow 换行被摘（大字号竖排挤压回归）
  check('m6 来源测试勾选行换行被摘', () =>
    sourceTestInvariants(tamper(REAL.SOURCE_TEST,
      "    // 放开换行：放得下的行布局与之前完全一致，放不下的整张卡片换到下一行，绝不压缩/裁切。\n    flexWrap: 'wrap',\n  },",
      '  },')),
  'checkboxRow')

  // m7 buttonRow 换行被摘（「常见问题」被挤出右缘回归）
  check('m7 来源测试按钮行换行被摘', () =>
    sourceTestInvariants(tamper(REAL.SOURCE_TEST,
      "    // 放开换行后整卡换行，按钮与文字都完整可见。\n    flexWrap: 'wrap',",
      '')),
  'buttonRow')

  // m8 历史地址按钮带回 marginLeft
  check('m8 历史地址按钮带回 marginLeft', () =>
    historyBtnInvariants(tamper(REAL.HISTORY,
      "  btn: {\n    flexDirection: 'row',\n",
      "  btn: {\n    flexDirection: 'row',\n    marginLeft: designSpacing.md,\n")),
  'marginLeft')

  // m9 下载页把列表拼回本地（未过滤 8 项）
  check('m9 下载页自拼未过滤列表', () =>
    (() => {
      const patched = tamper(REAL.DOWN,
        'const qualityList = useMemo(() => getVisibleQualityList(), [])',
        "const qualityList = useMemo(() => [...TRY_QUALITYS_LIST, '128k'].reverse(), [])")
      const saved = REAL.DOWN
      REAL.DOWN = patched
      try { return qualityInvariants() } finally { REAL.DOWN = saved }
    })(),
  'TRY_QUALITYS_LIST')

  // m10 真源过滤条件被削弱（hires 不再隐藏 → 7 项）
  check('m10 真源过滤削弱（hires 不隐藏）', () =>
    (() => {
      const patched = tamper(REAL.OPTIONS, "q !== 'atmos_plus' && q !== 'hires'", "q !== 'atmos_plus'")
      const saved = REAL.OPTIONS
      REAL.OPTIONS = patched
      try { return qualityInvariants() } finally { REAL.OPTIONS = saved }
    })(),
  '过滤条件被削弱')

  // m11 存量值归一表被清空
  check('m11 存量值归一表被清空', () =>
    (() => {
      const patched = tamper(REAL.OPTIONS,
        "export const QUALITY_ACTIVE_ALIAS: Record<string, LX.Quality> = { hires: 'flac24bit' }",
        "export const QUALITY_ACTIVE_ALIAS: Record<string, LX.Quality> = {}")
      const saved = REAL.OPTIONS
      REAL.OPTIONS = patched
      try { return qualityInvariants() } finally { REAL.OPTIONS = saved }
    })(),
  '归一丢失')

  // m12 Master 文案丢失（该项标签为空）
  check('m12 Master 文案丢失', () =>
    (() => {
      const patched = tamper(REAL.OPTIONS, "  master: 'Master',\n", '')
      const saved = REAL.OPTIONS
      REAL.OPTIONS = patched
      try { return qualityInvariants() } finally { REAL.OPTIONS = saved }
    })(),
  '固定文案')

  // m13 播放页绕过 getQualityLabel 直接查表
  check('m13 播放页绕过 getQualityLabel', () =>
    (() => {
      const patched = tamper(REAL.PLAY,
        '<Item name={getQualityLabel(q, t)} id={q} key={q} />',
        '<Item name={QUALITY_LABELS[q] ?? t(q)} id={q} key={q} />')
      const saved = REAL.PLAY
      REAL.PLAY = patched
      try { return qualityInvariants() } finally { REAL.PLAY = saved }
    })(),
  'QUALITY_LABELS')

  // m14 我的页列表显示少了 WebDAV
  check('m14 列表显示少了 WebDAV', () =>
    (() => {
      const patched = tamper(REAL.MYLIST_VIS, "  'nav_webdav',\n", '')
      const saved = REAL.MYLIST_VIS
      REAL.MYLIST_VIS = patched
      try { return myListVisibilityInvariants() } finally { REAL.MYLIST_VIS = saved }
    })(),
  "'nav_webdav'")

  // m15 我的页列表显示少了「本地与下载」
  check('m15 列表显示少了本地与下载', () =>
    (() => {
      const patched = tamper(REAL.MYLIST_VIS, "  'nav_local_download',\n", '')
      const saved = REAL.MYLIST_VIS
      REAL.MYLIST_VIS = patched
      try { return myListVisibilityInvariants() } finally { REAL.MYLIST_VIS = saved }
    })(),
  "'nav_local_download'")

  // m16 FeatureGrid 的过滤项被摘（开关拨了没人听）
  check('m16 FeatureGrid 过滤项被摘', () =>
    (() => {
      const patched = tamper(REAL.FEATURE_GRID, '(myListVisibility[menu.id] ?? true),', 'true,')
      const saved = REAL.FEATURE_GRID
      REAL.FEATURE_GRID = patched
      try { return myListVisibilityInvariants() } finally { REAL.FEATURE_GRID = saved }
    })(),
  'myListVisibility')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-setting-search-consistency ===')

const sections = [
  ['图四·浮层圆角（SearchTipList：行内 buttonRadius(40) + overflow 裁剪）', () => tipRadiusInvariants(REAL.TIP)],
  ['图四·输入框字号（SearchInput：行内 设计字号×字体大小，静态表无 fontSize）', () => inputFontInvariants(REAL.INPUT)],
  ['图五/六·来源测试行（顶部对齐 + 两行换行）', () => sourceTestInvariants(REAL.SOURCE_TEST)],
  ['图七·历史地址按钮（无 marginLeft、上边距 xs）', () => historyBtnInvariants(REAL.HISTORY)],
  ['图八·音质唯一真源（qualityOptions + 两页共用 + 6 项模型核对）', () => qualityInvariants()],
  ['第 5 条·我的页列表显示（7 个 id + FeatureGrid 过滤）', () => myListVisibilityInvariants()],
]

const model = buildQualityModel(stripComments(REAL.MUSIC_UTILS), stripComments(REAL.OPTIONS))
console.log(`音质模型：TRY_QUALITYS_LIST = [${model.baseList.join(', ')}]`)
console.log(`音质模型：界面可见 = [${model.visible.join(', ')}]（${model.visible.length} 项）`)

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
