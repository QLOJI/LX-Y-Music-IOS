import {
  type InitParams,
  onScriptAction,
  sendAction,
  type ResponseParams,
  type UpdateInfoParams,
  type RequestParams,
} from '@/utils/nativeModules/userApi'
import { log, setUserApiList, setUserApiStatus } from '@/core/userApi'
import settingState from '@/store/setting/state'
import BackgroundTimer from 'react-native-background-timer'
import { fetchData } from './request'
import { getUserApiList } from '@/utils/data'
import { confirmDialog, openUrl, tipDialog } from '@/utils/tools'

const LOSSLESS_QUALITYS = new Set(['master', 'atmos', 'atmos_plus', 'hires', 'flac24bit', 'flac'])

// 【第 259 轮】自定义源回传的 quality/type 不可信：IKUN-API 返回的是中文展示名
//（「臻品母带」「臻品全景声」「无损音质 FLAC」「高音质 320K」），有的脚本还会统一报成
// master。用它当 LX.Quality 会让高音质档被迫走 AVPlayer、失败降级又从 master 起跳
//（用户看到「手动选 atmos/24bit/SQ，取两次链接后自动跳回 master，HQ 正常」）。
// 定案：实际档位 = **本次请求档 + URL 容器格式**，源的文字标签不参与播放/降级判定。

// 只看容器格式判断是否发生了「明显降级」。无损档之间的大小差异受源侧切片影响，
// 不能拿曲目元数据里的 size 反推（会把 Master 误判成 24bit）。
const getActualQualityByFormat = (url: string, contentType: string, requested: LX.Quality): LX.Quality => {
  const type = contentType.toLowerCase()
  const path = url.toLowerCase().split('?')[0]
  const isFlac = type.includes('audio/flac') || type.includes('audio/x-flac') || /\.flac$/.test(path)
  const isM4a = type.includes('audio/mp4') || type.includes('audio/m4a') || type.includes('audio/aac') || /\.(m4a|aac)$/.test(path)
  const isMp3 = type.includes('audio/mpeg') || type.includes('audio/mp3') || /\.mp3$/.test(path)

  if (isFlac) return requested
  if (isM4a && (LOSSLESS_QUALITYS.has(requested) || requested === '320k')) return '128k'
  if (isMp3 && LOSSLESS_QUALITYS.has(requested)) return '320k'
  return requested
}

