import { memo } from 'react'
import Section from '../components/Section'
import Theme from './Theme/Theme'
import ThemeMode from './Theme/ThemeMode'
import IsDynamicBg from './Theme/IsDynamicBg'
import IsLandscapeStretch from './Theme/IsLandscapeStretch'
import IsFontShadow from './Theme/IsFontShadow'
import Blur from './Theme/Blur'
import LiquidGlassToggle from './Theme/LiquidGlassToggle'
import GlassOpacity from './Theme/GlassOpacity'
import CustomBg from './Theme/CustomBg'
import PicOpacity from './Theme/PicOpacity'
import SubContainerOpacity from './Theme/SubContainerOpacity'
import TabBarDistance from './Theme/TabBarDistance'
import ButtonOpacity from './Theme/ButtonOpacity'
import ButtonRadius from './Theme/ButtonRadius'
import { useSettingValue } from '@/store/setting/hook'
import { isIOS26_2OrAbove } from '@/utils/tools'

export default memo(() => {
  const liquidGlass = useSettingValue('theme.liquidGlass')
  // 「玻璃不透明度」只对磨砂形态有意义：
  //   - 液态玻璃开 → 隐藏（液态的浓度由主题染色表达，不暴露滑杆）；
  //   - 关（磨砂）→ 显示。
  // **iOS 26.2+ 常显**（2026-09-30 定案）：26.2+ 已隐藏液态玻璃开关、效果强制
  // 系统磨砂（LiquidGlass 组件内兜底），磨砂浓度滑杆全程有意义，不再跟随残留的
  // 开关值。14~26.1 维持「开关关才显示」。
  const showGlassOpacity = !liquidGlass || isIOS26_2OrAbove

  return (
    <Section sectionId="setting_theme">
      <Theme />
      <ThemeMode />
      <IsDynamicBg />
      <IsLandscapeStretch />
      <CustomBg />
      <PicOpacity />
      <Blur />
      {/* 液态玻璃开关（仅 iOS 14~26.1，26.2+ 整行隐藏）：开 = vendored Metal 液态玻璃，关 = 系统磨砂 */}
      <LiquidGlassToggle />
      {showGlassOpacity && <GlassOpacity />}
      <SubContainerOpacity />
      <IsFontShadow />
      {/* 播放器 ↔ tab 栏间距（相对量，不随字体大小变化） */}
      <TabBarDistance />
      {/* 按钮底色/边框不透明度（100=现状，0=只剩文字） */}
      <ButtonOpacity />
      {/* 按钮圆角（绝对比例：0=直角，100=半圆），紧跟在按钮透明度下面 */}
      <ButtonRadius />
    </Section>
  )
})
