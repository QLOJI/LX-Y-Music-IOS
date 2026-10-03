import { useRef, useImperativeHandle, forwardRef, useState, useEffect } from 'react'
import SearchTipList, {
  type SearchTipListProps as _SearchTipListProps,
  type SearchTipListType as _SearchTipListType,
} from '@/components/SearchTipList'
import Button from '@/components/common/Button'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { scaleSizeH } from '@/utils/pixelRatio'
import musicSdk from '@/utils/musicSdk'
import searchState, { type InitState as SearchState } from '@/store/search/state'
import { setSearchText, setTipList, setTipListInfo } from '@/core/search/search'
import { debounce } from '@/utils'

export const ITEM_HEIGHT = scaleSizeH(36)

export const debounceTipSearch = debounce(
  (keyword: string, source: SearchState['temp_source'], callback: (list: string[]) => void) => {
    // console.log(reslutList)
    void musicSdk[source].tipSearch.search(keyword).then(callback)
  },
  200,
)

export type SearchTipListProps = _SearchTipListProps<string>
export type SearchTipListType = _SearchTipListType<string>

interface TipListProps {
  onSearch: (keyword: string) => void
}
export interface TipListType {
  search: (keyword: string, height: number) => void
  show: (height: number) => void
  hide: () => void
}

export default forwardRef<TipListType, TipListProps>(({ onSearch }, ref) => {
  const searchTipListRef = useRef<SearchTipListType>(null)
  const [visible, setVisible] = useState(false)
  const visibleListRef = useRef(false)
  const isUnmountedRef = useRef(false)

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const handleSearch = (keyword: string, height: number) => {
    searchTipListRef.current?.setHeight(height)
    setSearchText(keyword)
    if (keyword) {
      setTipListInfo(keyword, searchState.temp_source)
      debounceTipSearch(keyword, searchState.temp_source, (list) => {
        if (keyword != searchState.tipListInfo.text) return
        setTipList(list)
        if (!visibleListRef.current || isUnmountedRef.current) return
        searchTipListRef.current?.setList(list)
      })
    } else {
      setTipListInfo(keyword, searchState.temp_source)
      setTipList([])
      searchTipListRef.current?.setList([])
    }
  }

  const handleShowList = (height: number) => {
    searchTipListRef.current?.setHeight(height)
    if (searchState.tipListInfo.list.length) {
      visibleListRef.current = true
      searchTipListRef.current?.setList([...searchState.tipListInfo.list])
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      search(keyword, height) {
        if (visible) handleSearch(keyword, height)
        else {
          setVisible(true)
          requestAnimationFrame(() => {
            handleSearch(keyword, height)
          })
        }
      },
      show(height) {
        visibleListRef.current = true
        if (visible) handleShowList(height)
        else {
          setVisible(true)
          requestAnimationFrame(() => {
            handleShowList(height)
          })
        }
      },
      hide() {
        requestAnimationFrame(() => {
          visibleListRef.current = false
          searchTipListRef.current?.setList([])
        })
        // 【第 21 轮·图九】收浮层的同时把全局联想缓存一起清掉。show() 只要看到
        // searchState.tipListInfo.list 非空就会把它整份摊出来 —— 缓存里留着上一次
        // 关键词的词条时，清空输入框后再聚焦就会「输入框没有文字、浮层却显示旧词条」。
        // 顺带把在途请求也一并作废：handleSearch 里 `keyword != searchState.tipListInfo.text`
        // 这道闸看到 text 已被清空，晚到的响应不会再写回来。
        setTipListInfo('', searchState.temp_source)
        setTipList([])
      },
    }),
    [visible],
  )

  const renderItem: SearchTipListProps['renderItem'] = ({ item, index }) => {
    return (
      <Button
        style={styles.item}
        onPress={() => {
          onSearch(item)
        }}
        key={index}
      >
        <Text numberOfLines={1}>{item}</Text>
      </Button>
    )
  }
  const getkey: SearchTipListProps['keyExtractor'] = (item, index) => String(index)
  const getItemLayout: SearchTipListProps['getItemLayout'] = (data, index) => {
    return { length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index }
  }

  return visible ? (
    <SearchTipList
      ref={searchTipListRef}
      renderItem={renderItem}
      onPressBg={() => searchTipListRef.current?.setList([])}
      keyExtractor={getkey}
      getItemLayout={getItemLayout}
    />
  ) : null
})

const styles = createStyle({
  item: {
    height: ITEM_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 15,
    paddingRight: 15,
    // backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
})
