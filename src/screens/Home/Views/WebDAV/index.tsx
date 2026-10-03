import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  Keyboard,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
  type ListRenderItem,
} from 'react-native'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import { SvgIcon } from '@/components/common/SvgIcon'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
// 【第 25 轮】列表封面改为**逐行按需**（与其他歌曲列表同一套：core/music/coverUrl.ts 的
// 缓存 + 并发上限队列）。此前本页在「进列表 / 扫描完 / 播放后」对全部歌曲跑一遍
// fetchWebDAVPic 批量下载（4 worker 扫全表，325 首就是 325 次请求），且只认网盘内封面文件，
// 不做在线匹配 —— 网盘里没有封面文件时列表永远是无封面占位（用户截图）。
import useCoverUrl from '@/utils/hooks/useCoverUrl'
// 【第 27 轮】扫描/刷新/进列表后主动预热封面：走的仍是同一套 fetchCoverUrl（内存缓存 +
// coverCache 上限 4 并发的全局队列），只是不等行渲染。见本文件 prefetchCovers。
import { fetchCoverUrl, getCachedCoverUrl } from '@/core/music/coverUrl'
import { useButtonRadius } from '@/utils/buttonRadius'
import { confirmDialog, createStyle, toast, getRowInfo } from '@/utils/tools'
import { LIST_ITEM_HEIGHT } from '@/config/constant'
import { scaleSizeH } from '@/utils/pixelRatio'
import { stageOnlineListToDefault } from '@/core/playListToDefault'
import { addTempPlayList } from '@/core/player/tempPlayList'
import { useHorizontalMode } from '@/utils/hooks'
import { usePlayMusicInfo } from '@/store/player/hook'
import playerState from '@/store/player/state'
import {
  getWebDAVConfig,
  listWebDAVFolders,
  saveWebDAVFilterPath,
  saveWebDAVSelectedFolder,
  scanWebDAVSongs,
  updateWebDAVMusicMeta,
} from '@/core/webdavMusic/drive'
import settingState from '@/store/setting/state'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { songRowMetrics, songRowStyles } from '@/components/common/songRowStyles'
import { useBottomOverlayInset } from '@/store/common/hook'
import PageTopInset from '@/components/common/PageTopInset'
import DetailPageTitle from '@/components/common/DetailPageTitle'
import PillTabs from '@/components/common/PillTabs'
import SwipeBackArea from '@/components/common/SwipeBackArea'
import { setNavActiveId } from '@/core/common'
import { useI18n } from '@/lang'
import WebDAVListMenu, { type WebDAVListMenuType, type SelectInfo as WebDAVSelectInfo } from './WebDAVListMenu'
import WebDAVDownloadPath from './components/WebDAVDownloadPath'
import MetadataEditModal from '@/components/MetadataEditModal'
import {
  handleWebDAVDownload,
  handleFetchWebDAVPicFromOnline,
  handleWebDAVRemove,
  handleWebDAVDownloadAndImport,
} from './WebDAVListAction'
import { readMetadata, readPic } from '@/utils/localMediaMetadata'

type ActiveTab = 'config' | 'list' | 'folders'
const ITEM_HEIGHT = scaleSizeH(LIST_ITEM_HEIGHT)

const formatTime = (time?: number) => {
  if (!time) return ''
  return new Date(time).toLocaleString()
}

