import { memo, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
// 【第二十轮·图八】与「播放设置 → 播放音质」共用同一份列表/文案/选中态归一：
// 用户原话「下载设置中下载音质更新为播放设置中的内容，要统一」。
// 此前本页是 `[...TRY_QUALITYS_LIST, '128k'].reverse()` 未过滤的 8 项 + i18n 文案
// （母带 / 杜比全景声 / Hi-Res …），播放音质页是过滤后的 6 项 + 固定串
// （Master / Atmos / 24bitFlac …），同一个概念两页对不上。现在两页都取
// ../qualityOptions 的 getVisibleQualityList() / getQualityLabel() /
// QUALITY_ACTIVE_ALIAS，改一处两页同时生效。
// 本页唯一与播放页不同的地方：写入的 key 是 'download.quality'（播放页是 'player.playQuality'）。
import { QUALITY_ACTIVE_ALIAS, getQualityLabel, getVisibleQualityList } from '../qualityOptions'

const useActive = (id: LX.Quality) => {
  const q = useSettingValue('download.quality')
  // 存量值 'hires' 显示为选中 24bitFlac（与播放音质页同一套归一；只做显示，不改存储值）
  const isActive = useMemo(() => (QUALITY_ACTIVE_ALIAS[q] ?? q) == id, [q, id])
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
        updateSetting({ 'download.quality': id })
      }}
      need
    />
  )
}

export default memo(() => {
  const t = useI18n()
  const qualityList = useMemo(() => getVisibleQualityList(), [])

  return (
    <SubTitle title={t('setting_download_quality')}>
      <View style={styles.list}>
        {qualityList.map((q) => (
          <Item name={getQualityLabel(q, t)} id={q} key={q} />
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
