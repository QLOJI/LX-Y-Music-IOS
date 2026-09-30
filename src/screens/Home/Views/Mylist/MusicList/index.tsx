import { useCallback, useRef } from 'react'

import listState from '@/store/list/state'
import ListMenu, { type ListMenuType, type Position, type SelectInfo } from './ListMenu'
import {
  handleDislikeMusic,
  handlePlay,
  handlePlayLater,
  handleRemove,
  handleUpdateMusicInfo,
  handleUpdateMusicPosition,
  handleClearMusicCache,
} from './listAction'
import List, { type ListType } from './List'
import ListMusicAdd, {
  type MusicAddModalType as ListMusicAddType,
} from '@/components/MusicAddModal'
import ListMusicMultiAdd, {
  type MusicMultiAddModalType as ListAddMultiType,
} from '@/components/MusicMultiAddModal'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'
import { type LayoutChangeEvent, View } from 'react-native'
import ActiveList, { type ActiveListType } from './ActiveList'
import MultipleModeBar, { type SelectMode, type MultipleModeBarType } from './MultipleModeBar'
import ListSearchBar, { type ListSearchBarType } from './ListSearchBar'
import ListMusicSearch, { type ListMusicSearchType } from './ListMusicSearch'
import MusicPositionModal, { type MusicPositionModalType } from './MusicPositionModal'
import MetadataEditModal, {
  type MetadataEditType,
  type MetadataEditProps,
} from '@/components/MetadataEditModal'
import { downloadMusic } from '@/core/download'
import MusicToggleModal, { type MusicToggleModalType } from './MusicToggleModal'
import { handleShowAlbumDetail, handleShowArtistDetail } from '@/components/OnlineList/listAction.ts'
import { useSettingValue } from '@/store/setting/hook.ts'
import { updateSetting } from '@/core/common.ts'
import commonState from '@/store/common/state'
import { useStatusbarHeight } from '@/store/common/hook'
import SimilarSongsModal, { type SimilarSongsModalType } from '@/components/SimilarSongsModal'

export interface MusicListProps {
  onBack?: () => void
  /** 指定要展示的列表 id。传入时优先于持久化的「上次选中列表」。 */
  listId?: string
}

// 顶部固定槽位顶边的额外间距：必须与「设置 → 基本设置」页的返回按钮对齐
// （src/screens/SettingDetail/index.tsx 里 header 的 `paddingTop: statusBarHeight + designSpacing.sm`）。
// statusBarHeight 一律用 useStatusbarHeight()，它内部已含全局 +6pt 偏移，两处都不要再加第二次。
// 之所以既留常量又必须「内联写进 style」而不是放进 createStyle：
// createStyle/trasformeStyle 会按 global.lx.fontSize 缩放 paddingTop，而基本设置页那处是
// 不缩放的内联值——一旦被缩放，用户调大字号后这里的返回栏就会比设置页返回按钮低一截
// （槽位内的栏高 44 走 createStyle 与设置页按钮的 44 同口径缩放，两边中心才始终同高）。
const BAR_SLOT_ALIGN_PADDING_TOP = designSpacing.sm

