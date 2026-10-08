import { forwardRef, memo, useImperativeHandle, useMemo, useRef, type ComponentRef } from 'react'
import { processColor, requireNativeComponent, type ProcessedColorValue, type ViewProps } from 'react-native'

type LiquidLensProps = ViewProps & {
  /**
   * 药丸目标中心 X（相对本组件左上角）。首次设置直接落位，之后由原生
   * UIView 弹簧动画滑动过去；滑动期间药丸自带加速度挤压/拉伸变形。
   */
  x: number
  /**
   * 按下态：true 时药丸 morph 成完整液态玻璃（LiquidGlassView(.lens)，
   * Metal 折射 + 边缘光，与底部栏玻璃同源）。点击切换的抬落由原生
   * setTargetX 内部驱动，一般无需从 JS 传此 prop。
   */
  lifted?: boolean
  /**
   * 跟手目标中心 X（可选）。拖动期间由父级**命令式**（ref handle 的 setFollowX）
   * 高频写入，绕过 state；此处保留声明式透传面：传值则原生非动画直落，
   * 不传（undefined）则 prop 不被下发。原生未重编译时该 prop 无效，静默降级。
   */
  followX?: number
  /**
   * 仅磨砂代餐时代有意义（液态形态无对应参数，原生为空操作）。保留 prop
   * 维持调用面兼容；底部栏玻璃的浓度由 LiquidGlass 的 glassOpacity 表达。
   */
  glassOpacity?: number
  /** 药丸宽度，默认 56。 */
  pillWidth?: number
  /**
   * 静止药丸底色（rgba 字符串）。**本应用不传**——走原生默认白 30%（上游
   * resting 药丸默认色，随透镜常显在选中 tab 上）；若真机上深浅主题观感
   * 需要分化，可按主题明暗传不同中性色。
   */
  pillColor?: string
  /**
   * 玻璃染色（rgba 字符串）。**本应用不传**（纯玻璃定案）——不传时用
   * .lens 预设的玻璃动态色。
   */
  tint?: string
}

/**
 * 原生组件视角的 props：原生侧的 `tint` 收到的是经 `processColor` 预处理后的色值
 * （number 或 OpaqueColorValue），而非 JS 侧的 rgba 字符串，故单独覆写该字段类型。
 */
type LiquidLensNativeProps = Omit<LiquidLensProps, 'tint'> & { tint?: ProcessedColorValue }

const NativeLiquidLens = requireNativeComponent<LiquidLensNativeProps>('LiquidGlassLens')

/** 命令式句柄：跟手/抬落/结束跟手，全部经 ref 直写原生，不触发 React 渲染 */
export interface LiquidLensHandle {
  /** 跟手直落：把药丸中心直接落到 x（原生非动画分支；<0.1pt 的变化跳过） */
  setFollowX: (x: number) => void
  /** 抬落透镜（拖动开始时抬起、结束时落下），走原生 lifted prop（带动画） */
  setLifted: (lifted: boolean) => void
  /** 结束跟手会话：清掉 JS 侧去重值，下一次会话从干净状态开始 */
  endFollow: () => void
  /**
   * 静止锚点重申（2026-10-08）：把「静止位」x 经**与 x prop 完全相同的原生通道**
   * 写一次（RCT_CUSTOM_VIEW_PROPERTY(x) → setTargetX:animated:YES）。
   *
   * 为什么必须存在：`x` 是声明式 prop，React 只在**值变化**时下发 —— 而跟手通道
   * （followX）会把药丸中心写到任意位置。一旦某次跟手会话没收住尾（idle 事件丢失，
   * 见 ModernTabBar 的 B-7 看门狗），native 的 `_x` 就停在一个非槽心的值上，而 JS
   * 侧 lensX 没变 → prop 永不下发 → 椭圆永久偏离图标/文字中心。本方法给父级一条
   * 「重申静止位」的命令式出口。
   *
   * 成本：原生 setTargetX 有同位守卫（|x - _x| < 0.5pt 直接吞掉、不重播动画），
   * 所以没漂移时本调用是零开销的 no-op；真漂了才播一次回位弹簧。
   * 不与 setFollowX 共用一个去重值（两条通道语义不同：一个是直落、一个是弹簧）。
   */
  setRestX: (x: number) => void
}

