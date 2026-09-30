// screens/Home/Views/Setting/settings/Theme/ButtonOpacity.tsx
//
// 「按钮透明度」：按钮族（圆角 + 1px 边框 + 半透明主题色底）的**底色与边框**不透明度，0-100。
//
// 100 = 完全不透明（默认，视觉与既有版本一致）；0 = 底色与边框全透明，只剩文字。
// 作用对象是颜色的 alpha（applyOpacity），**不是**容器 style.opacity —— 后者会把
// 文字一起淡出，与「0 时只剩文字」的要求相反。
// 覆盖范围：推荐 / 歌单 / 搜索 / 我的 / 设置 五个页面里同视觉族的按钮与胶囊。

import { memo } from 'react'

import SliderRow from '../../components/SliderRow'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'

export default memo(() => {
  const t = useI18n()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')

  return (
    <SliderRow
      settingKey="theme.buttonOpacity"
      title={t('setting_basic_theme_button_opacity')}
      desc={t('setting_basic_theme_button_opacity_desc')}
      value={buttonOpacity}
    />
  )
})
