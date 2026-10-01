import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ScrollView, TouchableOpacity } from 'react-native'
import songlistState, { type SortInfo, type Source } from '@/store/songlist/state'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'

export interface SortTabProps {
  onSortChange: (id: string) => void
}

export interface SortTabType {
  setSource: (source: Source, activeTab: SortInfo['id']) => void
}

export default forwardRef<SortTabType, SortTabProps>(({ onSortChange }, ref) => {
  const [sortList, setSortList] = useState<SortInfo[]>([])
  const [activeId, setActiveId] = useState<SortInfo['id']>('')
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  // 「按钮圆角」：排序胶囊的行内覆盖（静态 borderRadius 原样保留作兜底）
  const buttonRadius = useButtonRadius()
  const scrollViewRef = useRef<ScrollView>(null)

  useImperativeHandle(ref, () => ({
    setSource(source, activeTab) {
      scrollViewRef.current?.scrollTo({ x: 0 })
      setSortList(songlistState.sortList[source]!)
      setActiveId(activeTab)
    },
  }))

  const sorts = useMemo(() => {
    // 部分平台（kw/tx/git）的 sortList 没有 tid，i18n 键不存在会渲染成空胶囊，
    // 直接使用音乐平台自带的中文分类名。
    return sortList.map((s) => ({ label: s.name, id: s.id }))
  }, [sortList])

  const handleSortChange = (id: string) => {
    onSortChange(id)
    setActiveId(id)
  }

  // 排序胶囊的底色/边框随「按钮透明度」淡出，文字色不动。只改颜色 alpha，
  // 不能用容器 style.opacity——那会把胶囊文字一起变淡，0 时就不是「只剩文字」。
  // 激活态（c-primary 实底）一起处理，否则当前排序仍是实心、其余透明，观感割裂。
  const activeButtonStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary'], buttonOpacity),
      borderColor: applyOpacity(theme['c-primary'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )
  const inactiveButtonStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-300'], buttonOpacity),
      borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps={'always'}
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {sorts.map((s) => {
        const isActive = activeId == s.id
        return (
          <TouchableOpacity
            style={[
              styles.button,
              isActive ? activeButtonStyle : inactiveButtonStyle,
              // 排序胶囊圆角随「按钮圆角」设置行内覆盖；高度取 styles.button 的源值 36（胶囊自身高度）
              { borderRadius: buttonRadius(36) },
            ]}
            onPress={() => {
              handleSortChange(s.id)
            }}
            key={s.id}
          >
            <Text
              style={{
                ...styles.buttonText,
                color: isActive ? theme['c-primary-light-1000'] : theme['c-font'],
              }}
            >
              {s.label}
            </Text>
          </TouchableOpacity>
        )
      })}
    </ScrollView>
  )
})

const styles = createStyle({
  container: {
    flexGrow: 1,
    flexShrink: 1,
    // paddingLeft: 5,
    // paddingRight: 5,
  },
  button: {
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: designSpacing.lg,
    paddingRight: designSpacing.lg,
    marginRight: designSpacing.sm,
    borderRadius: 999,
    borderWidth: 1,
  },
  content: {
    alignItems: 'center',
    paddingLeft: designSpacing.lg,
    paddingRight: designSpacing.lg,
  },
  buttonText: {
    textAlign: 'center',
    fontWeight: '600',
  },
})
