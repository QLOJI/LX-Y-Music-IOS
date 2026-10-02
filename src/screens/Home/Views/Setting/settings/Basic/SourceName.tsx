import { memo, useMemo } from 'react'

import SubTitle from '../../components/SubTitle'
import CheckBoxGrid, { CheckBoxGridCell } from '../../components/CheckBoxGrid'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'

type SourceNameType = LX.AppSetting['common.sourceNameType']

const setSourceNameType = (type: SourceNameType) => {
  updateSetting({ 'common.sourceNameType': type })
}

const useActive = (type: SourceNameType) => {
  const sourceNameType = useSettingValue('common.sourceNameType')
  const isActive = useMemo(() => sourceNameType == type, [sourceNameType, type])
  return isActive
}

const Item = ({ id, name }: { id: SourceNameType, name: string }) => {
  const isActive = useActive(id)
  // const [toggleCheckBox, setToggleCheckBox] = useState(false)
  // 第 19 轮第 4 条：两项走两列网格（CheckBoxGrid）。此前是「flexWrap 行内独立卡片」，
  // 勾选框 x = 前项宽度之和，「原名 / 别名」第二项落在行中间，和上方「数据源」等整行卡
  // 的勾选框列（左缘 + 13）不在同一条线上 —— 用户原话「歌曲来源名称的勾选框也要和上面的对齐」。
  return (
    <CheckBoxGridCell
      check={isActive}
      label={name}
      onChange={() => {
        setSourceNameType(id)
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
        id: 'real',
        name: t('setting_basic_sourcename_real'),
      },
      {
        id: 'alias',
        name: t('setting_basic_sourcename_alias'),
      },
    ] as const
  }, [t])

  return (
    <SubTitle title={t('setting_basic_sourcename')}>
      <CheckBoxGrid>
        {list.map(({ id, name }) => (
          <Item name={name} id={id} key={id} />
        ))}
      </CheckBoxGrid>
    </SubTitle>
  )
})
