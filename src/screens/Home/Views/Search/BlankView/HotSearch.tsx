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
import { designSpacing, designTypography } from '@/theme/DesignTokens'
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
      <Text color={theme['c-font']} size={13}>
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
    // A-2：标题到词条 12→8（区块上方 16 / 标题到内容 8 / 词条行距 12）。
    // A-4（2026-10-01）：再收到 4 —— 用户反馈「下方的文字间距又很大」。词条是 44pt 高、
    // 字号 13 的胶囊，文字在胶囊内垂直居中，胶囊顶边到文字顶边本身就有 ~14pt 留白，
    // 若标题再留 8，视觉间距（~22pt）比标题离上方标签行（~19pt）还大，分组就反了。
    // 4 是「贴着自己的内容」的量级，不引间距令牌（最小档 xs 就是 8，反而会退回原样）。
    marginBottom: 4,
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
    justifyContent: 'center',
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
