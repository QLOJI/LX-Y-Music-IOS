import { TouchableOpacity } from 'react-native'
import { Icon } from '@/components/common/Icon'
import { useIsPlay } from '@/store/player/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { playNext, playPrev, togglePlay } from '@/core/player/player'
import { applyOpacity } from '@/utils/colorOpacity'
import { createStyle } from '@/utils/tools'
import { useHorizontalMode } from '@/utils/hooks'

const BTN_SIZE = 24
const handlePlayPrev = () => {
  void playPrev()
}
const handlePlayNext = () => {
  void playNext()
}

const PlayPrevBtn = () => {
  const theme = useTheme()

  return (
    <TouchableOpacity style={styles.cotrolBtn} activeOpacity={0.5} onPress={handlePlayPrev}>
      <Icon name="prevMusic" color={theme['c-font']} size={BTN_SIZE} />
    </TouchableOpacity>
  )
}

const PlayNextBtn = () => {
  const theme = useTheme()

  return (
    <TouchableOpacity style={styles.cotrolBtn} activeOpacity={0.5} onPress={handlePlayNext}>
      <Icon name="nextMusic" color={theme['c-font']} size={BTN_SIZE} />
    </TouchableOpacity>
  )
}

const TogglePlayBtn = () => {
  const isPlay = useIsPlay()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')

  return (
    <TouchableOpacity
      // 按钮底色随「按钮透明度」淡出
      style={{ ...styles.cotrolBtn, ...styles.playButton, backgroundColor: applyOpacity(theme['c-primary'], buttonOpacity) }}
      activeOpacity={0.5}
      onPress={togglePlay}
    >
      <Icon
        name={isPlay ? 'pause' : 'play'}
        color={theme['c-primary-light-1000']}
        size={18}
      />
    </TouchableOpacity>
  )
}

export default () => {
  const isHorizontalMode = useHorizontalMode()
  return (
    <>
      {/* <TouchableOpacity activeOpacity={0.5} onPress={toggleNextPlayMode}>
        <Text style={{ ...styles.cotrolBtn }}>
          <Icon name={playModeIcon} style={{ color: theme.secondary10 }} size={18} />
        </Text>
      </TouchableOpacity>
    */}
      {/* {btnPrev} */}
      {isHorizontalMode ? <PlayPrevBtn /> : null}
      <TogglePlayBtn />
      <PlayNextBtn />
    </>
  )
}

const styles = createStyle({
  cotrolBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playButton: {
    borderRadius: 999,
    // 播放/暂停与下一首的 40×40 热区留出空隙防误触；播放列表按钮移除后右侧
    // 空间变宽，间距放宽到 8（图标视觉间距 = 8 + 两侧热区留白 16 = 24pt）
    marginRight: 8,
  },
})
