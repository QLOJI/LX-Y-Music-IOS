import { memo, useEffect, useMemo, useState, type ComponentType } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'

import PageContent from '@/components/PageContent'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import LandscapeCentered from '@/components/LandscapeCentered'
import { pop } from '@/navigation'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { useSafeAreaBottom, useNavTransitioning, useStatusbarHeight } from '@/store/common/hook'
import { designSpacing } from '@/theme/DesignTokens'
import { useButtonRadius } from '@/utils/buttonRadius'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { type SettingScreenIds } from '@/screens/Home/Views/Setting/Main'
import { subscribeScrollLock } from '@/utils/scrollLock'
import WebLoginManager from '@/components/WebLoginManager'
import QQWebLoginManager from '@/components/QQWebLoginManager'
import KgWebLoginManager from '@/components/KgWebLoginManager'
import Basic from '@/screens/Home/Views/Setting/settings/Basic'
import Player from '@/screens/Home/Views/Setting/settings/Player'
import Search from '@/screens/Home/Views/Setting/settings/Search'
import List from '@/screens/Home/Views/Setting/settings/List'
import Sync from '@/screens/Home/Views/Setting/settings/Sync'
import Download from '@/screens/Home/Views/Setting/settings/Download'
import Backup from '@/screens/Home/Views/Setting/settings/Backup'
import Other from '@/screens/Home/Views/Setting/settings/Other'
import About from '@/screens/Home/Views/Setting/settings/About'
import ThemeScreen from '@/screens/Home/Views/Setting/settings/ThemeScreen'
import PlatformScreen from '@/screens/Home/Views/Setting/settings/PlatformScreen'

const SETTING_COMPONENTS: Record<SettingScreenIds, ComponentType> = {
  theme: ThemeScreen,
  platform: PlatformScreen,
  player: Player,
  search: Search,
  list: List,
  download: Download,
  sync: Sync,
  backup: Backup,
  other: Other,
  about: About,
  basic: Basic,
}

export default memo(({ settingId, componentId }: {
  settingId: SettingScreenIds
  componentId: string
}) => {
  const theme = useTheme()
  const t = useI18n()
  // 「按钮圆角」需订阅后行内覆盖（createStyle 的样式模块加载时已固化）。
  // 传参口径见下方 styles.backButton 的注释：本返回钮声明了 44 的固定热区，故用 44 当分母。
  const buttonRadius = useButtonRadius()
  const safeAreaBottom = useSafeAreaBottom()
  const statusBarHeight = useStatusbarHeight()
  // 全局页面转场标志（navigation 在发起 push 时置位、系统默认转场时长后自动复位），
  // 返回按钮据此门控，替代原来的「mount 起算 400ms」墙钟。
  const navTransitioning = useNavTransitioning()
  // 深层列表项（如自定义源拖拽排序）在拖拽期间通过 scrollLock 请求锁定祖先滚动容器，
  // 避免iOS 原生 UIScrollView 抢手势导致整页随拖动滚动（与 Setting/Horizontal 的处理一致）。
  const [scrollLocked, setScrollLocked] = useState(false)
  useEffect(() => subscribeScrollLock(setScrollLocked), [])

  useEffect(() => {
    setComponentId(COMPONENT_IDS.SETTING_DETAIL, componentId)
  }, [componentId])

  // push 转场进行中忽略返回，避免 pop 打断 push；返回走无自定义动画的 pop，
  // 与 push 侧（系统默认转场）配套，彻底规避 RNN iOS 自定义转场取消不回调导致的整栈卡死。
  // 门控改为复用全局转场标志：转场中吞掉、转场一结束立即放行。原实现按「mount 起算 400ms」
  // 墙钟判断，页面挂载偏晚时返回按钮会被额外锁死一段时间（用户反馈首次进入点返回没反应）。
  const handleBack = () => {
    if (navTransitioning) return
    void pop(componentId)
  }

  const ActiveScreen = useMemo(() => (
    SETTING_COMPONENTS[settingId] ?? Basic
  ), [settingId])

  const contentStyle = useMemo(() => ({
    // 设置详情内容离屏幕边缘过近，水平内边距从 lg(24) 提到 xl(32)
    paddingHorizontal: designSpacing.xl,
    paddingTop: designSpacing.sm,
    paddingBottom: designSpacing.xl + safeAreaBottom,
  }), [safeAreaBottom])

  return (
    <PageContent>
      <LandscapeCentered>
        <View style={{ ...styles.header, paddingTop: statusBarHeight + designSpacing.sm }}>
          <TouchableOpacity
            style={[
              styles.backButton,
              // 返回钮 styles.backButton 写死 44×44 热区，按 radiusFor 口径传该控件自己的设计高度 44：
              // 100% 时 RN 把 9999 夹到 min(44,44)/2=22，侧面闭合成整圆；中间档以真实半高为分母。
              // 不照抄 Comment/Header 与 DownloadManager/Header 返回钮的 18 —— 那两处 button 样式没有固定
              // height（只有 width + 居中，靠 18 号图标撑高），只能拿图标高当可见高度；本控件显式声明了
              // 44×44 热区，分母就该用它自己的 44，故两处不同值是有依据的（样式结构不同），不是疏漏。
              { borderRadius: buttonRadius(44) },
            ]}
            onPress={handleBack}
          >
            <Icon name="chevron-left" size={20} color={theme['c-font']} />
          </TouchableOpacity>
          <Text size={18} style={styles.title} color={theme['c-font']} numberOfLines={1}>
            {t(`setting_${settingId}`)}
          </Text>
          <View style={styles.headerSpace} />
        </View>
        <ScrollView
          style={styles.content}
          contentContainerStyle={contentStyle}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
          scrollEnabled={!scrollLocked}
          // iOS 键盘避让（默认 false，必须显式开启）：
          // 开启后由原生 RCTScrollView._keyboardWillChangeFrame 处理——键盘出现/尺寸变化时
          // ① 把 contentInset.bottom 设为被遮挡高度（max(遮挡高度, contentInset.bottom)）；
          // ② 沿响应链找到当前第一响应者（即聚焦的输入框），若其底边低于键盘顶边，
          //    则以键盘动画同款时长把它的底边滚到键盘上方（RCTScrollView.m:300-371）。
          // 此前该 ScrollView 完全没有键盘避让，而它就是「设置」各详情页唯一的滚动容器，
          // 因此「数据同步」（WebDAV 的服务器地址/用户名/密码/同步路径、同步服务地址等）
          // 这类靠近底部的输入框一旦聚焦，就会被键盘整块盖住、看不到正在输入的内容。
          // 属性仅 iOS 有效，Android 会忽略（本项目仅 iOS）。
          automaticallyAdjustKeyboardInsets
        >
          <ActiveScreen />
        </ScrollView>
      </LandscapeCentered>
      {/* 登录弹窗必须挂在本页面视图树内：RN Modal 仅在宿主视图挂在窗口上时呈现，
          挂在被 Home 托管的树里会因 Home 被 push 页面覆盖（self.window == nil）而不显示 */}
      <WebLoginManager />
      <QQWebLoginManager />
      <KgWebLoginManager />
    </PageContent>
  )
})

const styles = createStyle({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: designSpacing.sm,
    paddingHorizontal: designSpacing.sm,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '600',
  },
  headerSpace: {
    width: 44,
  },
  content: {
    flex: 1,
  },
})
