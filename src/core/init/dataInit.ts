// import { getPlayInfo } from '@/utils/data'
// import { log } from '@/utils/log'
import { init as musicSdkInit } from '@/utils/musicSdk'
import { getUserLists, setUserList } from '@/core/list'
import { cleanOneDriveDirtyData } from '@/utils/data'
import { bootLog } from '@/utils/bootLog'
import { getDislikeInfo, setDislikeInfo } from '@/core/dislikeList'
import { unlink } from '@/utils/fs'
import { TEMP_FILE_PATH } from '@/utils/tools'
import wyUserApi from '@/utils/musicSdk/wy/user'
import txUserApi from '@/utils/musicSdk/tx/user'
import { getUserPlaylists as getKgUserPlaylists } from '@/utils/musicSdk/kg/utils/api'
import {
  setWyFollowedArtists,
  setWyLikedSongs,
  setWySubscribedAlbums,
  setWySubscribedPlaylists,
  setWyUid,
  setTxLikedSongs,
  setTxSubscribedPlaylists,
  setKgSubscribedPlaylists,
  setKgLikedSongs,
} from '@/store/user/action.ts'
import { getDownloadTasks } from '@/utils/data/download.ts'
import downloadActions from '@/store/download/action'
import { withTimeout } from '@/utils/withTimeout'
import settingState from '@/store/setting/state'

const withInitTimeout = async <T,>(promise: Promise<T>, label: string, fallback: T): Promise<T> =>
  withTimeout(promise, label, fallback)

/**
 * 启动时设置里的 cookie 为空时补跑一次初始化（B-5「该运行未运行的模块」）：
 * - 先读 store 当前值：initSetting 若其实已就绪（只是 withTimeout 3 秒兜底让我们
 *   拿到了 defaultSetting 的旧引用），立即补跑；
 * - 否则订阅 configUpdated，等 cookie 第一次变为非空时补跑，跑完即退订，只跑一次。
 * 为什么需要：init/index.ts 用 withTimeout(initSetting(), 'Setting', defaultSetting)
 * 兜底时，dataInit 收到的 appSetting 里 cookie 恒为空；只判断这份捕获值会让
 * wy/tx/kg 的用户数据初始化在整个启动周期被静默跳过。
 * 为什么要先读 store：dataInit 前面还有多个 await（user list / dislike / download
 * tasks 各带 3 秒兜底），可能晚于 configUpdated 的广播才开始执行，只订阅会漏事件。
 */
const initUserDataWhenCookieReady = (
  key: 'common.wy_cookie' | 'common.tx_cookie' | 'common.kg_cookie',
  init: (cookie: string) => void,
) => {
  const current = settingState.setting[key]
  if (current) {
    init(current)
    return
  }
  const handleConfigUpdated: typeof global.state_event.configUpdated = (keys) => {
    const cookie = settingState.setting[key]
    if (!keys.includes(key) || !cookie) return
    global.state_event.off('configUpdated', handleConfigUpdated)
    init(cookie)
  }
  global.state_event.on('configUpdated', handleConfigUpdated)
}