/**
 * Paper（RN 0.73 旧架构）下宿主 ref 具备 setNativeProps（直接操作原生属性的官方
 * 通道）。RN 自身类型对 host ref 的声明随版本有差异，这里用最小结构类型收窄，
 * 避免依赖具体版本的类型定义；原生未重编译（没有对应 view property）或实现缺失
 * 时可选调用 + try/catch 静默降级——只失去跟手视觉，不影响切页。
 */
type NativeLensInstance = { setNativeProps?: (props: Record<string, unknown>) => void }

/**
 * 液态玻璃透镜药丸（原生 vendored LiquidLensView，复刻 iOS 26 TabBar 的
 * _UILiquidLensView）：静止态半透明白色药丸常显在选中 tab 上（上游 resting
 * 状态）；tab 切换时抬起 morph 成完整液态玻璃（LiquidGlassView(.lens) 液态
 * 引擎）并弹簧滑动，伴随加速度挤压/拉伸变形，落定回落静止药丸。全版本恒用
 * 自研透镜（上游亦为自研复刻，不调用系统私有类）。
 *
 * 交互面（B-7/C-6 + A-5）：点击切页走 x prop（原生弹簧）；**横滑跟手**与
 * **长按拖动**共用同一套跟手通道（homeTabScroll.ts 的订阅 → 本组件的
 * setFollowX handle，见 src/components/layout/ModernTabBar.tsx）。
 *
 * 用法：绝对定位成一条与药丸等高的横向条带（宽度=容器宽），置于玻璃背景
 * 之上、tab 内容之下；通过 `x` 指定目标中心。原生的 userInteractionEnabled
 * 已关闭，触摸全部穿透。
 */
const LiquidLens = memo(forwardRef<LiquidLensHandle, LiquidLensProps>(({
  x,
  lifted = false,
  followX,
  glassOpacity = 0.4,
  pillColor,
  pillWidth,
  tint,
  style,
}, ref) => {
  const nativeRef = useRef<ComponentRef<typeof NativeLiquidLens>>(null)
  // JS 侧跟手去重值：原生同位守卫是 0.5pt，这里更细（0.1pt），避免拖动起手时
  // 「先跳到整槽再跟手」的可见跳变
  const lastFollowXRef = useRef(0)

  useImperativeHandle(ref, () => ({
    setFollowX: (nextX: number) => {
      if (Math.abs(nextX - lastFollowXRef.current) < 0.1) return
      lastFollowXRef.current = nextX
      try {
        const instance = nativeRef.current as unknown as NativeLensInstance | null
        instance?.setNativeProps?.({ followX: nextX })
      } catch {
        // 原生未重编译（无 followX 属性）时静默降级
      }
    },
    setLifted: (nextLifted: boolean) => {
      try {
        const instance = nativeRef.current as unknown as NativeLensInstance | null
        instance?.setNativeProps?.({ lifted: nextLifted })
      } catch {
        // 同上，静默降级
      }
    },
    endFollow: () => {
      lastFollowXRef.current = 0
    },
    setRestX: (nextX: number) => {
      try {
        const instance = nativeRef.current as unknown as NativeLensInstance | null
        // 写的是 `x`（不是 followX）：与声明式 prop 同一条原生通道 —— 带弹簧动画、
        // 且受同位守卫保护（值没变时原生直接吞掉，不重播任何动画）。
        instance?.setNativeProps?.({ x: nextX })
      } catch {
        // 原生未重编译时静默降级（与 setFollowX 同因）
      }
    },
  }), [])

  // 原生 RCTConvert UIColor: 只认 processColor 预处理后的数值（rgb() 字符串会静默
  // 转成 nil），与 LiquidGlass 同因同修
  const nativeTint = useMemo(
    () => (tint != null ? processColor(tint) ?? undefined : undefined),
    [tint],
  )
  return (
    <NativeLiquidLens
      ref={nativeRef}
      style={style}
      x={x}
      lifted={lifted}
      followX={followX}
      glassOpacity={glassOpacity}
      pillColor={pillColor}
      pillWidth={pillWidth}
      tint={nativeTint}
      pointerEvents="none"
    />
  )
}))

export default LiquidLens
