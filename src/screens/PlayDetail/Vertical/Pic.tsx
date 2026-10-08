import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { View, Animated, Easing, TouchableWithoutFeedback } from 'react-native'
import FastImage from '@d11/react-native-fast-image'
import { useIsPlay, usePlayerMusicInfo, usePlayMusicInfo } from '@/store/player/hook'
import playerState from '@/store/player/state'
import { useWindowSize } from '@/utils/hooks'
import { useSettingValue } from '@/store/setting/hook'
import Image, { defaultHeaders } from '@/components/common/Image'
import { useStatusbarHeight, useScreenCovered } from '@/store/common/hook'
import { HEADER_HEIGHT } from './components/Header'
import { createStyle } from '@/utils/tools'
import CoverLongPressMenu, { type CoverLongPressMenuType } from '@/screens/PlayDetail/components/CoverLongPressMenu'

const AnimatedCover = Animated.createAnimatedComponent(FastImage)

// 封面自转的循环周期（ms）：25s 转满一圈后无缝重来，是持续循环动画。
// 刻意不引用 designMotion —— 那组常量管的是「跳转 / 切行 / 淡入」这类一次性交互过渡；
// 自转周期属于动画本身的表现（转速），不参与「全局交互动效放慢」的调整（150→200 不适用）。
const SPIN_CYCLE_DURATION = 25000

/**
 * 封面的「自然基准直径」：min(屏宽 × 0.65, 可用高 × 0.5)。
 * 设置里的 100% 就是它；50%~150% 是它的倍率区间（见 getCoverSize）。
 * 单独导出：竖屏布局（VerticalNew）算「封面保留下限」时要用同一个基准，
 * 各写一份必然漂移。
 */
export const getCoverNaturalSize = (
  winWidth: number,
  winHeight: number,
  statusBarHeight: number,
) => {
  const availableHeight = winHeight - statusBarHeight - HEADER_HEIGHT
  return Math.min(winWidth * 0.65, availableHeight * 0.5)
}

/**
 * 封面直径：只由窗口尺寸、设置与「封面可用区间高」决定，**不含任何内容实测高**
 * ⇒ 不构成自反馈环（封面变大变小不会反过来改变自己的上限）。
 *
 * 导出给竖屏布局（VerticalNew）复用：那边要用**同一个数**做「小歌词可用高度」的输入。
 * 两处各写一份公式必然漂移 —— 上一版把上限写成 `min(90% 屏宽, 66% 可用高)` 的旧口径
 * 就是这么烂掉的，所以这里只留一份。
 *
 * @param coverSize 设置值 'playDetail.style.coverSize'（50~150）。非法值（NaN / 非 number）
 *        兜底 100 = 基准尺寸，避免历史数据把封面算成 0 或 NaN。
 * @param coverRegionHeight 封面**可占用的纵向区间高度 = 直径上限**（pt），由 VerticalNew
 *        按「页面容器高 R − 页内留白 − 信息块高 − 至少一行小歌词」推出；未实测时的首帧
 *        传解析估算。传 0 / 负数 = 连估算都不可用，此时不施加这一条上限（最后防线：
 *        绝不能把封面算成 0 或极小再撑大）。
 *
 *        【2026-10-02 第 19 轮】这里以前是 `R/2`（R = 页面容器实测高）。那条上限来自
 *        「150% 档上下间隙合计 = 封面直径」的老验收口径，代价是滑块 100% 往上基本不起作用：
 *        用户机型上 base(≈286) 与 R/2(≈294) 只差 8pt ⇒ 100%~150% 整段几乎是平的
 *        （用户报「封面显示大小调节只到 100%，100-150% 没有反应」）。改成直接吃
 *        VerticalNew 推出来的真实可用区间：上限从 R/2 抬到「封面顶部顶到返回栏底边、
 *        底部顶到歌名栏顶边」的物理极限，滑块全段重新起作用，且仍然不会越区
 *        （区间高就是按「不越区」的充要条件算的，见 VerticalNew 的 coverRegionHeight 推导）。
 */
