import { memo, useMemo } from 'react'

import { StyleSheet, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBoxGrid, { CheckBoxGridCell } from '../../components/CheckBoxGrid'
import { useI18n } from '@/lang'
import { setFontSize } from '@/core/common'
import { useFontSize } from '@/store/common/hook'
import Text from '@/components/common/Text'
import { getTextSize } from '@/utils/pixelRatio'
import { useTheme } from '@/store/theme/hook'

const LIST = [
  {
    size: 0.8,
    name: 'setting_basic_font_size_80',
  },
  {
    size: 0.9,
    name: 'setting_basic_font_size_90',
  },
  {
    size: 1,
    name: 'setting_basic_font_size_100',
  },
  {
    size: 1.1,
    name: 'setting_basic_font_size_110',
  },
  {
    size: 1.2,
    name: 'setting_basic_font_size_120',
  },
  {
    size: 1.3,
    name: 'setting_basic_font_size_130',
  },
] as const

type SIZE_TYPE = (typeof LIST)[number]['size']

const useActive = (size: SIZE_TYPE) => {
  const _size = useFontSize()
  const isActive = useMemo(() => _size == size, [_size, size])
  return isActive
}

const SizeText = () => {
  const size = getTextSize(14) * useFontSize()
  const t = useI18n()
  const theme = useTheme()

  return (
    <Text style={{ fontSize: size }} color={theme['c-primary']}>
      {t('setting_basic_font_size_preview')}
    </Text>
  )
}

const Item = ({ size, label }: { size: SIZE_TYPE, label: string }) => {
  const isActive = useActive(size)
  // const [toggleCheckBox, setToggleCheckBox] = useState(false)
  // 第 19 轮第 4 条：6 个选项走两列网格（CheckBoxGrid），勾选框钉在两条固定列线上。
  // 此前是「flexWrap 行内独立卡片」：卡片宽度随标签字数（较小/小/标准/大/较大/非常大）
  // 变化，第二行起的勾选框 x 与第一行不等，肉眼就是「上下没对齐」。
  return (
    <CheckBoxGridCell
      check={isActive}
      label={label}
      onChange={() => {
        setFontSize(size)
      }}
      need
    />
  )
}

export default memo(() => {
  const t = useI18n()

  const list = useMemo(() => {
    return LIST.map((item) => ({ size: item.size, name: t(item.name) }))
  }, [t])

  return (
    <SubTitle title={t('setting_basic_font_size')}>
      <View style={styles.preview}>
        <SizeText />
      </View>
      <CheckBoxGrid>
        {list.map(({ size, name }) => (
          <Item key={size} size={size} label={name} />
        ))}
      </CheckBoxGrid>
    </SubTitle>
  )
})

const styles = StyleSheet.create({
  preview: {
    justifyContent: 'center',
    alignItems: 'center',
    // paddingTop: 3,
    paddingBottom: 10,
    minHeight: 45,
  },
})
