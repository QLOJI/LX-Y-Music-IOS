import { AppState } from 'react-native'
import handleAuth from './auth'
import {
  connect as socketConnect,
  disconnect as socketDisconnect,
  getStatus,
  hasClientConnection,
  isConnectionPending,
  isListNegotiating,
  resumeHeartbeat,
  sendConnectingStatus,
  sendSyncStatus,
  sendSyncMessage,
  suspendHeartbeat,
} from './client'
import { getSyncHost } from '../data'
import settingState from '@/store/setting/state'
import log from '../log'
import { parseUrl } from './utils'
import { SYNC_CODE } from '../constants'

let connectId = 0

const handleConnect = async(host: string, authCode?: string, options?: { silent?: boolean }) => {
  // const hostInfo = await getSyncHost()
  // console.log(hostInfo)
  // if (!hostInfo || !hostInfo.host || !hostInfo.port) throw new Error(SYNC_CODE.unknownServiceAddress)
  const id = connectId
  const urlInfo = parseUrl(host)
  await disconnectServer(false)
  if (id != connectId) return
  const keyInfo = await handleAuth(urlInfo, authCode)
  if (id != connectId) return
  socketConnect(urlInfo, keyInfo, options)
}
const handleDisconnect = async(isUserInitiated = true) => {
  await socketDisconnect(isUserInitiated)
}

const connectServer = async(host: string, authCode?: string, options?: { silent?: boolean }) => {
  // 已连接过的会话重连：状态保持「已连接」，只在文案上写「连接中」，
  // 避免「切出去再回来，已连接闪成未连接」（第 19 轮第 5 条，用户原话：
  //「退出软件或者切换出去，再返回软件后，状态变为未连接了……只要已连接，就要保持连接」）
  sendConnectingStatus()
  const id = connectId
  return handleConnect(host, authCode, options).catch(async(err) => {
    if (id != connectId) return
    sendSyncStatus({
      status: false,
      message: err.message,
    })
    switch (err.message) {
      case SYNC_CODE.connectServiceFailed:
      case SYNC_CODE.missingAuthCode:
        break
      default:
        log.r_warn(err.message)
        break
    }

    return Promise.reject(err)
  })
}

const disconnectServer = async(isResetStatus = true) =>
  handleDisconnect(isResetStatus)
    .then(() => {
      log.info('disconnect...')
      if (isResetStatus) {
        connectId++
        sendSyncStatus({
          status: false,
          message: '',
        })
      }
    })
    .catch((err: any) => {
      log.error(`disconnect error: ${err.message as string}`)
      sendSyncMessage(err.message as string)
    })

// 【第 34 轮第 1 条】isListNegotiating：歌单协商窗口（socket open → 服务端 finished()），
// 供 core/sync/webdavSync.ts 判断「现在能不能动本地歌单」
export { connectServer, disconnectServer, getStatus, isListNegotiating }

// ---------------------------------------------------------------------------
// 前后台切换的保活（第 19 轮第 5 条）
//
// 病根：iOS 退后台会冻结 JS，心跳的 31 秒计时器停在「已超时但没跑」的状态；
// 回前台瞬间它立刻到期，把 socket 关掉 —— 而不带 code 的 close 在事件里算「正常关闭」，
// 原逻辑对正常关闭直接 return，不重连。于是「显示已连接 → 切出去再回来 → 未连接」，
// 而且再也没人把连接拉起来。
//
// 现在的做法：
//   退后台 → 挂起心跳计时器（不误杀连接）；
//   回前台 → 连接还活着就重新计时；断了/僵尸了就延迟 1.5 秒复查一次再静默重连
//           （延迟是给 socket 的 close 事件一点送达时间，避免和已在途的重连打架）。
// ---------------------------------------------------------------------------

const FOREGROUND_RECHECK_MS = 1500

let foregroundTimer: ReturnType<typeof setTimeout> | null = null

/** 需要用户先处理的错误：回前台不要盲目重连，否则会反复撞同一个错 */
const unrecoverableMessages: string[] = [
  SYNC_CODE.missingAuthCode,
  SYNC_CODE.authFailed,
  SYNC_CODE.msgBlockedIp,
]

const reconnectSilently = async() => {
  const host = await getSyncHost()
  if (!host) return
  if (!settingState.setting['sync.enable']) return
  if (hasClientConnection() || isConnectionPending()) return
  // silent：不弹 "Sync connected" —— 这只是把断掉的连接接回来，不是用户发起的连接
  void connectServer(host, undefined, { silent: true }).catch(() => {})
}

const handleAppStateChange = (state: string) => {
  if (state !== 'active') {
    suspendHeartbeat()
    return
  }
  if (!settingState.setting['sync.enable']) return
  if (resumeHeartbeat()) return
  if (foregroundTimer) clearTimeout(foregroundTimer)
  foregroundTimer = setTimeout(() => {
    foregroundTimer = null
    if (!settingState.setting['sync.enable']) return
    if (hasClientConnection() || isConnectionPending()) return
    if (unrecoverableMessages.includes(getStatus().message)) return
    void reconnectSilently()
  }, FOREGROUND_RECHECK_MS)
}

AppState.addEventListener('change', handleAppStateChange)
