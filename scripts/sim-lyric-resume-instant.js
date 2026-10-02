#!/usr/bin/env node
/**
 * sim-lyric-resume-instant.js —— 「切回来歌词瞬时到位」契约（用户第 12 轮第 1 条）
 *
 * 需求原话（2026-10-02）：播放大歌词在我切换 / 打开 / 退出播放详情页后再次返回时，
 * 会从切走前的旧位置滑一段才追上当前行，太慢；要求「不管从什么地方切回来，只会显示
 * 实时的当前进度」「大小歌词部分也一样，要实时显示歌词加载位置」。
 *
 * 收敛结果（竖屏 Vertical/Lyric.tsx 与横屏 Horizontal/Lyric.tsx 同构）：
 *   rAF 连续滚动循环被**整段停掉**的场景（暂停 isPlay=false、被压栈页盖住
 *   panelVisible=false）在停帧时置 resumeInstantRef=true；恢复首帧（wasPauseRef 分支）
 *   直接走既有 force 通道 handleScrollToActiveRef.current(line, true)
 *   = scrollToOffset({animated:false}) + 把所有平滑基准 / 切行滑动状态对齐到目标，
 *   不再从旧位置播 600ms easeInOutQuad（原来的「慢慢加载歌词位置」）。
 *
 * 边界（刻意保留，脚本一并钉住）：用户手动滚动 / 拖动歌词期间循环**没有**停
 *   （只是逐帧早退），那条路径保持原来的平滑回位观感 —— resumeInstantRef 只在
 *   停帧守卫里置真，且每个文件只允许出现一处 `= true`。
 *
 * 本脚本从源码解析实际结构（不硬编码行号），并为每条关键断言带一个「删掉就该判不合格」
 * 的反例自检。
 *
 * 运行：node scripts/sim-lyric-resume-instant.js
 */
'use strict'

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

/** 取一段块体：从 headerRe 命中处起，到第一个「缩进 = indent 个空格的 }」为止。 */
const blockBody = (s, headerRe, indent = 4) => {
  const m = headerRe.exec(s)
  if (!m) return null
  const rest = s.slice(m.index + m[0].length)
  const end = new RegExp(`\\n {${indent}}\\}`).exec(rest)
  return end ? rest.slice(0, end.index) : null
}

const GUARD_RE = /if \(!isPlay \|\| !panelVisible\) \{/
const RESUME_RE = /if \(wasPauseRef\.current\) \{/
const CONSUME_RE = /if \(resumeInstantRef\.current\) \{/

const FILES = [
  { name: '竖屏', file: 'src/screens/PlayDetail/Vertical/Lyric.tsx' },
  { name: '横屏', file: 'src/screens/PlayDetail/Horizontal/Lyric.tsx' },
]

console.log('='.repeat(92))
console.log('「切回来歌词瞬时到位」契约模型（摘自源码）')
console.log('='.repeat(92))

for (const { name, file } of FILES) {
  const src = read(file)
  console.log(`\n【${name}】${file}`)

  const decl = /const resumeInstantRef = useRef\(false\)/.test(src)
  const totalUses = (src.match(/resumeInstantRef\.current/g) || []).length
  const setTrueCount = (src.match(/resumeInstantRef\.current = true/g) || []).length
  const setFalseCount = (src.match(/resumeInstantRef\.current = false/g) || []).length

  const guardBody = blockBody(src, GUARD_RE)
  const guardSetsFlag = !!guardBody && /resumeInstantRef\.current = true/.test(guardBody)

  // 缩进对齐真实结构：wasPauseRef 分支在 rAF 循环体内（8 空格），消费块再内嵌一层（10 空格）
  const resumeBody = blockBody(src, RESUME_RE, 8)
  const consumeBody = resumeBody ? blockBody(resumeBody, CONSUME_RE, 10) : null
  const consumeCallsForce = !!consumeBody &&
    /handleScrollToActiveRef\.current\(lineRef\.current\.line, true\)/.test(consumeBody)
  const consumeClearsFlag = !!consumeBody && /resumeInstantRef\.current = false/.test(consumeBody)

  // 恢复首帧原本的「重取平滑基准」不能丢：瞬时定位之外，暂停前旧基准也不该被沿用
  const resumeKeepsBaseline = !!resumeBody && /smoothOffsetRef\.current = (scrollYRef|scrollInfoRef)/.test(resumeBody)

  console.log(`  声明=${decl ? '✅' : '❌'}  置真=${setTrueCount}处  消费=${setFalseCount}处  总引用=${totalUses}`)
  console.log(`  停帧守卫置真=${guardSetsFlag ? '✅' : '❌'}  恢复首帧 force 定位=${consumeCallsForce ? '✅' : '❌'}  重取基准保留=${resumeKeepsBaseline ? '✅' : '❌'}`)

  // -- 反例自检：删掉消费块 / 把 force 改成 false / 在守卫外多置一次真 --
  const negNoConsume = src.replace(CONSUME_RE, 'if (false) {')
  const negNoConsumeStillFound = CONSUME_RE.test(negNoConsume)
  const negNoForce = src.replace(
    /handleScrollToActiveRef\.current\(lineRef\.current\.line, true\)/,
    'handleScrollToActiveRef.current(lineRef.current.line, false)',
  )
  const negNoForceBody = (() => {
    const r = blockBody(negNoForce, RESUME_RE, 8)
    return r ? blockBody(r, CONSUME_RE, 10) : null
  })()
  const negNoForceStillForce = !!negNoForceBody &&
    /handleScrollToActiveRef\.current\(lineRef\.current\.line, true\)/.test(negNoForceBody)
  // 在守卫之外（文件末尾）多置一次真 → 「只允许一处置真」的计数断言必须判不合格
  const negExtraArm = src + '\nconst _negOutsideGuard = () => { resumeInstantRef.current = true }\n'
  const negExtraArmCount = (negExtraArm.match(/resumeInstantRef\.current = true/g) || []).length

  check(`[${name}] resumeInstantRef 声明在位`, decl, 'useRef(false)')
  check(`[${name}] 只在停帧守卫里置真（手动滚动路径不受影响）`, guardSetsFlag && setTrueCount === 1,
    `守卫内=${guardSetsFlag} 全文件置真 ${setTrueCount} 处（应=1）`)
  check(`[${name}] 恢复首帧消费标记并走 force 瞬时定位`, !!consumeBody && consumeCallsForce && consumeClearsFlag,
    'handleScrollToActiveRef.current(lineRef.current.line, true)')
  check(`[${name}] 恢复首帧仍重取平滑基准（不沿用暂停前旧基准）`, resumeKeepsBaseline, 'smoothOffsetRef = 列表真实位置')
  check(`[${name}] 反例：删掉消费块必须判不合格`, !negNoConsumeStillFound, '消费块正则不再命中')
  check(`[${name}] 反例：force 改成 false 必须判不合格`, !negNoForceStillForce, '退化成 animated:true 动画滚动被检出')
  check(`[${name}] 反例：守卫外多置一次真必须判不合格`, negExtraArmCount === 2, `计数=${negExtraArmCount} 应=2`)
}

console.log()
console.log('='.repeat(92))
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
