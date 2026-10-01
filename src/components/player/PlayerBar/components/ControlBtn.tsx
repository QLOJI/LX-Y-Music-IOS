import { TouchableOpacity } from 'react-native'
import { Icon } from '@/components/common/Icon'
import { useIsPlay } from '@/store/player/hook'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { playNext, playPrev, togglePlay } from '@/core/player/player'
import { useButtonRadius } from '@/utils/buttonRadius'
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
  const buttonRadius = useButtonRadius()

  return (
    <TouchableOpacity style={[styles.cotrolBtn, { borderRadius: buttonRadius(40) }]} activeOpacity={0.5} onPress={handlePlayPrev}>
      <Icon name="prevMusic" color={theme['c-font']} size={BTN_SIZE} />
    </TouchableOpacity>
  )
}

const PlayNextBtn = () => {
  const theme = useTheme()
  const buttonRadius = useButtonRadius()

  return (
    <TouchableOpacity style={[styles.cotrolBtn, { borderRadius: buttonRadius(40) }]} activeOpacity={0.5} onPress={handlePlayNext}>
      <Icon name="nextMusic" color={theme['c-font']} size={BTN_SIZE} />
    </TouchableOpacity>
  )
}

const TogglePlayBtn = () => {
  const isPlay = useIsPlay()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()

  return (
    <TouchableOpacity
      // 播放/暂停键＝「收藏歌单」按钮同一套配色（2026-10-01 需求）：
      //   底色 淡灰 c-primary-background、图标 c-primary-font（= 收藏歌单的文字色）。
      // 原先这里是「主色实底 + 纯白图标」，是全应用唯一一颗实心主色圆形功能键。
      //
      // 底色随「按钮透明度」淡出（与收藏歌单 / 返回 / 播放全部同口径）：旧实现**刻意不接**
      // 该设置，理由是白图标离开实心底就看不见；现在图标是 c-primary-font（浅色主题下是
      // 深主色）压在透明底上依然可辨，那条例外已不成立，再保留就成了「同一屏里只有它
      // 不跟随设置」。只改颜色 alpha，不用容器 opacity（会把图标一起变淡）。
      // 热区为 cotrolBtn 的 40×40（静态圆角 999 = 圆钮），行内覆盖按 40 换算
      style={{
        ...styles.cotrolBtn,
        ...styles.playButton,
        backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
        borderRadius: buttonRadius(40),
      }}
      activeOpacity={0.5}
      onPress={togglePlay}
    >
      <Icon
        name={isPlay ? 'pause' : 'play'}
        color={theme['c-primary-font']}
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
