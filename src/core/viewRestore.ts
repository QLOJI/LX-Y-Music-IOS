import { setNavActiveId } from '@/core/common'
import { getViewPrevState, getViewPrevDetail } from '@/utils/data'
import { type NAV_ID_Type } from '@/config/constant'
import type { ListInfoItem } from '@/store/songlist/state'

/**
 * 「退出前所在界面」的页内子状态（B-6）。
 *
 * 只负责两处「页内子界面」的恢复：
 *  - discovery：推荐页当前选中的平台（如酷狗音乐）与页内打开的歌单详情；
 *  - songlist：歌单页内嵌打开的歌单详情。
 *
 * 刻意「不恢复」的边界（后人不要顺手扩大）：
 *  - 搜索页内部状态（搜索词/结果）：每次进入都应视为新会话，恢复反而干扰输入；
 *  - 「我的」页的列表详情覆盖层：NewListUI 依赖 activeListId，冷启动为空即主界面，
 *    需求明确要求「我的」只回主界面，禁止为它做恢复；
 *  - 设置页 push 出去的子屏：RNN 导航栈不做持久化，只恢复设置主界面；
 *  - nav_play_history：底部浮层，保持既有「不持久化」语义；
 *  - 其余既有独立页面 id（nav_top / nav_daily_rec / nav_kg_playlist / nav_webdav /
 *    nav_local_download 等）继续走顶层 id 恢复，不经本模块。
 */
export interface ViewPrevDetailState {
  discovery?: { source?: LX.OnlineSource, playlist?: ListInfoItem | null }
  songlist?: { playlist?: ListInfoItem | null }
}

// 待恢复状态：进程内缓存，只由 loadViewRestoreState 写入。
let pendingId: NAV_ID_Type | null = null
let pendingDetail: ViewPrevDetailState | null = null

// 一次性消费标记。必须是模块级（进程级）布尔：iPad 横屏（Horizontal/Main.tsx 单页
// 按需渲染）切 tab 会卸载再重挂载页面组件，若消费不置位，同一次启动内会把同一份
// detail 反复弹出（表现为「歌单详情切走再切回又出现」）。
let consumed = false

/**
 * 读盘并把待恢复状态缓存进内存（在 core/init/index.ts 的 init() 里被 await）。
 *
 * 为什么恢复必须早于 Home push：
 *  1) app.ts 在 init() 返回后才 pushHomeScreen，PagerView 挂载时直接用那一刻的
 *     commonState.navActiveId 推导 initialPage；
 *  2) 旧实现在 dataInit 末尾（fire-and-forget），前面 getUserLists 等任一 await reject
 *     会让整条链中断，恢复根本执行不到 —— 这是「重进永远停在推荐页」的根因；
 *  3) 页内子状态的待恢复缓存也必须先于 UI 挂载就绪，UI 才能一次性消费到。
 *
 * 任何读取失败都退化为默认值（nav_discovery + 空 detail），本函数绝不 reject。
 */
export const loadViewRestoreState = async(): Promise<void> => {
  let id: NAV_ID_Type = 'nav_discovery'
  let detail: ViewPrevDetailState = {}
  try {
    id = (await getViewPrevState()).id ?? id
    detail = (await getViewPrevDetail()) ?? {}
  } catch {
    // 读盘失败：保持默认值，启动链路不能因此中断
  }

  pendingId = id
  pendingDetail = detail
  consumed = false

  try {
    setNavActiveId(id)
  } catch {
    // setNavActiveId 内部含存储写入，理论上不抛；兜底保证本函数绝不 reject
  }
}

/**
 * 一次性消费：仅当待恢复的顶层 id === 传入 id 且本进程尚未消费过时，
 * 返回 detail 并置为已消费；否则返回 null。
 *
 * 为什么要「一次性」：
 *  - 同一份待恢复状态只对应冷启动后第一次挂载的那一个界面；用户之后手动切页 /
 *    关闭详情不该再被恢复值覆盖；
 *  - 横屏切走再切回、或从其它 tab 再次进入该页，都不允许重复弹歌单详情。
 */
export const consumeViewRestore = (id: NAV_ID_Type): ViewPrevDetailState | null => {
  if (consumed || pendingId !== id) return null
  consumed = true
  return pendingDetail
}
