import { memo } from 'react'
import SubTitle from '../../components/SubTitle'
import CheckBoxGrid, { CheckBoxGridCell } from '../../components/CheckBoxGrid'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'

type MenuSettingKey =
  | 'menu.playLater'
  | 'menu.dislike'

const SettingItem = ({ settingKey, label }: { settingKey: MenuSettingKey, label: string }) => {
  const value = useSettingValue(settingKey)
  const handleChange = (newValue: boolean) => {
    updateSetting({ [settingKey]: newValue })
  }

  // 第 19 轮第 4 条：两项走两列网格（CheckBoxGrid）。此前是「flexWrap 行内独立卡片」，
  // 第二项「不喜欢」的勾选框落在行中间，与上方「添加到歌曲的位置」的勾选框列
  // 都不在一条线上 —— 用户原话「菜单设置的勾选框也要和上面的对齐」。
  return (
    <CheckBoxGridCell
      check={value}
      onChange={handleChange}
      label={label}
    />
  )
}

export default memo(() => {
  const t = useI18n()

  return (
    <SubTitle title="菜单设置">
      {/* 外框已去掉（用户第 11 轮第 11 条「设置里的勾选框要都在同一直线上」）：
          此前是一个「带边框 + padding:12」的盒子，里面再放卡片式的 CheckBox 行，等于
          卡中卡——内层卡片左缘 = 页面内容左缘 + 13（12 padding + 1 border），勾选框
          整列比设置页其它行右移 13pt，肉眼就是「没对齐」。
          盒子本身的样式（半透明主题色底 + 边框，并随「按钮透明度」淡出）与卡片行
          完全重复，行本身就是圆角卡片、上方又有 SubTitle 分组标题，这层盒子没有额外
          信息量；去掉后勾选框回到与其它设置行同一条左基准线（卡片左缘 = 页面内容左缘，
          图标左缘 = +12），「按钮透明度」的淡出效果由卡片行自身承担（见 CheckBox
          card 变体的 contentStyle），视觉效果不变。 */}
      <CheckBoxGrid style={styles.content}>
        <SettingItem settingKey="menu.playLater" label={t('play_later')} />
        <SettingItem settingKey="menu.dislike" label={t('dislike')} />
      </CheckBoxGrid>
    </SubTitle>
  )
})

const styles = createStyle({
  content: {
    marginTop: designSpacing.xs,
    // 两列网格（勾选框同列）；行距由卡片自身的 marginBottom(8) 提供
  },
})
