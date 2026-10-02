import { memo, useMemo } from 'react'

import SubTitle from '../../components/SubTitle'
import CheckBoxGrid, { CheckBoxGridCell } from '../../components/CheckBoxGrid'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'

const setAddMusicLocationType = (type: LX.AddMusicLocationType) => {
  updateSetting({ 'list.addMusicLocationType': type })
}

const useActive = (id: LX.AddMusicLocationType) => {
  const addMusicLocationType = useSettingValue('list.addMusicLocationType')
  const isActive = useMemo(() => addMusicLocationType == id, [addMusicLocationType, id])
  return isActive
}

const Item = ({ id, name }: { id: LX.AddMusicLocationType, name: string }) => {
  const isActive = useActive(id)
  // const [toggleCheckBox, setToggleCheckBox] = useState(false)
  // 第 19 轮第 4 条：两项走两列网格（CheckBoxGrid）。此前是「flexWrap 行内独立卡片」，
  // 下方「菜单设置」的勾选框要「和上面的对齐」，靠的就是这一组也落在网格列线上。
  return (
    <CheckBoxGridCell
      check={isActive}
      label={name}
      onChange={() => {
        setAddMusicLocationType(id)
      }}
      need
    />
  )
}

export default memo(() => {
  const t = useI18n()

  return (
    <SubTitle title={t('setting_list_add_music_location_type')}>
      <CheckBoxGrid style={styles.list}>
        <Item id="top" name={t('setting_list_add_music_location_type_top')} />
        <Item id="bottom" name={t('setting_list_add_music_location_type_bottom')} />
      </CheckBoxGrid>
    </SubTitle>
  )
})

const styles = createStyle({
  list: {
    marginTop: designSpacing.xs,
    // 两列网格（勾选框同列）；行距由卡片自身的 marginBottom(8) 提供，
    // 此前这里的 gap/alignItems 是给「内容宽度卡片并排」用的，网格下不需要
  },
})
