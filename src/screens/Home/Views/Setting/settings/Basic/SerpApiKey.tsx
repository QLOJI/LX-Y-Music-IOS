import { memo } from 'react'
import InputItem, { type InputItemProps } from '../../components/InputItem'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'

export default memo(() => {
  const t = useI18n()
  const serpApiKey = useSettingValue('common.wy_serpapi_key')

  const handleSerpApiKeyChanged: InputItemProps['onChanged'] = (text, callback) => {
    callback(text)
    updateSetting({ 'common.wy_serpapi_key': text.trim() })
  }

  return (
    <InputItem
      value={serpApiKey}
      label="SerpApi API Key"
      onChanged={handleSerpApiKeyChanged}
      placeholder={t('serp_api_placeholder')}
    />
  )
})
