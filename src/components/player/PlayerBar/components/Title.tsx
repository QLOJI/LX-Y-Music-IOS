import { View } from 'react-native'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { useSettingValue } from '@/store/setting/hook'
import MarqueeText from '@/components/common/MarqueeText'
import { createStyle, formatMusicName } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'

export default () => {
  const musicInfo = usePlayerMusicInfo()
  const downloadFileName = useSettingValue('download.fileName')
  const theme = useTheme()

  const title = musicInfo.id
    ? musicInfo.singer
      ? formatMusicName(downloadFileName, musicInfo.name, musicInfo.singer)
      : musicInfo.name
    : ''

  return (
    // 【第 30 轮·图十】歌名过长不再截断成「...」：跑马灯从右到左滚动（速率见 MarqueeText）。
    <View style={styles.container}>
      <MarqueeText
        text={title}
        color={theme['c-font']}
        style={{ fontWeight: '700' }}
      />
    </View>
  )
}
// const Singer = () => {
//   const playMusicInfo = useGetter('player', 'playMusicInfo')
//   return (
//     <View style={{ flexGrow: 0, flexShrink: 0 }}>
//       <Text style={{ width: '100%', color: AppColors.normal }} numberOfLines={1}>
//         {playMusicInfo ? playMusicInfo.musicInfo.singer : ''}
//       </Text>
//     </View>
//   )
// }
// const MusicName = () => {
//   const playMusicInfo = useGetter('player', 'playMusicInfo')
//   return (
//     <View style={{ flexGrow: 0, flexShrink: 1 }}>
//       <Text style={{ width: '100%', color: AppColors.normal }} numberOfLines={1}>
//         {playMusicInfo ? playMusicInfo.musicInfo.name : '^-^'}
//       </Text>
//     </View>
//   )
// }

const styles = createStyle({
  container: {
    width: '100%',
    paddingHorizontal: 2,
    // paddingBottom: 4,
    // height: '50%',
    // backgroundColor: 'rgba(0, 0, 0, .1)',
  },
})
