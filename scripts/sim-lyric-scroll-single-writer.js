/**
 * ⑥ 「滚动唯一写者」契约（第六轮需求 6 的钉子）。
 *
 * 需求原话：歌词逐字加载动画要加强，防止歌词上下抖动、回跳、停在错误的位置。
 *
 * 第六轮的收敛结果（`src/screens/PlayDetail/Vertical/Lyric.tsx`）：
 *   播放中，歌词列表的偏移**只能由每帧连续滚动循环（scrollToActiveContinuous）写**。
 *   其余两条非强制定位（行高测量回正 scheduleRecentre、停手 1.5s 回位）不再自己发
 *   滚动，改为把「滑到 targetOffset」排进 pendingGlideRef，由循环按同一条 easeInOut
 *   轨迹落地。此前两路写者互抢同一个偏移 = 抖动 / 回跳 / 停在错误位置。
 *
 * 本脚本从源码解析实际结构（不硬编码行号），断言这套不变式还在：
 *   A. 两个 ref 声明在位，且带「单写者」不变式注释（防被后来的改动静默删掉）；
 *   B. 非强制分支在循环运行时**只排队、不滚**（块内不得出现任何 scrollToOffset），
 *      且这个守卫出现在该函数唯一写点之前；
 *   C. 硬跳（force：seek / 切歌 / 点歌词）清空排队；
 *   D. 循环消费排队请求；
 *   E. 循环存活标记：起 rAF 前置 true、cleanup 里复位（守卫的判据就是它）；
 *   F. 停手回位只有一条入口 armIdleReturn()，松手与惯性结束都走它，
 *      且 onMomentumScrollEnd 真的挂到了 FlatList 上；
 *   G. 换歌（lyricLines 变化）清空排队（旧歌词表算出的落点在新歌里没有意义）；
 *   H. 总账：全文件所有 scrollToOffset 写点都在白名单内，没有多出第三方写者；
 *   I. 反例自检：删掉排队分支 / 把惯性结束接成空实现 / 在非强制分支塞回一个写点，
 *      必须被判不合格。
 *
 * 运行：node scripts/sim-lyric-scroll-single-writer.js
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

const FILE = 'src/screens/PlayDetail/Vertical/Lyric.tsx'
const src = read(FILE)

/** 取一段块体：从 headerRe 命中处起，到第一个「缩进 = indent 个空格的 }」为止。
 *  indent 传块体的**闭合缩进**（嵌套 if 用 4，顶层 const 箭头函数用 2）。 */
const blockBody = (s, headerRe, indent = 4) => {
  const m = headerRe.exec(s)
  if (!m) return null
  const rest = s.slice(m.index + m[0].length)
  const end = new RegExp(`\\n {${indent}}\\}`).exec(rest)
  return end ? rest.slice(0, end.index) : null
}

// --- A. 声明 ---
const loopFlagDecl = /const isScrollLoopRunningRef = useRef\(false\)/.test(src)
const pendingDecl = /const pendingGlideRef = useRef<\{ index: number, target: number \} \| null>\(null\)/.test(src)
const invariantComment = /偏移\*\*只能由它写\*\*|单写者/.test(src)

