import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle, toast } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'

import CheckBoxItem from '../../components/CheckBoxItem'

export default memo(() => {
  const t = useI18n()
  const isDownloadEnable = useSettingValue('download.enable')
  const handleUpdate = (isDownloadEnable: boolean) => {
    if (isDownloadEnable) {
      toast(t('setting_download_enabled_tip'))
    }
    updateSetting({ 'download.enable': isDownloadEnable })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={isDownloadEnable}
        onChange={handleUpdate}
        label={t('setting_download_enable')}
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
