import { useRef, forwardRef, useImperativeHandle, useMemo, useCallback } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'

// import music from '@/utils/musicSdk'
import { controlGap, designSpacing } from '@/theme/DesignTokens'
// import InsetShadow from 'react-native-inset-shadow'
import SearchInput, { type SearchInputType, type SearchInputProps } from './SearchInput'
import { createStyle } from '@/utils/tools'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useStatusbarHeight } from '@/store/common/hook'
import { useI18n } from '@/lang'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { type Source as MusicSource } from '@/store/search/music/state'
import { type Source as SonglistSource } from '@/store/search/songlist/state'

type Sources = Readonly<Array<MusicSource | SonglistSource>>

export interface HeaderBarProps {
  sources: Sources
  source: MusicSource | SonglistSource
  onSourceChange: (source: MusicSource | SonglistSource) => void
  onTipSearch: SearchInputProps['onChangeText']
  onSearch: SearchInputProps['onSubmit']
  onHideTipList: SearchInputProps['onBlur']
  onOpenSearch: SearchInputProps['onFocus']
  onCancelSearch: () => void
  onShowTipList: SearchInputProps['onTouchStart']
  // 上报搜索框行自身几何（**窗口坐标**，供筛选建议浮层「贴搜索框下端 + 等宽」定位）。
  // 第 17 轮改窗口坐标：搜索框行挂在结果列表的 header 里，iOS 上列表被全局 swizzle 强制
  // contentInsetAdjustmentBehavior，安全区顶部插图（以及滚动偏移）只体现在 measureInWindow
  // 的窗口坐标里；第 16 轮拿 header 内部 onLayout 的 layout 坐标当页面坐标用，恰好少了一个
  // 安全区（实测 ≈59pt），联想浮层从搜索框上方起画、把输入框整个盖住。
  onSearchBarLayout?: (rect: { x: number, y: number, width: number, height: number }) => void
}

export interface HeaderBarType {
  setText: SearchInputType['setText']
  focus: SearchInputType['focus']
  blur: SearchInputType['blur']
  // 浮层显示前刷新实测（点输入框 / 输入内容 / show 之前调用；第 17 轮）
  measureSearchBar: () => void
}

