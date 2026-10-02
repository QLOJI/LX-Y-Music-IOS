/**
 * ① 「同步连接保活 + 启动不无条件同步」契约（第 19 轮第 5 条的钉子）。
 *
 * 需求原话：「启用同步后，退出后，每次返回软件都会马上同步一次，当前状态是，启用同步
 * 状态显示已连接，退出软件或者切换出去，再返回软件后，状态变为未连接了，这个问题要
 * 杜绝，只要已连接，就要保持连接。」
 *
 * 病根（两条，代码里的因果都写在注释里）：
 *   1) 心跳：ping 超时回调里 `client?.close()` 不带 code，close 事件按「正常关闭」分支
 *      直接 return —— 连接断了没人重连；而 iOS 退后台会冻结 JS，31s 的 ping 计时器
 *      会在回前台瞬间「过期即触发」，于是「切出去再回来 = 必定断一次且不自愈」。
 *   2) 启动：core/init/sync.ts 只要有 WebDAV 地址就无条件 triggerWebDAVSync()，
 *      每次冷启动都跑一次全量歌单同步 —— 就是「每次返回软件都会马上同步一次」。
 *
 * 本脚本断言：
 *   A. 心跳超时 = 「意图重连」再关（reconnectIntent 置位 → close 分支继续 reConnnect），
 *      且 31s / 重连退避等协议时值没被改动；
 *   B. 前后台：退后台挂起心跳、回前台续上或延迟复查后静默重连（AppState 监听 +
 *      1.5s 复查 + 不可自动恢复的错误黑名单 + 不弹 toast + 不并发起第二个连接）；
 *   C. 状态语义：连过的会话重连途中状态保持「已连接」（sendConnectingStatus /
 *      open 分支 / 用户主动断开才归零），不再出现「已连接 → 未连接」的闪断；
 *   D. 启动同步：只在本地攒着未同步歌单操作（opQueue 非空）时才补同步；
 *   E. 反例自检：心跳不标意图 / 正常关闭无条件归零 / 去掉 AppState 监听 /
 *      启动改回无条件同步，都必须判红。
 *
 * 运行：node scripts/sim-sync-keepalive.js
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

const clientSrc = read('src/plugins/sync/client/client.ts')
const indexSrc = read('src/plugins/sync/client/index.ts')
const initSrc = read('src/core/init/sync.ts')
const webdavSrc = read('src/core/sync/webdavSync.ts')

// --- A. 心跳：意图重连 ---
const flags = {
  everConnected: /let everConnected = false/.test(clientSrc),
  connectionAlive: /let connectionAlive = false/.test(clientSrc),
  reconnectIntent: /let reconnectIntent = false/.test(clientSrc),
  connecting: /let connecting = false/.test(clientSrc),
  pendingReconnect: /let pendingReconnect = false/.test(clientSrc),
  userDisconnect: /let userDisconnect = false/.test(clientSrc),
}

const pingBlock = /this\.pingTimeout = setTimeout\(\(\) => \{([\s\S]*?)\}, 30000 \+ 1000\)/.exec(clientSrc)
const pingIntervalKept = /30000 \+ 1000/.test(clientSrc)
const pingMarksIntent = !!pingBlock &&
  pingBlock[1].indexOf('reconnectIntent = true') > -1 &&
  pingBlock[1].indexOf('reconnectIntent = true') < pingBlock[1].indexOf('client?.close()')

const suspendBlock = /suspend\(\) \{([\s\S]*?)\}/.exec(clientSrc)
const resumeBlock = /resume\(\) \{([\s\S]*?)\}/.exec(clientSrc)
const suspendClears = !!suspendBlock && /this\.clearTimeout\(\)/.test(suspendBlock[1])
const resumeChecksAlive = !!resumeBlock && /if \(!connectionAlive\) return false/.test(resumeBlock[1]) && /this\.heartbeat\(\)/.test(resumeBlock[1])

const closeListener = /socket\.addEventListener\('close', \(event\) => \{([\s\S]*?)\n    \}\)/.exec(clientSrc)
const closeConsumesIntent = !!closeListener &&
  /const intended = reconnectIntent/.test(closeListener[1]) &&
  /reconnectIntent = false/.test(closeListener[1]) &&
  /if \(!intended\) return/.test(closeListener[1]) &&
  /this\.reConnnect\(\)/.test(closeListener[1])

const backoffKept = /Math\.min\(2000 \+ Math\.floor\(this\.failedNum \/ 2\) \* this\.stepMs, 30000\)/.test(clientSrc)

// --- C. 状态语义 ---
const sendConnecting = /export const sendConnectingStatus = \(\) => \{[\s\S]*?status: everConnected,[\s\S]*?message: SYNC_CODE\.connecting/.test(clientSrc)
const finishedMarksConnected = /finished\(\) \{([\s\S]*?)\n      \},/.exec(clientSrc)
const finishedOk = !!finishedMarksConnected &&
  /everConnected = true/.test(finishedMarksConnected[1]) &&
  /connectionAlive = true/.test(finishedMarksConnected[1])
const openListener = /client\.addEventListener\('open', \(\) => \{([\s\S]*?)\n  \}\)/.exec(clientSrc)
const openKeepsConnected = !!openListener &&
  /if \(everConnected\) \{/.test(openListener[1]) &&
  /status: true,\s*\n\s*message: SYNC_CODE\.connecting,/.test(openListener[1]) &&
  /status: false,\s*\n\s*message: initMessage,/.test(openListener[1])
const connectClose = /client\.addEventListener\('close', \(\{ code \}\) => \{([\s\S]*?)\n  \}\)/.exec(clientSrc)
const normalOnlyOnUserDisconnect = !!connectClose &&
  /case SYNC_CLOSE_CODE\.normal:[\s\S]*?if \(userDisconnect\) \{[\s\S]*?sendSyncStatus\(\{\s*\n\s*status: false,\s*\n\s*message: '',/.test(connectClose[1])
const disconnectSignature = /export const disconnect = async\(isUserInitiated = true\) =>/.test(clientSrc)
const disconnectResets = /if \(isUserInitiated\) everConnected = false/.test(clientSrc) && /userDisconnect = isUserInitiated/.test(clientSrc)
const connectResetsUserFlag = /export const connect = \(urlInfo[\s\S]*?userDisconnect = false/.test(clientSrc)
const exportsOk = /export const hasClientConnection = \(\) => connectionAlive/.test(clientSrc) &&
  /export const isConnectionPending = \(\) => connecting \|\| pendingReconnect/.test(clientSrc) &&
  /export const suspendHeartbeat = \(\) => \{\s*\n\s*heartbeatTools\.suspend\(\)/.test(clientSrc) &&
  /export const resumeHeartbeat = \(\) => heartbeatTools\.resume\(\)/.test(clientSrc)

// --- B. 前后台 ---
const appStateRegistered = /AppState\.addEventListener\('change', handleAppStateChange\)/.test(indexSrc)
const recheckMs = /const FOREGROUND_RECHECK_MS = (\d+)/.exec(indexSrc)
const recheckMsValue = recheckMs ? Number(recheckMs[1]) : NaN
const handlerBlock = /const handleAppStateChange = \(state: string\) => \{([\s\S]*?)\n\}/.exec(indexSrc)
const handlerOk = !!handlerBlock &&
  /if \(state !== 'active'\) \{\s*\n\s*suspendHeartbeat\(\)/.test(handlerBlock[1]) &&
  /if \(!settingState\.setting\['sync\.enable'\]\) return/.test(handlerBlock[1]) &&
  /if \(resumeHeartbeat\(\)\) return/.test(handlerBlock[1]) &&
  /hasClientConnection\(\) \|\| isConnectionPending\(\)/.test(handlerBlock[1]) &&
  /unrecoverableMessages\.includes\(getStatus\(\)\.message\)/.test(handlerBlock[1]) &&
  /void reconnectSilently\(\)/.test(handlerBlock[1])
const blacklistOk = /const unrecoverableMessages: string\[\] = \[([\s\S]*?)\]/.exec(indexSrc)
const blacklistEntries = blacklistOk ? blacklistOk[1].trim().split(',').map((s) => s.trim()).filter(Boolean) : []
const blacklistHasAuth = ['SYNC_CODE.missingAuthCode', 'SYNC_CODE.authFailed', 'SYNC_CODE.msgBlockedIp'].every((k) => blacklistEntries.includes(k))
const silentReconnect = /const reconnectSilently = async\(\) => \{([\s\S]*?)\n\}/.exec(indexSrc)
const silentOk = !!silentReconnect &&
  /\{ silent: true \}/.test(silentReconnect[1]) &&
  /if \(!settingState\.setting\['sync\.enable'\]\) return/.test(silentReconnect[1]) &&
  /if \(hasClientConnection\(\) \|\| isConnectionPending\(\)\) return/.test(silentReconnect[1])
const connectServerSilent = /connectServer\(host, undefined, \{ silent: true \}\)/.test(indexSrc)
const disconnectPassThrough = /const disconnectServer = async\(isResetStatus = true\) =>\s*\n\s*handleDisconnect\(isResetStatus\)/.test(indexSrc)
const oldConnectingGone = !/sendSyncStatus\(\{\s*\n\s*status: false,\s*\n\s*message: SYNC_CODE\.connecting,/.test(indexSrc)
const usesSendConnecting = /sendConnectingStatus\(\)/.test(indexSrc)

// --- D. 启动同步 ---
const startupGate = /export const syncPendingChangesOnStartup = async\(\) => \{([\s\S]*?)\n\}/.exec(webdavSrc)
const startupOk = !!startupGate &&
  /await loadOperationQueue\(\)/.test(startupGate[1]) &&
  /getOperationQueue\(\)\.length === 0/.test(startupGate[1]) &&
  /await triggerWebDAVSync\(\)/.test(startupGate[1])
const initUsesGate = /void syncPendingChangesOnStartup\(\)/.test(initSrc)
const initNoUnconditionalSync = !/void triggerWebDAVSync\(\)/.test(initSrc)

// --- E. 反例自检 ---
const mutate = (src, from, to) => {
  const out = src.replace(from, to)
  return { out, hit: out !== src }
}
const mutateAll = (src, from, to) => {
  const out = src.split(from).join(to)
  return { out, hit: out !== src }
}
const negPingIntent = mutateAll(clientSrc, 'reconnectIntent = true\n      client?.close()', 'client?.close()')
const negPingIntentBlock = /this\.pingTimeout = setTimeout\(\(\) => \{([\s\S]*?)\}, 30000 \+ 1000\)/.exec(negPingIntent.out)
const negPingRed = negPingIntent.hit && !(negPingIntentBlock[1].indexOf('reconnectIntent = true') > -1)

const negNormalZero = mutate(clientSrc, 'if (userDisconnect) {', 'if (true) {')
const negNormalClose = /client\.addEventListener\('close', \(\{ code \}\) => \{([\s\S]*?)\n  \}\)/.exec(negNormalZero.out)
const negNormalRed = negNormalZero.hit && !/if \(userDisconnect\) \{/.test(negNormalClose ? negNormalClose[1] : '')

const negNoAppState = mutate(indexSrc, "AppState.addEventListener('change', handleAppStateChange)", '')
const negNoAppStateRed = negNoAppState.hit && !/AppState\.addEventListener\('change', handleAppStateChange\)/.test(negNoAppState.out)

const negStartup = mutate(initSrc, 'void syncPendingChangesOnStartup()', 'void triggerWebDAVSync()')
const negStartupRed = negStartup.hit && /void triggerWebDAVSync\(\)/.test(negStartup.out)

const negConnectingStatus = mutate(indexSrc, 'sendConnectingStatus()', 'sendSyncStatus({\n      status: false,\n      message: SYNC_CODE.connecting,\n    })')
const negConnectingRed = negConnectingStatus.hit && /sendSyncStatus\(\{\s*\n\s*status: false,\s*\n\s*message: SYNC_CODE\.connecting,/.test(negConnectingStatus.out)

console.log('='.repeat(94))
console.log('「同步连接保活 + 启动不无条件同步」契约模型')
console.log('='.repeat(94))
console.log(`  连接状态位：${Object.entries(flags).map(([k, v]) => `${k} ${v ? '✅' : '❌'}`).join('   ')}`)
console.log(`  心跳：31s 时值保留 ${pingIntervalKept ? '✅' : '❌'}   超时先标意图再关 ${pingMarksIntent ? '✅' : '❌'}   悬挂/续接 ${suspendClears && resumeChecksAlive ? '✅' : '❌'}   close 消费意图 ${closeConsumesIntent ? '✅' : '❌'}   退避时值保留 ${backoffKept ? '✅' : '❌'}`)
console.log(`  前后台：AppState 监听 ${appStateRegistered ? '✅' : '❌'}   复查延时 ${Number.isFinite(recheckMsValue) ? recheckMsValue + 'ms' : '❌'}   处理分支 ${handlerOk ? '✅' : '❌'}   错误黑名单 ${blacklistHasAuth ? '✅' : '❌'}   静默重连 ${silentOk && connectServerSilent ? '✅' : '❌'}`)
console.log(`  状态语义：重连不清零 ${sendConnecting && openKeepsConnected ? '✅' : '❌'}   仅用户断开才归零 ${normalOnlyOnUserDisconnect ? '✅' : '❌'}   主动断开重置 ${disconnectSignature && disconnectResets ? '✅' : '❌'}`)
console.log(`  启动同步：opQueue 非空才补 ${startupOk ? '✅' : '❌'}   init 走门控 ${initUsesGate ? '✅' : '❌'}   不再无条件同步 ${initNoUnconditionalSync ? '✅' : '❌'}`)
console.log()

console.log('='.repeat(94))
console.log('断言')
console.log('='.repeat(94))

check('连接状态位齐备（everConnected / connectionAlive / reconnectIntent / connecting / pendingReconnect / userDisconnect）', Object.values(flags).every(Boolean), 'client.ts 模块级状态')
check('心跳超时先标「意图重连」再关（close 分支据此续连，连接不再躺平）', pingMarksIntent, 'reconnectIntent = true → client?.close()')
check('心跳时值仍是 30000 + 1000（服务端 30s ping 的协议时值，不许动）', pingIntervalKept, '30000 + 1000')
check('重连退避仍是 2000 + n/2 × 3000，封顶 30s', backoffKept, 'Math.min(...) 原式')
check('close 事件消费重连意图：normal/failed 仅在无意图时不重连', closeConsumesIntent, 'intended 判定 + reConnnect()')
check('退后台挂起心跳（suspend → clearTimeout）', suspendClears, 'heartbeatTools.suspend()')
check('回前台连接活着就续上心跳（resume → connectionAlive 判定 + heartbeat）', resumeChecksAlive, 'heartbeatTools.resume()')
check('AppState 监听已注册（退后台挂起 / 回前台续接）', appStateRegistered, "AppState.addEventListener('change', ...)")
check(`回前台复查延时 = ${recheckMsValue}ms（给 close 事件送达留时间，且 < 2s 不拖沓）`, recheckMsValue >= 1000 && recheckMsValue <= 2000, 'FOREGROUND_RECHECK_MS')
check('回前台处理：非 active 挂起 → 未开同步不动作 → 活着续上 → 否则延迟复查补连', handlerOk, 'handleAppStateChange')
check('复查跳过：连接活着 / 在途 → 不并发起第二个连接；握手类错误不盲目重连', /hasClientConnection\(\) \|\| isConnectionPending\(\)/.test(handlerBlock ? handlerBlock[1] : ''), '双保险')
check('不可自动恢复的错误黑名单（缺连接码 / 认证失败 / IP 被封）齐备', blacklistHasAuth, blacklistEntries.join(' / '))
check('补连走静默（不弹 "Sync connected"）+ 关同步后不补连', silentOk && connectServerSilent, 'connectServer(host, undefined, { silent: true })')
check('connectServer 用 sendConnectingStatus（连过的会话重连不清零状态）', usesSendConnecting && oldConnectingGone, '不再直接 status: false')
check('sendConnectingStatus 取 everConnected 作为 status（重连途中保持「已连接」）', sendConnecting, 'status: everConnected')
check('finished() 置 everConnected / connectionAlive（握手成功才算连上）', finishedOk, 'finished 分支')
check('socket open：连过的会话保持 status true（只在文案写「连接中」）；首连才走 Wait syncing', openKeepsConnected, 'if (everConnected) { ... } else { ... }')
check('close(1000)：只有用户主动断开才把状态归位「未连接」', normalOnlyOnUserDisconnect, 'if (userDisconnect) { ... }')
check('disconnect(isUserInitiated) 默认用户发起；重连前的收尾断开（false）保留连接记忆', disconnectSignature && disconnectResets && connectResetsUserFlag, 'everConnected / userDisconnect')
check('导出 hasClientConnection / isConnectionPending / suspendHeartbeat / resumeHeartbeat', exportsOk, 'AppState 分支要用')
check('disconnectServer(isResetStatus) 把「是否用户发起」透传给 socket 层', disconnectPassThrough, 'handleDisconnect(isResetStatus)')
check('启动补同步门控：先 loadOperationQueue，队列为空直接跳过', startupOk, 'syncPendingChangesOnStartup')
check('init/sync.ts 走门控，不再无条件 triggerWebDAVSync()', initUsesGate && initNoUnconditionalSync, 'core/init/sync.ts')
check('反例：心跳不标意图直接关，必须判红', negPingRed, negPingIntent.hit ? '意图缺失被抓到' : '替换未命中原文')
check('反例：正常关闭改回无条件清零状态，必须判红', negNormalRed, negNormalZero.hit ? '无条件归零被抓到' : '替换未命中原文')
check('反例：去掉 AppState 监听，必须判红', negNoAppStateRed, negNoAppState.hit ? '监听缺失被抓到' : '替换未命中原文')
check('反例：启动改回无条件同步，必须判红', negStartupRed, negStartup.hit ? '无条件同步被抓到' : '替换未命中原文')
check('反例：connectServer 改回直接 status:false「连接中」，必须判红', negConnectingRed, negConnectingStatus.hit ? '状态清零被抓到' : '替换未命中原文')

console.log()
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
}
console.log()
console.log(`结果：${results.length - failed}/${results.length} 通过${failed ? `（${failed} 项失败）` : ''}`)
process.exit(failed ? 1 : 0)
