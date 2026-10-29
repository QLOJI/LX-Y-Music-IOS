// 每日推荐「每个列表本次启动只自动下拉刷新一次」的闸门。
// 第一次进入某个 tab / 某个风格化 key 时返回 true（触发自动下拉）；
// 之后切换回来只显示已有列表，需要新数据由用户手动下拉。
const autoRefreshedKeys = new Set<string>()

export const takeDailyRecAutoRefresh = (key: string): boolean => {
  if (autoRefreshedKeys.has(key)) return false
  autoRefreshedKeys.add(key)
  return true
}
