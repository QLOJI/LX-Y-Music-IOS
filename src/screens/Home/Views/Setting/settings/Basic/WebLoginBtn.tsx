import { memo } from 'react'
import { View } from 'react-native'
import { createStyle } from '@/utils/tools'
import Button from '../../components/Button'
import { useI18n } from '@/lang'

export default memo(() => {
  const t = useI18n()
  const handleShowWyLoginModal = () => {
    global.app_event.showWebLogin()
  }

  const handleShowTxLoginModal = () => {
    global.app_event.showTxWebLogin()
  }

  const handleShowKgLoginModal = () => {
    global.app_event.showKgWebLogin()
  }

  return (
    <View style={styles.content}>
      <Button onPress={handleShowWyLoginModal}>{t('netease_login')}</Button>
      <Button onPress={handleShowTxLoginModal}>{t('qq_login')}</Button>
      <Button onPress={handleShowKgLoginModal}>{t('kugou_login')}</Button>
    </View>
  )
})

const styles = createStyle({
  content: {
    marginBottom: 5,
    paddingLeft: 20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
})
