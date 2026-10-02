import { memo, useCallback, useState, type ReactNode } from 'react'
import { View, useWindowDimensions, type LayoutChangeEvent } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { designSpacing, pageTitleGap, pageTitleLineHeight, subPageTitleSize } from '@/theme/DesignTokens'
import Text from './Text'

/** 一行里「标题 + 切换按钮」合计最多**同时**显示的列数（用户第 18 轮第 1 条）。
 *
 *  需求原话：「…酷狗每日推荐标题与滑动条中的文字最多同时显示 4 个，比如 QQ 每日推荐、
 *  主页推荐、雷达推荐、推荐歌单这 4 个文字…」。即：这一行整行等分成
 *  min(项目数, 本值) 列 —— 项目数 ≤ 4 时全部同时可见、每列等宽、平分整行；项目数 > 4 时
 *  每列仍按 1/4 行宽排布，多出来的部分不压缩、不换行、不缩小列宽，**横向滑动**查看。 */
export const detailTitleMaxVisibleColumns = 4

/** 等分列模式下标题允许被压到的最小字号比例（相对 subPageTitleSize），仅 iOS 生效。
 *
 *  「QQ每日推荐」这类 6 字标题在 4 等分里放不下（20pt 字号时 6 个全角字 = 120pt，
 *  而 4 等分在 Pro Max(430) 上是 95.5pt、在 375pt 屏上只有 81.75pt）：开了 numberOfLines +
 *  adjustsFontSizeToFit 后系统会把字号缩下来让它整行显示，而不是裁字（用户第 14 轮第 1 条
 *  「标题显示不全」）或换行（会撑破行高、破坏「同一高度」）。
 *  下限取 0.5：最坏一档「375pt 屏 + 字体大小设置 1.3（非常大）」（1.3×120 = 156pt ÷ 81.75pt
 *  = 0.52）也还在下限之上 —— 宁可略小也不裁字。只有 iPhone SE1 那档 320pt 屏会触底截断
 *  （0.44 < 0.5），已随第 18 轮清单披露。下限只影响「放不下」时缩到哪里，默认档（1.0）下
 *  三页标题实际都缩在 0.68~0.80 之间，观感一致。 */
const titleMinFontScale = 0.5

interface Props {
  /** 标题文案：与共享页头同一个 i18n key（t(navId)） */
  title: string
  /**
   * 可选：与标题同行的右侧内容（三大平台歌单 / 每日推荐页的 tab 切换）。
   * 等分列模式下可传函数：`(columnWidth) => ReactNode`，拿到本行**实测**算出的列宽（pt），
   * 给每个 tab 设 `width: columnWidth` —— 标题列与每个 tab 列因此严格同宽（间距相等、
   * 平分整行），而不是标题按内容宽 + tab 各自按内容宽。
   */
  children?: ReactNode | ((columnWidth: number) => ReactNode)
  /**
   * 等分模式（用户第 16 轮第 2 条）：标题与 children 各占行宽的等份。
   * 选中后标题 flex:1 + 两侧内边距仍为 designSpacing.lg，调用方把 children 容器设成
   * 「份数 − 1」份（如两个 tab → flex:2、每个 tab flex:1），全行即被等分成 N 份：
   * 「酷狗歌单 / 自建歌单 / 收藏歌单」各占 1/3，且都在同一行、同一垂直中线上。
   * 默认 false：标题按内容宽度、children 靠右（其它页面的原行为）。
   */
  equalColumns?: boolean
  /**
   * 等分列数（**含标题列**）—— 用户第 18 轮第 1 条口径，每日推荐三页用。
   * 传了它就走「显式列宽」的等分（与上面 equalColumns 的弹性等分是两回事，见 Props.children）：
   *   · 列数收敛到 min(equalColumnsCount, detailTitleMaxVisibleColumns)；
   *   · 列宽 = 行内容区实测宽 / 列数，标题占第一列、文字水平居中；
   *   · 标题单行显示，放不下自动缩小字号（不裁字、不换行），保证整行「同一高度」；
   *   · 调用方拿到同一个列宽的每个 tab 列同样居中 —— 全行文字同一垂直中线。
   * 默认 0：不启用（其它页面原行为）。
   */
  equalColumnsCount?: number
}

