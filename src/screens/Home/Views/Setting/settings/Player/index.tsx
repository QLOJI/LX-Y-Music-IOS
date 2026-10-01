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

export default memo(() => {
  return (
    <Section sectionId="setting_player">
      <IsSavePlayTime />
      <IsAutoPlayOnReturn />
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
