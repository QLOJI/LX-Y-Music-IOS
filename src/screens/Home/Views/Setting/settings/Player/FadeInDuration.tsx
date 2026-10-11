// screens/Home/Views/Setting/settings/Player/FadeInDuration.tsx
//
// 【第 63 轮第 2 条】「渐入时长（秒）」滑块行。
// 需求原话：「渐入（Fade In）：音乐开始播放时，音量从 0 在指定时长内平滑升至正常音量。
// 默认时长：渐入 2 秒……（可在播放设置中配置，位置在将播放的中文歌词转换为繁体选项下面，
// 调节范围为 0-3 秒）」。位置由 settings/Player/index.tsx 保证（紧跟 <IsS2T />）。
//
// 单位与取值：键里存的是**秒**（0~3，步进 0.5），标题自带「（秒）」后缀，滑块旁的数值
// 就是秒数；0 = 关闭渐入（音量直写，等于第 39 轮之前）。消费方见 plugins/player/volumeFade.ts
// 的 fadeInMs()——那边对缺省 / 脏值兜底成 2 秒，对超范围的值夹到 0~3。
// 只对 iOS 生效（Android 侧没有 'playing' 兜底，见 volumeFade.ts 文件头末段）。

import { memo } from 'react'

import SliderRow from '../../components/SliderRow'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'

export default memo(() => {
  const t = useI18n()
  const fadeInDuration = useSettingValue('player.fadeInDuration')

  return (
    <SliderRow
      settingKey="player.fadeInDuration"
      title={t('setting_play_fade_in_duration')}
      desc={t('setting_play_fade_in_duration_desc')}
      value={fadeInDuration}
      maximumValue={3}
      step={0.5}
    />
  )
})
