import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'

import CheckBoxItem from '../../components/CheckBoxItem'

/**
 * 「启动后打开播放详情页」（用户第 33 轮第 7 条：「在播放设置中新增"启动后打开播放详情页"选项，
 * 放在"返回软件时自动播放"选项下面，移植 lx-music-mobile-ios-adaptation 项目基本设置中该功能」）。
 *
 * 组件本体是移植过来的（key `player.startupPushPlayDetailScreen`、标签
 * `setting_basic_startup_push_play_detail_screen` 与参考工程逐字一致），但它在本工程里
 * **从来没被挂载过** —— 一直躺在 settings/Basic 目录下无人 import，所以选项在界面上根本不存在。
 * 本轮把它挪到 Player 设置目录（组件跟着它所属的设置页走），挂到「返回软件时自动播放」下面。
 *
 * 消费点早已就位（无需改动）：src/screens/Home/index.tsx 的启动 effect 里
 * `if (settingState.setting['player.startupPushPlayDetailScreen']) navigations.pushPlayDetailScreen(componentId)`，
 * 且本工程的 pushPlayDetailScreen 比参考工程多一道「没有正在播放的歌就不开页」守卫
 * （避免空状态卡死），转场沿用系统默认（第 12 轮定案：自定义 animations 曾导致卡死事故）。
 */
export default memo(() => {
  const t = useI18n()
  const startupPushPlayDetailScreen = useSettingValue('player.startupPushPlayDetailScreen')
  const setStartupPushPlayDetailScreen = (startupPushPlayDetailScreen: boolean) => {
    updateSetting({ 'player.startupPushPlayDetailScreen': startupPushPlayDetailScreen })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={startupPushPlayDetailScreen}
        label={t('setting_basic_startup_push_play_detail_screen')}
        onChange={setStartupPushPlayDetailScreen}
      />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
    // marginBottom: 15,
  },
})
