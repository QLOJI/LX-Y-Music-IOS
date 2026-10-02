import type { BadgeType } from '@/components/common/Badge'

/**
 * 音质小标（列表行 / 播放详情页上的 Master、Atmos、SQ… 徽章）的唯一映射表。
 *
 * 背景（2026-10-02 需求）：此前三个展示位各写一份天梯，档位、文案、徽章色三处互不一致 ——
 *   · components/OnlineList/ListItem.tsx         master → secondary（hires 标成 Hi-Res）
 *   · 首页「我的」MusicList/ListItem.tsx          同上，另有一档 192k → '192k'（小写 k 的野串）
 *   · PlayDetail/components/SourceQualityBadge   master → vip，128k / 未知档另有两个分支
 * 需求原文：「统一音质小标为 Master、Atmos、24bit、SQ、HQ、128K；没有小标的统一改为 128K」。
 * 于是把天梯收敛到这里，三个展示位只做「取数据 → t(key)」，不再各留一份。
 *
 * 六档与旧档位的归并关系：
 *   master                     → Master（vip 红）
 *   atmos_plus / atmos         → Atmos （原 atmos_plus 的 'Atmos2.0' 不再单列）
 *   hires / flac24bit          → 24bit （原 hires 的 'Hi-Res' 不再单列）
 *   flac                       → SQ
 *   320k / 192k                → HQ    （192k 的归并理由见下）
 *   128k / 取不到 / 其它未知档  → 128K  （兜底；以前这一档什么标都不显示）
 *
 * 192k 为什么归 HQ 而不是 128K：六档里没有它的位置，而本仓自己的音质天梯
 * （utils/musicSdk/utils.js 的 QUALITYS、core/music/utils.ts 的 QUALITY_RANK）都把它排在
 * 320k 与 128k 之间。归到 HQ（压缩档中最高的一档）比归到 128K（最低档）更贴近事实 ——
 * 低标会让用户以为拿到的是最低档。实际产出 192k 标注的只有 bilibili 等个别源。
 *
 * showHighest（设置项 common.quality_show_highest「音质显示最高支持」，默认关）只决定
 * Master / Atmos 两档参不参与：关掉时哪怕曲目标注里有 master 也不显示 —— 该开关的口径就是
 * 「不显示平台标称支持的最高档」。注意 wy/tx 的 master/atmos 标注本来就是这个开关打开时
 * 才去拉取的（core/search/music.ts 的 supplementQuality），关掉时这两档多数时候没有数据。
 * 两档被开关屏蔽、其余档也都没有时落到 128K —— 需求要的正是「没有小标的统一改为 128K」。
 */

export interface QualityBadgeInfo {
  /** i18n key，调用方用 t(key) 取文案（含既有的 '128k' → '128K'，见 src/lang/zh-cn.json） */
  key: string
  /** 徽章配色，取值同 components/common/Badge 的 BadgeType */
  type: BadgeType
}

const BADGE_MASTER: QualityBadgeInfo = { key: 'quality_lossless_master', type: 'vip' }
const BADGE_ATMOS: QualityBadgeInfo = { key: 'quality_lossless_atmos', type: 'secondary' }
const BADGE_24BIT: QualityBadgeInfo = { key: 'quality_lossless_24bit', type: 'secondary' }
const BADGE_SQ: QualityBadgeInfo = { key: 'quality_lossless', type: 'sq' }
const BADGE_HQ: QualityBadgeInfo = { key: 'quality_high_quality', type: 'hq' }

/** 取不到标注 / 未知档的统一兜底：128K */
export const QUALITY_BADGE_FALLBACK: QualityBadgeInfo = { key: '128k', type: 'tertiary' }

// 形参取 unknown：调用方传进来的可能是 meta._qualitys（各源类型不一、可为 undefined），
// 这里只判「键在不在」，不做类型体操，避免为了类型可赋值性在调用点到处写 as。
const hasKey = (map: Record<string, unknown> | null, key: string): boolean => !!(map && map[key])

/**
 * 由曲目标注的音质集合取小标（在线列表行用）。
 * @param qualitys 曲目 meta._qualitys（可能为空对象 / undefined —— 表示源未返回标注）
 * @param showHighest 设置项 common.quality_show_highest
 */
export const getQualityBadge = (qualitys: unknown, showHighest: boolean): QualityBadgeInfo => {
  const map = (qualitys ?? null) as Record<string, unknown> | null
  if (showHighest && hasKey(map, 'master')) return BADGE_MASTER
  if (showHighest && (hasKey(map, 'atmos_plus') || hasKey(map, 'atmos'))) return BADGE_ATMOS
  // flac32bit 一并归 24bit：它在入库时会被规范化成 hires（utils/index.ts），
  // 但存量数据里仍可能残留，不能让它掉到 128K 兜底去
  if (hasKey(map, 'hires') || hasKey(map, 'flac24bit') || hasKey(map, 'flac32bit')) return BADGE_24BIT
  if (hasKey(map, 'flac')) return BADGE_SQ
  if (hasKey(map, '320k') || hasKey(map, '192k')) return BADGE_HQ
  return QUALITY_BADGE_FALLBACK
}

/**
 * 由单个「实际达成档」取小标（播放详情页用：playerState.quality 是这一次真正解析到的档）。
 * 复用同一条天梯：把单档包成集合后按 showHighest=true 取 —— 详情页展示的是事实档，
 * 不受「音质显示最高支持」开关影响（那个开关管「平台标称支持什么」，不管「现在播的是什么」）。
 */
export const getQualityBadgeByTier = (quality: string | null | undefined): QualityBadgeInfo => {
  if (!quality) return QUALITY_BADGE_FALLBACK
  return getQualityBadge({ [quality]: true }, true)
}
