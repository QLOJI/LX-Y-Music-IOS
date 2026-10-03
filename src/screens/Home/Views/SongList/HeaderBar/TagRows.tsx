import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { createStyle } from '@/utils/tools'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import Text from '@/components/common/Text'
import { getTags } from '@/core/songlist'
import { type Source, type TagInfo } from '@/store/songlist/state'
import { controlGap, designSpacing } from '@/theme/DesignTokens'

export interface TagRowsProps {
  onTagChange: (name: string, id: string) => void
}

export interface TagRowsType {
  setSource: (source: Source, activeId: string) => void
}

// 平台标签分组行：原侧边分组抽屉/左栏（TagList）改为平台按钮下方的行式布局，
// 每个分组一行（组名 + 横向滚动的标签胶囊），「默认」始终位于首行。
export default forwardRef<TagRowsType, TagRowsProps>(({ onTagChange }, ref) => {
  const theme = useTheme()
  const t = useI18n()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  // 「按钮圆角」：标签胶囊的行内覆盖（静态 borderRadius 原样保留作兜底）
  const buttonRadius = useButtonRadius()
  const [groups, setGroups] = useState<TagInfo['tags']>([])
  const [activeId, setActiveId] = useState('')
  // 「默认」已选中时再次点击 → 收起/展开下方各分组行（再次点击「默认」展开）
  const [collapsed, setCollapsed] = useState(false)
  const prevSource = useRef('')
  const isUnmountedRef = useRef(false)

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  useImperativeHandle(ref, () => ({
    setSource(source, activeId) {
      setActiveId(activeId)
      // 切换平台后分组默认收起，点「默认」展开
      setCollapsed(true)
      if (source == prevSource.current) return
      prevSource.current = source
      // 先展示「默认」占位，标签数据到达后补齐各分组
      setGroups([
        {
          name: '',
          list: [{ name: t('songlist_tag_default'), id: '', parent_id: '', parent_name: '', source }],
        },
      ])
      void getTags(source)
        .then((tagInfo) => {
          if (isUnmountedRef.current) return
          setGroups(
            [
              {
                name: '',
                list: [
                  {
                    name: t('songlist_tag_default'),
                    id: '',
                    parent_id: '',
                    parent_name: '',
                    source,
                  },
                ],
              },
              { name: t('songlist_tag_hot'), list: [...tagInfo.hotTag] },
              ...tagInfo.tags,
            ].filter((group) => group.list.length),
          )
        })
        .catch(() => {
          // 汽水等平台无标签列表（getTags reject），保持默认空标签即可
        })
    },
  }))

  // 标签胶囊的底色/边框随「按钮透明度」淡出，文字色不动。只改颜色 alpha，
  // 不能用容器 style.opacity——那会把胶囊文字一起变淡。
  // 选中态一起处理，避免未选中透明、选中实心的割裂。
  // 选中态底色由「主色实底」改为主色的 20% 淡染：选中文字已统一改为主题主色
  // （与设置里「LX-Y Music 字体大小预览」同一个色值），同色实心底会把文字吃掉。
  const activeTagStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary-alpha-800'], buttonOpacity),
      borderColor: applyOpacity(theme['c-primary'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )
  const inactiveTagStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-300'], buttonOpacity),
      borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
    }),
    [theme, buttonOpacity],
  )

  const handlePress = (name: string, id: string) => {
    // 「默认」被选中时再次点击 → 切换分组行的收起/展开（不重复触发筛选）
    if (id === '' && activeId === '') {
      setCollapsed(c => !c)
      return
    }
    setActiveId(id)
    onTagChange(name, id)
  }

  return (
    <View style={styles.container}>
      {(collapsed ? groups.slice(0, 1) : groups).map((group, index) => (
        // 【第 21 轮·图十三】组名（热门/主题/场景/心情…）提到横向 ScrollView **外面**，
        // 与胶囊行并排：组名固定不动，只有右侧的标签胶囊能左右滑。旧实现把组名放在
        // ScrollView 的内容里，滑动时组名跟着一起被推出屏幕（用户截图里的现象）。
        <View key={`${group.name}-${index}`} style={styles.groupRow}>
          {group.name ? (
            <Text
              style={styles.groupName}
              size={13}
              color={theme['c-font-label']}
              numberOfLines={1}
            >
              {group.name}
            </Text>
          ) : null}
          <ScrollView
            style={styles.groupScroll}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={styles.groupContent}
          >
            {group.list.map((tag) => {
              const isActive = activeId == tag.id
              return (
                <Pressable
                  key={tag.id || `default-${index}`}
                  style={[
                    styles.tagButton,
                    isActive ? activeTagStyle : inactiveTagStyle,
                    // 标签胶囊圆角随「按钮圆角」设置行内覆盖；高度取 styles.tagButton 的源值 32（胶囊自身高度）
                    { borderRadius: buttonRadius(32) },
                  ]}
                  onPress={() => { handlePress(tag.name, tag.id) }}
                >
                  <Text
                    style={styles.tagText}
                    color={isActive ? theme['c-primary'] : theme['c-font']}
                  >
                    {tag.name}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
        </View>
      ))}
    </View>
  )
})

const styles = createStyle({
  container: {
    // 排序胶囊行 → 标签行（原为 xs 8，比同为「行间距」的 sortRow.marginTop 12 近）
    marginTop: controlGap,
    // 标签分组行与行之间：旧实现没有任何间距，展开多组时 32pt 高的胶囊上下贴在一起，
    // 是「有些间距太近」最极端的一处；现在与横向按钮间距同值（controlGap）。
    gap: controlGap,
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // 左边距由行容器统一提供（原挂在 groupContent 上）：有组名的行是「组名 + 胶囊」，
    // 无组名的「默认」行直接是胶囊 —— 两种行都从这里对齐到同一个左边界。
    paddingLeft: designSpacing.lg,
  },
  groupScroll: {
    // 只占「组名右边的剩余宽度」：胶囊在这个范围内横向滚动，组名在滚动区域之外，
    // 滑动时始终不动（第 21 轮·图十三）。
    flex: 1,
  },
  groupContent: {
    flexDirection: 'row',
    alignItems: 'center',
    // 左边距改由 groupRow 提供，这里只留右端留白（滚到最右时最后一个胶囊不贴边）
    paddingRight: designSpacing.lg,
  },
  groupName: {
    // 组名 → 本组第一个标签胶囊：与按钮间距同值（原 xs 8）
    marginRight: controlGap,
  },
  tagButton: {
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    // 胶囊内边距统一为 md(16)：与平台/排序/搜索平台的胶囊同值（原 sm 12）
    paddingHorizontal: designSpacing.md,
    // 标签胶囊之间：原 xs 8，是全部按钮行里唯一用 8 的一处（平台/排序/搜索平台
    // 胶囊与搜索类型按钮都是 12），统一到 controlGap。
    marginRight: controlGap,
    borderRadius: 999,
    borderWidth: 1,
  },
  tagText: {
    fontSize: 13,
    fontWeight: '600',
  },
})
