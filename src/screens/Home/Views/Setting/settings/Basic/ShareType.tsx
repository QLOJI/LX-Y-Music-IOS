import { memo, useMemo } from 'react'

import SubTitle from '../../components/SubTitle'
import CheckBoxGrid, { CheckBoxGridCell } from '../../components/CheckBoxGrid'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'

type ShareType = LX.AppSetting['common.shareType']

const setShareType = (type: ShareType) => {
  updateSetting({ 'common.shareType': type })
}

const useActive = (type: ShareType) => {
  const shareType = useSettingValue('common.shareType')
  const isActive = useMemo(() => shareType == type, [shareType, type])
  return isActive
}

const Item = ({ id, name }: { id: ShareType, name: string }) => {
  const isActive = useActive(id)
  // const [toggleCheckBox, setToggleCheckBox] = useState(false)
  // 第 19 轮第 4 条：两项走两列网格（CheckBoxGrid）。此前是「flexWrap 行内独立卡片」，
  // 第二项「剪贴板」的勾选框落在行中间，与下方各组第一列的勾选框不在同一条线上。
  return (
    <CheckBoxGridCell
      check={isActive}
      label={name}
      onChange={() => {
        setShareType(id)
      }}
      need
    />
  )
}

export default memo(() => {
  const t = useI18n()
  const list = useMemo(() => {
    return [
      {
        id: 'system',
        name: t('setting_basic_share_type_system'),
      },
      {
        id: 'clipboard',
        name: t('setting_basic_share_type_clipboard'),
      },
    ] as const
  }, [t])

  return (
    <SubTitle title={t('setting_basic_share_type')}>
      <CheckBoxGrid>
        {list.map(({ id, name }) => (
          <Item name={name} id={id} key={id} />
        ))}
      </CheckBoxGrid>
    </SubTitle>
  )
})
