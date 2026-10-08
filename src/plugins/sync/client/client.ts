import { encryptMsg, decryptMsg } from './utils'
import { callObj } from './sync'
// import { action as commonAction } from '@/store/modules/common'
// import { getStore } from '@/store'
// import registerSyncListHandler from './syncList'
import log from '../log'
import { aesEncrypt } from '../utils'
import { isSyncModeSelecting, setSyncStatus } from '@/core/sync'
import { dateFormat } from '@/utils/common'
import { createMsg2call } from 'message2call'
import { toast } from '@/utils/tools'
import { SYNC_CLOSE_CODE, SYNC_CODE } from '../constants'

let status: LX.Sync.Status = {
  status: false,
  message: '',
}

// 本进程内是否成功握手过（finished()）。用来区分「首次连接」与「断线重连」：
// 重连途中状态保持「已连接」（只在文案上写连接中），不把 UI 打回「未连接」。
let everConnected = false
// 连接活性：socket open 置 true，close / disconnect 置 false。
// 不能用 client 变量判断活性 —— 断开后 client 仍保留一份引用（重连要靠它拿 urlInfo/keyInfo）。
let connectionAlive = false
// 意图重连：心跳超时（链路已死，或回前台后过期的计时器误杀）主动关闭 socket 时置位，
// close 事件里据此重连。原来这里不带 code 关闭，close 事件按「正常关闭」分支直接躺平，
// 连接再也没人拉起来 —— 这就是用户看到的「显示已连接，切出去再回来变未连接」。
let reconnectIntent = false
// socket 已创建、尚未 open/close（WebSocket 握手途中）
let connecting = false
// 已排定延迟重连（reConnnect 的定时器已挂上）
let pendingReconnect = false
// 用户主动断开（关同步开关）：close 事件里据此把状态归位「未连接」；
// 重连前的收尾断开（connectServer 先断后连）不动状态 —— 连接马上会重建。
let userDisconnect = false

export const sendSyncStatus = (newStatus: Omit<LX.Sync.Status, 'address'>) => {
  status.status = newStatus.status
  status.message = newStatus.message
  setSyncStatus(status)
}

/** 发起（重）连接时的状态：连过的会话保持「已连接」不清零，只在文案上提示连接中。 */
export const sendConnectingStatus = () => {
  sendSyncStatus({
    status: everConnected,
    message: SYNC_CODE.connecting,
  })
}

export const sendSyncMessage = (message: string) => {
  status.message = message
  setSyncStatus(status)
}

/** 当前是否有活着的连接（open 之后、close 之前） */
export const hasClientConnection = () => connectionAlive
/** 连接是否「在途」（握手途中 / 已排定延迟重连）：回前台补连前要先排除这两种情况 */
export const isConnectionPending = () => connecting || pendingReconnect

// ---------------------------------------------------------------------------
// 【第 34 轮第 1 条】歌单协商窗口 + 握手静默看门狗
//
// 用户原话：「请判断 WebDAV 同步和同步服务地址同步是否有冲突，使其独立不相互影响」
// 与「启用同步勾选后，会有很长的 Wait syncing... 的提示」。
//
// ① 协商窗口：socket open 起、到服务端 finished() 为止。这期间服务端手里拿着我们刚报上去的
//    md5 做「谁更新 / 要不要合并」的判断，本地歌单若被另一套同步（WebDAV）改写，服务端据此
//    得出的结论就对不上真实数据。窗口供 core/sync/webdavSync.ts 让行用
//    （见那里的 waitForListNegotiation）。
//    窗口封顶 LX_LIST_NEGOTIATION_MAX_MS：服务端万一不回调 finished()（版本不匹配、
//    中途出错），也不能把 WebDAV 那边的自动同步永久挡死。
// ② 看门狗：握手期内服务端一直不说话（既没问问题、也没 finished），就把状态文案从
//    'Wait syncing...' 换成一句能让人有动作的话。只改文案、不重连 —— 首次同步大库本来就可能
//    慢，误杀重连会把一次正常的大同步打断。
// ---------------------------------------------------------------------------
const LX_LIST_NEGOTIATION_MAX_MS = 90000
let listNegotiationUntil = 0
/** 是否处于「服务端正在据此协商歌单」的窗口内（WebDAV 歌单同步据此让行） */
export const isListNegotiating = () => connectionAlive && Date.now() < listNegotiationUntil

