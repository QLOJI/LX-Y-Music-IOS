import { updateSetting } from '@/core/common'
import { reloadConfig } from '@/plugins/player'
import { useI18n } from '@/lang'
import { createStyle, toast } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'

import CheckBoxItem from '../../components/CheckBoxItem'

export default memo(() => {
  const t = useI18n()
  // 存储语义不变：player.isHandleAudioFocus = true = 独占处理（其他应用出声时我们自动暂停）。
  // 【第 23 轮】设置项由「其他应用播放声音时，自动暂停播放」改名为「与其他应用同时播放」，
  // 勾选极性随之翻转（不改极性就是撒谎——名字意味着勾选=允许同时播放）：
  //   勾选   = 与其他应用同时播放 = 不独占 = isHandleAudioFocus 为 false
  //   不勾选 = 独占（其他应用出声时自动暂停）= isHandleAudioFocus 为 true
  // 老用户偏好映射无缝：旧「勾选（自动暂停）」= 新「不勾选」，真实行为不变。
  // 不勾选即第 21 轮修的场景：车机蓝牙下高德播报会打断音乐、播报结束自动恢复
  // （AppDelegate 新路由判定 + service.ts 中断恢复三分支）。
  const isHandleAudioFocus = useSettingValue('player.isHandleAudioFocus')
  const playWithOthers = !isHandleAudioFocus
  const setPlayWithOthers = async(playWithOthers: boolean) => {
    // 写库时翻回存储语义：同时播放 = 不独占
    updateSetting({ 'player.isHandleAudioFocus': !playWithOthers })
    // 切换后重新初始化播放器，让 iOS 音频会话分类（mixWithOthers）立即生效。
    await reloadConfig().catch(() => {})
    toast(t('setting_play_handle_audio_focus_tip'))
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={playWithOthers}
        onChange={setPlayWithOthers}
        label={t('setting_play_handle_audio_focus')}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
