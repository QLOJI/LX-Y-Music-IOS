import { memo, useMemo, useRef } from 'react'
import { TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import SoundEffectPopup, { type SoundEffectPopupType } from '@/screens/PlayDetail/components/SoundEffectPopup'
import { applyOpacity } from '@/utils/colorOpacity'
import { createStyle } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'

// 播放详情设置 → 音效入口：打开音效弹层（均衡器 / 环境混响 / 变调 / 3D 环绕四个区块全量暴露，
// 2026-10-01 已恢复变调与 3D 环绕，恢复出的区块是正式需求，勿当误改再删）
// （2026-09-29 定案：旧播放器 More 按钮的音效弹窗移除，入口收敛到播放详情设置）
export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
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
        <TouchableOpacity style={[styles.btn, btnStyle, { borderRadius: buttonRadius(34) /* 「按钮圆角」：紧凑按钮可见高度 ≈ 上下 padding 8×2 + 13pt 文本行盒 ≈ 34 */ }]} onPress={() => { popupRef.current?.show() }}>
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
