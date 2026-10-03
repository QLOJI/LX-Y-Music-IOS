/**
 * 【第二十轮·图三】「页面自管页头」的导航 id 集合 —— 竖屏（Vertical/Content）与
 * 横屏（Horizontal/index）此前各写一份完全相同的 Set，现在收敛到这一份，杜绝漂移。
 *
 * 语义：集合内的页面自己渲染标题（PageTopInset + DetailPageTitle，位置按「我的」标题），
 * 共享页头（Vertical/Header、Horizontal/Header）必须不再渲染，否则同一屏上会出现
 * 两个标题 —— 用户第 20 轮图三：WebDAV 页出现两个「WebDAV」字样标题。
 *
 * 为什么 Header 组件内部还要再判一次（纵深防御）：
 * 仅靠调用方（Content/index）判一次在源码上是成立的，但那是一条「约定」—— 任何新写的
 * 容器/分支只要漏判，或者将来有人再包一层，第二个标题就会重新出现；而真机截图只能看到
 * 「多了一行标题」，看不出是哪一层画的（第 20 轮为定位这一点做了整页的像素级测量与穷举，
 * 成本极高，且当时按源码无法复现用户的截图）。让 Header 自己认识这份集合之后，无论谁、
 * 从哪渲染 Header，页面自管的 id 都不会再出现第二行标题：从「靠调用方小心」变成
 * 「结构上不可能」。两层判断共用同一个集合，不存在不一致的可能。
 */
export const PAGE_OWNED_HEADER_IDS: ReadonlySet<string> = new Set([
  'nav_discovery',
  'nav_play_history',
  'nav_songlist',
  'nav_search',
  'nav_love',
  'nav_setting',
  // 排行榜页接管页头：大标题与当前榜单名同行展示
  'nav_top',
  // 三大平台每日推荐接管页头：大标题与 tab 切换同行展示
  'nav_daily_rec',
  'nav_tx_daily_rec',
  'nav_kg_daily_rec',
  // 三大平台歌单页接管页头：大标题与 tab 切换同行展示
  'nav_my_playlist',
  'nav_tx_playlist',
  'nav_kg_playlist',
  // 我的页的其余二级列表页接管页头：页面标题按「我的」标题的位置/行高渲染
  // （DetailPageTitle；字号取共享页头的字号）—— 用户第 14 轮第 1 条
  'nav_followed_artists',
  'nav_subscribed_albums',
  'nav_webdav',
  'nav_local_download',
])

/** 该导航是否由页面自己接管页头（是 ⇒ 共享页头必须返回 null）。 */
export const isPageOwnedHeader = (navId: string): boolean => PAGE_OWNED_HEADER_IDS.has(navId)