/**
 * Home 二级列表页（「我的」页里的功能入口，即 LOVE_SUBPAGE_IDS 那七个页面）的页面标题行。
 *
 * 用户第 14 轮第 1 条：「勾选上我的页列表显示，网易歌单、酷狗歌单、QQ歌单、网易关注歌手、
 * 网易收藏专辑页面的顶部标题显示不全，修改位置应该和"我的"标题位置一样，所有列表中的标题
 * 都显示在这个位置，字体大小参考 WebDAV 界面上标题字体大小，网易关注歌手、网易收藏专辑、
 * WebDAV、本地与下载标题字体位置都按我的标题位置固定且显示完全。」
 *
 * 一、为什么「显示不全」：这批页面此前把行高写死在裸 StyleSheet.create 里
 *   （`lineHeight: pageTitleLineHeight`，42 不缩放），而字号是 Text 组件的 `size` 属性，
 *   会随「字体大小」设置乘 global.lx.fontSize。字体调大后 34pt 实际字形比 42pt 行框还高，
 *   上下笔画被行框裁掉 —— 字体越大裁得越多。对比「我的」页标题（NewListUI）用的是
 *   createStyle，fontSize 与 lineHeight 按同一比例缩放，所以它永远不裁。
 *   本组件走 createStyle + token，两个值同源，任何字体大小下都不会互斥。
 *
 * 二、位置与「我的」标题同源（逐项对齐 NewListUI.pageHeader / pageTitle）：
 *   —— 竖排位置由调用方紧跟 PageTopInset 渲染（与「我的」的 listHeader 结构一致）；
 *   —— paddingHorizontal: designSpacing.lg（24）、marginBottom: pageTitleGap（16）、
 *      lineHeight: pageTitleLineHeight（42）、fontWeight '800'，左侧与「我的」标题同在一条
 *      竖线上，行高也一致（左右滑动切页时标题不跳）；
 *   —— paddingTop: designSpacing.sm（12，【第 19 轮第 2 条】）：PageTopInset 之上再垫 12。
 *      用户原话：「网易歌单、酷狗歌单、QQ歌单、网易关注歌手、网页收藏专辑、WebDAV、本地与
 *      下载」这七个「我的」二级页面的标题栏到顶部距离太小，要和推荐页「显示高度位置和推荐
 *      文字到顶部之间间距一样」。此前这三页之外的七个页面里没垫这一下（只有三个每日推荐页
 *      在自己的 headerExtraTop 里垫），同样是本组件的页面，标题离顶部就差了 12pt。
 *      现在写进共享组件的 row：十个页面一条来源，调用方只管「紧跟 PageTopInset 渲染」，
 *      到顶间距不许各写各的（换了别的页面用本组件也一样对齐）。
 *
 * 三、字号取 subPageTitleSize（= WebDAV 页标题 / 共享页头的字号，20），**不是**「我的」的
 *   34：这是需求里点名的参照物。想改成同级大标题只改 DesignTokens 里那一行。
 *
 * 四、等分列模式（用户第 18 轮第 1 条，见 Props.equalColumnsCount）：
 *   三个每日推荐页的「标题 + tab 行」此前是「标题按内容宽、tab 各自按内容宽」拼在一行 ——
 *   文字块疏密不均，网易页四个按钮在 Pro Max 上还会换行（flexWrap）撑破「同一高度」。
 *   现在整行按列宽严格等分：列宽由本组件测量行内容区后下发（渲染回调），标题列与 tab 列
 *   同宽同中线；超过 4 列时横向滑动（列宽不缩）。
 */
