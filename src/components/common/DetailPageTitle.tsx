import { memo, useCallback, useState, type ReactNode } from 'react'
import { View, useWindowDimensions, type LayoutChangeEvent } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { scaleSizeW, setSpText } from '@/utils/pixelRatio'
import { designSpacing, designTypography, pageTitleGap, pageTitleLineHeight, subPageTitleSize } from '@/theme/DesignTokens'
import Text from './Text'

/** 一行里「标题 + 切换按钮」合计最多**同时**显示的列数（用户第 18 轮第 1 条）。
 *
 *  需求原话：「…酷狗每日推荐标题与滑动条中的文字最多同时显示 4 个，比如 QQ 每日推荐、
 *  主页推荐、雷达推荐、推荐歌单这 4 个文字…」。即：这一行最多同时看到
 *  「标题 + 3 个 tab」；多出来的 tab 不压缩、不换行、不缩小列宽，**横向滑动**查看。 */
export const detailTitleMaxVisibleColumns = 4

/** 等分列模式下标题允许被压到的最小字号比例（相对 subPageTitleSize），仅 iOS 生效。
 *
 *  【第 20 轮·图二】后这只是一道**长文案兜底**：标题现在按自然宽度渲染（见组件注释四），
 *  现有文案（最长的「酷狗每日推荐 / 网易每日推荐」6 个全角字）在**最坏组合（320pt 屏 +
 *  最大字体 1.3×）**下也只占行宽的 ~0.574，够不到 titleMaxWidthFraction 那道上限，
 *  因而三页标题从来不缩字号 —— 这正是图二要的「三页标题字号完全一致」。
 *  将来出现更长的标题文案时，宁可略小也不裁字。 */
const titleMinFontScale = 0.5

/** 等分列模式下标题的最大宽度（占行内容区宽的比例）。【第 20 轮·图二】
 *
 *  标题按自然宽渲染后必须留一道上限，否则一条超长文案会把 tab 挤没。
 *  取 0.6 的依据：现有最长标题「酷狗每日推荐 / 网易每日推荐」（6 个全角字 = 6 × setSpText(20)）
 *  在**最大字体设置（1.3）+ 最窄现代屏（375pt）**下只有行宽的约 0.48（1.3×6×20 = 156pt
 *  vs 0.6×327 = 196pt）；即便再退到 320pt 老屏也只有 0.574（156 vs 163.2）—— 余量 4%。
 *  也就是说现有文案永远够不着这道上限（不缩字号），只有将来更长的标题才会在窄屏被它收住。 */
const titleMaxWidthFraction = 0.6

/** 【第 20 轮·图二 / 第 21 轮·图十~图十二】「tab 文字字形底部对齐」的下移系数（相对两类文字的字号差）。
 *
 *  第 20 轮取 0.76（= 3.8pt ÷ 字号差 5pt），来源是一张 2.36px/pt 的截图；用户第 21 轮
 *  图十~图十二复核「酷狗 / QQ / 网易每日推荐标题与右边 tab 文字还没完全底部对齐」——
 *  按本机截图重新量（1280×2781 = 440pt ⇒ 2.909px/pt）：带着 0.76 的 3.8pt 时 tab 字形底
 *  反而比标题字形底**低** 5.33px（= 1.83pt），即老系数过冲；正确落差 = 3.8 − 1.83 = 1.97pt
 *  ⇒ 系数 = 1.97 ÷ 5 ≈ 0.39。与「两个字号在行内垂直居中时字形底落差 ≈ 0.36 × 字号差」的
 *  度量关系一致（0.36 × 5 = 1.8pt），两路证据互相印证。
 *  用「系数 × 字号差」而不是写死 pt：两个字号都随「字体大小」设置等比缩放（setSpText），
 *  落差同样等比，字体设置变化时不需要第二个常数。
 *  iOS 各机型/字号档的字体度量会有零点几 pt 出入 —— 真机复核若仍有 1pt 级残差，只改这一个系数。 */
const tabInkBottomOffsetRatio = 0.39

