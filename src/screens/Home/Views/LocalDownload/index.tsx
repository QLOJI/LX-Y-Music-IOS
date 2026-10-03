import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, StyleSheet, TouchableOpacity, View } from 'react-native'
import LandscapeDetailLayout from '@/components/LandscapeDetailLayout'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useHorizontalMode } from '@/utils/hooks'
import { useI18n } from '@/lang'
import { createStyle, toast } from '@/utils/tools'
import { useDownloadTasks } from '@/store/download/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { usePlayMusicInfo } from '@/store/player/hook'
import { stageOnlineListToDefault } from '@/core/playListToDefault'
import { getDefaultDownloadPath } from '@/utils/downloadPath'
import downloadActions from '@/store/download/action'
import { mkdir, readDir, unlink, stat } from '@/utils/fs'
import { sizeFormate } from '@/utils'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
import { useSafeAreaBottom, useBottomOverlayInset } from '@/store/common/hook'
import PageTopInset from '@/components/common/PageTopInset'
import DetailPageTitle from '@/components/common/DetailPageTitle'
import PillTabs from '@/components/common/PillTabs'
import SwipeBackArea from '@/components/common/SwipeBackArea'
import { setNavActiveId } from '@/core/common'

type TabId = 'local' | 'download'

const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape'])

// 下载路径下的「本地」音乐文件夹
const getLocalDirName = () => '本地'

const getDownloadDir = (settingPath: string) => {
  const path = (settingPath ?? '').trim() || getDefaultDownloadPath()
  return path.endsWith('/') ? path.slice(0, -1) : path
}

const getExt = (name: string) => {
  const ext = name.split('.').pop()
  return ext && ext != name ? ext.toLowerCase() : ''
}

const parseFileName = (fileName: string) => {
  const dotIndex = fileName.lastIndexOf('.')
  const rawName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  if (!rawName.includes('-')) return { name: rawName.trim(), singer: '' }
  const [left, ...rest] = rawName.split('-')
  return { name: left.trim(), singer: rest.join('-').trim() }
}

interface LocalFileItem {
  id: string
  path: string
  fileName: string
  name: string
  singer: string
  size: number
}

// 本地文件转播放器可识别结构（走 localPlay 本地播放接口）
const localFileToPlayItem = (item: LocalFileItem): any => ({
  id: item.id,
  name: item.name,
  singer: item.singer,
  source: 'local',
  interval: null,
  meta: {
    songId: item.path,
    albumName: '',
    filePath: item.path,
    ext: getExt(item.fileName),
  },
})

// 下载任务转播放器可识别结构（metadata.musicInfo 供歌词/封面/回退使用）
const taskToPlayItem = (task: LX.Download.DownloadTask): any => ({
  id: task.id,
  isComplate: true,
  status: task.status,
  statusText: '',
  downloaded: task.progress?.downloaded ?? 0,
  total: task.progress?.total ?? 0,
  progress: task.progress?.percent ?? 1,
  speed: '',
  metadata: {
    musicInfo: task.musicInfo as LX.Music.MusicInfoOnline,
    url: null,
    quality: task.quality,
    ext: (task.fileName.split('.').pop() as any) ?? 'mp3',
    fileName: task.fileName,
    filePath: task.filePath,
  },
})

