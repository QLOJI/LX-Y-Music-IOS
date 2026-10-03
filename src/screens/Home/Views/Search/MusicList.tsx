import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import { search } from '@/core/search/music'
import { stageOnlineListToDefault } from '@/core/playListToDefault'
import searchMusicState, { type Source } from '@/store/search/music/state'

// export type MusicListProps = Pick<OnlineListProps,
// 'onLoadMore'
// | 'onPlayList'
// | 'onRefresh'
// >

export interface MusicListType {
  loadList: (text: string, source: Source) => void
}

export default forwardRef<MusicListType, { header?: OnlineListProps['ListHeaderComponent'] }>(({ header }, ref) => {
  const listRef = useRef<OnlineListType>(null)
  const searchInfoRef = useRef<{ text: string, source: Source }>({ text: '', source: 'kw' })
  const isUnmountedRef = useRef(false)
  useImperativeHandle(
    ref,
    () => ({
      async loadList(text, source) {
        // const listDetailInfo = searchMusicState.listDetailInfo
        // 【第 30 轮·图十】这里原来有一句**无条件**的清空：
        //     listRef.current?.setList([], false, source == 'all')
        // 列表先被清成空，再在一个 requestAnimationFrame 之后从缓存把整份列表设回来 ——
        // 每次切走再切回搜索页（Search/index.tsx 的 navActiveIdUpdated 会调本方法）都会
        // 真的渲染出一帧空列表，用户看到的就是「歌曲区域闪一下」。现在不清了：
        //   · 命中缓存 → 同步设回（List.setList 对同一个数组引用直接跳过，连重渲染都没有）；
        //   · 真要重新搜 → 旧结果留在屏幕上，由 setStatus('loading') 的加载态表示正在查，
        //     新结果到了再整表替换（与下拉刷新的表现一致）。
        // 唯一保留「立刻清空」的是取消搜索（text 为空）：那是用户明确的清空动作，而且清空后
        // 走的就是下面这条空文本分支。
        if (text === '') {
          listRef.current?.setList([], false, source == 'all')
        }
        if (
          searchMusicState.searchText == text &&
          searchMusicState.source == source &&
          searchMusicState.listInfos[searchMusicState.source]!.list.length
        ) {
          listRef.current?.setList(
            searchMusicState.listInfos[searchMusicState.source]!.list,
            false,
            source == 'all',
          )
        } else {
          listRef.current?.setStatus('loading')
          const page = 1
          searchInfoRef.current.text = text
          searchInfoRef.current.source = source
          return search(text, page, source)
            .then((list) => {
              // const result = setListInfo(listDetail, id, page)
              if (isUnmountedRef.current) return
              requestAnimationFrame(() => {
                listRef.current?.setList(list, false, source == 'all')
                listRef.current?.setStatus(
                  searchMusicState.listInfos[searchMusicState.source]!.maxPage <= page
                    ? 'end'
                    : 'idle',
                )
              })
            })
            .catch(() => {
              listRef.current?.setStatus('error')
            })
        }
      },
    }),
    [],
  )

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const handleRefresh: OnlineListProps['onRefresh'] = () => {
    const page = 1
    listRef.current?.setStatus('refreshing')
    search(searchInfoRef.current.text, page, searchInfoRef.current.source)
      .then((list) => {
        // const result = setListInfo(listDetail, searchMusicState.listDetailInfo.id, page)
        if (isUnmountedRef.current) return
        listRef.current?.setList(list, false, searchInfoRef.current.source == 'all')
        listRef.current?.setStatus(
          searchMusicState.listInfos[searchInfoRef.current.source]!.maxPage <= page ? 'end' : 'idle',
        )
      })
      .catch(() => {
        listRef.current?.setStatus('error')
      })
  }
  const handleLoadMore: OnlineListProps['onLoadMore'] = () => {
    listRef.current?.setStatus('loading')
    const info = searchMusicState.listInfos[searchInfoRef.current.source]!
    const page = info?.list.length ? info.page + 1 : 1
    search(searchInfoRef.current.text, page, searchInfoRef.current.source)
      .then((list) => {
        // const result = setListInfo(listDetail, searchMusicState.listDetailInfo.id, page)
        if (isUnmountedRef.current) return
        listRef.current?.setList(list, true, searchInfoRef.current.source == 'all')
        listRef.current?.setStatus(info.maxPage <= page ? 'end' : 'idle')
      })
      .catch(() => {
        listRef.current?.setStatus('error')
      })
  }

  // 搜索点歌：把当前已加载的整份搜索结果按顺序写入试听列表(DEFAULT)，并从所选歌曲处播放。
  // 与歌单/榜单同一套语义（是否清空旧内容由 player.isAutoCleanPlayedList 决定）：
  // 只有传了 onPlayList，OnlineList 的行点击才会走「整份写入」而不是「单曲加进列表」。
  // 列表身份带上关键词：core/search/music.ts 已保证单源搜索也会同步 searchText，
  // 否则换关键词后 staged id 不变，stage 会把上一份结果误判成「同一份列表」而原位替换掉。
  const handlePlayList: OnlineListProps['onPlayList'] = (index) => {
    const source = searchMusicState.source
    const info = searchMusicState.listInfos[source]
    if (info?.list.length) {
      void stageOnlineListToDefault(`search__${source}__${searchMusicState.searchText}`, info.list, index)
    }
  }

  return (
    <OnlineList
      ref={listRef}
      listId="search"
      ListHeaderComponent={header}
      onPlayList={handlePlayList}
      onRefresh={handleRefresh}
      onLoadMore={handleLoadMore}
      checkHomePagerIdle
    />
  )
})
