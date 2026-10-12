import { Navigation } from 'react-native-navigation'
import { getAppearance, getIsSupportedAutoTheme, onAppearanceChange } from '@/utils/tools'
import { setShouldUseDarkColors, applyTheme } from '@/core/theme'
import { getTheme } from '@/theme/themes/index'
import settingState from '@/store/setting/state'
import commonState from '@/store/common/state'
import StatusBar from '@/components/common/StatusBar'
import { getStatusBarStyle } from '@/navigation/utils'
// import { Dimensions, PixelRatio } from 'react-native'

const syncStatusBar = (theme: LX.ActiveTheme) => {
  StatusBar.setBarStyle(theme.isDark ? 'light-content' : 'dark-content')

  const activeComponentId = commonState.componentIds[commonState.componentIds.length - 1]?.id
  if (!activeComponentId) return

  Navigation.mergeOptions(activeComponentId, {
    statusBar: {
      drawBehind: true,
      visible: true,
      style: getStatusBarStyle(theme.isDark),
      backgroundColor: 'transparent',
    },
  })
}

export default async(_setting: LX.AppSetting) => {
  if (getIsSupportedAutoTheme()) {
    setShouldUseDarkColors(getAppearance() == 'dark')

    onAppearanceChange((color) => {
      setShouldUseDarkColors((color ?? 'light') == 'dark')
      if (settingState.setting['common.isAutoTheme']) void getTheme().then(applyTheme)
    })
  }

  global.state_event.on('themeUpdated', syncStatusBar)
  applyTheme(await getTheme())
}
