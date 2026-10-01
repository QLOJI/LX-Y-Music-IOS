import { useEffect, useMemo, useState } from 'react'
import { ScrollView, TouchableOpacity } from 'react-native'

import { createStyle } from '@/utils/tools'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { type SearchType } from '@/store/search/state'
import { useI18n } from '@/lang'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { getSearchSetting } from '@/utils/data'
import { controlGap, designRadius, designSpacing } from '@/theme/DesignTokens'

const SEARCH_TYPE_LIST = ['music', 'songlist', 'singer', 'album'] as const

export default () => {
  const t = useI18n()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  const [type, setType] = useState<SearchType>('music')

  useEffect(() => {
    void getSearchSetting().then((info) => {
      setType(info.type)
    })

    const handleTypeChange = (newType: SearchType) => {
      setType(newType)
    }
    global.app_event.on('searchTypeChanged', handleTypeChange)
    return () => {
      global.app_event.off('searchTypeChanged', handleTypeChange)
    }
  }, [])

  const list = useMemo(() => {
    return SEARCH_TYPE_LIST.map((type) => ({ label: t(`search_type_${type}`), id: type }))
  }, [t])

  const handleTypeChange = (type: SearchType) => {
    setType(type)
    global.app_event.searchTypeChanged(type)
  }

  // 歌曲/歌单/歌手/专辑切换按钮：底色与边框随「按钮透明度」淡出，文字色不动。
  // 只改颜色 alpha，不能用容器 style.opacity——那会把文字一起变淡。
  // 选中态一起处理，避免未选中透明、当前类型实心的割裂。
  // 选中态底色由「主色实底」改为主色的 20% 淡染：选中文字已统一改为主题主色
  // （与设置里「LX-Y Music 字体大小预览」同一个色值），同色实心底会把文字吃掉。
  const activeButtonStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary-alpha-800'], buttonOpacity),
      borderColor: applyOpacity(theme['c-primary'], buttonOpacity),
      borderWidth: 1,
    }),
    [theme, buttonOpacity],
  )
  const inactiveButtonStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-200'], buttonOpacity),
      borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
      borderWidth: 1,
    }),
    [theme, buttonOpacity],
  )

  return (
    <ScrollView style={styles.container} keyboardShouldPersistTaps={'always'} horizontal={true}>
      {list.map((item) => (
        <TouchableOpacity
          style={[
            styles.button,
            type == item.id ? activeButtonStyle : inactiveButtonStyle,
            // 类型切换按钮圆角随「按钮圆角」设置行内覆盖；高度取 styles.button 的源值 36
            { borderRadius: buttonRadius(36) },
          ]}
          onPress={() => {
            handleTypeChange(item.id)
          }}
          key={item.id}
        >
          <Text
            style={{
              ...styles.buttonText,
              color: type == item.id ? theme['c-primary'] : theme['c-font-label'],
            }}
          >
            {item.label}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  )
}

const styles = createStyle({
  container: {
    height: '100%',
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  button: {
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
    // 内边距与其余胶囊行统一为 md(16)（原 sm 12）
    paddingLeft: designSpacing.md,
    paddingRight: designSpacing.md,
    // 按钮之间的外间距：全应用按钮行统一 controlGap（值与原 sm 相同，仅收敛来源）
    marginRight: controlGap,
    borderRadius: designRadius.pill,
    borderWidth: 1,
  },
  buttonText: {
    textAlign: 'center',
    fontWeight: '600',
  },
})
