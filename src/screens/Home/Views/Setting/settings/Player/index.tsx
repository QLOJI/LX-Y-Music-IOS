import { memo } from 'react'

import Section from '../../components/Section'
import IsSavePlayTime from './IsSavePlayTime'
import PlayHighQuality from './PlayHighQuality'
import IsHandleAudioFocus from './IsHandleAudioFocus'
import IsEnableAudioOffload from './IsEnableAudioOffload'
import IsEnableAudioPreload from './IsEnableAudioPreload'
import IsAutoCleanPlayedList from './IsAutoCleanPlayedList'
import IsAutoSkipOnError from './IsAutoSkipOnError'
import IsShowLyricTranslation from './IsShowLyricTranslation'
import IsShowLyricRoma from './IsShowLyricRoma'
import IsShowBluetoothLyric from './IsShowBluetoothLyric'
import IsS2T from './IsS2T'
import ClearCache from './ClearCache'
import IsAutoPlayOnReturn from './IsAutoPlayOnReturn'
import IsStartupPushPlayDetailScreen from './IsStartupPushPlayDetailScreen'

export default memo(() => {
  return (
    <Section sectionId="setting_player">
      <IsSavePlayTime />
      <IsAutoPlayOnReturn />
      {/* 用户第 33 轮第 7 条：紧跟在「返回软件时自动播放」下面（顺序即需求原话里的位置） */}
      <IsStartupPushPlayDetailScreen />
      <IsAutoCleanPlayedList />
      <IsAutoSkipOnError />
      <IsHandleAudioFocus />
      <IsEnableAudioOffload />
      <IsEnableAudioPreload />
      {/* 原生 FLAC 解码开关已移除：无损档固定走原生链路（见 plugins/player/nativeFlac.ts），避免留下无效空开关 */}
      <IsShowLyricTranslation />
      <IsShowLyricRoma />
      <IsShowBluetoothLyric />
      <IsS2T />
      <ClearCache />
      <PlayHighQuality />
    </Section>
  )
})
