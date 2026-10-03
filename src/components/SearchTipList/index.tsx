import {
  useRef,
  useState,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
  type Ref,
} from 'react'
import { StyleSheet, View, Animated } from 'react-native'
// import PropTypes from 'prop-types'
// import { AppColors } from '@/theme'
import { useTheme } from '@/store/theme/hook'
import List, { type ItemT, type ListProps, type ListType } from './List'
import { shadow } from '@/utils/shadow'
import { useButtonRadius } from '@/utils/buttonRadius'
// import InsetShadow from 'react-native-inset-shadow'

export interface SearchTipListProps<T> extends ListProps<T> {
  onPressBg?: () => void
}
export interface SearchTipListType<T> {
  setList: (list: T[]) => void
  setHeight: (height: number) => void
}

const noop = () => {}

const Component = <T extends ItemT<T>>(
  { onPressBg = noop, ...props }: SearchTipListProps<T>,
  ref: Ref<SearchTipListType<T>>,
) => {
  const theme = useTheme()
  // 【第二十轮·图四】联想浮层纳入「按钮圆角」配置：底座是通栏面板，取与搜索输入框
  // 同一条基准高度（40，见 SearchInput 的 buttonRadius(40)），圆角设 0 时面板走直角、
  // 设 100 时为全圆角，与设置项语义完全一致（用户：「搜索框的联想浮层加入倒角配置中」）。
  const buttonRadius = useButtonRadius()
  const translateY = useRef(new Animated.Value(0)).current
  const scaleY = useRef(new Animated.Value(0)).current
  const [visible, setVisible] = useState(false)
  const [animatePlayed, setAnimatPlayed] = useState(true)
  const listRef = useRef<ListType<T>>(null)
  const prevListRef = useRef<T[]>([])
  const heightRef = useRef(0)

  useImperativeHandle(ref, () => ({
    setList(list) {
      if (prevListRef.current.length) {
        if (!list.length) handleHide()
      } else if (list.length) handleShow()
      prevListRef.current = list
      requestAnimationFrame(() => {
        listRef.current?.setList(list)
      })
    },
    setHeight(height) {
      heightRef.current = height
    },
  }))

  const handleShow = useCallback(() => {
    // console.log('handleShow', height, visible)
    if (!heightRef.current) return
    setVisible(true)
    setAnimatPlayed(false)
    requestAnimationFrame(() => {
      translateY.setValue(-heightRef.current / 2)
      scaleY.setValue(0)

      Animated.parallel([
        // Animated.timing(fade, {
        //   toValue: 1,
        //   duration: 300,
        //   useNativeDriver: true,
        // }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(scaleY, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start(() => {
        setAnimatPlayed(true)
      })
    })
  }, [translateY, scaleY])

  const handleHide = useCallback(() => {
    setAnimatPlayed(false)
    Animated.parallel([
      // Animated.timing(fade, {
      //   toValue: 0,
      //   duration: 200,
      //   useNativeDriver: true,
      // }),
      Animated.timing(translateY, {
        toValue: -heightRef.current / 2,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(scaleY, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start((finished) => {
      // console.log(finished)
      if (!finished) return
      setVisible(false)
      setAnimatPlayed(true)
    })
  }, [translateY, scaleY])

  const component = useMemo(
    () => (
      <Animated.View
        style={{
          ...styles.anima,
          transform: [{ translateY }, { scaleY }],
        }}
      >
        <View
          style={{
            ...styles.container,
            backgroundColor: theme['c-content-background'],
            // 「按钮圆角」行内覆盖（同 SearchInput 的 40 基准），静态样式里不留兜底值：
            // 0 是默认（直角），与配置刻度一致
            borderRadius: buttonRadius(40),
          }}
        >
          <List ref={listRef} {...props} />
        </View>
        <View style={styles.blank} onTouchStart={onPressBg}></View>
      </Animated.View>
    ),
    [onPressBg, props, scaleY, theme, translateY, buttonRadius],
  )

  return !visible && animatePlayed ? null : component
}

export default forwardRef(Component) as <T>(
  p: SearchTipListProps<T> & { ref?: Ref<SearchTipListType<T>> }
) => JSX.Element | null

const styles = StyleSheet.create({
  anima: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    width: '100%',
    zIndex: 10,
  },
  container: {
    flex: 0,
    // flexGrow: 0,
    // borderBottomWidth: BorderWidths.normal,
    // iOS 浮层阴影（仅 iPhone/iPad）
    ...shadow(2),
    maxHeight: '80%',
    // 【第二十轮·图四】圆角来自行内 buttonRadius(40)，这里负责把子内容裁进圆角内，
    // 否则列表首/末行自身的底色会在圆角外露出直角。iOS 的 layer 阴影由 shadow* 提供，
    // 与本层 overflow 裁剪互不影响（阴影仍然画在圆角外）。
    overflow: 'hidden',
  },
  blank: {
    flex: 1,
    flexGrow: 1,
    // backgroundColor: 'transparent',
    // backgroundColor: 'rgba(0,0,0,0.2)',
  },
})
