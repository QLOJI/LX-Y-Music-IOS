#!/usr/bin/env node
/**
 * sim-webdav-manual-outcome.js —— WebDAV 手动动作的**结果**必须如实反映到状态行（第 54 轮第 1 条）
 *
 * 需求原话（2026-10-11 第 54 轮第 1 条）：
 *   「在数据同步的WebDAV功能中，当我点击上传设置与音源、下载设置与音源、上传歌单、下载歌单，
 *     然后再弹窗选择我不时，WebDAV状态应该显示已取消上传或者下载，目前无论点击弹窗中的按钮，
 *     都会显示上传完成，这是有问题的」。
 *
 * 病灶（读源码）：`src/core/sync/webdavSync.ts` 的四个手动函数在**五种「没真的做」的出口**上
 * 全部是**静默 return**（或者在 catch 里把错误吞掉后正常结束）：
 *   ① 用户点弹窗上的「我不」—— `if (!confirm) return`（就是用户报的这一幕）；
 *   ② 另一个 WebDAV 任务在跑 —— 模块级 `isSyncing` 门；
 *   ③ 没启用 / 没配服务器地址 —— 配置门；
 *   ④ 「同步服务地址」正在协商歌单 —— 让行门（waitForListNegotiation）；
 *   ⑤ 执行中抛错 —— 内层 catch 只弹 toast + 记日志，不往外抛。
 * 而 `src/screens/Home/Views/Setting/settings/Sync/index.tsx` 的六个处理函数一律写成
 * 「`await manualXxx()` 没抛错 ⇒ 写『…完成』」—— 调用方**根本分不出**上面五种情况，
 * 于是「取消」被显示成「上传完成」。`triggerWebDAVSync`（立即同步歌单）同病：
 * 「首次同步确认」「同步冲突」两个弹窗里选取消，也只 toast 不改状态行。
 *
 * 本轮口径（两条一起钉）：
 *   一、lib 侧：五个函数都回传 `WebdavManualOutcome`（success / canceled / busy / disabled /
 *      negotiating / empty / failed），**每一个出口都必须回传自己的结果**，一个静默 return 都不许留；
 *      每个出口该有几处也钉死 —— `triggerWebDAVSync` 有**两个**取消弹窗（「首次同步确认」与
 *      「同步冲突」），只查「出现过 canceled」的话，吞掉其中一个照样能蒙混过关。
 *   二、页面侧：五个处理函数拿到结果后交给 `webdavOutcomeText(outcome, what, verb)` 翻译成
 *      状态行文案；取消 → 「已取消上传 / 已取消下载」（用户原话），未执行 → 「未…：原因」，
 *      成功 / 失败两句与第 35/36 轮定下的文案一字不差（既有契约钉着它们）。
 *
 * 为什么必须靠契约脚本：这是**数据流**上的契约 —— lib 回传什么、页面怎么翻译，全靠约定。
 * 编译通过、页面正常、没有任何报错；谁把 `return 'canceled'` 退回裸 `return`、把返回类型删掉、
 * 或在页面里把「按结果写」改回写死「…完成」，症状与用户今天报的一模一样，而 tsc/eslint 全无感。
 * 带反例自检（n1–n11），锚点必须全文唯一（tamper 里断言命中数 === 1）。
 *
 * 运行：node scripts/sim-webdav-manual-outcome.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去块注释与整行 `//` 注释 —— 注释里写着 `if (!confirm) return`（病灶说明），
// 不剥掉就会当成代码命中，计数全错。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => (/^\s*\/\//.test(line) ? '' : line))
  .join('\n')

/** 抽「以 signature 开头、后接大括号体」的函数/箭头函数体（按大括号配平）。 */
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
  lib: 'src/core/sync/webdavSync.ts',
  page: 'src/screens/Home/Views/Setting/settings/Sync/index.tsx',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

