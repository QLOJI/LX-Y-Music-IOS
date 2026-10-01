import { memo, useRef } from 'react'
import { View, Platform } from 'react-native'
import { createStyle, toast } from '@/utils/tools'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { updateSetting } from '@/core/common'
import FileSelect, { type FileSelectType } from '@/components/common/FileSelect'

import { getWebDAVPrivateDirectory, selectFolder } from '@/utils/fs'

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  // 「按钮圆角」：两个路径按钮的行内覆盖（静态 borderRadius 原样保留作兜底）
  const buttonRadius = useButtonRadius()
  const webdavPath = useSettingValue('webdav.downloadPath')
  const fileSelectRef = useRef<FileSelectType>(null)

  const defaultPath = getWebDAVPrivateDirectory()

  const handleSelectPath = () => {
    // iOS：使用系统原生文件夹选择器（UIDocumentPicker 目录模式）
    if (Platform.OS === 'ios') {
      void selectFolder()
        .then((res) => {
          const path = res?.path
          if (!path) return
          updateSetting({ 'webdav.downloadPath': path })
          toast(t('webdav_download_path_set_success'))
        })
        .catch((err: any) => {
          if (err?.code === 'picker_cancelled') return
          if (err?.message) toast(err.message, 'long')
        })
      return
    }
    fileSelectRef.current?.show(
      {
        title: t('webdav_download_path_select'),
        dirOnly: true,
      },
      (path) => {
        if (!path) return
        updateSetting({ 'webdav.downloadPath': path })
        toast(t('webdav_download_path_set_success'))
      },
    )
  }

  const handleResetPath = () => {
    updateSetting({ 'webdav.downloadPath': '' })
    toast(t('webdav_download_path_reset_success'))
  }

  return (
    <View style={{ ...styles.panel, borderColor: theme['c-border-background'] }}>
      <Text style={styles.label}>{t('webdav_download_path')}</Text>
      <Text color={theme['c-font-label']} style={styles.meta}>
        {t('webdav_download_path_label', { path: webdavPath || defaultPath })}
      </Text>
      <View style={styles.buttonRow}>
        <Button
          // 按钮底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
          style={[
            { ...styles.button, backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity) },
            // 按钮无固定高度：可见高度 ≈ 29 = 单行文字行高 17（默认 15×1.15）+ 上下 padding 6×2，行内覆盖「按钮圆角」
            { borderRadius: buttonRadius(29) },
          ]}
          onPress={handleSelectPath}
        >
          <Text color={theme['c-button-font']}>{t('webdav_download_path_select')}</Text>
        </Button>
        <Button
          style={[
            { ...styles.button, backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity) },
            // 按钮无固定高度：可见高度 ≈ 29 = 单行文字行高 17（默认 15×1.15）+ 上下 padding 6×2，行内覆盖「按钮圆角」
            { borderRadius: buttonRadius(29) },
          ]}
          onPress={handleResetPath}
        >
          <Text color={theme['c-button-font']}>{t('webdav_download_path_default')}</Text>
        </Button>
      </View>
      <FileSelect ref={fileSelectRef} />
    </View>
  )
})

const styles = createStyle({
  panel: {
    borderWidth: 1,
    borderRadius: 4,
    padding: 10,
    marginBottom: 10,
  },
  label: {
    marginBottom: 6,
  },
  meta: {
    marginTop: 5,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
  },
  button: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    marginRight: 10,
    marginBottom: 8,
  },
})
