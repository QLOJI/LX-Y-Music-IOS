import { useState } from 'react'

import { View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'
import { useSettingValue } from '@/store/setting/hook'
import Slider, { type SliderProps } from '@/components/common/Slider'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import styles from './style'

// 【第 171 轮】当前歌词行缩放 1.0~1.5 倍。
// 存储用百分数（100~150），与歌词字体大小同一套设置通道；显示成一位小数。
const LrcZoom = ({ direction }: { direction: 'horizontal' | 'vertical' }) => {
  const theme = useTheme()
  const settingKey =
    direction == 'horizontal'
      ? 'playDetail.horizontal.style.lrcZoom'
      : 'playDetail.vertical.style.lrcZoom'
  const lrcZoom = useSettingValue(settingKey)
  const [sliderZoom, setSliderZoom] = useState(lrcZoom)
  const [isSliding, setSliding] = useState(false)
  const t = useI18n()

  const handleSlidingStart: SliderProps['onSlidingStart'] = (_value) => {
    setSliding(true)
  }
  const handleValueChange: SliderProps['onValueChange'] = (value) => {
    setSliderZoom(value)
  }
  const handleSlidingComplete: SliderProps['onSlidingComplete'] = (value) => {
    setSliding(false)
    if (lrcZoom == value) return
    updateSetting({ [settingKey]: value })
  }

  return (
    <View style={styles.container}>
      <Text>{t('play_detail_setting_lrc_zoom')}</Text>
      <View style={styles.content}>
        <Text style={styles.label} color={theme['c-font-label']}>
          {((isSliding ? sliderZoom : lrcZoom) / 100).toFixed(1)}
        </Text>
        <Slider
          minimumValue={100}
          maximumValue={150}
          onSlidingComplete={handleSlidingComplete}
          onValueChange={handleValueChange}
          onSlidingStart={handleSlidingStart}
          step={10}
          value={lrcZoom}
        />
      </View>
    </View>
  )
}

export default LrcZoom