const formatBriefTime = (time?: number) => {
  if (!time) return ''
  const date = new Date(time)
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const formatSize = (size?: number) => {
  if (!size) return ''
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

const getFolderName = (folder?: LX.WebDAV.DriveFolder | null) => folder?.path || 'WebDAV 根目录'

// 【第 27 轮】扫描/刷新/进列表后自动预热在线封面的条数上限（见组件里的 prefetchCovers）。
// 每次最多补这么多首：首屏那几首先出图，剩下的滚到哪行由行内 useCoverUrl 逐行补，
// 不会因为曲库有几百首就一次性打出几百个在线匹配请求。
const MAX_PREFETCH_COVERS = 20

const SongItem = memo(
  ({
    item,
    index,
    isPlaying,
    rowWidth = '100%',
    onPress,
    onShowMenu,
  }: {
    item: LX.WebDAV.MusicInfo
    index: number
    isPlaying: boolean
    /** 横屏多列时每列宽度（如 '50%'），竖屏为 '100%' */
    rowWidth?: `${number}%`
    onPress: (musicInfo: LX.WebDAV.MusicInfo) => void
    onShowMenu: (
      item: LX.WebDAV.MusicInfo,
      index: number,
      position: { x: number, y: number, w: number, h: number }
    ) => void
  }) => {
    const theme = useTheme()
    const buttonOpacity = useSettingValue('theme.buttonOpacity')
    // 「按钮圆角」：封面与图标按钮的行内覆盖（静态 borderRadius 原样保留作兜底）
    const buttonRadius = useButtonRadius()
    // 行封面：meta.picUrl 优先，为空时按需动态获取（网盘内同名封面 → 本地缓存 → 已下载文件的
    // 内嵌封面 → 在线匹配），结果带缓存与并发上限。只有渲染出来的行才会触发，不再全表扫。
    const coverUrl = useCoverUrl(item)
    const moreButtonRef = useRef<TouchableOpacity>(null)
    const subText = item.singer || item.meta.filePath
    const sizeText = formatSize(item.meta.size)
    const timeText = formatBriefTime(item.meta.lastModifiedTime)
    const detailText = [sizeText, timeText].filter(Boolean).join(' · ')

    const handleShowMenu = () => {
      if (moreButtonRef.current?.measure) {
        moreButtonRef.current.measure((fx, fy, width, height, px, py) => {
          onShowMenu(item, index, {
            x: Math.ceil(px),
            y: Math.ceil(py),
            w: Math.ceil(width),
            h: Math.ceil(height),
          })
        })
      }
    }

    return (
      <View
        style={{
          ...styles.songItem,
          width: rowWidth,
          // 【第 25 轮】卡片底色与边框**任何状态**都受「按钮透明度」控制。
          // 此前只有播放中的那一行套了 applyOpacity，未播放行用的是不透明的
          // theme['c-content-background'] —— 于是同一个列表里只有正在播的那张卡片是半透明的
          // （用户：WebDAV 的歌曲栏背景透明度没有受到控制，点击播放后才有透明度）。
          // 只改颜色 alpha，不用容器 style.opacity：否则文字与图标会跟着一起淡。
          backgroundColor: applyOpacity(
            isPlaying ? theme['c-primary-background-hover'] : theme['c-content-background'],
            buttonOpacity,
          ),
          borderColor: applyOpacity(
            isPlaying ? theme['c-primary-background-active'] : theme['c-border-background'],
            buttonOpacity,
          ),
        }}
      >
        <TouchableOpacity style={styles.songItemLeft} onPress={() => { onPress(item) }}>
          {/* 【第 24 轮】行内几何全部取 components/common/songRowStyles.ts：
              封面盒、标题字重/字号、副标题字号、⋮ 按钮都与其他歌曲列表同源（此前是本文件私有的一份） */}
          <View style={songRowStyles.sn}>
            {coverUrl ? (
              <Image
                url={coverUrl}
                style={[
                  songRowStyles.albumArt,
                  // 歌曲封面 54×54：按自身高度折算半高，行内覆盖「按钮圆角」
                  { borderRadius: buttonRadius(songRowMetrics.coverSize) },
                ]}
                cache={false}
              />
            ) : (
              <View
                style={[
                  styles.albumArtPlaceholder,
                  // 无封面占位与封面同尺寸 54×54，同口径行内覆盖「按钮圆角」
                  { borderRadius: buttonRadius(songRowMetrics.coverSize) },
                ]}
              />
            )}
          </View>
          <View style={songRowStyles.itemInfo}>
            <Text
              size={designTypography.body}
              style={songRowStyles.songName}
              color={isPlaying ? theme['c-primary-font'] : theme['c-font']}
              numberOfLines={1}
            >
              {item.name || item.meta.fileName}
            </Text>
            <View style={songRowStyles.listItemSingle}>
              <Text
                style={songRowStyles.listItemSingleText}
                size={songRowMetrics.metaTextSize}
                color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
                numberOfLines={1}
              >
                {subText}
              </Text>
            </View>
            {detailText ? (
              <Text
                size={songRowMetrics.metaTextSize}
                color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
                numberOfLines={1}
              >
                {detailText}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleShowMenu}
          ref={moreButtonRef}
          style={[
            songRowStyles.moreButton,
            // 图标按钮 40×40：与其他歌曲列表同一几何（此前 height:'80%' + padding 12，⋮ 落在别的 x 上）
            { borderRadius: buttonRadius(songRowMetrics.iconButtonSize) },
          ]}
        >
          <Icon name="dots-vertical" style={{ color: theme['c-350'] }} size={songRowMetrics.iconSize} />
        </TouchableOpacity>
      </View>
    )
  },
)

export default memo(() => {
  const theme = useTheme()
  const t = useI18n()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  // 「按钮圆角」：配置页按钮、搜索输入框与图标按钮的行内覆盖（静态 borderRadius 原样保留作兜底）
  const buttonRadius = useButtonRadius()
  const playMusicInfo = usePlayMusicInfo()
  const [activeTab, setActiveTab] = useState<ActiveTab>('list')
  const [loading, setLoading] = useState(false)
  // 下拉刷新动画只认「用户真的下拉过」（用户第 16 轮第 7 条）。
  // loading 是「忙」的共用开关：handleScan（扫描）、handleSelectCurrentFolder（选择目录）
  // 也会置位，它同时还要禁用扫描/批量按钮。旧写法 refreshing={loading} 意味着扫描一开始
  // 刷新控件就被激活——列表被压下去再弹回来（「向上刷新」）。refreshing 只由 handleRefresh
  // （用户下拉）置位，程序触发的加载一律不碰它。
  const [refreshing, setRefreshing] = useState(false)
  const [folderStack, setFolderStack] = useState<LX.WebDAV.DriveFolder[]>([])
  const [folders, setFolders] = useState<LX.WebDAV.DriveFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState<LX.WebDAV.DriveFolder | null>(null)
  const [songs, setSongs] = useState<LX.WebDAV.MusicInfo[]>([])
  const [scannedAt, setScannedAt] = useState<number | undefined>()
  const [filterPath, setFilterPath] = useState<string | null>(null)
  const [folderLoading, setFolderLoading] = useState(false)
  const [scanText, setScanText] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [batchLoadingText, setBatchLoadingText] = useState('')
  const listRef = useRef<FlatList<LX.WebDAV.MusicInfo>>(null)
  const searchInputRef = useRef<TextInput>(null)
  const pendingJumpIdRef = useRef<string | null>(null)
  const webDAVListMenuRef = useRef<WebDAVListMenuType>(null)
  const metadataEditTypeRef = useRef<any>(null)
  const selectedMusicInfoRef = useRef<LX.WebDAV.MusicInfo | null>(null)

  const currentFolder = folderStack.at(-1) ?? null

  const hasConfig = useMemo(() => {
    const settings = settingState.setting
    return !!(settings['sync.webdav.url'] && settings['sync.webdav.username'])
  }, [])

  const filteredSongs = useMemo(() => {
    let list = songs
    if (filterPath) {
      list = list.filter(song => {
        const path = song.meta.remotePath
        if (!path) return false
        const lastSlashIndex = path.lastIndexOf('/')
        const folderPath = path.substring(0, lastSlashIndex) || '/'
        return folderPath === filterPath
      })
    }
    const text = searchText.trim().toLowerCase()
    if (!text) return list
    return list.filter((item) => {
      return [
        item.name,
        item.singer,
        item.meta.fileName,
        item.meta.filePath,
      ].some(value => (value ?? '').toLowerCase().includes(text))
    })
  }, [searchText, songs, filterPath])

  const songFolders = useMemo(() => {
    const foldersMap = new Map<string, { name: string, path: string, count: number }>()
    songs.forEach(song => {
      const path = song.meta.remotePath
      if (!path) return
      const lastSlashIndex = path.lastIndexOf('/')
      if (lastSlashIndex === -1) return
      const folderPath = path.substring(0, lastSlashIndex) || '/'
      const folderName = folderPath === '/' ? '根目录' : (folderPath.split('/').pop() || '未知目录')

      const existing = foldersMap.get(folderPath)
      if (existing) {
        existing.count++
      } else {
        foldersMap.set(folderPath, { name: folderName, path: folderPath, count: 1 })
      }
    })
    return Array.from(foldersMap.values()).sort((a, b) => a.path.localeCompare(b.path))
  }, [songs])

  // 【第 27 轮】扫描 / 刷新 / 进列表后自动补充在线封面。
  //
  // 为什么还要这一层：列表行本身有 useCoverUrl 逐行按需补（第 25 轮），但那只覆盖"已经渲染出来
  // 的那几行"，而且首屏渲染那一瞬间就得等在线匹配（findMusic 跨平台搜索 + getPic）才出图。
  // 这里在拿到曲库列表时按列表顺序提前把前 MAX_PREFETCH_COVERS 首没有封面的歌丢给同一套
  // fetchCoverUrl（同一个 4 并发全局队列 + 同一份内存缓存，命中在飞的请求不会重复发），
  // 于是首屏那几首的请求在渲染前就已经在路上了，滚下去的歌仍旧由行内 useCoverUrl 补。
  //
  // 三重收口，避免扫描完 325 首就打出 325 个在线匹配：
  //   ① MAX_PREFETCH_COVERS 上限；
  //   ② 已经有 meta.picUrl（第 25 轮写回已落盘的）或内存缓存里已有封面的直接跳过；
  //   ③ prefetchedCoverIds 记住本次会话已经试过的歌曲 id，扫描/刷新/进列表来回切也不会重复补。
  const prefetchedCoverIds = useRef(new Set<string>())
  const prefetchCovers = useCallback((list: LX.WebDAV.MusicInfo[]) => {
    let started = 0
    for (const song of list) {
      if (started >= MAX_PREFETCH_COVERS) break
      if (!song?.id || !song.meta) continue
      if (song.meta.picUrl) continue
      if (prefetchedCoverIds.current.has(song.id)) continue
      prefetchedCoverIds.current.add(song.id)
      if (getCachedCoverUrl(song)) continue
      started++
      // fetchCoverUrl 内部已 catch（失败返回空串），这里再把拿到手的封面推回列表状态：
      // 即使 meta 落盘那一步失败（updateWebDAVMusicMeta 抛错时不会广播 webdavPicUpdated），
      // 已经渲染出来的行也能立刻换图。
      void fetchCoverUrl(song).then(url => {
        if (!url) return
        setSongs(prevSongs => prevSongs.map(item =>
          item.id === song.id
            ? { ...item, meta: { ...item.meta, picUrl: url } }
            : item,
        ))
      })
    }
  }, [])

  const loadConfig = useCallback(async() => {
    return getWebDAVConfig().then(config => {
      setSelectedFolder(config.selectedFolder ?? null)
      const songs = config.songs ?? []
      setSongs(songs)
      setScannedAt(config.scannedAt)
      setFilterPath(config.filterPath ?? null)
      prefetchCovers(songs)
    })
  }, [prefetchCovers])

  const handleSetFilterPath = useCallback((path: string | null) => {
    setFilterPath(path)
    void saveWebDAVFilterPath(path)
  }, [])

  const handleRefresh = useCallback(() => {
    setLoading(true)
    // 这条路径才是「用户下拉」，可以播刷新动画（见 refreshing 状态注释）
    setRefreshing(true)
    setScanText('正在加载标签...')
    void Promise.all(
      songs.map(async(song) => {
        if (!song.meta.filePath) return song
        try {
          const fileMetadata = await readMetadata(song.meta.filePath).catch(() => null)
          const picPath = await readPic(song.meta.filePath).catch(() => null)
          if (fileMetadata) {
            const updates: Record<string, any> = {}
            if (fileMetadata.albumName) updates.albumName = fileMetadata.albumName
            if (fileMetadata.name && !song.name) updates.name = fileMetadata.name
            if (fileMetadata.singer && !song.singer) updates.singer = fileMetadata.singer
            if (picPath) {
              const newPicUrl = picPath.startsWith('/') ? `file://${picPath}` : picPath
              updates.picUrl = newPicUrl
            }
            if (Object.keys(updates).length > 0) {
              await updateWebDAVMusicMeta(song.id, updates)
            }
          }
        } catch (e) {
          // ignore
        }
        return song
      }),
    ).then(async() => {
      return getWebDAVConfig()
    }).then((config) => {
      setSongs(config.songs ?? [])
      setScanText('')
      toast('标签加载完成')
      // 【第 27 轮】刷新完把没有封面的前几首自动补上在线封面
      prefetchCovers(config.songs ?? [])
    }).catch((err: any) => {
      const message = err.message ?? String(err)
      setScanText(message)
      toast(message, 'long')
    }).finally(() => {
      setLoading(false)
      setRefreshing(false)
    })
  }, [songs, prefetchCovers])

  const showMenu = useCallback(
    (musicInfo: LX.WebDAV.MusicInfo, index: number, position: { x: number, y: number, w: number, h: number }) => {
      webDAVListMenuRef.current?.show(
        { musicInfo, index },
        position,
      )
    },
    [],
  )

  const handlePlay = useCallback(
    (musicInfo: LX.WebDAV.MusicInfo) => {
      const index = songs.findIndex(item => item.id === musicInfo.id)
      if (index < 0) return
      // WebDAV 列表整份写入试听列表(DEFAULT)，不再走临时列表（见 core/list.ts playOnlineList 的说明）
      void stageOnlineListToDefault('webdav', [...songs], index).then(() => {
        void (async() => {
          const config = await getWebDAVConfig()
          const updatedSongs = config.songs ?? []
          setSongs(updatedSongs)
          // 【第 25 轮】这里原来会对整份列表再跑一遍封面批量下载；已改为逐行按需（行内 useCoverUrl），
          // 只要重新读一次配置即可把播放链路刚写回的封面/标签带进来。
          // 【第 27 轮】再加一步：把还没有封面的前几首预热补上（播放链路只补当前播放那一首）。
          prefetchCovers(updatedSongs)
        })()
      })
    },
    [songs, prefetchCovers],
  )

  const handlePlayLater = useCallback((info: WebDAVSelectInfo) => {
    const musicInfo = info.musicInfo
    addTempPlayList([{
      listId: null,
      musicInfo,
    }])
    toast('已添加到稍后播放')
  }, [])

  const handleLoadMetadata = useCallback(async(info: WebDAVSelectInfo) => {
    const musicInfo = info.musicInfo
    if (!musicInfo.meta.filePath) {
      toast('请先下载歌曲')
      return
    }
    try {
      toast('正在读取标签...')
      const fileMetadata = await readMetadata(musicInfo.meta.filePath)
      const picPath = await readPic(musicInfo.meta.filePath).catch(() => null)

      if (!fileMetadata) {
        toast('没有找到标签信息')
        return
      }

      const updates: Record<string, any> = {}
      if (fileMetadata.albumName) updates.albumName = fileMetadata.albumName
      if (fileMetadata.name && !musicInfo.name) updates.name = fileMetadata.name
      if (fileMetadata.singer && !musicInfo.singer) updates.singer = fileMetadata.singer
      if (picPath) {
        const newPicUrl = picPath.startsWith('/') ? `file://${picPath}` : picPath
        updates.picUrl = newPicUrl
      }

      if (Object.keys(updates).length > 0) {
        await updateWebDAVMusicMeta(musicInfo.id, updates)
        setSongs(prevSongs => prevSongs.map(song =>
          song.id === musicInfo.id
            ? { ...song, ...updates, meta: { ...song.meta, ...updates } }
            : song,
        ))
        toast('标签加载成功')
      } else {
        toast('没有新的标签信息')
      }
    } catch (error: any) {
      toast(`加载标签失败：${error.message}`, 'long')
    }
  }, [])

  const handleDownload = useCallback((info: WebDAVSelectInfo) => {
    void handleWebDAVDownload(info.musicInfo).then((newPicUrl) => {
      if (newPicUrl) {
        setSongs(prevSongs => prevSongs.map(song =>
          song.id === info.musicInfo.id
            ? { ...song, meta: { ...song.meta, picUrl: newPicUrl } }
            : song,
        ))
      }
    })
  }, [])

  const handleFetchPicFromOnline = useCallback((info: WebDAVSelectInfo) => {
    void handleFetchWebDAVPicFromOnline(info.musicInfo).then((newPicUrl) => {
      setSongs(prevSongs => prevSongs.map(song =>
        song.id === info.musicInfo.id
          ? { ...song, meta: { ...song.meta, picUrl: newPicUrl } }
          : song,
      ))
    })
  }, [])

  const handleEditMetadata = useCallback((info: WebDAVSelectInfo) => {
    selectedMusicInfoRef.current = info.musicInfo
    metadataEditTypeRef.current?.show(info.musicInfo.meta.filePath, info.musicInfo)
  }, [])

  const handleUpdateMetadata = useCallback(() => {
    if (!selectedMusicInfoRef.current) return
    loadConfig().catch(() => {})
  }, [loadConfig])

  const handleRemove = useCallback((info: WebDAVSelectInfo) => {
    void handleWebDAVRemove(info.musicInfo).then(() => {
      setSongs(prevSongs => prevSongs.filter(song => song.id !== info.musicInfo.id))
    })
  }, [])

  const handleBatchDownload = useCallback(() => {
    void confirmDialog({
      title: '扫描并下载',
      message: '此操作将先扫描 WebDAV 目录，然后下载所有扫描到的歌曲。下载后的歌曲将添加到下载列表中，并自动读取音乐标签。',
      confirmButtonText: '开始扫描并下载',
    }).then((confirmed) => {
      if (!confirmed) return

      setLoading(true)
      setScanText('开始扫描...')
      void scanWebDAVSongs(selectedFolder, (count, path) => {
        setScanText(`已找到 ${count} 首，正在扫描：${path}`)
      })
        .then((config) => {
          const scannedSongs = config.songs ?? []
          setSongs(scannedSongs)
          setScannedAt(config.scannedAt)
          setScanText('')
          // 【第 27 轮】扫描完立刻自动补在线封面（有上限，见 MAX_PREFETCH_COVERS）
          prefetchCovers(scannedSongs)

          if (scannedSongs.length === 0) {
            toast('没有扫描到可下载的歌曲')
            return
          }

          void handleWebDAVDownloadAndImport(scannedSongs, setBatchLoadingText)
        })
        .catch((err: any) => {
          const message = err.message ?? String(err)
          setScanText(message)
          toast(message, 'long')
        })
        .finally(() => {
          setLoading(false)
        })
    })
  }, [selectedFolder, prefetchCovers])

  const loadFolders = useCallback((folder: LX.WebDAV.DriveFolder | null) => {
    setFolderLoading(true)
    void listWebDAVFolders(folder)
      .then(setFolders)
      .catch((err: any) => {
        const message = err.message ?? String(err)
        toast(message, 'long')
      })
      .finally(() => {
        setFolderLoading(false)
      })
  }, [])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  useEffect(() => {
    if (!hasConfig) return
    loadFolders(currentFolder)
  }, [hasConfig, currentFolder, loadFolders])

  useEffect(() => {
    const handleWebdavPicUpdated = (musicId: string, picUrl: string) => {
      setSongs(prevSongs => prevSongs.map(song =>
        song.id === musicId
          ? { ...song, meta: { ...song.meta, picUrl } }
          : song,
      ))
    }

    global.app_event.on('webdavPicUpdated', handleWebdavPicUpdated)
    return () => {
      global.app_event.off('webdavPicUpdated', handleWebdavPicUpdated)
    }
  }, [])

  const handleScan = useCallback(() => {
    if (!hasConfig) {
      toast('请先在设置中配置 WebDAV')
      setActiveTab('config')
      return
    }
    const runScan = () => {
      setLoading(true)
      setScanText('开始扫描...')
      void scanWebDAVSongs(selectedFolder, (count, path) => {
        setScanText(`已找到 ${count} 首，正在扫描：${path}`)
      })
        .then((config) => {
          const scannedSongs = config.songs ?? []
          setSongs(scannedSongs)
          setScannedAt(config.scannedAt)
          setScanText('')
          setActiveTab('list')
          toast(`扫描完成：${config.songs.length} 首`)
          // 【第 27 轮】扫描完立刻自动补在线封面（有上限，见 MAX_PREFETCH_COVERS）
          prefetchCovers(scannedSongs)
        })
        .catch((err: any) => {
          const message = err.message ?? String(err)
          setScanText(message)
          toast(message, 'long')
        })
        .finally(() => {
          setLoading(false)
        })
    }
    if (!selectedFolder) {
      void confirmDialog({
        title: '扫描 WebDAV 根目录',
        message:
          '根目录扫描会递归读取所有子目录。文件夹很多时可能较慢。确定继续扫描根目录？',
        confirmButtonText: '继续扫描',
      }).then((confirmed) => {
        if (confirmed) runScan()
      })
      return
    }
    runScan()
  }, [hasConfig, selectedFolder, prefetchCovers])

  const handleSelectCurrentFolder = useCallback(() => {
    setLoading(true)
    void saveWebDAVSelectedFolder(currentFolder)
      .then((config) => {
        setSelectedFolder(config.selectedFolder ?? null)
        toast(`已选择：${getFolderName(config.selectedFolder)}`)
      })
      .catch((err: any) => {
        toast(err.message ?? String(err), 'long')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [currentFolder])

  const scrollToMusic = useCallback((musicId: string) => {
    let list = filteredSongs
    let index = list.findIndex(item => item.id === musicId)
    if (index < 0 && searchText) {
      setSearchText('')
      list = songs
      index = list.findIndex(item => item.id === musicId)
    }
    if (index < 0) return
    setActiveTab('list')
    requestAnimationFrame(() => {
      setTimeout(() => {
        listRef.current?.scrollToIndex({
          index,
          viewPosition: 0.3,
          animated: true,
        })
      }, searchText ? 160 : 80)
    })
  }, [filteredSongs, searchText, songs])

  useEffect(() => {
    const handleJumpPosition = () => {
      const rawMusicInfo = playerState.playMusicInfo.musicInfo
      const musicInfo = rawMusicInfo && 'progress' in rawMusicInfo ? rawMusicInfo.metadata.musicInfo : rawMusicInfo
      if (!musicInfo) return
      pendingJumpIdRef.current = musicInfo.id
      scrollToMusic(musicInfo.id)
    }
    // @ts-expect-error - jumpWebDAVPosition is a custom event
    global.app_event.on('jumpWebDAVPosition', handleJumpPosition)
    return () => {
      // @ts-expect-error - jumpWebDAVPosition is a custom event
      global.app_event.off('jumpWebDAVPosition', handleJumpPosition)
    }
  }, [scrollToMusic])

  useEffect(() => {
    if (activeTab !== 'list' || !pendingJumpIdRef.current) return
    const musicId = pendingJumpIdRef.current
    pendingJumpIdRef.current = null
    scrollToMusic(musicId)
  }, [activeTab, scrollToMusic])

  // 列数响应式（对齐 OnlineList）：iPad 横屏/分屏时双列，避免歌曲行在超宽屏上
  // 被拉得过长、左右留白；竖屏保持单列零回归。
  // numColumns 变更时 FlatList 必须重挂载（RN 不支持运行中改列数），故加 key。
  const isHorizontal = useHorizontalMode()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const rowInfo = useMemo(() => {
    void isHorizontal
    return getRowInfo()
  }, [isHorizontal])
  const numColumns = rowInfo.rowNum ?? 1

  const renderSong: ListRenderItem<LX.WebDAV.MusicInfo> = useCallback(
    ({ item, index }) => (
      <SongItem
        item={item}
        index={index}
        isPlaying={playMusicInfo.musicInfo?.id === item.id}
        rowWidth={rowInfo.rowWidth}
        onPress={handlePlay}
        onShowMenu={showMenu}
      />
    ),
    [handlePlay, showMenu, playMusicInfo.musicInfo?.id, rowInfo.rowWidth],
  )

  const headerText = useMemo(() => {
    if (batchLoadingText) return batchLoadingText
    if (searchText.trim()) return `${filteredSongs.length}/${songs.length} 首`
    return `${songs.length} 首${scannedAt ? ` · ${formatTime(scannedAt)}` : ''}`
  }, [batchLoadingText, filteredSongs.length, scannedAt, searchText, songs.length])

  const handleToggleSearch = useCallback(() => {
    setSearchVisible((visible) => {
      const nextVisible = !visible
      if (nextVisible) {
        requestAnimationFrame(() => {
          searchInputRef.current?.focus()
        })
      } else {
        setSearchText('')
        Keyboard.dismiss()
      }
      return nextVisible
    })
  }, [])

  const handleClearSearch = useCallback(() => {
    if (searchText) {
      setSearchText('')
      searchInputRef.current?.focus()
      return
    }
    setSearchVisible(false)
    Keyboard.dismiss()
  }, [searchText])

  // 三段标签是**整页唯一一份固定头**，渲染在三个面板之外（见下方 return）。
  //
  // 此前它由三个面板各渲染一次：配置页/文件列表页放在 contentContainerStyle=padding:12
  // 的 ScrollView 里，歌曲列表页放在 FlatList 的 ListHeaderComponent 里（没有那 12px）。
  // 于是切标签时同一行标签被不同容器的内边距推着平移（左右上下各差 12px），并且三处
  // 是三个不同的父容器 → 整棵子树跨分支重挂载，「文字和按钮乱动」的观感就是这么来的；
  // 列表页那份还会跟着列表滚走，不满足「固定不位移」。
  //
  // 现在统一采用歌曲列表页的几何（PageTopInset + paddingHorizontal:16）作为唯一基准，
  // 标签行位于所有滚动容器之外：切换只替换下方面板，标签本身既不重挂载也不位移。
  const renderTabsHeader = () => (
    <>
      <PageTopInset />
      {/* 页面标题：本页此前没有自己的标题，只有共享页头那一行；现按「我的」标题的位置/行高/
          字重渲染，字号取共享页头（也就是本页原来那行）的字号 —— 用户第 14 轮第 1 条。
          它与下面三段标签一起放在所有滚动容器之外，切标签、滚列表都不位移。 */}
      <DetailPageTitle title={t('nav_webdav')} />
      {/* 【第 21 轮·图三/图四】三段标签改用共享 PillTabs —— 本页原先是它自己的一份内联实现，
          酷狗歌单 / QQ歌单 要把标题行里的 tab 搬到这里时，几何必须与它逐字一致（用户点名
          「都参考 WebDAV 布局」），所以抽成唯一实现，三个页面共用同一份间距/胶囊几何。 */}
      <PillTabs
        tabs={[
          { key: 'list', label: '列表' },
          { key: 'folders', label: '文件列表' },
          { key: 'config', label: '配置' },
        ]}
        activeKey={activeTab}
        onChange={(key) => { setActiveTab(key as ActiveTab) }}
      />
    </>
  )

  const renderConfig = () => (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={Keyboard.dismiss}
      style={styles.scroll}
      contentContainerStyle={styles.content}
    >
      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <Text style={styles.label}>连接状态</Text>
        <Text color={hasConfig ? theme['c-primary-font'] : theme['c-font-label']}>
          {hasConfig ? '已配置' : '未配置，请在设置中配置 WebDAV'}
        </Text>
      </View>

      <WebDAVDownloadPath />

      <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
        <Text style={styles.label}>目录</Text>
        <Text color={theme['c-font-label']} style={styles.meta}>
          当前：{getFolderName(currentFolder)}
        </Text>
        <Text color={theme['c-font-label']} style={styles.meta}>
          已选择：{getFolderName(selectedFolder)}
        </Text>
        <View style={styles.buttonRow}>
          <Button
            // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
            style={[
              { ...styles.button, backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity) },
              // 按钮无固定高度：可见高度 ≈ 29 = 单行文字行高 17（默认 15×1.15）+ 上下 padding 6×2，行内覆盖「按钮圆角」
              { borderRadius: buttonRadius(29) },
            ]}
            disabled={!hasConfig || folderLoading || !folderStack.length}
            onPress={() => { setFolderStack(prev => prev.slice(0, -1)) }}
          >
            <Text color={theme['c-button-font']}>返回上级</Text>
          </Button>
          <Button
            style={[
              { ...styles.button, backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity) },
              // 按钮无固定高度：可见高度 ≈ 29 = 单行文字行高 17（默认 15×1.15）+ 上下 padding 6×2，行内覆盖「按钮圆角」
              { borderRadius: buttonRadius(29) },
            ]}
            disabled={!hasConfig || loading}
            onPress={handleSelectCurrentFolder}
          >
            <Text color={theme['c-button-font']}>选择当前目录</Text>
          </Button>
        </View>

        {folderLoading ? (
          <Text style={styles.tip} color={theme['c-font-label']}>
            正在读取目录...
          </Text>
        ) : folders.length ? (
          folders.map(folder => (
            <TouchableOpacity
              key={folder.id}
              style={{ ...styles.folderItem, borderBottomColor: theme['c-border-background'] }}
              onPress={() => { setFolderStack(prev => [...prev, folder]) }}
            >
              <Text numberOfLines={1}>{folder.name}</Text>
              <Text size={11} color={theme['c-font-label']} numberOfLines={1}>
                {folder.path}
              </Text>
            </TouchableOpacity>
          ))
        ) : (
          <Text style={styles.tip} color={theme['c-font-label']}>
            {hasConfig ? '当前目录没有子目录。' : '请先在设置中配置 WebDAV。'}
          </Text>
        )}
      </View>
    </ScrollView>
  )

  const renderFolders = () => (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
    >
      <TouchableOpacity
        style={{ ...styles.folderItem, borderBottomColor: theme['c-border-background'] }}
        onPress={() => {
          handleSetFilterPath(null)
          setActiveTab('list')
        }}
      >
        <View style={styles.folderItemInfo}>
          <SvgIcon name="music-list" size={18} color={theme['c-primary-font']} style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text>全部歌曲</Text>
          </View>
          <Text size={12} color={theme['c-font-label']}>{songs.length} 首</Text>
        </View>
      </TouchableOpacity>
      {songFolders.length ? (
        songFolders.map(folder => (
          <TouchableOpacity
            key={folder.path}
            style={{ ...styles.folderItem, borderBottomColor: theme['c-border-background'] }}
            onPress={() => {
              handleSetFilterPath(folder.path)
              setActiveTab('list')
            }}
          >
            <View style={styles.folderItemInfo}>
              <SvgIcon name="folder" size={18} color={theme['c-primary-font']} style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1}>{folder.name}</Text>
                <Text size={11} color={theme['c-font-label']} numberOfLines={1}>
                  {folder.path}
                </Text>
              </View>
              <Text size={12} color={theme['c-font-label']}>{folder.count} 首</Text>
            </View>
          </TouchableOpacity>
        ))
      ) : (
        <View style={styles.empty}>
          <Text color={theme['c-font-label']}>还没有扫描到包含音乐的文件夹</Text>
        </View>
      )}
    </ScrollView>
  )

  const renderList = () => (
    <View style={styles.listPage}>
      <FlatList
        key={`cols-${numColumns}`}
        ref={listRef}
        data={filteredSongs}
        ListHeaderComponent={
          <>
            <View style={{ ...styles.listHeader, borderBottomColor: theme['c-border-background'] }}>
              <View style={styles.listHeaderText}>
          {searchVisible ? (
            <TextInput
              ref={searchInputRef}
              value={searchText}
              placeholder="搜索歌曲或歌手"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onChangeText={setSearchText}
              placeholderTextColor={theme['c-font-label']}
              selectionColor={theme['c-primary-light-100-alpha-300']}
              style={{
                ...styles.searchInput,
                color: theme['c-font'],
                borderColor: theme['c-border-background'],
                // 搜索输入框静态高 34（styles.searchInput.height），行内覆盖「按钮圆角」
                borderRadius: buttonRadius(34),
              }}
            />
          ) : (
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text numberOfLines={1} style={{ flex: 1 }}>
                  {filterPath ? `文件夹：${filterPath.split('/').pop() || '根目录'}` : `已选择：${getFolderName(selectedFolder)}`}
                </Text>
                {filterPath ? (
                  <TouchableOpacity
                    onPress={() => { handleSetFilterPath(null) }}
                    style={[
                      { marginLeft: 8 },
                      // 清除筛选图标按钮无固定高度：以图标本体 12（Icon size=12）作可见高度
                      { borderRadius: buttonRadius(12) },
                    ]}
                  >
                    <Icon name="close" size={12} color={theme['c-primary-font']} />
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text size={11} color={theme['c-font-label']} numberOfLines={1}>
                {scanText || headerText}
              </Text>
            </View>
          )}
              </View>
              <TouchableOpacity
                style={[
                  styles.headerIconButton,
                  // 图标按钮 34×34：按自身高度折算半高，行内覆盖「按钮圆角」
                  { borderRadius: buttonRadius(34) },
                ]}
                onPress={handleToggleSearch}
              >
                <Icon name="search-2" size={16} color={searchVisible ? theme['c-primary-font'] : theme['c-font-label']} />
              </TouchableOpacity>
              {searchVisible ? (
                <TouchableOpacity
                  style={[
                    styles.headerIconButton,
                    // 图标按钮 34×34：按自身高度折算半高，行内覆盖「按钮圆角」
                    { borderRadius: buttonRadius(34) },
                  ]}
                  onPress={handleClearSearch}
                >
                  <Icon name="close" size={13} color={theme['c-font-label']} />
                </TouchableOpacity>
              ) : null}
              <Button
                // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                style={[
                  { ...styles.scanButton, backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity) },
                  // 按钮无固定高度：可见高度 ≈ 29 = 单行文字行高 17（默认 15×1.15）+ 上下 padding 6×2，行内覆盖「按钮圆角」
                  { borderRadius: buttonRadius(29) },
                ]}
                disabled={!hasConfig || loading || !!batchLoadingText}
                onPress={handleScan}
              >
                <Text color={theme['c-button-font']}>扫描</Text>
              </Button>
              <Button
                style={[
                  { ...styles.scanButton, backgroundColor: applyOpacity(theme['c-primary-background-hover'], buttonOpacity), marginLeft: 8 },
                  // 按钮无固定高度：可见高度 ≈ 29 = 单行文字行高 17（默认 15×1.15）+ 上下 padding 6×2，行内覆盖「按钮圆角」
                  { borderRadius: buttonRadius(29) },
                ]}
                disabled={!hasConfig || loading || !!batchLoadingText}
                onPress={handleBatchDownload}
              >
                <Text color={theme['c-primary-font']}>扫描并下载</Text>
              </Button>
            </View>
          </>
        }
        contentContainerStyle={{ paddingBottom: bottomInset }}
        numColumns={numColumns}
        renderItem={renderSong}
        keyExtractor={item => item.id}
        style={{ flex: 1 }}
        // 限制渲染窗口 + 离屏行视图摘除（iOS 滚动掉帧主杠杆；getItemLayout 固定行高下回挂安全）
        initialNumToRender={20}
        windowSize={5}
        maxToRenderPerBatch={10}
        removeClippedSubviews={true}
        updateCellsBatchingPeriod={50}
        getItemLayout={(data, index) => ({
          length: ITEM_HEIGHT,
          offset: ITEM_HEIGHT * Math.floor(index / numColumns),
          index,
        })}
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({
            offset: Math.max(0, info.averageItemLength * info.index),
            animated: true,
          })
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text color={theme['c-font-label']}>{searchText.trim() ? '没有匹配的歌曲' : '还没有扫描到歌曲'}</Text>
          </View>
        }
        refreshControl={
          <RefreshControl
            colors={[theme['c-primary']]}
            // 只认用户下拉（见 refreshing 状态注释）：扫描/选目录不再把列表压下去再弹回来
            refreshing={refreshing}
            onRefresh={handleRefresh}
          />
        }
      />
    </View>
  )

  // 【第 21 轮·图七】右滑返回「我的」主界面：与排行榜页（Leaderboard/Vertical）同一条
  // 右缘手势带，onBack 只做一件事 —— 把首页切回「我的」（setNavActiveId('nav_love')）。
  const handleBackToLove = useCallback(() => {
    setNavActiveId('nav_love')
  }, [])

  return (
    <View style={styles.container}>
      {renderTabsHeader()}
      {activeTab === 'config' ? renderConfig() : activeTab === 'folders' ? renderFolders() : renderList()}
      <SwipeBackArea onBack={handleBackToLove} />
      <WebDAVListMenu
        ref={webDAVListMenuRef}
        onPlay={(info) => { handlePlay(info.musicInfo) }}
        onPlayLater={handlePlayLater}
        onDownload={handleDownload}
        onFetchPicFromOnline={handleFetchPicFromOnline}
        onEditMetadata={handleEditMetadata}
        onRemove={handleRemove}
        onLoadMetadata={handleLoadMetadata}
      />
      <MetadataEditModal ref={metadataEditTypeRef} onUpdate={handleUpdateMetadata} />
    </View>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 12,
  },
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    padding: 10,
    marginBottom: 10,
  },
  label: {
    marginBottom: 6,
  },
  meta: {
    marginTop: 5,
  },
  tip: {
    marginTop: 6,
    // 行距按 ≈1.2×字号 收敛（原 18 相对 14pt 正文是 1.29，属 A-6 点名的离群值）
    lineHeight: 16,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
  },
  button: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    marginRight: 10,
    marginBottom: 8,
  },
  folderItem: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 9,
  },
  folderItemInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  listPage: {
    flex: 1,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  listHeaderText: {
    flex: 1,
    paddingRight: 8,
  },
  searchInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    height: 34,
    paddingHorizontal: 8,
    paddingVertical: 0,
    fontSize: 13,
  },
  headerIconButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
  },
  songItem: {
    height: ITEM_HEIGHT,
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    // 【第 24 轮】左右内边距对齐其他歌曲列表（原 sm=12）：⋮ 与封面的落点才与「我的列表 /
    // 歌单详情 / 歌单」各处同一竖线（行内留 16 + 按钮右 margin 8）
    paddingLeft: designSpacing.md,
    paddingRight: designSpacing.md,
    marginBottom: designSpacing.sm,
    borderWidth: 1,
    borderRadius: designRadius.lg,
  },
  songItemLeft: {
    flex: 1,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  // 【第 24 轮】sn / albumArt / itemInfo / listItemSingle / listItemSingleText / songTitle / moreButton
  // 已全部移入 components/common/songRowStyles.ts（歌曲行唯一来源）；本卡片只保留自己的
  // 边框+底色（songItem）与无封面占位（占位底色是 WebDAV 独有的，尺寸仍取共享 metrics）。
  albumArtPlaceholder: {
    width: songRowMetrics.coverSize,
    height: songRowMetrics.coverSize,
    borderRadius: designRadius.md,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  empty: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
