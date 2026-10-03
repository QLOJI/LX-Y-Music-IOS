import { memo } from 'react'
import { StyleSheet, View } from 'react-native'
import Button from '@/components/common/Button'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import { useI18n } from '@/lang'
import { designRadius, designSpacing } from '@/theme/DesignTokens'
import { scaleSizeW } from '@/utils/pixelRatio'

/**
 * 详情类页面（歌手详情 / 专辑详情等）通用操作栏：播放全部 + 返回。
 * iPhone 上可依赖系统左滑手势返回，但 iPad 上该手势不可用，
 * 独立 push 的详情页必须提供显式返回入口，否则无法返回上一级。
 * 样式与歌单详情页（SonglistDetail/ActionBar）保持一致。
 */
export default memo(({ onPlayAll, onBack }: { onPlayAll: () => void, onBack: () => void }) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  const t = useI18n()

  return (
    <View style={styles.container}>
      <Button
        onPress={onPlayAll}
        style={StyleSheet.compose(styles.controlBtn, {
          flexGrow: 1.45,
          // 按钮底色随「按钮透明度」设置淡出；图标/文字色不动（不用容器 style.opacity，否则内容会一起变淡）
          //
          // 2026-10-02：底色由「主色实底 c-primary」改为淡灰 c-primary-background、内容色改为
          // c-primary-font（在主题表里就等于主色 c-primary），与歌单详情页
          // SonglistDetail/ActionBar 的「播放全部」三件套逐字一致 ——
          // 需求原文「所有歌单、专辑、歌手等界面的播放全部按钮都用其他颜色+灰色背景的样式
          // （例如歌单界面的样式）」。主色文字压在原来的主色实底上会看不见，两个色必须一起改。
          backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
          // 静态高 44（styles.controlBtn.height），行内覆盖「按钮圆角」
          borderRadius: buttonRadius(44),
        })}
      >
        <View style={styles.primaryContent}>
          <Icon name="play" size={15} color={theme['c-primary-font']} />
          {/* 图标与文字之间的 6pt 间距只属于这一颗（唯一带图标的按钮），从共用样式下沉到这里，
              避免「返回」的文字被一起右推、看起来不居中 */}
          <Text style={{ ...styles.controlBtnText, marginLeft: 6, color: theme['c-primary-font'] }}>
            {t('play_all')}
          </Text>
          {/* 右侧补一块与「图标宽 + 6pt 间距」等宽的对称留白，见 SonglistDetail/ActionBar 的说明：
              否则 flex 居中的是「图标+文字」整组，文字自身会右偏约 10pt，和「返回」的文字对不齐。 */}
          <View style={{ width: scaleSizeW(15) + 6 }} />
        </View>
      </Button>
      <Button
        onPress={onBack}
        style={StyleSheet.compose(styles.controlBtn, {
          // 同上：只淡按钮自身底色，文字色不动
          backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
          // 静态高 44（styles.controlBtn.height），行内覆盖「按钮圆角」
          borderRadius: buttonRadius(44),
        })}
      >
        <Text style={{ ...styles.controlBtnText, color: theme['c-primary-font'] }}>
          {t('back')}
        </Text>
      </Button>
    </View>
  )
})

const styles = createStyle({
  container: {
    flexDirection: 'row',
    width: '100%',
    flexGrow: 0,
    flexShrink: 0,
    // 【第 30 轮】同 SonglistDetail/ActionBar：上下间距都收敛到 sm(12)，与歌单详情页对齐
    // （用户报「播放全部文字上下间距太大」，要求上下间距一样）。
    marginTop: designSpacing.sm,
    paddingHorizontal: designSpacing.md,
    gap: designSpacing.sm,
    paddingBottom: designSpacing.sm,
  },
  controlBtn: {
    flexGrow: 1,
    flexShrink: 1,
    height: 44,
    borderRadius: designRadius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  controlBtnText: {
    // 本样式两钮共用，这里**不能**再写 marginLeft：只有第一颗（播放全部）带图标需要 6pt 间距，
    // 写在共用样式里会把「返回」的文字整体右移（居中项 +6 左边距 = 视觉中心右偏 3pt），间距已下沉到第一颗按钮的 Text 上。
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
})
