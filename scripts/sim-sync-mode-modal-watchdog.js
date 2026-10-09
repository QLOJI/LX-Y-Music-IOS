/**
 * sim-sync-mode-modal-watchdog.js
 *
 * 「同步方式选择框一定会弹出来、一定会收尾、状态行一定会说清楚」契约不变量
 * （第 35 轮第 2 条，2026-10-08）。
 *
 * 用户原话：同步状态显示「等待选择同步方式...」，但是迟迟没有弹出选择窗口，
 * 而且选择一次后，后面就不会显示了，就只显示同步成功，需要修复；
 * 点击上面的按钮后，下面的提示还是没有。
 *
 * 三个各自独立、可以互相掩盖的病根：
 *
 *  A. **看门狗一次都不会触发（本轮根因）**。core/sync.ts 第 34 轮注册的是
 *     `onModalDismissed(syncState.syncModeComponentId, …)` —— 而 overlay 的 componentId
 *     由 RNN 在呈现时生成，**只有 SyncModeModal 挂载之后**才写回 store；这一行却在
 *     「呈现之前」执行，闭包进去的是空串。onModalDismissed 是「注册时闭包 id、只对该 id
 *     生效」的语义（src/navigation/event.ts），于是选择框被任何**非作答**路径关掉
 *     （点外面、宿主 VC 消失、系统收走）时：
 *       · 这次问询的 Promise 永不 settle（服务端一直等）；
 *       · syncModeSelecting 一直是 true —— 第 34 轮的握手看门狗把它当成「用户在考虑」，
 *         既不催也不超时；
 *       · 状态行就永远钉在「等待选择同步方式...」。
 *     修法：改用 onAnyModalDismissed（触发时把「被关掉的那个 id」交回来，与**当下**的
 *     store 值比对，天然免疫「注册早于挂载」）+ 组件卸载主动回调
 *     handleSyncModeModalUnmounted（免掉「卸载先把 store id 清空、RNN 事件后到」的竞态）。
 *
 *  B. **重复呈现把好的那个顶掉**。showSyncModeModal 的「挂载复查」是延时 1000ms 才看的：
 *     挂载慢一点（原生 Modal 正在淡出、桥接繁忙）就先判「没挂上」→ 700ms 后 present(attempt+1)；
 *     若第一次其实已经挂上，第二个副本挂载时会发现 store 里是别人的 id，反手把**第一个**
 *     关掉 —— 两个都不在了完全可能。修法：present() 入口加「已经有一个活着的选择框就
 *     绝不再呈现第二个」。
 *     【第 38 轮第 2 条】这道守卫本身升级了：原来是无条件静默 return，而它同时是一条死路 ——
 *     「在屏幕上」的标记只要因为任何一次「原生把选择框收走、JS 侧卸载清理没跑到」而残留成
 *     true，本轮每一次 present（含 5 次重试）都在这行无声返回：不呈现、不重试、不上报失败，
 *     core/sync.ts 的 20 秒问句复查又因为这个标记一直为 true 而无限续期 ⇒ 服务端的问句永远
 *     等不到回答、状态文案永远钉在「等待选择同步方式...」（用户第 38 轮第 2 条的原话）。
 *     现在的守卫区分两种来源：presentedThisRound（本轮自己刚推出去过 → 静默停手）
 *     / 陈旧标记（打日志 + 清标记后照常呈现，绝不静默 return）。本脚本的 B 段判据随之改写。
 *
 *  C. **按钮点了下面那行字不动**。设置页那六个 WebDAV 动作以前只在底部弹一条 toast，
 *     而「状态」行只由同步客户端写（syncStatus.message），于是点了半天下面纹丝不动
 *     （用户原话「点击上面的按钮后，下面的提示还是没有」）。修法：六个动作各自写
 *     开始 / 成功 / 失败三句状态。**文案里不得出现地址、账号、路径**（第 25 轮凭据口径），
 *     失败详情只留在 toast 里。
 *
 *  【第 36 轮第 2 条】对 ③ 的改写：这 18 句**不许再写进 syncStatus.message** ——
 *  用户原话「点击测试连接按钮时，提示信息显示在同步服务地址的状态一栏，其实这两个功能是
 *  相互独立的……互不干扰」。它写的是设置页 WebDAV 区块自己的局部 state（setWebdavStatus，
 *  渲染在「上次歌单同步时间」上面一行）。本脚本的判据随之从 setSyncMessage 换成
 *  setWebdavStatus，并新增「页面里一个 setSyncMessage( 都不许有」这条负向判据；
 *  「等待选择同步方式...」这些由 core/sync 写的字仍然属于**下面那块**同步服务地址，两者互不覆盖。
 *
 * 运行：node scripts/sim-sync-mode-modal-watchdog.js
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const F = {
  events: 'src/navigation/event.ts',
  sync: 'src/core/sync.ts',
  utils: 'src/navigation/utils.ts',
  modal: 'src/navigation/components/SyncModeModal.tsx',
  page: 'src/screens/Home/Views/Setting/settings/Sync/index.tsx',
}
const REAL = Object.fromEntries(Object.entries(F).map(([k, v]) => [k, read(v)]))

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const sliceBy = (code, from, to) => {
  const a = code.indexOf(from)
  if (a < 0) return ''
  const b = code.indexOf(to, a)
  return b < 0 ? '' : code.slice(a, b + to.length)
}

/** 从源码抽出「以 signature 开头、后接大括号体」的函数体（按大括号配平）。 */
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

