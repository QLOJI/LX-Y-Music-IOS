import { memo, useEffect, useMemo, useRef, useCallback } from 'react'
import { Animated, Easing, View } from 'react-native'
import { usePlayerMusicInfo, useIsPlay } from '@/store/player/hook'
import { useWindowSize } from '@/utils/hooks'
import { createStyle } from '@/utils/tools'
import { shadow } from '@/utils/shadow'
import { HEADER_HEIGHT } from './components/Header'
import { BTN_WIDTH } from './MoreBtn/Btn'
import { marginLeft } from './constant'
import Image from '@/components/common/Image'
import { useStatusbarHeight } from '@/store/common/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useLandscapeLayout, getLeftWidth } from '@/utils/landscapeLayout'

// 封面自转的循环周期（ms）：25s 转满一圈后无缝重来，是持续循环动画。
// 刻意不引用 designMotion —— 那组常量管的是「跳转 / 切行 / 淡入」这类一次性交互过渡；
// 自转周期属于动画本身的表现（转速），不参与「全局交互动效放慢」的调整（150→200 不适用）。
const SPIN_CYCLE_DURATION = 25000

// 方形封面的圆角：与竖屏 Pic.tsx 同值，且同样保持独立字面量不并入 designRadius 令牌
// （令牌的 sm/md 面向列表封面与卡片，语义不同；当前恰好同为 4）。
// 横竖屏两处必须同值，否则切一下方向方形封面的圆角观感就不一致，
// 由 scripts/sim-cover-shape.js 的 invariant 4 与跨文件比对钉住。
const SQUARE_RADIUS = 4

export default memo(({ componentId: _componentId }: { componentId: string }) => {
  const musicInfo = usePlayerMusicInfo()
  const { width: winWidth, height: winHeight } = useWindowSize()
  const layout = useLandscapeLayout()
  const statusBarHeight = useStatusbarHeight()
  const isPlay = useIsPlay()
  const isCoverSpin = useSettingValue('playDetail.isCoverSpin')
  const coverShape = useSettingValue('playDetail.style.coverShape')
  // 方形封面强制不旋转（与竖屏 Pic.tsx 同一套语义，见 SettingCoverShape.tsx）。
  const isSquare = coverShape === 'square'
  const allowSpin = isCoverSpin && !isSquare
  const coverSizeRaw = useSettingValue('playDetail.style.coverSize')
  const coverSize = typeof coverSizeRaw === 'number' && !isNaN(coverSizeRaw) ? coverSizeRaw : 100
  const spinValue = useRef(new Animated.Value(0)).current
  const animationRef = useRef<Animated.CompositeAnimation | null>(null)
  const isAnimating = useRef(false)
  const isUnmounted = useRef(false)

  const createAnimation = useCallback((value: number) => {
    return Animated.timing(spinValue, {
      toValue: 1,
      duration: SPIN_CYCLE_DURATION * (1 - value),
      easing: Easing.linear,
      useNativeDriver: true,
    })
  }, [spinValue])

  const startAnimation = useCallback(() => {
    if (isAnimating.current || !allowSpin || isUnmounted.current) return
    isAnimating.current = true
    spinValue.stopAnimation(value => {
      if (isUnmounted.current) return
      animationRef.current = createAnimation(value)
      animationRef.current.start(({ finished }) => {
        if (finished && isAnimating.current && !isUnmounted.current) {
          spinValue.setValue(0)
          isAnimating.current = false
          startAnimation()
        }
      })
    })
  }, [spinValue, createAnimation, allowSpin])

  const stopAnimation = useCallback(() => {
    if (!isAnimating.current) return
    isAnimating.current = false
    animationRef.current?.stop()
    animationRef.current = null
    spinValue.stopAnimation()
  }, [spinValue])

  useEffect(() => {
    if (isPlay && allowSpin) {
      startAnimation()
    } else {
      stopAnimation()
    }
  }, [isPlay, allowSpin, startAnimation, stopAnimation])

  useEffect(() => {
    stopAnimation()
    spinValue.setValue(0)
    if (isPlay && allowSpin) {
      startAnimation()
    }
  }, [musicInfo.id, isPlay, allowSpin, startAnimation, stopAnimation, spinValue])

  useEffect(() => {
    return () => {
      isUnmounted.current = true
      stopAnimation()
    }
  }, [stopAnimation])

  const spin = spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  })

  const imageContainerStyle = useMemo(() => {
    // 歌词区被限宽时，多出来的空间由左半区吸收，因此按左半区实际宽度推导封面尺寸，
    // 避免封面与信息区脱节。手机横屏（medium 档）下结果与历史计算完全一致。
    const leftWidth = getLeftWidth(winWidth, layout)
    let baseWidth = Math.min(
      (leftWidth - marginLeft - BTN_WIDTH) * layout.coverFillRatio,
      (winHeight - statusBarHeight - HEADER_HEIGHT) * layout.coverHeightRatio,
    )
    baseWidth -= baseWidth * (global.lx.fontSize - 1) * 0.3
    const imgWidth = baseWidth * (coverSize / 100)
    const radius = isSquare ? SQUARE_RADIUS : imgWidth / 2
    return {
      width: imgWidth,
      height: imgWidth,
      borderRadius: radius,
      // iOS 浮层阴影（仅 iPhone/iPad）
      ...shadow(3),
      opacity: 1,
      backgroundColor: 'transparent',
      overflow: 'hidden',
    }
  }, [winWidth, winHeight, statusBarHeight, isSquare, coverSize, layout])

  const imageStyle = useMemo(() => ({
    width: '100%',
    height: '100%',
    borderRadius: imageContainerStyle.borderRadius,
  } as any), [imageContainerStyle.borderRadius])

  let contentHeight = (winHeight - statusBarHeight - HEADER_HEIGHT) * 0.66
  contentHeight -= contentHeight * (global.lx.fontSize - 1) * 0.2

  return (
    <View style={{ ...styles.container, height: contentHeight }}>
      <View style={[styles.content, imageContainerStyle, { overflow: 'hidden' }]}>
        <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: imageContainerStyle.borderRadius, transform: [{ rotate: spin }] }}>
          <Image
            url={musicInfo.pic}
            style={imageStyle}
          />
        </Animated.View>
      </View>
    </View>
  )
})

const styles = createStyle({
  container: {
    flexShrink: 1,
    flexGrow: 0,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  content: {
    backgroundColor: 'rgba(0,0,0,0)',
  },
})
