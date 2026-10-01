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

/** 自动回位动画的时长：随距离线性增长并夹在 [120, 300] 内，远距离不会拖沓。 */
export const getReturnDuration = (distance: number) =>
  Math.min(Math.max(Math.abs(distance) * 0.5, 120), 300)