export default async(appSetting: LX.AppSetting) => {
  void musicSdkInit()
  bootLog('User list init...')
  const userLists = await withInitTimeout(getUserLists(), 'User list', [])
  bootLog('User list data loaded.')
  setUserList(userLists)
  bootLog('User list state set.')
  const dislikeInfo = await withInitTimeout(getDislikeInfo(), 'Dislike info', {
    names: new Set<string>(),
    musicNames: new Set<string>(),
    singerNames: new Set<string>(),
    rules: '',
  })
  bootLog('Dislike info data loaded.')
  setDislikeInfo(dislikeInfo)
  bootLog('User list inited.')

  void cleanOneDriveDirtyData().then(() => { bootLog('OneDrive dirty data cleaned.') }).catch((err) => { bootLog(`OneDrive dirty data clean failed: ${err?.message ?? err}`) })


  bootLog('Download tasks init...')
  const savedTasks = await withInitTimeout(getDownloadTasks(), 'Download tasks', [])
  bootLog('Download task data loaded.')
  downloadActions.setTasks(savedTasks)
  bootLog('Download tasks inited.')

  const initWyUserData = (wy_cookie: string) => {
    bootLog('Wy like list init...')
    wyUserApi.getUid(wy_cookie)
      .then((uid: any) => {
        setWyUid(uid)
        wyUserApi.getLikedSongList(uid, wy_cookie).then((ids: any) => {
          setWyLikedSongs(ids)
          bootLog('Wy like list inited.')
        })
        wyUserApi.getAllSublist().then(artists => {
          setWyFollowedArtists(artists)
          bootLog('Wy followed artists inited.')
        }).catch(err => {
          bootLog(`Wy followed artists init failed: ${err.message}`)
        })
        wyUserApi.getAllSubAlbumList().then(albums => {
          setWySubscribedAlbums(albums)
          bootLog('Wy liked albums inited.')
        }).catch(err => {
          bootLog(`Wy liked albums init failed: ${err.message}`)
        })
        wyUserApi.getUserPlaylists(uid, wy_cookie).then((playlists: any) => {
          setWySubscribedPlaylists(playlists)
          bootLog('Wy subscribed playlists inited.')
        }).catch((err: any) => {
          bootLog(`Wy subscribed playlists init failed: ${err.message}`)
        })
      })
      .catch((err: any) => {
        bootLog(`Wy like list init failed: ${err.message}`)
      })
  }

  const wy_cookie = appSetting['common.wy_cookie']
  if (wy_cookie) {
    initWyUserData(wy_cookie)
  } else {
    initUserDataWhenCookieReady('common.wy_cookie', initWyUserData)
  }

  const initTxUserData = () => {
    bootLog('Tx like list init...')
    ;(async() => {
      try {
        const allLikedMids: string[] = []
        let page = 1
        const pageSize = 100
        let hasMore = true

        while (hasMore) {
          const result = await txUserApi.getFavSongs(page, pageSize)
          if (result.list && result.list.length > 0) {
            allLikedMids.push(...result.list.map((song: any) => song.mid))
          }
          hasMore = result.hasMore
          page++
        }

        setTxLikedSongs(allLikedMids)
        bootLog(`Tx like list inited. (${allLikedMids.length} songs)`)
      } catch (err: any) {
        bootLog(`Tx like list init failed: ${err.message}`)
      }
    })()

    bootLog('Tx playlists init...')
    txUserApi.getUserPlaylists().then(playlists => {
      const formattedPlaylists = playlists.map((p: any) => ({
        id: `tx__${p.id}`,
        name: p.name,
        cover: p.cover,
        songCount: p.songCount,
        creator: { nickname: 'QQ音乐' },
        dirid: p.dirid,
        tid: p.tid,
        desc: p.desc,
        isFavorites: p.isFavorites,
        isCollected: p.isCollected,
      }))
      setTxSubscribedPlaylists(formattedPlaylists)
      bootLog('Tx playlists inited.')
    }).catch(err => {
      bootLog(`Tx playlists init failed: ${err.message}`)
    })
  }

  const tx_cookie = appSetting['common.tx_cookie']
  if (tx_cookie) {
    initTxUserData()
  } else {
    initUserDataWhenCookieReady('common.tx_cookie', () => { initTxUserData() })
  }

  const initKgUserData = (kg_cookie: string) => {
    bootLog('Kg playlists init...')
    getKgUserPlaylists(kg_cookie).then(async result => {
      if (result.success && result.data) {
        const allPlaylists = [...(result.data.createdList || []), ...(result.data.collectedList || [])]
        const formattedPlaylists = allPlaylists.map((p: any) => ({
          id: p.id || `kg_${p.listid}`,
          listid: p.listid,
          name: p.name,
          cover: p.cover,
          songCount: p.songCount,
          desc: p.desc,
          isCollected: p.isCollected || false,
        }))
        setKgSubscribedPlaylists(formattedPlaylists)
        bootLog('Kg playlists inited.')

        const favoritesPlaylist = result.data.createdList.find((p: any) => p.isFavorites)
        if (favoritesPlaylist) {
          bootLog('Kg like list init...')
          try {
            const { getPlaylistSongs } = await import('@/utils/musicSdk/kg/utils/api')
            const allLikedIds: string[] = []
            let page = 1
            const pageSize = 500
            let hasMore = true

            while (hasMore) {
              const songsResult = await getPlaylistSongs(kg_cookie, favoritesPlaylist.id, page, pageSize)
              if (songsResult.success && songsResult.data?.list?.length) {
                for (const song of songsResult.data.list) {
                  const songId = song.hash || song.songmid || song.audio_id
                  if (songId) {
                    allLikedIds.push(String(songId))
                  }
                }
                hasMore = songsResult.data.list.length === pageSize
                page++
              } else {
                hasMore = false
              }
            }

            setKgLikedSongs(allLikedIds)
            bootLog(`Kg like list inited. (${allLikedIds.length} songs)`)
          } catch (err: any) {
            bootLog(`Kg like list init failed: ${err.message}`)
          }
        }
      }
    }).catch(err => {
      bootLog(`Kg playlists init failed: ${err.message}`)
    })
  }

  const kg_cookie = appSetting['common.kg_cookie']
  if (kg_cookie) {
    initKgUserData(kg_cookie)
  } else {
    initUserDataWhenCookieReady('common.kg_cookie', initKgUserData)
  }

  // 「退出前所在界面」的恢复已前移到 core/init/index.ts 的 init()（见 core/viewRestore.ts）：
  // 放在本函数末尾时，前面任一 await 的 reject 都会让这条 fire-and-forget 链整条中断，
  // 恢复语句永远执行不到；而且执行时机晚于 Home 挂载，存在 navActiveIdUpdated 事件漏接竞态。
  void unlink(TEMP_FILE_PATH)
}
