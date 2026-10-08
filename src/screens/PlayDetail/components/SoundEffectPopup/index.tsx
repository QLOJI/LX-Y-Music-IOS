import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import Popup, { type PopupProps, type PopupType } from '@/components/common/Popup'
import { useI18n } from '@/lang'
import SoundEffectControl from '@/components/player/SoundEffectControl'

export interface SoundEffectPopupType {
  show: () => void
}

export default forwardRef<SoundEffectPopupType, Omit<PopupProps, 'children'> & {
  layoutMode?: 'split' | 'stacked'
}>(({ layoutMode = 'split', ...props }, ref) => {
  const [visible, setVisible] = useState(false)
  const popupRef = useRef<PopupType>(null)
  const t = useI18n()

  useImperativeHandle(ref, () => ({
    show() {
      if (visible) popupRef.current?.setVisible(true)
      else {
        setVisible(true)
        requestAnimationFrame(() => {
          popupRef.current?.setVisible(true)
        })
      }
    },
  }))

  return visible ? (
    <Popup ref={popupRef} title={t('setting_play_sound_effect')} {...props}>
      <ScrollView>
        <View onStartShouldSetResponder={() => true}>
          <SoundEffectControl showTip={false} layoutMode={layoutMode} />
        </View>
      </ScrollView>
    </Popup>
  ) : null
})
