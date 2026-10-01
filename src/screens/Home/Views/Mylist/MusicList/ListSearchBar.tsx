import { useState, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react'
import { Animated, View, TouchableOpacity } from 'react-native'

import Text from '@/components/common/Text'
import Input, { type InputType } from '@/components/common/Input'

import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { BorderWidths } from '@/theme'
import { designMotion } from '@/theme/DesignTokens'
import { useButtonRadius } from '@/utils/buttonRadius'

interface SearchInputProps {
  onSearch: (keywork: string) => void
}
type SearchInputType = InputType

const SearchInput = forwardRef<SearchInputType, SearchInputProps>(({ onSearch }, ref) => {
  const [text, setText] = useState('')
  // 搜索框无静态高度，高度 100% 铺满 44 槽位（同返回栏 ActiveList 行高）：按 44 折算半高
  const buttonRadius = useButtonRadius()

  const handleChangeText = (text: string) => {
    setText(text)
    onSearch(text.trim())
  }

  return (
    <Input
      onChangeText={handleChangeText}
      placeholder="Search for something..."
      value={text}
      style={[
        styles.input,
        // 搜索框铺满 44 槽位（同返回栏行高）：按 44 折算半高
        { borderRadius: buttonRadius(44) },
      ]}
      // onFocus={showTipList}
      clearBtn
      ref={ref}
    />
  )
})

export interface ListSearchBarProps {
  onSearch: (keywork: string) => void
  onExitSearch: () => void
}
export interface ListSearchBarType {
  show: () => void
  hide: () => void
}

export default forwardRef<ListSearchBarType, ListSearchBarProps>(
  ({ onSearch, onExitSearch }, ref) => {
    const t = useI18n()
    // const isGetDetailFailedRef = useRef(false)
    const [visible, setVisible] = useState(false)
    const [animatePlayed, setAnimatPlayed] = useState(true)
    const animFade = useRef(new Animated.Value(0)).current
    const searchInputRef = useRef<SearchInputType>(null)

    const theme = useTheme()
    // 取消按钮（下面 component 里的 styles.btn 行内覆盖）要用它，必须声明在**本组件**作用域。
    // 早前只有内层 SearchInput 声明过 buttonRadius，这里却直接在第 131 行把它列进了 useMemo
    // 依赖数组 —— useMemo 的依赖数组在渲染时就会求值，跟第 126 行的 JSX 是否真的渲染无关，
    // 于是本组件一挂载就抛 ReferenceError: buttonRadius is not defined。而它是常驻挂载的
    // （MusicList/index.tsx 的 barSlot），等于打开「我的」歌曲列表必崩。
    // 注意这类「运行时未定义」既不是语法错，也没有类型检查兜底（本工程无 tsc 链路），
    // 全仓语法扫描与 scripts/ 下的契约脚本都抓不到，只能靠人读作用域。
    const buttonRadius = useButtonRadius()

    useImperativeHandle(ref, () => ({
      show() {
        handleShow()
        requestAnimationFrame(() => {
          searchInputRef.current?.focus()
        })
      },
      hide() {
        handleHide()
      },
    }))

    const handleShow = useCallback(() => {
      // console.log('show List')
      setVisible(true)
      setAnimatPlayed(false)
      requestAnimationFrame(() => {
        // 只做原地淡入，不再有 translateY(-20→0) 位移：搜索栏与返回栏同处一个固定槽位，
        // 「点击搜索后搜索框在同一位置且不可移动」是硬要求，任何位移都会破坏它
        // （位移还会让输入框短暂越过槽位顶边、盖到状态栏上）。
        Animated.timing(animFade, {
          toValue: 0.92,
          duration: designMotion.quick,
          useNativeDriver: true,
        }).start(() => {
          setAnimatPlayed(true)
        })
      })
    }, [animFade])

    const handleHide = useCallback(() => {
      setAnimatPlayed(false)
      Animated.timing(animFade, {
        toValue: 0,
        duration: designMotion.quick,
        useNativeDriver: true,
      }).start((finished) => {
        if (!finished) return
        setVisible(false)
        setAnimatPlayed(true)
      })
    }, [animFade])

    const animaStyle = useMemo(
      () => ({
        ...styles.container,
        // backgroundColor: theme['c-content-background'],
        borderBottomColor: theme['c-border-background'],
        opacity: animFade, // Bind opacity to animated value
      }),
      [animFade, theme],
    )

    const component = useMemo(() => {
      return (
        <Animated.View style={animaStyle}>
          <View style={styles.content}>
            <SearchInput ref={searchInputRef} onSearch={onSearch} />
          </View>
          {/* 取消按钮同上：无自身高度，按槽位行高 44 折算半高 */}
          <TouchableOpacity onPress={onExitSearch} style={[styles.btn, { borderRadius: buttonRadius(44) }]}>
            <Text color={theme['c-button-font']}>{t('list_select_cancel')}</Text>
          </TouchableOpacity>
        </Animated.View>
      )
    }, [animaStyle, onSearch, onExitSearch, theme, t, buttonRadius])

    return !visible && animatePlayed ? null : component
  },
)

const styles = createStyle({
  // 绝对铺满父级「固定槽位」（index.tsx 的 barSlot，高度=返回栏 ActiveList 的 44）：
  // 搜索栏不再另起定位体系，展开后正好严丝合缝地替换掉返回栏的位置。
  container: {
    flex: 1,
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    flexDirection: 'row',
    paddingLeft: 10,
    borderBottomWidth: BorderWidths.normal,
  },
  content: {
    flexDirection: 'row',
    flex: 1,
  },
  input: {
    height: '100%',
  },
  btn: {
    // flex: 1,
    paddingLeft: 15,
    paddingRight: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
