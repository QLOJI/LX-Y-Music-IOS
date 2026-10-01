import { memo, useRef, useEffect } from 'react'
import { View, StyleSheet, Animated, TouchableOpacity } from 'react-native'
import { Icon } from '@/components/common/Icon'
import TimeoutExitEditModal, { type TimeoutExitEditModalType, useTimeInfo } from '@/components/TimeoutExitEditModal'
import { pop } from '@/navigation'
import { useTheme } from '@/store/theme/hook'
import { HEADER_HEIGHT as _HEADER_HEIGHT, NAV_SHEAR_NATIVE_IDS, COMPONENT_IDS } from '@/config/constant'
import commonState from '@/store/common/state'
import SettingPopup, { type SettingPopupType } from '../../components/SettingPopup'
import SoundEffectPopup, { type SoundEffectPopupType } from '../../components/SoundEffectPopup'
import { useSetting } from '@/store/setting/hook'
import { isSoundEffectActive } from '@/plugins/player/soundEffect/constants'
import { useStatusbarHeight } from '@/store/common/hook'
import StatusBar from '@/components/common/StatusBar'
import { scaleSizeH, scaleSizeW } from '@/utils/pixelRatio'
import { useWindowSize } from '@/utils/hooks'
import { useButtonRadius } from '@/utils/buttonRadius'

const HEADER_HEIGHT = scaleSizeH(_HEADER_HEIGHT)
const ICON_SIZE = 22
// 返回按钮触控区：宽度固定 44pt（iOS HIG 建议的最小可点尺寸），图标在区域内居中，
// 相比原实现图标向右让出约 10pt、远离屏幕左边缘，触摸面积也从「字形大小」扩大到整块区域。
const BACK_BTN_WIDTH = scaleSizeW(44)
// 再叠加一层 hitSlop 容错，进一步降低贴边点击的失败率。
const BACK_BTN_HIT_SLOP = {
  top: scaleSizeH(10),
  bottom: scaleSizeH(10),
  left: scaleSizeW(10),
  right: scaleSizeW(10),
}
// 右侧三枚按钮（计时/音效/设置）等分右区宽度、彼此相邻，故只做垂直方向的 hitSlop 扩展：
// 若同时水平扩展，相邻按钮的触控区会互相重叠，反而误触到相邻按钮。
const RIGHT_BTN_HIT_SLOP = {
  top: scaleSizeH(8),
  bottom: scaleSizeH(8),
}
const DOT_ACTIVE_WIDTH = scaleSizeW(18)
const DOT_INACTIVE_WIDTH = scaleSizeW(8)
const DOT_HEIGHT = scaleSizeW(8)
const DOT_BORDER_RADIUS = DOT_HEIGHT / 2

const AnimatedIndicatorDot = ({ isActive }: { isActive: boolean }) => {
  const animatedWidth = useRef(new Animated.Value(isActive ? DOT_ACTIVE_WIDTH : DOT_INACTIVE_WIDTH)).current
  const animatedOpacity = useRef(new Animated.Value(isActive ? 1 : 0.7)).current

  useEffect(() => {
    Animated.parallel([
      // width 在 iOS 原生动画驱动下不被支持，必须用 JS 驱动（useNativeDriver: false）
      Animated.spring(animatedWidth, {
        toValue: isActive ? DOT_ACTIVE_WIDTH : DOT_INACTIVE_WIDTH,
        useNativeDriver: false,
        tension: 50,
        friction: 7,
      }),
      // 同视图内不能混用原生/JS 驱动：只要有一个值用原生驱动，整个 style
      // 都会按原生校验，width 仍会抛 "not supported by native animated module"。
      // 因此 opacity 也必须用 JS 驱动（useNativeDriver: false）。
      // 圆点动画仅切页瞬间触发、开销极小，全 JS 驱动无性能问题。
      Animated.spring(animatedOpacity, {
        toValue: isActive ? 1 : 0.7,
        useNativeDriver: false,
        tension: 50,
        friction: 7,
      }),
    ]).start()
  }, [isActive, animatedOpacity, animatedWidth])

  return (
    <Animated.View
      style={{
        width: animatedWidth,
        height: DOT_HEIGHT,
        borderRadius: DOT_BORDER_RADIUS,
        backgroundColor: '#000',
        opacity: animatedOpacity,
      }}
    />
  )
}

