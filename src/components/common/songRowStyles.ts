/**
 * 歌曲列表行的**统一样式源**（用户第 24 轮追加）。
 *
 * 用户原话（2026-10-03 第 24 轮）：
 *   「又发现一个问题：1、如图，网易列表和QQ列表的歌曲字体粗细不一致，都统一为网易字体。」
 *   「如图，列表中右边的歌曲时间，爱心，三个点的位置都不统一，请把列表栏所有样式都统一下」
 *
 * 此前三处歌曲行各写各的，同一首歌在不同列表里长得不一样：
 *
 *                        OnlineList/ListItem   Mylist/MusicList/ListItem   WebDAV 歌曲行
 *   行标题字重            '600'（粗）           不覆盖（细 = 目标口径）      '600'（粗）
 *   行标题字号            body(15)              不传 size（默认 15）        body(15)
 *   封面盒宽              70                    70                          74
 *   序号字号 / 字重       14 / 700              12 / 不覆盖                 无序号
 *   副标题（歌手·专辑）   12 / 300              11 / 300                    13 / 400
 *   副标题行              paddingTop 2 + 居中   paddingTop 3（不居中）      paddingTop 3（不居中）
 *   时长                  12，无固定宽度        11，无固定宽度              无
 *   爱心按钮              40×40 + 左右 margin   height:'80%' + padding 8   无
 *   ⋮ 按钮                40×40 + 右 margin      height:'80%' + padL10/R8     height:'80%' + pad 12
 *   ⋮ 图标                17                    12                          17
 *
 * 于是「时间 / 爱心 / 三个点」在不同列表落在不同的 x 上（时长还会随数字宽度自己飘），
 * 行标题时粗时细 —— 用户看到的就是这个。
 *
 * 本模块是这三处的唯一来源：要改行内几何 / 字重 / 字号，只改这里，
 * **不要**再回行组件里写第二份（契约脚本 scripts/sim-song-row-style-unify.js 会钉住这点）。
 *
 * 字重口径（用户点名的「统一为网易字体」）：行标题**不覆盖字重**，'400' = 系统常规，
 * 即「我的列表 / 网易那侧」的细体观感；此前的 '600' 是粗的那一侧。
 * 要反过来统一成粗体只需改 songName 这一个值。
 *
 * 会话/音频策略不在这里：见 plugins/player/service.ts 与 ios/LxMusicMobile/AppDelegate.mm。
 */
import { createStyle } from '@/utils/tools'
import { designSpacing, designTypography } from '@/theme/DesignTokens'

/** 行内几何 / 字号裸值。JSX 里（Icon size、Text size）也取这里，避免同一行两种口径。 */
export const songRowMetrics = {
  /** 封面盒宽（内容 54 居中）：盒宽 70 时封面距行左缘 16（行内边距）+ 8 ≈ 24，与页头对齐 */
  coverBoxWidth: 70,
  /** 序号盒宽（关闭封面时用）：两处歌曲行历史值一致，保持 */
  indexBoxWidth: 40,
  coverSize: 54,
  /** 爱心 / ⋮ 的固定热区边长：40（行高 70 下仍可点，三处原先唯一自洽的值） */
  iconButtonSize: 40,
  /** 爱心 / ⋮ 图标本体边长 */
  iconSize: 17,
  /** 副标题（歌手·专辑）与时长（时间）的统一字号 */
  metaTextSize: 12,
  /** 序号字号 */
  indexTextSize: 14,
  /** 时长列最小宽度：右对齐后所有行的「03:48」落在同一条竖线上（更长的 1:02:33 只向左扩） */
  intervalMinWidth: 44,
} as const

export const songRowStyles = createStyle({
  listItem: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    // 左右各留 16pt：封面盒（宽 70、内容居中）叠加后封面落在距屏幕边缘 24pt，与页头对齐；
    // 右侧 ⋮ 按钮（marginRight xs=8）的图标中心同样收在 24pt+（40/2）。列表不再贴边。
    paddingLeft: designSpacing.md,
    paddingRight: designSpacing.md,
    alignItems: 'center',
  },
  listItemLeft: {
    flex: 1,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  sn: {
    width: songRowMetrics.coverBoxWidth,
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: designSpacing.sm,
    paddingRight: designSpacing.sm,
  },
  snIndex: {
    width: songRowMetrics.indexBoxWidth,
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 5,
    paddingRight: 5,
  },
  albumArt: {
    width: songRowMetrics.coverSize,
    height: songRowMetrics.coverSize,
  },
  itemInfo: {
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: designSpacing.xs,
    paddingRight: designSpacing.xs,
  },
  // 行标题：不覆盖字号（调用方传 size = designTypography.body）+ 明确常规字重。
  // 三处列表统一走这里 = 「都统一为网易字体（细）」。
  songName: {
    fontWeight: '400',
  },
  indexText: {
    fontWeight: '700',
  },
  // 副标题行（音源 / 音质 / VIP 徽标 + 歌手·专辑）：必须显式居中，否则徽标与文字
  // 各自按自身的行框基线落位，行高不同的徽标会把这一行撑出高矮差。
  listItemSingle: {
    paddingTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  listItemSingleText: {
    flexGrow: 0,
    flexShrink: 1,
    fontWeight: '300',
  },
  // 时长：固定最小宽度 + 右对齐 ⇒ 行与行、列表与列表之间「时间」都在同一条竖线上
  interval: {
    minWidth: songRowMetrics.intervalMinWidth,
    textAlign: 'right',
    marginRight: designSpacing.xs,
    fontWeight: '400',
  },
  /** 图标按钮（爱心 / ⋮）的公共几何：固定 40×40、圆形、内容居中 */
  iconButton: {
    width: songRowMetrics.iconButtonSize,
    height: songRowMetrics.iconButtonSize,
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  likeButton: {
    width: songRowMetrics.iconButtonSize,
    height: songRowMetrics.iconButtonSize,
    marginHorizontal: designSpacing.xs,
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  moreButton: {
    width: songRowMetrics.iconButtonSize,
    height: songRowMetrics.iconButtonSize,
    marginRight: designSpacing.xs,
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
  },
})
