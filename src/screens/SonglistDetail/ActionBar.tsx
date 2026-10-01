import { memo } from 'react'
import { StyleSheet, View } from 'react-native'
import Button from '@/components/common/Button'

import { createStyle, toast } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { designRadius, designSpacing } from '@/theme/DesignTokens'
import { scaleSizeW } from '@/utils/pixelRatio'
import { handleCollect, handlePlay } from './listAction'
import songlistState from '@/store/songlist/state'
import { useI18n } from '@/lang'
import { useListInfo } from './state'

export default memo(({ onBack }: { onBack?: () => void }) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  const buttonRadius = useButtonRadius()
  const t = useI18n()
  const info = useListInfo()

  const handlePlayAll = () => {
    // 兜底：歌单 id/source 来自 useListInfo()（由 SonglistDetail 的 Provider 提供）。
    // 若 Provider 缺失，这里会拿到默认值（id=''、source='kw'），用空 id 去播放会写出一个
    // 「只有页面已加载部分」的临时列表，且拉取完整歌单必然失败（静默），用户看到的就是
    // 「播放全部后临时列表缺歌」。这里显式提示，避免再退化成静默的半截列表。
    if (!info.id || !info.source) {
      toast('歌单信息未就绪，请稍后重试')
      return
    }
    if (!songlistState.listDetailInfo.list.length) {
      toast('歌单加载失败，请返回重试')
      return
    }
    void handlePlay(info.id, info.source, songlistState.listDetailInfo.list)
  }

  const handleCollection = () => {
    if (!info.id || !info.source) {
      toast('歌单信息未就绪，请稍后重试')
      return
    }
    const name = songlistState.listDetailInfo.info?.name || info.name || '未命名歌单'
    void handleCollect(info.id, info.source, name)
  }

  return (
    <View style={styles.container}>
      <Button
        onPress={handlePlayAll}
        style={StyleSheet.compose(styles.controlBtn, {
          flexGrow: 1.45,
          // 按钮底色随「按钮透明度」设置淡出；图标/文字色不动
          // （不用容器 style.opacity，否则内容会一起变淡）
          backgroundColor: applyOpacity(theme['c-primary'], buttonOpacity),
          // 三颗按钮共用 styles.controlBtn 的静态高 44，行内覆盖「按钮圆角」
          borderRadius: buttonRadius(44),
        })}
      >
        <View style={styles.primaryContent}>
          <Icon name="play" size={15} color={theme['c-primary-light-1000']} />
          {/* 图标与文字之间的 6pt 间距只属于这一颗（唯一带图标的按钮）：
              以前它写在共用的 controlBtnText 里，后两颗（收藏歌单 / 返回）没有图标
              却被一起往右推了 6pt —— 按钮内容看起来「不居中」。
              现在间距只作用在本按钮的文字上，另外两颗的文字严格居中。 */}
          <Text style={{ ...styles.controlBtnText, marginLeft: 6, color: theme['c-primary-light-1000'] }}>
            {t('play_all')}
          </Text>
          {/* 右侧补一块与「图标宽 + 6pt 间距」等宽的对称留白。
              没有它时：flex 居中的是「图标+文字」这一组，文字自身中心比按钮中心
              右偏 (scaleSizeW(15)+6)/2 ≈ 10pt —— 三颗按钮里唯独这一颗的文字不在
              中线，和「收藏歌单 / 返回」的文字对不齐。补上后居中的就是文字本身。 */}
          <View style={{ width: scaleSizeW(15) + 6 }} />
        </View>
      </Button>
      <Button
        onPress={handleCollection}
        style={StyleSheet.compose(styles.controlBtn, {
          // 同上：只淡按钮自身底色，文字色不动
          backgroundColor: applyOpacity(theme['c-primary-background'], buttonOpacity),
          borderRadius: buttonRadius(44),
        })}
      >
        <Text style={{ ...styles.controlBtnText, color: theme['c-primary-font'] }}>
          {t('collect_songlist')}
        </Text>
      </Button>
      <Button
        onPress={onBack}
        style={StyleSheet.compose(styles.controlBtn, {
          // 同上：只淡按钮自身底色，文字色不动
          backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
          borderRadius: buttonRadius(44),
        })}
      >
        <Text style={{ ...styles.controlBtnText, color: theme['c-primary-font'] }}>{t('back')}</Text>
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
    marginTop: designSpacing.sm,
    paddingHorizontal: designSpacing.md,
    gap: designSpacing.sm,
    paddingBottom: designSpacing.md,
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
    // 这里**不能**再写 marginLeft：本样式被三颗按钮共用，只有第一颗（播放全部）
    // 带图标需要 6pt 间距，写在共用样式里会把「收藏歌单 / 返回」的文字整体右移
    // 6pt（居中项 +6 左外边距 = 视觉中心右偏 3pt）。间距已下沉到第一颗按钮的 Text 上。
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
})