export const getCoverSize = (
  winWidth: number,
  winHeight: number,
  statusBarHeight: number,
  coverSize: unknown,
  coverRegionHeight: number,
) => {
  const ratio = typeof coverSize === 'number' && !isNaN(coverSize) ? coverSize : 100
  const availableHeight = winHeight - statusBarHeight - HEADER_HEIGHT
  const base = getCoverNaturalSize(winWidth, winHeight, statusBarHeight)
  const safetyMax = Math.min(winWidth, availableHeight * 0.85)
  const regionMax = coverRegionHeight > 0 ? coverRegionHeight : Infinity
  return Math.min(base * (ratio / 100), safetyMax, regionMax)
}

/**
 * 竖屏播放页封面。
 * - 封面来源：playerMusicInfo.pic 已兼容在线 + 下载两种来源（playInfo.ts setPlayerMusicInfo）。
 *   同时兜底 playMusicInfo.musicInfo.meta.picUrl（下载歌曲取 metadata.musicInfo.meta.picUrl）。
 * - 旋转动画：采用与横屏/沉浸一致的 createAnimation/startAnimation/stopAnimation 手动循环模式
 *   （参考版封面即此写法）。经验证 Animated.loop 在首屏挂载时常不启动（表现为进页面不转、
 *   切歌才转），故这里改为 stopAnimation 取当前角度后重新 timing 的可靠循环：进页面（歌曲已
 *   播放）即开始旋转，暂停时停止，切歌时重置角度重新旋转。
 * - 渲染组件：使用 Animated.createAnimatedComponent(FastImage) 直接承载封面并做旋转。
 *   旧代码把 FastImage 包在 Animated.View 里做 rotate 动画时，在 iOS 上会白屏/不渲染；
 *   直接对 FastImage 做 rotate 既保留 FastImage 的缓存/加载能力，又避免白屏。
 * - 错误回退：FastImage 加载失败时显示通用 Image 占位图，避免 RN Image 失败后的完全空白。
 * - 圆形：封面自身 borderRadius = size/2（圆形旋转视觉不变），
 *   全链路不使用 overflow:'hidden' 裁切——iOS 上 clipsToBounds 祖先
 *   会把带 transform 的后代剔除出渲染树。
 * - 不使用 RNN sharedElementTransitions：iOS 上会被原生层劫持成错位大图；封面与导航转场解耦。
 * - 尺寸：基准 min(屏宽 * 0.65, 可用高 * 0.5)，再乘设置 'playDetail.style.coverSize'
 *   （50~150%，默认 100%）；上限取「封面可用区间高」（coverRegionHeight，由 VerticalNew 按
 *   「封面 + 信息块 + 至少一行小歌词不越区」反推：稳态吃页面容器实测高，实测到位前的首帧吃
 *   解析估算，封面因此不会出现入场缩放，见 size 处注释），另保留极端机型的安全上限；
 *   与横屏 Pic.tsx 消费同一个设置键。
 * - 位置：本组件只产出固定尺寸的封面，居中由上层容器（VerticalNew 的 picContainer）负责。
 * - 自转启停门控：播放态（useIsPlay）× 可见性（active=封面页是 PagerView 当前页 ×
 *   本屏未被压栈页覆盖）同时成立才驱动；任一不满足立即取消动画（cancel，不是转速改 0）。
 *   恢复驱动时**优先从离开视线那一刻的角度无缝续转**（resumePhaseRef，2026-10-02 修复
 *   「返回播放详情页封面短暂卡顿」）；没有记录（首次驱动 / 切歌 / 暂停恢复）时才按
 *   已播进度重新起算角度（见下方动画区）。
 */
