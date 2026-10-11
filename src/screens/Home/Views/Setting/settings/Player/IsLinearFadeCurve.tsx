// screens/Home/Views/Setting/settings/Player/IsLinearFadeCurve.tsx
//
// 【第 63 轮第 2 条】「使用线性音量曲线」开关（渐入渐出的缓动曲线）。
// 需求原话：「缓动曲线：默认使用等功率曲线（Equal-Power），避免音量突变；可选线性（Linear）」。
// 【第 65 轮第 1 条】用户按听感把默认那条曲线换成了**缓入缓出**（原话「出声要缓，特别是两头
// 位置……曲线一定要缓」）—— 开关本身与设置键都没变，只是「不勾选」的含义从等功率变成缓入缓出。
//
// 为什么是复选框而不是单选：需求只给了两个选项，而设置页的行组件里没有单选 / 下拉行
//（components/ 下只有 CheckBoxItem / Section / SubTitle / SliderRow / InputItem / Slider /
// CheckBoxGrid / Button），复选框 + 「?」说明是最小且语义准确的表达 —— 不勾 = 缓入缓出（默认），
// 勾上 = 线性。
//
// 判据（消费方 plugins/player/volumeFade.ts 的 easeVolume）：缓入缓出是 `0.5 - 0.5·cos(π·p)`，
// 两端导数为 0（两头慢）、中段最陡；线性则是等幅度变化，人耳在中段会觉得掉得快。
// 曲线在**起斜坡时快照**，拖动这个开关不会改写在途斜坡。

import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'

import CheckBoxItem from '../../components/CheckBoxItem'

export default memo(() => {
  const t = useI18n()
  const isLinearCurve = useSettingValue('player.fadeLinearCurve')
  const setLinearCurve = (isLinear: boolean) => {
    updateSetting({ 'player.fadeLinearCurve': isLinear })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={isLinearCurve}
        onChange={setLinearCurve}
        label={t('setting_play_fade_linear_curve')}
        helpTitle={t('setting_play_fade_linear_curve')}
        helpDesc={t('setting_play_fade_linear_curve_desc')}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