export default ({ onBack, listId }: MusicListProps) => {
  const statusBarHeight = useStatusbarHeight()
  const activeListRef = useRef<ActiveListType>(null)
  const listMusicSearchRef = useRef<ListMusicSearchType>(null)
  const listRef = useRef<ListType>(null)
  const multipleModeBarRef = useRef<MultipleModeBarType>(null)
  const listSearchBarRef = useRef<ListSearchBarType>(null)
  const listMusicAddRef = useRef<ListMusicAddType>(null)
  const listMusicMultiAddRef = useRef<ListAddMultiType>(null)
  const musicPositionModalRef = useRef<MusicPositionModalType>(null)

  const metadataEditTypeRef = useRef<MetadataEditType>(null)
  const listMenuRef = useRef<ListMenuType>(null)
  const musicToggleModalRef = useRef<MusicToggleModalType>(null)
  const similarSongsModalRef = useRef<SimilarSongsModalType>(null)
  const layoutHeightRef = useRef<number>(0)
  const isShowMultipleModeBar = useRef(false)
  const isShowSearchBarModeBar = useRef(false)
  const selectedInfoRef = useRef<SelectInfo>()

  const showCover = useSettingValue('list.isShowCover')
  const handleToggleView = useCallback(() => {
    updateSetting({ 'list.isShowCover': !showCover })
  }, [showCover])

  const hancelMultiSelect = useCallback(() => {
    if (isShowSearchBarModeBar.current) {
      multipleModeBarRef.current?.setVisibleBar(false)
    } else activeListRef.current?.setVisibleBar(false)
    isShowMultipleModeBar.current = true
    multipleModeBarRef.current?.show()
    listRef.current?.setIsMultiSelectMode(true)
  }, [])
  const hancelExitSelect = useCallback(() => {
    if (isShowSearchBarModeBar.current) {
      multipleModeBarRef.current?.setVisibleBar(true)
    } else activeListRef.current?.setVisibleBar(true)
    multipleModeBarRef.current?.exitSelectMode()
    listRef.current?.setIsMultiSelectMode(false)
    isShowMultipleModeBar.current = false
  }, [])
  const hancelSwitchSelectMode = useCallback((mode: SelectMode) => {
    multipleModeBarRef.current?.setSwitchMode(mode)
    listRef.current?.setSelectMode(mode)
  }, [])
  const hancelScrollToTop = useCallback(() => {
    listRef.current?.scrollToTop()
  }, [])
  const handleShowArtist = useCallback((info: SelectInfo) => {
    if (info.musicInfo.source !== 'local') {
      void handleShowArtistDetail(commonState.componentIds[commonState.componentIds.length - 1]?.id, info.musicInfo)
    }
  }, [])

  const handleShowAlbum = useCallback((info: SelectInfo) => {
    if (info.musicInfo.source !== 'local') {
      handleShowAlbumDetail(commonState.componentIds[commonState.componentIds.length - 1]?.id, info.musicInfo)
    }
  }, [])

  const showMenu = useCallback(
    (musicInfo: LX.Music.MusicInfo, index: number, position: Position) => {
      listMenuRef.current?.show(
        {
          musicInfo,
          index,
          listId: listState.activeListId,
          single: false,
          selectedList: listRef.current!.getSelectedList(),
        },
        position,
      )
    },
    [],
  )
  const handleShowSearch = useCallback(() => {
    isShowSearchBarModeBar.current = true
    if (isShowMultipleModeBar.current) {
      multipleModeBarRef.current?.setVisibleBar(false)
    } else activeListRef.current?.setVisibleBar(false)
    listSearchBarRef.current?.show()
  }, [])
  const handleExitSearch = useCallback(() => {
    isShowSearchBarModeBar.current = false
    listMusicSearchRef.current?.hide()
    listSearchBarRef.current?.hide()
    if (isShowMultipleModeBar.current) {
      multipleModeBarRef.current?.setVisibleBar(true)
    } else activeListRef.current?.setVisibleBar(true)
  }, [])
  const handleScrollToInfo = useCallback(
    (info: LX.Music.MusicInfo) => {
      listRef.current?.scrollToInfo(info)
      handleExitSearch()
    },
    [handleExitSearch],
  )
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    layoutHeightRef.current = e.nativeEvent.layout.height
  }, [])

  const handleAddMusic = useCallback((info: SelectInfo) => {
    if (info.selectedList.length) {
      listMusicMultiAddRef.current?.show({
        selectedList: info.selectedList,
        listId: info.listId,
        isMove: false,
      })
    } else {
      listMusicAddRef.current?.show({
        musicInfo: info.musicInfo,
        listId: info.listId,
        isMove: false,
      })
    }
  }, [])
  const handleMoveMusic = useCallback((info: SelectInfo) => {
    if (info.selectedList.length) {
      listMusicMultiAddRef.current?.show({
        selectedList: info.selectedList,
        listId: info.listId,
        isMove: true,
      })
    } else {
      listMusicAddRef.current?.show({
        musicInfo: info.musicInfo,
        listId: info.listId,
        isMove: true,
      })
    }
  }, [])
  const handleEditMetadata = useCallback((info: SelectInfo) => {
    if (info.musicInfo.source != 'local') return
    selectedInfoRef.current = info
    metadataEditTypeRef.current?.show(info.musicInfo.meta.filePath)
  }, [])
  const handleUpdateMetadata = useCallback<MetadataEditProps['onUpdate']>((info) => {
    if (!selectedInfoRef.current || selectedInfoRef.current.musicInfo.source != 'local') return
    handleUpdateMusicInfo(selectedInfoRef.current.listId, selectedInfoRef.current.musicInfo, info)
  }, [])

  return (
    <View style={styles.container}>
      {/*
        顶部固定槽位：返回栏 / 多选栏 / 搜索栏三根横条共用这一个槽位，不随歌曲列表滚动。
        改动前的结构是三根横条分属两套定位体系：返回栏被塞进 <List> 的 ListHeaderComponent
        （跟着列表一起滚走、顶边由 PageTopInset 的 max(12, statusBarHeight-16) 决定），
        搜索栏/多选栏则各自绝对定位在别的容器上——所以进入详情、点搜索时顶部栏位置会跳。
        收敛到同一个槽位后：正常流里只有 ActiveList（高度撑起槽位），另外两条栏都是
        absolute top:0/height:100%，互相替换时位置天然一致（与 REF 工程同构）。
      */}
      <View
        style={{ ...styles.fixedBar, paddingTop: statusBarHeight + BAR_SLOT_ALIGN_PADDING_TOP }}
      >
        <View style={styles.barSlot}>
          <ActiveList
            ref={activeListRef}
            onShowSearchBar={handleShowSearch}
            onScrollToTop={hancelScrollToTop}
            showCover={showCover}
            onToggleView={handleToggleView}
            onBack={onBack}
          />
          <MultipleModeBar
            ref={multipleModeBarRef}
            onSwitchMode={hancelSwitchSelectMode}
            onSelectAll={(isAll) => listRef.current?.selectAll(isAll)}
            onExitSelectMode={hancelExitSelect}
          />
          <ListSearchBar
            ref={listSearchBarRef}
            onSearch={(keyword) =>
              listMusicSearchRef.current?.search(keyword, layoutHeightRef.current)
            }
            onExitSearch={handleExitSearch}
          />
        </View>
      </View>
      <View style={{ flex: 1 }} onLayout={onLayout}>
        <List
          ref={listRef}
          listId={listId}
          onShowMenu={showMenu}
          onMuiltSelectMode={hancelMultiSelect}
          onSelectAll={(isAll) => multipleModeBarRef.current?.setIsSelectAll(isAll)}
          showCover={showCover}
        />
        <ListMusicSearch ref={listMusicSearchRef} onScrollToInfo={handleScrollToInfo} />
      </View>
      <ListMusicAdd ref={listMusicAddRef} onAdded={hancelExitSelect} />
      <ListMusicMultiAdd ref={listMusicMultiAddRef} onAdded={hancelExitSelect} />
      <MusicPositionModal
        ref={musicPositionModalRef}
        onUpdatePosition={(info, postion) => {
          handleUpdateMusicPosition(
            postion,
            info.listId,
            info.musicInfo,
            info.selectedList,
            hancelExitSelect,
          )
        }}
      />
      <ListMenu
        ref={listMenuRef}
        onPlay={(info) => {
          handlePlay(info.listId, info.index)
        }}
        onPlayLater={(info) => {
          hancelExitSelect()
          handlePlayLater(info.listId, info.musicInfo, info.selectedList, hancelExitSelect)
        }}
        onRemove={(info) => {
          hancelExitSelect()
          handleRemove(info.listId, info.musicInfo, info.selectedList, hancelExitSelect)
        }}
        onDislikeMusic={(info) => {
          void handleDislikeMusic(info.musicInfo)
        }}
        onDownload={(info) => { downloadMusic(info.musicInfo) }}
        onAdd={handleAddMusic}
        onMove={handleMoveMusic}
        onEditMetadata={handleEditMetadata}
        onChangePosition={(info) => musicPositionModalRef.current?.show(info)}
        onToggleSource={(info) => musicToggleModalRef.current?.show(info)}
        onArtistDetail={handleShowArtist}
        onAlbumDetail={handleShowAlbum}
        onSimilarSongs={(info) => {
          similarSongsModalRef.current?.show(info.musicInfo)
        }}
        onClearCache={(info) => {
          void handleClearMusicCache(info.musicInfo)
        }}
      />
      <MetadataEditModal ref={metadataEditTypeRef} onUpdate={handleUpdateMetadata} />
      <MusicToggleModal ref={musicToggleModalRef} />
      <SimilarSongsModal ref={similarSongsModalRef} />
    </View>
  )
}

const styles = createStyle({
  container: {
    flex: 1,
    flexDirection: 'column',
  },
  // 固定槽位外框：左右/下内边距与「设置 → 基本设置」header 同源（都是 designSpacing.sm=12），
  // 再叠加槽内的返回栏，返回按钮与返回栏就落在同一个视觉坐标系里。
  // 注意这里【不能】写 paddingTop：createStyle 会按 global.lx.fontSize 缩放它，
  // 而顶边必须用与设置页一致的不缩放公式——paddingTop 内联在上面的 JSX 里。
  fixedBar: {
    zIndex: 2,
    paddingHorizontal: designSpacing.sm,
    paddingBottom: designSpacing.sm,
  },
  // 槽位本体（相对定位）：高度由正常流里的 ActiveList 撑起（44，与设置页返回按钮同高），
  // MultipleModeBar / ListSearchBar 都是 absolute top:0/height:100%，精确铺满本槽位，
  // 所以三根横条换来换去都不会跳位。ActiveList 用 opacity 隐形而不是卸载，槽位高度才不会塌。
  barSlot: {
    position: 'relative',
  },
})