const DetailPageTitle = memo(({ title, children, equalColumns = false, equalColumnsCount = 0 }: Props) => {
  const theme = useTheme()
  const { width: windowWidth } = useWindowDimensions()
  // 行内容区实测宽（onLayout 挂在没有内边距的 inner 上，量到的就是列宽的分母）。
  // 首帧还没量到时先用窗口宽估算：内边距按 createStyle 的 scaleSizeW(lg) 同口径扣掉，
  // 手机（24）/ 平板（28）/ 字体大小设置下都可能差几 pt，量到后以实测值为准 ——
  // 这样列宽与真实行宽严格对齐（标题列 + 各 tab 列正好铺满，留不出缝、也不会溢出）。
  // 同值不 setState：布局抖动不会引出额外渲染。
  const [rowWidth, setRowWidth] = useState(0)
  const handleInnerLayout = useCallback((e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout.width
    setRowWidth((prev) => (Math.abs(prev - next) > 0.5 ? next : prev))
  }, [])

  const columnCount = equalColumnsCount > 0 ? Math.min(equalColumnsCount, detailTitleMaxVisibleColumns) : 0
  const availableWidth = rowWidth > 0 ? rowWidth : windowWidth - scaleSizeW(designSpacing.lg) * 2
  const columnWidth = columnCount > 0 && availableWidth > 0 ? availableWidth / columnCount : 0
  const isColumn = columnWidth > 0

  return (
    <View style={styles.row}>
      <View style={styles.inner} onLayout={columnCount > 0 ? handleInnerLayout : undefined}>
        <Text
          style={[
            styles.title,
            isColumn ? styles.titleColumn : null,
            isColumn ? { width: columnWidth } : equalColumns ? styles.titleEqual : null,
          ]}
          // 等分列模式：单行 + 自动缩字号（不裁字、不换行），保证整行高度恒为
          // pageTitleLineHeight，三个每日推荐页的文字都在同一高度。其它模式不传（原行为）。
          numberOfLines={isColumn ? 1 : undefined}
          adjustsFontSizeToFit={isColumn ? true : undefined}
          minimumFontScale={isColumn ? titleMinFontScale : undefined}
          size={subPageTitleSize}
          color={theme['c-font']}
        >
          {title}
        </Text>
        {typeof children === 'function' ? children(columnWidth) : children}
      </View>
    </View>
  )
})

DetailPageTitle.displayName = 'CommonDetailPageTitle'

export default DetailPageTitle

const styles = createStyle({
  row: {
    // 与「我的」标题同一个左边距 / 下间距，见上方注释二
    paddingHorizontal: designSpacing.lg,
    marginBottom: pageTitleGap,
    // 到顶额外间距的唯一来源（第 19 轮第 2 条，见上方注释二）：PageTopInset 之后再垫 sm(12)。
    // 原先写在三个每日推荐页各自的 headerExtraTop 里，七个「我的」二级列表页没有 ⇒ 标题
    // 离顶部比推荐页近 12pt。现在十页共用这一个值，几何与推荐页完全一致。
    paddingTop: designSpacing.sm,
  },
  // 行内容区（无内边距）：标题列 + children 列都挂在这一层里，等分列模式量它的宽度。
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontWeight: '800',
    // 与「我的」标题同一行高：标题行高度一致，下方第一行内容不会上下跳
    lineHeight: pageTitleLineHeight,
  },
  // 等分模式（用户第 16 轮第 2 条）：标题占满自己的那一份，文字仍左对齐（与全站页面标题
  // 同一竖线），行内其余空间由 children 按份数瓜分见 Props.equalColumns。
  titleEqual: {
    flex: 1,
  },
  // 等分列模式（用户第 18 轮第 1 条）：标题宽 = 列宽（行内给），文字在列内水平居中 ——
  // 各文字块的中心等距，间距相等且平分整个宽度。
  titleColumn: {
    textAlign: 'center',
  },
})