const CANCEL_MESSAGE = "setSyncMessage('同步方式选择已取消，本次同步已中止')"

// ---------------------------------------------------------------------------
// 不变量 A1：navigation/event.ts 提供「任意弹窗被关掉」的单次订阅，回调交回 componentId
// ---------------------------------------------------------------------------

const anyDismissedInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)
  const body = extractBracedBody(code, 'export const onAnyModalDismissed = (handler:')
  if (!body) {
    reasons.push('onAnyModalDismissed 缺失或抽取失败（锚点漂移 —— core/sync 的看门狗靠它免疫「注册早于挂载」）')
    return reasons
  }
  if (!body.includes('registerModalDismissedListener')) {
    reasons.push('onAnyModalDismissed 未订阅弹窗关闭事件')
  }
  if (!/if \(!componentId\) return/.test(body)) {
    reasons.push('onAnyModalDismissed 未过滤空 componentId（空 id 会与「还没挂载」的 store 值撞上，误判成用户取消）')
  }
  if (!/handler\(componentId\)/.test(body)) {
    reasons.push('onAnyModalDismissed 未把「被关掉的那个 componentId」交回调用方（交不回来就只能回到注册时闭包 id 的老路）')
  }
  if (/componentId != id|componentId === id/.test(body)) {
    reasons.push('onAnyModalDismissed 里保留了「按注册时的 id 比对」的语义（订阅时拿不到 overlay 的 id —— 这层过滤必须留给调用方在触发那一刻做）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 A2/B：core/sync.ts 的看门狗与呈现顺序
// ---------------------------------------------------------------------------

const syncWatchdogInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // ① 旧语义必须彻底退场（注册时闭包 id ⇒ 一次都不会触发）
  if (/(^|[^A-Za-z])onModalDismissed\(/.test(code)) {
    reasons.push('仍在用 onModalDismissed（注册时把 componentId 闭包进去的旧语义 —— 那行在选择框挂载前执行，闭包到的是空串，看门狗一次都不会触发，这正是用户看到的「状态写着等待选择同步方式、框却已不在」）')
  }
  if (!code.includes('onAnyModalDismissed')) {
    reasons.push('未改用 onAnyModalDismissed（看门狗拿不到「被关掉的那个 id」）')
  }

  // ② 看门狗：比对 + 改文案 + 走取消通路
  const iWatch = code.indexOf('removeDismissListener = onAnyModalDismissed(')
  if (iWatch < 0) {
    reasons.push('看门狗未注册（removeDismissListener = onAnyModalDismissed(… 缺失）')
  } else {
    // 三个「收尾动作」在回调体里的相对次序：先比对 → 再改文案 → 再走取消通路。
    //（用 indexOf 而不是拼正则：比对的判据是异步比较，不该只看文本形状）
    const iCompare = code.indexOf('if (!syncState.syncModeComponentId || dismissedId != syncState.syncModeComponentId) return', iWatch)
    const iMessage = code.indexOf(CANCEL_MESSAGE, iWatch)
    const iCancel = code.indexOf('removeEvent?.()', iWatch)
    const watchdogEnd = code.indexOf('    })', iWatch)
    if (iCompare < 0 || (watchdogEnd > 0 && iCompare > watchdogEnd)) {
      reasons.push('看门狗未把「被关掉的 id」与「当下 store 里的 id」比对（不比对就会把别的 overlay 的关闭、甚至早已作答的那次，误当成这次问询被取消）')
    }
    if (iMessage < 0 || iMessage < iCompare) {
      reasons.push('看门狗收尾没改状态文案（那行字会永远停在「等待选择同步方式...」—— 用户第 35 轮第 2 条看到的正是它）')
    }
    if (iCancel < 0 || iCancel < iMessage) {
      reasons.push('看门狗没走既有的取消通路（removeEvent?.() 缺失 —— 这次问询不会 reject，服务端还在等）')
    }
  }

  // ③ 呈现必须在「收尾手脚」接好之后（showSyncModeModal 去抖占满时会**同步**回调
  //    handleUnavailable，而它要调用 removeListeners —— 放前面就是一个 TDZ）
  const iPresent = code.indexOf('showSyncModeModal(handleUnavailable)')
  const iRemoveListeners = code.indexOf('const removeListeners = () => {')
  if (iPresent < 0) {
    reasons.push('showSyncModeModal(handleUnavailable) 调用缺失（选择框根本不会被呈现）')
  } else {
    if (iRemoveListeners < 0 || iPresent < iRemoveListeners) {
      reasons.push('呈现在前（showSyncModeModal 调用出现在「收尾手脚」removeListeners 初始化之前 —— 去抖占满时它会同步回调 handleUnavailable，直接踩 TDZ：Cannot access removeListeners before initialization）')
    }
    if (iWatch >= 0 && iPresent < iWatch) {
      reasons.push('呈现在前（showSyncModeModal 调用出现在看门狗注册之前 —— 呈现失败/被取消时看门狗还没挂上，前几十毫秒的关闭事件会漏）')
    }
  }

  // ④ 收尾必须复位 syncModeSelecting（第 34 轮的握手看门狗据此区分「卡死」与「用户在考虑」；
  //    不复位的话，下一次问询会被上一次的残留当成「用户还在考虑」，永远不催也不超时）
  if (!/const removeListeners = \(\) => \{[\s\S]{0,800}?syncModeSelecting = false/.test(code)) {
    reasons.push('收尾未复位 syncModeSelecting（残留 true 会让握手看门狗一直以为「用户在考虑」，卡死时既不催也不超时）')
  }

  // ⑤ 组件卸载主动上报（免掉「卸载先清 store id、RNN 事件后到」的竞态）
  // 【第 36 轮第 1 条】形参改成 componentId?: string —— 要能精确比对「消失的是不是当前
  // 问句的那个选择框」（反向误杀：上一轮问句的选择框卸载回调姗姗来迟，把**新**问句杀掉的
  // 表现与原始 bug 一模一样）。
  const unmounted = extractBracedBody(code, 'export const handleSyncModeModalUnmounted = (componentId?: string) =>')
  if (!unmounted) {
    reasons.push('handleSyncModeModalUnmounted 缺失或抽取失败（只靠 RNN 关闭事件会漏：卸载清理会先把 store 里的 id 清成空串）')
  } else {
    if (!unmounted.includes('if (!syncModeSelecting) return')) {
      reasons.push('handleSyncModeModalUnmounted 越过 syncModeSelecting 判据（作答/取消/呈现失败三条路径都会把它置回 false；少了这道判据，「用户刚点完选项、我们再关框」会被误当成「用户跑了」）')
    }
    if (!unmounted.includes(CANCEL_MESSAGE)) {
      reasons.push('handleSyncModeModalUnmounted 没改状态文案（卸载与关闭必须给同一句话，界面不能一片死寂）')
    }
    if (!unmounted.includes('removeSyncModeEvent()')) {
      reasons.push('handleSyncModeModalUnmounted 没走取消通路（removeSyncModeEvent() 缺失）')
    }
    // 【第 36 轮第 1 条】先摘「在屏幕上」的标记，再判取消：标记说的是物理状态，卸载即不在
    // 屏幕上；而「要不要按取消收尾」是业务判断，必须留在标记摘掉之后按问句态决定。
    if (!unmounted.includes('markSyncModeModalHidden()')) {
      reasons.push('卸载回调没有摘掉「选择框在屏幕上」的标记：showSyncModeModal 的重试入口与 client.ts 的'
        + '握手看门狗会一直以为用户正盯着一个早已消失的选择框 —— 既不重试也不催，'
        + '正是用户第 36 轮第 1 条「状态一直等待选择同步方式、框不弹、也等不到已连接」的死路')
    }
    // 精确比对不能少（成分：只对「消失的正是当前那个」收尾）
    if (!unmounted.includes('componentId != syncState.syncModeComponentId')) {
      reasons.push('卸载回调没有用 componentId 比对当前问句（迟到的卸载回调会把**新**问句当成被取消而杀掉，'
        + '表现同样是「状态写着等待选择同步方式、选择框却不出现」）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 B：present() 入口的「绝不叠第二个选择框」守卫
// ---------------------------------------------------------------------------

const presentGuardInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  // 【第 36 轮第 1 条】守卫的判据从「有 id」换成「确实在屏幕上」（syncModeModalVisible）：
  // 原生把 overlay 收走却没跑到 JS 卸载清理时，store 里的 id 是一条残留 —— 用 id 当判据，
  // 此后每一次呈现都在这里静默 return（不呈现、不重试、不上报失败），问句与状态文案一起悬着。
  //
  // 【第 38 轮第 2 条】守卫从「无条件静默 return」升级为「区分两种来源」：
  //   · presentedThisRound = 本轮自己刚把 overlay 推出去过（1000ms 挂载复查 / 700ms 失败重试
  //     重入 present()）—— 真的可能已经在屏幕上，静默停手是正解；
  //   · 否则 = 上一轮留下的陈旧标记 —— 必须就地纠正（打日志 + 清标记）后**照常呈现**。
  // 为什么必须这么改：陈旧标记 + 无条件 return = 一条死路 —— 本轮每一次 present（含 5 次重试）
  // 都无声返回（不呈现、不重试、不上报失败），core/sync.ts 的 20 秒问句复查又因为这个标记
  // 一直为 true 而无限续期 ⇒ 服务端的问句永远等不到回答、状态文案永远钉在「等待选择同步方式」
  // （用户第 38 轮第 2 条原话：状态只会显示等待选择同步方式，不会弹出同步方式的窗口）。
  const GUARD_ENTRY = /const present = \(attempt: number\) => \{\s*\n\s*if \(syncState\.syncModeModalVisible\) \{/
  if (!GUARD_ENTRY.test(code)) {
    reasons.push('present() 入口没有「已经有一个活着的选择框就绝不再呈现第二个」守卫（复查是延时 1000ms 才看的；'
      + '挂载慢一点就先判没挂上 → 700ms 后补呈现，副本挂载时反手把第一个关掉 ⇒ 两个都没了，'
      + '正是「状态写着等待选择同步方式、选择框却迟迟不出现」）。第 36 轮起判据必须是'
      + 'syncState.syncModeModalVisible（「确实在屏幕上」）—— 用 id 判会把残留 id 当成「还在」，静默 return')
  }
  const body = sliceBy(code, 'const present = (attempt: number) => {', '\n  present(1)')
  if (!body) {
    reasons.push('present() 抽取失败（锚点漂移）')
    return reasons
  }
  // 守卫块本体：从「确实在屏幕上」的判据到「本轮真的推过 overlay」的落点（第 38 轮的 presentedThisRound）
  const guardBlock = sliceBy(body, 'if (syncState.syncModeModalVisible) {', 'presentedThisRound = true')
  if (!guardBlock) {
    reasons.push('present() 的 visible 守卫块抽取失败（判据 / presentedThisRound 锚点漂移）')
  } else {
    // ① 静默停手只能对「本轮自己推过」的那一支成立
    if (!guardBlock.includes('if (presentedThisRound) return')) {
      reasons.push('visible 守卫没有区分「本轮自己刚把 overlay 推出去过」（presentedThisRound）：'
        + '要么把上一轮的陈旧标记也一起放过（叠第二个 overlay，反手把在屏幕上那个关掉），'
        + '要么退回无条件静默 return（陈旧标记 = 选择框再也不弹，第 38 轮第 2 条的死路）')
    }
    if (/if \(syncState\.syncModeModalVisible\) return/.test(guardBlock)) {
      reasons.push('visible 守卫又退回无条件静默 return（陈旧标记下每一次呈现都无声返回：不呈现、不重试、不上报失败）')
    }
    // ② 陈旧标记必须就地纠正：只判不救就是第 36 轮第 1 条死路的另一半
    if (!guardBlock.includes('stale syncModeModalVisible')) {
      reasons.push('陈旧「在屏幕上」标记没有日志（用户日志里看不到「为什么这次呈现被当成重复呈现」）')
    }
    if (!guardBlock.includes('syncState.syncModeModalVisible = false')) {
      reasons.push('陈旧「在屏幕上」标记没有被清掉（只判不救：本轮每一次 present 都在这里停手，'
        + '选择框与状态文案一起永久悬着，core/sync 的 20 秒复查还会因它无限续期）')
    }
  }
  const iGuard = body.indexOf('if (syncState.syncModeModalVisible) {')
  const iOverlay = body.indexOf('Navigation.showOverlay')
  if (iGuard < 0 || iOverlay < 0 || iGuard > iOverlay) {
    reasons.push('守卫必须在 showOverlay 之前（再往后放就拦不住这一次呈现了）')
  }
  // 不在屏幕上却留着 id = 残留：必须清掉再照常呈现，不许静默 return（否则就是第 36 轮第 1 条的原始症状）
  // 【第 38 轮】判据补强：清理必须发生在 showOverlay 之前（放到呈现之后 = 清的是新写回的 id）
  const iStale = body.indexOf("syncActions.setSyncModeComponentId('')")
  if (iStale < 0 || (iOverlay >= 0 && iStale > iOverlay)) {
    reasons.push('残留 id 没有清理分支（不在屏幕上却留着 id 时必须先清掉再呈现 —— 只判断不清理，'
      + '或者干脆 return，都会让选择框再也弹不出来）')
  }
  if (!body.includes('stale syncModeComponentId')) {
    reasons.push('残留 id 的清理没有日志（用户日志里看不到「为什么这次呈现被跳过」）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 A3：SyncModeModal 卸载上报 + 未知类型自撤
// ---------------------------------------------------------------------------

const modalInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  if (!code.includes('handleSyncModeModalUnmounted')) {
    reasons.push('SyncModeModal 卸载不上报 core/sync（只靠 RNN 关闭事件会漏：卸载清理先把 store 里的 id 清成空串，事件到达时已无从比对）')
  }
  // 【第 36 轮第 1 条】次序与第 35 轮相反：**先**带 componentId 回调 core/sync，**再**清自己的 id。
  // core/sync 要用这个 id 精确比对「消失的是不是当前问句的那个选择框」；先清掉就等于把比对
  // 依据抹掉了（迟到的卸载回调会把新问句误杀）。带参调用是这件事的判据。
  if (!/handleSyncModeModalUnmounted\(componentId\)[\s\S]{0,600}?setSyncModeComponentId\(''\)/.test(code)) {
    reasons.push('SyncModeModal 卸载上报次序不对：必须先 handleSyncModeModalUnmounted(componentId) 再 setSyncModeComponentId(\'\')'
      + '（反过来的话 core/sync 拿到的 id 已经没了，无从比对「消失的是不是当前那个」，'
      + '迟到的卸载回调会把新问句当成被取消而杀掉）')
  }
  if (!/if \(syncState\.type != 'list' && syncState\.type != 'dislike'\) \{[\s\S]{0,500}?dismissOverlay\(componentId\)/.test(code)) {
    reasons.push('未知问答类型的自撤缺失（画 null 的 overlay 仍带 interceptTouchOutside: true —— 用户看不到任何选择框、触摸却被整片吃掉，就是「卡住又一声不吭」）')
  }
  // 【第 36 轮第 1 条】挂载即点亮「在屏幕上」—— 这是 present() 守卫与 client.ts 握手看门狗
  // 共用的唯一依据，没人点亮的话它永远为 false，两处守卫都成了摆设。
  if (!code.includes('markSyncModeModalVisible()')) {
    reasons.push('SyncModeModal 挂载没有点亮「在屏幕上」标记（markSyncModeModalVisible 缺失：'
      + 'present() 的重复呈现守卫与 client.ts 的握手看门狗都靠它，没人点亮就都成了摆设）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 C：设置页六个动作各自写「开始 / 成功 / 失败」三句状态，且文案不含地址账号。
// 【第 36 轮第 2 条】这 18 句写的是**本区块自己**的状态行（setWebdavStatus）——
// 用户原话：「上面 WebDAV 是一个功能，下面同步服务地址是另一个功能，互不干扰」。
// ---------------------------------------------------------------------------

const HANDLERS = [
  'handleTestConnection',
  'handleSyncNow',
  'handleUpload',
  'handleDownload',
  'handleUploadLists',
  'handleDownloadLists',
]

const syncPageInvariants = (raw) => {
  const reasons = []
  const code = stripComments(raw)

  for (const h of HANDLERS) {
    const body = sliceBy(code, `const ${h} = useCallback(async() => {`, '  }, [')
    if (!body) {
      reasons.push(`${h} 抽取失败（锚点漂移）`)
      continue
    }
    const n = (body.match(/setWebdavStatus\(/g) || []).length
    if (n !== 3) {
      reasons.push(`${h} 的状态行写入次数是 ${n}（应为 3：开始 / 成功 / 失败 —— 点完必须有一句明确的反馈）`)
    }
  }
  const calls = (code.match(/setWebdavStatus\(/g) || []).length
  if (calls !== HANDLERS.length * 3) {
    reasons.push(`状态行写入总次数是 ${calls}（应为 ${HANDLERS.length * 3} = 六个动作 × 三句）`)
  }
  // 【第 36 轮第 2 条】负向判据：WebDAV 区块一个字都不许写进下面「同步服务地址」那一栏
  if (code.includes('setSyncMessage(')) {
    reasons.push('设置页往 setSyncMessage 里写状态：那是下面「同步服务地址」（WebSocket 同步）那一栏的状态行，'
      + '两个功能必须互不干扰（用户第 36 轮第 2 条原话「提示信息显示在同步服务地址的状态一栏」）')
  }
  // 第 25 轮凭据口径：界面文案不得回显主机名 / 账号 / 路径（失败详情留在 toast 里）
  const bad = (code.match(/setWebdavStatus\([^)]*\)/g) || [])
    .filter(s => /https?|\S@\S|\d+\.\d+\.\d+\.\d+/.test(s))
  if (bad.length) {
    reasons.push(`状态文案里出现了地址/账号形态的内容（第 25 轮凭据口径：不得回显主机名、账号、路径）—— ${bad.slice(0, 2).join(' | ')}`)
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

  // c1 看门狗退回「注册时闭包 id」的旧语义（第 35 轮第 2 条的原始 bug）
  check('c1 看门狗退回 onModalDismissed', () => syncWatchdogInvariants(tamper(REAL.sync,
    '    removeDismissListener = onAnyModalDismissed((dismissedId) => {',
    '    removeDismissListener = onModalDismissed(syncState.syncModeComponentId, () => {')),
  'onModalDismissed')

  // c2 看门狗不再比对 id（别人的关闭事件也算）
  check('c2 看门狗不再比对 id', () => syncWatchdogInvariants(tamper(REAL.sync,
    '      if (!syncState.syncModeComponentId || dismissedId != syncState.syncModeComponentId) return\n',
    '')),
  '比对')

  // c3 呈现提到收尾手脚之前（去抖占满时同步回调 → TDZ）
  check('c3 呈现移到手脚接好之前', () => syncWatchdogInvariants(tamper(REAL.sync,
    "    global.app_event.on('selectSyncMode', handleSelectMode)\n",
    "    global.app_event.on('selectSyncMode', handleSelectMode)\n    showSyncModeModal(handleUnavailable)\n")),
  '呈现在前')

  // c4 present() 入口的重复呈现守卫被删
  // 【第 38 轮第 2 条】锚点从旧的「无条件 return 一行」换成带大括号的判据块（守卫已升级为
  // 「区分本轮自己推出去的 / 上一轮的陈旧标记」）——沿用旧锚点会命中 .then() 复查里那句
  // 同样文本的无条件 return，反例就成了假通过。
  check('c4 present 入口守卫被删', () => presentGuardInvariants(tamper(REAL.utils,
    '    if (syncState.syncModeModalVisible) {\n',
    '')),
  '绝不再呈现第二个')

  // c5 卸载上报不看 syncModeSelecting（用户刚作答就被收回）
  check('c5 卸载上报越界', () => syncWatchdogInvariants(tamper(REAL.sync,
    '  if (!syncModeSelecting) return\n',
    '')),
  '越过 syncModeSelecting 判据')

  // c6 选择框卸载不再上报（锚点只取调用那行：它前后都是中文注释，跨行锚点会命中不到）
  check('c6 选择框卸载不上报', () => modalInvariants(tamper(REAL.modal,
    '      handleSyncModeModalUnmounted(componentId)\n',
    '')),
  '卸载上报次序不对')

  // c7 某个动作不再写状态行（点了下面那行字纹丝不动）
  check('c7 某个动作不再写状态行', () => syncPageInvariants(tamper(REAL.page,
    "      setWebdavStatus('歌单同步完成')\n",
    '')),
  '状态行写入次数')

  // c8 状态文案回显服务器地址（第 25 轮凭据口径）
  check('c8 状态文案回显地址', () => syncPageInvariants(tamper(REAL.page,
    "      setWebdavStatus('连接成功')\n",
    "      setWebdavStatus('连接成功 https://example.invalid/x')\n")),
  '不得回显')

  // c9 WebDAV 的状态又写进下面「同步服务地址」那一栏（两个功能串台 —— 第 36 轮第 2 条的原始 bug）
  check('c9 状态写回 setSyncMessage（串到下面那一栏）', () => syncPageInvariants(tamper(REAL.page,
    "      setWebdavStatus('连接成功')\n",
    "      setSyncMessage('连接成功')\n")),
  '互不干扰')

  // c10 卸载回调不带 componentId（core/sync 无从精确比对「消失的是不是当前那个」）
  check('c10 卸载回调不带 componentId', () => modalInvariants(tamper(REAL.modal,
    '      handleSyncModeModalUnmounted(componentId)\n',
    '      handleSyncModeModalUnmounted()\n')),
  '卸载上报次序不对')

  // c11 残留 id 的清理分支被删（呈现入口只判不救 → 选择框再也弹不出来）
  check('c11 残留 id 不再清理', () => presentGuardInvariants(tamper(REAL.utils,
    "      console.warn('[SyncMode] stale syncModeComponentId, clear before presenting:', syncState.syncModeComponentId)\n      syncActions.setSyncModeComponentId('')\n",
    '')),
  '残留 id')

  // c12 守卫退回按 id 判（残留 id 会被当成「还在屏幕上」→ 静默 return）
  check('c12 守卫退回按 id 判', () => presentGuardInvariants(tamper(REAL.utils,
    '    if (syncState.syncModeModalVisible) {',
    '    if (syncState.syncModeComponentId) {')),
  '确实在屏幕上')

  // c12b 陈旧标记又退回无条件静默 return（第 38 轮第 2 条的死路：不呈现、不重试、不上报）
  check('c12b 陈旧标记退回静默 return', () => presentGuardInvariants(tamper(REAL.utils,
    '      if (presentedThisRound) return\n',
    '      return\n')),
  'presentedThisRound')

  // c12c 陈旧标记只判不救（不清掉「在屏幕上」的标记 → 本轮每一次 present 都在守卫处停手）
  check('c12c 陈旧标记只判不救', () => presentGuardInvariants(tamper(REAL.utils,
    '      syncState.syncModeModalVisible = false\n',
    '')),
  '没有被清掉')

  // c13 挂载不再点亮「在屏幕上」标记
  check('c13 挂载不点亮在屏标记', () => modalInvariants(tamper(REAL.modal,
    '    markSyncModeModalVisible()\n',
    '')),
  '挂载没有点亮')

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-sync-mode-modal-watchdog ===')

const checks = [
  ['event.ts：onAnyModalDismissed（交回被关掉的 componentId，不闭包 id）', () => anyDismissedInvariants(REAL.events)],
  ['core/sync.ts：看门狗改语义 + 呈现次序 + 卸载上报', () => syncWatchdogInvariants(REAL.sync)],
  ['utils.ts：present() 入口的「绝不叠第二个」守卫', () => presentGuardInvariants(REAL.utils)],
  ['SyncModeModal：卸载上报 + 未知类型自撤', () => modalInvariants(REAL.modal)],
  ['设置页：六个动作各自写三句状态，且文案不含地址账号', () => syncPageInvariants(REAL.page)],
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
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.ok ? '已拦下' : `未拦下（reasons=${JSON.stringify(r.detail)}）`}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${checks.length}/${checks.length}；反例 ${ceResults.filter(r => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
