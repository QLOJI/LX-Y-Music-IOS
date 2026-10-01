import { memo } from 'react'

import { StyleSheet, View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import Text from '@/components/common/Text'
import ButtonPrimary from '@/components/common/ButtonPrimary'
import { useI18n } from '@/lang'

export interface ParseNameProps {
  fileName: string
  onNameChanged: (text: string) => void
  onSingerChanged: (text: string) => void
}

const parsePath = (fileName: string) => {
  return fileName
    .substring(0, fileName.lastIndexOf('.'))
    .split('-')
    .map((name) => name.trim())
}

export default memo(({ fileName, onNameChanged, onSingerChanged }: ParseNameProps) => {
  const theme = useTheme()
  // 按钮底面随「按钮透明度」设置淡出；只改颜色 alpha，不用容器 style.opacity，否则按钮文字会一起变淡
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const t = useI18n()
  const handleParseNameSinger = () => {
    const [name, singer] = parsePath(fileName)
    onNameChanged(name)
    if (singer) onSingerChanged(singer)
  }
  const handleParseSingerName = () => {
    const [singer, name] = parsePath(fileName)
    onSingerChanged(singer)
    if (name) onNameChanged(name)
  }
  return (
    <View style={styles.container}>
      <Text style={styles.label} size={14}>
        {t('metadata_edit_modal_form_parse_name')}
      </Text>
      <View style={styles.btns}>
        <ButtonPrimary
          // 按钮底色随「按钮透明度」设置淡出；只改颜色 alpha，文字色不动
          style={{ backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity) }}
          onPress={handleParseNameSinger}
        >
          <Text color={theme['c-button-font']} size={13}>
            {t('metadata_edit_modal_form_parse_name_singer')}
          </Text>
        </ButtonPrimary>
        <ButtonPrimary
          // 按钮底色随「按钮透明度」设置淡出；只改颜色 alpha，文字色不动
          style={{ backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity) }}
          onPress={handleParseSingerName}
        >
          <Text color={theme['c-button-font']} size={13}>
            {t('metadata_edit_modal_form_parse_singer_name')}
          </Text>
        </ButtonPrimary>
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    // paddingLeft: 25,
    marginBottom: 15,
  },
  label: {
    marginBottom: 2,
  },
  btns: {
    marginTop: 5,
    flexDirection: 'row',
  },
})
