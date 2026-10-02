import { memo } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import CheckBox, { type CheckBoxProps } from '@/components/common/CheckBox'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'

/** 设置页「成组勾选项」的两列网格（第 19 轮第 4 条；用户："勾选框可以两列"）。
 *
 *  背景：设置页里成组的单选项（字体大小 / 歌曲来源名称 / 资源缓存上限 / 菜单设置 /
 *  分享方式 / 添加到歌曲的位置）此前是「flexWrap 行内独立卡片」——卡片宽度随标签字数
 *  （较小/小/标准/大/较大/非常大…）变化，勾选框的 x 也跟着变：同组第二行对不齐第一行，
 *  相邻小组之间也对不齐（用户原话「勾选框要上下对齐 / 也要和上面的对齐」）。
 *
 *  几何（单一真值，改这一处 = 改所有网格）：
 *   · cell：flexBasis 45% + flexGrow 1 ⇒ 每行恰好两项、各占 (行宽 − 8) / 2
 *     （0.45 × 2 + 8 < 100%，两项平分剩余 10%，第三项换行；行宽过窄时自动退化为单列）
 *   · cell 内是 CheckBox 的 block 形态 ⇒ 卡片撑满 cell、去掉并排预留的右外边距，
 *     勾选框左缘 = cell 左缘 + 1 边框 + 12 内边距
 *   · 第一列勾选框 x = 内容左缘 + 13 —— 与设置页所有整行卡（CheckBoxItem）同一条左基准线，
 *     即用户要的「和上面的对齐」；第二列 = 内容左缘 + 行宽/2 + 17（同一常数，跨区块一致）
 *   · 列间距 8；行间距**不在这里给** —— 卡片自带 marginBottom(8)，再叠 rowGap 会变 16
 *   · 右列卡片右缘正好落在内容右缘（与上方整行卡右缘对齐，不缩进）
 */
const CheckBoxGrid = memo(({
  children,
  style,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
}) => {
  return <View style={style ? [styles.grid, style] : styles.grid}>{children}</View>
})
CheckBoxGrid.displayName = 'SettingCheckBoxGrid'

/** 网格单元：一个选项 = 一整张卡片（block 形态）撑满所在 cell，勾选框落在列线上。 */
export const CheckBoxGridCell = memo((props: CheckBoxProps) => {
  return (
    <View style={styles.cell}>
      <CheckBox {...props} block />
    </View>
  )
})
CheckBoxGridCell.displayName = 'SettingCheckBoxGridCell'

export default CheckBoxGrid

const styles = createStyle({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // 只给列间距；行间距由卡片自身的 marginBottom(8) 提供（同 HotSearch 的 rowGap 处理）
    columnGap: designSpacing.xs,
  },
  cell: {
    flexGrow: 1,
    flexBasis: '45%',
  },
})