const HANDSHAKE_QUIET_TIMEOUT_MS = 60000
let handshakeWatchdog: ReturnType<typeof setTimeout> | null = null

const clearHandshakeWatchdog = () => {
  if (handshakeWatchdog) {
    clearTimeout(handshakeWatchdog)
    handshakeWatchdog = null
  }
}

const armHandshakeWatchdog = () => {
  clearHandshakeWatchdog()
  handshakeWatchdog = setTimeout(() => {
    handshakeWatchdog = null
    if (!connectionAlive) return
    if (client?.isReady) return
    // 用户正在看「同步方式」选择框：这是合理的长等待，不能催
    if (isSyncModeSelecting()) return
    log.r_warn('[sync] handshake quiet timeout: no finished() from server')
    sendSyncMessage('同步服务 60 秒内没有完成同步，可尝试关闭「启用同步」后重新打开')
  }, HANDSHAKE_QUIET_TIMEOUT_MS)
}

const heartbeatTools = {
  failedNum: 0,
  maxTryNum: 100000,
  stepMs: 3000,
  connectTimeout: null as NodeJS.Timeout | null,
  pingTimeout: null as NodeJS.Timeout | null,
  delayRetryTimeout: null as NodeJS.Timeout | null,
  handleOpen() {
    console.log('open')
    // this.failedNum = 0
    this.heartbeat()
  },
  heartbeat() {
    if (this.pingTimeout) clearTimeout(this.pingTimeout)

    // Use `WebSocket#terminate()`, which immediately destroys the connection,
    // instead of `WebSocket#close()`, which waits for the close timer.
    // Delay should be equal to the interval at which your server
    // sends out pings plus a conservative assumption of the latency.
    this.pingTimeout = setTimeout(() => {
      // 心跳超时 = 链路已死：标记「意图重连」再关，close 分支据此把连接拉起来
      reconnectIntent = true
      client?.close()
    }, 30000 + 1000)
  },
  /** 退后台：挂起所有计时器 —— iOS 冻结 JS，超时的 ping 计时器会在回前台瞬间误触发 */
  suspend() {
    this.clearTimeout()
  },
  /** 回前台：连接还活着就重新计时（再给一个心跳周期）；返回是否续上 */
  resume() {
    if (!connectionAlive) return false
    this.heartbeat()
    return true
  },
  reConnnect() {
    this.clearTimeout()
    // client = null
    if (!client) return

    if (++this.failedNum > this.maxTryNum) {
      this.failedNum = 0
      sendSyncStatus({
        status: false,
        message: 'Connect error',
      })
      throw new Error('connect error')
    }

    const waitTime = Math.min(2000 + Math.floor(this.failedNum / 2) * this.stepMs, 30000)

    // sendSyncStatus({
    //   status: false,
    //   message: `Waiting ${waitTime / 1000}s reconnnect...`,
    // })

    pendingReconnect = true
    this.delayRetryTimeout = setTimeout(() => {
      this.delayRetryTimeout = null
      pendingReconnect = false
      if (!client) return
      console.log(dateFormat(new Date()), 'reconnnect...')
      sendSyncStatus({
        status: false,
        message: `Try reconnnect... (${this.failedNum})`,
      })
      connect(client.data.urlInfo, client.data.keyInfo)
    }, waitTime)
  },
  clearTimeout() {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout)
      this.connectTimeout = null
    }
    if (this.delayRetryTimeout) {
      clearTimeout(this.delayRetryTimeout)
      this.delayRetryTimeout = null
    }
    pendingReconnect = false
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout)
      this.pingTimeout = null
    }
  },
  connect(socket: LX.Sync.Socket) {
    console.log('heartbeatTools connect')
    this.connectTimeout = setTimeout(
      () => {
        this.connectTimeout = null
        if (client) {
          try {
            client.close(SYNC_CLOSE_CODE.failed)
          } catch {}
        }
        if (++this.failedNum > this.maxTryNum) {
          this.failedNum = 0
          sendSyncStatus({
            status: false,
            message: 'Connect error',
          })
          throw new Error('connect error')
        }
        sendSyncStatus({
          status: false,
          message: 'Connect timeout, try reconnect...',
        })
        this.reConnnect()
      },
      2 * 60 * 1000,
    )
    socket.addEventListener('open', () => {
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout)
        this.connectTimeout = null
      }
      this.handleOpen()
    })
    socket.addEventListener('message', ({ data }) => {
      if (data == 'ping') this.heartbeat()
    })
    socket.addEventListener('close', (event) => {
      // console.log(event.code)
      connectionAlive = false
      const intended = reconnectIntent
      reconnectIntent = false
      switch (event.code) {
        case SYNC_CLOSE_CODE.normal:
        case SYNC_CLOSE_CODE.failed:
          // 主动断开（disconnect()）/ 协议级失败：沿用旧行为不自动重连；
          // 但「意图重连」（心跳超时主动关闭）必须继续重连，否则连接从此躺平
          if (!intended) return
          break
      }
      this.reConnnect()
    })
  },
}

