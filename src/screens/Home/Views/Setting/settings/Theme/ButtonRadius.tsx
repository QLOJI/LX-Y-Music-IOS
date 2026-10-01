// screens/Home/Views/Setting/settings/Theme/ButtonRadius.tsx
//
// 「按钮圆角」：按钮族（按钮 / 胶囊 / 芯片 / 图标按钮 / 分段控件 / 内联小按钮）的
// 圆角半径比例，0-100。刻度是**绝对比例**（2026-10-01 用户定案，否掉了
// 「0% = 保持现状」的相对方案）：
//
//   0   = 直角（方角）—— 默认值
//   100 = 半圆：容器侧面圆弧闭合成半圆。RN 会把圆角夹到 min(宽, 高) / 2，
//         所以 100% 走的是一个超大值（见 utils/buttonRadius.ts 的 FULL_SEMICIRCLE），
//         任何尺寸的按钮都能拿到精确半圆，不需要测量真实高度。
//   中间值按各按钮**自身高度的一半**线性插值 —— 所以同一个百分比下，矮胶囊与高
//   按钮各自走完自己的一半，不会出现「矮的先圆、高的永远圆不了」。
//
// 与「按钮透明度」的两个关键差别：
//   1) 透明度只动颜色的 alpha，圆角改的是几何，无法用行内颜色覆盖，必须逐个调用点
//      覆盖 borderRadius；
//   2) 静态样式（createStyle）里的圆角在模块加载时就固化了，改设置不会重新求值，
//      因此生效值一律来自 useButtonRadius() 的行内覆盖。
// 覆盖范围与「按钮透明度」一致：推荐 / 歌单 / 搜索 / 我的 / 设置等页面的按钮族。

import { memo } from 'react'

import SliderRow from '../../components/SliderRow'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'

export default memo(() => {
  const t = useI18n()
  const buttonRadius = useSettingValue('theme.buttonRadius')

  return (
    <SliderRow
      settingKey="theme.buttonRadius"
      title={t('setting_basic_theme_button_radius')}
      desc={t('setting_basic_theme_button_radius_desc')}
      value={buttonRadius}
    />
  )
})
