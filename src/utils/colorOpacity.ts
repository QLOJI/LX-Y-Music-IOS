/**
 * 在已有颜色值上叠加透明度（0-100），返回带 alpha 的颜色。
 * 主题色多为 rgb()/rgba() 字符串（如 'rgb(255,255,255)'），直接拼接十六进制
 * alpha 会得到无效颜色，因此这里做格式解析后再合成。
 */
export const applyOpacity = (color: string, opacity: number): string => {
  // 【第 69 轮第 1 条】两个入口守卫。旧写法把参数直接喂进 Math.max/min：
  //   · opacity 是 undefined / NaN 时，`Math.min(Math.max(NaN, 0), 100)` 还是 NaN
  //     （NaN 与任何数比较都为 false，钳制等于没做），下面的 `(baseAlpha * ratio).toFixed(2)`
  //     拼出 `rgba(12, 34, 56, NaN)` —— React Native **不报错**，直接把这条样式整条丢掉，
  //     表现就是「滑杆拉满、播放中那一行还是没底色」；
  //   · color 不是字符串（主题 token 取空）时 `.match` / `.startsWith` 直接抛。
  // 兜底口径：拿不到透明度就按 100（= 主题原色，与新设置项的默认值同向），拿不到颜色
  // 就给一个合法的透明色 —— 都不许把非法串交给 RN。
  if (typeof color != 'string' || !color) return 'transparent'
  const raw = typeof opacity == 'number' && Number.isFinite(opacity) ? opacity : 100
  const ratio = Math.min(Math.max(raw, 0), 100) / 100

  const rgbaMatch = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (rgbaMatch) {
    const baseAlpha = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1
    return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${(baseAlpha * ratio).toFixed(2)})`
  }

  if (color.startsWith('#')) {
    let hex = color.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split('').map(c => c + c).join('')
    }
    const baseAlpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    const alphaHex = Math.round(baseAlpha * ratio * 255).toString(16).padStart(2, '0')
    return `#${hex.slice(0, 6)}${alphaHex}`
  }

  return color
}