let client: LX.Sync.Socket | null
// let listSyncPromise: Promise<void>
export const connect = (urlInfo: LX.Sync.UrlInfo, keyInfo: LX.Sync.KeyInfo, options?: { silent?: boolean }) => {
  connecting = true
  userDisconnect = false
  client = new WebSocket(
    `${urlInfo.wsProtocol}//${urlInfo.hostPath}/socket?i=${encodeURIComponent(keyInfo.clientId)}&t=${encodeURIComponent(aesEncrypt(SYNC_CODE.msgConnect, keyInfo.key))}`,
  ) as LX.Sync.Socket
  client.data = {
    keyInfo,
    urlInfo,
  }
  heartbeatTools.connect(client)

  let closeEvents: Array<(err: Error) => void | Promise<void>> = []
  let disconnected = true

  const message2read = createMsg2call<LX.Sync.ServerSyncActions>({
    funcsObj: {
      ...callObj,
      finished() {
        // 仅对真实（手动/重连）连接成功弹 toast；App 冷启动的自动连接不弹，
        // 避免"每次杀死后台再打开都显示 sync connected"的骚扰。
        if (!options?.silent) toast('Sync connected')
        client!.isReady = true
        everConnected = true
        connectionAlive = true
        reconnectIntent = false
        // 【第 34 轮第 1 条】服务端说「这一轮同步完了」：关掉协商窗口与握手看门狗
        listNegotiationUntil = 0
        clearHandshakeWatchdog()
        sendSyncStatus({
          status: true,
          message: '',
        })
        heartbeatTools.failedNum = 0
      },
    },
    timeout: 120 * 1000,
    sendMessage(data) {
      if (disconnected) throw new Error('disconnected')
      void encryptMsg(keyInfo, JSON.stringify(data))
        .then((data) => {
          client?.send(data)
        })
        .catch((err) => {
          log.error('encrypt msg error: ', err)
          client?.close(SYNC_CLOSE_CODE.failed)
        })
    },
    onCallBeforeParams(rawArgs) {
      return [client, ...rawArgs]
    },
    onError(error, path, groupName) {
      const name = groupName ?? ''
      log.r_error(`sync call ${name} ${path.join('.')} error:`, error)
      // if (groupName == null) return
      // client?.close(SYNC_CLOSE_CODE.failed)
      // sendSyncStatus({
      //   status: false,
      //   message: error.message,
      // })
    },
  })

  client.remote = message2read.remote
  client.remoteQueueList = message2read.createQueueRemote('list')
  client.remoteQueueDislike = message2read.createQueueRemote('dislike')

  client.addEventListener('message', ({ data }) => {
    if (data == 'ping') return
    if (typeof data === 'string') {
      void decryptMsg(keyInfo, data)
        .then((data) => {
          let syncData: LX.Sync.ServerSyncActions
          try {
            syncData = JSON.parse(data)
          } catch (err) {
            log.error('parse msg error: ', err)
            client?.close(SYNC_CLOSE_CODE.failed)
            return
          }
          message2read.message(syncData)
        })
        .catch((error) => {
          log.error('decrypt msg error: ', error)
          client?.close(SYNC_CLOSE_CODE.failed)
        })
    }
  })
  client.onClose = function(handler: (typeof closeEvents)[number]) {
    closeEvents.push(handler)
    return () => {
      closeEvents.splice(closeEvents.indexOf(handler), 1)
    }
  }

  const initMessage = 'Wait syncing...'
  client.addEventListener('open', () => {
    log.info('connect')
    // const store = getStore()
    // global.lx.syncKeyInfo = keyInfo
    client!.isReady = false
    client!.moduleReadys = {
      list: false,
      dislike: false,
    }
    disconnected = false
    connecting = false
    connectionAlive = true
    // 【第 34 轮第 1 条】协商窗口从这里开始（结算点 = 服务端 finished()，封顶 90 秒），
    // 同时挂上握手看门狗（服务端 60 秒毫无动静时把状态文案换成人话）
    listNegotiationUntil = Date.now() + LX_LIST_NEGOTIATION_MAX_MS
    armHandshakeWatchdog()
    if (everConnected) {
      // 断线重连：状态保持「已连接」（文案提示连接中），不打回「未连接」
      sendSyncStatus({
        status: true,
        message: SYNC_CODE.connecting,
      })
    } else {
      sendSyncStatus({
        status: false,
        message: initMessage,
      })
    }
  })
  client.addEventListener('close', ({ code }) => {
    const err = new Error('closed')
    try {
      for (const handler of closeEvents) void handler(err)
    } catch (err: any) {
      log.error(err?.message)
    }
    closeEvents = []
    disconnected = true
    connecting = false
    connectionAlive = false
    // 【第 34 轮第 1 条】连接没了：协商窗口与看门狗一并收掉（下次 open 再挂）
    listNegotiationUntil = 0
    clearHandshakeWatchdog()
    message2read.destroy()
    switch (code) {
      case SYNC_CLOSE_CODE.normal:
        // case SYNC_CLOSE_CODE.failed:
        // 只有「用户主动断开」（disconnect(true)）才归位「未连接」；
        // 心跳超时等意图重连的关闭不清零，状态交给 reConnnect / finished 接管
        if (userDisconnect) {
          sendSyncStatus({
            status: false,
            message: '',
          })
        }
        break
      case SYNC_CLOSE_CODE.failed:
        if (!status.message || status.message == initMessage) {
          sendSyncStatus({
            status: false,
            message: 'failed',
          })
        }
        break
    }
  })
  client.addEventListener('error', ({ message }) => {
    sendSyncStatus({
      status: false,
      message,
    })
  })
}

/**
 * 断开连接。
 * @param isUserInitiated 用户主动关闭同步（true）：清掉连接记忆，close 事件把状态归位「未连接」。
 *   重连前的收尾断开（connectServer 先断后连）传 false —— 连接马上重建，状态不能清零。
 */
export const disconnect = async(isUserInitiated = true) => {
  if (!client) return
  log.info('disconnecting...')
  reconnectIntent = false
  connecting = false
  connectionAlive = false
  // 【第 34 轮第 1 条】同上：主动断开也要把协商窗口 / 看门狗收掉
  listNegotiationUntil = 0
  clearHandshakeWatchdog()
  userDisconnect = isUserInitiated
  if (isUserInitiated) everConnected = false
  client.close(SYNC_CLOSE_CODE.normal)
  client = null
  heartbeatTools.clearTimeout()
  heartbeatTools.failedNum = 0
}

/** 退后台：挂起心跳（避免回前台时过期计时器把连接误杀） */
export const suspendHeartbeat = () => {
  heartbeatTools.suspend()
}

/** 回前台：连接还活着就续上心跳；返回 false 表示需要重连 */
export const resumeHeartbeat = () => heartbeatTools.resume()

export const getStatus = (): LX.Sync.Status => status
