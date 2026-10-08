import { memo } from 'react'
import { View } from 'react-native'

import CheckBoxItem from '../../components/CheckBoxItem'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { createStyle, toast } from '@/utils/tools'

/**
 * 「启用音频卸载」（用户第 33 轮第 7 条：「通过这个项目，完善"启用音频卸载"选项功能，目前不可用需修复」）。
 *
 * 修复分两处，本文件只负责其中一处的**提示**：
 *   ① 接线（plugins/player/index.ts）：audioOffload 以前硬编码 false、形参还带 `_` 前缀（声明了不用），
 *      开关勾不勾都一样 —— 现已改成取本设置值；
 *   ② 提示：本文件原先把 toast 文案写成 `setting_play_handle_audio_focus_tip`（「立即生效，无需重启」），
 *      那是「与其他应用同时播放」的文案，与本开关的生效时机完全相反（audioOffload 只在播放器
 *      初始化时读一次，本设置自带的帮助文案也写着「关闭该选项后完全重启应用再试」）。
 *      改为专用文案。
 *
 * 这里刻意**不**调用 reloadConfig：播放中重建播放器会让锁屏 / 灵动岛卡片消失、原生引擎
 * 有进度没声音（第 24 轮实锤），与「重启后生效」的既有文案一致。
 */
export default memo(() => {
  const t = useI18n()
  const isEnableAudioOffload = useSettingValue('player.isEnableAudioOffload')

  const setIsEnableAudioOffload = (value: boolean) => {
    updateSetting({ 'player.isEnableAudioOffload': value })
    toast(t('setting_play_audio_offload_tip_updated'))
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={isEnableAudioOffload}
        onChange={setIsEnableAudioOffload}
        helpDesc={t('setting_play_audio_offload_tip')}
        label={t('setting_play_audio_offload')}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
