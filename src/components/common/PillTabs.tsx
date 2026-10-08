import { memo } from 'react'
import { TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { createStyle } from '@/utils/tools'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'

export interface PillTabsItem {
  key: string
  label: string
}

interface PillTabsProps {
  tabs: PillTabsItem[]
  activeKey: string
  onChange: (key: string) => void
}

/**
 * 「页面标题下面那行胶囊按钮」的唯一实现（第 21 轮·图三 / 图四 / 图七 / 图八）。
 *
 * 几何来源 = WebDAV 页「列表 / 文件列表 / 配置」那一行（用户点名「都参考 WebDAV 布局：
 * 标题在上面、按钮在标题栏下面、按钮下面显示列表」）：
 *   行高 44（rows 里胶囊垂直居中）、左右内边距 designSpacing.md、胶囊间距 designSpacing.xs、
 *   胶囊高 32 / 水平内边距 designSpacing.sm / 圆角 pill / 字号 caption 600。
 * 之前酷狗歌单、QQ 歌单各自把 tab 塞在标题行里（equalColumns 三等分），tab 文字为了给
 * 下划线留位（paddingBottom + 边框）整体比标题字形中心高 ~2.5pt —— 用户看到的「标题右边的
 * 按钮文字不和标题文字在同一直线上」。结构上把按钮移出标题行后，这类配平问题不复存在，
 * 且四个页面（WebDAV / 酷狗歌单 / QQ歌单 / 本地与下载）共用同一份几何，间距不会再漂。
 *
 * 选中态：主色 20% 淡染底 + 主题主色文字（与设置里「LX-Y Music 字体大小预览」同色）；
 * 底色 / 边框 alpha 随「按钮透明度」设置淡出；圆角随「按钮圆角」设置行内覆盖（胶囊自身
 * 高度 32 折算半高）。key 全部由调用点的 tabs 数组给出，onChange 只是把 key 原样回传。
 */
const PillTabs = memo(({ tabs, activeKey, onChange }: PillTabsProps) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  return (
    <View style={styles.tabs}>
      {tabs.map(({ key, label }) => (
        <TouchableOpacity
          key={key}
          style={{
            ...styles.tab,
            backgroundColor: applyOpacity(activeKey === key ? theme['c-primary-alpha-800'] : theme['c-primary-light-900-alpha-300'], buttonOpacity),
            borderColor: applyOpacity(activeKey === key ? theme['c-primary'] : theme['c-border-background'], buttonOpacity),
            borderRadius: buttonRadius(32),
          }}
          onPress={() => { onChange(key) }}
        >
          <Text
            style={{
              ...styles.tabText,
              color: activeKey === key ? theme['c-primary'] : theme['c-font-label'],
            }}
            numberOfLines={1}
          >
            {label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  )
})

PillTabs.displayName = 'CommonPillTabs'
export default PillTabs

const styles = createStyle({
  tabs: {
    flexDirection: 'row',
    height: 44,
    paddingHorizontal: designSpacing.md,
    alignItems: 'center',
    gap: designSpacing.xs,
  },
  tab: {
    height: 32,
    paddingHorizontal: designSpacing.sm,
    borderWidth: 1,
    borderRadius: designRadius.pill,
    justifyContent: 'center',
  },
  tabText: {
    fontSize: designTypography.caption,
    fontWeight: '600',
  },
})
