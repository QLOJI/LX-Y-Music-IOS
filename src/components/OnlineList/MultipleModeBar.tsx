import { useState, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react'
import { Animated, View, TouchableOpacity, StyleSheet } from 'react-native'

import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useSafeAreaBottom } from '@/store/common/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { createStyle } from '@/utils/tools'
import { shadow } from '@/utils/shadow'
import { scaleSizeH } from '@/utils/pixelRatio'
import { designRadius, designSpacing } from '@/theme/DesignTokens'

export type SelectMode = 'single' | 'range'

export const MULTI_SELECT_BAR_HEIGHT = scaleSizeH(40)

export interface MultipleModeBarProps {
  onSwitchMode: (mode: SelectMode) => void
  onSelectAll: (isAll: boolean) => void
  onExitSelectMode: () => void
  onDownload: () => void
}
export interface MultipleModeBarType {
  show: () => void
  setIsSelectAll: (isAll: boolean) => void
  setSwitchMode: (mode: SelectMode) => void
  exitSelectMode: () => void
}

export default forwardRef<MultipleModeBarType, MultipleModeBarProps>(
  ({ onSelectAll, onSwitchMode, onExitSelectMode, onDownload }, ref) => {
    // const isGetDetailFailedRef = useRef(false)
    const [visible, setVisible] = useState(false)
    const [animatePlayed, setAnimatPlayed] = useState(true)
    const animFade = useRef(new Animated.Value(0)).current
    const animTranslateY = useRef(new Animated.Value(0)).current
    const [selectMode, setSelectMode] = useState<SelectMode>('single')
    const [isSelectAll, setIsSelectAll] = useState(false)
    const theme = useTheme()
    const buttonOpacity = useSettingValue('theme.buttonOpacity')
    // 条内按钮没有写死高度，统一按多选浮动条的高度 40（MULTI_SELECT_BAR_HEIGHT 的设计值）折算半高
    const buttonRadius = useButtonRadius()
    const safeAreaBottom = useSafeAreaBottom()

    useImperativeHandle(ref, () => ({
      show() {
        handleShow()
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
        animTranslateY.setValue(20)

        Animated.parallel([
          Animated.timing(animFade, {
            toValue: 0.92,
            duration: 200,
            useNativeDriver: true,
          }),
          Animated.timing(animTranslateY, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
          }),
        ]).start(() => {
          setAnimatPlayed(true)
        })
      })
    }, [animFade, animTranslateY])

    const handleHide = useCallback(() => {
      setAnimatPlayed(false)
      Animated.parallel([
        Animated.timing(animFade, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(animTranslateY, {
          toValue: 20,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start((finished) => {
        if (!finished) return
        setVisible(false)
        setAnimatPlayed(true)
      })
    }, [animFade, animTranslateY])

    const animaStyle = useMemo(
      () => ({
        ...styles.container,
        height: MULTI_SELECT_BAR_HEIGHT,
        // 悬浮在迷你播放器胶囊上方：胶囊 + tab 栏最高约到 safeAreaBottom + 150
        bottom: 160 + safeAreaBottom,
        backgroundColor: theme['c-content-background'],
        borderColor: theme['c-border-background'],
        opacity: animFade, // Bind opacity to animated value
        transform: [{ translateY: animTranslateY }],
      }),
      [animFade, animTranslateY, theme, safeAreaBottom],
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
                // 条内按钮无自身高度，按多选条高 40 折算半高（同 MULTI_SELECT_BAR_HEIGHT 的设计值）
                borderRadius: buttonRadius(40),
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
                // 条内按钮无自身高度，按多选条高 40 折算半高（同 MULTI_SELECT_BAR_HEIGHT 的设计值）
                borderRadius: buttonRadius(40),
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

          {/* 条内按钮同上：无自身高度，按多选条高 40 折算半高 */}
          <TouchableOpacity onPress={onDownload} style={[styles.btn, { borderRadius: buttonRadius(40) }]}>
            <Text color={theme['c-button-font']}>{global.i18n.t('download')}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={handleSelectAll} style={[styles.btn, { borderRadius: buttonRadius(40) }]}>
            <Text color={theme['c-button-font']}>
              {global.i18n.t(isSelectAll ? 'list_select_unall' : 'list_select_all')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onExitSelectMode} style={[styles.btn, { borderRadius: buttonRadius(40) }]}>
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
      onDownload,
    ])

    return !visible && animatePlayed ? null : component
  },
)

const styles = createStyle({
  container: {
    position: 'absolute',
    left: designSpacing.md,
    right: designSpacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: designSpacing.xs,
    borderRadius: designRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    ...shadow(2),
    overflow: 'hidden',
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
