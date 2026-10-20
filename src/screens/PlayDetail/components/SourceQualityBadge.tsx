import { memo, useMemo } from 'react'
import { View } from 'react-native'
import { usePlayMusicInfo } from '@/store/player/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import Badge from '@/components/common/Badge'
import { createStyle } from '@/utils/tools'
import { getQualityBadge } from '@/utils/musicQualityBadge'

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

export default memo(() => {
  const t = useI18n()
  const playMusicInfo = usePlayMusicInfo()
  const qualityShowHighest = useSettingValue('common.quality_show_highest')

  const musicInfo = playMusicInfo.musicInfo
    ? 'progress' in playMusicInfo.musicInfo
      ? playMusicInfo.musicInfo.metadata.musicInfo
      : playMusicInfo.musicInfo
    : null

  const abbr = musicInfo?.source ? (SOURCE_ABBR[musicInfo.source] ?? musicInfo.source.toUpperCase()) : ''

  // 【第 133 轮】与歌单 / 搜索列表同源：曲目标注的 _qualitys + 「音质显示最高支持」开关。
  // 本地文件没有在线档位，与「我的」列表一致，不显示音质小标。
  const qualityBadge = useMemo(() => {
    if (!musicInfo || musicInfo.source === 'local') return null
    return getQualityBadge((musicInfo.meta as LX.Music.MusicInfoMeta_online)?._qualitys, qualityShowHighest)
  }, [musicInfo, qualityShowHighest])

  if (!musicInfo) return null

  return (
    <View style={styles.row}>
      {abbr ? <Badge type="tertiary">{abbr}</Badge> : null}
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
