import { memo } from 'react'
import { View } from 'react-native'

import Progress from '@/components/player/ProgressBar'
import Status from './Status'
import { useProgress } from '@/store/player/hook'
import { useNavTransitioning, usePlayDetailOnTop } from '@/store/common/hook'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { useBufferProgress } from '@/plugins/player'

// const FONT_SIZE = 13

const PlayTimeCurrent = ({ timeStr }: { timeStr: string }) => {
  const theme = useTheme()
  // console.log(timeStr)
  const activeColor = theme.isDark ? theme['c-font'] : theme['c-primary']
  return <Text color={activeColor}>{timeStr}</Text>
}

const PlayTimeMax = memo(({ timeStr }: { timeStr: string }) => {
  const theme = useTheme()
  const activeColor = theme.isDark ? theme['c-font'] : theme['c-primary']
  return <Text color={activeColor}>{timeStr}</Text>
})

export default () => {
  // 【第 177 轮】被评论 / 设置等页盖住时不再跟 4Hz 进度事件：详情页仍挂着，
  // 每拍 setState + 进度条 Animated.timing 在完全不可见时纯属耗电。
  // 转场窗口内照常更新（push 进来时账本还没翻，pop 时账本要等 screenPopped），
  // 重新可见时 useProgress 重订阅会先同步一次最新值，不会停在旧进度。
  const visible = usePlayDetailOnTop() || useNavTransitioning()
  const { maxPlayTimeStr, nowPlayTimeStr, progress, maxPlayTime } = useProgress(visible)
  const buffered = useBufferProgress()

  // console.log('render playInfo')

  return (
    <>
      <View style={styles.progress}>
        <Progress progress={progress} duration={maxPlayTime} buffered={buffered} />
      </View>
      <View style={styles.info}>
        <PlayTimeCurrent timeStr={nowPlayTimeStr} />
        <View style={styles.status}>
          <Status />
        </View>
        <PlayTimeMax timeStr={maxPlayTimeStr} />
      </View>
    </>
  )
}

const styles = createStyle({
  progress: {
    flexGrow: 1,
    flexShrink: 0,
    flexDirection: 'column',
    justifyContent: 'center',
  },
  info: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    // alignItems: 'center',
    // backgroundColor: '#ccc',
  },
  status: {
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: 10,
    paddingRight: 10,
  },
})
