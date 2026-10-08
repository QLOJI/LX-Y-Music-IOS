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
import MarqueeText from '@/components/common/MarqueeText'
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
// 【第 29 轮】再加 invalidateCoverCache：本地封面文件失效 / 行内加载失败时作废内存缓存。
import { fetchCoverUrl, getCachedCoverUrl, invalidateCoverCache } from '@/core/music/coverUrl'
// 【第 29 轮】每轮封面巡检开始时清空 local.ts 的「搜过没结果」失败备忘（否则失败一次就永不重试）
import { clearWebdavCoverMisses } from '@/core/music/local'
import { webDAVLog } from '@/core/webdavMusic/logger'
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
  handleFetchWebDAVPicFromOnline,
  handleWebDAVRemove,
  // 【第 31 轮】行内封面加载失败的单曲自愈走「加法式」helper（只作废这一首的缓存与
  // 失败备忘、单取一次），不再借道 prefetchCovers —— 后者会清空轮次把在飞的整轮巡检掐死。
  refreshWebdavCover,
} from './WebDAVListAction'
// 【第 30 轮】本页的下载入口（⋮ 菜单「下载」/ 头部「扫描并下载」）统一走下载管理器：
// 与「我的 / 歌单 / 搜索结果 / 播放列表」里的下载按钮完全同一条路径（任务列表可见、有进度、
// 能取消、自动写封面/歌词/标签），不再走 WebDAVListAction 那条「静默下到网盘目录、
// 界面上看不到任何动静」的老链路（老函数保留未删，本轮起无调用点，见改动清单）。
import { batchDownload, downloadMusicAsync } from '@/core/download'
import { readMetadata, readPic } from '@/utils/localMediaMetadata'
import { existsFile } from '@/utils/fs'

type ActiveTab = 'config' | 'list' | 'folders'
const ITEM_HEIGHT = scaleSizeH(LIST_ITEM_HEIGHT)

// 【第 34 轮第 3 条】列表项**实测行高**：卡片自身高度是 ITEM_HEIGHT，但它下面还挂着
// marginBottom（styles.songItem 里 = designSpacing.sm），一个单元格占的是两者之和。
// FlatList 的 getItemLayout 必须回报这个真实值（length 与 offset 同一来源）：
// 以前 length 只报 ITEM_HEIGHT、比真实值小 designSpacing.sm，逐行累计后 FlatList 算出的
// 内容总高、可视窗口和滚动偏移全部偏小，配合 removeClippedSubviews 在列表末尾卸载/回挂
// 单元格时内容高度反复收缩 —— 用户看到的正是「滑到最后继续往上滑时列表抽动、
// 向上滑的过程中会出现间断的向下滑」（用户第 34 轮第 3 条原话）。
// 改的是常量来源，不改任何视觉：卡片高度、间距、圆角一概不动。
const ITEM_ROW_HEIGHT = ITEM_HEIGHT + designSpacing.sm

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

// 【第 27 轮】封面巡检每批推进的条数上限（见组件里的 prefetchCovers）。
// 【第 29 轮】语义从「每次只补前 20 首」改成「整份列表分批走完、每批最多 20 首」：
// 批与批之间等上一批落地，免得曲库里几百首一次性压进 coverUrl.ts 的 4 并发队列，
// 把行内按需请求排在长队后面。单批 20 首也保证首屏那几首先出图。
const MAX_PREFETCH_COVERS = 20

