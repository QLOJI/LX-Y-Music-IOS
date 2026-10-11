#!/usr/bin/env node
/**
 * sim-play-with-others-card-exit.js —— 「与其他应用同时播放」勾选态的三件事契约
 * （锁屏卡片照常发布 + 不被其它音频停播 + 有界重取把声音拉回来）
 *
 * 需求原话（2026-10-08 第 33 轮第 4 条）：
 *   「播放设置中，勾选“与其他应用同时播放”选项后，配置为未勾选时和现在一样，勾选后，
 *     退出灵动岛占用，强化不会暂停播放功能，不论后台什么音频在播，软件音频正常播放」
 * 需求原话（2026-10-08 第 34 轮第 2 条 —— 用户当场改口，第 33 轮那一支作废）：
 *   「勾选"与其他应用同时播放"选项后，请问可以设置为显示锁屏播放器界面，取消灵动岛播放器
 *     界面吗？目前是都取消显示了，使用上面样式后，还是保留同时播放功能；修改灵动岛规则，
 *     当打开软件并正在使用时，取消灵动岛播放器界面，只显示锁屏播放器界面，当软件关闭或者
 *     切入后台时，灵动岛播放器界面和锁屏播放器界面都显示，并且在切入后台时，会有一个向上
 *     缩放的动画缩小到灵动岛位置，随之灵动岛播放器界面显示，锁屏播放器界面保持显示，
 *     点击灵动岛文字区域，会跳转到播放详情页，跳转过程动画同上」
 *
 * 第 34 轮口径（本脚本以它为准；第 33 轮那版「勾选就退出卡片」的抑制已**整体撤除**）：
 *   ⓐ 锁屏播放器与灵动岛播放器是**同一个** Now Playing 会话，公开 API 无法只关其中一个。
 *      第 33 轮按「退出灵动岛占用」做的元数据抑制，实测把锁屏播放器一起关掉了（第 33 轮
 *      交付物里已把这条例外写明）；用户第 34 轮改口：勾选后要「显示锁屏播放器界面」。
 *      于是抑制这条路径整体撤掉 —— nowPlaying.ts 里不许再出现任何抑制开关，
 *      元数据一律照常发布。切换「与其他应用同时播放」只做三件事：
 *        下发原生混音策略（这是「同时播放」功能本体）→ 有正在播放的歌就按当前曲目重新发布
 *        一次元数据（锁屏播放器立刻跟上，不用等下一行歌词）→ 按当前播放状态重对齐
 *        play/pause（原生位置 / 歌词时钟只在 Playing 时走，它同时是前台 4Hz 位置事件的
 *        枢纽 = 进度条唯一驱动源）。
 *   ⓑ 「前台不显示灵动岛播放器、切到后台锁屏与灵动岛都显示」、「切入后台向上缩放收到灵动岛」
 *      以及「点灵动岛文字区域」这三件事都是**系统**按前后台自动决定 / 系统自己拥有的表现，
 *      代码不介入也无法介入：点灵动岛 = 把 App 拉回前台，系统不提供「点的是灵动岛」这个
 *      信号，那条「跳到播放详情页」走的是「回前台」的通用路径
 *      （消费者见 sim-startup-detail-offload-wiring.js 不变量 B 的第二个消费点）。
 *   ⓒ 「不会暂停播放」仍要守住 —— 策略层：打断分支不调 pause()、不对外呈现暂停（第 24 轮
 *      分支，见 scripts/sim-audio-interruption-mix.js）+ service.ts 的**有界**重取阶梯
 *      scheduleMixReclaim：固定延时表 + 手动暂停/停止/取消勾选闸门 + 用户任何明确动作经
 *      cancelResumePending 撤销。为什么必须「有界」：无上限重取 = 反复激活音频会话，
 *      正是第 33 轮第 1 条要治的发热源。
 *   原生的混音会话（真·同时出声）只在无损档的 prepareAudioSession 里、由
 *   LXPlayWithOthersEnabled 守卫，其守卫 / 路由策略 / 唯一性由
 *   scripts/sim-play-with-others-toggle.js 把住；本脚本只补「默认值必须是 NO（未勾选 /
 *   冷启动不许走混音会话）」与「声明在方法之前」两条。
 *
 * 为什么必须靠契约脚本：以上全是「开关极性 + 调用顺序 + 有界性 + 不许复活的旧设计」，
 * tsc/eslint 一律无感；写反了、忘了撤销、把阶梯写成无界，都只在真机上表现为
 * 「锁屏播放器没了 / 手机发烫 / 声音回不来」。
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
// 不变量 A：元数据照常发布 —— 第 33 轮的抑制已整体撤除，不许复活
// ---------------------------------------------------------------------------

const nowPlayingInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ⓐ-1 抑制开关必须不存在（第 34 轮的定案是「撤掉」，不是「保留着但默认关」——
  //      留着一颗开关，下次谁把初值一翻，锁屏播放器又没了，而这次没人会记得为什么）
  if (/suppress/i.test(code)) {
    reasons.push('nowPlaying.ts 里又出现了抑制开关（Suppress）：锁屏播放器与灵动岛播放器是同一个'
      + ' Now Playing 会话，抑制元数据发布会把锁屏播放器一起关掉（第 33 轮实锤，用户第 34 轮'
      + '已改口要显示锁屏播放器）')
  }

  // ⓐ-2 元数据发布是唯一出口、且不许有任何闸门：形状被钉死成
  //      「平台能力守卫 → 直接下发」两句，中间塞不进任何条件（抑制 / 空值 / 节流）
  const pubShape = /export const updateNowPlayingInfo = async\(metadata: NowPlayingInfoMetadata\) => \{\n  if \(!hasMethod\('updateNowPlayingInfo'\)\) return\n  return NowPlayingModule\?\.updateNowPlayingInfo\?\.\(metadata\)\n\}/
  if (!pubShape.test(code)) {
    reasons.push('updateNowPlayingInfo 不再是无条件直发（唯一出口被加了闸门）：勾选态下任何一次'
      + '「按条件不发」都会让锁屏播放器停在上一次的状态 / 干脆不出现')
  }

  // ⓐ-3 六个桥缺一不可（清卡桥也在：别的路径 —— 停止播放 / 清空队列 —— 仍要用它）
  for (const name of ['playNowPlaying', 'pauseNowPlaying', 'stopNowPlaying', 'clearNowPlayingInfo', 'setNowPlayingLyrics', 'reanchorNowPlayingLyric']) {
    if (!code.includes(`export const ${name}`)) {
      reasons.push(`nowPlaying.ts 找不到 ${name}（六个桥缺一不可：清卡桥供停止播放用，`
        + `歌词 / 重锚桥的时钟是前台 4Hz 位置的唯一驱动源）`)
    }
  }

  // ⓐ-4 撤除理由必须留在同一处（这是一条文档契约）：需求是被用户当场改口的，
  //      旧实现（抑制）看起来非常「合理」，不留痕的话下一个改的人会照着第 33 轮口径加回来
  if (!raw.includes('第 34 轮第 2 条')) {
    reasons.push('nowPlaying.ts 没有留下「第 33 轮那版抑制为何撤掉」的说明：需求是被用户改口的，'
      + '旧实现看起来仍然「合理」，不留痕的下场就是被照着旧口径加回来')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：切换编排（下发原生策略 → 有歌才重发布 → 按播放状态重对齐）+ 冷启动
// ---------------------------------------------------------------------------

const orchestrationInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ⓑ-1 引用的出口只能是「状态对齐」两个：一旦又出现抑制 / 清卡，说明旧设计重新长回来了
  if (/setNowPlayingInfoSuppressed/.test(code)) {
    reasons.push('index.ts 又下发了元数据抑制口径：第 34 轮第 2 条已把「勾选就退出卡片」整体撤掉'
      + '（同一个 Now Playing 会话，锁屏播放器会被一起关掉）')
  }
  if (/clearNowPlayingInfo/.test(code)) {
    reasons.push('index.ts 又调了 clearNowPlayingInfo：切换开关时清卡会把用户此刻正在看的锁屏播放器'
      + '抹掉（第 34 轮第 2 条已把「勾选就退出卡片」整体撤掉）')
  }
  if (!code.includes("import { pauseNowPlaying, playNowPlaying } from '@/utils/nativeModules/nowPlaying'")) {
    reasons.push('index.ts 没有从 nowPlaying 只引入 play / pause 两个状态桥（该模块现在只该被用来做状态对齐）')
  }

  const body = sliceFn(code, 'const syncPlayWithOthersEnabled = async() => {', '\nconst initial =')
  if (body == null) {
    reasons.push('index.ts 找不到 syncPlayWithOthersEnabled')
    return reasons
  }

  // ⓑ-2 开关极性：勾选（isHandleAudioFocus === false）才是「与其他应用同时播放」
  if (!body.includes("const enabled = settingState.setting['player.isHandleAudioFocus'] === false")) {
    reasons.push('syncPlayWithOthersEnabled 的开关极性变了：勾选态 = isHandleAudioFocus === false（写反 = 功能与设置项相反）')
  }
  // ⓑ-3 「同时播放」功能本体：把策略交给原生（混音会话开关，勾选后真·同时出声）
  if (!body.includes('await setNativePlayWithOthersPolicy(enabled)')) {
    reasons.push('syncPlayWithOthersEnabled 没有下发原生混音策略：勾选后不会切到混音会话，'
      + '「与其他应用同时播放」功能失效（用户第 34 轮第 2 条：「还是保留同时播放功能」）')
  }

  const iPolicy = body.indexOf('await setNativePlayWithOthersPolicy(enabled)')
  const iGuard = body.indexOf('if (!playerState.musicInfo.id) return')
  const iPublish = body.indexOf('void updateMetaData(playerState.musicInfo, playerState.isPlay, playerState.lastLyric, true)')
  const iAlignPlay = body.indexOf('if (playerState.isPlay) await playNowPlaying().catch(() => {})')
  const iAlignPause = body.indexOf('else await pauseNowPlaying().catch(() => {})')

  if (iGuard < 0) {
    reasons.push('syncPlayWithOthersEnabled 丢了「没有正在播放的歌就不发布」守卫：'
      + '空 id 的元数据会把锁屏播放器刷成空白（没有可显示的曲目）')
  }
  if (iPublish < 0) {
    reasons.push('syncPlayWithOthersEnabled 切换后不按当前曲目重新发布元数据：'
      + '锁屏播放器与当前曲目脱钩（要等下一行歌词 / 下一首歌才回来）')
  } else if (iGuard >= 0 && iPublish < iGuard) {
    reasons.push('重发布发生在「有歌吗」守卫之前：没有正在播放的歌时也会发布一次空元数据')
  }
  if (iAlignPlay < 0 || iAlignPause < 0) {
    reasons.push('syncPlayWithOthersEnabled 切换后不按播放状态重对齐 play / pause：'
      + '原生位置 / 歌词时钟只在 Playing 时走，它同时是前台进度条的唯一驱动源（不对齐 = 进度条停摆）')
  } else if (iPublish >= 0 && iAlignPlay < iPublish) {
    reasons.push('状态重对齐发生在重发布之前：播放状态与刚发布的元数据可能不同步')
  }
  if (iPolicy >= 0 && iPublish >= 0 && iPolicy > iPublish) {
    reasons.push('重发布发生在原生策略下发之前：会话分类还没定就把元数据推出去，锁屏播放器的播放态会与真实会话错一拍')
  }

  const initBody = sliceFn(code, 'const initial = async(', '\nconst isInitialized =')
  if (initBody == null) {
    reasons.push('index.ts 找不到 initial')
  } else if (!initBody.includes('await syncPlayWithOthersEnabled()')) {
    reasons.push('initial 不再调 syncPlayWithOthersEnabled：重启后「与其他应用同时播放」的策略 / 元数据口径全丢'
      + '（设置项显示已勾选，实际是独占口径）')
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
  } else {
    if (countOf(mixSlice, 'scheduleMixReclaim()') !== 2) {
      reasons.push(`混音分支的布防次数不是 2（现为 ${countOf(mixSlice, 'scheduleMixReclaim()')}）：打断开始与结束各需一次，缺任一次都会留下「状态在播、没有声音」`)
    }
    // 【第 50 轮】「结束」分支的**即时重取**：Ended 是本机唯一「对方已释放」信号。
    // 只靠阶梯首拍（1000ms）时用户先听到的是「进度条在加载但是短暂几秒没有声音」
    // （用户第 50 轮第 2 条原话）。scheduleAutoResume 在勾选态下会因 isPlay 仍为真
    // 直接早退（我们从不对外呈现暂停），所以现场必须有一条与阶梯同一原语、同一组
    // 闸门（停止 / 已不在播 / 手动暂停）的重取。
    if (!mixSlice.includes('if (!global.lx.isPlayedStop && playerState.isPlay && !isManualPause()) play()')) {
      reasons.push('混音分支的「结束」分支缺即时重取 play()（Ended 是唯一「对方已释放」信号；'
        + '只靠阶梯首拍 = 用户先听到几秒无声，正是第 50 轮第 2 条要治的）')
    }
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
    reasons.push('原生缺 LXPlayWithOthersEnabled 声明，或默认值不是 NO（未勾选 / 冷启动必须是标准非混音会话，否则设置项未勾选也会走混音会话）')
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
    results.push({ name, ok: true === hit, detail: hit ? '已拦下' : `未拦下（reasons=${JSON.stringify(reasons)}）` })
  }

  // n1 第 33 轮的抑制开关复活（勾选后又把锁屏播放器一起关掉）
  check('n1 抑制开关复活', () => nowPlayingInvariants(tamper(REAL.np,
    "export const updateNowPlayingInfo = async(metadata: NowPlayingInfoMetadata) => {\n  if (!hasMethod('updateNowPlayingInfo')) return\n",
    "let nowPlayingInfoSuppressed = false\nexport const setNowPlayingInfoSuppressed = (v: boolean) => {\n  nowPlayingInfoSuppressed = v\n}\nexport const updateNowPlayingInfo = async(metadata: NowPlayingInfoMetadata) => {\n  if (nowPlayingInfoSuppressed) return\n  if (!hasMethod('updateNowPlayingInfo')) return\n")),
  '抑制开关')

  // n2 元数据发布被加闸门（唯一出口不再无条件）
  check('n2 元数据发布被加闸门', () => nowPlayingInvariants(tamper(REAL.np,
    "  return NowPlayingModule?.updateNowPlayingInfo?.(metadata)\n}",
    "  if (metadata.title == null) return\n  return NowPlayingModule?.updateNowPlayingInfo?.(metadata)\n}")),
  '唯一出口')

  // n3 切换时又清卡（用户此刻正在看的锁屏播放器被抹掉）
  check('n3 切换时清卡', () => orchestrationInvariants(tamper(REAL.plugin,
    '  await setNativePlayWithOthersPolicy(enabled)\n',
    '  await setNativePlayWithOthersPolicy(enabled)\n  if (enabled) await clearNowPlayingInfo().catch(() => {})\n')),
  '整体撤掉')

  // n4 切换后不重发布（锁屏播放器要等下一行歌词才回来）
  check('n4 切换后不重新发布元数据', () => orchestrationInvariants(tamper(REAL.plugin,
    '  void updateMetaData(playerState.musicInfo, playerState.isPlay, playerState.lastLyric, true)\n',
    '')),
  '重新发布')

  // n5 不下发原生混音策略（同时播放功能失效）
  check('n5 不下发原生混音策略', () => orchestrationInvariants(tamper(REAL.plugin,
    '  await setNativePlayWithOthersPolicy(enabled)\n',
    '')),
  '混音策略')

  // n6 冷启动不下发（重启后设置项显示已勾选、实际是独占口径）
  check('n6 冷启动不下发', () => orchestrationInvariants(tamper(REAL.plugin,
    '  await syncPlayWithOthersEnabled()\n',
    '')),
  '重启后')

  // n7 丢掉「有歌才发布」守卫（空 id 元数据把锁屏播放器刷成空白）
  check('n7 丢掉有歌才发布的守卫', () => orchestrationInvariants(tamper(REAL.plugin,
    '  if (!playerState.musicInfo.id) return\n',
    '')),
  '空 id')

  // n8 丢状态重对齐（原生位置 / 歌词时钟与播放状态脱钩，前台进度条停摆）
  check('n8 丢掉状态重对齐', () => orchestrationInvariants(tamper(REAL.plugin,
    '  if (playerState.isPlay) await playNowPlaying().catch(() => {})\n  else await pauseNowPlaying().catch(() => {})\n',
    '')),
  '重对齐')

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
  // 【第 50 轮】延时表前压成 [1000, 2500, 4000, 5500, 7000, 9000]（同播时前几秒没声音的修复），
  // 锚点必须跟着新字面量走，否则 tamper 未命中会直接抛错、反例失效。
  check('r5 延时表首次重取太密', () => reclaimInvariants(tamper(REAL.service,
    'const MIX_RECLAIM_DELAYS = [1000, 2500, 4000, 5500, 7000, 9000]',
    'const MIX_RECLAIM_DELAYS = [50, 50]')),
  '太密')

  // r6 「结束」分支丢即时重取（对方一松手不现场抢回输出，用户先听到几秒无声）
  check('r6 结束分支丢即时重取', () => reclaimInvariants(tamper(REAL.service,
    '        if (!global.lx.isPlayedStop && playerState.isPlay && !isManualPause()) play()\n',
    '')),
  '即时重取')

  // r7 即时重取被改成无条件 play()（用户手动暂停 / 停止后也会被抢着出声）
  check('r7 即时重取丢了闸门', () => reclaimInvariants(tamper(REAL.service,
    'if (!global.lx.isPlayedStop && playerState.isPlay && !isManualPause()) play()',
    'play()')),
  '即时重取')

  // k1 原生默认值翻成 YES（未勾选也走混音 ⇒ 未勾选就进混音会话）
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
console.log('「与其他应用同时播放」= 元数据照常发布（锁屏播放器在）+ 不因其它音频停播 + 有界重取兜底（第 34 轮第 2 条口径）')
console.log()

const checks = [
  ['元数据照常发布（抑制整体撤除、唯一出口无闸门、六个桥都在、撤销理由留痕）', () => nowPlayingInvariants(REAL.np)],
  ['切换编排 + 冷启动（下发原生策略 → 有歌才按当前曲目重发布 → 按播放状态重对齐；禁止抑制 / 清卡）', () => orchestrationInvariants(REAL.plugin)],
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
