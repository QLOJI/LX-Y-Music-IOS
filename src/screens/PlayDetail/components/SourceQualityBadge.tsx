import { memo, useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { usePlayMusicInfo } from '@/store/player/hook'
import playerState from '@/store/player/state'
import { useI18n } from '@/lang'
import Badge from '@/components/common/Badge'
import { createStyle } from '@/utils/tools'
import { getQualityBadgeByTier } from '@/utils/musicQualityBadge'

// 【C-11-2 决策】徽标数据源改用 playerState.quality（实际达成档，src/plugins/player/utils.ts
// setResource 每次资源加载完成时写入），不再用 getPlayQuality 反推。
// 原因：徽标应该反映「现在真正在播的是什么」，而不是「偏好里写了什么」——getPlayQuality
// 改造后返回的是固定天梯首档（用户偏好档，忽略曲目标注），拿它当实际音质会误导用户。
// playerState.quality 没有专用变更事件，这里挂在几个与资源加载相邻的状态事件上重读：
// 切歌(playMusicInfoChanged)、元数据更新(playerMusicInfoChanged)、播放状态变化(playStateChanged)。
const usePlayerQuality = (): LX.Quality | null => {
  const [quality, setQuality] = useState<LX.Quality | null>(playerState.quality)
  useEffect(() => {
    const update = () => setQuality(playerState.quality)
    global.state_event.on('playMusicInfoChanged', update)
    global.state_event.on('playerMusicInfoChanged', update)
    global.state_event.on('playStateChanged', update)
    return () => {
      global.state_event.off('playMusicInfoChanged', update)
      global.state_event.off('playerMusicInfoChanged', update)
      global.state_event.off('playStateChanged', update)
    }
  }, [])
  return quality
}

// 平台英文缩写映射（用户指定：酷狗=KG，网易=WY，企鹅=QQ，酷我=KW，咪咕=MG）
const SOURCE_ABBR: Record<string, string> = {
  kg: 'KG',
  wy: 'WY',
  tx: 'QQ',
  kw: 'KW',
  mg: 'MG',
  qs: 'QS',
  local: '本地',
  xm: 'XM',
  bilibili: 'BILI',
  gitee: 'GITEE',
}

// 档位 → 小标的映射已抽到 utils/musicQualityBadge.ts（2026-10-02 统一：
// Master/Atmos/24bit/SQ/HQ/128K，未知档不再原样大写透出，统一落到 128K）。

export default memo(() => {
  const t = useI18n()
  const playMusicInfo = usePlayMusicInfo()
  const quality = usePlayerQuality()

  const musicInfo = playMusicInfo.musicInfo
    ? 'progress' in playMusicInfo.musicInfo
      ? playMusicInfo.musicInfo.metadata.musicInfo
      : playMusicInfo.musicInfo
    : null

  const abbr = musicInfo ? (SOURCE_ABBR[musicInfo.source] ?? musicInfo.source.toUpperCase()) : ''

  const qualityBadge = useMemo(() => {
    // 尚无实际达成档（本地文件、资源未加载完成）时隐藏徽标：没有「正在播的音质」就不显示
    if (!musicInfo || musicInfo.source === 'local' || !quality) return null
    return getQualityBadgeByTier(quality)
  }, [musicInfo, quality])

  if (!musicInfo) return null

  return (
    <View style={styles.row}>
      <Badge type="tertiary">{abbr}</Badge>
      {qualityBadge ? <Badge type={qualityBadge.type}>{t(qualityBadge.key)}</Badge> : null}
    </View>
  )
})

const styles = createStyle({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
})
