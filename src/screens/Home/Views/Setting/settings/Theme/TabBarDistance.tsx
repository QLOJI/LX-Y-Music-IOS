// screens/Home/Views/Setting/settings/Theme/TabBarDistance.tsx
//
// 「Tab栏距离」：迷你播放条底边与底部 tab 栏之间的间距，0-100。
//
// 100 = 标准字体下的既有距离（20pt），0 = 播放器贴合 tab 栏。滑块是**相对量**：
// 间距由「两端的缩放口径一致」算出，不再随字体大小变化（改字体只改 tab 栏自身
// 高度与播放条位置，两者同缩放，差值恒定 = 本滑块的值）。
// 见 DesignTokens.tabBarBaseHeight / tabBarDistanceMax 与 PlayerBar/index.tsx。

import { memo } from 'react'

import SliderRow from '../../components/SliderRow'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'

export default memo(() => {
  const t = useI18n()
  const tabBarDistance = useSettingValue('theme.tabBarDistance')

  return (
    <SliderRow
      settingKey="theme.tabBarDistance"
      title={t('setting_basic_theme_tab_bar_distance')}
      desc={t('setting_basic_theme_tab_bar_distance_desc')}
      value={tabBarDistance}
    />
  )
})
