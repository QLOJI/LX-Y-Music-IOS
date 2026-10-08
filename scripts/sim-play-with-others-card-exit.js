#!/usr/bin/env node
/**
 * sim-play-with-others-card-exit.js —— 「与其他应用同时播放」勾选态的三件事契约
 * （退出灵动岛/锁屏卡片占用 + 不被其它音频停播 + 有界重取把声音拉回来）
 *
 * 需求原话（2026-10-08 第 33 轮第 4 条）：
 *   「播放设置中，勾选“与其他应用同时播放”选项后，配置为未勾选时和现在一样，勾选后，
 *     退出灵动岛占用，强化不会暂停播放功能，不论后台什么音频在播，软件音频正常播放」
 *
 * 三条口径（勾选 = setting['player.isHandleAudioFocus'] === false，即 playWithOthers）：
 *   ① 退出灵动岛 / 锁屏卡片占用 —— JS 侧抑制**元数据发布**这一个出口 + 切换那一刻清一次
 *      已发布的卡片（utils/nativeModules/nowPlaying.ts + plugins/player/index.ts）。
 *      为什么不能顺手把状态桥也砍掉：原生那条歌词时钟（LXNowPlayingLyricStep）同时是
 *      「前台 4Hz 位置事件 → JS 进度条」的唯一驱动源，砍掉状态桥 ⇒ 前台进度条停摆。
 *   ② 不被其它音频停播 —— 策略层：打断分支不调 pause()、不对外呈现暂停（第 24 轮分支，
 *      见 scripts/sim-audio-interruption-mix.js）。
 *   ③ 引擎真被系统停掉时的兜底 —— service.ts 的**有界**重取阶梯 scheduleMixReclaim：
 *      固定延时表 + 手动暂停/停止/取消勾选闸门 + 用户任何明确动作经 cancelResumePending 撤销。
 *      为什么要「有界」：无上限重取 = 反复激活音频会话，正是第 33 轮第 1 条要治的发热源。
 *   原生的混音会话（真·同时出声）只在无损档的 prepareAudioSession 里、由
 *   LXPlayWithOthersEnabled 守卫，其守卫/路由策略/唯一性由 scripts/sim-play-with-others-toggle.js
 *   把住；本脚本只补「默认值必须是 NO（未勾选不许退出卡片）」与声明顺序两条。
 *
 * 为什么必须靠契约脚本：以上全是「开关极性 + 调用顺序 + 有界性」，tsc/eslint 一律无感；
 * 写反了、忘了撤销、把阶梯写成无界，都只在真机上表现为「卡片没了 / 手机发烫 / 声音回不来」。
 * 运行：node scripts/sim-play-with-others-card-exit.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const countOf = (src, needle) => src.split(needle).length - 1

const F = {
  np: 'src/utils/nativeModules/nowPlaying.ts',
  plugin: 'src/plugins/player/index.ts',
  service: 'src/plugins/player/service.ts',
  native: 'ios/LxMusicMobile/AppDelegate.mm',
}

const REAL = {}
for (const [key, file] of Object.entries(F)) REAL[key] = read(file)

/** 取某个函数 / 分支的源码切片；startAnchor 找不到返回 null */
const sliceFn = (code, startAnchor, endAnchor) => {
  const at = code.indexOf(startAnchor)
  if (at < 0) return null
  const end = code.indexOf(endAnchor, at + startAnchor.length)
  return code.slice(at, end < 0 ? code.length : end)
}

// ---------------------------------------------------------------------------
// 不变量 A：卡片退出 = 只抑制元数据发布这一个出口
// ---------------------------------------------------------------------------

const nowPlayingInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  const fnBody = (name) => {
    const at = code.indexOf(`export const ${name}`)
    if (at < 0) return null
    const end = code.indexOf('\nexport const ', at + 1)
    return code.slice(at, end < 0 ? code.length : end)
  }

  if (!code.includes('let nowPlayingInfoSuppressed = false')) {
    reasons.push('nowPlaying.ts 缺抑制开关（或初值不是 false：未勾选时卡片必须照常显示）')
  }
  if (!code.includes('export const setNowPlayingInfoSuppressed')) {
    reasons.push('nowPlaying.ts 缺 setNowPlayingInfoSuppressed 出口（plugins/player/index.ts 无法下发抑制口径）')
  }

  const update = fnBody('updateNowPlayingInfo')
  if (update == null) {
    reasons.push('nowPlaying.ts 找不到 updateNowPlayingInfo')
  } else if (!update.includes('if (nowPlayingInfoSuppressed) return')) {
    reasons.push('updateNowPlayingInfo 发布前没查抑制开关（勾选后卡片会被下一行歌词 / 下一首歌建回来，「退出灵动岛占用」守不住）')
  }

  for (const name of ['playNowPlaying', 'pauseNowPlaying', 'stopNowPlaying', 'clearNowPlayingInfo', 'setNowPlayingLyrics', 'reanchorNowPlayingLyric']) {
    const body = fnBody(name)
    if (body == null) {
      reasons.push(`nowPlaying.ts 找不到 ${name}（六个桥缺一不可：歌词时钟同时驱动前台进度条）`)
      continue
    }
    if (body.includes('nowPlayingInfoSuppressed')) {
      reasons.push(`${name} 被抑制开关牵连（抑制只许作用在元数据发布一个出口；状态 / 歌词 / 重锚五桥里的时钟是前台 4Hz 位置的唯一驱动源，砍掉进度条就停）`)
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：切换编排（抑制口径先立 → 下发原生 → 清卡 / 重发布 → 状态重对齐）+ 冷启动
// ---------------------------------------------------------------------------

const orchestrationInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!code.includes("import { clearNowPlayingInfo, pauseNowPlaying, playNowPlaying, setNowPlayingInfoSuppressed } from '@/utils/nativeModules/nowPlaying'")) {
    reasons.push('index.ts 未引入 nowPlaying 的抑制 / 清卡 / 状态三个出口')
  }

  const body = sliceFn(code, 'const syncPlayWithOthersEnabled = async() => {', '\nconst initial =')
  if (body == null) {
    reasons.push('index.ts 找不到 syncPlayWithOthersEnabled')
    return reasons
  }
  const suppressAt = body.indexOf('setNowPlayingInfoSuppressed(enabled)')
  const policyAt = body.indexOf('await setNativePlayWithOthersPolicy(enabled)')
  if (suppressAt < 0) {
    reasons.push('syncPlayWithOthersEnabled 未下发抑制口径（勾选后卡片不会被退出）')
  } else if (policyAt >= 0 && suppressAt > policyAt) {
    reasons.push('抑制口径落在原生策略下发之后（顺序反了：两步之间到达的元数据发布会把卡片漏出来一次）')
  }
  if (!/if \(enabled\) \{[\s\S]{0,120}clearNowPlayingInfo\(\)[\s\S]{0,120}\} else \{[\s\S]{0,160}updateMetaData\(/.test(body)) {
    reasons.push('切换编排不是「勾选＝清除已发布的卡片 / 取消勾选＝按当前曲目重新发布」二选一（少任一边都表现为：卡片退不掉，或取消勾选后卡片要等下一行歌词才回来）')
  }
  if (!body.includes('playNowPlaying()') || !body.includes('pauseNowPlaying()')) {
    reasons.push('切换后未按当前播放状态重对齐（原生位置 / 歌词时钟只在 Playing 时走，它同时是前台进度条的唯一驱动源）')
  }

  const initBody = sliceFn(code, 'const initial = async(', '\nconst isInitialized =')
  if (initBody == null) {
    reasons.push('index.ts 找不到 initial')
  } else {
    const coldAt = initBody.indexOf("setNowPlayingInfoSuppressed(settingState.setting['player.isHandleAudioFocus'] === false)")
    const syncAt = initBody.indexOf('await syncPlayWithOthersEnabled()')
    if (coldAt < 0) {
      reasons.push('initial 缺冷启动抑制口径（初始化窗口内一次早到的元数据发布会把卡片建出来，重启后勾选态失效）')
    } else if (syncAt >= 0 && coldAt > syncAt) {
      reasons.push('冷启动抑制口径落在 syncPlayWithOthersEnabled 之后（窗口期内同样会漏一次）')
    }
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：有界重取阶梯（延时表 / 有界性 / 闸门 / 三处布防 / 可撤销）
// ---------------------------------------------------------------------------

const reclaimInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  const tableMatch = code.match(/const MIX_RECLAIM_DELAYS = \[([^\]]*)\]/)
  if (tableMatch == null) {
    reasons.push('service.ts 缺 MIX_RECLAIM_DELAYS 延时表（重取阶梯的节奏必须集中可调）')
  } else {
    const nums = tableMatch[1].split(',').map(s => s.trim()).filter(s => s.length > 0).map(Number)
    if (nums.length === 0 || nums.some(n => !Number.isFinite(n))) {
      reasons.push(`MIX_RECLAIM_DELAYS 不是有限数字表（现为 [${tableMatch[1]}]）`)
    } else {
      if (nums.length > 6) reasons.push(`MIX_RECLAIM_DELAYS 太长（${nums.length} 次）：重取等于反复激活音频会话，次数越多越费电越热`)
      if (nums[0] < 1000) reasons.push(`MIX_RECLAIM_DELAYS 首次重取太密（${nums[0]}ms）：打断通知到达瞬间会话还在交接，抢会话必失败还会连点激活会话`)
      const total = nums.reduce((a, b) => a + b, 0)
      if (total > 60000) reasons.push(`MIX_RECLAIM_DELAYS 总窗口过长（${total}ms）：超出用户在车机场景的一次打断时长，等于常驻轮询`)
    }
  }

  const sched = sliceFn(code, 'const scheduleMixReclaim = () => {', '\nconst restoreConfiguredVolume')
  if (sched == null) {
    reasons.push('service.ts 找不到 scheduleMixReclaim')
  } else {
    if (!sched.includes('if (!isPlayWithOthers()) return')) {
      reasons.push('scheduleMixReclaim 未按「与其他应用同时播放」开关设防（未勾选也重取＝独占口径下自说自话出声）')
    }
    if (!sched.includes('if (global.lx.isPlayedStop || !playerState.isPlay || isManualPause() || !isPlayWithOthers()) return clearMixReclaimTimer()')) {
      reasons.push('scheduleMixReclaim 缺闸门（停止 / 已不在播 / 用户手动暂停 / 取消勾选任一命中都必须收手，否则会跟用户的暂停抢播放）')
    }
    if (!sched.includes('play()')) {
      reasons.push('scheduleMixReclaim 没有真正重取（play() 在无损档落到原生 resume：抢回会话 + 重启引擎，已在播时幂等）')
    }
    if (!sched.includes('if (mixReclaimCount >= MIX_RECLAIM_DELAYS.length) return clearMixReclaimTimer()')) {
      reasons.push('scheduleMixReclaim 无界（阶梯必须按延时表走完即止，无上限重取 = 第 33 轮第 1 条要治的发热源）')
    }
  }

  const mixSlice = sliceFn(code, '      if (isPlayWithOthers()) {', '\n      if (ducking) {')
  if (mixSlice == null) {
    reasons.push('service.ts 找不到混音策略分支（if (isPlayWithOthers())）')
  } else if (countOf(mixSlice, 'scheduleMixReclaim()') !== 2) {
    reasons.push(`混音分支的布防次数不是 2（现为 ${countOf(mixSlice, 'scheduleMixReclaim()')}）：打断开始与结束各需一次，缺任一次都会留下「状态在播、没有声音」`)
  }

  if (countOf(code, 'scheduleMixReclaim()') !== 3) {
    reasons.push(`scheduleMixReclaim() 全文件出现 ${countOf(code, 'scheduleMixReclaim()')} 次（应为 3：混音分支两次 + 回前台一次；多出来说明它被铺到了独占口径 / 别的事件上）`)
  }

  const cancel = sliceFn(code, 'export const cancelResumePending = () => {', '\nconst scheduleAutoResume')
  if (cancel == null) {
    reasons.push('service.ts 找不到 cancelResumePending')
  } else if (!cancel.includes('clearMixReclaimTimer()')) {
    reasons.push('cancelResumePending 未撤销重取阶梯（用户手动暂停 / 切歌 / 停止后阶梯还在跑，会跟播放状态抢控制权）')
  }

  if (!code.includes('const reclaim = playerState.isPlay && !global.lx.isPlayedStop && !isManualPause() && isPlayWithOthers()')) {
    reasons.push('回前台（AppState active）缺重取判定（退后台期间被系统停掉且结束通知丢失时，回前台是最后一次拉回声音的机会）')
  } else if (!code.includes('if (reclaim) scheduleMixReclaim()')) {
    reasons.push('回前台判定后未落 scheduleMixReclaim()')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 D：原生放行形态的默认值 + 声明顺序（守卫/路由策略/唯一性见 sim-play-with-others-toggle.js）
// ---------------------------------------------------------------------------

const nativeInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  const declAt = code.indexOf('static BOOL LXPlayWithOthersEnabled = NO;')
  if (declAt < 0) {
    reasons.push('原生缺 LXPlayWithOthersEnabled 声明，或默认值不是 NO（未勾选 / 冷启动必须是标准非混音会话，否则设置项未勾选也会退出卡片）')
  }
  const methodAt = code.indexOf('- (BOOL)prepareAudioSession:')
  if (methodAt < 0) {
    reasons.push('原生找不到 prepareAudioSession（勾选态混音会话的唯一落点）')
  } else {
    const guardAt = code.indexOf('if (LXPlayWithOthersEnabled) {', methodAt)
    if (guardAt < 0) {
      reasons.push('prepareAudioSession 里没有 LXPlayWithOthersEnabled 守卫分支（勾选后仍是非混音会话 ⇒ 真·同时出声不成立）')
    }
    if (declAt >= 0 && declAt > methodAt) {
      reasons.push('LXPlayWithOthersEnabled 的声明落在 prepareAudioSession 之后（文件作用域静态变量必须先声明后使用，否则编译不过）')
    }
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

  // n1 抑制开关没接上（卡片被后续元数据建回来）
  check('n1 元数据发布前不查抑制开关', () => nowPlayingInvariants(tamper(REAL.np,
    '  if (nowPlayingInfoSuppressed) return\n',
    '')),
  '发布前没查抑制开关')

  // n2 抑制误伤状态桥（前台进度条失去驱动）
  check('n2 抑制开关牵连状态桥', () => nowPlayingInvariants(tamper(REAL.np,
    'export const playNowPlaying = async(options: NowPlayingStateOptions = {}) => {\n',
    'export const playNowPlaying = async(options: NowPlayingStateOptions = {}) => {\n  if (nowPlayingInfoSuppressed) return\n')),
  '被抑制开关牵连')

  // n3 下发顺序颠倒（切换瞬间漏一次卡片）
  check('n3 抑制口径晚于原生策略下发', () => orchestrationInvariants(tamper(REAL.plugin,
    '  setNowPlayingInfoSuppressed(enabled)\n  await setNativePlayWithOthersPolicy(enabled)',
    '  await setNativePlayWithOthersPolicy(enabled)\n  setNowPlayingInfoSuppressed(enabled)')),
  '顺序反了')

  // n4 取消勾选后不重发布（卡片要等下一行歌词才回来）
  check('n4 取消勾选不重新发布卡片', () => orchestrationInvariants(tamper(REAL.plugin,
    '    void updateMetaData(playerState.musicInfo, playerState.isPlay, playerState.lastLyric, true)',
    '    // removed')),
  '重新发布')

  // n5 勾选后不清已发布的卡片（灵动岛占用退不掉）
  check('n5 勾选不清已发布的卡片', () => orchestrationInvariants(tamper(REAL.plugin,
    '    await clearNowPlayingInfo().catch(() => {})',
    '    await pauseNowPlaying().catch(() => {})')),
  '清除已发布的卡片')

  // n6 缺冷启动抑制口径（重启后勾选态失效）
  check('n6 缺冷启动抑制口径', () => orchestrationInvariants(tamper(REAL.plugin,
    "  setNowPlayingInfoSuppressed(settingState.setting['player.isHandleAudioFocus'] === false)\n",
    '')),
  '冷启动')

  // r1 阶梯写成无界（反复激活会话 = 发热源）
  check('r1 重取阶梯无界', () => reclaimInvariants(tamper(REAL.service,
    '    if (mixReclaimCount >= MIX_RECLAIM_DELAYS.length) return clearMixReclaimTimer()\n',
    '')),
  '无界')

  // r2 缺手动暂停闸门（跟用户的暂停抢播放）
  check('r2 缺手动暂停闸门', () => reclaimInvariants(tamper(REAL.service,
    ' || isManualPause() || !isPlayWithOthers()',
    ' || !isPlayWithOthers()')),
  '手动暂停')

  // r3 打断开始不布防（少一次，声音回不来）
  check('r3 混音分支少一次布防', () => reclaimInvariants(tamper(REAL.service,
    '          scheduleMixReclaim()\n          clearResumeTimer()',
    '          clearResumeTimer()')),
  '布防次数不是 2')

  // r4 用户动作不撤销阶梯
  check('r4 用户动作不撤销阶梯', () => reclaimInvariants(tamper(REAL.service,
    '  clearMixReclaimTimer()\n  clearResumeTimer()',
    '  clearResumeTimer()')),
  '未撤销重取阶梯')

  // r5 首次重取太密（会话交接期抢会话必失败）
  check('r5 延时表首次重取太密', () => reclaimInvariants(tamper(REAL.service,
    'const MIX_RECLAIM_DELAYS = [1200, 3000, 7000, 15000]',
    'const MIX_RECLAIM_DELAYS = [50, 50]')),
  '太密')

  // k1 原生默认值翻成 YES（未勾选也走混音 ⇒ 卡片被无条件砍掉）
  check('k1 原生默认值翻成 YES', () => nativeInvariants(tamper(REAL.native,
    'static BOOL LXPlayWithOthersEnabled = NO;',
    'static BOOL LXPlayWithOthersEnabled = YES;')),
  '默认值不是 NO')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-play-with-others-card-exit ===')
console.log('勾选「与其他应用同时播放」= 退出灵动岛 / 锁屏卡片占用 + 不因其它音频停播 + 有界重取兜底（第 33 轮第 4 条）')
console.log()

const checks = [
  ['卡片退出（抑制开关只作用在元数据发布这一个出口；六个桥里状态/歌词/重锚不许被牵连）', () => nowPlayingInvariants(REAL.np)],
  ['切换编排 + 冷启动（抑制先立 → 下发原生 → 勾选清卡 / 取消勾选重发布 → 按状态重对齐）', () => orchestrationInvariants(REAL.plugin)],
  ['有界重取阶梯（延时表有界合理 + 开关/停止/手动暂停闸门 + 混音分支两次布防 + 可撤销 + 回前台末次机会）', () => reclaimInvariants(REAL.service)],
  ['原生（默认 NO + 守卫在 prepareAudioSession 内 + 声明在方法之前）', () => nativeInvariants(REAL.native)],
]

let invOk = true
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    console.log(`\n[${name}]\n  PASS`)
  } else {
    invOk = false
    console.log(`\n[${name}]`)
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
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
