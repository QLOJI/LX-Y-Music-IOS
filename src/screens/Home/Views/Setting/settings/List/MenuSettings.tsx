import { memo, useMemo } from 'react'
import { View } from 'react-native'
import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { createStyle } from '@/utils/tools'
import { applyOpacity } from '@/utils/colorOpacity'
import { useTheme } from '@/store/theme/hook'
import { designRadius, designSpacing } from '@/theme/DesignTokens'

type MenuSettingKey =
  | 'menu.playLater'
  | 'menu.dislike'

const SettingItem = ({ settingKey, label }: { settingKey: MenuSettingKey, label: string }) => {
  const value = useSettingValue(settingKey)
  const handleChange = (newValue: boolean) => {
    updateSetting({ [settingKey]: newValue })
  }

  return (
    <CheckBox
      check={value}
      onChange={handleChange}
      label={label}
    />
  )
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')

  // 卡片底色与边框随「按钮透明度」淡出，卡内文字不动。
  // 只改颜色 alpha，不用容器 style.opacity——那会把卡内文字一起变淡。
  const contentStyle = useMemo(() => ({
    ...styles.content,
    backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-200'], buttonOpacity),
    borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
  }), [theme, buttonOpacity])

  return (
    <SubTitle title="菜单设置">
      <View style={contentStyle}>
        <SettingItem settingKey="menu.playLater" label={t('play_later')} />
        <SettingItem settingKey="menu.dislike" label={t('dislike')} />
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  content: {
    marginTop: designSpacing.xs,
    padding: designSpacing.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: designSpacing.xs,
    borderWidth: 1,
    borderRadius: designRadius.md,
  },
})
