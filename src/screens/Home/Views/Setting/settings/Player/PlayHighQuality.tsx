import { memo, useMemo } from 'react'

import { StyleSheet, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { TRY_QUALITYS_LIST } from '@/core/music/utils'

// 【C-13-1】需求指定的 7 档展示文案（一字不改：128K / 320K / Flac / 24bitFlac / Hires / Atmos / Master）。
// 在组件内硬编码而不改 src/lang/zh-cn.json：那些 quality_* key 还被下载音质页
// （DownloadQuality.tsx:43）与下载完成 toast（core/download.ts:533）复用，改全局 i18n 会连带改到下载页；
// 且需求给的是固定串，本页文案也就不再随语言切换（手法同 REF PlayHighQuality.tsx:12-19）。
// 注意：'flac24bit' 的展示串是 '24bitFlac'（REF 是 'Flac24bit'，需求串不同，勿抄错）。
const QUALITY_LABELS: Record<string, string> = {
  '128k': '128K',
  '320k': '320K',
  flac: 'Flac',
  flac24bit: '24bitFlac',
  hires: 'Hires',
  atmos: 'Atmos',
  master: 'Master',
}

const useActive = (id: LX.Quality) => {
  const q = useSettingValue('player.playQuality')
  const isActive = useMemo(() => q == id, [q, id])
  return isActive
}

const Item = ({ id, name }: { id: LX.Quality, name: string }) => {
  const isActive = useActive(id)
  return (
    <CheckBox
      marginRight={8}
      block
      check={isActive}
      label={name}
      onChange={() => {
        updateSetting({ 'player.playQuality': id })
      }}
      need
    />
  )
}

export default memo(() => {
  const t = useI18n()
  const playQualityList = useMemo(() => {
    // 【C-13-2】渲染 7 项，与需求清单一致；atmos_plus 从列表隐藏。
    // 枚举值不迁移、不清除：老用户设置里存量的 'atmos_plus' 仍要能正常降级播放，
    // 由取流层的 normalizeQuality 映射到从其下档 atmos 起降级（C-11-1）兜住。
    return ([...TRY_QUALITYS_LIST, '128k'] as LX.Quality[])
      .filter(q => q !== 'atmos_plus')
      .reverse()
  }, [])

  return (
    <SubTitle title={t('setting_play_play_quality')}>
      <View style={styles.list}>
        {playQualityList.map((q) => (
          <Item name={QUALITY_LABELS[q] ?? t(q)} id={q} key={q} />
        ))}
      </View>
    </SubTitle>
  )
})

const styles = StyleSheet.create({
  list: {
    flexDirection: 'column',
    flexWrap: 'wrap',
  },
})
