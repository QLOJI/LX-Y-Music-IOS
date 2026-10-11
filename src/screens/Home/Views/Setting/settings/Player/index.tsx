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
// 【第 63 轮第 2 条】渐入渐出：时长两个滑块 + 曲线开关，插在「将播放的中文歌词转换为繁体」
// 下面（需求原话点名的位置，顺序即需求文字顺序：先渐入、再渐出、最后曲线）
import FadeInDuration from './FadeInDuration'
import FadeOutDuration from './FadeOutDuration'
import IsLinearFadeCurve from './IsLinearFadeCurve'
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
      {/* 用户第 63 轮第 2 条：「位置在将播放的中文歌词转换为繁体选项下面」（顺序即原话顺序） */}
      <FadeInDuration />
      <FadeOutDuration />
      <IsLinearFadeCurve />
      <ClearCache />
      <PlayHighQuality />
    </Section>
  )
})
