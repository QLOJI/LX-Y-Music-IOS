#!/usr/bin/env node
/**
 * sim-mini-lyric-return-timing.js —— 小歌词「换行过程被瞬跳复位打快」的防复发契约
 * （用户第 22 轮第 3 条 + 中途补充）。
 *
 * 需求原话（2026-10-03）：
 *   「播放详情页的小歌词，滑动歌词后返回播放进度时，这个动画和大歌词动画的速度不一致，
 *     我发现，歌曲播放时，加载歌词比较快的情况下，一滑动歌词，它会马上跳回原位置，特别快，
 *     速度和正常速度完全不一样，有时候一滑出去，就回来了，请规范整体返回时间，特别是正在播放时。」
 * 中途补充原话：
 *   「小歌词问题，主要发生在歌词换行过程中，会出现上面速度快的 bug」
 *
 * 根因（两条瞬时复位入口，都在歌词换行时被触发）：
 *   ① 复位 effect 依赖写着 [lyricLines, resetScroll]，而 resetScroll 的依赖链是
 *      rowHeights → rowOffsets → getScrollOffset → resetScroll —— rowHeights 依赖
 *      activeLine，**每次换行都换引用**，于是「整份歌词变了才复位」变成「每次换行都复位」：
 *      瞬跳（animated:false）会把刚起步的换行滑行（followActiveLine / LINE_CHANGE_GLIDE_MS）
 *      当场取消，观感就是「快到不正常」。
 *   ② onContentSizeChange 直接挂 resetScroll：当前行带/摘翻译槽时内容总高每次换行都变，
 *      于是同一次换行又白跑一次瞬跳复位。
 *
 * 收敛结果：
 *   一、复位 effect 走 ref、依赖只写 [lyricLines]（useLrcSet 只在整份歌词变更时换引用）；
 *   二、onContentSizeChange 换成「窗口高度真变了才同步」的 handleContentSizeChange，
 *      换行引起的行高变化交给跟随滑行；
 *   三、resetScroll / handleContentSizeChange 都保持「手动定位期间绝不抢滚动」的纪律；
 *   四、时长口径不动：换行跟随 LINE_CHANGE_GLIDE_MS、回位 duration ?? RETURN_TO_ACTIVE_MS
 *      （与大歌词同源，见 sim-lyric-manual-position.js）。
 *
 * 带反例自检（这类回归 tsc/eslint 无感：hooks 依赖数组多写一个变量完全合法）。
 * 运行：node scripts/sim-mini-lyric-return-timing.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const FILE = 'src/screens/PlayDetail/components/MiniLyric.tsx'
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const invariants = (rawFile) => {
  const reasons = []
  const code = stripComments(rawFile)

  // ① 复位只在「整份歌词换了引用」时跑：ref 转发 + 依赖只写 [lyricLines]
  if (!/const resetScrollRef = useRef\(resetScroll\)\s*\n\s*resetScrollRef\.current = resetScroll\s*\n\s*useEffect\(\(\) => \{\s*\n\s*resetScrollRef\.current\(\)\s*\n\s*\}, \[lyricLines\]\)/.test(code)) {
    reasons.push('复位 effect 未走「ref 转发 + 仅依赖 [lyricLines]」（rowHeights 每次换行换引用 → resetScroll 换引用 → 每次换行都瞬跳复位）')
  }
  if (/\[lyricLines, resetScroll\]/.test(code)) {
    reasons.push('复位 effect 依赖又写回了 resetScroll（每次歌词换行都会重建引用、触发瞬跳复位，用户报的「换行过程中特别快」）')
  }

  // ② resetScroll 第一道纪律：手动定位期间直接跳过（绝不抢滚动）
  if (!/const resetScroll = useCallback\(\(\) => \{\s*\n\s*if \(isPauseScrollRef\.current\) return/.test(code)) {
    reasons.push('resetScroll 缺少「手动定位期间直接跳过」守卫（用户滑动中的位置会被复位抢走）')
  }

  // ③ onContentSizeChange 不再直挂 resetScroll，走「窗口高度真变了才同步」的处理器
  if (code.includes('onContentSizeChange={resetScroll}')) {
    reasons.push('onContentSizeChange 又直挂 resetScroll（换行时当前行翻译槽增减会改内容总高 → 每次换行白跑一次瞬跳复位）')
  }
  if (!code.includes('onContentSizeChange={handleContentSizeChange}')) {
    reasons.push('onContentSizeChange 未挂 handleContentSizeChange')
  }
  if (!/const sizeHandledHeightRef = useRef\(containerHeight\)\s*\n\s*const handleContentSizeChange = useCallback\(\(\) => \{\s*\n\s*if \(sizeHandledHeightRef\.current === containerHeight\) return/.test(code)) {
    reasons.push('handleContentSizeChange 未按「窗口高度（containerHeight）真变了才处理」去重（普通内容高变化不该触发同步）')
  }
  const hcBody = /const handleContentSizeChange = useCallback\(\(\) => \{([\s\S]*?)\}, \[containerHeight, getScrollOffset, cancelScroll\]\)/.exec(code)
  if (!hcBody) {
    reasons.push('handleContentSizeChange 处理体抽取失败（锚点漂移）')
  } else {
    for (const [needle, label] of [
      ['sizeHandledHeightRef.current = containerHeight', '更新已处理窗口高度'],
      ['if (isPauseScrollRef.current) return', '手动定位期间不抢滚动'],
      ['cancelScroll()', '取消进行中的定位动画'],
      ['listRef.current?.scrollToOffset({ offset: getScrollOffset(activeLineRef.current), animated: false })', '同步到当前行'],
    ]) {
      if (!hcBody[1].includes(needle)) reasons.push(`handleContentSizeChange 语义被改动（缺 ${label}）`)
    }
  }

  // ④ 时长口径不动：换行跟随 = LINE_CHANGE_GLIDE_MS，回位 = duration ?? RETURN_TO_ACTIVE_MS
  if (!code.includes("import { IDLE_RETURN_MS, LINE_CHANGE_GLIDE_MS, RETURN_TO_ACTIVE_MS } from '@/screens/PlayDetail/lyricAnimation'")) {
    reasons.push('三个动画时长常量未从 lyricAnimation 单一来源引入（时长口径漂移）')
  }
  if (!/const total = Math\.max\(duration \?\? RETURN_TO_ACTIVE_MS, 1\)/.test(code)) {
    reasons.push('回位时长未走 duration ?? RETURN_TO_ACTIVE_MS（手动定位后的回位时长漂移）')
  }
  if (!/animateToLine\(index, LINE_CHANGE_GLIDE_MS\)/.test(code)) {
    reasons.push('换行跟随未用 LINE_CHANGE_GLIDE_MS（换行滑行时长漂移）')
  }
  if (!/animateToLine\(target, undefined,/.test(code)) {
    reasons.push('停手回位未用「不传 duration 的回位口径」（应走 duration ?? RETURN_TO_ACTIVE_MS）')
  }

  // ⑤ 换行跟随 effect 仍在（activeLine 变化 → followActiveLine），且手动定位期间不插队
  if (!/useEffect\(\(\) => \{\s*\n\s*if \(activeLine < 0\) return\s*\n[\s\S]{0,120}?if \(isPauseScrollRef\.current\) return\s*\n\s*followActiveLine\(activeLine\)\s*\n\s*\}, \[activeLine, followActiveLine\]\)/.test(code)) {
    reasons.push('换行跟随 effect 被改动（activeLine 变化 → followActiveLine 的链路缺失或守卫丢失）')
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

const REAL = read(FILE)

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

  // c1 复位 effect 退回 [lyricLines, resetScroll]（换行即瞬跳的老写法）
  check('c1 复位依赖退回 resetScroll', () => invariants(tamper(REAL,
    '    resetScrollRef.current()\n  }, [lyricLines])',
    '    resetScroll()\n  }, [lyricLines, resetScroll])')),
  '复位 effect 未走「ref 转发 + 仅依赖 [lyricLines]」')

  // c2 onContentSizeChange 退回直挂 resetScroll
  check('c2 内容高变化退回瞬跳复位', () => invariants(tamper(REAL,
    'onContentSizeChange={handleContentSizeChange}',
    'onContentSizeChange={resetScroll}')),
  'onContentSizeChange 又直挂 resetScroll')

  // c3 拆掉 resetScroll 的手动定位守卫
  check('c3 拆掉 resetScroll 定位守卫', () => invariants(tamper(REAL,
    '  const resetScroll = useCallback(() => {\n    if (isPauseScrollRef.current) return\n',
    '  const resetScroll = useCallback(() => {\n')),
  'resetScroll 缺少「手动定位期间直接跳过」守卫')

  // c4 拆掉内容高去重（普通换行又触发瞬跳同步）
  check('c4 拆掉内容高去重', () => invariants(tamper(REAL,
    '    if (sizeHandledHeightRef.current === containerHeight) return\n',
    '')),
  'handleContentSizeChange 未按「窗口高度（containerHeight）真变了才处理」去重')

  // c5 换行跟随时长漂移
  check('c5 换行跟随时长漂移', () => invariants(tamper(REAL,
    'animateToLine(index, LINE_CHANGE_GLIDE_MS)',
    'animateToLine(index, 120)')),
  '换行跟随未用 LINE_CHANGE_GLIDE_MS')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-mini-lyric-return-timing ===')
console.log('小歌词换行不被瞬跳复位打快（第 22 轮第 3 条 + 中途补充）')
console.log()

const reasons = invariants(REAL)
if (reasons.length === 0) {
  console.log('[不变量] PASS —— 复位只跟整份歌词走；内容高变化按窗口高度去重；时长口径同源')
} else {
  console.log('[不变量] FAIL')
  reasons.forEach(r => console.log('  FAIL ' + r))
}

console.log('\n[反例自检]')
const ceResults = runCounterExamples()
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.detail}`)
  if (!r.ok) ceAllOk = false
}

const invOk = reasons.length === 0
const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${invOk ? 1 : 0}/1；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
