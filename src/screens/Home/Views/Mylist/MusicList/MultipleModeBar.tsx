import { useState, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react'
import { Animated, View, TouchableOpacity } from 'react-native'

import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { createStyle } from '@/utils/tools'
import { BorderWidths } from '@/theme'
import { designMotion } from '@/theme/DesignTokens'
import { useButtonRadius } from '@/utils/buttonRadius'

export type SelectMode = 'single' | 'range'

export interface MultipleModeBarProps {
  onSwitchMode: (mode: SelectMode) => void
  onSelectAll: (isAll: boolean) => void
  onExitSelectMode: () => void
}
export interface MultipleModeBarType {
  show: () => void
  setVisibleBar: (visible: boolean) => void
  setIsSelectAll: (isAll: boolean) => void
  setSwitchMode: (mode: SelectMode) => void
  exitSelectMode: () => void
}

export default forwardRef<MultipleModeBarType, MultipleModeBarProps>(
  ({ onSelectAll, onSwitchMode, onExitSelectMode }, ref) => {
    // const isGetDetailFailedRef = useRef(false)
    const [visible, setVisible] = useState(false)
    const [animatePlayed, setAnimatPlayed] = useState(true)
    const animFade = useRef(new Animated.Value(0)).current
    const [selectMode, setSelectMode] = useState<SelectMode>('single')
    const [isSelectAll, setIsSelectAll] = useState(false)
    const [visibleBar, setVisibleBar] = useState(true)
    const theme = useTheme()
    const buttonOpacity = useSettingValue('theme.buttonOpacity')
    // 条内按钮无自身高度，按槽位/返回栏行高 44 折算半高（与 ActiveList 行高 44 同源）
    const buttonRadius = useButtonRadius()

    useImperativeHandle(ref, () => ({
      show() {
        handleShow()
      },
      setVisibleBar(visible) {
        setVisibleBar(visible)
      },
      setIsSelectAll(isAll) {
        setIsSelectAll(isAll)
      },
      setSwitchMode(mode: SelectMode) {
        setSelectMode(mode)
      },
      exitSelectMode() {
        handleHide()
      },
    }))

    const handleShow = useCallback(() => {
      // console.log('show List')
      setVisible(true)
      setAnimatPlayed(false)
      requestAnimationFrame(() => {
        // 只做原地淡入，不再有 translateY(-20→0) 位移——与搜索栏同理：多选栏和返回栏/
        // 搜索栏同处一个固定槽位，首帧就必须落在槽位里。从上方 20pt 滑下来的入场，在用户
        // 眼里和「顶部栏又没对齐」长得一模一样（分辨不出是动效还是定位 bug）。
        Animated.timing(animFade, {
          toValue: 0.92,
          duration: designMotion.quick,
          useNativeDriver: true,
        }).start(() => {
          setAnimatPlayed(true)
        })
      })
    }, [animFade])

    const handleHide = useCallback(() => {
      setAnimatPlayed(false)
      Animated.timing(animFade, {
        toValue: 0,
        duration: designMotion.quick,
        useNativeDriver: true,
      }).start((finished) => {
        if (!finished) return
        setVisible(false)
        setAnimatPlayed(true)
      })
    }, [animFade])

    const animaStyle = useMemo(
      () => ({
        ...styles.container,
        // backgroundColor: theme['c-content-background'],
        // 【第 46 轮】底边框同样跟「主题设置 → 按钮透明度」走。这条栏与返回栏/搜索栏共用
        // 顶部同一个槽位、自己不带底色（底色那行本来就被注释掉，这里不动它），所以能受
        // 设置影响的就只有这条分隔线；不接的话整条栏对那个设置毫无反应。
        borderBottomColor: applyOpacity(theme['c-border-background'], buttonOpacity),
        opacity: visibleBar ? animFade : 0, // Bind opacity to animated value
      }),
      [animFade, theme, visibleBar, buttonOpacity],
    )

    const handleSelectAll = useCallback(() => {
      const selectAll = !isSelectAll
      setIsSelectAll(selectAll)
      onSelectAll(selectAll)
    }, [isSelectAll, onSelectAll])

    const component = useMemo(() => {
      return (
        <Animated.View style={animaStyle}>
          <View style={styles.switchBtn}>
            <Button
              onPress={() => {
                onSwitchMode('single')
              }}
              style={{
                ...styles.btn,
                // 条内按钮无自身高度，按槽位/返回栏行高 44 折算半高（与 ActiveList 行高 44 同源）
                borderRadius: buttonRadius(44),
                // 选中态底色随「按钮透明度」淡出；只改颜色 alpha，不用容器 style.opacity
                backgroundColor:
                  selectMode == 'single'
                    ? applyOpacity(theme['c-button-background'], buttonOpacity)
                    : 'rgba(0,0,0,0)',
              }}
            >
              <Text color={theme['c-button-font']}>{global.i18n.t('list_select_single')}</Text>
            </Button>
            <Button
              onPress={() => {
                onSwitchMode('range')
              }}
              style={{
                ...styles.btn,
                // 条内按钮无自身高度，按槽位/返回栏行高 44 折算半高（与 ActiveList 行高 44 同源）
                borderRadius: buttonRadius(44),
                // 同上：只改颜色 alpha，文字色不动
                backgroundColor:
                  selectMode == 'range'
                    ? applyOpacity(theme['c-button-background'], buttonOpacity)
                    : 'rgba(0,0,0,0)',
              }}
            >
              <Text color={theme['c-button-font']}>{global.i18n.t('list_select_range')}</Text>
            </Button>
          </View>
          {/* 条内按钮同上：无自身高度，按槽位/返回栏行高 44 折算半高 */}
          <TouchableOpacity onPress={handleSelectAll} style={[styles.btn, { borderRadius: buttonRadius(44) }]}>
            <Text color={theme['c-button-font']}>
              {global.i18n.t(isSelectAll ? 'list_select_unall' : 'list_select_all')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onExitSelectMode} style={[styles.btn, { borderRadius: buttonRadius(44) }]}>
            <Text color={theme['c-button-font']}>{global.i18n.t('list_select_cancel')}</Text>
          </TouchableOpacity>
        </Animated.View>
      )
    }, [
      animaStyle,
      selectMode,
      theme,
      buttonOpacity,
      buttonRadius,
      handleSelectAll,
      isSelectAll,
      onExitSelectMode,
      onSwitchMode,
    ])

    return !visible && animatePlayed ? null : component
  },
)

const styles = createStyle({
  // 绝对铺满父级「固定槽位」（index.tsx 的 barSlot，高度=返回栏 ActiveList 的 44）：
  // 多选栏与返回栏/搜索栏共用同一个槽位，进入多选时原地替换、不跳位。
  container: {
    flex: 1,
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    flexDirection: 'row',
    borderBottomWidth: BorderWidths.normal,
  },
  switchBtn: {
    flexDirection: 'row',
    flex: 1,
  },
  btn: {
    // flex: 1,
    paddingLeft: 18,
    paddingRight: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
