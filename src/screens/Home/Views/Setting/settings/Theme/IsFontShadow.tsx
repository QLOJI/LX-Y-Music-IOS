import { memo } from 'react'
import { View } from 'react-native'

import CheckBoxItem from '../../components/CheckBoxItem'
import { createStyle } from '@/utils/tools'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { useSettingValue } from '@/store/setting/hook'

export default memo(() => {
  const t = useI18n()
  const isFontShadow = useSettingValue('theme.fontShadow')
  const setIsFontShadow = (isFontShadow: boolean) => {
    updateSetting({ 'theme.fontShadow': isFontShadow })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={isFontShadow}
        label={t('setting_basic_theme_font_shadow')}
        onChange={setIsFontShadow}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
    // A-6：删除 wrapper 的 marginBottom:15 —— 行距由 CheckBox 卡片的 8pt 统一提供
    // （CheckBoxItem 既定约定），此前 15+8 叠加成 ~23pt 双倍间距
  },
})
