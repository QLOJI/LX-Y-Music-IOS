import { useEffect, useMemo, useState } from 'react'
import { ScrollView, TouchableOpacity } from 'react-native'

import { createStyle } from '@/utils/tools'
import { applyOpacity } from '@/utils/colorOpacity'
import { type SearchType } from '@/store/search/state'
import { useI18n } from '@/lang'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { getSearchSetting } from '@/utils/data'
import { designRadius, designSpacing } from '@/theme/DesignTokens'

const SEARCH_TYPE_LIST = ['music', 'songlist', 'singer', 'album'] as const

export default () => {
  const t = useI18n()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
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
  // 激活态（c-primary 实底）一起处理，避免未激活透明、当前类型实心的割裂。
  const activeButtonStyle = useMemo(
    () => ({
      backgroundColor: applyOpacity(theme['c-primary'], buttonOpacity),
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
          style={[styles.button, type == item.id ? activeButtonStyle : inactiveButtonStyle]}
          onPress={() => {
            handleTypeChange(item.id)
          }}
          key={item.id}
        >
          <Text
            style={{
              ...styles.buttonText,
              color: type == item.id ? theme['c-primary-light-1000'] : theme['c-font-label'],
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
    paddingLeft: designSpacing.sm,
    paddingRight: designSpacing.sm,
    marginRight: designSpacing.sm,
    borderRadius: designRadius.pill,
    borderWidth: 1,
  },
  buttonText: {
    textAlign: 'center',
    fontWeight: '600',
  },
})
