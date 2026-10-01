// utils/buttonRadius.ts
//
// 「按钮圆角」：按钮族（按钮 / 胶囊 / 芯片 / 图标按钮 / 分段控件 / 内联小按钮）的
// 圆角半径比例，0-100。调节入口在「设置 → 主题 → 按钮圆角」，紧挨「按钮透明度」。
//
// 为什么不能像 designRadius 那样在 createStyle 里算：
//   createStyle 在**模块加载时**就把样式固化进 StyleSheet，之后再改设置不会重新求值。
//   所以调用方统一用 useButtonRadius() 订阅设置，再以行内样式覆盖上去
//   （与「按钮透明度」用的 applyOpacity 是同一套做法：静态样式保留当兜底，
//    行内值才是生效值）。
//
// 刻度是**绝对比例**（2026-10-01 用户定案，否掉了「0% = 保持现状」的相对方案）：
//   0   = 直角（方角）—— 默认值
//   100 = 半圆 —— RN 会把超大半径夹到 min(宽, 高) / 2，即侧面圆弧闭合成半圆
//   中间值按**该按钮自身高度的一半**线性插值。
//
// 为什么每个调用点要传 height：
//   0-100 表示「占该按钮半高的比例」，不同高度的按钮必须各用自己的一半高度做分母，
//   否则矮胶囊会先到半圆、高按钮永远到不了。height 传该按钮样式里写死的设计高度
//   （与 createStyle 里 height 写的是同一个数）；靠 padding 撑起来、没有固定高度的
//   按钮省略该参数，用 DEFAULT_BUTTON_RADIUS_HEIGHT 兜底。

import { useMemo } from 'react'
import { useSettingValue } from '@/store/setting/hook'
import { scaleSizeH } from './pixelRatio'

/** 没有固定高度的按钮的参考高度（对应设计令牌里最常用的 56pt 控件）。 */
export const DEFAULT_BUTTON_RADIUS_HEIGHT = 56

/**
 * 100% 时返回的超大值。RN 会把圆角夹到 min(宽, 高) / 2，因此这个值对任何尺寸的
 * 按钮都等价于「精确半圆」，无需知道真实尺寸。99% 与 100% 的视觉差异只有一点点
 * 圆角收口，不会出现跳变。
 */
const FULL_SEMICIRCLE = 9999

/**
 * 把 0-100 的比例换算成具体半径。
 * @param pct 按钮圆角比例，0 = 直角，100 = 半圆
 * @param height 该按钮的设计高度（与 createStyle 里写的同一个数值），省略则用默认参考高度
 */
export const radiusFor = (pct: number, height = DEFAULT_BUTTON_RADIUS_HEIGHT): number => {
  const v = Number(pct)
  // 设置缺失 / 非法值时按 0 处理（等价于默认值），不要让 NaN 传进 style
  if (!Number.isFinite(v) || v <= 0) return 0
  if (v >= 100) return FULL_SEMICIRCLE
  // height 走与 createStyle 同一个缩放函数，保证在任何屏幕密度下都等于真实半高
  return (Math.min(v, 100) / 100) * (scaleSizeH(height) / 2)
}

/**
 * 订阅「按钮圆角」设置，返回一个「高度 → 半径」的换算函数。
 *
 * 用法（hook 必须写在组件函数体顶层）：
 *   const buttonRadius = useButtonRadius()
 *   ...
 *   style={[styles.btn, { borderRadius: buttonRadius(44) }]}
 *
 * height 省略时用 DEFAULT_BUTTON_RADIUS_HEIGHT；同一个组件里有多种高度的按钮时，
 * 在各自的行内样式里传各自的 height 即可。
 */
export const useButtonRadius = (): ((height?: number) => number) => {
  const pct = useSettingValue('theme.buttonRadius')
  return useMemo(() => (height?: number) => radiusFor(pct, height), [pct])
}
