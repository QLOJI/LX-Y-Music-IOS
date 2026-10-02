import { memo, useCallback, useMemo } from 'react'
import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBoxItem from '../../components/CheckBoxItem'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useMyList } from '@/store/list/hook'
import { LIST_IDS } from '@/config/constant'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'

const PLATFORM_ITEM_IDS = [
  'nav_my_playlist',
  'nav_kg_playlist',
  'nav_tx_playlist',
  'nav_followed_artists',
  'nav_subscribed_albums',
] as const

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const allList = useMyList()
  const visibility = useSettingValue('list.myListVisibility')

  const listItems = useMemo(() => {
    return allList.map((list) => ({
      id: list.id,
      name: list.id === LIST_IDS.DEFAULT
        ? t('list_name_default')
        : list.id === LIST_IDS.LOVE
          ? t('list_name_love')
          : list.name,
    }))
  }, [allList, t])

  const platformItems = useMemo(() => {
    return PLATFORM_ITEM_IDS.map(id => ({ id, name: t(id) }))
  }, [t])

  const handleChange = useCallback((listId: string, visible: boolean) => {
    updateSetting({
      'list.myListVisibility': {
        ...visibility,
        [listId]: visible,
      },
    })
  }, [visibility])

  return (
    <SubTitle title={t('setting_list_my_list_visibility')}>
      <Text style={styles.tip} size={12} color={theme['c-font-label']}>
        {t('setting_list_my_list_visibility_tip')}
      </Text>
      {/* 外框已去掉（用户第 11 轮第 11 条「设置里的勾选框要都在同一直线上」）：
          此前是「带边框 + padding:12」的盒子套卡片式 CheckBoxItem 行（卡中卡），内层行
          左缘 = 页面内容左缘 + 13（12 padding + 1 border），勾选框整列比设置页其它行
          右移 13pt。每行本身就是圆角卡片、上方又有分组标题与说明文字，这层盒子没有
          额外信息量；去掉后勾选框回到与其它设置行同一条左基准线。 */}
      <View>
        {listItems.map((item) => (
          <CheckBoxItem
            key={item.id}
            check={visibility[item.id] ?? true}
            label={item.name}
            onChange={(visible) => { handleChange(item.id, visible) }}
          />
        ))}
        {platformItems.map((item) => (
          <CheckBoxItem
            key={item.id}
            check={visibility[item.id] ?? true}
            label={item.name}
            onChange={(visible) => { handleChange(item.id, visible) }}
          />
        ))}
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  tip: {
    marginBottom: designSpacing.sm,
  },
})