// lib 侧五个函数 + 各自**每个出口该有几处**回传。
// 只查「有没有出现过某结果」是不够的 —— triggerWebDAVSync 里有两处取消（「首次同步确认」
// 和「同步冲突」两个弹窗），吞掉其中一处，另一处照样让「出现过 canceled」成立，
// 反例 n5 / n6 就是这么漏的。所以这里按**逐出口计数**钉死。
// 'empty' 只属于两个下载动作；'negotiating' 只属于碰歌单的三个动作。
const LIB_FUNCS = [
  { name: 'manualUploadSettingsAndApis', sig: 'export async function manualUploadSettingsAndApis()',
    exits: { busy: 1, disabled: 1, canceled: 1, success: 1, failed: 1 } },
  { name: 'manualDownloadSettingsAndApis', sig: 'export async function manualDownloadSettingsAndApis()',
    exits: { busy: 1, disabled: 1, canceled: 1, success: 1, failed: 1, empty: 1 } },
  { name: 'manualUploadLists', sig: 'export async function manualUploadLists()',
    exits: { busy: 1, disabled: 1, negotiating: 1, canceled: 1, success: 1, failed: 1 } },
  { name: 'manualDownloadLists', sig: 'export async function manualDownloadLists()',
    exits: { busy: 1, disabled: 1, negotiating: 1, canceled: 1, success: 1, failed: 1, empty: 1 } },
  // triggerWebDAVSync 的 success 有 3 处（首次同步「传」「下」各一处 + 正常走完一处），
  // canceled 有 2 处（两个弹窗各一处）—— 这正是「缺席的取消」最容易藏身的地方。
  { name: 'triggerWebDAVSync', sig: 'export async function triggerWebDAVSync(isManual = false)',
    exits: { busy: 1, disabled: 1, negotiating: 1, canceled: 2, success: 3, failed: 1 } },
]

const OUTCOME_MEMBERS = ['success', 'canceled', 'busy', 'disabled', 'negotiating', 'empty', 'failed']

// 页面侧五个处理函数 → 它调的函数 / 状态行里该写的「对象 + 动作」
const PAGE_HANDLERS = [
  { name: '立即同步歌单', sig: 'const handleSyncNow = useCallback(async() =>',
    call: 'triggerWebDAVSync(true)', what: '歌单', verb: '同步' },
  { name: '上传设置与音源', sig: 'const handleUpload = useCallback(async() =>',
    call: 'manualUploadSettingsAndApis()', what: '设置与音源', verb: '上传' },
  { name: '下载设置与音源', sig: 'const handleDownload = useCallback(async() =>',
    call: 'manualDownloadSettingsAndApis()', what: '设置与音源', verb: '下载' },
  { name: '上传歌单', sig: 'const handleUploadLists = useCallback(async() =>',
    call: 'manualUploadLists()', what: '歌单', verb: '上传' },
  { name: '下载歌单', sig: 'const handleDownloadLists = useCallback(async() =>',
    call: 'manualDownloadLists()', what: '歌单', verb: '下载' },
]