interface Props {
  /** 标题文案：与共享页头同一个 i18n key（t(navId)） */
  title: string
  /**
   * 可选：与标题同行的右侧内容（三大平台歌单 / 每日推荐页的 tab 切换）。
   * 等分列模式下可传函数：`(columnWidth) => ReactNode`，拿到本行**实测**算出的 tab 列宽（pt），
   * 给每个 tab 设 `width: columnWidth` —— 各 tab 列等宽、列内文字水平居中，平分标题右侧的行宽。
   * 【第 20 轮·图二】起 columnWidth 是「标题自然宽之外的剩余宽度 ÷ tab 列数」，
   * 标题自己不再占等分列（见 Props.equalColumnsCount 与组件注释四）。
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
   * 传了它就走「等分列」的排布（与上面 equalColumns 的弹性等分是两回事，见 Props.children）：
   *   · 列数收敛到 min(equalColumnsCount, detailTitleMaxVisibleColumns)（tab 列数 = 列数 − 1）；
   *   · 标题按**自然宽度**渲染：不设固定列宽 ⇒ 字号恒为 subPageTitleSize，不随页面/档位变化
   *     （用户第 20 轮图二：「QQ每日推荐字体和其他酷狗每日推荐字体不一样」的根因就是旧版
   *     把标题塞进等分列后按列宽自动缩字号）；只保留 titleMaxWidthFraction 这道长文案上限；
   *   · tab 列 = （行宽 − 标题实测宽）后由各 tab 列**等宽平分**，列内文字水平居中，
   *     列宽下限见组件内的 minTabColumnWidth；
   *   · 两类文字**字形底部对齐**（图二：「主页推荐等文字和 QQ 每日推荐文字不在一条直线上」）。
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
 * 四、等分列模式（用户第 18 轮第 1 条提出、用户第 20 轮图二重做排布）：
 *   三个每日推荐页的「标题 + tab 行」由本组件统一排布。
 *   第 18 轮的排布是「整行等分成 min(列数, 4) 列，标题也占其中一列」；但标题列宽只有行宽的
 *   1/4（375pt 屏 ≈ 82pt），而「网易每日推荐」这类 6 字标题在 20pt 字号下要 120pt ——
 *   numberOfLines + adjustsFontSizeToFit 只能把字号缩到塞得进列宽为止。列宽又随「三页各自
 *   的列数（5 列 / 3 列）与 tab 档位」变化：三个页面里最长的 6 字标题在酷狗 / 网易页缩到 ~0.68，
 *   而 QQ 页 5 字出头的「QQ每日推荐」缩到 ~0.79 —— 于是有了用户图二
 *   「QQ每日推荐字体和其他酷狗每日推荐字体不一样」。
 *   第 20 轮改成「标题自然宽 + tab 列等分剩余宽」：
 *     · 标题按**自然宽度**渲染（不设固定 width ⇒ 字号恒为 subPageTitleSize、三页完全一致），
 *       只保留 titleMaxWidthFraction 这道长文案安全上限；
 *     · tab 列宽 = （行内容区实测宽 − 标题实测宽）÷ tab 列数，各列等宽（列内文字水平居中），
 *       下限 minTabColumnWidth 保证 4 字 tab 不被逼到缩字号（宁可行内横向滑动，同 >4 列口径）；
 *     · **底部对齐**（图二：「主页推荐等文字和 QQ 每日推荐文字不在一条直线上」）：标题字号大、
 *       tab 字号小，两个行盒在同一行内垂直居中时，大字号的字形底天然更低（本机复测 1.97pt，
 *       第 21 轮图十~图十二修正，见 tabInkBottomOffsetRatio）——把 tab 整行（含下划线、
 *       子模式 chip）下移同一距离，两类文字字形底就落在同一条线上。
 *       下移的是 tab 而不是上移标题：标题保持与「我的 / WebDAV」等非等分列页面同一高度，
 *       十一个页面的大标题才在同一水平线上；transform 不改布局，行高仍由标题行盒决定。
 *   调用方接口不变：children 仍是 `(columnWidth) => ReactNode`，语义是「每个 tab 列的宽度」。
 */
const DetailPageTitle = memo(({ title, children, equalColumns = false, equalColumnsCount = 0 }: Props) => {
  const theme = useTheme()
  const { width: windowWidth } = useWindowDimensions()
  // 行内容区实测宽（onLayout 挂在没有内边距的 inner 上，量到的就是列宽的分母）。
  // 首帧还没量到时先用窗口宽估算：内边距按 createStyle 的 scaleSizeW(lg) 同口径扣掉，
  // 手机（24）/ 平板（28）/ 字体大小设置下都可能差几 pt，量到后以实测值为准 ——
  // 这样列宽与真实行宽严格对齐（标题 + 各 tab 列正好铺满，留不出缝、也不会溢出）。
  // 同值不 setState：布局抖动不会引出额外渲染。
  const [rowWidth, setRowWidth] = useState(0)
  const handleInnerLayout = useCallback((e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout.width
    setRowWidth((prev) => (Math.abs(prev - next) > 0.5 ? next : prev))
  }, [])

  // 【第 20 轮·图二】标题自然宽实测（onLayout 挂在标题 Text 上）：tab 列宽 = 行宽 − 标题宽，
  // 所以必须知道标题实际占了多少。同值不 setState，抖动不引出额外渲染。
  // 还没量到的首帧：tab 列宽退化为旧口径（整行等分），量到后立即修正 —— 只差一帧。
  const [titleWidth, setTitleWidth] = useState(0)
  const handleTitleLayout = useCallback((e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout.width
    setTitleWidth((prev) => (Math.abs(prev - next) > 0.5 ? next : prev))
  }, [])

  const columnCount = equalColumnsCount > 0 ? Math.min(equalColumnsCount, detailTitleMaxVisibleColumns) : 0
  const availableWidth = rowWidth > 0 ? rowWidth : windowWidth - scaleSizeW(designSpacing.lg) * 2
  const isColumn = columnCount > 0 && availableWidth > 0
  // 列数含标题列，tab 列数 = 列数 − 1（至少 1，避免除零；当前最小列数是酷狗每日推荐页的 3）
  const tabCount = Math.max(columnCount - 1, 1)
  // tab 列宽下限（【第 20 轮·图二】）：tab 文案统一是 4 个全角字，下限就取「4 字文案的宽」
  // ——这是「tab 不被逼到缩字号」的物理最小值（文字宽度随字体设置等比，下限同样等比）。
  // 列间距不靠加常量：默认字体设置下剩余宽足够，列宽由「平分剩余宽」给出（自然留有间隙）；
  // 下限只在「大字体 / 窄屏」生效，那时这一行本来就靠横向滑动查看（列宽顶着 4 字文案，与旧版
  // 被压在同一列宽里的观感一致）——比「让 tab 缩字号、各页缩得不一样」更贴合图二的要求。
  // 注意必须行内算：setSpText/scaleSizeW 都乘 global.lx.fontSize，写进模块级常量会被冻结在
  // 模块加载时的字体设置上（createStyle 的静态样式同理，这也是本组件字号相关的值都走行内的原因）。
  const minTabColumnWidth = setSpText(designTypography.body) * 4
  const tabColumnWidth = !isColumn
    ? 0
    : titleWidth > 0
      // 标题实测宽已知：tab 列平分剩余行宽；剩余宽在「最大字体设置 + 窄屏」下可能不够 4 字 tab ——
      // 与其让 tab 缩字号（各页缩得不一样，又是一次「字体不一样」），不如让这一行横向滑动
      // （与 >4 列时的既有行为一致，用户第 18 轮第 1 条已认可）。
      ? Math.max((availableWidth - titleWidth) / tabCount, minTabColumnWidth)
      // 首帧兜底：旧口径（整行等分），下一帧就被实测值替换，不会闪。
      : availableWidth / columnCount
  // 【第 20 轮·图二 / 第 21 轮·图十~图十二】tab 文字的下移量（字形底部对齐）：两类文字都在
  // 行内垂直居中，字号大的字形底天然更低，落差 ≈ 系数 × 字号差（本机复测 1.97pt @ 字体设置
  // 1.0；第 20 轮的 3.8pt 过冲 1.83pt，见上方系数注释）。随字体设置等比。
  const tabInkBottomOffset = isColumn
    ? tabInkBottomOffsetRatio * (setSpText(subPageTitleSize) - setSpText(designTypography.body))
    : 0

  return (
    <View style={styles.row}>
      <View style={styles.inner} onLayout={columnCount > 0 ? handleInnerLayout : undefined}>
        <Text
          style={[
            styles.title,
            // 等分列模式（第 20 轮·图二）：标题按自然宽渲染，只留长文案上限 —— 不再居中于等分列
            // （旧版的 {width: columnWidth, textAlign: 'center'} 已删除：正是它逼得标题缩字号）。
            // 其它模式原样：equalColumns 走 flex:1。
            isColumn ? { maxWidth: availableWidth * titleMaxWidthFraction } : equalColumns ? styles.titleEqual : null,
          ]}
          onLayout={isColumn ? handleTitleLayout : undefined}
          // 等分列模式：单行；只有标题长到超过上面那道上限才会缩字号（现有文案都够不着），
          // 宁可略小也不裁字、不换行（换行会撑破行高、破坏「同一高度」）。其它模式不传（原行为）。
          numberOfLines={isColumn ? 1 : undefined}
          adjustsFontSizeToFit={isColumn ? true : undefined}
          minimumFontScale={isColumn ? titleMinFontScale : undefined}
          size={subPageTitleSize}
          color={theme['c-font']}
        >
          {title}
        </Text>
        {typeof children === 'function'
          ? isColumn
            // 整个 tab 行连同包装层一起下移（底部对齐）；包装层 flex:1 吃掉标题右侧的剩余宽度
            // （原来是 tab 的 ScrollView 直接作行子级，多这一层只为挂 transform ——
            // transform 不改布局，行高仍由标题行盒决定，下一块内容不会跟着动）。
            ? (
              <View style={[styles.tabColumnWrap, { transform: [{ translateY: tabInkBottomOffset }] }]}>
                {children(tabColumnWidth)}
              </View>
            )
            : children(tabColumnWidth)
          : children}
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
  // 行内容区（无内边距）：标题 + children 都挂在这一层里，等分列模式量它的宽度。
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
  // 等分列模式的 tab 行包装层（【第 20 轮·图二】）：flex:1 吃掉标题右侧剩余宽度；
  // 整层挂 translateY（底部对齐），transform 不参与布局 —— 行高仍由标题的 42pt 行盒决定。
  tabColumnWrap: {
    flex: 1,
  },
  // 说明：旧版的 titleColumn（{ textAlign: 'center' }，配行内的 { width: columnWidth }）在第 20 轮
  // 图二里删除 —— 标题被限制在等分列宽内会自动缩字号，是三页标题字号不一致的根因。
})
