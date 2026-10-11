/**
 * sim-heat-idle-gates.js
 *
 * 第 57 轮「长时间使用发烫 / 不播放音乐留在后台也发烫」的降载闸门契约 + 死代码清除契约。
 *
 * 用户原话（第 57 轮）：「不播放音乐时，减少占用导致的发热，播放音乐时，优化代码，
 * 去除冗余代码，尽量减少代码中的注释，总之减少发热……前提是不要影响目前所有的功能和展示样式。」
 *
 * 三条闸门（都在 ios/LxMusicMobile/AppDelegate.mm）：
 *   A 前台位置事件从 20Hz 节流到 250ms（4Hz）。原先是歌词时钟每一拍都往 JS 发一次位置
 *     （桥接 → JS 处理器 → store 派发 → 进度组件重渲染），是本轮「播放时」发热的主力。
 *     闸门行保持原样、节流**单独嵌套一层**：那一行是 sim-remote-command-lockscreen-tap 的
 *     g7 反例与 sim-nowplaying-lyric-arbitration ⑥ 逐字钉住的锚点，换行即锚点漂移。
 *   B 暂停期间的缓冲轮询从 30ms 放宽到 200ms —— 暂停挂着时唯一还在高频转的轮询。
 *   C stop（真停播）之后、且「图已拆干净」时释放音频会话。会话是后台执行权的凭证
 *     （Info.plist 的 UIBackgroundModes=audio），不释放则「不播放留后台」时进程照旧活着：
 *     JS 定时器、桥接、存活检查全部继续跑。pause 不动（第 48 轮定案：锁屏卡片 / 遥控按键
 *     要靠常驻会话），reset 不动（JS 拿它当「换引擎前的清场」，紧随其后就是另一台引擎起播）。
 *
 * 死代码清除：逐点钉住本轮删掉的「注释掉的死代码」不许回来（代表点），以及 pannerTimer
 * 定时器家族（属性 / 创建 / 取消）整族不许回来。
 *
 * 运行：node scripts/sim-heat-idle-gates.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const APP_DELEGATE = 'ios/LxMusicMobile/AppDelegate.mm'
const PLAYER_UTILS = 'src/plugins/player/utils.ts'
const PLAYER_HOOK = 'src/plugins/player/hook.ts'
const PLAYER_PLAYLIST = 'src/plugins/player/playList.ts'
const COMMON_TEXT = 'src/components/common/Text.tsx'
const COMMON_INPUT = 'src/components/common/Input.tsx'
const THEMES_INDEX = 'src/theme/themes/index.ts'
const SEARCH_ACTION = 'src/store/search/action.ts'

const REAL_APPDELEGATE = read(APP_DELEGATE)
const REAL_UTILS = read(PLAYER_UTILS)
const REAL_HOOK = read(PLAYER_HOOK)
const REAL_PLAYLIST = read(PLAYER_PLAYLIST)
const REAL_TEXT = read(COMMON_TEXT)
const REAL_INPUT = read(COMMON_INPUT)
const REAL_THEMES = read(THEMES_INDEX)
const REAL_SEARCH = read(SEARCH_ACTION)

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 从源码抽出「以 signature 开头、后接大括号体」的函数体（按大括号配平）。 */
const extractBracedBody = (src, signature) => {
  let start = src.indexOf(signature)
  while (start >= 0) {
    const after = src.slice(start + signature.length)
    if (/^\s*\{/.test(after)) {
      const braceStart = start + signature.length + after.indexOf('{')
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
    start = src.indexOf(signature, start + 1)
  }
  return null
}

// ---------------------------------------------------------------------------
// A. 前台位置事件 4Hz 节流
// ---------------------------------------------------------------------------

const POSITION_GATE =
  'if (!paused && [UIApplication sharedApplication].applicationState == UIApplicationStateActive) {'
const POSITION_THROTTLE = 'elapsedRefreshNowMs - LXNowPlayingPositionBroadcastAtMs >= 250.0'
const POSITION_THROTTLE_RE = /elapsedRefreshNowMs - LXNowPlayingPositionBroadcastAtMs >= ([0-9.]+)/
const POSITION_STAMP = 'LXNowPlayingPositionBroadcastAtMs = elapsedRefreshNowMs;'
const POSITION_POST = 'postNotificationName:LXPlayerPositionNotificationName'
const POSITION_DECL = 'static double LXNowPlayingPositionBroadcastAtMs = 0;'
const EARLY_RETURN_NO_LYRIC = 'if (LXNowPlayingLyricLines.count == 0) return;'

const positionThrottleInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)
  const step = extractBracedBody(raw, 'static void LXNowPlayingLyricStep(void)')
  if (!step) {
    reasons.push('LXNowPlayingLyricStep 缺失或抽取失败（锚点漂移）')
    return reasons
  }
  const body = stripComments(step)

  // ① 时钟戳只许一处声明、只许一处写入（多处 = 有人另起了一条位置广播旁路）
  const decls = code.match(/static double LXNowPlayingPositionBroadcastAtMs = 0;/g) || []
  if (decls.length !== 1) {
    reasons.push(`LXNowPlayingPositionBroadcastAtMs 声明 ${decls.length} 处（应恰好一处 —— 多出来的每一处都是绕过 4Hz 节流的旁路）`)
  }
  const inStep = (body.match(/LXNowPlayingPositionBroadcastAtMs/g) || []).length
  const inFile = (code.match(/LXNowPlayingPositionBroadcastAtMs/g) || []).length
  if (inFile !== inStep + 1) {
    reasons.push(`LXNowPlayingPositionBroadcastAtMs 在时钟函数之外还有 ${inFile - inStep - 1} 处引用（位置广播只许留在 LXNowPlayingLyricStep 里）`)
  }
  const stamps = (body.match(/LXNowPlayingPositionBroadcastAtMs = elapsedRefreshNowMs;/g) || []).length
  if (stamps !== 1) {
    reasons.push(`位置广播的时间戳写入 ${stamps} 处（应恰好一处、且与广播同拍 —— 判据读的就是它：不写回时间戳，第二拍起判据永远成立不了，进度条会冻在第一拍）`)
  }

  // ② 节流判据必须在、档位必须是 250ms
  const throttleMatch = POSITION_THROTTLE_RE.exec(body)
  if (throttleMatch == null) {
    reasons.push(`前台位置事件没有 4Hz 节流（缺 \`${POSITION_THROTTLE}\` —— 歌词时钟 20Hz，每一拍都发就等于 20Hz 桥接事件：桥接 → JS 处理器 → store 派发 → 进度组件重渲染，第 57 轮的降发热口径当场作废）`)
  } else if (Number(throttleMatch[1]) !== 250) {
    reasons.push(`位置事件节流档位被改成 ${throttleMatch[1]}ms（第 57 轮契约值 250ms —— 与 JS 侧既有设计同档：慢校准 1s、seek 收敛 2s、进度条 tick 不挂过渡；改小＝桥接次数回升、发热回归，改大＝进度条肉眼可见地一格一格跳）`)
  }

  // ③ 形状：节流嵌在前台闸门里、在广播之前；闸门行本身不许改写
  const iGate = body.indexOf(POSITION_GATE)
  const iThrottle = throttleMatch == null ? -1 : throttleMatch.index
  const iPost = body.indexOf(POSITION_POST)
  const iStamp = body.indexOf(POSITION_STAMP)
  if (iGate < 0) {
    reasons.push('前台闸门行不见了或被改写（第 57 轮口径：闸门行原样保留、节流单独嵌套一层 —— 那一行是 sim-remote-command-lockscreen-tap 的 g7 反例与 sim-nowplaying-lyric-arbitration ⑥ 逐字钉住的锚点）')
  } else if (iThrottle >= 0 && iThrottle < iGate) {
    reasons.push('节流判据落到了「仅前台」闸门之外（后台 / 熄屏时也在判 —— 节流与前台闸门必须同层：闸门里第一句就是节流）')
  }
  if (iPost < 0) {
    reasons.push('位置事件不见了（JS 进度条的前台数据源没了）')
  } else if (iThrottle >= 0 && iThrottle > iPost) {
    reasons.push('节流判据落在位置广播之后（判了等于没判，每拍照发）')
  }
  if (iStamp >= 0 && iPost >= 0 && iStamp > iPost) {
    reasons.push('时间戳写在广播之后（先发再记，下一拍的判据从「刚发过」起算，实际间隔被拉长）')
  }

  // ④ 必须仍在「无歌词早退」之前 —— 没有歌词的歌也要按 4Hz 走进度条
  const iEarly = body.indexOf(EARLY_RETURN_NO_LYRIC)
  if (iThrottle >= 0 && iEarly >= 0 && iThrottle > iEarly) {
    reasons.push('位置事件落在「无歌词早退」之后（没有歌词的歌前台进度条不再更新 —— 这是第 46 轮就修过的老坑）')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// B. 暂停期间的缓冲轮询放宽到 200ms
// ---------------------------------------------------------------------------

const PAUSED_POLL = '[NSThread sleepForTimeInterval:self.manualPause ? 0.2 : 0.03];'

const pausedPollInvariants = (raw) => {
  const reasons = []
  const body = extractBracedBody(raw, '- (void)waitForBufferCapacityIfNeeded')
  if (!body) {
    reasons.push('waitForBufferCapacityIfNeeded 缺失或抽取失败（锚点漂移）')
    return reasons
  }
  const code = stripComments(body)

  if (!code.includes('while (!self.stopRequested && !self.seekRequested)')) {
    reasons.push('缓冲等待循环不见了（stopRequested / seekRequested 守卫没了，这条空转轮询会一直转下去）')
  }
  if (!code.includes(PAUSED_POLL)) {
    const m = /\[NSThread sleepForTimeInterval:[^\]]*\]/.exec(code)
    reasons.push(`暂停期间的缓冲轮询不是 200ms（第 57 轮口径：手动暂停时从 33Hz（30ms）放宽到 5Hz（200ms） —— 暂停期间环里已存着 pausedBufferSeconds 的音频，最坏 200ms 才补货，听感无差异；当前原文：${m ? m[0] : '（找不到 sleepForTimeInterval）'}）`)
  }
  const iBreak = code.indexOf('if (!shouldWait) break;')
  const iSleep = code.indexOf('[NSThread sleepForTimeInterval:')
  if (iBreak >= 0 && iSleep >= 0 && iSleep < iBreak) {
    reasons.push('睡眠落在「不需要等就跳出」之前（不需要等待时也会先睡一觉，反而拖慢正常起播）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// C. stop 之后释放音频会话（幂等守卫 + 调用点唯一）
// ---------------------------------------------------------------------------

const RELEASE_CALL = '[self releaseAudioSessionWhenIdle];'
const RELEASE_GUARD = 'if (self.engine != nil || self.sourceNode != nil) return;'
const STOP_SIGNATURE =
  'RCT_REMAP_METHOD(stop, stopStreamWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)'
const RESET_SIGNATURE =
  'RCT_REMAP_METHOD(reset, resetStreamWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)'
const STOP_INTERNAL_SIGNATURE = '- (void)stopStreamingInternal:(BOOL)resetAudio'

const releaseWhenIdleInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ① 定义 + 幂等守卫 + 真的 setActive:NO
  const def = extractBracedBody(raw, '- (void)releaseAudioSessionWhenIdle')
  if (!def) {
    reasons.push('releaseAudioSessionWhenIdle 定义缺失（「不播放留后台」将重新持有会话：进程不被挂起，JS 定时器 / 桥接 / 存活检查照旧跑，正是用户第 57 轮报的「不播放音乐留在后台也会很烫」）')
  } else {
    const body = stripComments(def)
    if (!body.includes(RELEASE_GUARD)) {
      reasons.push(`释放会话前没有「图已拆干净」的守卫（缺 \`${RELEASE_GUARD}\` —— 引擎 / 源节点还在时释放会当场静音：这是本轮唯一会「一放就没声」的写法）`)
    }
    if (!/\[session setActive:NO/.test(body)) {
      reasons.push('释放函数里没有 setActive:NO（会话根本没让出，等于什么都没做）')
    }
  }

  // ② 调用点唯一，且在 stop 里、排在 stopStreamingInternal 之后
  const calls = (code.match(/\[self releaseAudioSessionWhenIdle\];/g) || []).length
  if (calls !== 1) {
    reasons.push(`释放会话的调用点 ${calls} 处（应恰好一处：只有 stop 释放 —— pause 释放会让锁屏卡片变灰、遥控按键与进度条拖动全失效（第 48 轮定案）；reset 释放会在「换引擎前的清场」里把紧随其后的起播挡掉）`)
  }
  const stop = extractBracedBody(raw, STOP_SIGNATURE)
  if (!stop) {
    reasons.push('RCT_REMAP_METHOD(stop, ...) 缺失或抽取失败（锚点漂移）')
  } else {
    const body = stripComments(stop)
    const iInner = body.indexOf('[self stopStreamingInternal:YES];')
    const iRelease = body.indexOf(RELEASE_CALL)
    if (iRelease < 0) {
      reasons.push('stop 里不再释放音频会话（「不播放留后台」的发热成因就回来了）')
    } else if (iInner >= 0 && iRelease < iInner) {
      reasons.push('释放排在 stopStreamingInternal 之前（图还没拆就判「引擎 / 源节点是否为空」—— 判据必须排在拆图之后）')
    }
  }

  // ③ 不许塞进 stopStreamingInternal（openStream 会先激活会话再调它 ⇒ 起播瞬间被释放）
  const internal = extractBracedBody(raw, STOP_INTERNAL_SIGNATURE)
  if (internal && stripComments(internal).includes('releaseAudioSessionWhenIdle')) {
    reasons.push('释放会话被塞进了 stopStreamingInternal —— openStream 的顺序是「先 prepareAudioSession（setActive:YES）再 stopStreamingInternal」，塞进来就会在起播瞬间把刚激活的会话释放掉（直接无声）')
  }
  // ④ 不许塞进 reset（JS 把 reset 当换引擎前的清场）
  const reset = extractBracedBody(raw, RESET_SIGNATURE)
  if (reset && stripComments(reset).includes('releaseAudioSessionWhenIdle')) {
    reasons.push('reset 里也释放了音频会话 —— JS 侧把 reset 当「换引擎前的清场」（nativeFlac → AVPlayer 兜底、startNativeFlacPlayback 开场），紧随其后就是另一台引擎起播：在这里让出会话等于给起播挖坑')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// D. 死代码清除（本轮删掉的注释代码不许回来）
// ---------------------------------------------------------------------------

// [文件, 原文, 回归标志（任一命中即回归）, 为什么会回来 = 回归后果]
// 注意：这里**不能** stripComments —— 要拦的正是「注释掉的死代码又贴回来」，
// 所以标志串都取「只在代码里出现、不会出现在说明性注释里」的形状。
const DEAD_CODE_GONE = [
  [APP_DELEGATE, REAL_APPDELEGATE, ['self.pannerTimer', 'dispatch_source_t pannerTimer'],
    'pannerTimer 定时器家族（属性 / 创建 / 取消）第 57 轮已整族删除：声像摆动早已改由 _realtimePannerProcessor 在渲染回调里做，那个 dispatch_source 没有任何创建点，只留下「取消一个永远是 nil 的定时器」'],
  [PLAYER_UTILS, REAL_UTILS, ['debouncePlayMusicTools'],
    'debouncePlayMusicTools（快速切歌去抖的旧实现）已由 playList.ts 的 debounceUpdateMetaInfoTools 取代'],
  [PLAYER_HOOK, REAL_HOOK, ['useTrackPlayerEvents'],
    'hook.ts 里的 useTrackPlayerEvents 本地副本已删除（事件订阅走统一漏斗，别再养第二份）'],
  [PLAYER_PLAYLIST, REAL_PLAYLIST, ['delayUpdateMusicInfo = (('],
    'playList.ts 里注释掉的旧 delayUpdateMusicInfo 实现已删除（真身是同文件的 debounceUpdateMetaInfoTools.init()）'],
  [COMMON_TEXT, REAL_TEXT, ['warpText'],
    'Text.tsx 里注释掉的 warpText 实现已删除'],
  [COMMON_INPUT, REAL_INPUT, ['showClearBtn'],
    'Input.tsx 里注释掉的 clear 按钮动画实现已删除'],
  [THEMES_INDEX, REAL_THEMES, ['copyTheme'],
    'themes/index.ts 里注释掉的 copyTheme 实现已删除'],
  [SEARCH_ACTION, REAL_SEARCH, ['isInitedSearchHistory'],
    'search/action.ts 里注释掉的搜索历史初始化实现已删除'],
  [APP_DELEGATE, REAL_APPDELEGATE, ['LXStartRemoteCommandWatchdog'],
    '第 43 轮删掉的 1s 可用性看门狗不许回来（它只重写六个 enabled、不重发 info / playbackState，会把显示态与启停态的分叉钉死）'],
]

// overrides：反例用「篡改后的原文」替换某个文件的正文（不污染模块级常量）
const deadCodeInvariants = (overrides = {}) => {
  const reasons = []
  for (const [file, text, patterns, why] of DEAD_CODE_GONE) {
    const body = file in overrides ? overrides[file] : text
    const hit = patterns.find(p => body.includes(p))
    if (hit) {
      reasons.push(`${file} 里又出现了 \`${hit}\` —— ${why}`)
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

const POSITION_BLOCK =
  '      if (elapsedRefreshNowMs - LXNowPlayingPositionBroadcastAtMs >= 250.0) {\n' +
  '        LXNowPlayingPositionBroadcastAtMs = elapsedRefreshNowMs;\n' +
  '        [[NSNotificationCenter defaultCenter] postNotificationName:LXPlayerPositionNotificationName\n' +
  '                                                            object:nil\n' +
  '                                                            userInfo:@{ @"position": @(positionMs / 1000.0), @"rate": @(rate) }];\n' +
  '      }\n'

const runCounterExamples = () => {
  const results = []
  const check = (name, fn, expectReasonSubstr) => {
    let reasons = []
    try {
      reasons = fn()
    } catch (e) {
      results.push({ name, ok: false, detail: `抛异常: ${String(e.message).slice(0, 120)}` })
      return
    }
    const hit = reasons.some(r => r.includes(expectReasonSubstr))
    results.push({ name, ok: hit, detail: hit ? '已拦下' : `未拦下（reasons=${JSON.stringify(reasons)}）` })
  }

  // ── A 位置事件节流 ──────────────────────────────────────────────────────
  // p1 节流整块删掉（= 回到第 57 轮之前：每拍 20Hz 都发）→ 报「4Hz 节流」
  check('p1 前台位置事件回到 20Hz 每拍发', () => positionThrottleInvariants(tamper(REAL_APPDELEGATE,
    POSITION_BLOCK, ''))
    , '4Hz 节流')

  // p2 档位缩到 50ms（≈ 每拍都发，节流名存实亡）→ 报「契约值 250ms」
  check('p2 节流档位被缩到 50ms', () => positionThrottleInvariants(tamper(REAL_APPDELEGATE,
    'elapsedRefreshNowMs - LXNowPlayingPositionBroadcastAtMs >= 250.0',
    'elapsedRefreshNowMs - LXNowPlayingPositionBroadcastAtMs >= 50.0'))
    , '契约值 250ms')

  // p3 判据在、时间戳不写（第二拍起判据永远成立不了 → 进度条冻在第一拍）→ 报「时间戳」
  check('p3 只判节流不写时间戳', () => positionThrottleInvariants(tamper(REAL_APPDELEGATE,
    '        LXNowPlayingPositionBroadcastAtMs = elapsedRefreshNowMs;\n', ''))
    , '时间戳')

  // p4 节流块被搬到「仅前台」闸门外面（后台 / 熄屏也在判）→ 报「闸门之外」
  check('p4 节流块被搬到前台闸门之外', () => positionThrottleInvariants(tamper(REAL_APPDELEGATE,
    '    ' + POSITION_GATE + '\n' + POSITION_BLOCK,
    POSITION_BLOCK + '    ' + POSITION_GATE + '\n'))
    , '闸门之外')

  // p5 闸门行被改写（把节流并进同一行条件 —— 会让 g7 / ⑥ 的锚点漂移）→ 报「闸门行」
  check('p5 前台闸门行被改写', () => positionThrottleInvariants(tamper(REAL_APPDELEGATE,
    POSITION_GATE, 'if (!paused && appActive) {'))
    , '闸门行')

  // ── B 暂停轮询 ──────────────────────────────────────────────────────────
  // q1 退回 30ms（暂停挂着时每秒 33 次唤醒）→ 报「200ms」
  check('q1 暂停轮询退回 30ms', () => pausedPollInvariants(tamper(REAL_APPDELEGATE,
    PAUSED_POLL, '[NSThread sleepForTimeInterval:0.03];'))
    , '200ms')

  // ── C stop 释放会话 ────────────────────────────────────────────────────
  // c1 调用点从 stop 挪进 stopStreamingInternal（openStream 也走它 ⇒ 起播瞬间被释放）→ 报「stopStreamingInternal」
  check('c1 释放会话被塞进 stopStreamingInternal', () => releaseWhenIdleInvariants(tamper(
    tamper(REAL_APPDELEGATE, '  [self stopStreamingInternal:YES];\n  [self releaseAudioSessionWhenIdle];\n', '  [self stopStreamingInternal:YES];\n'),
    STOP_INTERNAL_SIGNATURE + ' {\n',
    STOP_INTERNAL_SIGNATURE + ' {\n  [self releaseAudioSessionWhenIdle];\n'))
    , 'stopStreamingInternal')

  // c2 幂等守卫被删（无条件 setActive:NO）→ 报「守卫」
  check('c2 释放前不判「图是否拆干净」', () => releaseWhenIdleInvariants(tamper(REAL_APPDELEGATE,
    '  ' + RELEASE_GUARD + '\n', ''))
    , '守卫')

  // c3 reset 里也释放一次（换引擎前的清场被让出会话）→ 报「reset」
  check('c3 reset 里也释放会话', () => releaseWhenIdleInvariants(tamper(REAL_APPDELEGATE,
    RESET_SIGNATURE, RESET_SIGNATURE + '\n  [self releaseAudioSessionWhenIdle];\n'))
    , 'reset')

  // c4 整个释放函数被删（会话重新常驻）→ 报「定义缺失」
  check('c4 释放函数被整条删除', () => releaseWhenIdleInvariants(tamper(REAL_APPDELEGATE,
    '- (void)releaseAudioSessionWhenIdle {\n  if (self.engine != nil || self.sourceNode != nil) return;\n  AVAudioSession *session = [AVAudioSession sharedInstance];\n  [session setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];\n}\n\n',
    ''))
    , '定义缺失')

  // ── D 死代码回流 ───────────────────────────────────────────────────────
  // d1 pannerTimer 家族回来（属性 / 创建 / 取消任意一处）→ 报「pannerTimer」
  check('d1 pannerTimer 定时器家族回归', () => deadCodeInvariants({
    [APP_DELEGATE]: tamper(REAL_APPDELEGATE,
      '- (void)releaseAudioSessionWhenIdle {',
      '  self.pannerTimer = nil;\n- (void)releaseAudioSessionWhenIdle {'),
  }), 'pannerTimer')

  // d2 注释掉的死代码回来（themes/index.ts 的 copyTheme）→ 报「copyTheme」
  check('d2 死代码 copyTheme 回流', () => deadCodeInvariants({
    [THEMES_INDEX]: tamper(REAL_THEMES, 'export const getTheme = async() => {',
      '// const copyTheme = (id) => {\n// }\nexport const getTheme = async() => {'),
  }), 'copyTheme')

  // d3 第 43 轮删掉的 1s 看门狗回来 → 报「看门狗」
  check('d3 可用性看门狗回归', () => deadCodeInvariants({
    [APP_DELEGATE]: tamper(REAL_APPDELEGATE,
      '- (void)releaseAudioSessionWhenIdle {',
      '// static void LXStartRemoteCommandWatchdog(void) {\n//   LXApplyNowPlayingInfo();\n// }\n- (void)releaseAudioSessionWhenIdle {'),
  }), '看门狗')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-heat-idle-gates ===')

const checks = [
  ['原生：前台位置事件 4Hz 节流（第 57 轮 A）', () => positionThrottleInvariants(REAL_APPDELEGATE)],
  ['原生：暂停期间缓冲轮询放宽到 200ms（第 57 轮 B）', () => pausedPollInvariants(REAL_APPDELEGATE)],
  ['原生：stop 之后在「图已拆干净」时释放音频会话（第 57 轮 C）', () => releaseWhenIdleInvariants(REAL_APPDELEGATE)],
  ['死代码：已删的注释代码与 pannerTimer 家族不许回来（第 57 轮 D）', () => deadCodeInvariants()],
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
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.ok ? '已拦下' : `未拦下（${r.detail}）`}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
