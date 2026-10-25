// 每日推荐页的「本次启动」状态：页面离开即卸载，靠这两份模块级数据撑住体验。
//   · autoRefreshDone：每次打开软件、每个 tab 只自动下拉刷新一次；
//   · lists：上次拿到的列表，再进入时先原样显示（不转圈、不请求），用户要新数据就手动下拉。
const autoRefreshDone = new Set<string>()
const lists = new Map<string, unknown>()

export const takeDailyRecAutoRefresh = (key: string): boolean => {
  if (autoRefreshDone.has(key)) return false
  autoRefreshDone.add(key)
  return true
}

export const getDailyRecSessionList = <T>(key: string): T | undefined => {
  return lists.get(key) as T | undefined
}

export const setDailyRecSessionList = <T>(key: string, data: T) => {
  lists.set(key, data)
}