export default memo(({ componentId, active = true, coverRegionHeight = 0 }: { componentId: string, active?: boolean, coverRegionHeight?: number }) => {
  const playerMusicInfo = usePlayerMusicInfo()
  const playMusicInfo = usePlayMusicInfo()
  const { width: winWidth, height: winHeight } = useWindowSize()
  const statusBarHeight = useStatusbarHeight()
  const isPlay = useIsPlay()
  const isCoverSpin = useSettingValue('playDetail.isCoverSpin')
  const coverShape = useSettingValue('playDetail.style.coverShape')
  // 封面显示大小（设置弹层滑块 50~150%）：与横屏 Pic.tsx 同一个设置键（'playDetail.style.coverSize'）。
  // 非法值（NaN / 非 number）兜底 100 = 基准尺寸的判定统一在 getCoverSize 内部，
  // 不在这里再抄一份 —— 两处兜底口径分叉时，「预扣高度」与「实际直径」会对不上。
  const coverSize = useSettingValue('playDetail.style.coverSize')
  // 方形封面强制不旋转（两者互斥，见 SettingCoverShape.tsx 的说明）。
  // 注意：`isCoverSpin` 在下面被替换为 `allowSpin` 参与动画启停判断，
  // 这样「方形时不旋转」只需一处判据，不会出现「方形 + 旋转」被部分应用。
  const isSquare = coverShape === 'square'
  const allowSpin = isCoverSpin && !isSquare

  // 自转可见性：封面页是 PagerView 当前页（VerticalNew 下传 active），且本屏没有被压栈页
  // （评论/设置/歌单详情…）覆盖（useScreenCovered 与其它页面同一套 RNN 栈顶判据）。
  // 两者任一不满足即封面不可见：PagerView 会一直保持封面页挂载，不加这道门时滑到歌词页、
  // 或被别的页面盖住后，原生动画仍被逐帧驱动，纯白烧电。
  const screenCovered = useScreenCovered(componentId)
  const spinVisible = active && !screenCovered

  // 封面 URL：playerMusicInfo.pic 已兼容在线 + 下载两种来源（playInfo.ts setPlayerMusicInfo）。
  // 同时兜底 playMusicInfo.musicInfo.meta.picUrl，保证和参考版 e58d1ab1 的数据入口一致。
  const rawMusicInfo = playMusicInfo.musicInfo
  const coverUrl = playerMusicInfo.pic ||
    (rawMusicInfo && ('progress' in rawMusicInfo
      ? (rawMusicInfo).metadata.musicInfo.meta.picUrl
      : (rawMusicInfo).meta?.picUrl)) ||
    ''

  // FastImage 加载失败状态（RN Image 失败时完全空白，无占位；改用 FastImage 并自带错误回退）
  const [isLoadError, setLoadError] = useState(false)
  useEffect(() => {
    setLoadError(false)
  }, [coverUrl])
  const handleCoverError = useCallback(() => {
    setLoadError(true)
  }, [])

  // 当前歌曲 id，用于切歌时重置旋转角度
  const musicId = playerMusicInfo.id

  // 封面尺寸：算式在模块级的 getCoverSize 里（与 VerticalNew 的「小歌词可用高度」共用同一份），
  // 这里不再叠加第二条上限。
  //
  // coverRegionHeight = 「封面可占用的纵向区间高 = 直径上限」，由 VerticalNew 下传
  //（稳态按页面容器实测高推出，实测到位前的首帧用解析估算，见 VerticalNew 注释）。
  // 区间高是按「封面 + 信息块 + 至少一行小歌词恰好不越区」反推的（推导见 VerticalNew），
  // 所以 getCoverSize 里的 min(…, coverRegionHeight) 就是「不越区」的充要上限：
  // 滑块 50%~150% 要涨到这条线才第一次封顶，而它只由屏幕与内容高决定、与封面当前值无关
  //（封面不会反过来改变自己的上限，无自反馈）。
  // coverRegionHeight ≤ 0（窗口尺寸未就绪的极端首帧）= 不施加这条上限（最后防线：
  // 绝不能把封面算成 0 或极小再撑大）。另保留旧的安全上限 min(屏宽, 85% 可用高) 兜底极端机型。
  //
  // 【2026-10-02 第 19 轮】删掉旧的两条并列上限：
  //   1) 旧 R/2（R = 封面页容器实测高）：用户机型上 R/2 只比 100% 基准大 8pt ⇒
  //      100%~150% 整段几乎无变化，用户报「封面显示大小调节只到 100%，100-150% 没有反应」。
  //      现在上限抬到物理极限：封面顶部顶到返回栏底边、底部顶到歌名栏顶边（区间高
  //      = M − getMiniLyricRowHeight(true)，见 VerticalNew）。全段重新起作用，且仍不越区 ——
  //      小歌词在区间之外另有自己的可用高度（M − 封面直径），区间高就是按这两条同时成立反推的。
  //   2) 旧 sizeCap（VerticalNew 下传的「至少一行小歌词」单向约束）：新口径下它与
  //      coverRegionHeight 是同一个数的两种写法（都由同一份 M − 行高推出），两条并列必然漂移，
  //      合并成一条。
  const size = useMemo(() => (
    getCoverSize(winWidth, winHeight, statusBarHeight, coverSize, coverRegionHeight)
  ), [winWidth, winHeight, statusBarHeight, coverSize, coverRegionHeight])

  // ---- 旋转动画：采用与横屏/沉浸一致的 createAnimation/start/stop 模式 ----
  // 原 Animated.loop 在首屏挂载时常不启动（进页面不转、切歌才转），
  // 这里改为 stopAnimation -> 取当前角度 -> 重新 timing 的可靠循环方式。
  // 启停由两个门控决定（见下面两个 effect）：播放态 × 可见性；
  // 停即取消动画（cancel），恢复驱动时按已播进度重新起算角度。
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
  // 2026-10-02 修的 bug：进评论页 / 歌名 / 专辑页再返回播放详情页，封面会「短暂卡顿」。
  // 成因正是恢复驱动时按播放位置重锚：在评论页待了 8 秒，位置相位前进了 8/25 圈 ≈ 115°，
  // 返回的第一帧封面就从离开时的角度猛地跳到 115° 再继续转。改成续转后，
  // 恢复的第一帧就是离开时的那个角度，肉眼无跳变（相位只在「不可见」期间被冻住，
  // 回来接着转 —— 与用户看到的「静止画面」严格连续）。
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

  // 起转角（0~1）=「已播位置」在自转周期内的相位。
  // 恢复驱动时用它重锚，而不是沿用上次停下的角度、也不是归零——后两者在真机上分别是
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
      //（resumePhaseRef，见 stopAnimation）—— 被压栈页盖住 / 滑到歌词页这条路径上，
      // 回来的第一帧就是离开时的角度，不再按进页面期间前进的播放位置重锚（那会跳一下）；
      // 没有记录（首次驱动 / 切歌 / 暂停恢复）时按已播进度重新起算，与历史口径一致。
      // reanchor=false（25s 周期到点的自然续转）：从 0 接上（0°≡360°，无缝）——
      // 接力点不重锚，避免进度更新的粒度（前台 4Hz，非前台更粗）在接力瞬间造成微小回跳。
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
    // 「临时不可见」这条停法（spinVisible=false：被压栈页盖住 / 滑到歌词页）记下
    // 离开视线那一刻的实际相位，供恢复可见时无缝续转（见 resumePhaseRef 的完整说明）。
    // 其余停法（暂停、切歌、关自转、卸载）不记：它们各自的恢复语义是「按播放位置重锚」
    // 或「归零」，吃了这份相位反而会破坏原有语义。
    if (!spinVisibleRef.current) resumePhaseRef.current = readSpinPhase()
    // 锚点作废：驱动停了相位不再推进，留着它会把「停住的这段时间」也算进相位里
    phaseAnchorRef.current = null
    animationRef.current?.stop()
    animationRef.current = null
    spinValue.stopAnimation()
  }, [spinValue, readSpinPhase])

  // 启停门控：播放态 × 可见性，任一不满足即取消动画；恢复驱动时由 startAnimation
  // 按已播进度重锚起转角（见 getSpinPhase）。
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
  // 这条路径上封面会**冻在任意相位**：方形带着一个随机角度停在屏幕上，正是用户报的
  // 「勾选方形封面后，方形封面不应该旋转显示，而是没有角度的显示」。
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

  // 插值节点必须 memo 化：父级（VerticalNew）在滑动期间会 setForceUpdate 重渲染，
  // 本组件的 active 随之变化 ⇒ 重渲染，每次渲染都新建插值节点会让 Animated 重新挂载
  // 对该节点的驱动，正在跑的旋转动画会被打断一帧 —— 也就是「滑动中封面卡顿」的一类来源。
  // spinValue 是 useRef(...).current，引用恒定，所以这个依赖数组实际上永不变化。
  const spin = useMemo(() => spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  }), [spinValue])

  // ---- 长按菜单：下载歌曲 / 下载封面 ----
  // 【第 21 轮·优化 2（2026-10-03）】菜单实现（菜单项、动作、弹层与锚点测量）抽到
  // PlayDetail/components/CoverLongPressMenu.tsx，与横屏封面共用同一份 —— 以前这段
  // 内联在这里，横屏封面因此完全没有长按入口；「下载封面」自己那套写沙盒 Pictures
  // 的代码也一并收敛过去（现在统一走 utils/image.ts 保存到系统相册）。
  // 本组件只负责：量出封面位置 → 让菜单弹出来。
  const menuRef = useRef<CoverLongPressMenuType>(null)
  const coverRef = useRef<View>(null)

  const handleLongPress = () => {
    menuRef.current?.show()
  }

  const menuMusicInfo = playMusicInfo.musicInfo

  // 方形封面的圆角：小圆角，保留图本身的方形观感。
  // 保持独立字面量而不并入 designRadius 令牌：这 4pt 是按「自转方形封面」的观感手调的，
  // 令牌里同值的 sm/md 面向的是列表封面与卡片（46 处引用），两者语义不同 ——
  // 令牌再动时这里应当独立评估，而不是被一起带走。（当前恰好同为 4。）
  // 与横屏 Pic.tsx 的方形分支保持同值（两处必须一致，否则横竖屏切一下形状观感不一致），
  // 由 scripts/sim-cover-shape.js 的 invariant 4 与跨文件比对钉住。
  const SQUARE_RADIUS = 4
  const radius = isSquare ? SQUARE_RADIUS : size / 2
  // 外层容器：只负责固定尺寸与定位，**不做 overflow 裁切**。
  // iOS 上 overflow:'hidden'(clipsToBounds) 的祖先 + 带 transform 的后代
  // 会被错误剔除出渲染树（封面白屏的根因）。圆形效果完全由封面自身的
  // borderRadius 实现——圆形旋转后仍是圆形，视觉与裁切完全一致。
  // 方形同理不需要裁切：方形本来就不旋转，圆角也由封面自身给。
  const coverContainerStyle = useMemo(() => ({
    width: size,
    height: size,
    backgroundColor: 'transparent' as const,
  }), [size])

  // 封面图样式：固定尺寸 + 圆角（圆形=size/2，方形=小圆角）+ 旋转动画
  // （方形时 allowSpin 恒为 false，动画不会启动、角度停在 0）
  const animatedCoverStyle = useMemo(() => ({
    width: size,
    height: size,
    borderRadius: radius,
    transform: [{ rotate: spin }],
  } as any), [size, radius, spin])

  // 无封面 URL 时回退到通用 Image 组件（显示 EmptyPic 占位）
  const emptyImageStyle = useMemo(() => ({
    width: '100%',
    height: '100%',
    borderRadius: radius,
  } as any), [radius])

  return (
    <View style={styles.container}>
      <TouchableWithoutFeedback onLongPress={handleLongPress}>
        <View
          ref={coverRef}
          collapsable={false}
          style={coverContainerStyle}
        >
          {coverUrl && !isLoadError ? (
            <AnimatedCover
              source={{
                uri: coverUrl,
                headers: defaultHeaders,
                priority: 'normal',
                cache: 'immutable',
              }}
              // 自转封面的圆角**只由 coverShape 决定**（圆形 = size/2，方形 = 4），不走「按钮圆角」：
              //  · 「按钮圆角」默认 0（defaultSetting.ts 的 theme.buttonRadius）—— 行内覆盖会把
              //    「圆形封面」压成**直角方块**，形状设置直接失效；
              //  · 方块自转时对角的外接半径 = size×√2/2，比圆的 size/2 外扩 0.207×size
              //    （用户机型 440×956 上 size≈286 ⇒ 约 59pt），四个角会捅出 picContainer、
              //    压到歌名栏与大歌词上 —— 这正是「封面图片区域跑到其他区域」的成因；
              //  · 而外层容器按 design 约定**不做 overflow 裁切**（iOS 上 clipsToBounds 祖先 +
              //    带 transform 的后代会被错误剔除出渲染树，是封面白屏的老根因），越界没有任何东西兜住；
              //  · 与用户点名的「歌单封面」也不冲突：那三类面是 PlaylistCard / SonglistDetail 的
              //    封面（由 check-button-radius-coverage.js 钉住），本处是详情页的自转封面，
              //    形状语义由 playDetail.style.coverShape 这个更具体的设置独占。
              style={animatedCoverStyle}
              resizeMode={FastImage.resizeMode.cover}
              onError={handleCoverError}
            />
          ) : (
            <Image url={coverUrl} style={emptyImageStyle} />
          )}
        </View>
      </TouchableWithoutFeedback>
      <CoverLongPressMenu ref={menuRef} anchorRef={coverRef} musicInfo={menuMusicInfo} />
    </View>
  )
})

const styles = createStyle({
  container: {
    flexShrink: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
})
