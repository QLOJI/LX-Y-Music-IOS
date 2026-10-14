import { memo, useCallback, useMemo, useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'
import { createStyle } from '@/utils/tools'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { designRadius, designSpacing } from '@/theme/DesignTokens'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import commonState from '@/store/common/state'
import { COMPONENT_IDS } from '@/config/constant'
import { navigations } from '@/navigation'
import { SETTING_SCREENS, type SettingScreenIds } from '../Main'
import { useListBottomClearance, useListBottomClearanceFloor, resolveListBottomClearance } from '@/utils/tabBarCollapse'
import Text from '@/components/common/Text'
import PageHeader from '@/components/common/PageHeader'
import { Icon } from '@/components/common/Icon'
import LandscapeCentered from '@/components/LandscapeCentered'

export default memo(() => {
  const theme = useTheme()
  const t = useI18n()
  // 列表末尾的避让：上限（展开态顶边 + 缝）/ 下限（收起态顶边 + 缝），再按实测内容高收口
  // （第 77 轮第 1 条，见 resolveListBottomClearance 的说明）
  const clearanceMax = useListBottomClearance()
  const clearanceFloor = useListBottomClearanceFloor()
  const [scrollMetrics, setScrollMetrics] = useState({ viewport: 0, rows: 0 })
  const listClearance = useMemo(
    () => resolveListBottomClearance(clearanceMax, clearanceFloor, scrollMetrics.viewport, scrollMetrics.rows),
    [clearanceMax, clearanceFloor, scrollMetrics],
  )
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  // 「按钮圆角」：分类按钮行内覆盖；高度取 styles.categoryItem.minHeight 的源值 56
  const buttonRadius = useButtonRadius()

  const handlePress = useCallback((id: SettingScreenIds) => {
    const homeComponentId = commonState.componentIds.find(({ name }) => name === COMPONENT_IDS.home)?.id
    if (homeComponentId) navigations.pushSettingDetailScreen(homeComponentId, id)
  }, [])

  // ⚠️ 这里只放纵向内边距，**不要**再把水平内边距加回来：
  // PageHeader 自身带着 lg(24) 的水平内边距（与推荐页 Discovery 的 header 同值），
  // 若在 ScrollView 的外层再加一层水平内边距，大标题「设置」会被额外右推，
  // 而推荐页的「推荐」仍在 lg(24) 处 —— 两者相差正好是外层那层内边距
  // （历史上这里是 xl(32)，表现为「设置」比「推荐」右缩进 32pt，左右切 Tab 时标题横向跳一下）。
  const contentContainer = useMemo(() => ({
    // 底部留白 = useListBottomClearance()（播放器**展开态**顶边 + 一道呼吸缝，2026-10-14 第 74 轮）。
    //
    // 第 73 轮这里改成了 useAboveMiniPlayerBottom()（跟 Tab 栏收起态走），本意是「收起态下
    // 悬浮层只到 safeAreaBottom + 底缝 4 + 胶囊高 ≈ 54，可以少留 120pt 空白」。但本页是
    // Home 的一个 tab 页（不是压栈页，useHomeCovered 恒 false ⇒ isHome 恒 true），**它自己的
    // 滚动就驱动 Tab 栏收起**：收起态一变，这里的留白从 168 掉到 92 → contentSize 当场缩小 →
    // iOS 把 contentOffset 夹回新的最大值 → 夹回来的位置落回展开门限以内 → 原生状态机又判
    // 展开 → 留白涨回 168 …… 用户报的「向下滑到底部，反复在底部碰撞跳动」就是这个环；
    // 同一根因还让每次 fling 收尾提前撞墙（内容长度半途变小），表现成滚动时的抖动。
    // 现在取「不随滚动改变」的常量：展开态顶边 + designSpacing.sm 呼吸缝（用户第 74 轮
    //「设置距离小了点」→ 在实测顶边之外再给一道缝，比第 73 轮的 168 多 12pt）。
    // 代价见 useListBottomClearance 的注释：收起态下末尾会多出 tab 栏那一层空白。
    paddingBottom: listClearance,
  }), [listClearance])

  // 分类列表与本页大标题无关，它的水平内边距单独挂在列表容器上：
  // 与设置详情页（SettingDetail/index.tsx）保持一致，用 xl(32)。
  // 用内联常量而非 createStyle，是为了保持 32 这个原始值不被 scaleSizeW 再放大一次
  // （createStyle 会把 padding/margin 过一遍 scaleSizeW），避免列表行位置发生变化。
  const listStyle = useMemo(() => ({ paddingHorizontal: designSpacing.xl }), [])

  // 分类入口统一走「推荐页排行榜按钮」那套视觉语言：圆角 + 1px 边框 + 半透明主题色底。
  // 底色与边框随「按钮透明度」淡出；文字色与右侧 chevron 图标不动。
  // 只改颜色的 alpha，不能用容器 style.opacity——那会把按钮文字一起变淡，
  // 0 时的目标是「只剩文字」而不是「整颗按钮连字一起消失」。
  const categoryItemStyle = useMemo(() => ({
    ...styles.categoryItem,
    // 「按钮圆角」行内覆盖；高度取 styles.categoryItem.minHeight 的源值 56（单行分类按钮，可见高度即 minHeight）
    borderRadius: buttonRadius(56),
    backgroundColor: applyOpacity(theme['c-primary-light-900-alpha-200'], buttonOpacity),
    borderColor: applyOpacity(theme['c-border-background'], buttonOpacity),
  }), [theme, buttonOpacity, buttonRadius])

  return (
    <View style={styles.container}>
      <LandscapeCentered maxWidth={760}>
        <ScrollView
          style={styles.content}
          contentContainerStyle={contentContainer}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
          onLayout={(e) => {
            const viewport = e.nativeEvent.layout.height
            setScrollMetrics(s => (s.viewport === viewport ? s : { ...s, viewport }))
          }}
          onContentSizeChange={(_w, h) => {
            const rows = h - listClearance
            setScrollMetrics(s => (s.rows === rows ? s : { ...s, rows }))
          }}
        >
          <PageHeader title={t('nav_setting')} />
          <View style={listStyle}>
            {SETTING_SCREENS.map((id) => (
              <TouchableOpacity
                key={id}
                style={categoryItemStyle}
                activeOpacity={0.7}
                onPress={() => { handlePress(id) }}
              >
                <Text
                  size={17}
                  style={styles.categoryLabel}
                  color={theme['c-font']}
                >
                  {t(`setting_${id}`)}
                </Text>
                <Icon name="chevron-right" size={16} color={theme['c-font-label']} />
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </LandscapeCentered>
    </View>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
  },
  categoryItem: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: designRadius.md,
    borderWidth: 1,
    paddingHorizontal: designSpacing.md,
    marginBottom: designSpacing.xs,
  },
  categoryLabel: {
    flexShrink: 1,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
})