export default forwardRef<HeaderBarType, HeaderBarProps>(
  ({
    sources,
    source,
    onSourceChange,
    onTipSearch,
    onSearch,
    onHideTipList,
    onOpenSearch,
    onCancelSearch,
    onShowTipList,
    onSearchBarLayout,
  }, ref) => {
    const searchInputRef = useRef<SearchInputType>(null)
    const searchBarRowRef = useRef<View>(null)
    const theme = useTheme()
    const buttonOpacity = useSettingValue('theme.buttonOpacity')
    const statusBarHeight = useStatusbarHeight()
    const t = useI18n()
    const buttonRadius = useButtonRadius()
    // 容器上内边距：styles.container 的 paddingTop（第 17 轮起不再用于任何坐标换算 ——
    // 浮层锚点只用 measureInWindow 的窗口坐标，见 measureSearchBar）
    const containerPaddingTop = Math.max(designSpacing.sm, statusBarHeight - designSpacing.md)

    // 搜索平台胶囊：底色随「按钮透明度」淡出，文字色不动。只改颜色 alpha，
    // 不能用容器 style.opacity——那会把胶囊文字一起变淡。
    // 选中态一起处理，避免未选中透明、当前平台实心的割裂。
    // 选中态底色由「主色实底」改为主色的 20% 淡染：选中文字已统一改为主题主色
    // （与设置里「LX-Y Music 字体大小预览」同一个色值），同色实心底会把文字吃掉。
    const activePlatformStyle = useMemo(
      () => ({
        backgroundColor: applyOpacity(theme['c-primary-alpha-800'], buttonOpacity),
      }),
      [theme, buttonOpacity],
    )
    const inactivePlatformStyle = useMemo(
      () => ({
        backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-200'], buttonOpacity),
      }),
      [theme, buttonOpacity],
    )

    // 搜索框行的窗口坐标实测（y + height 即行的屏幕底边）：measureInWindow 的坐标天然包含
    // 列表的安全区插图与滚动偏移，这正是第 16 轮「header 内部 layout 坐标」缺的那一项
    // （第 17 轮：浮层锚点坐标空间错位、少一个安全区，联想浮层盖住搜索框）。
    const measureSearchBar = useCallback(() => {
      searchBarRowRef.current?.measureInWindow((x, y, width, height) => {
        onSearchBarLayout?.({ x, y, width, height })
      })
    }, [onSearchBarLayout])

    useImperativeHandle(
      ref,
      () => ({
        setText(text) {
          searchInputRef.current?.setText(text)
        },
        focus() {
          searchInputRef.current?.focus()
        },
        blur() {
          searchInputRef.current?.blur()
        },
        measureSearchBar,
      }),
      [measureSearchBar],
    )

    return (
      <View style={[styles.container, { paddingTop: containerPaddingTop }]}>
        <View style={styles.openHeader}>
          {/* 搜索框容器是输入控件（不是按钮），不随「按钮透明度」变化 */}
          <View
            ref={searchBarRowRef}
            collapsable={false}
            onLayout={measureSearchBar}
            style={{
              ...styles.searchBar,
              flexShrink: 1,
              backgroundColor: theme['c-primary-light-900-alpha-300'],
              borderColor: theme['c-border-background'],
              // 搜索框圆角随「按钮圆角」设置行内覆盖；高度取 styles.searchBar.height 的源值 48
              borderRadius: buttonRadius(48),
            }}
          >
            <View style={styles.searchIcon}>
              <Icon name="search-2" size={17} color={theme['c-font-label']} />
            </View>
            <SearchInput
              ref={searchInputRef}
              onChangeText={onTipSearch}
              onSubmit={onSearch}
              onBlur={onHideTipList}
              onFocus={onOpenSearch}
              onTouchStart={onShowTipList}
            />
          </View>
          <Text style={styles.cancelButton} color={theme['c-primary']} onPress={onCancelSearch}>
            取消
          </Text>
        </View>
        <View style={styles.platformHeader}>
          <Text size={17} color={theme['c-font']}>搜索平台</Text>
          <Text size={13} color={theme['c-primary']}>{t(`source_${source}`)}</Text>
        </View>
        <ScrollView
          style={styles.platformScroll}
          contentContainerStyle={styles.platformContent}
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
        >
          {sources.map((sourceId) => {
            const isActive = sourceId == source
            return (
              <TouchableOpacity
                key={sourceId}
                style={[
                  styles.platformItem,
                  isActive ? activePlatformStyle : inactivePlatformStyle,
                  // 平台胶囊圆角随「按钮圆角」设置行内覆盖；高度取 styles.platformItem 的 minHeight 源值 38（单行胶囊实际高度）
                  { borderRadius: buttonRadius(38) },
                ]}
                onPress={() => {
                  onSourceChange(sourceId)
                }}
              >
                <Text
                  size={15}
                  color={isActive ? theme['c-primary'] : theme['c-font']}
                >
                  {t(`source_${sourceId}`)}
                </Text>
              </TouchableOpacity>
            )
          })}
        </ScrollView>
      </View>
    )
  },
)

const styles = createStyle({
  container: {
    zIndex: 2,
    // 不设 marginBottom：平台胶囊行自身已有 platformContent.paddingVertical(controlGap)
    // 作为下留白，再叠一个 marginBottom 会让「胶囊行 → 类型按钮行」变成 20pt 以上
    // （RN 相邻 margin 不合并），是搜索页里最明显的一处「间距太远」。
  },
  openHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: designSpacing.lg,
    // 搜索框行 → 「搜索平台」标题行的间距（controlGap，与下方各行间距同值）。
    // 必须挂在**行**上而不是搜索框上：挂在搜索框上时本行高度会变成 48 + controlGap，
    // 「取消」文字按整行垂直居中就会比搜索框中心低半个 controlGap（用户第 11 轮
    // 第 6 条「取消文字偏下」）。挂到行上后行高 = 搜索框高 = 48，两者自然同轴。
    marginBottom: controlGap,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    marginRight: designSpacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    zIndex: 2,
  },
  searchIcon: {
    paddingLeft: designSpacing.sm,
    paddingRight: 4,
    justifyContent: 'center',
  },
  cancelButton: {
    fontWeight: '700',
  },
  platformHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: designSpacing.lg,
    // 与上方搜索框行的间距由 searchBar.marginBottom（controlGap）承担，这里不再叠加
    // marginTop：旧写法 xs(8) + sm(12) = 20pt，比同页其它行距（12）明显更远。
  },
  platformScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  platformContent: {
    paddingHorizontal: designSpacing.lg,
    // 平台胶囊行的上/下留白：controlGap，同时充当「标题行 → 胶囊行」与
    // 「胶囊行 → 类型按钮行」两处间距（下方 typeRow 已不再额外加 marginBottom）。
    paddingVertical: controlGap,
  },
  platformItem: {
    minHeight: 38,
    justifyContent: 'center',
    alignItems: 'center',
    // 内边距 md(16)：与 PlatformChips / SortTab / TagRows 的胶囊同值
    paddingHorizontal: designSpacing.md,
    // 胶囊之间的外间距：全应用按钮行统一 controlGap
    marginRight: controlGap,
    borderRadius: 999,
  },
})