export default async(_setting: LX.AppSetting) => {
  const userApiRequestMap = new Map<
  string,
  {
    resolve: (value: ResponseParams['result']) => void
    reject: (error: Error) => void
    timeout: number
  }
  >()
  const scriptRequestMap = new Map<string, { request: Promise<any>, abort: () => void }>()

  const cancelRequest = (requestKey: string, _message: string) => {
    const target = scriptRequestMap.get(requestKey)
    if (!target) return
    scriptRequestMap.delete(requestKey)
    target.abort()
  }
  const sendScriptRequest = (
    requestKey: string,
    url: string,
    options: RequestParams['options'],
  ) => {
    let req = fetchData(url, options)
    req.request
      .then((response) => {
        // console.log(response)
        sendAction('response', {
          error: null,
          requestKey,
          response,
        })
      })
      .catch((err) => {
        sendAction('response', {
          error: err.message,
          requestKey,
          response: null,
        })
      })
      .finally(() => {
        scriptRequestMap.delete(requestKey)
      })
    scriptRequestMap.set(requestKey, req)
  }
  const sendUserApiRequest = async(data: LX.UserApi.UserApiRequestParams) => {
    const handleApiUpdate = () => {
      const target = userApiRequestMap.get(data.requestKey)
      if (!target) return
      userApiRequestMap.delete(data.requestKey)
      BackgroundTimer.clearTimeout(target.timeout)
      target.reject(new Error('request failed'))
    }
    const requestPromise = new Promise<ResponseParams['result']>((resolve, reject) => {
      userApiRequestMap.set(data.requestKey, {
        resolve,
        reject,
        timeout: BackgroundTimer.setTimeout(() => {
          const target = userApiRequestMap.get(data.requestKey)
          if (!target) return
          userApiRequestMap.delete(data.requestKey)
          target.reject(new Error('request timeout'))
        }, 20_000),
      })
      sendAction('request', data)
    }).finally(() => {
      global.state_event.off('apiSourceUpdated', handleApiUpdate)
    })
    global.state_event.on('apiSourceUpdated', handleApiUpdate)
    return requestPromise
  }
  const handleUserApiResponse = ({ status, result, requestKey, errorMessage }: ResponseParams) => {
    const target = userApiRequestMap.get(requestKey)
    if (!target) return
    userApiRequestMap.delete(requestKey)
    BackgroundTimer.clearTimeout(target.timeout)
    if (status) target.resolve(result)
    else target.reject(new Error(errorMessage ?? 'failed'))
  }
  const handleStateChange = ({ status, errorMessage, info }: InitParams) => {
    // console.log(status, message, info)
    setUserApiStatus(status, errorMessage)
    if (!info || info.id !== settingState.setting['common.apiSource']) return
    if (status) {
      if (info.sources) {
        let apis: any = {}
        let qualitys: LX.QualityList = {}
        for (const [source, { actions, type, qualitys: sourceQualitys }] of Object.entries(
          info.sources ?? {},
        )) {
          if (type != 'music') continue
          apis[source as LX.Source] = {}
          for (const action of actions) {
            switch (action) {
              case 'musicUrl':
                apis[source].getMusicUrl = (songInfo: LX.Music.MusicInfo, type: LX.Quality) => {
                  const requestKey = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      // userApiRequestCancel(requestKey)
                    },
                    promise: sendUserApiRequest({
                      requestKey,
                      data: {
                        source,
                        action: 'musicUrl',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                    })
                      .then(async(res) => {
                        const payload = res?.data
                        // 兼容两种常见返回：data 直接是 URL 字符串，或 { url, ... }
                        const url = typeof payload === 'string'
                          ? payload
                          : (typeof payload?.url === 'string' ? payload.url : '')
                        // 档位只由「请求档 + 容器格式」决定，源回传的 quality/type 一律不采信
                        let actualQuality: LX.Quality = type

                        // URL 带 .flac/.mp3/.m4a 扩展名时按扩展名判定（不再 HEAD）；
                        // 未知扩展名才 HEAD 一次做容器兜底。
                        if (url) {
                          if (/\.(flac|mp3|m4a|aac)(\?|#|$)/i.test(url)) {
                            actualQuality = getActualQualityByFormat(url, '', actualQuality)
                          } else {
                            try {
                              const headResponse = await fetch(url, { method: 'HEAD' })
                              actualQuality = getActualQualityByFormat(url, headResponse.headers.get('content-type') || '', actualQuality)
                            } catch {
                              actualQuality = getActualQualityByFormat(url, '', actualQuality)
                            }
                          }
                        }

                        // 空 URL 当失败处理：否则天梯会把这一档标成成功，播放器拿到空串又报错
                        if (!url) throw new Error('empty music url')
                        return { type: actualQuality, url }
                      })
                      .catch((err) => {
                        console.log(err.message)
                        throw err
                      }),
                  }
                }
                break
              case 'lyric':
                apis[source].getLyric = (songInfo: LX.Music.MusicInfo) => {
                  const requestKey = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      // userApiRequestCancel(requestKey)
                    },
                    promise: sendUserApiRequest({
                      requestKey,
                      data: {
                        source,
                        action: 'lyric',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                    })
                      .then((res) => {
                        // console.log(res)
                        return res.data
                      })
                      .catch(async(err) => {
                        console.log(err.message)
                        return Promise.reject(err)
                      }),
                  }
                }
                break
              case 'pic':
                apis[source].getPic = (songInfo: LX.Music.MusicInfo) => {
                  const requestKey = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      // userApiRequestCancel(requestKey)
                    },
                    promise: sendUserApiRequest({
                      requestKey,
                      data: {
                        source,
                        action: 'pic',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                    })
                      .then((res) => {
                        // console.log(res)
                        return res.data
                      })
                      .catch(async(err) => {
                        console.log(err.message)
                        return Promise.reject(err)
                      }),
                  }
                }
                break
              default:
                break
            }
          }
          qualitys[source as LX.Source] = sourceQualitys
        }
        global.lx.qualityList = qualitys
        global.lx.apis = apis
        global.state_event.apiSourceUpdated(settingState.setting['common.apiSource'])
      }
    } else {
      if (errorMessage) {
        void tipDialog({
          message: `${global.i18n.t('user_api__init_failed_alert', { name: info.name })}\n${errorMessage}`,
          // selection: true,
          btnText: global.i18n.t('ok'),
        })
      }
    }
    if (!global.lx.apiInitPromise[1]) global.lx.apiInitPromise[2](status)
  }
  const showUpdateAlert = ({ name, log, updateUrl }: UpdateInfoParams) => {
    if (!name && !log) return
    const message = `${global.i18n.t('user_api_update_alert', { name: name || '' })}\n${log || ''}`.trim()
    if (!message) return
    if (updateUrl) {
      void confirmDialog({
        message,
        confirmButtonText: global.i18n.t('user_api_update_alert_open_url'),
        cancelButtonText: global.i18n.t('close'),
      }).then((confirm) => {
        if (!confirm) return
        setTimeout(() => {
          void openUrl(updateUrl)
        }, 300)
      })
    } else {
      void tipDialog({
        message,
        btnText: global.i18n.t('ok'),
      })
    }
  }

  onScriptAction((event) => {
    // console.log('script actuon: ', event)
    switch (event.action) {
      case 'init':
        if ((event as unknown as { errorMessage?: string }).errorMessage) { event.data.errorMessage = (event as unknown as { errorMessage: string }).errorMessage }
        handleStateChange(event.data)
        break
      case 'response':
        handleUserApiResponse(event.data)
        break
      case 'request':
        sendScriptRequest(event.data.requestKey, event.data.url, event.data.options)
        break
      case 'cancelRequest':
        cancelRequest(event.data, 'request canceled')
        break
      case 'showUpdateAlert':
        showUpdateAlert(event.data)
        break
      case 'log':
        switch ((event as unknown as { type: keyof typeof log }).type) {
          case 'log':
          case 'info':
            log.info((event as unknown as { log: string }).log)
            break
          case 'error':
            log.error((event as unknown as { log: string }).log)
            break
          case 'warn':
            log.warn((event as unknown as { log: string }).log)
            break
          default:
            break
        }
        break
      default:
        break
    }
  })

  setUserApiList(await getUserApiList())
}