// --- B. 非强制分支只排队不滚 ---
const enqueueBody = blockBody(src, /if \(!force && isScrollLoopRunningRef\.current\) \{/)
const enqueueQueues = !!enqueueBody && /pendingGlideRef\.current = \{ index, target: targetOffset \}/.test(enqueueBody)
const enqueueReturns = !!enqueueBody && /\breturn\b/.test(enqueueBody)
const enqueueWrites = !!enqueueBody && /scrollToOffset|scrollToIndex/.test(enqueueBody)

// 该函数唯一的写点：必须在排队守卫之后（守卫在前 = 先分流再写）
const firstWriteInHandler = /const handleScrollToActive = useCallback\([\s\S]*?flatListRef\.current\.scrollToOffset/.exec(src)
const guardBeforeWrite = !!(firstWriteInHandler && enqueueBody && firstWriteInHandler[0].includes(enqueueBody))

// --- C. 硬跳清队列 ---
const forceBody = blockBody(src, /if \(force\) \{/)
const forceClears = !!forceBody && /pendingGlideRef\.current = null/.test(forceBody)

// --- D. 循环消费 ---
const consumeBody = blockBody(src, /if \(pendingGlide\) \{/)
const consumeTakes = !!consumeBody && /pendingGlideRef\.current = null/.test(consumeBody) &&
  /continuousOffset = pendingGlide\.target/.test(consumeBody)
const consumeReads = /const pendingGlide = pendingGlideRef\.current/.test(src)

// --- E. 循环存活标记 ---
// 置位必须在起 rAF 之前（守卫的判据 = 真的起了 rAF），复位在 cleanup 里。
const setTrueAt = src.indexOf('isScrollLoopRunningRef.current = true')
const loopDefAt = src.indexOf('const loop = (ts: number) => {')
const rafAt = src.indexOf('rafId = requestAnimationFrame(loop)')
const setTrueBeforeRaf = setTrueAt > -1 && loopDefAt > setTrueAt && rafAt > loopDefAt
const resetInCleanup = /return \(\) => \{\n\s+isScrollLoopRunningRef\.current = false\n\s+cancelAnimationFrame\(rafId\)/.test(src)

// --- F. 停手回位单一入口 ---
const armDef = /const armIdleReturn = \(\) => \{/.test(src)
const armCallsHandler = /const armIdleReturn = \(\) => \{[\s\S]*?handleScrollToActive\(\)[\s\S]*?\n {2}\}/.test(src)
const endDragBody = blockBody(src, /const onScrollEndDrag = \(\) => \{/, 2)
const momentumBody = blockBody(src, /const onMomentumScrollEnd = \(\) => \{/, 2)
const endDragArms = !!endDragBody && /armIdleReturn\(\)/.test(endDragBody)
const momentumArms = !!momentumBody && /armIdleReturn\(\)/.test(momentumBody)
const momentumWired = /onMomentumScrollEnd=\{onMomentumScrollEnd\}/.test(src)

// --- G. 换歌清队列 ---
// 文件里有不止一个 [lyricLines] effect（歌词内容变化重置 remount key 的那个不含排队清理），
// 逐个检查，只要有一个带 `pendingGlideRef.current = null` 即可。
const lyricResetEffects = [...src.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[lyricLines\]\)/g)]
  .map((m) => m[1])
const songChangeClears = lyricResetEffects.some((body) => /pendingGlideRef\.current = null/.test(body))

// --- H. 总账：所有写点 ---
const writeSites = [...src.matchAll(/flatListRef\.current\.scrollToOffset\(\{ offset: ([^,}]+), animated: ([^}]+) \}\)/g)]
  .map((m) => ({ at: src.slice(0, m.index).split('\n').length, offset: m[1].trim(), animated: m[2].trim() }))
const ALLOWED = [
  { offset: 'targetOffset', animated: '!force' },              // handleScrollToActive 的唯一点
  { offset: 'smoothOffsetRef.current', animated: 'false' },    // 连续滚动循环
  { offset: '0', animated: 'false' },                          // 换歌重置（此时列表已 remount）
]
const unexpected = writeSites.filter((w) =>
  !ALLOWED.some((a) => a.offset === w.offset && a.animated === w.animated))

// --- I. 反例自检 ---
// 1) 把排队分支整个删掉：B 组断言必须判不合格
const negNoQueue = src.replace(/if \(!force && isScrollLoopRunningRef\.current\) \{[\s\S]*?\n {4}\}/, '')
const negNoQueueOk = /if \(!force && isScrollLoopRunningRef\.current\) \{/.test(negNoQueue)
// 2) 惯性结束接成空实现：F 组断言必须判不合格
const negMomentum = src.replace(
  /const onMomentumScrollEnd = \(\) => \{[\s\S]*?\n {2}\}/,
  'const onMomentumScrollEnd = () => {}',
)
const negMomentumBody = blockBody(negMomentum, /const onMomentumScrollEnd = \(\) => \{/, 2)
const negMomentumOk = !!negMomentumBody && /armIdleReturn\(\)/.test(negMomentumBody)
// 3) 往非强制分支塞回一个原生动画滚动：B 组断言必须判不合格
const negSecondWriter = src.replace(
  /if \(!force && isScrollLoopRunningRef\.current\) \{/,
  'if (!force && isScrollLoopRunningRef.current) {\n      flatListRef.current.scrollToOffset({ offset: targetOffset, animated: true })',
)
const negSecondWriterBody = blockBody(negSecondWriter, /if \(!force && isScrollLoopRunningRef\.current\) \{/)
const negSecondWriterOk = !(!!negSecondWriterBody && /scrollToOffset|scrollToIndex/.test(negSecondWriterBody))

console.log('='.repeat(92))
console.log('「歌词滚动唯一写者」契约模型（摘自源码）')
console.log('='.repeat(92))
console.log(`  声明：isScrollLoopRunningRef=${loopFlagDecl ? '✅' : '❌'}  pendingGlideRef=${pendingDecl ? '✅' : '❌'}  不变式注释=${invariantComment ? '✅' : '❌'}`)
console.log(`  非强制分支：排队=${enqueueQueues ? '✅' : '❌'} return=${enqueueReturns ? '✅' : '❌'} 块内无写点=${enqueueWrites ? '❌ 有写点' : '✅'}`)
console.log(`  守卫先于唯一写点：${guardBeforeWrite ? '✅' : '❌'}`)
console.log(`  硬跳清队列：${forceClears ? '✅' : '❌'}   循环消费：${consumeReads && consumeTakes ? '✅' : '❌'}`)
console.log(`  存活标记：起 rAF 前置位=${setTrueBeforeRaf ? '✅' : '❌'}  cleanup 复位=${resetInCleanup ? '✅' : '❌'}`)
console.log(`  停手回位：armIdleReturn=${armDef && armCallsHandler ? '✅' : '❌'}  松手=${endDragArms ? '✅' : '❌'}  惯性结束=${momentumArms ? '✅' : '❌'}  挂载=${momentumWired ? '✅' : '❌'}`)
console.log(`  换歌清队列：[lyricLines] effect 内=${songChangeClears ? '✅' : '❌'}`)
console.log()
console.log(`  全文件 scrollToOffset 写点（${writeSites.length} 处）：`)
for (const w of writeSites) console.log(`    L${w.at}  offset: ${w.offset}  animated: ${w.animated}`)
console.log(`  白名单之外的写点：${unexpected.length ? unexpected.map((w) => `L${w.at}`).join(', ') : '无'}`)
console.log()

console.log('='.repeat(92))
console.log('断言')
console.log('='.repeat(92))

check('isScrollLoopRunningRef 声明在位（唯一写者的判据）', loopFlagDecl, 'useRef(false)')
check('pendingGlideRef 声明在位（排队请求）', pendingDecl, 'useRef<{ index, target } | null>(null)')
check('文件内保留「单写者 / 只能由它写」的不变式注释', invariantComment, '防后来者静默删守卫')

check('非强制 + 循环运行中：把定位排进 pendingGlideRef', enqueueQueues && enqueueReturns,
  enqueueQueues ? '排队并 return' : '排队分支缺失')
check('非强制分支块内不得出现任何滚动写点（只排队、不自己滚）', !enqueueWrites,
  enqueueWrites ? '块内有 scrollToOffset/scrollToIndex' : '无写点')
check('排队守卫出现在 handleScrollToActive 唯一写点之前', guardBeforeWrite, '先分流、后写')

check('硬跳（force）清空排队请求', forceClears, 'pendingGlideRef.current = null')
check('连续滚动循环读取并消费排队请求', consumeReads && consumeTakes,
  'pendingGlide → continuousOffset = pendingGlide.target')

check('循环起 rAF 前置 isScrollLoopRunningRef = true', setTrueBeforeRaf, 'cleanup 前')
check('循环 cleanup 复位 isScrollLoopRunningRef = false', resetInCleanup, '与 cancelAnimationFrame 同段')

check('armIdleReturn 提取为共用入口并调用 handleScrollToActive', armDef && armCallsHandler, '松手 / 惯性结束共用')
check('onScrollEndDrag 走 armIdleReturn', endDragArms, '抬手重新计时')
check('onMomentumScrollEnd 走 armIdleReturn（惯性结束才真正停手）', momentumArms, '抖动/回跳的直接修复点')
check('onMomentumScrollEnd 已挂到 FlatList', momentumWired, 'onMomentumScrollEnd={onMomentumScrollEnd}')
check('换歌（[lyricLines] effect）清空排队请求', songChangeClears, 'pendingGlideRef.current = null')
check(`全文件滚动写点总账：${writeSites.length} 处全部在白名单内`, unexpected.length === 0,
  unexpected.length ? unexpected.map((w) => `L${w.at}`).join(', ') : 'handleScrollToActive / 循环 / 换歌重置')

check('反例：删掉排队分支，必须判不合格', !negNoQueueOk, '守卫正则不再命中')
check('反例：把 onMomentumScrollEnd 接成空实现，必须判不合格', !negMomentumOk, 'armIdleReturn 不再被调用')
check('反例：非强制分支塞回原生动画滚动，必须判不合格', !negSecondWriterOk, '块内写点被检出')

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
