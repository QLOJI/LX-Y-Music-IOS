import { useContext, useEffect, useState } from 'react'
import { ThemeContext } from './state'
import settingState from '@/store/setting/state'

// export const useSetting = () => {
//   const [setting, updateSetting] = useState(state.setting)

//   }, [])

//   return setting
// }

// export const useSettingValue = <T extends keyof LX.AppSetting>(key: T): LX.AppSetting[T] => {
//   const [value, update] = useState(state.setting[key])

//   }, [key])

//   return value
// }

export const useTheme = () => useContext(ThemeContext)

export const useTextShadow = () => {
  const [value, update] = useState(settingState.setting['theme.fontShadow'])

  useEffect(() => {
    const handleUpdate = (keys: Array<keyof LX.AppSetting>, setting: Partial<LX.AppSetting>) => {
      if (!keys.includes('theme.fontShadow')) return
      requestAnimationFrame(() => {
        update(setting['theme.fontShadow'])
      })
    }
    global.state_event.on('configUpdated', handleUpdate)
    return () => {
      global.state_event.off('configUpdated', handleUpdate)
    }
  }, [])

  return value
}
