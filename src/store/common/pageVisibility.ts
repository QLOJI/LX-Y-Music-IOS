import { createContext, useContext } from 'react'

/**
 * 【第 186 轮】「当前这棵 Home 页面是否真的可见」的上下文。
 *
 * Home 的五页 / 各 detail 页是「访问过即常驻」（useHomeLazyPage），切走后只隐藏不卸载。
 * 页内实例最多的连续动画源（跑马灯 / 正在播放图标）此前只有 App 前台门，离屏 tab、
 * 被播放详情等压栈页盖住时仍逐帧驱动 —— 看不见的活。
 *
 * 由 useHomeLazyPage 在挂载页外层提供：可见 = 当前 nav 就是本页 且 Home 没被压栈页覆盖。
 * 不在 Home 页面里的用例（例如播放详情里的播放队列弹窗）没有 Provider，默认 true，
 * 行为与以前完全一致。
 */
export const HomePageVisibleContext = createContext(true)

export const useHomePageVisible = () => useContext(HomePageVisibleContext)