const HeaderNew = memo(({ pageIndex }: { pageIndex?: number }) => {
  const popupRef = useRef<SettingPopupType>(null)
  const soundEffectPopupRef = useRef<SoundEffectPopupType>(null)
  const timerModalRef = useRef<TimeoutExitEditModalType>(null)
  const statusBarHeight = useStatusbarHeight()
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  // 音效生效状态用于右上角音效按钮高亮，与参考工程一致订阅整个 setting
  const setting = useSetting()
  const timeInfo = useTimeInfo()
  const { width: winWidth } = useWindowSize()
  const back = () => {
    // 修复导航缺陷：原来 pop 的是账本数组栈顶，栈顶不是本屏时返回按钮点了没反应；
    // 本组件 props 链（VerticalNew → Header 包装）拿不到 componentId，改为按名字查本屏自己的 id
    const ownComponentId = commonState.componentIds.find(item => item.name === COMPONENT_IDS.playDetail)?.id
    if (ownComponentId) void pop(ownComponentId)
  }
  const showSetting = () => {
    popupRef.current?.show()
  }
  const showSoundEffect = () => {
    soundEffectPopupRef.current?.show()
  }
  const showTimer = () => {
    timerModalRef.current?.show()
  }
  const iconColor = theme.isDark ? theme['c-font'] : theme['c-primary']
  const activeIndex = pageIndex ?? 0

  const sideAreaWidth = winWidth * 0.2
  const dotGap = scaleSizeW(8)
  const containerPadding = scaleSizeW(10)

  return (
    <View
      style={{ height: HEADER_HEIGHT + statusBarHeight, paddingTop: statusBarHeight }}
      nativeID={NAV_SHEAR_NATIVE_IDS.playDetail_header}
    >
      <StatusBar />
      <View style={[styles.containerNew, { paddingHorizontal: containerPadding }]}>
        <View style={[styles.leftArea, { width: sideAreaWidth }]}>
          <TouchableOpacity style={[styles.backBtn, { borderRadius: buttonRadius(42) /* 「按钮圆角」：按钮自身高度 = HEADER_HEIGHT（设计 42pt）；42 = 设计原值，不要传 styles.backBtn.height（已被 createStyle 预缩放） */ }]} onPress={back} hitSlop={BACK_BTN_HIT_SLOP}>
            <Icon name="chevron-left" color={iconColor} size={24} />
          </TouchableOpacity>
        </View>
        <View style={styles.centerArea}>
          <View style={[styles.pageIndicator, { gap: dotGap }]}>
            <AnimatedIndicatorDot isActive={activeIndex === 0} />
            <AnimatedIndicatorDot isActive={activeIndex === 1} />
          </View>
        </View>
        <View style={[styles.rightArea, { width: sideAreaWidth }]}>
          <TouchableOpacity style={[styles.rightBtn, { borderRadius: buttonRadius(42) /* 「按钮圆角」：按钮自身高度 = HEADER_HEIGHT（设计 42pt）；42 = 设计原值，不要传 styles.rightBtn.height（已被 createStyle 预缩放） */ }]} onPress={showTimer} hitSlop={RIGHT_BTN_HIT_SLOP}>
            <Icon
              name="music_time"
              color={timeInfo.active ? theme['c-primary-font-active'] : iconColor}
              size={ICON_SIZE}
            />
          </TouchableOpacity>
          {/* 音效按钮：沿用原 slider 图标与位置，onPress 改为直接打开音效弹层，生效中时高亮 */}
          <TouchableOpacity style={[styles.rightBtn, { borderRadius: buttonRadius(42) /* 「按钮圆角」：按钮自身高度 = HEADER_HEIGHT（设计 42pt）；42 = 设计原值，不要传 styles.rightBtn.height（已被 createStyle 预缩放） */ }]} onPress={showSoundEffect} hitSlop={RIGHT_BTN_HIT_SLOP}>
            <Icon
              name="slider"
              color={isSoundEffectActive(setting) ? theme['c-primary-font-active'] : iconColor}
              size={ICON_SIZE}
            />
          </TouchableOpacity>
          {/* 设置按钮：音效入口独立出去后，设置弹层入口仍需保留，图标名取自本工程 IcoMoon 字体 */}
          <TouchableOpacity style={[styles.rightBtn, { borderRadius: buttonRadius(42) /* 「按钮圆角」：按钮自身高度 = HEADER_HEIGHT（设计 42pt）；42 = 设计原值，不要传 styles.rightBtn.height（已被 createStyle 预缩放） */ }]} onPress={showSetting} hitSlop={RIGHT_BTN_HIT_SLOP}>
            <Icon name="setting" color={iconColor} size={ICON_SIZE} />
          </TouchableOpacity>
        </View>
      </View>
      {/* 独立音效弹层：打开方式与设置弹层内的 SettingSoundEffect 保持一致（stacked） */}
      <SoundEffectPopup ref={soundEffectPopupRef} layoutMode="stacked" />
      <SettingPopup ref={popupRef} direction="vertical" />
      <TimeoutExitEditModal ref={timerModalRef} timeInfo={timeInfo} />
    </View>
  )
})

export default HeaderNew

const styles = StyleSheet.create({
  containerNew: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '100%',
  },
  leftArea: {
    alignItems: 'flex-start',
  },
  backBtn: {
    width: BACK_BTN_WIDTH,
    height: HEADER_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rightArea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  rightBtn: {
    // 三枚等分右区宽度：在不下压中间指示点区域的前提下，把每枚图标的触控块撑到最大
    flex: 1,
    height: HEADER_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
  },
})
