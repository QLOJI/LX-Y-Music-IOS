import { View } from 'react-native'
// import Button from '@/components/common/Button'
// import { navigations } from '@/navigation'
// import { BorderWidths } from '@/theme'
import { useNavActiveId, useStatusbarHeight } from '@/store/common/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import StatusBar from '@/components/common/StatusBar'
import { useSettingValue } from '@/store/setting/hook'
import { scaleSizeH } from '@/utils/pixelRatio'
import { HEADER_HEIGHT as _HEADER_HEIGHT } from '@/config/constant'
import SearchTypeSelector from '@/screens/Home/Views/Search/SearchTypeSelector'
import { isPageOwnedHeader } from '../pageOwnedHeaders'


const HEADER_HEIGHT = _HEADER_HEIGHT * 0.8

// const LeftTitle = () => {
//   const id = useNavActiveId()
//   const t = useI18n()

//   return <Text style={styles.leftTitle} size={18}>{t(id)}</Text>
// }
const LeftHeader = () => {
  const id = useNavActiveId()
  const t = useI18n()
  const statusBarHeight = useStatusbarHeight()
  const isSearchPage = id === 'nav_search'
  return (
    <View
      style={{
        ...styles.container,
        height: scaleSizeH(HEADER_HEIGHT) + statusBarHeight,
        paddingTop: statusBarHeight,
      }}
    >
      <View style={styles.left}>
        <Text style={styles.leftTitle} size={18}>
          {t(id)}
        </Text>
      </View>
      {isSearchPage ? <SearchTypeSelector /> : null}

      {/* <TouchableOpacity style={styles.btn} onPress={openSetting}>
        <Icon style={{ ...styles.btnText, color: theme['c-font'] }} name="setting" size={styles.btnText.fontSize} />
      </TouchableOpacity> */}
    </View>
  )
}

// const RightTitle = () => {
//   const id = useNavActiveId()
//   const t = useI18n()

//   return <Text style={styles.rightTitle} size={18}>{t(id)}</Text>
// }
const RightHeader = () => {
  const t = useI18n()
  const id = useNavActiveId()
  const statusBarHeight = useStatusbarHeight()
  const isSearchPage = id === 'nav_search'

  return (
    <View
      style={{
        ...styles.container,
        height: scaleSizeH(HEADER_HEIGHT) + statusBarHeight,
        paddingTop: statusBarHeight,
      }}
    >
      <View style={styles.left}>
        <Text style={styles.rightTitle} size={18}>
          {t(id)}
        </Text>
      </View>
      {isSearchPage ? <SearchTypeSelector /> : null}
      {/* <TouchableOpacity style={styles.btn} onPress={openSetting}>
        <Icon style={{ ...styles.btnText, color: theme['c-font'] }} name="setting" size={styles.btnText.fontSize} />
      </TouchableOpacity> */}
    </View>
  )
}

const Header = () => {
  const id = useNavActiveId()
  const drawerLayoutPosition = useSettingValue('common.drawerLayoutPosition')
  // 【第二十轮·图三】纵深防御：页面自管页头时共享页头整行（含这里的 StatusBar 副本）都不渲染。
  // 调用方 Horizontal/index 已经判过一次，这里让 Header 自己再认一次 —— 任何渲染路径都
  // 不可能再画出第二行标题。两个 hook 均在早返回之前无条件调用，不破坏 hook 顺序；
  // 顶层 Horizontal/index 另有自己的 <StatusBar />，状态栏不会因此消失。
  // 集合与判定见 ../pageOwnedHeaders。
  if (isPageOwnedHeader(id)) return null

  return (
    <>
      <StatusBar />
      {drawerLayoutPosition == 'left' ? <LeftHeader /> : <RightHeader />}
    </>
  )
}

const styles = createStyle({
  container: {
    // width: '100%',
    paddingRight: 5,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    // backgroundColor: 'rgba(0,0,0,0.1)',
    zIndex: 10,
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    paddingLeft: 5,
    alignItems: 'center',
    height: '100%',
    // backgroundColor: 'rgba(0,0,0,0.1)',
  },
  btn: {
    // flex: 1,
    width: HEADER_HEIGHT,
    // backgroundColor: 'rgba(0,0,0,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  titleBtn: {
    flex: 1,
    // backgroundColor: 'rgba(0,0,0,0.1)',
    height: '100%',
    justifyContent: 'center',
  },
  leftTitle: {
    paddingLeft: 10,
    paddingRight: 16,
  },
  rightTitle: {
    paddingLeft: 16,
    paddingRight: 16,
  },
})

export default Header
