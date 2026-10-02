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
import { useStatusbarHeight, useScreenCovered } from '@/store/common/hook'
import playerState from '@/store/player/state'
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

export default memo(({ componentId }: { componentId: string }) => {
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
  // 自转可见性：本屏被压栈页（评论/设置/歌单详情…）盖住时封面根本不可见，不加这道门的话
  // 原生动画仍被逐帧驱动（纯白烧电）—— 与竖屏 Pic.tsx 同一套 RNN 栈顶判据。
  // 横屏没有「封面页/歌词页」分页（左栏常驻，见 Horizontal/index.tsx），所以不需要竖屏
  // 那条 active（PagerView 当前页）门控，可见性只有屏幕是否被覆盖这一个来源。
  const screenCovered = useScreenCovered(componentId)
  const spinVisible = !screenCovered
  const coverSizeRaw = useSettingValue('playDetail.style.coverSize')
  const coverSize = typeof coverSizeRaw === 'number' && !isNaN(coverSizeRaw) ? coverSizeRaw : 100
  const spinValue = useRef(new Animated.Value(0)).current
  const animationRef = useRef<Animated.CompositeAnimation | null>(null)
  const isAnimating = useRef(false)
  const isUnmounted = useRef(false)
  // 相位锚点（只在驱动中有效）：`{ phase, at }` = 「at 毫秒时刻，相位是 phase」。
  // 自转是匀速线性动画（25s 一整圈），所以任何时刻的相位都能由它**同步**推算出来
  //（readSpinPhase）。不用「回读原生动画值」那条路：那是异步的，会和「切歌 / 关自转时
  // 同步清相位」抢时序 —— 回调晚一拍落地就会把陈旧的相位写回去，恢复时反而跳一下。
  const phaseAnchorRef = useRef<{ phase: number, at: number } | null>(null)
  // 「无缝续转」相位（0~1）：只由**临时不可见**那条停法写入（见 stopAnimation），
  // 下一次恢复驱动时从该角度接着转，不再按播放位置重锚。
  // 2026-10-02 修的 bug（与竖屏 Pic.tsx 同源）：进评论页 / 歌名 / 专辑页再返回播放详情页，
  // 封面会「短暂卡顿」—— 成因正是恢复驱动时按播放位置重锚：在评论页待了 8 秒，位置相位
  // 前进了 8/25 圈 ≈ 115°，返回的第一帧封面就从离开时的角度猛地跳到 115° 再继续转。
  // 改成续转后，恢复的第一帧就是离开时的那个角度，肉眼无跳变。
  const resumePhaseRef = useRef<number | null>(null)
  // spinVisible 的 ref 镜像：stopAnimation 需要区分「这次停是不是因为不可见」，
  // 但把 spinVisible 加进它的依赖数组会让下面卸载 effect 的 cleanup 每次可见性变化
  // 都重跑一次（那里会把 isUnmounted 置 true，等于把自转永久关掉），所以只镜像读最新值。
  const spinVisibleRef = useRef(spinVisible)
  spinVisibleRef.current = spinVisible

  const createAnimation = useCallback((value: number) => {
    return Animated.timing(spinValue, {
      toValue: 1,
      duration: SPIN_CYCLE_DURATION * (1 - value),
      easing: Easing.linear,
      useNativeDriver: true,
    })
  }, [spinValue])

  // 起转角（0~1）=「已播位置」在自转周期内的相位（与竖屏 Pic.tsx 同源。
  // 恢复驱动时用它重锚，而不是沿用上次停下的角度、也不是归零 —— 后两者在真机上分别是
  // 「暂停久了转一大截」和「恢复时肉眼可见地跳一下」：
  //  - 不可见/暂停期间角度不推进也不补转，恢复时直接对齐播放位置；
  //  - 对齐的是播放位置：位置没变（普通暂停/恢复）看不出跳变；位置变过（拖动进度条）
  //    则角度跟着进度走，与进度条语义一致。
  const getSpinPhase = useCallback(() => {
    const position = playerState.progress.nowPlayTime
    const cycle = SPIN_CYCLE_DURATION / 1000
    if (!Number.isFinite(position) || position <= 0) return 0
    return (position % cycle) / cycle
  }, [])

  // 当前**实际**相位（0~1）：驱动中由相位锚点同步推算（匀速线性 ⇒ 相位 = 起点相位 +
  // 已过时间/周期）；没有锚点（从未驱动过）时回落到按已播位置推导，与历史口径一致。
  // 与 getSpinPhase 的区别：getSpinPhase 是「若此刻起转该从哪起步」（可与实际角度脱节，
  // 例如封面临时不可见期间播放位置还在前进）；readSpinPhase 是「封面此刻转到哪儿了」。
  const readSpinPhase = useCallback(() => {
    const anchor = phaseAnchorRef.current
    if (!anchor) return getSpinPhase()
    const phase = anchor.phase + (Date.now() - anchor.at) / SPIN_CYCLE_DURATION
    return phase - Math.floor(phase)
  }, [getSpinPhase])

  const startAnimation = useCallback((reanchor = true) => {
    if (isAnimating.current || !allowSpin || isUnmounted.current) return
    isAnimating.current = true
    // 先确保在途动画已被取消（驱动只有「停/起」两态，不是把转速降为 0）。
    spinValue.stopAnimation(() => {
      if (isUnmounted.current || !isAnimating.current) return
      // reanchor=true（恢复驱动 / 首次驱动）：优先吃「离开视线前记下的相位」
      //（resumePhaseRef，见 stopAnimation）—— 被压栈页盖住这条路径上，回来的第一帧
      // 就是离开时的角度，不再按进页面期间前进的播放位置重锚（那会跳一下）；
      // 没有记录（首次驱动 / 切歌 / 暂停恢复）时按已播进度重新起算，与历史口径一致。
      // reanchor=false（25s 周期到点的自然续转）：从 0 接上（0°≡360°，无缝）——
      // 接力点不重锚，避免进度更新的粒度在接力瞬间造成微小回跳。
      const recorded = resumePhaseRef.current
      resumePhaseRef.current = null
      const from = reanchor ? (recorded ?? getSpinPhase()) : 0
      spinValue.setValue(from)
      // 相位锚点从这一帧起算：readSpinPhase 之后按「from + 已过时间/周期」推算
      phaseAnchorRef.current = { phase: from, at: Date.now() }
      animationRef.current = createAnimation(from)
      animationRef.current.start(({ finished }) => {
        if (finished && isAnimating.current && !isUnmounted.current) {
          isAnimating.current = false
          startAnimation(false)
        }
      })
    })
  }, [spinValue, createAnimation, allowSpin, getSpinPhase])

  const stopAnimation = useCallback(() => {
    if (!isAnimating.current) return
    isAnimating.current = false
    // 「临时不可见」这条停法（spinVisible=false：被压栈页盖住）记下离开视线那一刻的
    // 实际相位，供恢复可见时无缝续转（见 resumePhaseRef 的完整说明）。
    // 其余停法（暂停、切歌、关自转、卸载）不记：它们各自的恢复语义是「按播放位置重锚」
    // 或「归零」，吃了这份相位反而会破坏原有语义。
    if (!spinVisibleRef.current) resumePhaseRef.current = readSpinPhase()
    // 锚点作废：驱动停了相位不再推进，留着它会把「停住的这段时间」也算进相位里
    phaseAnchorRef.current = null
    animationRef.current?.stop()
    animationRef.current = null
    spinValue.stopAnimation()
  }, [spinValue, readSpinPhase])

  // 启停门控：播放态 × 可见性，任一不满足即取消动画（cancel，不是把转速降为 0）；
  // 恢复驱动时由 startAnimation 按已播进度重锚起转角（见 getSpinPhase）。
  useEffect(() => {
    if (isPlay && allowSpin) {
      if (spinVisible) startAnimation()
      else stopAnimation()
    } else {
      stopAnimation()
    }
  }, [isPlay, allowSpin, spinVisible, startAnimation, stopAnimation])

  // 形状切到「方形」或把自转开关关掉：除停驱动外还必须**把角度归零**。
  // stopAnimation 只停不归零（它要保住「暂停/不可见期间相位不推进、恢复时按已播进度重锚」
  // 的语义，归零会破坏它）；而唯一会归零的切歌 effect 只依赖 musicId —— 于是「圆形 → 方形」
  // 这条路径上封面会**冻在任意相位**：方形带着一个随机角度停在屏幕上（用户报的
  // 「勾选方形封面后，方形封面不应该旋转显示，而是没有角度的显示」）。
  // 写成提前 return（而不是 if (!allowSpin) {...}）是有意的：
  // scripts/sim-cover-shape.js 的 invariant 2 要求「取反 allowSpin」全仓恰好出现 1 次
  //（startAnimation 的守卫），多一处取反直接判红。
  useEffect(() => {
    if (allowSpin) return
    stopAnimation()
    // 关自转 / 切方形：相位归零的同时把「续转相位」与锚点一并作废 ——
    // 否则重新打开自转时封面会带着一个与当前角度不符的陈旧相位起转
    resumePhaseRef.current = null
    phaseAnchorRef.current = null
    spinValue.setValue(0)
  }, [allowSpin, stopAnimation, spinValue])

  // 切歌：重置角度并按新歌的播放位置起转。
  // 依赖只留 musicId —— isPlay / 可见性 / 形状开关的变化统一由上面的启停 effect 消费；
  // 历史写法把 isPlay 放进依赖，导致每次暂停/恢复都 setValue(0) 归零，
  // 恢复播放时封面角度会肉眼可见地跳一下（本轮一并修掉）。
  const musicId = musicInfo.id
  useEffect(() => {
    stopAnimation()
    // 切歌：把「续转相位」与锚点一并作废 —— 那是上一首歌的角度，新歌必须按它自己的
    // 播放位置起算（下面 setValue(0) + startAnimation 会重锚）
    resumePhaseRef.current = null
    phaseAnchorRef.current = null
    spinValue.setValue(0)
    if (isPlay && allowSpin && spinVisible && musicId) {
      startAnimation()
    }
    // 只以切歌为重置时机；其余判据变化由启停 effect / startAnimation 的相位重锚处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicId])

  useEffect(() => {
    return () => {
      isUnmounted.current = true
      stopAnimation()
    }
  }, [stopAnimation])

  // 插值节点必须 memo 化：父级重渲染（切歌、旋转、字号变化…）每次都会新建节点，
  // 而 Animated 会因节点身份变化重新挂载对它的驱动，正在跑的旋转会被打断一帧 ——
  // 也就是「封面转动卡顿」的一类来源。spinValue 是 useRef(...).current，引用恒定，
  // 所以这个依赖数组实际上永不变化（与竖屏 Pic.tsx 同一处修正）。
  const spin = useMemo(() => spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  }), [spinValue])

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
      {/* 圆角只由 coverShape 决定（圆形 = imgWidth/2，方形 = 4），三层同源、都取自
          imageContainerStyle.borderRadius —— 曾经三层各自被「按钮圆角」行内覆盖（默认 0），
          把圆形封面压成直角方块，形状设置直接失效；横屏与竖屏必须同观感
          （sim-cover-shape.js 的 invariant 4 就是钉这个的），竖屏 Pic.tsx 同步去掉了覆盖。 */}
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
