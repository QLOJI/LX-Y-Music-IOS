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

const styles = createStyle({
  container: {
    width: '100%',
    paddingHorizontal: 2,
  },
})
