import playerState from '@/store/player/state'
import { prefetch } from '@/components/common/ImageBackground'
import { setBgPic, updateSetting } from '@/core/common'
import wyUserApi from '@/utils/musicSdk/wy/user'
import txUserApi from '@/utils/musicSdk/tx/user'
import { setWyFollowedArtists, setWyLikedSongs, setWySubscribedAlbums, setWyUid, setTxLikedSongs, setKgLikedSongs } from '@/store/user/action'
import { getUserPlaylists, getPlaylistSongs } from '@/utils/musicSdk/kg/utils/api'
import { toast } from '@/utils/tools'
import { searchLog } from '@/utils/searchLog'
import { playerLog } from '@/utils/playerLog'

const formatUri = <T extends string | null>(url: T) => {
  return typeof url == 'string' && url.startsWith('/') ? `file://${url}` : url
}

export default async(setting: LX.AppSetting) => {
  let pic = playerState.musicInfo.pic
  let isDynamicBg = setting['theme.dynamicBg']
  const handleUpdatePic = (pic: string) => {
    if (!pic) return
    const picUrl = formatUri(pic)
    void prefetch(picUrl).then(() => {
      if (pic != playerState.musicInfo.pic || !isDynamicBg) return
      setBgPic(picUrl)
      // 持久化最近一次动态背景，冷启动时先同步恢复，避免白屏闪烁
      updateSetting({ 'theme.lastDynamicBgPic': picUrl })
    })
  }
  // 冷启动：先立即恢复上次的动态背景（免预取等待），预取完成后再无缝升级为当前封面
  const lastBgPic = formatUri(setting['theme.lastDynamicBgPic'] as string | null)
  if (isDynamicBg && lastBgPic) setBgPic(lastBgPic)
  const handlePicUpdate = () => {
    if (playerState.musicInfo.pic && playerState.musicInfo.pic != playerState.loadErrorPicUrl) {
      pic = playerState.musicInfo.pic
      if (!isDynamicBg) return
      handleUpdatePic(pic)
    }
  }
  const handleConfigUpdate = (
    keys: Array<keyof LX.AppSetting>,
    setting: Partial<LX.AppSetting>,
  ) => {
    if (!keys.includes('theme.dynamicBg')) return
    isDynamicBg = setting['theme.dynamicBg']!
    if (isDynamicBg) {
      if (pic) handleUpdatePic(pic)
    } else {
      setBgPic(null)
      updateSetting({ 'theme.lastDynamicBgPic': '' })
    }
  }

  const handleWyCookieUpdate = (keys: Array<keyof LX.AppSetting>, setting: Partial<LX.AppSetting>) => {
    if (!keys.includes('common.wy_cookie')) return
    const cookie = setting['common.wy_cookie']
    if (cookie) {
      console.log('正在刷新网易云数据...')
      wyUserApi.getUid(cookie)
        .then(async(uid: any) => {
          // 必须同步设置 UID，否则依赖 useWyUid 的「我的歌单」页面在 cookie 更新后
          // 因 uid 为空而不会触发歌单加载（iPad 常驻/预挂载场景尤其明显）。
          setWyUid(uid)
          return Promise.all([
            wyUserApi.getLikedSongList(uid, cookie),
            wyUserApi.getAllSublist(),
            wyUserApi.getAllSubAlbumList(),
          ])
        })
        .then(([likedIds, followedArtists, subscribedAlbums]: any[]) => {
          setWyLikedSongs(likedIds)
          setWyFollowedArtists(followedArtists)
          setWySubscribedAlbums(subscribedAlbums)
        })
        .catch((err: any) => {
          toast(`网易云数据获取失败: ${err.message}`)
        })
    } else {
      console.log('网易云 cookie 已清除')
    }
  }

  const handleTxCookieUpdate = async(keys: Array<keyof LX.AppSetting>, setting: Partial<LX.AppSetting>) => {
    if (!keys.includes('common.tx_cookie')) return
    const cookie = setting['common.tx_cookie']
    if (cookie) {
      console.log('正在刷新QQ音乐数据...')
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
        console.log(`QQ音乐喜欢歌曲加载成功，共 ${allLikedMids.length} 首`)
      } catch (err: any) {
        toast(`QQ音乐数据获取失败: ${err.message}`)
      }
    } else {
      setTxLikedSongs([])
    }
  }

  const handleKgCookieUpdate = async(keys: Array<keyof LX.AppSetting>, setting: Partial<LX.AppSetting>) => {
    if (!keys.includes('common.kg_cookie')) return
    const cookie = setting['common.kg_cookie']
    if (cookie) {
      console.log('正在刷新酷狗音乐数据...')
      try {
        const playlistsResult = await getUserPlaylists(cookie)
        if (!playlistsResult.success || !playlistsResult.data) {
          console.log('酷狗歌单获取失败')
          return
        }

        const favoritesPlaylist = playlistsResult.data.createdList.find((p: any) => p.isFavorites)
        if (!favoritesPlaylist) {
          console.log('未找到酷狗"我喜欢"歌单')
          setKgLikedSongs([])
          return
        }

        const allLikedIds: string[] = []
        let page = 1
        const pageSize = 500
        let hasMore = true

        while (hasMore) {
          const songsResult = await getPlaylistSongs(cookie, favoritesPlaylist.id, page, pageSize)
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
        console.log(`酷狗喜欢歌曲加载成功，共 ${allLikedIds.length} 首`)
      } catch (err: any) {
        toast(`酷狗数据获取失败: ${err.message}`)
      }
    } else {
      setKgLikedSongs([])
    }
  }

  // 日志开关同步（用户第 7 条 (1) 的修复中心）。
  // `global.lx` 上的这三个 + 搜索 / 播放器日志模块的 isEnabled 是**两套状态**：
  //   · 记录日志 / 记录同步日志 / 记录自定义源日志 → global.lx.*（下游 plugins/sync/log、
  //     core/userApi、core/webdavMusic/logger 直读 global）；
  //   · 启用搜索日志 / 启用播放器日志 → searchLog.isEnabled / playerLog.isEnabled
  //     （下游 searchLog.* / playerLog.* 自己判），此前**只在设置页里 updateEnabled**，
  //     冷启动没有任何调用点，于是恒为 false —— 设置页显示已开启，实际一条都不写；
  //     两个模块里的 init() 也从未被调用过。
  // 现在两条链路都收进这一个函数，设置页改动 + 冷启动首同步走的是同一条代码。
  const handleLogSettingUpdate = (keys: Array<keyof LX.AppSetting>, setting: Partial<LX.AppSetting>) => {
    if (keys.includes('common.isEnableLog')) {
      global.lx.isEnableLog = setting['common.isEnableLog'] ?? global.lx.isEnableLog
    }
    if (keys.includes('common.isEnableSyncLog')) {
      global.lx.isEnableSyncLog = setting['common.isEnableSyncLog'] ?? global.lx.isEnableSyncLog
    }
    if (keys.includes('common.isEnableUserApiLog')) {
      global.lx.isEnableUserApiLog = setting['common.isEnableUserApiLog'] ?? global.lx.isEnableUserApiLog
    }
    // 直接写显式值而不是调 searchLog.init() / playerLog.init()：那两个 init 从
    // settingState 读，而冷启动这次同步发生在设置 state 之外的时序里，传值更可靠。
    if (keys.includes('common.isEnableSearchLog')) {
      searchLog.updateEnabled(setting['common.isEnableSearchLog'] ?? false)
    }
    if (keys.includes('common.isEnablePlayerLog')) {
      playerLog.updateEnabled(setting['common.isEnablePlayerLog'] ?? false)
    }
  }

  // 冷启动首同步（用户第 7 条 (1)）：init/index.ts 里 initSetting()（会广播
  // configUpdated）跑在 initCommonState()（注册监听）**之前**，首次配置广播因此永远
  // 被漏掉 —— global.lx 的三个开关恒为 globalData.ts 的硬编码默认值
  // （isEnableLog=true，其余 false）。表现为「关掉『记录日志』重启后仍在记录 /
  // 打开的子开关不记录 / 打开搜索·播放器日志重启后失效」。
  // 这里用**包含全部日志开关的完整键集**手工补一次同步。
  // （WebDAV / 同步 / 自定义源日志本就是调用时直读设置或 global，无需额外处理。）
  const ALL_LOG_SETTING_KEYS: Array<keyof LX.AppSetting> = [
    'common.isEnableLog',
    'common.isEnableSyncLog',
    'common.isEnableUserApiLog',
    'common.isEnableSearchLog',
    'common.isEnablePlayerLog',
  ]

  handlePicUpdate()
  global.state_event.on('playerMusicInfoChanged', handlePicUpdate)
  global.state_event.on('configUpdated', handleConfigUpdate)
  global.state_event.on('configUpdated', handleWyCookieUpdate)
  global.state_event.on('configUpdated', handleTxCookieUpdate)
  global.state_event.on('configUpdated', handleKgCookieUpdate)
  global.state_event.on('configUpdated', handleLogSettingUpdate)
  // 冷启动补一次日志开关同步（见上方 ALL_LOG_SETTING_KEYS 的说明：
  // initSetting 的首次广播早于本监听注册）。必须在 on(...) 之后，
  // 这样同一份配置之后继续走监听这条常规路径。
  handleLogSettingUpdate(ALL_LOG_SETTING_KEYS, setting)
}
