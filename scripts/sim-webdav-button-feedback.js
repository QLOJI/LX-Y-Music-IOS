#!/usr/bin/env node
/**
 * sim-webdav-button-feedback.js —— WebDAV 六个按钮的「一定有反馈 + 一定不会锁死」契约（第 33 轮第 3 条）
 *
 * 需求原话（2026-10-08 第 33 轮第 3 条）：
 *   「WebDAV服务部分，点击测试连接后没有任何提示连接成功或者失败文字，而且存在测试连接、
 *     立即同步歌单、上传设置与音源与音源、上传歌单、下载歌单等按钮点击后，上面文字没有
 *     显示加载中的情况，然后出现我再点击所有按钮全部锁死，点击后没有任何反应的问题」
 *
 * 三个症状，各有根因（全部来自读源码）：
 *   ① 「点击后没有任何提示、没有加载中」—— 设置页 `sync.webdav.enable` 默认 false
 *      （defaultSetting.ts:191），而六个按钮全是 `disabled={!isEnableWebdav || isXxx}`，
 *      整块还套着 `opacity: isEnableWebdav ? 1 : 0.5`。开关没勾时：按下被吞、处理函数根本不跑，
 *      既不会有「测试中.../同步中...」这些加载文案，也不会有任何 toast。点了当然「没有任何反应」。
 *   ② 「按钮锁死」—— 四个手动动作的处理函数是 `setIsXxx(true) → await … → setIsXxx(false)`
 *      直筒写法，没有 try/finally：任何一次抛错都会跳过复位，按钮永远停在「上传中...」并保持禁用。
 *   ③ 「全部锁死」—— core/sync/webdavSync.ts 的模块级 `isSyncing` 原本写在 try **外面**、
 *      紧跟着一句 toast：这一小段一旦出岔子，标记永久停在 true，此后四个手动动作 + 自动同步
 *      全部只回一句「正在同步中，请稍后...」。
 *      另外 utils/tools.ts 的 toast 浮层 Promise 没有 catch：浮层创建失败就是 unhandled
 *      rejection + 提示静默消失（连「连接失败」这种话都看不到），currentToastId 还会停在旧值上。
 *   附带：utils/webdav.ts 的 testConnection 以前没有超时（服务器半死不活时 Promise 永不 settle，
 *      按钮永远停在「测试中...」），而且只探根目录 `/` 而不是用户真正要用的「同步路径」。
 *
 * 本轮口径（三条一起钉）：
 *   一、Sync 页六个动作按钮**不因「未启用」而假禁用**：`disabled` 只由各自的 loading 标记决定，
 *      动作按钮区不再半透明；每个按钮都带「…中...」的加载文案；缺地址/用户名时测试连接先给
 *      明确提示（读 webdavSync 的门会给「请先启用并配置 WebDAV 同步」）。
 *   二、六个处理函数的 loading 标记**一律在 try/finally 里复位**。
 *   三、模块级锁与提示链路都不许再卡住：webdavSync 的 `isSyncing = true` 必须在 try 内；
 *      tools.ts 的 toast 浮层 Promise 必须有 catch + 一次重试（且 dismiss 后的重试必须走箭头
 *      函数——`.finally(showOverlay)` 会把 resolve 值当参数传进重试开关，等于永远不重试）。
 *
 * 为什么必须靠契约脚本：这三条都是「点了没反应」的形态 —— 编译通过、页面正常、没有任何报错，
 * tsc/eslint 对 disabled 的真假、loading 有没有复位、Promise 有没有 catch 全部无感。
 * 谁把 `!isEnableWebdav` 加回 disabled、把 finally 拿掉、把 isSyncing 挪出 try、或把 toast 的
 * catch 删掉，脚本立刻红。带反例自检（m1–m8）。
 *
 * 运行：node scripts/sim-webdav-button-feedback.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去块注释与整行 `//` 注释（锚点里有 `//` 会误伤，本文件不涉及；但注释里有 disabled / toast
// 这样的词，必须剥掉才能按「代码」计数）
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

/** 抽「以 signature 开头、后接大括号体」的函数/箭头函数体（按大括号配平）。同 sim-progress-poll-foreground-gate.js 的助手。 */
const extractBracedBody = (src, signature) => {
  const start = src.indexOf(signature)
  if (start < 0) return null
  const braceStart = src.indexOf('{', start + signature.length)
  if (braceStart < 0) return null
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

const countOf = (src, needle) => src.split(needle).length - 1

const F = {
  sync: 'src/screens/Home/Views/Setting/settings/Sync/index.tsx',
  webdav: 'src/utils/webdav.ts',
  webdavSync: 'src/core/sync/webdavSync.ts',
  tools: 'src/utils/tools.ts',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// 六个按钮的 loading 标记（顺序 = 页面上的顺序）
const BUTTONS = [
  { name: '测试连接', flag: 'isTesting', label: '测试中...' },
  { name: '立即同步歌单', flag: 'isSyncing', label: '同步中...' },
  { name: '上传设置与音源', flag: 'isUploading', label: '上传中...' },
  { name: '下载设置与音源', flag: 'isDownloading', label: '下载中...' },
  { name: '上传歌单', flag: 'isUploadingLists', label: '上传中...' },
  { name: '下载歌单', flag: 'isDownloadingLists', label: '下载中...' },
]

const HANDLERS = [
  { name: '测试连接', sig: 'const handleTestConnection = useCallback(async() =>', reset: 'setIsTesting(false)' },
  { name: '立即同步歌单', sig: 'const handleSyncNow = useCallback(async() =>', reset: 'setIsSyncing(false)' },
  { name: '上传设置与音源', sig: 'const handleUpload = useCallback(async() =>', reset: 'setIsUploading(false)' },
  { name: '下载设置与音源', sig: 'const handleDownload = useCallback(async() =>', reset: 'setIsDownloading(false)' },
  { name: '上传歌单', sig: 'const handleUploadLists = useCallback(async() =>', reset: 'setIsUploadingLists(false)' },
  { name: '下载歌单', sig: 'const handleDownloadLists = useCallback(async() =>', reset: 'setIsDownloadingLists(false)' },
]

// ---------------------------------------------------------------------------
// 不变量 A：Sync 页 —— 按钮不假禁用 + 有加载文案 + 缺配置先给提示
// ---------------------------------------------------------------------------
const pageInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // 动作按钮区的锚点：`styles.btnRow` 被勾选行和按钮行共用，所以先用「第一个 btnCell」定位，
  // 再回退到它前面那个 btnRow —— 否则会切到勾选行那一块（那里的 !isEnableWebdav 是合法的：
  // 「播放历史 / 下载任务」这两个子开关本来就跟着启用状态走）
  const firstCell = code.indexOf('<View style={styles.btnCell}>')
  const firstRow = firstCell < 0 ? -1 : code.lastIndexOf('<View style={styles.btnRow}>', firstCell)
  const lastSync = code.indexOf('上次歌单同步时间')
  if (firstRow < 0 || lastSync < 0 || lastSync < firstRow) {
    return ['按钮区锚点漂移（找不到按钮行 btnRow+btnCell 或「上次歌单同步时间」）']
  }
  const region = code.slice(firstRow, lastSync)

  if (region.includes('!isEnableWebdav')) {
    reasons.push('动作按钮又回到「未启用 WebDAV 就 disabled」的假禁用：开关默认就是关的，'
      + '按下去没有加载文案、没有任何提示（用户第 33 轮第 3 条的原症状）')
  }
  for (const b of BUTTONS) {
    const want = `disabled={${b.flag}}`
    const n = countOf(region, want)
    if (n !== 1) {
      reasons.push(`「${b.name}」的 disabled 应恰好是 ${want}（出现 ${n} 次）：`
        + '只能由它自己的 loading 标记决定，不能再叠加其它门')
    }
  }
  // 加载文案：六个按钮都要有 `flag ? 'xxx中...' : '原文案'` 的三元
  for (const b of BUTTONS) {
    if (!region.includes(b.label)) {
      reasons.push(`「${b.name}」少了「${b.label}」加载文案（用户原话「上面文字没有显示加载中的情况」）`)
    }
  }
  if (countOf(code, 'opacity: isEnableWebdav ? 1 : 0.5') !== 1) {
    reasons.push('「未启用就半透明」的块应只剩 1 处（勾选项那块）：动作按钮区不该再被置灰——'
      + '半透明会被读成「按钮坏了」，与「始终可点、点了必有反馈」矛盾')
  }
  if (!code.includes("if (!webdavUrl.trim() || !webdavUsername.trim()) {")) {
    reasons.push('测试连接缺「先填地址和用户名」的前置检查：缺配置时它只会抛「WebDAV 未配置」，'
      + '用户读到的是「连接失败: WebDAV 未配置」，不如直说缺什么')
  }
  if (!code.includes("toast('请先填写服务器地址和用户名', 'long')")) {
    reasons.push('缺配置的提示文案不见了')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：六个处理函数的 loading 标记一律在 try/finally 里复位
// ---------------------------------------------------------------------------
const handlerInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  for (const h of HANDLERS) {
    const body = extractBracedBody(code, h.sig)
    if (!body) {
      reasons.push(`找不到「${h.name}」处理函数体（锚点漂移，先修脚本锚点）`)
      continue
    }
    if (!/try\s*\{/.test(body)) {
      reasons.push(`「${h.name}」没有 try：抛错会跳过 loading 复位，按钮永久停在「…中...」并保持禁用`)
    }
    if (!/\}\s*finally\s*\{[\s\S]*\}/.test(body)) {
      reasons.push(`「${h.name}」没有 finally：loading 标记不是「所有路径都会复位」`)
    }
    if (!body.includes(h.reset)) {
      reasons.push(`「${h.name}」的复位语句 ${h.reset} 不在处理函数体内`)
    }
    if (!body.includes('catch')) {
      reasons.push(`「${h.name}」没有 catch：失败时用户看不到原因（第 28 轮 WebDAV 下载菜单已立过同一条口径：失败必须给具体原因，不许静默）`)
    }
  }

  // 复位语句必须落在 finally 里（而不是 try 的末尾）——否则 throw 之后照样跳过
  for (const h of HANDLERS) {
    const body = extractBracedBody(code, h.sig)
    if (!body) continue
    const finallyAt = body.search(/\}\s*finally\s*\{/)
    if (finallyAt >= 0 && body.indexOf(h.reset) < finallyAt) {
      reasons.push(`「${h.name}」的 ${h.reset} 写在 finally 之前：抛错时不会执行，等于没复位`)
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：testConnection 有超时、探同步路径、404 不算失败、结果进日志
// ---------------------------------------------------------------------------
const testConnectionInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  const body = extractBracedBody(code, 'export async function testConnection(')
  if (!body) return ['找不到 testConnection 函数体（锚点漂移，先修脚本锚点）']

  if (!/testConnection\(timeoutMs = \d+\)/.test(body)) {
    reasons.push('testConnection 没有超时形参：服务器 TCP 连得上却不回包时，Promise 永不 settle，'
      + '按钮永远停在「测试中...」且保持禁用（用户第 33 轮第 3 条「没有任何提示」的一种成因）')
  }
  if (!body.includes('withTimeout(')) {
    reasons.push('testConnection 没有套 withTimeout：没有超时保护')
  }
  if (!code.includes('function withTimeout<T>(')) {
    reasons.push('缺 withTimeout 助手')
  }
  if (!body.includes('sync.webdav.path')) {
    reasons.push('测试连接只探根目录：用户真正要用的是「同步路径」，只开放子目录的服务器会被误判成连接失败')
  }
  if (!body.includes('probePath')) {
    reasons.push('testConnection 里没有 probePath（探测目标未按同步路径计算）')
  }
  if (!body.includes('error?.status === 404')) {
    reasons.push('404/409 未被当成「服务器可达、目录还没建」：首次同步前测试连接会误报失败')
  }
  if (!body.includes('webDAVLog.error(') || !body.includes('webDAVLog.info(')) {
    reasons.push('测试连接的成功/失败没有写 WebDAV 日志（用户报「没有任何提示」时没法定位）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：webdavSync 的模块级 isSyncing 不许再卡死
// ---------------------------------------------------------------------------
const syncLockInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  const FUNCS = [
    'export async function manualUploadSettingsAndApis()',
    'export async function manualDownloadSettingsAndApis()',
    'export async function manualUploadLists()',
    'export async function manualDownloadLists()',
    'export async function triggerWebDAVSync(isManual = false)',
  ]
  let guarded = 0
  for (const sig of FUNCS) {
    const body = extractBracedBody(code, sig)
    if (!body) {
      reasons.push(`找不到 ${sig}（锚点漂移，先修脚本锚点）`)
      continue
    }
    const tryAt = body.search(/try\s*\{/)
    const flagAt = body.indexOf('isSyncing = true')
    if (flagAt < 0) {
      reasons.push(`${sig} 里没有 isSyncing = true（锚点漂移？）`)
      continue
    }
    if (tryAt < 0 || flagAt < tryAt) {
      reasons.push(`${sig}：isSyncing = true 写在 try 外面 —— 这一小段（含紧随其后的 toast）`
        + `一旦出岔子，标记永久停在 true，之后所有手动动作与自动同步都只回「正在同步中，请稍后...」`
        + `（用户原话「所有按钮全部锁死，点击后没有任何反应」）`)
    } else {
      guarded++
    }
    if (!body.includes('isSyncing = false')) {
      reasons.push(`${sig} 里没有 isSyncing = false（finally 里必须复位）`)
    }
  }
  if (guarded !== FUNCS.length) {
    reasons.push(`isSyncing = true 进 try 的函数 ${guarded}/${FUNCS.length}`)
  }
  // 未启用 / 未配置时必须有可见提示（这是「按钮始终可点」之后的反馈来源）
  if (countOf(code, "'请先启用并配置 WebDAV 同步'") < 5) {
    reasons.push('「请先启用并配置 WebDAV 同步」的提示少于 5 处：'
      + '按钮不再假禁用之后，这条提示就是「未启用时点按钮」的唯一反馈，缺一处就是又一处静默')
  }
  if (countOf(code, "'正在同步中，请稍后...'") < 5) {
    reasons.push('「正在同步中，请稍后...」的提示少于 5 处（并发点击时的反馈）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 E：toast 浮层不许静默失败
// ---------------------------------------------------------------------------
const toastInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!code.includes('}).catch((err: any) => {')) {
    reasons.push('toast 的 showOverlay Promise 没有 catch：浮层创建失败就是 unhandled rejection，'
      + '提示静默消失（连「连接失败」都看不到），且 currentToastId 会停在旧值上')
  }
  if (!code.includes('[toast] overlay 创建失败')) {
    reasons.push('toast 浮层失败没有日志（用户报「没有任何提示」时无从定位）')
  }
  if (!code.includes('setTimeout(() => { showOverlay(false) }, 250)')) {
    reasons.push('toast 浮层失败没有重试：瞬时争用（上一次浮层还没销毁 / 正在切导航）会让这一条提示直接丢掉')
  }
  if (!code.includes('.finally(() => { showOverlay() })')) {
    reasons.push('dismiss 之后的重新弹出必须写成箭头函数：`.finally(showOverlay)` 会把 '
      + 'dismissOverlay 的 resolve 值（undefined）当成 allowRetry 参数传进去，重试分支永远不走')
  }
  if (code.includes('.finally(showOverlay)')) {
    reasons.push('又出现 `.finally(showOverlay)` 裸传：重试开关会被 resolve 值污染')
  }
  if (!/let toastSeq = 0/.test(code)) {
    reasons.push('缺 toastSeq 序号：失败重试可能把过期提示（如「正在测试连接...」）补在结果提示之后')
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

  // m1 恢复「未启用就 disabled」的假禁用（第一颗按钮）
  check('m1 「测试连接」退回 !isEnableWebdav 假禁用', pageInvariants(tamper(REAL.sync,
    'disabled={isTesting}', 'disabled={!isEnableWebdav || isTesting}')),
  '假禁用')

  // m2 删掉「同步中...」加载文案
  check('m2 删掉「立即同步歌单」的加载文案', pageInvariants(tamper(REAL.sync,
    "{isSyncing ? '同步中...' : '立即同步歌单'}", "'立即同步歌单'")),
  '少了')

  // m3 动作按钮区又套回 0.5 半透明
  check('m3 按钮区又置灰', pageInvariants(tamper(REAL.sync,
    '        <View>\n          {/* 【第 23 轮】',
    '        <View style={{ opacity: isEnableWebdav ? 1 : 0.5 }}>\n          {/* 【第 23 轮】')),
  '只剩 1 处')

  // m4 上传按钮退回「三行直筒」写法（无 try/finally）
  // 【第 35 轮第 2 条】六个处理函数各加了起止/失败三条状态行（setSyncMessage），
  // 锚点随之更新；反例拆的仍是「这段到底还有没有 try/finally」，语义不变。
  check('m4 「上传设置与音源」去掉 try/finally', handlerInvariants(tamper(REAL.sync,
    "    setIsUploading(true)\n    setSyncMessage('正在上传设置与音源...')\n    try {\n      await manualUploadSettingsAndApis()\n      setSyncMessage('设置与音源上传完成')\n    } catch (error: any) {\n      toast(`上传失败: ${error?.message ?? error}`, 'long')\n      setSyncMessage('设置与音源上传失败，详情见下方提示')\n    } finally {\n      setIsUploading(false)\n    }",
    "    setIsUploading(true)\n    setSyncMessage('正在上传设置与音源...')\n    await manualUploadSettingsAndApis()\n    setSyncMessage('设置与音源上传完成')\n    setIsUploading(false)")),
  '没有 try')

  // m5 testConnection 退回无超时的裸调用
  check('m5 testConnection 退回无超时', testConnectionInvariants(tamper(REAL.webdav,
    '    await withTimeout(\n      cli.getDirectoryContents(probePath) as Promise<unknown>,\n      timeoutMs,\n      `连接超时（${Math.round(timeoutMs / 1000)} 秒内服务器没有响应）`,\n    )',
    "    await cli.getDirectoryContents('/')")),
  'withTimeout')

  // m6 isSyncing 挪出 try（回到「永久锁死」形态）
  check('m6 isSyncing 挪回 try 外', syncLockInvariants(tamper(REAL.webdavSync,
    "  try {\n    isSyncing = true\n    toast('开始上传...')",
    "  isSyncing = true\n  toast('开始上传...')\n  try {")),
  'try 外面')

  // m7 toast 的 catch 被删
  check('m7 toast 浮层失败不再兜底', toastInvariants(tamper(REAL.tools,
    "    }).catch((err: any) => {", '    })\n    /* removed */((err: any) => {')),
  '没有 catch')

  // m8 dismiss 后的重试退回裸传（重试永不生效）
  check('m8 重试退回 .finally(showOverlay)', toastInvariants(tamper(REAL.tools,
    '.finally(() => { showOverlay() })', '.finally(showOverlay)')),
  '裸传')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-webdav-button-feedback ===')
console.log('WebDAV 六按钮：点了必有反馈 + 加载中一定复位 + 模块级锁与提示链路都不许卡死（第 33 轮第 3 条）')
console.log()

const checks = [
  ['Sync 页（按钮不假禁用 + 六个加载文案 + 按钮区不再置灰 + 缺配置先给提示）',
    () => pageInvariants(REAL.sync)],
  ['六个处理函数（loading 标记一律 try/finally 复位 + 失败给原因）',
    () => handlerInvariants(REAL.sync)],
  ['testConnection（超时 + 探同步路径 + 404 容忍 + 日志）',
    () => testConnectionInvariants(REAL.webdav)],
  ['webdavSync（isSyncing 进 try + 未启用/并发点击都有可见提示）',
    () => syncLockInvariants(REAL.webdavSync)],
  ['toast（浮层失败有 catch/日志/一次重试，且重试不被 resolve 值污染）',
    () => toastInvariants(REAL.tools)],
]

let invOk = true
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    console.log(`\n[${name}]\n  PASS`)
  } else {
    invOk = false
    console.log(`\n[${name}]`)
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
console.log(`结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length - (invOk ? 0 : 1)}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
