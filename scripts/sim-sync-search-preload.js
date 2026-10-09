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
 *      b. overlay resolve 之后延时复查「SyncModeModal 是否真的挂上了」：判据是它挂载时点亮的
 *         「在屏幕上」标记（syncModeModalVisible）；仍为 false → 按失败重试呈现（上限 5 次 / 间隔 700ms）。
 *         【第 36 轮第 1 条】判据从 store 里的 syncModeComponentId 换成 syncModeModalVisible：
 *         id 是「挂载时写回、卸载清理时清掉」的，原生把 overlay 收走却没跑到 JS 卸载清理时它就是
 *         一条残留 —— 拿 id 当「挂上了」会误判成已挂载而停止重试，选择框再也弹不出来（用户第 36
 *         轮第 1 条：状态一直「等待选择同步方式...」、框不弹、也没有「已连接」）。
 *      c. 复查必须能作废：用户已作答 / 取消 / 连接断开时 core/sync 的 closeSyncModeModal
 *         无条件调用 cancelSyncModeModalRetries()（代次 +1），否则到点的复查会把用户已经
 *         回答过的选择框再弹一次（幽灵弹窗）。另外 overlay 是 interceptTouchOutside 的
 *         全屏透明层，叠两个会拦整页触摸（假死），所以 SyncModeModal 挂载时若 store 里还
 *         记着另一个活的选择框，先关旧的；卸载时只清「自己那一个」。
 *
 * ② 搜索筛选下拉框要「上贴搜索框下端」（第 2 条 → 第 16 轮第 5 条 → 第 17 轮改窗口坐标）
 *    浮层容器的 top 与展开动画的高度必须同源（containerHeight − top）：展开 / 收起动画用
 *    translateY(∓height/2) 抵消「以中心缩放」的位移，height 若还按整块 header 算
 *    （旧实现 containerHeight − headerHeight，比真实高度小），补偿量就偏小，盒子会在动画
 *    期间越过这个上端 —— 就是「下拉框和搜索框底部没对齐」。本脚本钉住 tipListTopRef（top）
 *    与 syncTipListHeight（height）同源、三处调用都传这个高度、锚点上报的是窗口坐标。
 *
 *    第 16 轮第 5 条（用户：「筛选清单位置还是不对，它完全遮住了搜索输入框，修改为显示在
 *    搜索框整体下面，筛选清单上边界和搜索输入框下边界齐平」）：搜索页除输入框外还有
 *    「搜索平台」标题行 + 平台胶囊横滑行 + 类型选择行（≈116pt）。旧实现的 top 只有一处
 *    来源（整块 header 实测高），联想/筛选浮层因此隔着这三行才出现 —— 展开后正好盖住
 *    输入框。修法：**删掉整块 header 这条锚点**，top 只认搜索框实测底边；首帧还没测到
 *    几何时容器给 0 高（不是「先按整宽铺一屏」）。本脚本同时钉住「旧锚点不得复活」：
 *    headerHeightRef 一旦被写回，两套基准就会再次漂移。
 *
 *    第 17 轮（用户截图：联想浮层从屏幕顶部起画、把输入框整个盖住）：搜索框行挂在结果列表
 *    的 header 里，iOS 上列表被全局 swizzle 强制 contentInsetAdjustmentBehavior，系统会给
 *    列表内容叠加一份安全区顶部插图 —— **列表内部 onLayout 量到的 layout.y 不含这份插图**，
 *    第 16 轮把它直接当页面坐标写进 tipListTopRef，浮层因此比搜索框高出一个安全区
 *    （iPhone 16 Pro Max 实测 ≈59pt，浮层从列表顶部起画、正好压住搜索框）。修法：坐标
 *    全部走窗口坐标系，不再依赖任何坐标系假设：
 *      a. HeaderBar 用 searchBarRowRef.measureInWindow 上报「搜索框行底边」的窗口 y
 *         （y + height；天然含安全区插图与滚动偏移），并把 measureSearchBar() 挂到 ref 上
 *         供浮层显示前刷新；
 *      b. 搜索页量根 View（浮层定位所在层，collapsable={false}）的窗口 y，
 *         top = 搜索框底边窗口 y − 容器窗口 y，换算成本层坐标后再设 tipList 的 top；
 *      c. 点输入框 / 输入内容时各刷新一次实测，真正 search / show 之前（500ms 定时器内）
 *         再测一次 —— 列表能否滚动会让插图出现 / 消失，搜索框在屏上的位置跟着变。
 *    本脚本只钉这条链的接线与同源关系；**第 17 轮锚点的完整契约（源码不变量 9 条 + 距离
 *    模型 4 条 + 反例 5 条）在 scripts/sim-search-tip-anchor.js**。
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
 * ④【第 16 轮第 3 条】同一首歌不许取三次链接（用户：「在歌曲播放到最后 10 秒位置时，获取
 *    下一首歌曲一次请求，目前会发 2 次，播放结束后，还会再获取一次请求，总共请求 3 次」）
 *    取链固定天梯从用户偏好档（如 flac）起步降级，实际达成档常更低（如 320k）。URL 缓存
 *    按「档位」为键（本档链接是诚实语义），而「最后一刻预取」写入的是**达成档**键、
 *    切歌起播读的是**请求档**（天梯首档）键 —— 键不一致 → 缓存穿透 → 又发一次请求。
 *    修法：写侧在 quality == null（天梯模式）且达成档 ≠ 请求档时，额外记一条
 *    「请求档 → 达成档」映射；读侧（core/music 的 online.ts / utils.ts 两处缓存入口）
 *    在请求档未命中时按映射回退到达成档，命中即原样复用（quality 仍报达成档，不撒谎）。
 *    三处必须同时成立才闭环：① 预取的取链调 **不带** 显式档（走天梯才会写映射）；
 *    ② 写侧映射的闸门（只在天梯模式 + 真的降级时写）；③ 读侧带回退。
 *    映射键前缀沿用 storageDataPrefix.musicUrl、清理走 startsWith，不留孤儿键。
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
  data: 'src/utils/data.ts',
  online: 'src/core/music/online.ts',
  musicUtils: 'src/core/music/utils.ts',
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
/** 去掉行注释：断言只看代码，避免中文说明里提到 headerHeight 之类的旧名字造成假命中/假失败 */
const stripComments = (s) => s.split('\n').map((line) => {
  const at = line.indexOf('//')
  return at < 0 ? line : line.slice(0, at)
}).join('\n')

