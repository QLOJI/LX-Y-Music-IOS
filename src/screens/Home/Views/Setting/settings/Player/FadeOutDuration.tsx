// screens/Home/Views/Setting/settings/Player/FadeOutDuration.tsx
//
// 【第 63 轮第 2 条】「渐出时长（秒）」滑块行。
// 需求原话：「渐出（Fade Out）：音乐停止或切换前，音量从当前值在指定时长内平滑降至 0。
// 默认时长：……渐出 3 秒（可在播放设置中配置，位置在将播放的中文歌词转换为繁体选项下面，
// 调节范围为 0-3 秒）」。
//
// 单位与取值：键里存的是**秒**（0~3，步进 0.5），0 = 关闭渐出（音量直写）。
// 真暂停跟在斜坡之后（锁屏 / 灵动岛 / 界面按钮的暂停态翻转都在那之后）——第 61 轮用户
// 原话「点击暂停播放按钮显示都有延迟了，需要还原」，所以那个量级的取舍写在这里：
// 3 秒是这个滑块的上限、也是默认值（需求原话「默认渐出 3 秒」），第 62 轮已经把界面反馈
// 改成「按下即翻」，暂停图标不再等斜坡，这条斜坡现在只影响**声音**什么时候降到 0。
// 消费方见 plugins/player/volumeFade.ts 的 fadeOutMs()（缺省 / 脏值兜底成 3 秒，超范围夹到 0~3）。

import { memo } from 'react'

import SliderRow from '../../components/SliderRow'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'

export default memo(() => {
  const t = useI18n()
  const fadeOutDuration = useSettingValue('player.fadeOutDuration')

  return (
    <SliderRow
      settingKey="player.fadeOutDuration"
      title={t('setting_play_fade_out_duration')}
      desc={t('setting_play_fade_out_duration_desc')}
      value={fadeOutDuration}
      maximumValue={3}
      step={0.5}
    />
  )
})
