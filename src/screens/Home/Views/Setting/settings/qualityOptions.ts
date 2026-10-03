import { TRY_QUALITYS_LIST } from '@/core/music/utils'

/**
 * 【第二十轮·图八】音质选项的唯一真源（播放设置 / 下载设置共用）。
 *
 * 用户原话：「下载设置中下载音质更新为播放设置中的内容，要统一」。
 * 此前两页各写一份：播放音质（PlayHighQuality）已按第 11/13 轮收敛为 6 项
 * （128K / 320K / Flac / 24bitFlac / Atmos / Master，隐藏 atmos_plus 与 hires，
 * hires 的存量值显示映射到 24bitFlac）；下载音质（DownloadQuality）却还是
 * `[...TRY_QUALITYS_LIST, '128k'].reverse()` 未过滤的 8 项、标题走 i18n 的
 * `t(q)`（如「母带」「杜比全景声」），于是同一个概念两页文案/档位数都不同。
 * 现在两页都从这里取列表与文案 —— 改一处 = 两页同时改，不会再漂移。
 *
 * 语义边界（与第 11/13 轮一致，勿在此处迁移枚举）：
 *  · 隐藏 ≠ 删除：'atmos_plus' / 'hires' 只从列表隐藏，存储值一律不改写，
 *    取流层（PLAY_LADDER / normalizeQuality）的位次也不动 —— 存量用户照常取流；
 *  · 'hires' 与 'flac24bit' 是同一条取流路径，存量选 'hires' 的由 ACTIVE_ALIAS
 *    在界面上显示为选中 24bitFlac，避免出现「一个都没选中」的空档。
 */

/** 展示文案（用户给定的固定串，不随语言切换；KEY 为 LX.Quality）。 */
export const QUALITY_LABELS: Record<string, string> = {
  '128k': '128K',
  '320k': '320K',
  flac: 'Flac',
  flac24bit: '24bitFlac',
  atmos: 'Atmos',
  master: 'Master',
}

/** 存量设置值的选中态归一（只做显示映射，不改写用户存储值）。 */
export const QUALITY_ACTIVE_ALIAS: Record<string, LX.Quality> = { hires: 'flac24bit' }

/** 界面上展示的音质列表（自高到低，6 项）：128K / 320K / Flac / 24bitFlac / Atmos / Master。 */
export const getVisibleQualityList = (): LX.Quality[] =>
  ([...TRY_QUALITYS_LIST, '128k'] as LX.Quality[])
    .filter(q => q !== 'atmos_plus' && q !== 'hires')
    .reverse()

/** 取某项的展示文案：命中固定表用固定表，未收录的（理论上没有）退回 i18n。 */
export const getQualityLabel = (q: LX.Quality, t: (k: string) => string): string =>
  QUALITY_LABELS[q] ?? t(q)