// ==================== A. 同步方式选择框 ====================
const GROUP_A = [
  ['utils：有挂载复查代次 syncModeModalSeq（初值 0）',
    (s) => /let syncModeModalSeq = 0/.test(s.utils)],
  ['utils：导出 cancelSyncModeModalRetries（代次 +1）',
    // 第 34 轮该函数体多了「放掉去抖占位」一句，断言只钉「导出 + 首句代次 +1」，
    // 后半段由下面那条专门钉（钉太死会让注释/追加语句误伤）。
    (s) => /export const cancelSyncModeModalRetries = \(\) => \{\s*\n\s*syncModeModalSeq \+= 1/.test(s.utils)],
  // 【第 34 轮第 1 条】新增：取消复查时一并放掉「呈现去抖」占位。
  // 服务端连着问「歌单同步方式」和「不喜欢列表同步方式」时，第二个问题进来时占位还在
  // （500ms 定时器没到点）⇒ showSyncModeModal 直接 return ⇒ 那个问题永远没人回答、
  // Promise 永不 settle ⇒ 服务端一直等、客户端死卡 'Wait syncing...'。
  ['utils：取消复查时一并放掉去抖占位 pendingOverlays（否则后一个问题被静默吞掉）',
    (s) => {
      const fn = sliceBy(s.utils, 'export const cancelSyncModeModalRetries = () => {', '\n}')
      return fn.length > 0 && /pendingOverlays\.delete\(SYNC_MODE_MODAL\)/.test(fn) &&
        fn.indexOf('syncModeModalSeq += 1') < fn.indexOf('pendingOverlays.delete(SYNC_MODE_MODAL)')
    }],
  // 【第 34 轮第 1 条】新增：呈现不可用时必须上报调用方（core/sync 据此 reject 问询）。
  // 以前这两条路径都是「什么都不做就 return」——用户看不到提示、服务端等不到回答，
  // 界面与「正常等待用户选择」长得一模一样（就是那串 'Wait syncing...'）。
  ['utils：去抖占位久占不放 → 按「呈现不可用」上报（不再静默吞掉）',
    (s) => /if \(guardRetryCount < 3\) \{[\s\S]{0,320}?console\.error\('\[SyncMode\] overlay debounce occupied, give up'\)[\s\S]{0,80}?onUnavailable\?\.\(\)/.test(s.utils)],
  ['sync：showSyncModeModal 的失败回调会 reject 掉这次问询（服务端据此中止，不再干等）',
    (s) => {
      const call = /showSyncModeModal\(handleUnavailable\)/.test(s.sync)
      const body = sliceBy(s.sync, 'function handleUnavailable()', "reject(new Error('sync mode modal unavailable'))")
      return call && body.length > 0 &&
        /if \(settled\) return/.test(body) &&   // 已作答就不该再 settle 一次
        /removeListeners\(\)/.test(body) &&     // 收尾：撤监听 + 复位 selecting
        /setSyncMessage\('同步方式选择框未能显示/.test(body)  // 界面必须留言，不能一片死寂
    }],
  ['sync：等待作答期间状态文案写明确（不再是连接建立时那句 Wait syncing... 死等提示）',
    (s) => /setSyncMessage\('等待选择同步方式\.\.\.'\)/.test(s.sync) && /\bsyncModeSelecting = true\b/.test(s.sync)],
  ['utils：每次呈现取一个代次（seq = ++syncModeModalSeq）',
    (s) => /const seq = \+\+syncModeModalSeq/.test(s.utils)],
  ['utils：复查延时 1000ms / 重试间隔 700ms / 上限 5 次',
    (s) => /const verifyDelay = 1000/.test(s.utils) &&
      /const retryDelay = 700/.test(s.utils) &&
      /const maxAttempts = 5/.test(s.utils)],
  ['utils：resolve 之后才复查，且先比代次（已作答 / 已取消就作废）',
    (s) => /\.then\(\(\) => \{\s*\n\s*setTimeout\(\(\) => \{[\s\S]{0,200}?if \(seq !== syncModeModalSeq\) return/.test(s.utils)],
  ['utils：复查判据 = 「选择框确实在屏幕上」（已挂上就停手，绝不叠第二个）',
    // 【第 35 轮第 2 条】present() 入口也有一句同样家族的判据（防重复呈现），所以这里必须连
    // 「判据为假 → handleFail('overlay not mounted')」一起钉，否则拿掉复查那句也判绿。
    // 【第 36 轮第 1 条】判据 = syncModeModalVisible（组件挂载点亮 / 卸载摘掉）；不能再按
    // store 里的 id 判 —— 残留 id 会让复查误判成「已挂载」，重试停止、选择框再也不出现。
    (s) => /if \(syncState\.syncModeModalVisible\) return\s*\n\s*handleFail\(attempt, new Error\('overlay not mounted'\)\)/.test(s.utils) &&
      !/if \(syncState\.syncModeComponentId\) return/.test(s.utils)],
  ['utils：判据为空才按「没挂上」走重试（handleFail）',
    (s) => /handleFail\(attempt, new Error\('overlay not mounted'\)\)/.test(s.utils)],
  ['utils：showOverlay 的 reject 与静默失败走同一条重试路径',
    (s) => /\.catch\(\(err\) => \{\s*\n\s*handleFail\(attempt, err\)/.test(s.utils)],
  ['utils：重试有上限（attempt >= maxAttempts 停手），首次呈现是 present(1)',
    // 第 34 轮「停手」不再是裸 return —— 变成「上报 onUnavailable + return」块
    //（上报那条由下面专门钉），这里只钉上限判断存在 + 重试走 present(attempt + 1) + 首次 present(1)
    (s) => /if \(attempt >= maxAttempts\) \{/.test(s.utils) &&
      /setTimeout\(\(\) => \{[\s\S]{0,200}?present\(attempt \+ 1\)[\s\S]{0,40}?\}, retryDelay\)/.test(s.utils) &&
      /present\(1\)\s*\n\}/.test(s.utils)],
  ['utils：重试用尽 → onUnavailable 上报（不再静默 return —— 弹不出来与永远等待必须可区分）',
    (s) => {
      const body = sliceBy(s.utils, 'if (attempt >= maxAttempts) {', 'onUnavailable?.()')
      return body.length > 0 && body.indexOf('onUnavailable?.()') > 0 &&
        /give up presenting overlay/.test(body)
    }],
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
  ['search：tipListTopRef 记录浮层上端（本层坐标）',
    (s) => /const tipListTopRef = useRef\(0\)/.test(s.search)],
  ['search：浮层高度以「搜索框下端」为唯一基准（containerHeight − top），且无整块 header 回退',
    (s) => /const top = tipListTopRef\.current\r?\n/.test(stripComments(s.search)) &&
      /layoutHeightRef\.current = Math\.max\(0, containerHeightRef\.current - top\)/.test(s.search) &&
      !/headerHeightRef\.current\s*=/.test(stripComments(s.search))],
  ['search：换算函数写入「窗口坐标 − 容器窗口 y」的 top 再同步高度（先定位后定高）',
    (s) => {
      const body = sliceBy(s.search, 'const applyTipListGeometry = useCallback', '}, [syncTipListHeight])')
      const iTop = body.indexOf('const top = bar.y + bar.height - box.y')
      const iWrite = body.indexOf('tipListTopRef.current = top')
      const iSync = body.indexOf('syncTipListHeight()')
      return iTop >= 0 && iWrite > iTop && iSync > iWrite
    }],
  ['search：容器 onLayout 重算高度并重测容器窗口坐标；旧的整块 header 锚点不得复活',
    (s) => {
      const code = stripComments(s.search)
      const container = /containerHeightRef\.current = e\.nativeEvent\.layout\.height[\s\S]{0,120}?syncTipListHeight\(\)[\s\S]{0,120}?measureOverlayContainer\(\)/.test(code)
      // 旧锚点一旦复活（两套基准漂移）必须判红；注释里提到不算
      return container && !/headerHeight/i.test(code)
    }],
  ['search：浮层容器 top/left/width 用换算值（tipListGeometry），首帧给 0 高不铺一屏',
    (s) => /top: tipListGeometry\.top,/.test(s.search) &&
      /left: tipListGeometry\.left,/.test(s.search) &&
      /width: tipListGeometry\.width,/.test(s.search) &&
      /: \{ top: 0, height: 0, left: 0, right: 0 \}/.test(s.search)],
  ['search：换算回写几何时同值保持原引用（不因测量抖动整页重渲染）',
    (s) => /prev && prev\.top == top && prev\.left == left && prev\.width == bar\.width/.test(s.search) &&
      /\? prev\r?\n\s*: \{ top, left, width: bar\.width \}/.test(s.search)],
  ['search：点输入框 / 输入内容 / 真正 search、show 之前都刷新实测（refreshTipListAnchor）',
    (s) => {
      const code = stripComments(s.search)
      const refresh = sliceBy(code, 'const refreshTipListAnchor', '}, [measureOverlayContainer])')
      const okRefresh = /headerBarRef\.current\?\.measureSearchBar\(\)/.test(refresh) &&
        /measureOverlayContainer\(\)/.test(refresh)
      const show = sliceBy(code, 'const handleShowTipList: HeaderBarProps', '}, 500)')
      const tip = sliceBy(code, 'const handleTipSearch: HeaderBarProps', '}, 500)')
      return okRefresh &&
        (show.match(/refreshTipListAnchor\(\)/g) || []).length >= 2 &&
        (tip.match(/refreshTipListAnchor\(\)/g) || []).length >= 2
    }],
  ['search：三处调起浮层都传 layoutHeightRef（与定位同一份高度）',
    (s) => (s.search.match(/searchTipListRef\.current\?\.(?:search|show)\([^)]*layoutHeightRef\.current\)/g) || []).length >= 3],
  ['search：把 handleSearchBarWindowLayout 接到 HeaderBar 的 onSearchBarLayout',
    (s) => /onSearchBarLayout=\{handleSearchBarWindowLayout\}/.test(s.search)],
  ['headerBar：搜索框用 measureInWindow 上报窗口坐标（不再退回 header 内部 layout 坐标）',
    (s) => {
      const code = stripComments(s.headerBar)
      return /searchBarRowRef\.current\?\.measureInWindow\(/.test(code) &&
        !/nativeEvent\.layout/.test(code) &&
        !/containerPaddingTop \+ y/.test(code)
    }],
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

// ============ D.【第 16 轮第 3 条】预取写下的链接必须被切歌复用（一首歌不许取三次） ============
const GROUP_D = [
  ['preloadNext：预取取链不带显式档（走天梯才会写「请求档 → 达成档」映射，切歌起播才复用得上）',
    (s) => /await getMusicUrlInfo\(\{ musicInfo: info\.musicInfo \}\)\.catch\(\(\) => null\)/.test(s.preloadNext) &&
      !/getMusicUrlInfo\(\{ musicInfo: info\.musicInfo,[^}]*quality:/.test(s.preloadNext)],
  ['data：读缓存带回退——先按请求档直读，命中即返回请求档',
    (s) => {
      const body = sliceBy(s.data, 'export const getMusicUrlResolved', '\n}')
      const iDirect = body.indexOf('await getMusicUrl(musicInfo, type)')
      const iMap = body.indexOf('await getMusicUrlRequestQuality(musicInfo, type)')
      return iDirect >= 0 && iMap > iDirect && /if \(url\) return \{ url, quality: type \}/.test(body)
    }],
  ['data：请求档未命中查映射；映射缺失或等于请求档时返回 null（不猜、不拿请求档冒充）',
    (s) => {
      const body = sliceBy(s.data, 'export const getMusicUrlResolved', '\n}')
      return /const achievedQuality = await getMusicUrlRequestQuality\(musicInfo, type\)/.test(body) &&
        /if \(!achievedQuality \|\| achievedQuality === type\) return null/.test(body)
    }],
  ['data：按达成档再取一次链接，命中返回达成档（质量标不撒谎），未命中 null',
    (s) => /const aliasedUrl = await getMusicUrl\(musicInfo, achievedQuality\)/.test(s.data) &&
      /return aliasedUrl \? \{ url: aliasedUrl, quality: achievedQuality \} : null/.test(s.data)],
  ['data：映射读写同键，且键前缀仍挂在 musicUrl 下（clearMusicUrl 的 startsWith 一并清掉，无孤儿键）',
    (s) => {
      const hits = [...s.data.matchAll(/export const (getMusicUrlRequestQuality|saveMusicUrlRequestQuality) = [\s\S]{0,200}?`\$\{storageDataPrefix\.(\w+)\}request_quality__\$\{musicInfo\.id\}_\$\{type\}`/g)]
      return hits.length === 2 && hits.every((m) => m[2] === 'musicUrl') &&
        /key\.startsWith\(storageDataPrefix\.musicUrl\)/.test(sliceBy(s.data, 'export const clearMusicUrl', '\n}'))
    }],
  ['online：天梯模式（未指定档）读缓存走映射回退；显式档只直读该档（低档链接不冒充指定档）',
    (s) => /const cached = quality == null\s*\? await getStoreMusicUrlResolved\(currentMusicInfo, targetQuality\)\s*: await getStoreMusicUrl\(currentMusicInfo, targetQuality\)\.then\(url => url \? \{ url, quality: targetQuality \} : null\)/.test(s.online)],
  ['online：缓存命中按达成档回报（setLastTryQuality 与返回的 quality 都是 cached.quality）',
    (s) => /setLastTryQuality\(currentMusicInfo\.id, cached\.quality\)[\s\S]{0,600}?return \{ url: cached\.url, quality: cached\.quality \}/.test(s.online)],
  ['online：天梯降级达成时补写映射，两处都在 quality == null 闸内（显式档不写）',
    (s) => (s.online.match(/if \(quality == null && (?:result\.quality|achievedQuality) !== targetQuality\) \{/g) || []).length === 2],
  ['online：换源分支连源歌 musicInfo 也写一份映射（切歌读的是源歌 id，只写当前 id 会穿透）',
    (s) => /if \(currentMusicInfo\.id !== musicInfo\.id\) void saveMusicUrlRequestQuality\(musicInfo, targetQuality, achievedQuality\)/.test(s.online)],
  ['musicUtils：起播 / 切歌这一侧同口径（天梯模式走映射回退，显式档只直读）',
    (s) => /const cached = quality == null\s*\? await getStoreMusicUrlResolved\(musicInfo, targetQuality\)\s*: await getStoreMusicUrl\(musicInfo, targetQuality\)\.then\(url => url \? \{ url, quality: targetQuality \} : null\)/.test(s.musicUtils)],
  ['musicUtils：命中缓存走「不再发请求」分支（isFromCache: true）且按达成档回报',
    (s) => /if \(cached && !isRefresh\) \{[\s\S]{0,240}?return \{ url: cached\.url, musicInfo, quality: cached\.quality, isFromCache: true \}/.test(s.musicUtils)],
]

const SRC_D = readSet(['preloadNext', 'data', 'online', 'musicUtils'])

const SRC_A = readSet(['utils', 'sync', 'modal', 'isEnable'])
const SRC_B = readSet(['search', 'headerBar'])
const SRC_C = readSet(['preload', 'preloadNext'])

const aRes = runGroup(GROUP_A, SRC_A)
const bRes = runGroup(GROUP_B, SRC_B)
const cRes = runGroup(GROUP_C, SRC_C)
const dRes = runGroup(GROUP_D, SRC_D)

// —— 反例（全部用当前源码变异，必须被对应分组判红）——
const mutated = (src, key, from, to) => {
  const m = Object.assign({}, src)
  m[key] = src[key].replace(from, to)
  return { m, changed: m[key] !== src[key] }
}
const caught = (group, src) => runGroup(group, src).some((r) => !r.ok)

// n1: utils 拿掉「已挂上就停手」的判据（复查变成无条件重试）
// 【第 35 轮第 2 条】present() 入口也加了同样家族的一句（防重复呈现），所以锚点带上它的下一行
// ——只锚那一句的话 .replace 会命中新加的那处，复查判据还在，反例就拦不下来了。
// 【第 36 轮第 1 条】判据本身改成 syncModeModalVisible（见上），锚点随之更新。
const n1 = mutated(SRC_A, 'utils',
  "if (syncState.syncModeModalVisible) return\n            handleFail(attempt",
  "if (false) return\n            handleFail(attempt")
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
// n5: search 高度基准退回整块 header（不再是搜索框实测底边）
const n5 = mutated(SRC_B, 'search',
  '    const top = tipListTopRef.current\n',
  '    const top = headerHeightRef.current\n')
// n5b: 高度基准上加「没有实测值就按容器高估一个」的回退（浮层又会落到平台行下面）
const n5b = mutated(SRC_B, 'search',
  '    const top = tipListTopRef.current\n',
  '    const top = tipListTopRef.current || containerHeightRef.current * 0.3\n')
// n5c: 旧的「整块 header 高度」锚点复活（两套基准漂移 = 本轮修掉的老 bug 源头）
const n5c = mutated(SRC_B, 'search',
  '    <View>\n      <HeaderBar',
  '    <View onLayout={(e) => { headerHeightRef.current = e.nativeEvent.layout.height }}>\n      <HeaderBar')
// n5d: 首帧回退改回「整宽铺一屏」（没有几何时先画出来，闪一下错位的列表）
const n5d = mutated(SRC_B, 'search',
  '      : { top: 0, height: 0, left: 0, right: 0 },',
  '      : { top: 0, left: 0, right: 0 },')
// n5e: 换算后不再同步高度（top 变了 height 没变 → 展开动画位移补偿错位）
const n5e = mutated(SRC_B, 'search',
  '    tipListTopRef.current = top\n    syncTipListHeight()',
  '    tipListTopRef.current = top')
// n5f: 真正 show 之前不再刷新实测（列表能否滚动让插图出现 / 消失，位置会变）—— 拿掉定时器内那次实测
const n5f = mutated(SRC_B, 'search',
  'setTimeout(() => {\n      refreshTipListAnchor()\n      timeoutRef.current = null',
  'setTimeout(() => {\n      timeoutRef.current = null')
// n6: search 浮层 top 换回写死的页头高度（不再用换算值）
const n6 = mutated(SRC_B, 'search',
  'top: tipListGeometry.top,',
  'top: 96,')
// n7: headerBar 上报改回 measure（给的是相对父级的布局坐标，不含安全区插图）
const n7 = mutated(SRC_B, 'headerBar',
  'searchBarRowRef.current?.measureInWindow((x, y, width, height) => {',
  'searchBarRowRef.current?.measure((x, y, width, height) => {')
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
// n12: data 读侧把映射回退删掉（退回直读请求档 → 预取过的歌切歌又发一次请求）
const n12 = mutated(SRC_D, 'data',
  'const achievedQuality = await getMusicUrlRequestQuality(musicInfo, type)',
  'const achievedQuality = null')
// n13: data 砍掉「按达成档再取一次」（映射查了也不用，等于没回退）
const n13 = mutated(SRC_D, 'data',
  'const aliasedUrl = await getMusicUrl(musicInfo, achievedQuality)',
  "const aliasedUrl = ''")
// n14: online 写侧映射闸门拆掉（显式档也写 / 不判是否真降级）
const n14 = mutated(SRC_D, 'online',
  'if (quality == null && result.quality !== targetQuality) {',
  'if (true) {')
// n15: musicUtils 退回「一律直读请求档」（缓存再次穿透 → 起播又发一次请求）
const n15 = mutated(SRC_D, 'musicUtils',
  '? await getStoreMusicUrlResolved(musicInfo, targetQuality)',
  '? await getStoreMusicUrl(musicInfo, targetQuality).then(url => url ? { url, quality: targetQuality } : null)')
// n16: 缓存命中谎报请求档（320k 的链接被标成 flac）
const n16 = mutated(SRC_D, 'musicUtils',
  'quality: cached.quality, isFromCache: true',
  'quality: targetQuality, isFromCache: true')
// n17: 预取取链改带显式档（不走天梯 → 写侧永远不写映射 → 切歌读请求档仍穿透）
const n17 = mutated(SRC_D, 'preloadNext',
  'getMusicUrlInfo({ musicInfo: info.musicInfo })',
  "getMusicUrlInfo({ musicInfo: info.musicInfo, quality: '320k' })")
// n18: 映射键离开 musicUrl 前缀（孤儿键，清缓存清不掉，读侧也再查不到）
const n18 = mutated(SRC_D, 'data',
  '`${storageDataPrefix.musicUrl}request_quality__${musicInfo.id}_${type}`',
  '`${storageDataPrefix.lyric}request_quality__${musicInfo.id}_${type}`')

// n19: utils 的第 34 轮修复回退 —— 取消复查时不放掉去抖占位（第二个问题被静默吞掉 → Wait syncing...）
const n19 = mutated(SRC_A, 'utils',
  '  pendingOverlays.delete(SYNC_MODE_MODAL)\n}',
  '}')
// n20: utils 去抖占位久占时又退回静默 return（用户既看不到提示、服务端也等不到回答）
const n20 = mutated(SRC_A, 'utils',
  '    onUnavailable?.()\n    return\n  }\n  guardRetryCount = 0',
  '    return\n  }\n  guardRetryCount = 0')
// n21: utils 重试用尽又退回静默 return（「弹不出来」与「永远等待」再次长得一样）
const n21 = mutated(SRC_A, 'utils',
  '      onUnavailable?.()\n      return',
  '      return')
// n22: sync 的失败回调不再 reject（服务端干等一个永远不会到来的回答）
const n22 = mutated(SRC_A, 'sync',
  "      reject(new Error('sync mode modal unavailable'))",
  '      return')
// n23: sync 等待作答时不写状态文案（界面继续挂着死等提示）
const n23 = mutated(SRC_A, 'sync',
  "    setSyncMessage('等待选择同步方式...')",
  '    // setSyncMessage removed')
// n24: sync 呈现时不再接失败回调（第 34 轮的上报通道整条断开）
const n24 = mutated(SRC_A, 'sync',
  'showSyncModeModal(handleUnavailable)',
  'showSyncModeModal()')

// —— 输出 ——
console.log('='.repeat(92))
console.log('「同步选择框 / 搜索浮层 / 预加载 10 秒闸」契约模型（摘自源码，静态解析）')
console.log('='.repeat(92))
console.log(`  A 同步模式选择框：${aRes.filter((r) => r.ok).length}/${aRes.length} 通过`)
console.log(`  B 搜索筛选浮层  ：${bRes.filter((r) => r.ok).length}/${bRes.length} 通过`)
console.log(`  C 预加载 10 秒闸：${cRes.filter((r) => r.ok).length}/${cRes.length} 通过`)
console.log(`  D 预取链接复用  ：${dRes.filter((r) => r.ok).length}/${dRes.length} 通过`)
console.log()

console.log('—— A. 连接码验证成功后的「列表同步方式」选择框 ——')
for (const r of aRes) check(r.label, r.ok)
console.log('—— B. 搜索筛选浮层上贴搜索框下端（窗口坐标换算，top 与高度同源）——')
for (const r of bRes) check(r.label, r.ok)
console.log('—— C. 音频预加载只在最后 10 秒开始（两条路径同口径）——')
for (const r of cRes) check(r.label, r.ok)
console.log('—— D. 最后 10 秒取到的链接被切歌复用（一首歌不再取三次）——')
for (const r of dRes) check(r.label, r.ok)

neg('反例 n1：utils 拿掉「已挂上就停手」判据（叠加 / 幽灵重试），被 A 判红', n1.changed && caught(GROUP_A, n1.m))
neg('反例 n2：sync 删掉复查作废（用户回答后被再弹一次），被 A 判红', n2.changed && caught(GROUP_A, n2.m))
neg('反例 n3：isEnable 退回「点确认立刻连接」（撞原生 Modal 淡出），被 A 判红', n3.changed && caught(GROUP_A, n3.m))
neg('反例 n4：modal 拿掉重复呈现去重（两个透明层拦整页触摸），被 A 判红', n4.changed && caught(GROUP_A, n4.m))
neg('反例 n5：search 高度基准退回整块 header（不是搜索框实测底边），被 B 判红', n5.changed && caught(GROUP_B, n5.m))
neg('反例 n5b：高度基准加了「没实测值就按容器高估一个」的回退，被 B 判红', n5b.changed && caught(GROUP_B, n5b.m))
neg('反例 n5c：旧的整块 header 锚点复活（两套基准漂移），被 B 判红', n5c.changed && caught(GROUP_B, n5c.m))
neg('反例 n5d：首帧回退改回整宽铺一屏（错位列表先闪一下），被 B 判红', n5d.changed && caught(GROUP_B, n5d.m))
neg('反例 n5e：换算后不再同步高度（top 与 height 脱钩），被 B 判红', n5e.changed && caught(GROUP_B, n5e.m))
neg('反例 n5f：真正 show 之前不再刷新实测（位置已变仍用旧值），被 B 判红', n5f.changed && caught(GROUP_B, n5f.m))
neg('反例 n6：search 浮层 top 换回写死的页头高度，被 B 判红', n6.changed && caught(GROUP_B, n6.m))
neg('反例 n7：headerBar 上报改回 measure（布局坐标不含安全区插图），被 B 判红', n7.changed && caught(GROUP_B, n7.m))
neg('反例 n8：preload 拆掉时间闸（起播就取下一首），被 C 判红', n8.changed && caught(GROUP_C, n8.m))
neg('反例 n9：preload 把 isPreloading 抢到时间闸之前，被 C 判红', n9.changed && caught(GROUP_C, n9.m))
neg('反例 n10：preloadNext 砍掉串行暖链，被 C 判红', n10.changed && caught(GROUP_C, n10.m))
neg('反例 n11：utils 拿掉重试 tick 的代次复查（作废窗口内补弹幽灵框），被 A 判红', n11.changed && caught(GROUP_A, n11.m))
neg('反例 n12：data 读侧删掉映射回退（预取过的歌切歌又发请求），被 D 判红', n12.changed && caught(GROUP_D, n12.m))
neg('反例 n13：data 砍掉「按达成档再取一次」（回退形同虚设），被 D 判红', n13.changed && caught(GROUP_D, n13.m))
neg('反例 n14：online 写侧映射闸门拆掉（显式档也写 / 不判降级），被 D 判红', n14.changed && caught(GROUP_D, n14.m))
neg('反例 n15：musicUtils 退回一律直读请求档（缓存穿透），被 D 判红', n15.changed && caught(GROUP_D, n15.m))
neg('反例 n16：缓存命中谎报请求档（低档链接标成 flac），被 D 判红', n16.changed && caught(GROUP_D, n16.m))
neg('反例 n17：预取取链改带显式档（不走天梯 → 永不写映射），被 D 判红', n17.changed && caught(GROUP_D, n17.m))
neg('反例 n18：映射键离开 musicUrl 前缀（孤儿键，清缓存清不掉），被 D 判红', n18.changed && caught(GROUP_D, n18.m))
neg('反例 n19：取消复查不放去抖占位（连问两个同步方式时第二个被吞），被 A 判红', n19.changed && caught(GROUP_A, n19.m))
neg('反例 n20：去抖占位久占退回静默 return（问题问不出来还没人知道），被 A 判红', n20.changed && caught(GROUP_A, n20.m))
neg('反例 n21：重试用尽退回静默 return（弹不出来 ≡ 永远等待），被 A 判红', n21.changed && caught(GROUP_A, n21.m))
neg('反例 n22：失败回调不 reject（服务端干等无人回答），被 A 判红', n22.changed && caught(GROUP_A, n22.m))
neg('反例 n23：等待作答时不写状态文案（界面继续挂死等提示），被 A 判红', n23.changed && caught(GROUP_A, n23.m))
neg('反例 n24：呈现时不接失败回调（上报通道断开），被 A 判红', n24.changed && caught(GROUP_A, n24.m))

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
