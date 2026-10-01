import { useRef, forwardRef, useImperativeHandle, useMemo } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'

// import music from '@/utils/musicSdk'
import { designSpacing } from '@/theme/DesignTokens'
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
}

export interface HeaderBarType {
  setText: SearchInputType['setText']
  focus: SearchInputType['focus']
  blur: SearchInputType['blur']
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
  }, ref) => {
    const searchInputRef = useRef<SearchInputType>(null)
    const theme = useTheme()
    const buttonOpacity = useSettingValue('theme.buttonOpacity')
    const statusBarHeight = useStatusbarHeight()
    const t = useI18n()
    const buttonRadius = useButtonRadius()

    // 搜索平台胶囊：底色随「按钮透明度」淡出，文字色不动。只改颜色 alpha，
    // 不能用容器 style.opacity——那会把胶囊文字一起变淡。
    // 激活态（c-primary 实底）一起处理，避免未激活透明、当前平台实心的割裂。
    const activePlatformStyle = useMemo(
      () => ({
        backgroundColor: applyOpacity(theme['c-primary'], buttonOpacity),
      }),
      [theme, buttonOpacity],
    )
    const inactivePlatformStyle = useMemo(
      () => ({
        backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-200'], buttonOpacity),
      }),
      [theme, buttonOpacity],
    )

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
      }),
      [],
    )

    return (
      <View style={[styles.container, { paddingTop: Math.max(designSpacing.sm, statusBarHeight - designSpacing.md) }]}>
        <View style={styles.openHeader}>
          {/* 搜索框容器是输入控件（不是按钮），不随「按钮透明度」变化 */}
          <View
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
                  color={isActive ? theme['c-primary-light-1000'] : theme['c-font']}
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
    marginBottom: designSpacing.xs,
  },
  openHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: designSpacing.lg,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    marginRight: designSpacing.sm,
    marginBottom: designSpacing.sm,
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
    marginTop: designSpacing.xs,
  },
  platformScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  platformContent: {
    paddingHorizontal: designSpacing.lg,
    paddingVertical: designSpacing.sm,
  },
  platformItem: {
    minHeight: 38,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: designSpacing.md,
    marginRight: designSpacing.sm,
    borderRadius: 999,
  },
})
