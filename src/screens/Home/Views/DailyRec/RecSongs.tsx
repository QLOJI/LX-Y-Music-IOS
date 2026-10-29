import { memo, useEffect, useRef, useCallback, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import OnlineList, { type OnlineListType } from '@/components/OnlineList'
import wyApi from '@/utils/musicSdk/wy'
import musicDetailApi from '@/utils/musicSdk/wy/musicDetail'
import { useSettingValue } from '@/store/setting/hook'
import { toast } from '@/utils/tools'
import { useI18n } from '@/lang'
import { autoSaveDailyPlaylist, handlePlay } from './listAction'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { useTheme } from '@/store/theme/hook'
import { useButtonRadius } from '@/utils/buttonRadius'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import {
  getDailyRecCache,
  saveDailyRecCache,
  clearDailyRecCache,
} from '@/utils/data'
import { useHomePageVisible } from '@/store/common/pageVisibility'


import type { StylizedSelection } from './StylizedModal'

const BATCH_SIZE = 8
// 失败后退避窗口：effect 依赖含 isLoading，失败时 setIsLoading(false) 会再次触发 effect，
// 同一输入的重复触发在窗口内直接跳过，避免「失败→重跑→再失败」的即时重试风暴
const LOAD_FAIL_BACKOFF = 3000

const similarSongsFetcher = {
  isFetching: false,
  currentDailyRecId: null as string | null,
}

interface RecSongsProps {
  isStylized?: boolean
  stylizedSelection?: StylizedSelection | null
  /** 当前 tab：每次切到本 tab 都自动下拉刷新（保留原列表）。 */
  active?: boolean
}

export default memo(({ isStylized, stylizedSelection, active = true }: RecSongsProps) => {
  const listRef = useRef<OnlineListType>(null)
  const unmountedRef = useRef(false)
  // 离屏 Home 页重新进入时也刷新当前 tab（pageVisible false→true 的上升沿）。
  const pageVisible = useHomePageVisible()
  const [enterSeq, setEnterSeq] = useState(0)
  const prevPageVisibleRef = useRef(pageVisible)
  useEffect(() => {
    if (pageVisible && !prevPageVisibleRef.current) setEnterSeq(v => v + 1)
    prevPageVisibleRef.current = pageVisible
  }, [pageVisible])
  const [isLoading, setIsLoading] = useState(true)
  // 当前列表对应的「数据源」标识：普通日推 = cookie，风格化 = cookie + 选中标签。
  // 标识变了（换风格 / 换账号）必须重新加载，哪怕旧列表还有数据。
  const loadKeyRef = useRef('')
  const t = useI18n()
  const cookie = useSettingValue('common.wy_cookie')
  const playerMusicInfo = usePlayerMusicInfo()
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  const [isAllSimilarSongsFetched, setIsAllSimilarSongsFetched] = useState(false)

  // 卸载时停止后台相似歌曲预取任务，避免切走后仍跑网络请求/磁盘读写造成卡顿
  useEffect(() => {
    return () => {
      unmountedRef.current = true
      similarSongsFetcher.isFetching = false
    }
  }, [])

  useEffect(() => {
    if (!active) return

    if (!cookie) {
      if (isLoading) {
        toast(t('wy_cookie_not_set'))
        setIsLoading(false)
      }
      listRef.current?.setList([], false)
      listRef.current?.setStatus('idle')
      return
    }

    // 列表已有数据且数据源没变：只展示，不再自动下拉刷新（第一次刷出后只能手动下拉）。
    // 列表为空（首次进入 / PagerView 恢复重挂后数据丢失）或数据源变了（换风格/换账号）
    // 时必须加载，否则就是空白页或旧内容。
    const loadKey = isStylized && stylizedSelection
      ? `${cookie}|${JSON.stringify(stylizedSelection)}`
      : cookie
    if (loadKeyRef.current === loadKey && (listRef.current?.getList()?.length ?? 0) > 0) return
    loadKeyRef.current = loadKey

    // 首次加载时列表本来就是空的，自然就是「空白 + 刷新」。
    listRef.current?.setStatus('refreshing')
    // 不在这里刷封面缓存：签名计算 + bumpImageEpoch 会重渲所有已挂载图片，
    // 赶上用户下一次点击就是「点了没反应、过一会儿才切页」。手动下拉时 OnlineList 会刷。

    if (isStylized && stylizedSelection) {
      setIsLoading(true)
      wyApi.dailyRec.saveStylizedTag(cookie, stylizedSelection.categoryId, stylizedSelection.tagIds).then(() => {
        return wyApi.dailyRec.getStylizedList(cookie)
      }).then((result: any) => {
        listRef.current?.setList(result.list, false)
        listRef.current?.setStatus('idle')
      }).catch((err: any) => {
        console.error(err)
        toast(t('load_failed'), 'long')
        listRef.current?.setStatus('error')
      }).finally(() => {
        setIsLoading(false)
      })
      return
    }

    setIsLoading(true)
    wyApi.dailyRec.getList(cookie).then(async(result: any) => {
        listRef.current?.setList(result.list, false)
        listRef.current?.setStatus('idle')

        if (!result.list || result.list.length === 0) {
          setIsLoading(false)
          return
        }

        void autoSaveDailyPlaylist(result.list)

        const currentDailyRecId = result.list[0].id

        if (similarSongsFetcher.isFetching) {
          console.log('后台任务已在运行，本次加载跳过')
          return
        }

        similarSongsFetcher.isFetching = true
        similarSongsFetcher.currentDailyRecId = currentDailyRecId
        console.log(`开始处理日推相似歌曲获取任务，日推ID: ${currentDailyRecId}`)
        let cache = await getDailyRecCache()
        if (!cache || cache.dailyRecId !== currentDailyRecId) {
          console.log('缓存不存在或日推ID已变更，重新获取')
          await clearDailyRecCache()
          cache = {
            dailyRecId: currentDailyRecId,
            items: result.list.map((song: any) => ({
              dailySong: song,
              similarSongs: [],
              fetchStatus: 'pending',
            })),
          }
          await saveDailyRecCache(cache)
        }

        const songsToFetch = cache.items.filter(item => item.fetchStatus === 'pending').map(item => item.dailySong)

        if (songsToFetch.length === 0) {
          console.log('所有相似歌曲均已获取，无需操作')
          setIsAllSimilarSongsFetched(true)
          similarSongsFetcher.isFetching = false
          setIsLoading(false)
          return
        }

        console.log(`发现 ${songsToFetch.length} 首歌曲的相似推荐未获取，开始后台任务...`)
        setIsAllSimilarSongsFetched(false)
        const allDailySongIds = new Set(result.list.map((s: any) => s.id))

        const processQueue = async() => {
          if (unmountedRef.current) {
            similarSongsFetcher.isFetching = false
            return
          }
          const batch = songsToFetch.splice(0, BATCH_SIZE)
          if (batch.length === 0) {
            setIsAllSimilarSongsFetched(true)
            similarSongsFetcher.isFetching = false
            console.log('所有相似歌曲批次处理完成。')
            return
          }

          if (similarSongsFetcher.currentDailyRecId !== currentDailyRecId) {
            console.log('日推ID已变更，终止旧的后台任务。')
            similarSongsFetcher.isFetching = false
            return
          }

          const promises = batch.map(song => wyApi.dailyRec.getSimilarSongs(song.meta.songId).catch(() => []))
          const results = await Promise.all(promises)

          const currentCache = await getDailyRecCache()
          if (!currentCache || currentCache.dailyRecId !== currentDailyRecId) return

          for (let i = 0; i < batch.length; i++) {
            const dailySong = batch[i]
            const similarSongsRaw = results[i]
            const cacheItem = currentCache.items.find(item => item.dailySong.id === dailySong.id)

            if (!cacheItem) continue

            if (similarSongsRaw.length > 0) {
              const uniqueSimilarSongs = similarSongsRaw.filter((s: any) => !allDailySongIds.has(s.id))
              uniqueSimilarSongs.forEach((ns: any) => allDailySongIds.add(ns.id))
              if (uniqueSimilarSongs.length > 0) {
                const detailedSongs = await musicDetailApi.filterList({ songs: uniqueSimilarSongs, privileges: [] })
                const existingSimilarIds = new Set(cacheItem.similarSongs.map(s => s.id))
                const songsToAppend = detailedSongs.filter(s => !existingSimilarIds.has(s.id))
                if (songsToAppend.length > 0) {
                  cacheItem.similarSongs.push(...songsToAppend)
                }
              }
            }
            cacheItem.fetchStatus = 'fetched'
          }

          await saveDailyRecCache(currentCache)
          console.log(`批次完成，已更新 ${batch.length} 首歌曲的相似推荐缓存。`)
          if (unmountedRef.current) {
            similarSongsFetcher.isFetching = false
            return
          }
          if (songsToFetch.length > 0) {
            setTimeout(processQueue, 2000)
          } else {
            setIsAllSimilarSongsFetched(true)
            similarSongsFetcher.isFetching = false
            console.log('所有相似歌曲批次处理完成。')
          }
        }

        await processQueue()
      }).catch((err: any) => {
        console.error(err)
        toast(t('load_failed'), 'long')
        listRef.current?.setStatus('error')
      }).finally(() => {
        setIsLoading(false)
      })
  }, [t, cookie, isStylized, stylizedSelection, active, enterSeq])

  useEffect(() => {
    const handleReplaceMusic = (oldMusicInfoId: string, newMusicInfo: LX.Music.MusicInfoOnline | null) => {
      const currentList = listRef.current?.getList()
      if (!currentList) return
      const index = currentList.findIndex(s => s.id === oldMusicInfoId)
      if (index > -1) {
        const newList = [...currentList]
        if (newMusicInfo) {
          newList.splice(index, 1, newMusicInfo)
        } else {
          newList.splice(index, 1)
        }
        listRef.current?.setList(newList, false, false)
      }
    }

    global.list_event.on('daily_rec_music_replace', handleReplaceMusic)
    return () => {
      global.list_event.off('daily_rec_music_replace', handleReplaceMusic)
    }
  }, [])

  const handleRefresh = useCallback(() => {
    if (!cookie) {
      toast(t('wy_cookie_not_set'))
      listRef.current?.setStatus('idle')
      return
    }
    listRef.current?.setStatus('refreshing')

    if (isStylized && stylizedSelection) {
      wyApi.dailyRec.saveStylizedTag(cookie, stylizedSelection.categoryId, stylizedSelection.tagIds).then(() => {
        return wyApi.dailyRec.getStylizedList(cookie)
      }).then((result: any) => {
        listRef.current?.setList(result.list, false)
      }).catch((err: any) => {
        console.error(err)
        toast(t('load_failed'), 'long')
        listRef.current?.setStatus('error')
      }).finally(() => {
        listRef.current?.setStatus('idle')
      })
      return
    }

    wyApi.dailyRec.getList(cookie).then((result: any) => {
      listRef.current?.setList(result.list, false)
      if (result.list && result.list.length > 0) {
        void autoSaveDailyPlaylist(result.list)
      }
    }).catch((err: any) => {
      console.error(err)
      toast(t('load_failed'), 'long')
      listRef.current?.setStatus('error')
    }).finally(() => {
      listRef.current?.setStatus('idle')
    })
  }, [cookie, t, isStylized, stylizedSelection])

  const handleFindMore = async() => {
    const cache = await getDailyRecCache()
    const allSimilarSongs = cache?.items.flatMap(item => item.similarSongs) ?? []

    if (allSimilarSongs.length === 0) {
      toast('暂无相似歌曲推荐')
      return
    }

    const uniqueSongs = Array.from(new Map(allSimilarSongs.map(song => [song.id, song])).values())

    navigations.pushSimilarSongsScreen(commonState.componentIds[commonState.componentIds.length - 1]?.id, uniqueSongs)
  }

  const ListFooter = () => {
    if (isStylized || isLoading || !isAllSimilarSongsFetched) return null
    return (
      <View style={{ alignItems: 'center', padding: 20 }}>
        <TouchableOpacity
          onPress={handleFindMore}
          style={{
            // 「更多相似歌曲」文字按钮圆角随「按钮圆角」设置行内覆盖；可见高度 ≈ 16 = 单行 14 号文字行高 16（无纵向 padding）
            borderRadius: buttonRadius(16),
          }}
        >
          <Text color={theme['c-font']} size={14}>更多相似歌曲</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <View style={{ flex: 1 }}>
      <OnlineList
        ref={listRef}
        listId="dailyrec_wy"
        forcePlayList={true}
        playingId={playerMusicInfo.id}
        onPlayList={(index) => {
          const list = listRef.current?.getList()
          if (!list) return
          handlePlay(list, index)
        }}
        onRefresh={handleRefresh}
        onLoadMore={() => {}}
        checkHomePagerIdle
        ListFooterComponent={ListFooter}
      />
    </View>
  )
})
