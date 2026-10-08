import { memo, useMemo } from 'react'

import { StyleSheet, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
// 【第二十轮·图八】列表与文案收敛到唯一真源 ../qualityOptions（播放/下载两页共用）：
// 此前 QUALITY_LABELS / ACTIVE_ALIAS / 列表过滤都写在本文件里，下载音质页各写一份导致
// 两页档位数与文案不一致（用户原话「下载设置中下载音质更新为播放设置中的内容，要统一」）。
// 原先此处的一段说明（为什么硬编码而不改 zh-cn.json：quality_* key 还被下载页与
// 下载完成 toast 复用）随实现搬到 qualityOptions.ts 的文件头注释。
import { QUALITY_ACTIVE_ALIAS, getQualityLabel, getVisibleQualityList } from '../qualityOptions'

const useActive = (id: LX.Quality) => {
  const q = useSettingValue('player.playQuality')
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
        updateSetting({ 'player.playQuality': id })
      }}
      need
    />
  )
}

export default memo(() => {
  const t = useI18n()
  // 【C-13-2】渲染 6 项：128K / 320K / Flac / 24bitFlac / Atmos / Master。
  // 隐藏两项、且都是「只从列表隐藏、不动存储与取流」：atmos_plus（取流层 normalizeQuality
  // 兜底）/ hires（与 24bitFlac 同路径，选中态由 QUALITY_ACTIVE_ALIAS 显示到 24bitFlac）。
  // 具体过滤规则见 ../qualityOptions。
  const playQualityList = useMemo(() => getVisibleQualityList(), [])

  return (
    <SubTitle title={t('setting_play_play_quality')}>
      <View style={styles.list}>
        {playQualityList.map((q) => (
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
