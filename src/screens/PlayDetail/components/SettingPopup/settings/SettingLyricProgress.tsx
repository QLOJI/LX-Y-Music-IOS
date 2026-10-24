import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import CheckBox from '@/components/common/CheckBox'
import styles from './style'

// 【第 190 轮】歌词手动定位浮层（虚线 + 时间 + 播放三角）开关。
// 该设置此前只有消费方、没有入口，用户无法关闭拖动歌词时的浮层。
export default () => {
  const t = useI18n()
  const isShow = useSettingValue('playDetail.isShowLyricProgressSetting')
  const setShow = (show: boolean) => {
    updateSetting({ 'playDetail.isShowLyricProgressSetting': show })
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <CheckBox
          check={isShow}
          variant="plain"
          label={t('play_detail_setting_show_lyric_progress_setting')}
          onChange={setShow}
        />
      </View>
    </View>
  )
}
