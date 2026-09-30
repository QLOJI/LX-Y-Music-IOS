import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'
import { createStyle } from '@/utils/tools'

import CheckBoxItem from '../../components/CheckBoxItem'

export default memo(() => {
  const t = useI18n()
  const qualityShowHighest = useSettingValue('common.quality_show_highest')
  const handleUpdate = (qualityShowHighest: boolean) => {
    updateSetting({ 'common.quality_show_highest': qualityShowHighest })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={qualityShowHighest}
        onChange={handleUpdate}
        label={t('setting_common_quality_show_highest')}
        helpDesc={t('setting_common_quality_show_highest_tip')}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    // A-6：删除 wrapper 的 marginBottom:15 —— 行距由 CheckBox 卡片的 8pt 统一提供
    // （CheckBoxItem 既定约定），此前 15+8 叠加成 ~23pt 双倍间距
  },
})
