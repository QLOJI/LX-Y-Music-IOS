import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import { PULL_SETTLE_MS } from '@/components/common/usePullRefresh'
import { clearListDetail, getListDetail, setListDetail, setListDetailInfo } from '@/core/songlist'
import songlistState from '@/store/songlist/state'
import { handlePlay } from './listAction'
import { useListInfo } from './state'
import { type DetailInfo } from '@/screens/SonglistDetail/Header.tsx'
import playerState from '@/store/player/state'
import { LIST_IDS } from '@/config/constant'
import listState from '@/store/list/state'
import { getListMusics } from '@/core/list'
import { getTopSourceInfo } from '@/core/playListToDefault'
import txUserApi from '@/utils/musicSdk/tx/user'
import { log } from '@/utils/log'
import { decodeName } from '@/utils/index'
import { useSettingValue } from '@/store/setting/hook'
import { useKgSubscribedPlaylists, useTxSubscribedPlaylists, useWySubscribedPlaylists, useWyUid } from '@/store/user/hook'

export interface MusicListProps {
  componentId: string
  isCreator: boolean
  onListUpdate: OnlineListProps['onListUpdate']
  playingId: string | null
  searchText: string
  isFuzzySearch: boolean
}

export interface MusicListType {
  loadList: (source: LX.OnlineSource, listId: string, isRefresh?: boolean) => Promise<DetailInfo>
  scrollToInfo: (info: LX.Music.MusicInfoOnline) => void
  addSongToList: (rawSong: any) => void
}

