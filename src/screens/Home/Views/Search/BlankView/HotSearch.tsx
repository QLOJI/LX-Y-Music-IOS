import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { Icon } from '@/components/common/Icon'
import { type Source, type InitState } from '@/store/hotSearch/state'
import Button from '@/components/common/Button'
import { getList } from '@/core/hotSearch'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { controlGap, designSpacing, designTypography } from '@/theme/DesignTokens'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'

interface ListProps {
  onSearch: (keyword: string) => void
}
export interface HotSearchType {
  show: (source: Source) => void
}

export type List = NonNullable<InitState['sourceList'][keyof InitState['sourceList']]>

const ListItem = ({
  keyword,
  onSearch,
}: {
  keyword: string
  onSearch: (keyword: string) => void
}) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()

  // 热门搜索胶囊：底色与边框随「按钮透明度」淡出，文字与放大镜图标色不动。
  // 只改颜色 alpha，不能用容器 style.opacity（会把胶囊内容一起变淡）。
  const chipStyle = useMemo(
    () => ({
      ...styles.button,
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-200'], buttonOpacity),
      borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  return (
    <Button
      style={[
        chipStyle,
        // 热门搜索词条胶囊圆角随「按钮圆角」设置行内覆盖；高度取 styles.button 的源值 44
        { borderRadius: buttonRadius(44) },
      ]}
      onPress={() => {
        onSearch(keyword)
      }}
    >
      <Icon name="search-2" size={16} color={theme['c-primary']} style={styles.icon} />
      {/* 左对齐后词条可能超出胶囊（48% 宽、固定 44 高），按单行截断 */}
      <Text color={theme['c-font']} size={13} style={styles.keyword} numberOfLines={1}>
        {keyword}
      </Text>
    </Button>
  )
}

export default forwardRef<HotSearchType, ListProps>((props, ref) => {
  // const [listType, setListType] = useState<SearchState['searchType']>('music')
  // const listRef = useRef<MusicListType>(null)
  const [list, setList] = useState<List>([])
  const t = useI18n()
  // const theme = useTheme()

  const isUnmountedRef = useRef(false)
  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      show(source) {
        void getList(source).then((list) => {
          if (isUnmountedRef.current) return
          setList(list)
        })
      },
    }),
    [],
  )

  return list.length ? (
    <View>
      <Text style={styles.title} size={designTypography.title}>
        {t('search_hot_search')}
      </Text>
      <View style={styles.list}>
        {list.slice(0, 12).map((keyword, _index) => (
          <ListItem
            keyword={keyword}
            key={keyword}
            onSearch={props.onSearch}
          />
        ))}
      </View>
    </View>
  ) : null
})

const styles = createStyle({
  title: {
    // 「标题 → 自己的词条」间距：与「搜索平台」区块同源 —— HeaderBar 的
    // platformContent.paddingVertical 用的就是 controlGap(12)。
    // 第 19 轮第 2 条（用户原话）：「搜索页面，热门搜索和历史搜索下面与按钮的间距，
    // 要和搜索平台和下面按钮的间距一致，确保整个画面间距一致。」
    // A-4 曾单独收到 4（理由是胶囊内自带留白），但那让本页三处「标题→内容」变成
    // 12 / 4 / 4 三套；现统一回 controlGap —— 本文件与 HistorySearch / HeaderBar
    // 三处同值的要求由契约 scripts/sim-page-title-align.js D 组钉住。
    marginBottom: controlGap,
    fontWeight: '700',
  },
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // 词条行距的唯一来源：button 不再自带 marginBottom（A-2 去双重间距），
    // 否则 rowGap 与 marginBottom 会叠加成 24pt
    rowGap: designSpacing.sm,
    columnGap: designSpacing.sm,
  },
  button: {
    width: '48%',
    height: 44,
    flexDirection: 'row',
    // 图标 + 文字整体左对齐（用户第 11 轮第 1 条）：原先居中，两列胶囊里的词条
    // 由于长度不同起点参差，视觉上既不像列表也没法纵向对齐。
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingHorizontal: designSpacing.md,
    borderRadius: 22,
    borderWidth: 1,
  },
  icon: {
    marginRight: designSpacing.sm,
  },
  keyword: {
    flexShrink: 1,
  },
})
