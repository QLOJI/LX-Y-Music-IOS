/*
 * 第十五轮另外三条的契约模型（用户第 15 轮第 1 / 2 / 4 条）
 *
 * ① 连接码验证成功后「列表同步方式」选择框不弹出（第 1 条）
 *    链路：设置页 Sync/IsEnable 的确认回调 → connectServer → 服务端握手后回问同步方式
 *    → core/sync 触发 showSyncModeModal → navigation/utils 用 RNN overlay 呈现。
 *    失败面有三条，本脚本把三条防线都钉住：
 *      a. 连接码输入框是 RN 原生 Modal，若在它还没走完淡出 / 卸载时就呈现 overlay，
 *         iOS 上 overlay 会被挂到正在消失的宿主 VC 上、随它一起消失，而 Promise 照常
 *         resolve —— 只监听 reject 的实现会漏掉这种静默失败。IsEnable 改为「先关输入框，
 *         延时 400ms 再 connectServer」，延时值对齐「先卸载 Dialog 再调起原生面板」的既有口径。
 *      b. overlay resolve 之后延时复查「SyncModeModal 是否真的挂上了」：判据是它挂载时写进
 *         store 的 syncModeComponentId；仍为空 → 按失败重试呈现（上限 5 次 / 间隔 700ms）。
 *      c. 复查必须能作废：用户已作答 / 取消 / 连接断开时 core/sync 的 closeSyncModeModal
 *         无条件调用 cancelSyncModeModalRetries()（代次 +1），否则到点的复查会把用户已经
 *         回答过的选择框再弹一次（幽灵弹窗）。另外 overlay 是 interceptTouchOutside 的
 *         全屏透明层，叠两个会拦整页触摸（假死），所以 SyncModeModal 挂载时若 store 里还
 *         记着另一个活的选择框，先关旧的；卸载时只清「自己那一个」。
 *
 * ② 搜索筛选下拉框要「上贴搜索框下端」（第 2 条）
 *    浮层容器的 top 来自 HeaderBar 里搜索框 View 的 onLayout（y + height；y 要先加上容器
 *    上内边距才是页面坐标）。**高度必须与这个 top 同源**（containerHeight − top）：展开 /
 *    收起动画用 translateY(∓height/2) 抵消「以中心缩放」的位移，height 若还按整块 header
 *    算（旧实现 containerHeight − headerHeight，比真实高度小），补偿量就偏小，盒子会在动画
 *    期间从搜索框上端附近一路往下滑、遮住输入框 —— 就是「下拉框和搜索框底部没对齐」。
 *    本脚本钉住 tipListTopRef（top）与 syncTipListHeight（height）同源、三处调用都传
 *    这个高度、搜索框 onLayout 上报的坐标是页面坐标。
 *
 * ③ 音频预加载只在当前歌曲「播到最后 10 秒」才开始（第 4 条）
 *    两条调用路径都要过这道闸：
 *      a. 进度驱动：init/player/preloadNextMusic.ts 的 playProgressChanged 监听（第 11 轮已收窄）；
 *      b. controller 驱动：core/player/preload.ts 的 startPreload —— 起播 / 暂停恢复 / 切歌
 *         都会调它，第 11 轮漏了这里，所以「一起播就取下一首」。本轮在 preloadNextMusic()
 *         函数体内补了同口径时间闸（必须在取链之前、且在 isPreloading 置位之前），并让进度
 *         监听在暖链（nativeFlac 预启动 / URL 预热）完成后**串行**调 startPreload —— 串行是
 *         为了第二步命中第一步刚写入的 URL 缓存（core/music 按档位缓存），同一时刻不会对
 *         同一首歌发两次请求。
 *
 * 本脚本是**静态源码解析**（正则 + 位置比较），钉的是「结构还在不在」，证明不了真机行为。
 * 每条断言都配了一个「改回旧实现就该判红」的反例，反例全部用当前源码变异，防止断言写成
 * 永远为真的空壳。
 *
 * 运行：node scripts/sim-sync-search-preload.js
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
const neg = (label, ok) => {
  results.push({ label, ok: !!ok })
  if (!ok) failed++
}

const F = {
  utils: 'src/navigation/utils.ts',
  sync: 'src/core/sync.ts',
  modal: 'src/navigation/components/SyncModeModal.tsx',
  isEnable: 'src/screens/Home/Views/Setting/settings/Sync/IsEnable.tsx',
  search: 'src/screens/Home/Views/Search/index.tsx',
  headerBar: 'src/screens/Home/Views/Search/HeaderBar/index.tsx',
  preload: 'src/core/player/preload.ts',
  preloadNext: 'src/core/init/player/preloadNextMusic.ts',
}
const readSet = (keys) => {
  const s = {}
  for (const k of keys) s[k] = read(F[k])
  return s
}
const sliceBy = (code, from, to) => {
  const a = code.indexOf(from)
  if (a < 0) return ''
  const b = code.indexOf(to, a)
  if (b < 0) return ''
  return code.slice(a, b + to.length)
}
const runGroup = (group, src) => group.map(([label, fn]) => ({ label, ok: !!fn(src) }))

// ==================== A. 同步方式选择框 ====================
const GROUP_A = [
  ['utils：有挂载复查代次 syncModeModalSeq（初值 0）',
    (s) => /let syncModeModalSeq = 0/.test(s.utils)],
  ['utils：导出 cancelSyncModeModalRetries（代次 +1）',
    (s) => /export const cancelSyncModeModalRetries = \(\) => \{\s*\n\s*syncModeModalSeq \+= 1\s*\n\}/.test(s.utils)],
  ['utils：每次呈现取一个代次（seq = ++syncModeModalSeq）',
    (s) => /const seq = \+\+syncModeModalSeq/.test(s.utils)],
  ['utils：复查延时 1000ms / 重试间隔 700ms / 上限 5 次',
    (s) => /const verifyDelay = 1000/.test(s.utils) &&
      /const retryDelay = 700/.test(s.utils) &&
      /const maxAttempts = 5/.test(s.utils)],
  ['utils：resolve 之后才复查，且先比代次（已作答 / 已取消就作废）',
    (s) => /\.then\(\(\) => \{\s*\n\s*setTimeout\(\(\) => \{[\s\S]{0,200}?if \(seq !== syncModeModalSeq\) return/.test(s.utils)],
  ['utils：复查判据 = store 里的 componentId（已挂上就停手，绝不叠第二个）',
    (s) => /if \(syncState\.syncModeComponentId\) return/.test(s.utils)],
  ['utils：判据为空才按「没挂上」走重试（handleFail）',
    (s) => /handleFail\(attempt, new Error\('overlay not mounted'\)\)/.test(s.utils)],
  ['utils：showOverlay 的 reject 与静默失败走同一条重试路径',
    (s) => /\.catch\(\(err\) => \{\s*\n\s*handleFail\(attempt, err\)/.test(s.utils)],
  ['utils：重试有上限（attempt >= maxAttempts 停手），首次呈现是 present(1)',
    (s) => /if \(attempt >= maxAttempts\) return/.test(s.utils) &&
      /setTimeout\(\(\) => \{[\s\S]{0,200}?present\(attempt \+ 1\)[\s\S]{0,40}?\}, retryDelay\)/.test(s.utils) &&
      /present\(1\)\s*\n\}/.test(s.utils)],
  ['utils：重试 tick 也先复查代次（作废发生在 700ms 窗口里也不再补弹）',
    (s) => /setTimeout\(\(\) => \{[\s\S]{0,200}?if \(seq !== syncModeModalSeq\) return[\s\S]{0,120}?present\(attempt \+ 1\)/.test(s.utils)],
  ['sync：closeSyncModeModal 关掉旧框并清 componentId',
    (s) => /const closeSyncModeModal = \(\) => \{[\s\S]{0,200}?dismissOverlay\(syncState\.syncModeComponentId\)[\s\S]{0,120}?setSyncModeComponentId\(''\)/.test(s.sync)],
  ['sync：作废复查的调用在 if 之外、无条件执行（幽灵弹窗防线）',
    (s) => /if \(syncState\.syncModeComponentId\) \{[\s\S]{0,240}?\n  \}\n[\s\S]{0,240}?cancelSyncModeModalRetries\(\)/.test(s.sync)],
  ['sync：作答（handleSelectMode）与断开（removeSyncModeEvent）都走 closeSyncModeModal',
    (s) => (s.sync.match(/^[ \t]+closeSyncModeModal\(\)$/gm) || []).length >= 2],
  ['modal：挂载时若 store 里还有另一个活的选择框，先关旧的',
    (s) => /if \(syncState\.syncModeComponentId && syncState\.syncModeComponentId != componentId\) \{[\s\S]{0,120}?dismissOverlay\(syncState\.syncModeComponentId\)/.test(s.modal)],
  ['modal：挂载写回 componentId（复查判据的来源）',
    (s) => /setSyncModeComponentId\(componentId\)/.test(s.modal)],
  ['modal：卸载只清自己那一个（别人值班时不误清）',
    (s) => /if \(syncState\.syncModeComponentId == componentId\) setSyncModeComponentId\(''\)/.test(s.modal)],
  ['isEnable：先关连接码输入框，再延时 400ms 发起连接（避开原生 Modal 淡出竞态）',
    (s) => {
      const body = sliceBy(s.isEnable, 'const handleSetCode = useCallback', '}, [host, authCode])')
      const iClose = body.indexOf('confirmAlertRef.current?.setVisible(false)')
      const iCall = body.indexOf('void connectServer(host, code)')
      return iClose >= 0 && iCall > iClose &&
        /setTimeout\(\(\) => \{[\s\S]{0,160}?void connectServer\(host, code\)[\s\S]{0,40}?\}, 400\)/.test(body)
    }],
  ['isEnable：延时的 connectServer 有卸载守卫（页面已离开就不再连接）',
    (s) => /setTimeout\(\(\) => \{[\s\S]{0,120}?if \(isUnmountedRef\.current\) return[\s\S]{0,80}?connectServer\(host, code\)/.test(s.isEnable)],
]

// ==================== B. 搜索筛选浮层 ====================
const GROUP_B = [
  ['search：tipListTopRef 记录浮层上端（页面坐标）',
    (s) => /const tipListTopRef = useRef\(0\)/.test(s.search)],
  ['search：浮层高度以「上端」为基准（containerHeight − top），且首帧回退整块 header',
    (s) => /const top = tipListTopRef\.current \|\| headerHeightRef\.current/.test(s.search) &&
      /layoutHeightRef\.current = Math\.max\(0, containerHeightRef\.current - top\)/.test(s.search)],
  ['search：搜索框 onLayout 回调写入「搜索框下端」并同步高度',
    (s) => {
      const body = sliceBy(s.search, 'const handleSearchBarLayout', '}, [syncTipListHeight])')
      const iTop = body.indexOf('tipListTopRef.current = rect.y + rect.height')
      const iSync = body.indexOf('syncTipListHeight()')
      return iTop >= 0 && iSync > iTop
    }],
  ['search：容器 onLayout 与 header onLayout 都会重算高度（两处真实高度来源同一口径）',
    (s) => {
      const container = /containerHeightRef\.current = e\.nativeEvent\.layout\.height[\s\S]{0,80}?syncTipListHeight\(\)/.test(s.search)
      const header = /headerHeightRef\.current = nativeEvent\.layout\.height[\s\S]{0,120}?syncTipListHeight\(\)/.test(s.search)
      return container && header
    }],
  ['search：浮层容器 top = 搜索框下端，left/width 与搜索框同宽，首帧回退整宽',
    (s) => /top: searchBarRect\.y \+ searchBarRect\.height,/.test(s.search) &&
      /left: searchBarRect\.x,/.test(s.search) &&
      /width: searchBarRect\.width,/.test(s.search) &&
      /top: headerHeight, left: 0, right: 0/.test(s.search)],
  ['search：三处调起浮层都传 layoutHeightRef（与定位同一份高度）',
    (s) => (s.search.match(/searchTipListRef\.current\?\.(?:search|show)\([^)]*layoutHeightRef\.current\)/g) || []).length >= 3],
  ['search：把 handleSearchBarLayout 接到 HeaderBar 的 onSearchBarLayout',
    (s) => /onSearchBarLayout=\{handleSearchBarLayout\}/.test(s.search)],
  ['headerBar：搜索框 onLayout 上报页面坐标（y 加容器上内边距）',
    (s) => /onSearchBarLayout\(\{ x, y: containerPaddingTop \+ y, width, height \}\)/.test(s.headerBar)],
]

// ==================== C. 预加载「最后 10 秒」 ====================
const GROUP_C = [
  ['preload：函数体内有时间闸（不在最后 10 秒直接返回，不取链）',
    (s) => /if \(!\(maxPlayTime > 10 && maxPlayTime - nowPlayTime < 10\)\) \{/.test(s.preload)],
  ['preload：时间闸在 isPreloading 置位之前、在取下一首之前（先判时间再占位再取链）',
    (s) => {
      const iGate = s.preload.indexOf('maxPlayTime > 10 && maxPlayTime - nowPlayTime < 10')
      const iFlag = s.preload.indexOf('isPreloading = true')
      const iFetch = s.preload.indexOf('await getNextPlayMusicInfo()')
      return iGate >= 0 && iFlag > iGate && iFetch > iGate
    }],
  ['preload：极短音频不预取（下界 > 10s，与进度监听同口径）',
    (s) => /maxPlayTime > 10/.test(s.preload)],
  ['preloadNext：进度触发条件 = 剩余 < 10s 且本首还没取过（!preloadMusicInfo.info 去重）',
    (s) => /if \(duration > 10 && duration - progress\.nowPlayTime < 10 && !preloadMusicInfo\.info\) \{/.test(s.preloadNext)],
  ['preloadNext：暖链完成后串行调 startPreload（第二步命中第一步写的 URL 缓存）',
    (s) => /void preloadNextMusicUrl\(progress\.nowPlayTime\)[\s\S]{0,80}?\.then\(\(\) => \{\s*\n\s*startPreload\(\)/.test(s.preloadNext)],
  ['preloadNext：已注册 playProgressChanged 监听（这条链真的会在播到 10 秒内时被叫醒）',
    (s) => /global\.state_event\.on\('playProgressChanged', handlePlayProgressChanged\)/.test(s.preloadNext)],
  ['preloadNext：startPreload 从 core/player/preload 导入（串行调用的是同一个预加载入口）',
    (s) => /import \{ startPreload \} from '@\/core\/player\/preload'/.test(s.preloadNext)],
  ['两处阈值同口径（都是 > 10 与 < 10，不存在一边 20 秒的旧口径）',
    (s) => /duration > 10 && duration - progress\.nowPlayTime < 10/.test(s.preloadNext) &&
      /maxPlayTime > 10 && maxPlayTime - nowPlayTime < 10/.test(s.preload)],
]

const SRC_A = readSet(['utils', 'sync', 'modal', 'isEnable'])
const SRC_B = readSet(['search', 'headerBar'])
const SRC_C = readSet(['preload', 'preloadNext'])

const aRes = runGroup(GROUP_A, SRC_A)
const bRes = runGroup(GROUP_B, SRC_B)
const cRes = runGroup(GROUP_C, SRC_C)

// —— 反例（全部用当前源码变异，必须被对应分组判红）——
const mutated = (src, key, from, to) => {
  const m = Object.assign({}, src)
  m[key] = src[key].replace(from, to)
  return { m, changed: m[key] !== src[key] }
}
const caught = (group, src) => runGroup(group, src).some((r) => !r.ok)

// n1: utils 拿掉「已挂上就停手」的判据（复查变成无条件重试）
const n1 = mutated(SRC_A, 'utils',
  'if (syncState.syncModeComponentId) return',
  'if (false) return')
// n2: sync 删掉复查作废（幽灵弹窗防线没了）
const n2 = mutated(SRC_A, 'sync',
  '  cancelSyncModeModalRetries()\n}',
  '}')
// n3: isEnable 退回「点确认就立刻连接」（原生 Modal 还在淡出）
const n3 = mutated(SRC_A, 'isEnable',
  '    setTimeout(() => {\n      if (isUnmountedRef.current) return\n      void connectServer(host, code)\n    }, 400)',
  '    void connectServer(host, code)')
// n4: modal 拿掉「先关掉另一个活的选择框」的去重防线
const n4 = mutated(SRC_A, 'modal',
  'if (syncState.syncModeComponentId && syncState.syncModeComponentId != componentId) {',
  'if (false) {')
// n5: search 高度退回旧口径「容器高 − 整块 header 高」
const n5 = mutated(SRC_B, 'search',
  '    const top = tipListTopRef.current || headerHeightRef.current\n    layoutHeightRef.current = Math.max(0, containerHeightRef.current - top)',
  '    layoutHeightRef.current = Math.max(0, containerHeightRef.current - headerHeightRef.current)')
// n6: search 浮层 top 退回整块 header 下端
const n6 = mutated(SRC_B, 'search',
  'top: searchBarRect.y + searchBarRect.height,',
  'top: headerHeight,')
// n7: headerBar 上报相对坐标（漏掉容器上内边距，top 会整体上偏）
const n7 = mutated(SRC_B, 'headerBar',
  'onSearchBarLayout({ x, y: containerPaddingTop + y, width, height })',
  'onSearchBarLayout({ x, y, width, height })')
// n8: preload 把时间闸拆掉（起播就取下一首）
const n8 = mutated(SRC_C, 'preload',
  'if (!(maxPlayTime > 10 && maxPlayTime - nowPlayTime < 10)) {',
  'if (false) {')
// n9: preload 把 isPreloading 抢到时间闸之前（占位先于判定）
const n9 = mutated(SRC_C, 'preload',
  '  const { nowPlayTime, maxPlayTime } = playerState.progress',
  '  isPreloading = true\n  const { nowPlayTime, maxPlayTime } = playerState.progress')
// n10: preloadNext 砍掉串行暖链（只剩本模块的 URL 预热）
const n10 = mutated(SRC_C, 'preloadNext',
  '      void preloadNextMusicUrl(progress.nowPlayTime)\n        .catch(() => {})\n        .then(() => {\n          startPreload()\n        })',
  '      void preloadNextMusicUrl(progress.nowPlayTime).catch(() => {})')
// n11: utils 重试 tick 拿掉代次复查（作废发生在 700ms 窗口里时仍补弹幽灵框）
const n11 = mutated(SRC_A, 'utils',
  '      if (seq !== syncModeModalSeq) return\n      present(attempt + 1)',
  '      present(attempt + 1)')

// —— 输出 ——
console.log('='.repeat(92))
console.log('「同步选择框 / 搜索浮层 / 预加载 10 秒闸」契约模型（摘自源码，静态解析）')
console.log('='.repeat(92))
console.log(`  A 同步模式选择框：${aRes.filter((r) => r.ok).length}/${aRes.length} 通过`)
console.log(`  B 搜索筛选浮层  ：${bRes.filter((r) => r.ok).length}/${bRes.length} 通过`)
console.log(`  C 预加载 10 秒闸：${cRes.filter((r) => r.ok).length}/${cRes.length} 通过`)
console.log()

console.log('—— A. 连接码验证成功后的「列表同步方式」选择框 ——')
for (const r of aRes) check(r.label, r.ok)
console.log('—— B. 搜索筛选下拉框上贴搜索框下端（top 与高度同源）——')
for (const r of bRes) check(r.label, r.ok)
console.log('—— C. 音频预加载只在最后 10 秒开始（两条路径同口径）——')
for (const r of cRes) check(r.label, r.ok)

neg('反例 n1：utils 拿掉「已挂上就停手」判据（叠加 / 幽灵重试），被 A 判红', n1.changed && caught(GROUP_A, n1.m))
neg('反例 n2：sync 删掉复查作废（用户回答后被再弹一次），被 A 判红', n2.changed && caught(GROUP_A, n2.m))
neg('反例 n3：isEnable 退回「点确认立刻连接」（撞原生 Modal 淡出），被 A 判红', n3.changed && caught(GROUP_A, n3.m))
neg('反例 n4：modal 拿掉重复呈现去重（两个透明层拦整页触摸），被 A 判红', n4.changed && caught(GROUP_A, n4.m))
neg('反例 n5：search 高度退回「容器高 − 整块 header 高」（旧 bug），被 B 判红', n5.changed && caught(GROUP_B, n5.m))
neg('反例 n6：search 浮层 top 退回整块 header 下端，被 B 判红', n6.changed && caught(GROUP_B, n6.m))
neg('反例 n7：headerBar 上报相对坐标（top 上偏），被 B 判红', n7.changed && caught(GROUP_B, n7.m))
neg('反例 n8：preload 拆掉时间闸（起播就取下一首），被 C 判红', n8.changed && caught(GROUP_C, n8.m))
neg('反例 n9：preload 把 isPreloading 抢到时间闸之前，被 C 判红', n9.changed && caught(GROUP_C, n9.m))
neg('反例 n10：preloadNext 砍掉串行暖链，被 C 判红', n10.changed && caught(GROUP_C, n10.m))
neg('反例 n11：utils 拿掉重试 tick 的代次复查（作废窗口内补弹幽灵框），被 A 判红', n11.changed && caught(GROUP_A, n11.m))

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