const SongItem = memo(
  ({
    item,
    index,
    isPlaying,
    rowWidth = '100%',
    onPress,
    onShowMenu,
    onCoverError,
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
    /** 【第 29 轮】封面加载失败（远程封面 404 / 本地封面文件被清掉）时回调，交给列表页自愈 */
    onCoverError: (musicInfo: LX.WebDAV.MusicInfo, url: string) => void
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
                // 【第 29 轮】加载失败就交给列表页自愈（作废缓存 + 清 picUrl + 重查一次），
                // 而不是让这一行永远停在占位上（远程封面 404 / 本地封面被系统清掉）
                onError={(url) => { onCoverError(item, String(url)) }}
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
            {/* 【第 30 轮·图十】歌名过长改为从右到左滚动（原先截断成「...」） */}
            <MarqueeText
              text={item.name || item.meta.fileName}
              size={designTypography.body}
              style={songRowStyles.songName}
              color={isPlaying ? theme['c-primary-font'] : theme['c-font']}
            />
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
  // 【第 30 轮】原来的 batchLoadingText（「正在下载 x/y」页头 + 两个按钮的禁用条件）已移除：
  // 下载改由下载管理器接管，进度在「我的 → 下载」里看，按钮不再被批量下载长时间禁用
  // （旧链路下几百首要下很久，按钮一直灰着 —— 那也是「点了没反应」的一部分）。
  const listRef = useRef<FlatList<LX.WebDAV.MusicInfo>>(null)
  const searchInputRef = useRef<TextInput>(null)
  const pendingJumpIdRef = useRef<string | null>(null)
  const webDAVListMenuRef = useRef<WebDAVListMenuType>(null)
  const metadataEditTypeRef = useRef<any>(null)
  const selectedMusicInfoRef = useRef<LX.WebDAV.MusicInfo | null>(null)

  const currentFolder = folderStack.at(-1) ?? null

  // 【第 29 轮】hasConfig 原来是 useMemo(..., [])：只在挂载那一刻读一次 settingState。
  // 设置是异步水合的、用户也可能刚在同一次会话的配置页里填好 WebDAV —— 挂载时读到空值就
  // **永远是 false**，而两个按钮都是 disabled={!hasConfig || ...}：按钮从此点不动、也没有
  // 任何提示，这正是「WebDAV 的下载按钮按了没反应」。改用设置 hook（与设置页同款用法），
  // 配置一变 hasConfig 立即跟上。
  const webdavUrl = useSettingValue('sync.webdav.url')
  const webdavUsername = useSettingValue('sync.webdav.username')
  const hasConfig = useMemo(() => {
    return !!(webdavUrl && webdavUsername)
  }, [webdavUrl, webdavUsername])

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
  // 【第 29 轮】从「预热前 20 首」升级为「整份列表巡检」。
  //
  // 为什么还要这一层：列表行本身有 useCoverUrl 逐行按需补（第 25 轮），但那只覆盖"已经渲染出来
  // 的那几行"，而且首屏渲染那一瞬间就得等在线匹配（findMusic 跨平台搜索 + getPic）才出图。
  // 这里在拿到曲库列表时把没有可用封面的歌按顺序丢给同一套 fetchCoverUrl（同一个 4 并发全局
  // 队列 + 同一份内存缓存，命中在飞的请求不会重复发），首屏那几首的请求在渲染前就已经在路上，
  // 其余的按 MAX_PREFETCH_COVERS 分批发完（每批最多 20 首，批间等待），整份列表都会走到。
  //
  // 第 29 轮修的三件事（用户：要时刻关注 WebDAV 列表，封面缺失或者未更新时要自动加载）：
  //   ① 「缺封面」不再只等于 meta.picUrl 为空 —— picUrl 指向的本地封面文件（file://）可能已被
  //      系统清理，状态里那个 file:// 会让行内 useCoverUrl 直接短路（认为有封面），列表上就是
  //      永远的空占位。巡检先把这类失效封面清成空串，再当缺失重补；
  //   ② 上一轮「试过 / 搜过没结果」的记录每轮巡检开始时清空（local.ts 的 clearWebdavCoverMisses），
  //      否则一首歌失败过一次就再也不会被补上（第 28 轮的备忘原本是会话级的）；
  //   ③ 刷新（下拉）是一次「连封面是不是最新的都重查」：forceCoverRefresh 置位后这批请求走
  //      isRefresh，绕过内存缓存与在线源的缓存重新匹配（用户：刷新列表后也要刷新封面是否最新或者缺失）。
  //   ④ 【第 30 轮】「点扫描」也并入 ③ 这条路（handleScan 同样置位 forceCoverRefresh），
  //      并且 isRefresh 时不再看内存缓存（上一轮只跳过了源侧缓存，同歌名/歌手的本地缓存仍会把
  //      重新选目录后的新歌单整份挡掉 —— 图七/图八的「歌单切了封面不刷新」）。另外每次从别的
  //      页面切进本页都会重新 loadConfig 一次 ⇒ 随即按列表顺序从上到下起一轮巡检（图六）。
  // 请求量仍由 coverUrl.ts 的 4 并发全局队列 + local.ts 的 2 并发搜索闸 + 这里的分批收口。
  const prefetchedCoverIds = useRef(new Set<string>())
  // 巡检轮次号：每轮 +1。上一轮的异步结果落地前先核对轮次，避免把上一份列表的封面写进新列表。
  const coverSweepToken = useRef(0)
  // 「刷新」= 连封面是否最新都重查。用 ref 传递而不是给 prefetchCovers 加第二个参数：
  // 四个调用点的文本保持不变（第 27 轮契约按字面匹配调用点）。
  const forceCoverRefresh = useRef(false)

  const prefetchCovers = useCallback((list: LX.WebDAV.MusicInfo[]) => {
    const isRefresh = forceCoverRefresh.current
    forceCoverRefresh.current = false
    // 每轮巡检都是新的一轮：上一轮试过的 id、上一轮确认查不到的歌全部作废，重新查一遍。
    prefetchedCoverIds.current.clear()
    clearWebdavCoverMisses()
    const token = ++coverSweepToken.current

    const sweep = async() => {
      // ① 不用联网的先做：校验 file:// 封面文件是否还在（被系统清掉的必须当「缺失」）
      const queue: LX.WebDAV.MusicInfo[] = []
      for (const rawSong of list) {
        if (!rawSong?.id || !rawSong.meta) continue
        let song = rawSong
        if (song.meta.picUrl) {
          // 远程 http(s) 封面留着（两种模式都一样）：巡检里逐个探活代价太大（几百次 HEAD），
          // 它是不是还活着，行内 Image 的 onError 最清楚 —— 那条路走 handleCoverError 自愈。
          if (!song.meta.picUrl.startsWith('file://')) continue
          // 本地 file:// 封面必须探活：文件被系统清掉后状态里那个 URL 会让行内 useCoverUrl
          // 直接短路（认为有封面），列表上就是永远的空占位。刷新模式同样要查（否则「扫描一次
          // 刷新一次封面」对这类失效封面无效）。
          const alive = await existsFile(song.meta.picUrl.replace('file://', '')).catch(() => false)
          if (alive) continue
          webDAVLog.info('prefetchCovers: cached local cover is gone, re-fetch', { musicId: song.id, picUrl: song.meta.picUrl })
          invalidateCoverCache(song)
          song = { ...song, meta: { ...song.meta, picUrl: '' } }
          setSongs(prevSongs => prevSongs.map(item =>
            item.id === rawSong.id ? { ...item, meta: { ...item.meta, picUrl: '' } } : item,
          ))
        }
        if (prefetchedCoverIds.current.has(song.id)) continue
        // 【第 30 轮】刷新（点扫描 / 下拉）不看内存缓存：原先对「内存里已经有封面结果」的歌
        // 一律跳过 —— 用户重新选目录后点扫描，同歌名/歌手的缓存会把新歌单里的歌挡在门外，
        // 观感就是「歌单切了，封面没有刷新加载」（图七/图八）。刷新模式重新走一遍 getPicPath，
        // 并把 isRefresh 透传给在线源（见 fetchCoverUrl），绕过源侧缓存重新匹配。
        if (!isRefresh && getCachedCoverUrl(song)) continue
        prefetchedCoverIds.current.add(song.id)
        queue.push(song)
      }

      // ② 分批推进整份列表
      for (let i = 0; i < queue.length; i += MAX_PREFETCH_COVERS) {
        if (coverSweepToken.current !== token) return
        const tasks: Array<Promise<void>> = []
        let started = 0
        for (const song of queue.slice(i, i + MAX_PREFETCH_COVERS)) {
          if (started >= MAX_PREFETCH_COVERS) break
          started++
          // fetchCoverUrl 内部已 catch（失败返回空串），这里再把拿到手的封面推回列表状态：
          // 即使 meta 落盘那一步失败（updateWebDAVMusicMeta 抛错时不会广播 webdavPicUpdated），
          // 已经渲染出来的行也能立刻换图。
          tasks.push(fetchCoverUrl(song, { isRefresh }).then(url => {
            if (!url) return
            if (coverSweepToken.current !== token) return
            setSongs(prevSongs => prevSongs.map(item =>
              item.id === song.id
                ? { ...item, meta: { ...item.meta, picUrl: url } }
                : item,
            ))
          }))
        }
        // 【第 34 轮第 3 条】原来是 `await Promise.all(tasks)`：整批 20 首里只要有一首的
        // Promise 永不 settle（音源 SDK 卡在底层 HTTP 上，见 core/music/coverUrl.ts 的超时说明），
        // 这一批就永远等不到返回 —— 循环不再往下走，**后面所有歌曲的封面全部不再加载**，
        // 用户看到的就是「一个或者几个刷新不出来，后面就不加载了」。
        // 换成 allSettled：等的是「这一批都结束了」而不是「这一批都成功了」，
        // 个别失败 / 卡死（超时后按空串落地）也照样推进下一批。
        await Promise.allSettled(tasks)
      }
    }

    void sweep()
  }, [])

  const loadConfig = useCallback(async() => {
    return getWebDAVConfig().then(config => {
      setSelectedFolder(config.selectedFolder ?? null)
      const songs = config.songs ?? []
      setSongs(songs)
      setScannedAt(config.scannedAt)
      setFilterPath(config.filterPath ?? null)
      // 【第 31 轮·图一】「进列表」也按强制刷新处理：与点扫描 / 下拉刷新同一个口径。
      // 用户需求原文：「进入 WebDAV 歌单界面也是会刷新该列表下所有歌曲的在线封面」。
      // 第 30 轮只把扫描与下拉接上了 force（见上面 ③④），而**入口这条路**（第 30 轮图六加的
      // 「每次切页都 loadConfig」）没接：进列表走的这次 prefetchCovers 里 isRefresh = false，
      // 内存里已有封面结果的歌会被 getCachedCoverUrl 挡在门外（第 30 轮那条注释管的就是这个），
      // 于是「进来看到的还是灰占位 / 老封面」照旧复现。置位后本次巡检不看内存缓存、
      // 并把 isRefresh 透传到在线源复核「未更新」的封面。
      // 请求量不变：仍由分批（每批 20）+ coverUrl.ts 的 4 并发全局队列 + local.ts 的 2 并发
      // 搜索闸收口；拿到手的 URL 已缓存的会覆盖写回，不额外放大并发。
      forceCoverRefresh.current = true
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
    // 【第 29 轮】刷新是一次「连封面是不是最新的都重查」的巡检（用户：刷新列表后也要刷新
    // 封面是否最新或者缺失）：置位后本次 prefetchCovers 走 isRefresh，重查在线封面。
    forceCoverRefresh.current = true
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
    // 【第 29 轮】入口先落日志：用户报「下载按钮按了没反应」时，日志里至少能看出这次点击有没有到
    // 菜单回调（分辨「点了没进回调」还是「进了回调但下载静默失败」）。
    webDAVLog.info('handleDownload: menu download pressed', {
      musicId: info.musicInfo.id,
      fileName: info.musicInfo.meta?.fileName,
    })
    // 【第 30 轮·图五】下载动作交给下载管理器 —— 与其他列表的下载按钮「效果一样」：
    // 同一份任务模型、同一个下载列表、同样的失败提示，而且 WebDAV 歌曲的落盘目录由
    // core/download.ts 的 resolveDownloadDir 优先取 webdav.downloadPath（配置页里选的那个目录）。
    // 老链路（handleWebDAVDownload）是「静默下到网盘目录 + 写一条下载列表」，没有进度也没有失败回声，
    // 用户看到的就是「点了不开始下载」；它仍保留在 WebDAVListAction 里没删（见改动清单）。
    void downloadMusicAsync(info.musicInfo).catch((err: any) => {
      // 【第 29 轮】这里原来没有 catch：准备阶段抛错时整个 Promise 静默 reject —— 点了下载什么都
      // 不会发生，日志里也一行没有，正是「按了没反应」。现在一律落日志 + 把原因告诉用户。
      const message = err?.message ?? String(err)
      webDAVLog.error('handleDownload: download failed', { message, err })
      toast(`下载失败：${message}`, 'long')
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

  // 【第 29 轮】行内封面加载失败的自愈 —— 巡检之外的另一半「时刻关注」：
  // 远程封面（http(s)）没法在巡检里逐个探活，但真的挂了时 Image 一定会走到 onError。
  // 做法：作废内存缓存 → 清掉这一行状态里的 picUrl（行内 useCoverUrl 才会重新走 fetchCoverUrl）
  // → 交给 WebDAVListAction.refreshWebdavCover 重取这一首。
  // 【第 31 轮】重取入口从 prefetchCovers([song]) 换成 refreshWebdavCover(song)：
  // 前者是**整轮**巡检的入口（clear 试过名单 + 清空全部失败备忘 + 轮次 +1），在巡检推进
  // 过程中被行内失败触发时，会把**正在飞的那一轮**判成过期而整体中止 —— 一首歌的封面
  // 加载失败就能掐死后面所有歌的封面补全（用户这一轮报的「WebDAV 还是存在不自动加载
  // 在线封面」的另一半成因）。后者是加法式单曲补齐，不碰轮次、不清别人进度。
  // 同一行 + 同一个 URL 只自愈一次：否则「换来的封面又挂 → 再失败 → 再换」会变成死循环。
  const coverErrorRetriedKeys = useRef(new Set<string>())
  const handleCoverError = useCallback((song: LX.WebDAV.MusicInfo, url: string) => {
    const key = `${song.id}|${url}`
    if (coverErrorRetriedKeys.current.has(key)) return
    coverErrorRetriedKeys.current.add(key)
    webDAVLog.warn('handleCoverError: cover load failed, retrying once', { musicId: song.id, url })
    // 行内状态先清成空占位（行内 useCoverUrl 才会重新走 fetchCoverUrl）
    setSongs(prevSongs => prevSongs.map(item =>
      item.id === song.id ? { ...item, meta: { ...item.meta, picUrl: '' } } : item,
    ))
    // 单曲自愈：作废这一首的内存缓存与失败备忘后重取一次；拿到新封面立刻推回列表状态
    // （fetchCoverUrl 失败返回空串，空串不动状态，保持空占位）。
    void refreshWebdavCover(song).then((newPicUrl) => {
      if (!newPicUrl) return
      setSongs(prevSongs => prevSongs.map(item =>
        item.id === song.id ? { ...item, meta: { ...item.meta, picUrl: newPicUrl } } : item,
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
    // 【第 29 轮】未配置时不再靠 disabled 静默吞掉点击（见按钮那两处注释）
    if (!hasConfig) {
      toast('请先在设置中配置 WebDAV')
      setActiveTab('config')
      return
    }
    // 【第 29 轮】「按了没反应」的排查入口 + 即时反馈：
    // 这条链路的第一步是 confirmDialog —— 弹窗若没出来（宿主/时机问题），用户看到的就是
    // 「点了一下什么都没发生」，日志里也一行都没有。现在按下就落日志 + 先把标题写成
    // 「准备扫描并下载…」，即使弹窗没弹出来也有可见反馈。
    webDAVLog.info('handleBatchDownload: invoked', { hasConfig })
    setScanText('准备扫描并下载…')
    void confirmDialog({
      title: '扫描并下载',
      message: '此操作将先扫描 WebDAV 目录，然后下载所有扫描到的歌曲。下载后的歌曲将添加到下载列表中，并自动读取音乐标签。',
      confirmButtonText: '开始扫描并下载',
    }).then((confirmed) => {
      if (!confirmed) {
        webDAVLog.info('handleBatchDownload: cancelled by user')
        setScanText('')
        return
      }

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
          // 【第 30 轮】同 handleScan：这是「点了一次扫描」，封面也强制刷新一轮
          forceCoverRefresh.current = true
          prefetchCovers(scannedSongs)

          if (scannedSongs.length === 0) {
            toast('没有扫描到可下载的歌曲')
            return
          }

          // 【第 30 轮·图五】「扫描并下载」也交给下载管理器：扫描结果整份进下载队列，
          // 进度 / 取消 / 写封面歌词标签 / 失败原因全部复用其他下载按钮那一条链路，
          // 用户在「我的 → 下载」里看得见每一首。老链路
          // （handleWebDAVDownloadAndImport）是边下边把进度写进页头、并靠 batchLoadingText
          // 把两个按钮一直禁用着 —— 几百首要下很久，按钮长期灰着，观感同样像「点了没反应」。
          void batchDownload(scannedSongs).catch((err: any) => {
            const message = err?.message ?? String(err)
            webDAVLog.error('handleBatchDownload: batch add failed', { message, err })
            toast(`添加到下载列表失败：${message}`, 'long')
          })
        })
        .catch((err: any) => {
          const message = err.message ?? String(err)
          setScanText(message)
          toast(message, 'long')
        })
        .finally(() => {
          setLoading(false)
        })
    }).catch((err: any) => {
      // 确认框本身失败 / 上面这条链抛错时，别把「准备扫描并下载…」永远留在标题上
      const message = err?.message ?? String(err)
      webDAVLog.error('handleBatchDownload: failed', { message, err })
      setScanText('')
      toast(message, 'long')
    })
  }, [hasConfig, selectedFolder, prefetchCovers])

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

  // 【第 30 轮·图六】每次从别的页面切进 WebDAV 歌单，都重新读一次配置并立刻按列表顺序从上到
  // 下起一轮封面巡检。本页是 useHomeLazyPage 常驻挂载（切走不卸载）：只有上面那条挂载 effect
  // 的话，第二次之后进来页面一行都不跑，新缺的封面（比如播放链路/自愈清掉的那几张）永远等不到
  // 巡检。惰性挂载发生在导航事件之后一帧，所以「首次进入」由挂载 effect 负责、这条只管后续切换，
  // 两条不重不漏。prefetchCovers 内部按列表顺序入队、每批 20 首推进，天然是「由上到下秒加载」。
  // 【第 31 轮·图一】这两条入口现在都走 loadConfig，而 loadConfig 会置位 forceCoverRefresh ——
  // 即「进列表」按强制刷新处理（用户需求：进入 WebDAV 歌单界面也要刷新该列表下所有歌曲的在线封面）。
  useEffect(() => {
    const handleNavChange = (id: string) => {
      if (id !== 'nav_webdav') return
      void loadConfig()
    }
    global.state_event.on('navActiveIdUpdated', handleNavChange)
    return () => {
      global.state_event.off('navActiveIdUpdated', handleNavChange)
    }
  }, [loadConfig])

  useEffect(() => {
    if (!hasConfig) return
    loadFolders(currentFolder)
  }, [hasConfig, currentFolder, loadFolders])

  useEffect(() => {
    const handleWebdavPicUpdated = (musicId: string, picUrl: string) => {
      // 状态边界收口：只接受字符串。picUrl 最终会交给行内 <Image url={coverUrl}>，
      // 一旦是对象（上游音源 SDK getPic 没解包的请求对象），Image.tsx 的 `url.startsWith`
      // 求值为 undefined 再被调用 ⇒ 渲染期致命错误「undefined is not a function」
      // （用户截图：WebDAV 列表下滑突然弹 Fatal 错误框）。宁可这一帧不换图。
      if (typeof picUrl !== 'string') return
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
          // 【第 30 轮·图七/图八】扫描是一次强制刷新：用户重新选目录后点扫描，歌单立刻切了，
          // 但封面还是老样子（内存缓存按 歌名|歌手 命中，把新歌单整份挡住）。置位后这一轮巡检
          // 不看缓存、并把 isRefresh 透传到在线源 —— 「点一次扫描，刷新一次封面」。
          forceCoverRefresh.current = true
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
        onCoverError={handleCoverError}
      />
    ),
    [handlePlay, showMenu, handleCoverError, playMusicInfo.musicInfo?.id, rowInfo.rowWidth],
  )

  const headerText = useMemo(() => {
    if (searchText.trim()) return `${filteredSongs.length}/${songs.length} 首`
    return `${songs.length} 首${scannedAt ? ` · ${formatTime(scannedAt)}` : ''}`
  }, [filteredSongs.length, scannedAt, searchText, songs.length])

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
                // 【第 29 轮】不再把 !hasConfig 放进 disabled：未配置时按钮被禁用，按下去
                // 一点反馈都没有（用户读到的就是「按钮按了没反应」）。交给 handleScan 自己弹
                // 「请先在设置中配置 WebDAV」并跳到配置页。
                // 【第 30 轮】去掉 !!batchLoadingText：下载交给下载管理器后不再有「批量下载中」
                // 这个页面态，按钮只在扫描/选目录这类真正的页面忙碌时禁用。
                disabled={loading}
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
                // 【第 29 轮】同上：未配置时也让按得动，由 handleBatchDownload 提示 + 跳配置页
                // 【第 30 轮】同上：不再被批量下载的 loading text 长期禁用
                disabled={loading}
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
        // 【第 34 轮第 3 条】length / offset 一律用实测行高 ITEM_ROW_HEIGHT（= 卡片高 + 下外边距），
        // 与 styles.songItem 的几何同源，别再拿 ITEM_HEIGHT 当行高（见该常量的说明）
        getItemLayout={(data, index) => ({
          length: ITEM_ROW_HEIGHT,
          offset: ITEM_ROW_HEIGHT * Math.floor(index / numColumns),
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
