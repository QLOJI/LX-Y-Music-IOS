import { memo } from 'react'

import { View } from 'react-native'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { designSpacing } from '@/theme/DesignTokens'

interface Props {
  title: string
  children: React.ReactNode | React.ReactNode[]
  collapsible?: boolean
  sectionId?: keyof LX.AppSetting['common.sectionExpandedStatus']
}

export default memo(({ title, children }: Props) => {
  const theme = useTheme()

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <Text style={{ ...styles.title, color: theme['c-font-label'] }} size={14}>
          {title}
        </Text>
      </View>
      {children}
    </View>
  )
})

const styles = createStyle({
  container: {
    marginTop: designSpacing.sm,
    // A-6（步骤5）：小节标题下方压缩 12→8，避免与卡片 8pt 再叠加出 20pt 级空隙
    marginBottom: designSpacing.xs,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    // A-6（步骤5）：标题到内容 12→8
    marginBottom: designSpacing.xs,
  },
  title: {
    fontWeight: '700',
    textTransform: 'uppercase',
    flex: 1,
  },
})
