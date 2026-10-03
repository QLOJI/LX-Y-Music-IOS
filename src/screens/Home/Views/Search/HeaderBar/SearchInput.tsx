import { useCallback, useRef, forwardRef, useImperativeHandle, useState } from 'react'
import { StyleSheet } from 'react-native'
import Input, { type InputType, type InputProps } from '@/components/common/Input'
import { designTypography } from '@/theme/DesignTokens'
import { useButtonRadius } from '@/utils/buttonRadius'
import { getTextSize } from '@/utils/pixelRatio'
import { useFontSize } from '@/store/common/hook'
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
    // 【第二十轮·图四】输入文字字号与联想浮层统一。useFontSize() 订阅「字体大小」设置，
    // 改字号时本组件重渲染；字号算法与 Text 组件的 setSpText 同一口径
    // （getTextSize(size) × 字体倍率），见 utils/pixelRatio。
    const fontSizeValue = useFontSize()

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
          // 【第二十轮·图四】输入文字字号必须与联想浮层（Text 组件按 setSpText 缩放）同口径：
          // 此前 styles.input 里写死 fontSize:15（普通 StyleSheet，不随「字体大小」缩放，
          // 且因调用方 style 优先，把 Input 内部本来的 setSpText(size) 也覆盖掉了），
          // 字号一旦不是 1.0 输入框文字就比联想浮层小一圈（用户原话「搜索框中输入的文字
          // 字体太小了，要和联想浮层文字统一」）。改为行内计算 —— 静态样式表会在模块加载
          // 时把值冻住，不能放在 styles.input 里。
          { fontSize: getTextSize(designTypography.body) * fontSizeValue },
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
    // 字号不在这里给：见组件内行内 fontSize（要随「字体大小」设置变化，静态样式表做不到）
  },
})