const SongRow = memo(
  ({
    title,
    subText,
    isPlaying,
    selected,
    onPress,
  }: {
    title: string
    subText: string
    isPlaying: boolean
    selected: boolean
    onPress: () => void
  }) => {
    const theme = useTheme()
    const buttonOpacity = useSettingValue('theme.buttonOpacity')
    return (
      <TouchableOpacity
        style={{
          ...styles.songItem,
          // 播放中/选中行高亮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
          // 【第 22 轮·图一/图二】普通行此前走不透明的 c-content-background，绕过了「按钮透明度」
          // 设置 —— 下载 / 本地两栏每首歌都像贴着一块实心底板，点下去进入 isPlaying 态才变成
          // 跟随透明度的高亮底，用户看到的「点击后才正常」就是这个差。现在与页头「批量管理 /
          // 刷新」按钮、播放中/选中行同一口径：同一个 c-primary-background token + applyOpacity。
          backgroundColor: isPlaying || selected
            ? applyOpacity(theme['c-primary-background-hover'], buttonOpacity)
            : applyOpacity(theme['c-primary-background'], buttonOpacity),
          borderColor: isPlaying || selected
            ? theme['c-primary-background-active']
            : theme['c-border-background'],
        }}
        onPress={onPress}
      >
        <View style={styles.itemInfo}>
          <Text
            size={designTypography.body}
            style={styles.songTitle}
            color={isPlaying ? theme['c-primary-font'] : theme['c-font']}
            numberOfLines={1}
          >
            {title}
          </Text>
          <Text
            size={designTypography.caption}
            color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
            numberOfLines={1}
          >
            {subText}
          </Text>
        </View>
        {selected && (
          <View style={{ ...styles.selectedMark, borderColor: theme['c-primary-background-active'] }}>
            <Text size={13} color={theme['c-primary-font-active']}>
              ✓
            </Text>
          </View>
        )}
      </TouchableOpacity>
    )
  },
)

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  const isHorizontal = useHorizontalMode()
  const safeAreaBottom = useSafeAreaBottom()
  // 底部悬浮层（迷你播放器 + 底部 Tab + 安全区）统一避让高度
  const bottomInset = useBottomOverlayInset()
  const downloadPathSetting = useSettingValue('download.path')
  const tasks = useDownloadTasks()
  const playMusicInfo = usePlayMusicInfo()

  const [tab, setTab] = useState<TabId>('download')
  const [localFiles, setLocalFiles] = useState<LocalFileItem[]>([])
  const [loading, setLoading] = useState(false)
  const [taskSizes, setTaskSizes] = useState<Record<string, number>>({})

  const downloadDir = useMemo(() => getDownloadDir(downloadPathSetting), [downloadPathSetting])
  const localDir = useMemo(() => `${downloadDir}/${getLocalDirName()}`, [downloadDir])

  const completedTasks = useMemo(
    () => tasks.filter(task => task.status === 'completed' && task.filePath),
    [tasks],
  )

  // 读取已完成下载文件的真实大小（progress.total 在某些场景为 0，导致页面上不显示大小）
  const completedKey = useMemo(
    () => completedTasks.map(task => task.id).join(','),
    [completedTasks],
  )
  useEffect(() => {
    let active = true
    if (completedTasks.length === 0) {
      setTaskSizes({})
      return
    }
    void Promise.all(
      completedTasks.map(async task => {
        if (!task.filePath) return null
        try {
          const info = await stat(task.filePath)
          return { id: task.id, size: info.size }
        } catch {
          return null
        }
      }),
    ).then(results => {
      if (!active) return
      const next: Record<string, number> = {}
      for (const r of results) {
        if (r) next[r.id] = r.size
      }
      setTaskSizes(next)
    })
    return () => {
      active = false
    }
  }, [completedKey, completedTasks])

  // 扫描下载路径下的「本地」文件夹
  const scanLocalDir = useCallback(async() => {
    setLoading(true)
    try {
      await mkdir(localDir).catch(() => {})
      const files = await readDir(localDir).catch(() => [])
      const items: LocalFileItem[] = []
      for (const file of files) {
        if (!file.isFile) continue
        if (!AUDIO_EXTS.has(getExt(file.name))) continue
        const parsed = parseFileName(file.name)
        items.push({
          id: `localdl_${file.path}`,
          path: file.path,
          fileName: file.name,
          name: parsed.name,
          singer: parsed.singer,
          size: file.size,
        })
      }
      items.sort((a, b) => a.name.localeCompare(b.name))
      setLocalFiles(items)
    } finally {
      setLoading(false)
    }
  }, [localDir])

  useEffect(() => {
    void scanLocalDir()
  }, [scanLocalDir])

  const handleRefresh = useCallback(() => {
    if (loading) return
    void scanLocalDir().then(() => {
      toast('已刷新', 'short')
    })
  }, [loading, scanLocalDir])

  const handlePlayLocal = useCallback(
    (item: LocalFileItem, index: number) => {
      const playListData = localFiles.map(localFileToPlayItem)
      // 本地文件整份写入试听列表(DEFAULT)，不再走临时列表（见 core/list.ts playOnlineList 的说明）。
      // 注意：试听列表是持久化 + 参与同步的列表，本地文件条目会随它一起被保存/备份。
      void stageOnlineListToDefault('local_files', playListData, index)
    },
    [localFiles],
  )

  const handlePlayTask = useCallback(
    (task: LX.Download.DownloadTask, index: number) => {
      const playListData = completedTasks.map(taskToPlayItem)
      // 已下载任务整份写入试听列表(DEFAULT)，与本地文件走的是两份不同的源列表
      void stageOnlineListToDefault('download_tasks', playListData, index)
    },
    [completedTasks],
  )

  // 批量管理模式：点击行改为切换选中，底部出现 全选 / 已选 / 删除 操作栏
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const enterSelecting = useCallback(() => {
    setSelecting(true)
    setSelectedIds(new Set())
  }, [])

  const exitSelecting = useCallback(() => {
    setSelecting(false)
    setSelectedIds(new Set())
  }, [])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    const current = tab === 'download' ? completedTasks : localFiles
    const allIds = current.map(i => i.id)
    const allSelected = allIds.length > 0 && allIds.every(id => selectedIds.has(id))
    setSelectedIds(allSelected ? new Set() : new Set(allIds))
  }, [tab, completedTasks, localFiles, selectedIds])

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return
    if (tab === 'download') {
      for (const id of selectedIds) {
        const task = completedTasks.find(t => t.id === id)
        if (!task) continue
        const removeFile = task.filePath ? unlink(task.filePath).catch(() => {}) : Promise.resolve()
        void removeFile.then(() => { downloadActions.removeTask(id) })
      }
    } else {
      for (const id of selectedIds) {
        const item = localFiles.find(f => f.id === id)
        if (!item) continue
        void unlink(item.path).catch(() => {})
      }
    }
    toast('已删除', 'short')
    exitSelecting()
    void scanLocalDir()
  }, [selectedIds, tab, completedTasks, localFiles, exitSelecting, scanLocalDir])

  const isPlayingId = playMusicInfo.musicInfo?.id

  // 渲染项提取为稳定 useCallback：避免父组件因加载更多/选择状态变化重渲时，
  // 内联 renderItem 每次重建函数引用导致所有可见 cell 跟着重渲（低端机卡顿）
  const renderDownloadItem = useCallback(
    ({ item, index }: { item: LX.Download.DownloadTask, index: number }) => {
      const fileSize = taskSizes[item.id] ?? item.progress?.total ?? 0
      return (
        <View style={isHorizontal ? styles.itemWrapper : null}>
          <SongRow
            title={item.musicInfo.name}
            subText={[
              item.musicInfo.singer,
              item.quality ? item.quality.toUpperCase() : '',
              fileSize ? sizeFormate(fileSize) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
            isPlaying={isPlayingId == item.id}
            selected={selectedIds.has(item.id)}
            onPress={() => { selecting ? toggleSelect(item.id) : handlePlayTask(item, index) }}
          />
        </View>
      )
    },
    [isHorizontal, isPlayingId, selectedIds, selecting, toggleSelect, handlePlayTask, taskSizes],
  )

  const renderLocalItem = useCallback(
    ({ item, index }: { item: LocalFileItem, index: number }) => (
      <View style={isHorizontal ? styles.itemWrapper : null}>
        <SongRow
          title={item.name}
          subText={[item.singer, item.size ? sizeFormate(item.size) : ''].filter(Boolean).join(' · ')}
          isPlaying={isPlayingId == item.id}
          selected={selectedIds.has(item.id)}
          onPress={() => { selecting ? toggleSelect(item.id) : handlePlayLocal(item, index) }}
        />
      </View>
    ),
    [isHorizontal, isPlayingId, selectedIds, selecting, toggleSelect, handlePlayLocal],
  )

  // 【第 21 轮·图七】右滑返回「我的」主界面：与排行榜页（Leaderboard/Vertical）同一条
  // 右缘手势带，onBack 只做一件事 —— 把首页切回「我的」（setNavActiveId('nav_love')）。
  const handleBackToLove = useCallback(() => {
    setNavActiveId('nav_love')
  }, [])

  // 下载 / 本地切换的 key 只可能是这两个（tabs 数组就在下面 JSX 里），原样回传即可。
  const handleTabChange = useCallback((key: string) => {
    setTab(key as TabId)
  }, [])

  // 页头（状态栏占位 + 标题行 + 标题下面那行按钮 + 下载/本地切换 + 说明）。
  // 【第 21 轮·图七】竖屏时它固定在列表**外面**（见 return 里的 {!isHorizontal && pageHeader}）：
  // 此前竖屏它是 FlatList 的 ListHeaderComponent —— 页头落在可滚动内容里，iOS 会对贴着安全区
  // 顶边的滚动视图自动加顶部 contentInset（本机 = 62pt），用户截图里「标题文字消失、标题栏
  // 位置和大小不统一」就是这层 inset 在推页头；列表一滚页头还会跟着走。移成列表兄弟节点后，
  // 与「我的」/ WebDAV 同构、位置固定。横屏仍走 LandscapeDetailLayout 的左栏（header 槽）。
  // 另把「下载 / 本地」原来那条整宽分段条换成共享 PillTabs —— 胶囊几何与 WebDAV / 酷狗歌单 /
  // QQ歌单逐字同源（用户点名「间距都参考 WebDAV」）。
  const pageHeader = (
    <>
      {/* 本页已接管页头（PAGE_OWNED_HEADER_IDS：nav_local_download），共享页头不再渲染，
          所以横竖屏都要自己铺状态栏占位（此前只在横屏铺，竖屏靠共享页头，见下条注释）。
          —— 用户第 14 轮第 1 条：本页标题按「我的」标题位置固定且显示完全。 */}
      <PageTopInset />
      <DetailPageTitle title={t('nav_local_download')} />
      <View style={styles.header}>
        <View style={styles.headerActions}>
          <TouchableOpacity
            // 按钮底面随「按钮透明度」淡出
            style={{ ...styles.headerBtn, backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity), borderRadius: buttonRadius(32) /* 批量管理按钮高 32：按自身高度 32 折算半高，行内覆盖「按钮圆角」 */ }}
            onPress={selecting ? exitSelecting : enterSelecting}
          >
            <Text size={designTypography.caption} color={theme['c-primary-font']}>
              {selecting ? '取消' : '批量管理'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            // 按钮底面随「按钮透明度」淡出
            style={{ ...styles.refreshBtn, backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity), borderRadius: buttonRadius(32) /* 刷新按钮高 32：按自身高度 32 折算半高，行内覆盖「按钮圆角」 */ }}
            onPress={handleRefresh}
          >
            <Text size={designTypography.caption} color={theme['c-primary-font']}>
              刷新
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 下载 / 本地切换：共享 PillTabs（选中态淡染底 + 主色文字，几何见组件注释） */}
      <PillTabs
        tabs={[
          { key: 'download', label: '下载' },
          { key: 'local', label: '本地' },
        ]}
        activeKey={tab}
        onChange={handleTabChange}
      />

      <Text size={11} color={theme['c-500']} style={styles.tip}>
        {tab === 'download'
          ? '软件内下载的音乐，离线可播放'
          : `下载目录下的「${getLocalDirName()}」文件夹，把音频放进来即可离线播放，支持同名 .lrc 歌词`}
      </Text>
    </>
  )

  return (
    // 根 View 给 SwipeBackArea 一个铺满的定位父级（与排行榜页/歌单页同构）
    <View style={{ flex: 1 }}>
      <LandscapeDetailLayout
        header={isHorizontal ? pageHeader : null}
        body={
          <View style={styles.listArea}>
            {/* 【第 21 轮·图七】竖屏：页头固定在列表**外面**（列表的兄弟节点），列表只占
                页头下面那块 —— WebDAV 布局「标题 → 按钮 → 列表」，也避开 iOS 给贴安全区
                滚动视图自动加的顶部 contentInset（本机 62pt，此前标题被这层 inset 推走/
                吞掉）。横屏仍走 LandscapeDetailLayout 左栏（header 槽）。 */}
            {!isHorizontal && pageHeader}
            {tab === 'download' ? (
              <FlatList
                style={styles.list}
                data={completedTasks}
                contentContainerStyle={{ paddingBottom: bottomInset }}
                key={isHorizontal ? 'horizontal' : 'vertical'}
                numColumns={isHorizontal ? 2 : 1}
                columnWrapperStyle={isHorizontal ? styles.columnWrapper : undefined}
                keyExtractor={item => item.id}
                // 限制渲染窗口减负；removeClippedSubviews 必须关闭：iOS 上新增行（下载刚完成
                // 的歌曲进场）的离屏视图复用会让整行渲染成空白/白底，直到下一次重渲（点一下）
                // 才恢复（用户第 11 轮第 12 条）。仓库内同类列表均已按此口径关闭。
                initialNumToRender={20}
                windowSize={5}
                maxToRenderPerBatch={10}
                removeClippedSubviews={false}
                updateCellsBatchingPeriod={50}
                renderItem={renderDownloadItem}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text color={theme['c-500']}>{loading ? '加载中...' : t('no_item')}</Text>
                  </View>
                }
              />
            ) : (
              <FlatList
                style={styles.list}
                data={localFiles}
                contentContainerStyle={{ paddingBottom: bottomInset }}
                key={isHorizontal ? 'horizontal' : 'vertical'}
                numColumns={isHorizontal ? 2 : 1}
                columnWrapperStyle={isHorizontal ? styles.columnWrapper : undefined}
                keyExtractor={item => item.id}
                initialNumToRender={20}
                windowSize={5}
                maxToRenderPerBatch={10}
                // 同上：iOS 上开启离屏摘除会让新扫描/新下载进场的行整行变白，关闭
                removeClippedSubviews={false}
                updateCellsBatchingPeriod={50}
                renderItem={renderLocalItem}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text color={theme['c-500']}>{loading ? '正在扫描...' : `「${getLocalDirName()}」文件夹为空`}</Text>
                  </View>
                }
              />
            )}

            {selecting && (
              <View
                style={[
                  styles.selectBar,
                  {
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: theme['c-border-background'],
                    backgroundColor: theme['c-content-background'],
                    // 悬浮在迷你播放器胶囊上方：胶囊 + tab 栏最高约到 safeAreaBottom + 150
                    bottom: 160 + safeAreaBottom,
                  },
                ]}
              >
                <TouchableOpacity style={[styles.selectBarBtn, { borderRadius: buttonRadius(22) /* 小按钮可见高 ≈ 文字 + 上下 padding 4×2 ≈ 22 */ }]} onPress={toggleSelectAll}>
                  <Text size={designTypography.caption} color={theme['c-primary-font']}>
                    {tab === 'download'
                      ? completedTasks.length > 0 && completedTasks.every(t => selectedIds.has(t.id))
                        ? '取消全选'
                        : '全选'
                      : localFiles.length > 0 && localFiles.every(f => selectedIds.has(f.id))
                        ? '取消全选'
                        : '全选'}
                  </Text>
                </TouchableOpacity>
                <Text size={designTypography.caption} color={theme['c-font-label']} style={{ marginLeft: 'auto' }}>
                  已选 {selectedIds.size} 项
                </Text>
                <TouchableOpacity
                  style={[styles.selectBarBtn, selectedIds.size === 0 && styles.selectBarBtnDisabled, { borderRadius: buttonRadius(22) /* 同「全选」按钮：可见高 ≈ 22 */ }]}
                  onPress={handleDeleteSelected}
                >
                  <Text
                    size={designTypography.caption}
                    color={selectedIds.size === 0 ? theme['c-500'] : theme['c-primary-font']}
                  >
                    删除
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        }
      />
      {/* 【第 21 轮·图七】右滑返回「我的」主界面：铺满整页的右缘手势带（与排行榜页同一条）。
          本页没有二级浮层，直接常开。 */}
      <SwipeBackArea onBack={handleBackToLove} />
    </View>
  )
})