export default forwardRef<MusicListType, MusicListProps>(({ componentId, isCreator, playingId, searchText, isFuzzySearch }, ref) => {
  const listRef = useRef<OnlineListType>(null)
  const isUnmountedRef = useRef(false)
  const info = useListInfo()
  const [txIsUserCreated, setTxIsUserCreated] = useState(false)
  const [kgIsUserCreated, setKgIsUserCreated] = useState(false)
  const fullListRef = useRef<LX.Music.MusicInfoOnline[]>([])

  const filterList = useCallback((list: LX.Music.MusicInfoOnline[], keyword: string, fuzzy = false) => {
    if (!keyword.trim()) return list
    const textLower = keyword.trim().toLowerCase()
    if (!fuzzy) {
      // 严格模式：精确子串匹配
      return list.filter(song =>
        song.name?.toLowerCase().includes(textLower) ||
        song.singer?.toLowerCase().includes(textLower) ||
        (song as any).meta?.albumName?.toLowerCase().includes(textLower),
      )
    }
    // 模糊模式：允许字符间有间隔
    const chars = textLower.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/, '\\$&'))
    const regex = new RegExp(chars.join('.*'), 'i')
    return list.filter(song => {
      const str = `${song.name}${song.singer}${(song as any).meta?.albumName || ''}`
      return regex.test(str)
    })
  }, [])

  useEffect(() => {
    if (fullListRef.current.length > 0) {
      const filtered = searchText.trim() ? filterList(fullListRef.current, searchText, isFuzzySearch) : fullListRef.current
      listRef.current?.setList(filtered)
    }
  }, [searchText, isFuzzySearch, filterList])

  useEffect(() => {
    if (info.source === 'tx') {
      txUserApi.getUserPlaylists().then(playlists => {
        const targetPlaylist = playlists.find((p: any) => String(p.id) === String(info.id))
        if (targetPlaylist && !targetPlaylist.isCollected) {
          setTxIsUserCreated(true)
        } else {
          setTxIsUserCreated(false)
        }
      }).catch(() => {
        setTxIsUserCreated(false)
      })
    } else {
      setTxIsUserCreated(false)
    }
  }, [info.source, info.id])

  useEffect(() => {
    if (info.source === 'kg') {
      setKgIsUserCreated(true)
    } else {
      setKgIsUserCreated(false)
    }
  }, [info.source, info.id])

  const finalIsCreator = info.source === 'tx' ? txIsUserCreated : info.source === 'kg' ? kgIsUserCreated : isCreator

  // 自己的歌单（我喜欢 / 自建）里的歌，在平台本来就已经「添加」——整页显示实心红心。
  // 数据来源：当前歌单是否属于本人（wy 比较 creator.userId 与 uid；tx/kg 查已加载的
  // 自建歌单集合，收藏的不算），且对应平台 cookie 存在（cookie 失效则不显示红心）。
  const wyCookie = useSettingValue('common.wy_cookie')
  const txCookie = useSettingValue('common.tx_cookie')
  const kgCookie = useSettingValue('common.kg_cookie')
  const wyUid = useWyUid()
  const wyPlaylists = useWySubscribedPlaylists()
  const txPlaylists = useTxSubscribedPlaylists()
  const kgPlaylists = useKgSubscribedPlaylists()
  const isOwnPlaylist = useMemo(() => {
    if (info.isFavorites) return true
    switch (info.source) {
      case 'wy': {
        if (info.userId != null && wyUid != null && String(info.userId) === String(wyUid)) return true
        return wyPlaylists.some((p: any) =>
          String(p.id) === String(info.id) &&
          String(p.creator?.userId ?? p.userId ?? '') === String(wyUid))
      }
      case 'tx': {
        if (txIsUserCreated) return true
        const target = String(info.id).replace(/^tx__/, '')
        return txPlaylists.some(p => String(p.id).replace(/^tx__/, '') === target && !p.isCollected)
      }
      case 'kg': {
        return kgPlaylists.some(p =>
          (String(p.id) === String(info.id) || String(p.listid) === String(info.id)) && !p.isCollected)
      }
      default:
        return false
    }
  }, [info.isFavorites, info.source, info.id, info.userId, wyUid, wyPlaylists, txPlaylists, kgPlaylists, txIsUserCreated])
  const forceLiked = isOwnPlaylist && (info.source === 'wy' ? !!wyCookie : info.source === 'tx' ? !!txCookie : info.source === 'kg' ? !!kgCookie : false)

  useImperativeHandle(
    ref,
    () => ({
      async loadList(source, id, isRefresh = false) {
        if (global.lx.isEnableLog) console.log('[SonglistDetail] loadList', { source, id, isRefresh })
        clearListDetail()
        const listDetailInfo = songlistState.listDetailInfo
        const createDetailInfo = (detail: typeof listDetailInfo.info): DetailInfo => ({
          name: (info.name || detail.name) ?? '',
          desc: detail.desc || info.desc || '',
          // 用 || 而不是 ??：酷狗/腾讯推荐歌单的入口把 play_count 写死成 0（占位），
          // 0 不是 null/undefined，?? 不会回退，于是 formatPlayCountText(0) 返回空串 ——
          // 详情页左上角封面右上角的播放量小标就直接消失了（用户点名的「数字不显示」）。
          playCount: info.play_count || detail.play_count || '',
          imgUrl: info.img ?? detail.img,
          userId: info.userId || detail.userId,
          total: listDetailInfo.total,
        })

        if (
          listDetailInfo.id === id &&
          listDetailInfo.source === source &&
          listDetailInfo.list.length
        ) {
          if (global.lx.isEnableLog) log.info('[SonglistDetail] loadList cache hit', { listCount: listDetailInfo.list.length })
          requestAnimationFrame(() => {
            fullListRef.current = listDetailInfo.list
            listRef.current?.setList(listDetailInfo.list)
          })
          return Promise.resolve(createDetailInfo(listDetailInfo.info))
        }

        listRef.current?.setStatus('loading')
        const page = 1
        setListDetailInfo(info.source, info.id)
        if (global.lx.isEnableLog) log.info('[SonglistDetail] loadList start', { source, id, page, isRefresh })
        return getListDetail(id, source, page, isRefresh)
          .then((listDetail) => {
            if (global.lx.isEnableLog) log.info('[SonglistDetail] loadList got data', { songCount: listDetail.list.length, total: listDetail.total })
            const result = setListDetail(listDetail, id, page)
            if (isUnmountedRef.current) return createDetailInfo(result.info)
            const filtered = searchText.trim() ? filterList(result.list, searchText) : result.list
            requestAnimationFrame(() => {
              fullListRef.current = result.list
              listRef.current?.setList(filtered)
              listRef.current?.setStatus(
                songlistState.listDetailInfo.maxPage <= page ? 'end' : 'idle',
              )
            })
            return createDetailInfo(result.info)
          })
          .catch((err) => {
            if (global.lx.isEnableLog) log.info('[SonglistDetail] loadList error', { error: err?.message })
            if (songlistState.listDetailInfo.list.length && page === 1) clearListDetail()
            listRef.current?.setStatus('error')
            throw err
          })
      },
      scrollToInfo(targetInfo) {
        const currentList = songlistState.listDetailInfo.list
        if (currentList.some(s => s.id === targetInfo.id)) {
          listRef.current?.scrollToInfo(targetInfo)
          return
        }

        const currentListId = `${songlistState.listDetailInfo.source}__${songlistState.listDetailInfo.id}`
        let playingListId = playerState.playMusicInfo.listId
        let fromDefaultTop = false
        let defaultTopLen = 0
        if (playingListId === LIST_IDS.TEMP) {
          playingListId = listState.tempListMeta.id
        } else if (playingListId === LIST_IDS.DEFAULT) {
          // 歌单点歌整份写入试听列表(DEFAULT)后，源列表 id 与「完整列表」都记录在
          // playListToDefault 的顶部这一段里：完整列表 = 试听列表顶部 top.len 首。
          // 若顶部这一段已不是任何源列表（如手动整理过试听列表）就维持原样，下面的
          // 匹配不成立、直接跳过——还有 currentList.some(targetInfo) 的存在性校验兜底。
          const top = getTopSourceInfo()
          if (top.id) {
            playingListId = top.id
            fromDefaultTop = true
            defaultTopLen = top.len
          }
        }

        if (playingListId === currentListId) {
          const promise = fromDefaultTop
            ? getListMusics(LIST_IDS.DEFAULT).then(fullList => (fullList as LX.Music.MusicInfoOnline[]).slice(0, defaultTopLen))
            : getListMusics(LIST_IDS.TEMP).then(fullList => fullList as LX.Music.MusicInfoOnline[])
          void promise.then(castedList => {
            if (castedList.some(s => s.id === targetInfo.id)) {
              songlistState.listDetailInfo.list = castedList
              fullListRef.current = castedList
              const filtered = filterList(castedList, searchText)
              listRef.current?.setList(filtered)
              setTimeout(() => {
                listRef.current?.scrollToInfo(targetInfo)
              }, 200)
            }
          })
        }
      },
      addSongToList(rawSong: any) {
        const song: LX.Music.MusicInfoOnline = {
          id: `kg__${rawSong.hash || rawSong.audio_id}`,
          name: decodeName(rawSong.name || rawSong.songname || '').replace(/\.mp3$/i, ''),
          singer: decodeName(rawSong.singerinfo?.map((s: any) => s.name).join('、') || rawSong.singername || ''),
          albumName: decodeName(rawSong.album_name || ''),
          albumId: String(rawSong.album_id || ''),
          songmid: String(rawSong.audio_id || rawSong.hash || ''),
          source: 'kg',
          interval: rawSong.duration ? rawSong.duration + 's' : '',
          img: rawSong.cover ? rawSong.cover.replace('{size}', '400') : '',
          hash: rawSong.hash || '',
          mixsongid: rawSong.mixsongid || 0,
          fileId: rawSong.fileid || 0,
        } as any
        const currentList = [...songlistState.listDetailInfo.list]
        if (!currentList.some(s => s.id === song.id)) {
          currentList.push(song)
          songlistState.listDetailInfo.list = currentList
          songlistState.listDetailInfo.total = currentList.length
          fullListRef.current = currentList
          const filtered = filterList(currentList, searchText)
          listRef.current?.setList(filtered)
          log.info(`[乐观更新] 已添加歌曲到列表: ${song.name}, 当前共 ${currentList.length} 首`)
        }
      },
    }),
    [filterList, info.desc, info.img, info.name, info.play_count, info.source, info.id, info.userId, searchText],
  )

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const handlePlayList: OnlineListProps['onPlayList'] = (index) => {
    const listDetailInfo = songlistState.listDetailInfo
    void handlePlay(listDetailInfo.id, listDetailInfo.source, listDetailInfo.list, index)
  }

  const handleRefresh: OnlineListProps['onRefresh'] = () => {
    const page = 1
    // 记录松手时刻：新列表要等回弹落定后再替换，否则替换引起的 contentSize 变化会把
    // 回弹中的负偏移夹回 0，表现为「松手后列表被往上拽一下」。
    const refreshStartedAt = Date.now()
    listRef.current?.setStatus('refreshing')
    getListDetail(songlistState.listDetailInfo.id, songlistState.listDetailInfo.source, page, true)
      .then((listDetail) => {
        const result = setListDetail(listDetail, songlistState.listDetailInfo.id, page)
        if (isUnmountedRef.current) return
        const apply = () => {
          if (isUnmountedRef.current) return
          fullListRef.current = result.list
          const filtered = filterList(result.list, searchText)
          listRef.current?.setList(filtered)
          listRef.current?.setStatus(songlistState.listDetailInfo.maxPage <= page ? 'end' : 'idle')
        }
        const remain = PULL_SETTLE_MS - (Date.now() - refreshStartedAt)
        if (remain > 0) setTimeout(apply, remain)
        else apply()
      })
      .catch(() => {
        if (songlistState.listDetailInfo.list.length && page == 1) clearListDetail()
        listRef.current?.setStatus('error')
      })
  }

  const handleLoadMore: OnlineListProps['onLoadMore'] = () => {
    listRef.current?.setStatus('loading')
    const page = songlistState.listDetailInfo.list.length
      ? songlistState.listDetailInfo.page + 1
      : 1
    getListDetail(songlistState.listDetailInfo.id, songlistState.listDetailInfo.source, page)
      .then((listDetail) => {
        const result = setListDetail(listDetail, songlistState.listDetailInfo.id, page)
        if (isUnmountedRef.current) return
        // 追加新数据并按 ID 去重
        const existingIds = new Set(fullListRef.current.map(m => m.id))
        const newSongs = result.list.filter(m => !existingIds.has(m.id))
        fullListRef.current = [...fullListRef.current, ...newSongs]
        // 同步更新列表显示
        const filtered = searchText.trim() ? filterList(fullListRef.current, searchText) : fullListRef.current
        listRef.current?.setList(filtered)
        listRef.current?.setStatus(songlistState.listDetailInfo.maxPage <= page ? 'end' : 'idle')
      })
      .catch(() => {
        if (songlistState.listDetailInfo.list.length && page == 1) clearListDetail()
        listRef.current?.setStatus('error')
      })
  }

  const handleListUpdate = useCallback((newList: LX.Music.MusicInfoOnline[]) => {
    if (isUnmountedRef.current) return
    songlistState.listDetailInfo.list = newList
  }, [])

  // 自己的歌单里取消红心：立即把该歌曲从当前列表移除（乐观更新），不用再下拉刷新。
  const handleUnlike = useCallback((song: LX.Music.MusicInfoOnline) => {
    const next = fullListRef.current.filter(s => s.id !== song.id)
    if (next.length === fullListRef.current.length) return
    fullListRef.current = next
    const filtered = searchText.trim() ? filterList(next, searchText, isFuzzySearch) : next
    listRef.current?.setList(filtered)
  }, [filterList, searchText, isFuzzySearch])

  return (
    <OnlineList componentId={componentId}
                ref={listRef}
                onPlayList={handlePlayList}
                onRefresh={handleRefresh}
                onLoadMore={handleLoadMore}
                onListUpdate={handleListUpdate}
                forcePlayList={true}
                listId={`${info.source}__${info.id}`}
                isCreator={finalIsCreator}
                playingId={playingId}
                // 自绘停留位（60/60）：停留空白平时不存在，下拉达标松手后才生成，
                // 刷新收尾收回；停留画面有 1.2s 硬性最短显示。
                // lockHold：松手回弹越过 60pt 线后把列表钉住，空白不会小于 60pt。所有歌单一致。
                lockHold
                // 自己的歌单：整页歌曲显示实心红心（cookie 存在才生效）。
                forceLiked={forceLiked}
                // 自己的歌单里取消红心 → 立即移除该行。
                onUnlike={forceLiked ? handleUnlike : undefined}
    />
  )
})
