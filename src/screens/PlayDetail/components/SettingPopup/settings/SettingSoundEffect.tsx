import { memo, useMemo, useRef } from 'react'
import { TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import SoundEffectPopup, { type SoundEffectPopupType } from '@/screens/PlayDetail/components/SoundEffectPopup'
import { applyOpacity } from '@/utils/colorOpacity'
import { createStyle } from '@/utils/tools'

// 播放详情设置 → 音效入口：打开自定义均衡器 + 环境混响弹层
// （2026-09-29 用户定案：旧播放器 More 按钮的音效弹窗移除，变调/环绕不再暴露，
// 仅保留均衡器与环境混响两项，入口收敛到播放详情设置）
export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const popupRef = useRef<SoundEffectPopupType>(null)

  // 「自定义」按钮底色随「按钮透明度」淡出：只改颜色 alpha，不用容器 opacity，否则文字会一起变淡
  const btnStyle = useMemo(() => ({
    backgroundColor: applyOpacity('rgba(128,128,128,0.16)', buttonOpacity),
  }), [buttonOpacity])

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.labelArea}>
          <Text style={styles.label}>{t('setting_play_sound_effect')}</Text>
          <Text size={12} color={theme['c-font-label']}>{t('setting_play_sound_effect_tip')}</Text>
        </View>
        <TouchableOpacity style={[styles.btn, btnStyle]} onPress={() => { popupRef.current?.show() }}>
          <Text size={13} color={theme['c-button-font']}>{t('setting_play_sound_effect_custom')}</Text>
        </TouchableOpacity>
      </View>
      <SoundEffectPopup ref={popupRef} layoutMode="stacked" />
    </View>
  )
})

const styles = createStyle({
  container: {
    paddingLeft: 20,
    paddingRight: 20,
    paddingTop: 14,
    paddingBottom: 14,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  labelArea: {
    flex: 1,
    paddingRight: 12,
    gap: 4,
  },
  label: {
    fontSize: 15,
  },
  btn: {
    minWidth: 72,
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
})