const styles = createStyle({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: designSpacing.sm,
    paddingBottom: designSpacing.xs,
    paddingLeft: designSpacing.md,
    paddingRight: designSpacing.md,
  },
  headerActions: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerBtn: {
    height: 32,
    paddingHorizontal: designSpacing.sm,
    borderRadius: designRadius.pill,
    justifyContent: 'center',
  },
  refreshBtn: {
    height: 32,
    paddingHorizontal: designSpacing.sm,
    borderRadius: designRadius.pill,
    justifyContent: 'center',
  },
  // 【第 21 轮·图七】原 tabs / tabItem / tabItemActive（整宽分段条：h38 + 发丝边框 +
  // overflow hidden + 每项 flex:1）已删除：下载/本地切换改用共享 PillTabs（几何来自 WebDAV，
  // 见组件注释），与酷狗歌单 / QQ歌单 / WebDAV 同一份胶囊几何。
  tip: {
    paddingLeft: designSpacing.md,
    paddingRight: designSpacing.md,
    paddingBottom: designSpacing.sm,
  },
  columnWrapper: {
    paddingHorizontal: 8,
  },
  itemWrapper: {
    flex: 1,
    maxWidth: '50%',
  },
  songItem: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 62,
    marginHorizontal: designSpacing.md,
    marginBottom: designSpacing.sm,
    paddingHorizontal: designSpacing.md,
    borderWidth: 1,
    borderRadius: designRadius.lg,
  },
  songTitle: {
    fontWeight: '600',
  },
  itemInfo: {
    flex: 1,
    gap: 4,
  },
  empty: {
    paddingTop: 60,
    alignItems: 'center',
  },
  listArea: {
    flex: 1,
    // selectBar 绝对定位的参照容器
    position: 'relative',
  },
  list: {
    flex: 1,
  },
  selectBar: {
    position: 'absolute',
    left: designSpacing.md,
    right: designSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: designSpacing.sm,
    paddingHorizontal: designSpacing.sm,
    borderRadius: designRadius.lg,
  },
  selectBarBtn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  selectBarBtnDisabled: {
    opacity: 0.5,
  },
  selectedMark: {
    width: 22,
    height: 22,
    marginLeft: designSpacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
