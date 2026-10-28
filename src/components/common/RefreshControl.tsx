import { memo, useEffect, useRef, useState } from 'react'
import { RefreshControl as RNRefreshControl, type RefreshControlProps } from 'react-native'
import { useTheme } from '@/store/theme/hook'

/**
 * 全 App 统一的下拉刷新控件：
 *   · 颜色统一走主题主色（iOS tintColor / Android colors + 背景）；
 *   · 刷新指示器至少停留 MIN_REFRESH_MS：接口很快返回时也不会「闪一下就没」，
 *     所有页面看到的刷新节奏一致、比系统默认稍慢一点。
 *
 * 数据与刷新规则不变：本组件只控制「指示器何时隐藏」，不改变父级的
 * refreshing / onRefresh 语义，也不延迟数据更新。
 */
export const MIN_REFRESH_MS = 600

const RefreshControl = (props: RefreshControlProps) => {
  const theme = useTheme()
  const [visible, setVisible] = useState(!!props.refreshing)
  const startedAtRef = useRef(props.refreshing ? Date.now() : 0)

  useEffect(() => {
    if (props.refreshing) {
      startedAtRef.current = Date.now()
      setVisible(true)
      return
    }
    if (!startedAtRef.current) return
    const remain = MIN_REFRESH_MS - (Date.now() - startedAtRef.current)
    if (remain <= 0) {
      startedAtRef.current = 0
      setVisible(false)
      return
    }
    const timer = setTimeout(() => {
      startedAtRef.current = 0
      setVisible(false)
    }, remain)
    return () => { clearTimeout(timer) }
  }, [props.refreshing])

  return (
    <RNRefreshControl
      {...props}
      refreshing={visible}
      colors={[theme['c-primary']]}
      tintColor={theme['c-primary']}
      progressBackgroundColor={theme['c-content-background']}
    />
  )
}

export default memo(RefreshControl)
