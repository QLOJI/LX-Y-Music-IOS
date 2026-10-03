// screens/PlayDetail/lyricAnimation.ts
//
// 播放详情页（大歌词 / 小歌词 / 手动定位浮层）动效时长的**单一来源**。
//
// 此前这些时长在各文件里各写各的魔数（换行滑动 180、seek 过渡 180、回位 120~300…），
// 导致「按大歌词的速率」这类要求无处落地，全局调速也要逐文件改。现统一收口到这里，
// 实际数值一律取自 designMotion.quick（2026-10-01：150 → 200，全局放慢）。
// 新增歌词相关动画请引用本文件，不要再内联数字。

import { designMotion } from '@/theme/DesignTokens'

/** 歌词换行时，当前行滑到居中位置的时长（大歌词与小歌词同值）。 */
export const LINE_CHANGE_GLIDE_MS = designMotion.quick

/** 手动拖动歌词结束、停手多久后自动回位并隐藏定位浮层。用户要求「未滑动响应时间缩短一半」，故由 3000 改为 1500。 */
export const IDLE_RETURN_MS = 1500

/** 定位浮层（虚线 + 时间 + 播放三角）显隐的淡入淡出时长。 */
export const OVERLAY_FADE_MS = designMotion.quick

/**
 * 手动滑动后「回位到正在播放的那一行」的时长（与竖屏大歌词的回位滑动同值同源）。
 *
 * 竖屏大歌词的回位不是另起一套动画：停手后它往连续滚动循环里排一个 glide 任务，
 * 走的就是换行滑动那条 easeInOutQuad、固定 600ms（Vertical/Lyric.tsx 的
 * LINE_CHANGE_GLIDE_REF_MS，需求 #1 对齐参考工程的定案值）。
 * 小歌词（MiniLyric）此前按距离取 [120, 300]，同屏一比就是「小歌词回位窜得快」
 * —— 用户报的「小歌词滑动后返回播放进度时，动画速度和大歌词不一致」。
 * 现在两边共同引用本常量：改一处两边同步，不会再各自漂移。
 * （曲线两边同为 easeInOutQuad，只差时长，所以对齐时长即完全同速。）
 */
export const RETURN_TO_ACTIVE_MS = 600

/**
 * 自动回位动画的时长：随距离线性增长并夹在 [120, 300] 内，远距离不会拖沓。
 *
 * 注意：**竖屏大歌词与小歌词的回位不用它**（两者必须同速，见 RETURN_TO_ACTIVE_MS）；
 * 目前只有横屏大歌词的回位/跟随在用，别拿它去改小歌词。
 */
export const getReturnDuration = (distance: number) =>
  Math.min(Math.max(Math.abs(distance) * 0.5, 120), 300)