// ---------------------------------------------------------------------------
// 不变量 A：lib 侧 —— 五个函数都回传结果，且每个出口都回传自己的那一支
// ---------------------------------------------------------------------------
const outcomeTypeInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!code.includes('export type WebdavManualOutcome =')) {
    reasons.push('lib 没有导出结果联合类型 WebdavManualOutcome：调用方只能靠「有没有抛错」猜，'
      + '而四个手动函数在取消 / 正忙 / 未配置 / 让行 / 出错这五种出口上一个都不抛')
  }
  for (const m of OUTCOME_MEMBERS) {
    if (!code.includes(`| '${m}'`)) {
      reasons.push(`结果类型里缺 '${m}'：这一种结局没有名字，页面就只能笼统写「完成」或「失败」`)
    }
  }
  for (const f of LIB_FUNCS) {
    if (!code.includes(`${f.sig}: Promise<WebdavManualOutcome>`)) {
      reasons.push(`「${f.name}」没有声明返回类型 Promise<WebdavManualOutcome>：`
        + '调用方拿不到结果，又会退回「没抛错就是成功」')
    }
    const body = extractBracedBody(code, f.sig)
    if (!body) {
      reasons.push(`找不到「${f.name}」函数体（锚点漂移，先修脚本锚点）`)
      continue
    }
    for (const [e, want] of Object.entries(f.exits)) {
      const got = countOf(body, `return '${e}'`)
      if (got !== want) {
        reasons.push(`「${f.name}」的 '${e}' 出口是 ${got} 处（应为 ${want} 处）：`
          + '少一处就是那次操作又在静默 return，页面会把它显示成「完成」'
          + '（用户第 54 轮报的就是这种「没做却报完成」）')
      }
    }
    // 兜底网：这几个函数里不许出现**裸 return**（不带结果的出口）。
    // 上面按出口计数能挡住「已知的出口被吞」，这条挡的是「又新加了一个静默出口」。
    const bare = body.split('\n').filter((line) => /\breturn\s*;?\s*$/.test(line)).length
    if (bare !== 0) {
      reasons.push(`「${f.name}」里有 ${bare} 处裸 return：这些出口不带结果，`
        + '调用方只能当成「做完了」—— 本函数的每一个 return 都必须回传 WebdavManualOutcome')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：lib 侧 —— 「取消」「让行」两个出口尤其不许裸 return
// ---------------------------------------------------------------------------
const silentExitInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  const guardTotal = (code.match(/if \(!confirm\)/g) || []).length
  const cancelReturns = countOf(code, "if (!confirm) return 'canceled'")
  if (guardTotal !== 4 || cancelReturns !== 4) {
    reasons.push(`取消出口（if (!confirm)）共 ${guardTotal} 处，其中回了 'canceled' 的只有 ${cancelReturns} 处：`
      + '剩下的取消出口又在静默 return —— 用户点弹窗上的「我不」，页面照样会写「上传完成」')
  }

  const negCalls = (code.match(/if \(!await waitForListNegotiation\([^)]*\)\) return/g) || []).length
  const negReturns = (code.match(/if \(!await waitForListNegotiation\([^)]*\)\) return 'negotiating'/g) || []).length
  if (negCalls !== 3 || negReturns !== 3) {
    reasons.push(`让行出口共 ${negCalls} 处，其中回了 'negotiating' 的只有 ${negReturns} 处：`
      + '让行时页面会以为「做完了」（第 34 轮第 1 条的让行门必须能被看见）')
  }

  // 四个「用户按了按钮、但这次什么都没做」的门：每处都得紧跟自己的回传，
  // 不许出现「toast 一句然后裸 return」的形态（toast 会消失，状态行才是留在屏幕上的那句）。
  const bareAfterToast = (code.match(/toast\('(?:正在同步中，请稍后\.\.\.|请先启用并配置 WebDAV 同步)'\)\n\s*return\n/g) || []).length
  if (bareAfterToast !== 0) {
    reasons.push(`有 ${bareAfterToast} 处「toast 完就裸 return」的出口：`
      + '提示浮层一消失就什么都不剩，状态行还停在「正在上传…」或更糟的「上传完成」')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：页面侧 —— 五个处理函数按结果写状态行，不许再写死「…完成」
// ---------------------------------------------------------------------------
const pageOutcomeInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  for (const h of PAGE_HANDLERS) {
    const body = extractBracedBody(code, h.sig)
    if (!body) {
      reasons.push(`找不到「${h.name}」处理函数体（锚点漂移，先修脚本锚点）`)
      continue
    }
    const want = `setWebdavStatus(webdavOutcomeText(outcome, '${h.what}', '${h.verb}'))`
    if (!body.includes(`const outcome = await ${h.call}`) || !body.includes(want)) {
      reasons.push(`「${h.name}」没有按结果写状态行：期望「const outcome = await ${h.call}」+「${want}」——`
        + '少一处就又回到「await 正常返回就写完成」的老病')
    }
    if (body.includes(`setWebdavStatus('${h.what}${h.verb}完成')`)) {
      reasons.push(`「${h.name}」把成功文案写死了（'${h.what}${h.verb}完成'）：`
        + '一旦用户取消 / 失败 / 未配置，状态行还是报完成 —— 就是用户第 54 轮报的 bug')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：页面侧 —— 翻译表（用户原话「已取消上传或者下载」+ 文案不含凭据）
// ---------------------------------------------------------------------------
const translateInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  const sig = 'const webdavOutcomeText = (outcome: WebdavManualOutcome, what: string, verb: string) =>'
  const body = extractBracedBody(code, sig)
  if (!body) {
    return ['找不到 webdavOutcomeText 翻译表（锚点漂移，或页面又直接把结果丢了）']
  }
  // 注意：这些 needle 里有反引号与 ${...}，必须用**双引号**字符串写（单引号串里反引号会开模板串）
  const wants = [
    ["case 'canceled': return `已取消${verb}`",
      '取消没翻成「已取消上传 / 已取消下载」——用户第 54 轮的原话就是这两句'],
    ["case 'success': return `${what}${verb}完成`",
      '成功文案不再是「…完成」（第 35/36 轮定下的句式，既有契约钉着）'],
    ["case 'failed': return `${what}${verb}失败，详情见下方提示`",
      '失败文案不再是「…失败，详情见下方提示」（失败详情只留在 toast 里）'],
    ["case 'busy': return `未${verb}：",
      "'busy'（正忙）没写成「未…：原因」——分不出「没执行」和「执行完了」"],
    ["case 'disabled': return `未${verb}：",
      "'disabled'（未启用 / 未配置）没写成「未…：原因」"],
    ["case 'negotiating': return `未${verb}：",
      "'negotiating'（让行）没写成「未…：原因」"],
    ["case 'empty': return `云端没有${what}文件，未${verb}`",
      "'empty'（云端没文件）没如实写出来"],
  ]
  for (const [needle, why] of wants) {
    if (!body.includes(needle)) reasons.push(`${why}（缺：${needle}）`)
  }
  // 第 25 轮凭据口径：状态行文案里不许出现地址 / 账号形态
  const bad = (body.match(/`[^`]*`/g) || []).filter((s) => /https?|\S@\S|\d+\.\d+\.\d+\.\d+/.test(s))
  if (bad.length) {
    reasons.push(`状态行文案里出现了地址 / 账号形态的内容（第 25 轮凭据口径）—— ${bad.slice(0, 2).join(' | ')}`)
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
// 【第 53 轮的教训】String.replace 只换第一处 —— 锚点必须全文唯一，否则反例可能打在别的地方，
// 变成「假通过」。这里直接断言命中数 === 1。
const tamper = (src, from, to) => {
  const n = countOf(src, from)
  if (n !== 1) throw new Error(`反例锚点不唯一（命中 ${n} 次）: ` + from.slice(0, 70))
  return src.replace(from, to)
}

const runCounterExamples = () => {
  const results = []
  const check = (name, reasons, expectKeyword) => {
    const hit = reasons.some((r) => r.includes(expectKeyword))
    results.push({ name, ok: hit, detail: hit ? '已拦下' : '未拦下（缺失期望理由：' + expectKeyword + '）' })
  }
  // 反例按「真跑一遍全套」的口径来：lib 侧两条不变量都过，页面侧两条不变量都过 ——
  // 否则「A 漏了、B 拦住了」会被误判成未拦下。
  const libChecks = (src) => [...outcomeTypeInvariants(src), ...silentExitInvariants(src)]
  const pageChecks = (src) => [...pageOutcomeInvariants(src), ...translateInvariants(src)]

  // n1 取消被写成「成功」（用户报的这一幕的镜像）
  check('n1 「确认上传」的取消回成 success', libChecks(tamper(REAL.lib,
    "  if (!confirm) return 'canceled'\n\n  // 【第 33 轮第 3 条】isSyncing = true 挪进 try",
    "  if (!confirm) return 'success'\n\n  // 【第 33 轮第 3 条】isSyncing = true 挪进 try")),
  "'canceled'")

  // n2 取消退回裸 return（第 54 轮之前的原始形态）
  check('n2 取消退回裸 return', libChecks(tamper(REAL.lib,
    "  if (!confirm) return 'canceled'\n\n  // 【第 33 轮第 3 条】isSyncing = true 挪进 try",
    "  if (!confirm) return\n\n  // 【第 33 轮第 3 条】isSyncing = true 挪进 try")),
  '裸 return')

  // n3 「未启用/未配置」出口丢结果（回到静默 return）
  check('n3 disabled 出口丢结果', libChecks(tamper(REAL.lib,
    "    toast('请先启用并配置 WebDAV 同步')\n    return 'disabled'\n  }\n\n  const confirm = await confirmDialog({\n    title: '确认上传',",
    "    toast('请先启用并配置 WebDAV 同步')\n    return\n  }\n\n  const confirm = await confirmDialog({\n    title: '确认上传',")),
  "'disabled'")

  // n4 让行出口丢结果
  check('n4 让行出口丢结果', libChecks(tamper(REAL.lib,
    "  if (!await waitForListNegotiation(true)) return 'negotiating'\n\n  const confirm = await confirmDialog({\n    title: '确认上传歌单',",
    "  if (!await waitForListNegotiation(true)) return\n\n  const confirm = await confirmDialog({\n    title: '确认上传歌单',")),
  'negotiating')

  // n5 「首次同步确认」弹窗里取消又被吞掉（立即同步歌单那条线）
  check('n5 首次同步确认的取消被吞', libChecks(tamper(REAL.lib,
    "          if (isManual) toast('同步已取消')\n          return 'canceled'",
    "          if (isManual) toast('同步已取消')\n          return")),
  "'canceled'")

  // n6 「同步冲突」弹窗里取消又被吞掉
  check('n6 同步冲突的取消被吞', libChecks(tamper(REAL.lib,
    "            webDAVLog.info('[Sync] Conflict resolution cancelled by user.')\n            toast('操作已取消')\n            return 'canceled'",
    "            webDAVLog.info('[Sync] Conflict resolution cancelled by user.')\n            toast('操作已取消')")),
  "'canceled'")

  // n7 返回类型丢了（函数回传 void，页面拿不到结果）
  check('n7 返回类型被删', libChecks(tamper(REAL.lib,
    'export async function manualUploadLists(): Promise<WebdavManualOutcome> {',
    'export async function manualUploadLists() {')),
  '返回类型')

  // n8 下载时「云端什么都没找到」又谎报完成
  check('n8 云端无文件不再回传 empty', libChecks(tamper(REAL.lib,
    "      toast('云端没有可下载的设置与音源文件')\n      return 'empty'",
    "      toast('云端没有可下载的设置与音源文件')")),
  "'empty'")

  // n9 页面回退成「await 完直接写完成」
  check('n9 页面回退「await 完直接写完成」', pageChecks(tamper(REAL.page,
    "      const outcome = await manualUploadSettingsAndApis()\n      setWebdavStatus(webdavOutcomeText(outcome, '设置与音源', '上传'))",
    "      await manualUploadSettingsAndApis()\n      setWebdavStatus('设置与音源上传完成')")),
  '按结果')

  // n10 页面把动作传错（点的是下载，取消时却显示「已取消上传」）
  check('n10 页面把动作传错', pageChecks(tamper(REAL.page,
    "      setWebdavStatus(webdavOutcomeText(outcome, '设置与音源', '下载'))",
    "      setWebdavStatus(webdavOutcomeText(outcome, '设置与音源', '上传'))")),
  '按结果')

  // n11 翻译表把「取消」翻成「完成」（用户原话那两句没了）
  check('n11 翻译表把取消翻成完成', pageChecks(tamper(REAL.page,
    "    case 'canceled': return `已取消${verb}`",
    "    case 'canceled': return `${what}${verb}完成`")),
  '已取消')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-webdav-manual-outcome ===')
console.log('WebDAV 手动动作的结果契约（第 54 轮第 1 条）：取消 → 已取消上传 / 已取消下载，')
console.log('正忙 / 未配置 / 让行 / 云端没文件 → 「未…：原因」，五个函数一个出口都不许静默 return')
console.log()

const checks = [
  ['lib：五个函数都回传 WebdavManualOutcome，每个出口都回传自己那一支',
    () => outcomeTypeInvariants(REAL.lib)],
  ['lib：取消 / 让行 / 并发 / 未配置四处出口不许裸 return',
    () => silentExitInvariants(REAL.lib)],
  ['页面：五个处理函数按结果写状态行（不许再写死「…完成」）',
    () => pageOutcomeInvariants(REAL.page)],
  ['页面：结果 → 状态行文案的翻译表（已取消上传 / 已取消下载 + 文案不含凭据）',
    () => translateInvariants(REAL.page)],
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
console.log(`结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${invOk ? checks.length : checks.length - 1}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
