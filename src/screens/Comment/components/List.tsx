import { useMemo, useRef, useState, forwardRef, useImperativeHandle, useCallback } from 'react'
import { Animated, FlatList, type FlatListProps, View } from 'react-native'
import usePullRefresh from '@/components/common/usePullRefresh'

// import { useMusicList } from '@/store/list/hook'
import CommentFloor, { type CommentFloorActions } from './CommentFloor'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { type Comment } from '../utils'
import { useI18n } from '@/lang'
import Text from '@/components/common/Text'

type FlatListType = FlatListProps<Comment>

export interface ListProps {
  onRefresh: () => void
  onLoadMore: () => void
  actions?: CommentFloorActions
}
export interface ListType {
  setList: (list: Comment[]) => void
  getList: () => Comment[]
  setStatus: (val: Status) => void
}
export type Status = 'loading' | 'refreshing' | 'end' | 'error' | 'idle'

const List = forwardRef<ListType, ListProps>(({ onRefresh, onLoadMore, actions }, ref) => {
  // const t = useI18n()
  const theme = useTheme()
  const flatListRef = useRef<FlatList>(null)
  const [currentList, setList] = useState<Comment[]>([])
  const [status, setStatus] = useState<Status>('idle')
  // const currentListIdRef = useRef('')
  // console.log('render comment list')

  useImperativeHandle(ref, () => ({
    setList(list) {
      setList(list)
    },
    getList() {
      return currentList
    },
    setStatus(val) {
      setStatus(val)
    },
  }))

  const handleLoadMore = () => {
    if (status != 'idle') return
    onLoadMore()
  }

  const renderItem: FlatListType['renderItem'] = ({ item }) => (
    <CommentFloor
      comment={item}
      onReply={actions?.onReply}
      onDelete={actions?.onDelete}
      canDelete={actions?.canDelete}
      showActions={actions?.showActions}
    />
  )

  const getkey: FlatListType['keyExtractor'] = (item) => item.id

  const handlePullRefresh = useCallback(() => {
    onRefresh()
  }, [onRefresh])
  const { indicator: pullIndicator, scrollProps: pullScrollProps, pullOffset } = usePullRefresh(
    status == 'refreshing',
    handlePullRefresh,
    flatListRef,
  )
  const footerComponent = useMemo(() => {
    let label: FooterLabel
    switch (status) {
      case 'refreshing':
        return null
      case 'loading':
        label = 'list_loading'
        break
      case 'end':
        label = 'list_end'
        break
      case 'error':
        label = 'list_error'
        break
      case 'idle':
        label = null
        break
    }
    return <Footer label={label} onLoadMore={onLoadMore} />
  }, [onLoadMore, status])

  return (
    <View style={{ flex: 1, overflow: 'hidden' }}>
      {pullIndicator}
      <Animated.View style={{ flex: 1, transform: [{ translateY: pullOffset }] }}>
      <FlatList
      ref={flatListRef}
      {...pullScrollProps}
      style={styles.list}
      data={currentList}
      onEndReachedThreshold={0.5}
      // maxToRenderPerBatch={4}
      // updateCellsBatchingPeriod={80}
      // windowSize={8}
      removeClippedSubviews={false}
      // initialNumToRender={12}
      renderItem={renderItem}
      keyExtractor={getkey}
      // onRefresh={onRefresh}
      // refreshing={refreshing}
      onEndReached={handleLoadMore}
      ListFooterComponent={footerComponent}
      />
      </Animated.View>
    </View>
  )
})

type FooterLabel = 'list_loading' | 'list_end' | 'list_error' | null
const Footer = ({ label, onLoadMore }: { label: FooterLabel, onLoadMore: () => void }) => {
  const theme = useTheme()
  const t = useI18n()
  const handlePress = () => {
    if (label != 'list_error') return
    onLoadMore()
  }
  return label ? (
    <View>
      <Text onPress={handlePress} style={styles.footer} color={theme['c-font-label']}>
        {t(label)}
      </Text>
    </View>
  ) : null
}

const styles = createStyle({
  container: {
    flex: 1,
  },
  list: {
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: 15,
    paddingRight: 15,
  },
  footer: {
    textAlign: 'center',
    padding: 10,
  },
})

export default List
