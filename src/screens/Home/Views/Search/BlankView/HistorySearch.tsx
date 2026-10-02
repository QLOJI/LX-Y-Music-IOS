import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Pressable, TouchableOpacity, View } from 'react-native'
import { type InitState } from '@/store/hotSearch/state'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { controlGap, designSpacing, designTypography, designRadius } from '@/theme/DesignTokens'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { clearHistoryList, getSearchHistory, removeHistoryWord } from '@/core/search/search'
import { Icon } from '@/components/common/Icon'

export type List = NonNullable<InitState['sourceList'][keyof InitState['sourceList']]>

const ListItem = ({
  keyword,
  onSearch,
  onRemove,
}: {
  keyword: string
  onSearch: (keyword: string) => void
  onRemove: (keyword: string) => void
}) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()

  // 历史搜索胶囊（含行内删除小圆钮）：底色与边框随「按钮透明度」淡出，
  // 文字与图标色不动。只改颜色 alpha，不能用容器 style.opacity（会把内容一起变淡）。
  const chipStyle = useMemo(
    () => ({
      ...styles.button,
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-200'], buttonOpacity),
      borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )
  const removeButtonStyle = useMemo(
    () => ({
      ...styles.removeButton,
      backgroundColor: applyOpacity(theme['c-primary-background-active'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  return (
    <Pressable
      style={[
        chipStyle,
        // 历史搜索词条胶囊圆角随「按钮圆角」设置行内覆盖；高度取 styles.button 的源值 36
        { borderRadius: buttonRadius(36) },
      ]}
      onPress={() => {
        onSearch(keyword)
      }}
    >
      <Text color={theme['c-font']} size={13}>
        {keyword}
      </Text>
      <TouchableOpacity
        hitSlop={8}
        style={[
          removeButtonStyle,
          // 行内删除小圆钮圆角随「按钮圆角」设置行内覆盖；高度取 styles.removeButton 的源值 18
          { borderRadius: buttonRadius(18) },
        ]}
        onPress={() => {
          onRemove(keyword)
        }}
      >
        <Icon name="close" color={theme['c-font-label']} size={10} />
      </TouchableOpacity>
    </Pressable>
  )
}

interface HistorySearchProps {
  onSearch: (keyword: string) => void
}
export interface HistorySearchType {
  show: () => void
}

export default forwardRef<HistorySearchType, HistorySearchProps>((props, ref) => {
  const [list, setList] = useState<List>([])
  const isUnmountedRef = useRef(false)
  const t = useI18n()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()

  // 标题右侧的「清空历史」工具钮：底色随设置淡出，橡皮图标色不动
  const titleBtnStyle = useMemo(
    () => ({ ...styles.titleBtn, backgroundColor: applyOpacity(theme['c-primary-background-hover'], buttonOpacity) }),
    [theme, buttonOpacity],
  )

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      show() {
        void getSearchHistory().then((list) => {
          if (isUnmountedRef.current) return
          setList(list)
        })
      },
    }),
    [],
  )

  const handleClear = () => {
    clearHistoryList()
    setList([])
  }

  const handleRemove = useCallback((keyword: string) => {
    setList((list) => {
      list = [...list]
      const index = list.indexOf(keyword)
      list.splice(index, 1)
      removeHistoryWord(index)
      return list
    })
  }, [])

  return list.length ? (
    <View>
      <View style={styles.titleContent}>
        <Text size={designTypography.title} style={styles.title}>{t('search_history_search')}</Text>
        <TouchableOpacity
          onPress={handleClear}
          style={[
            titleBtnStyle,
            // 「清空历史」工具钮圆角随「按钮圆角」设置行内覆盖；高度取 styles.titleBtn 的源值 32
            { borderRadius: buttonRadius(32) },
          ]}
        >
          <Icon name="eraser" color={theme['c-300']} size={14} />
        </TouchableOpacity>
      </View>
      <View style={styles.list}>
        {list.map((keyword) => (
          <ListItem
            keyword={keyword}
            key={keyword}
            onSearch={props.onSearch}
            onRemove={handleRemove}
          />
        ))}
      </View>
    </View>
  ) : null
})

const styles = createStyle({
  titleContent: {
    // 「标题 → 自己的词条」间距：与 HotSearch 的 title、以及「搜索平台」区块
    // （HeaderBar.platformContent 的 paddingVertical）同为 controlGap(12)。
    // 第 19 轮第 2 条要求整页「标题→内容」间距一致；A-4 的 4 已废弃 ——
    // 本处与 HotSearch 必须同步，否则左右两个区块自己就不齐。
    marginBottom: controlGap,
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    fontWeight: '700',
  },
  titleBtn: {
    marginLeft: designSpacing.sm,
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // 词条行距的唯一来源：button 不再自带 marginBottom（A-2 去双重间距），
    // 否则 rowGap 与 marginBottom 会叠加成 24pt
    rowGap: designSpacing.sm,
  },
  button: {
    height: 36,
    justifyContent: 'center',
    paddingHorizontal: designSpacing.md,
    marginRight: designSpacing.sm,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: designRadius.pill,
  },
  removeButton: {
    marginLeft: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
