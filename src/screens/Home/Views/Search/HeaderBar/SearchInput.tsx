import { useCallback, useRef, forwardRef, useImperativeHandle, useState } from 'react'
import { StyleSheet } from 'react-native'
import Input, { type InputType, type InputProps } from '@/components/common/Input'
import { designTypography } from '@/theme/DesignTokens'
import { useButtonRadius } from '@/utils/buttonRadius'
import searchState from '@/store/search/state'

// 输入框文字的「跨实例暂存」（用户第 11 轮第 7 条：点下面的按钮后，输入框里的字看不见了）。
// 成因：Search/List.tsx 把同一个 header 元素分别放进「空白页(BlankView)」和「结果列表」两棵
// 子树，切换显示（搜索提交、点热门词条、取消…）时 React 会把整棵 header 连同本输入框一起
// 重挂载，实例内的 useState 随之清零；而触发切换那次 setText 调的是重挂载前的旧实例，
// 新实例补不回来，输入框就空了。这里用模块作用域存最后一次输入，重挂载时按它还原。
// 首次冷启动没有暂存值时退回持久化的搜索词（与页面原有 setText(searchState.searchText) 同源）。
let lastInputText: string | null = null

export interface SearchInputProps {
  onChangeText: (text: string) => void
  onSubmit: (text: string) => void
  onBlur: () => void
  onFocus: () => void
  onTouchStart: () => void
}

export interface SearchInputType {
  setText: (text: string) => void
  // getText: () => string
  focus: () => void
  blur: () => void
}

export default forwardRef<SearchInputType, SearchInputProps>(
  ({ onChangeText, onSubmit, onBlur, onFocus, onTouchStart }, ref) => {
    // const theme = useTheme()
    const [text, setText] = useState(() => lastInputText ?? searchState.searchText ?? '')
    const inputRef = useRef<InputType>(null)
    const buttonRadius = useButtonRadius()

    // 所有写入口都经这里：同步暂存再落 state，重挂载后能还原
    const applyText = useCallback((next: string) => {
      lastInputText = next
      setText(next)
    }, [])

    useImperativeHandle(ref, () => ({
      // getText() {
      //   return text.trim()
      // },
      setText(text) {
        applyText(text)
      },
      focus() {
        inputRef.current?.focus()
      },
      blur() {
        inputRef.current?.blur()
      },
    }))

    const handleChangeText = (text: string) => {
      applyText(text)
      onChangeText(text.trim())
    }

    const handleClearText = useCallback(() => {
      applyText('')
      onChangeText('')
      onSubmit('')
    }, [applyText, onChangeText, onSubmit])

    const handleSubmit = useCallback<NonNullable<InputProps['onSubmitEditing']>>(
      ({ nativeEvent: { text } }) => {
        onSubmit(text)
      },
      [onSubmit],
    )

    return (
      <Input
        ref={inputRef}
        placeholder="搜索歌曲、歌手、专辑或歌单"
        value={text}
        onChangeText={handleChangeText}
        style={[
          styles.input,
          // 搜索输入框圆角随「按钮圆角」设置行内覆盖；高度取 styles.input.height 的源值 40
          { borderRadius: buttonRadius(40) },
        ]}
        onBlur={onBlur}
        onFocus={onFocus}
        onSubmitEditing={handleSubmit}
        onClearText={handleClearText}
        onTouchStart={onTouchStart}
        clearBtn
      />
    )
  },
)

const styles = StyleSheet.create({
  input: {
    backgroundColor: 'transparent',
    height: 40,
    borderRadius: 999,
    paddingLeft: 6,
    paddingRight: 10,
    fontSize: designTypography.body,
  },
})
