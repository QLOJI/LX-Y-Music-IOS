import { memo, type ReactNode } from 'react'
import { View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designSpacing, pageTitleGap, pageTitleLineHeight, subPageTitleSize } from '@/theme/DesignTokens'
import Text from './Text'

interface Props {
  /** 标题文案：与共享页头同一个 i18n key（t(navId)） */
  title: string
  /** 可选：与标题同行的右侧内容（三大平台歌单页的两个 tab 切换） */
  children?: ReactNode
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
 *      竖线上，行高也一致（左右滑动切页时标题不跳）。
 *
 * 三、字号取 subPageTitleSize（= WebDAV 页标题 / 共享页头的字号，20），**不是**「我的」的
 *   34：这是需求里点名的参照物。想改成同级大标题只改 DesignTokens 里那一行。
 */
const DetailPageTitle = memo(({ title, children }: Props) => {
  const theme = useTheme()
  return (
    <View style={styles.row}>
      <Text style={styles.title} size={subPageTitleSize} color={theme['c-font']}>
        {title}
      </Text>
      {children}
    </View>
  )
})

DetailPageTitle.displayName = 'CommonDetailPageTitle'

export default DetailPageTitle

const styles = createStyle({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // 与「我的」标题同一个左边距 / 下间距，见上方注释二
    paddingHorizontal: designSpacing.lg,
    marginBottom: pageTitleGap,
  },
  title: {
    fontWeight: '800',
    // 与「我的」标题同一行高：标题行高度一致，下方第一行内容不会上下跳
    lineHeight: pageTitleLineHeight,
  },
})
