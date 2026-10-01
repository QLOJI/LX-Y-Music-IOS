import { useEffect, useMemo, useState, type ReactNode } from 'react'

import commonState, { type InitState as CommonState } from '@/store/common/state'
import type { NAV_ID_Type } from '@/config/constant'

// 改这两项设置时，被「设置」浮层盖住的列表页需要隐藏，返回时才按新样式重建列表。
// （原 Main.tsx 顶部的 hideKeys 常量，语义不变。）
const hideKeys = ['list.isShowAlbumName', 'list.isShowInterval'] as Readonly<
Array<keyof LX.AppSetting>
>

/**
 * Home 的 PagerView 懒挂载页：只在第一次切到本页时挂载，之后**保持挂载**不再卸载。
 *
 * 为什么是「保持挂载」而不是「离开即卸载」：这些页面普遍持有较多本地 state——
 * 搜索关键词、列表滚动位置、WebDAV 已浏览目录、本地下载筛选条件、歌单排序等
 * （WebDAV 14 个 useState、TxPlaylist/KgPlaylist 各 10 个、LocalDownload 7 个、
 * Search 6 个、MyPlaylist 5 个）。卸载会让用户「切走再回来」丢失这些状态，属功能回退。
 * 惰性挂载 + 常驻是这些页面的既定取舍，本 hook 只是把原来 13 份复制粘贴的样板收敛成一处。
 *
 * 例外：`LeaderboardPage` 不适用本 hook —— 它无跨切页状态（当前榜单由
 * getLeaderboardSetting 持久化兜底），且内部有一个左侧 12pt 全高的透明手势层
 * （SwipeBackArea），常驻会一直占着一份完整歌曲列表 + 手势层，故它单独实现为
 * 「离开即卸载」。
 *
 * @param navId 本页对应的导航 id
 * @param render 页面内容工厂（只在挂载时求值一次，避免每次重渲染新建元素）
 * @param options.preloadNavIds 预挂载触发页（**必须传模块级常量数组**，保持引用稳定，
 *   否则每次 render 都会重订阅事件）。这些页激活时就把本页一起挂上，用于修「横滑进本页
 *   时页面还是空的」：横滑过程中导航 id 要等 pager 落定才更新，而本页此时已经被拖进
 *   视野——等到落定再挂载 + 再等一帧 rAF，用户看到的就是「拖出来一片空白」。设置页
 *   （nav_setting）是 tab 固定序的最后一页，唯一能滑进它的就是左邻 nav_love，故它用
 *   `preloadNavIds: ['nav_love']`。
 * @param options.hideWhenSettingActive 默认 true：设置页处于激活状态时把本页隐藏
 *   （省一次主题重排，返回时按新样式重建）。设置页**自己**必须传 false —— 否则用户在
 *   设置页里改主题/语言/列表显示项时，随之而来的 themeUpdated / configUpdated 会把用户
 *   正在看的设置页自己置为不可见（整页消失）。这正是旧实现没用本 hook 的原因。
 */
export const useHomeLazyPage = (
  navId: NAV_ID_Type,
  render: () => ReactNode,
  options?: { preloadNavIds?: ReadonlyArray<NAV_ID_Type>, hideWhenSettingActive?: boolean },
) => {
  const preloadNavIds = options?.preloadNavIds
  const hideWhenSettingActive = options?.hideWhenSettingActive ?? true
  const [visible, setVisible] = useState(() => (
    commonState.navActiveId == navId || !!preloadNavIds?.includes(commonState.navActiveId)
  ))

  // render 只在挂载时求值一次：与原来 useMemo(() => <Xxx />, []) 的行为一致
  // （render 由调用方以稳定闭包传入，此处 [] 依赖即等价）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const component = useMemo(render, [])

  useEffect(() => {
    let currentId: CommonState['navActiveId'] = commonState.navActiveId

    const handleNavIdUpdate = (id: CommonState['navActiveId']) => {
      currentId = id
      if (id == navId || preloadNavIds?.includes(id)) {
        // 延后一帧挂载：切页瞬间的布局/滚动更稳，与原实现保持一致。
        requestAnimationFrame(() => {
          setVisible(true)
        })
      }
      // 注意：切走时**不**置 false —— 见函数头注释（保留各页本地 state）。
    }

    // 「设置」是覆盖在其他页之上的浮层；被它盖住时把本页隐藏以省渲染，
    // 但仅限「当前确实在设置页」时才隐藏，避免切页过程中被误隐藏。
    // 设置页自己传 hideWhenSettingActive: false 走不到这里（见 options 注释）。
    const handleHideByTheme = () => {
      if (!hideWhenSettingActive) return
      if (currentId != 'nav_setting') return
      setVisible(false)
    }
    const handleConfigUpdated = (keys: Array<keyof LX.AppSetting>) => {
      // hideKeys 变化时，若正被设置浮层盖住，则隐藏自己以便返回时按新样式重建。
      if (keys.some((k) => hideKeys.includes(k))) handleHideByTheme()
    }

    global.state_event.on('navActiveIdUpdated', handleNavIdUpdate)
    global.state_event.on('themeUpdated', handleHideByTheme)
    global.state_event.on('languageChanged', handleHideByTheme)
    global.state_event.on('configUpdated', handleConfigUpdated)

    return () => {
      global.state_event.off('navActiveIdUpdated', handleNavIdUpdate)
      global.state_event.off('themeUpdated', handleHideByTheme)
      global.state_event.off('languageChanged', handleHideByTheme)
      global.state_event.off('configUpdated', handleConfigUpdated)
    }
    // preloadNavIds 进了依赖：它按约定是模块级常量（引用稳定），正常只会订阅一次；
    // 若调用方传了内联数组，这里也只会多几次廉价的订阅往返，不会出错。
  }, [navId, preloadNavIds, hideWhenSettingActive])

  return visible ? component : null
}
