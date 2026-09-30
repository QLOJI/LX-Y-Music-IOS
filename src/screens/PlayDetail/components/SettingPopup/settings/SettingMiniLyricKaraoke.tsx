import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import CheckBox from '@/components/common/CheckBox'
import styles from './style'

// 小歌词逐字高亮（开关）：
//   开 —— 当前行按「已唱 / 未唱」两色推进。该行有逐字时间戳时走真实时间轴，
//         没有则按字符数均分该行时长做线性推进；
//   关 —— 回到整行高亮（当前行一种颜色、其余一种颜色）。
// 与「小歌词对齐」同属小歌词的展示设置，故紧邻放置。
export default () => {
  const t = useI18n()
  const isKaraoke = useSettingValue('playDetail.isMiniLyricKaraoke')
  const setMiniLyricKaraoke = (isKaraoke: boolean) => {
    updateSetting({ 'playDetail.isMiniLyricKaraoke': isKaraoke })
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <CheckBox
          check={isKaraoke}
          variant="plain"
          label={t('play_detail_setting_mini_lrc_karaoke')}
          onChange={setMiniLyricKaraoke}
        />
      </View>
    </View>
  )
}
