#!/usr/bin/env node
/**
 * sim-webdav-url-parity.js —— 「服务器地址」前缀校验与参考工程 1:1 口径（第 33 轮第 2 条）
 *
 * 需求原话（2026-10-08 第 33 轮第 2 条）：
 *   「数据同步中，同步服务地址部分功能请参考lx-music-mobile-ios-adaptation项目，一比一复刻，
 *     它做的比较好」
 *
 * 对照结论（读源码得出，参考工程全程只读）：
 *   · 参考工程 R 的 `Sync/IsEnable.tsx` 里「同步服务地址」（key `setting_sync_host_label`）
 *     用 `addressRxp = /^https?:\/\/\S+/i` 做前缀校验：合法才写入、非法清空输入框并 toast
 *     `setting_sync_host_value_error_tip`，同时给输入框加 `inputMode="url"`。
 *   · 本工程 W 的 `Sync/IsEnable.tsx` 与 R 版逐字符等价（同一套 regex、同一句提示、同一个
 *     inputMode），也就是「同步服务地址」这块本来就是 1:1，没有可搬的差异。
 *   · 真正没跟上这套口径的，是同一个数据同步页里的 WebDAV「服务器地址」输入行：它以前把任意
 *     文本（含 `abc`、`ftp://x`）直接落盘到 `sync.webdav.url`，没有前缀校验、没有 inputMode。
 *     本轮把那行接到同一套校验上 —— 这就是第 2 条的落点。
 *
 * 口径（本脚本钉死）：
 *   一、模块级正则与 IsEnable.tsx 的 `addressRxp` **同一串字面量**（1:1 的直接证据）；
 *   二、「服务器地址」行必须走专用处理函数，并且该函数：合法 → `text.trim()`；非法 → 写空串 +
 *      `toast(t('setting_sync_host_value_error_tip'), 'long')`；两条路径都要 `callback(url)`，
 *      变更后 `updateSetting({'sync.webdav.url': …})` + `resetClient()`（换地址必须重置客户端）；
 *   三、该行带 `inputMode="url"`（与 IsEnable.tsx 同写法）；
 *   四、用户名 / 密码 / 同步路径三行仍走通用处理函数（它们不是 URL，不能被这套校验误伤）；
 *   五、提示词条 `setting_sync_host_value_error_tip` 在 zh-cn.json 里存在（否则 toast 会显示空串）。
 *
 * 为什么必须靠契约脚本：这一整条是「输入框行为」——没有报错、没有类型错，tsc/eslint 全绿；
 * 谁把 onChanged 换回通用处理函数、把非法分支的「清空 + 提示」删掉、或把正则改窄/改宽，
 * 表面「能跑」，实际又退回「垃圾串直接落盘」。带反例自检（m1–m6）。
 *
 * 运行：node scripts/sim-webdav-url-parity.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

const countOf = (src, needle) => src.split(needle).length - 1

const F = {
  sync: 'src/screens/Home/Views/Setting/settings/Sync/index.tsx',
  isEnable: 'src/screens/Home/Views/Setting/settings/Sync/IsEnable.tsx',
  lang: 'src/lang/zh-cn.json',
}

const REAL = {
  sync: read(F.sync),
  isEnable: read(F.isEnable),
  lang: read(F.lang),
}

// 参考先例（W 侧与 R 逐字符等价的实现）里的那串正则
const PRECEDENT_RXP = 'const addressRxp = /^https?:\\/\\/\\S+/i'

// ---------------------------------------------------------------------------
// 不变量 A：正则 1:1 + 地址行接线
// ---------------------------------------------------------------------------
const parityInvariants = (rawSync, rawIsEnable) => {
  const reasons = []
  const sync = stripComments(rawSync)
  const isEnable = stripComments(rawIsEnable)

  // A1 先例还在（参考工程那套口径在 W 里的落点）
  if (!isEnable.includes(PRECEDENT_RXP)) {
    reasons.push('IsEnable.tsx 的 addressRxp 不见了或改了样：它就是被复刻的那串口径，动了它「1:1」无从谈起')
  }
  // A2 新正则与先例同一串字面量（只换名字，不动模式）
  if (!sync.includes('const webdavAddressRxp = /^https?:\\/\\/\\S+/i')) {
    reasons.push('WebDAV 服务器地址的正则不是 /^https?:\\/\\/\\S+/i：必须与 IsEnable.tsx 的 addressRxp 同一串字面量（1:1 复刻）')
  }

  // A3 地址行接线：走专用处理函数 + inputMode
  const urlRowAt = sync.indexOf('label="服务器地址"')
  if (urlRowAt < 0) {
    reasons.push('找不到「服务器地址」输入行（锚点漂移，先修脚本锚点）')
  } else {
    const row = sync.slice(urlRowAt, urlRowAt + 320)
    if (!row.includes('onChanged={handleWebdavUrlChanged}')) {
      reasons.push('「服务器地址」行没有接到 handleWebdavUrlChanged：非法串会照旧直接落盘')
    }
    if (!row.includes('inputMode="url"')) {
      reasons.push('「服务器地址」行没有 inputMode="url"（IsEnable.tsx 的地址行有，这是同一条口径）')
    }
  }

  // A4 另外三行仍是通用处理函数（别被 URL 校验误伤）
  for (const key of ['sync.webdav.username', 'sync.webdav.password', 'sync.webdav.path']) {
    if (!sync.includes(`handleWebdavSettingChanged('${key}')`)) {
      reasons.push(`${key} 那行不再走通用 handleWebdavSettingChanged：用户名/密码/同步路径不是 URL，不能被前缀校验吞掉`)
    }
  }
  if (sync.includes("handleWebdavSettingChanged('sync.webdav.url')")) {
    reasons.push("服务器地址又走回通用 handleWebdavSettingChanged('sync.webdav.url')：等于取消校验")
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：专用处理函数的行为（合法 trim / 非法清空 + 提示 / 落盘 + 重置客户端）
// ---------------------------------------------------------------------------
const handlerInvariants = (rawSync, rawLang) => {
  const reasons = []
  const sync = stripComments(rawSync)
  const lang = stripComments(rawLang)

  const body = (() => {
    const sig = 'const handleWebdavUrlChanged = useCallback('
    const start = sync.indexOf(sig)
    if (start < 0) return null
    const braceStart = sync.indexOf('{', start + sig.length)
    if (braceStart < 0) return null
    let depth = 0
    for (let i = braceStart; i < sync.length; i++) {
      if (sync[i] === '{') depth++
      else if (sync[i] === '}') {
        depth--
        // 依赖数组在箭头函数体的收尾大括号**之后**，所以连尾巴一起切进来
        if (depth === 0) return sync.slice(start, i + 40)
      }
    }
    return null
  })()

  if (!body) return ['找不到 handleWebdavUrlChanged（锚点漂移或函数被删）']

  if (!body.includes('if (webdavAddressRxp.test(text)) url = text.trim()')) {
    reasons.push('合法分支不是「正则通过才 trim 落盘」：与 IsEnable.tsx 的 setHostAddress 口径不一致')
  }
  if (!body.includes("toast(t('setting_sync_host_value_error_tip'), 'long')")) {
    reasons.push('非法输入的提示丢了：用户会看到输入框被清空却不知道为什么（IsEnable.tsx 同一条提示）')
  }
  if (!/else\s*\{[\s\S]*?url = ''/.test(body)) {
    reasons.push('非法分支没有把值清空：非法地址会继续留在输入框 / 设置里')
  }
  if (countOf(body, 'callback(url)') !== 1) {
    reasons.push('callback(url) 必须恰好一次且对所有分支生效：漏了它输入框显示与实际值会分叉')
  }
  if (!body.includes("updateSetting({ 'sync.webdav.url': url })")) {
    reasons.push('没有把校验后的地址写进设置项')
  }
  if (!body.includes('resetClient()')) {
    reasons.push('换地址后没有 resetClient()：webdav 客户端还握着旧地址，之后所有请求打到旧服务器')
  }
  if (!body.includes('if (url === webdavUrl) return')) {
    reasons.push('缺少「值没变就不写」的短路：每次输入都会 updateSetting + 重置客户端，输入一个字就重建一次连接')
  }
  if (!body.includes('useCallback')) {
    reasons.push('处理函数不是 useCallback：输入行每次渲染都换新的 onChanged，会拖慢输入')
  }
  if (!body.includes('[webdavUrl, t]')) {
    reasons.push('useCallback 依赖不是 [webdavUrl, t]：闭包会读到旧地址（短路判断失效）')
  }
  if (!lang.includes('"setting_sync_host_value_error_tip"')) {
    reasons.push('zh-cn.json 里没有 setting_sync_host_value_error_tip：toast 会显示空串（t() 找不到 key）')
  }
  if (!sync.includes("import { useI18n } from '@/lang'")) {
    reasons.push("缺 useI18n 导入：t('setting_sync_host_value_error_tip') 会编译不过")
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
const tamper = (src, from, to) => {
  if (!src.includes(from)) throw new Error('反例锚点未命中: ' + from.slice(0, 70))
  return src.replace(from, to)
}

const runCounterExamples = () => {
  const results = []
  const check = (name, reasons, expectKeyword) => {
    const hit = reasons.some((r) => r.includes(expectKeyword))
    results.push({ name, ok: hit, detail: hit ? '已拦下' : '未拦下（缺失期望理由：' + expectKeyword + '）' })
  }

  check('m1 地址行改回通用处理函数', parityInvariants(tamper(REAL.sync,
    'onChanged={handleWebdavUrlChanged}', "onChanged={handleWebdavSettingChanged('sync.webdav.url')}"), REAL.isEnable),
  'handleWebdavUrlChanged')

  check('m2 正则改窄（去掉 \\S+）', parityInvariants(tamper(REAL.sync,
    'const webdavAddressRxp = /^https?:\\/\\/\\S+/i', 'const webdavAddressRxp = /^https?:\\/\\//i'), REAL.isEnable),
  '同一串字面量')

  check('m3 inputMode 被删', parityInvariants(tamper(REAL.sync,
    '          inputMode="url"\n', ''), REAL.isEnable),
  'inputMode')

  check('m4 非法分支不再清空', handlerInvariants(tamper(REAL.sync,
    "      url = ''\n", '      url = text\n'), REAL.lang),
  '没有把值清空')

  check('m5 提示被删', handlerInvariants(tamper(REAL.sync,
    "      if (text) toast(t('setting_sync_host_value_error_tip'), 'long')\n", ''), REAL.lang),
  '提示丢了')

  check('m6 换地址后不再重置客户端', handlerInvariants(tamper(REAL.sync,
    '    updateSetting({ \'sync.webdav.url\': url })\n    resetClient()\n', "    updateSetting({ 'sync.webdav.url': url })\n"), REAL.lang),
  'resetClient()')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-webdav-url-parity ===')
console.log('WebDAV「服务器地址」前缀校验与参考工程 1:1（第 33 轮第 2 条）')
console.log()

const checks = [
  ['正则 1:1 + 服务器地址行接线 + 另外三行不被误伤', () => parityInvariants(REAL.sync, REAL.isEnable)],
  ['handleWebdavUrlChanged 行为（trim / 清空 + 提示 / 落盘 + resetClient / 短路）', () => handlerInvariants(REAL.sync, REAL.lang)],
]

let invOk = true
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    console.log(`[${name}] PASS`)
  } else {
    invOk = false
    console.log(`[${name}]`)
    ;[...new Set(reasons)].forEach((r) => console.log('  FAIL ' + r))
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
console.log()
console.log(`结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${invOk ? checks.length : checks.length - 1}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
