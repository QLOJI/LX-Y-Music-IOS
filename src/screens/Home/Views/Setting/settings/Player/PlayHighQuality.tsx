import { memo, useMemo } from 'react'

import { StyleSheet, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { TRY_QUALITYS_LIST } from '@/core/music/utils'

// 【C-13-1】展示文案（一字不改：128K / 320K / Flac / 24bitFlac / Atmos / Master）。
// 在组件内硬编码而不改 src/lang/zh-cn.json：那些 quality_* key 还被下载音质页
// （DownloadQuality.tsx:43）与下载完成 toast（core/download.ts:533）复用，改全局 i18n 会连带改到下载页；
// 且需求给的是固定串，本页文案也就不再随语言切换（手法同 REF PlayHighQuality.tsx:12-19）。
// 注意：'flac24bit' 的展示串是 '24bitFlac'（REF 是 'Flac24bit'，需求串不同，勿抄错）。
// 'hires' 不再有展示项（见下面 playQualityList 的过滤），故本表也不留它的文案。
const QUALITY_LABELS: Record<string, string> = {
  '128k': '128K',
  '320k': '320K',
  flac: 'Flac',
  flac24bit: '24bitFlac',
  atmos: 'Atmos',
  master: 'Master',
}

// 存量设置值的选中态归一：'hires' 与 'flac24bit' 在本应用是同一条取流路径
// （需求原话「24bitFlac 就是获取 hires」），Hires 档已从列表删除，存量选 'hires' 的
// 用户改由 24bitFlac 这一项显示为选中，避免出现「一个都没选中」的空档。
// 只做显示映射，不改写用户存储值——取流层天梯 PLAY_LADDER 里 'hires' 的位次不动，
// 存量值仍能正常取流（同 C-11-1 对 atmos_plus 的兜底思路）。
const ACTIVE_ALIAS: Record<string, LX.Quality> = { hires: 'flac24bit' }

const useActive = (id: LX.Quality) => {
  const q = useSettingValue('player.playQuality')
  const isActive = useMemo(() => (ACTIVE_ALIAS[q] ?? q) == id, [q, id])
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
    // 【C-13-2】渲染 6 项：128K / 320K / Flac / 24bitFlac / Atmos / Master。
    // 隐藏两项、且都是「只从列表隐藏、不动存储与取流」：
    //  - atmos_plus：需求里本就没有这一档，存量值由取流层 normalizeQuality 映射兜住（C-11-1）；
    //  - hires：需求要求删除（第 11 轮第 11 条），它与 24bitFlac 是同一条取流路径，
    //    存量值仍走 PLAY_LADDER 的 hires 位次正常取流，选中态在 ACTIVE_ALIAS 里显示到
    //    24bitFlac 那一项。枚举值一律不迁移、不清除，避免改写用户设置存储。
    return ([...TRY_QUALITYS_LIST, '128k'] as LX.Quality[])
      .filter(q => q !== 'atmos_plus' && q !== 'hires')
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
