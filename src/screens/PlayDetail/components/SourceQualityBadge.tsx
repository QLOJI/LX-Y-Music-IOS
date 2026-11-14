import { memo, useMemo, useRef } from 'react'
import { TouchableOpacity, View } from 'react-native'
import { usePlayMusicInfo, usePlayerQuality } from '@/store/player/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import Badge from '@/components/common/Badge'
import Text from '@/components/common/Text'
import Modal, { type ModalType } from '@/components/common/Modal'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import { applyFixedOpacity } from '@/utils/colorOpacity'
import { getQualityBadgeByQuality } from '@/utils/musicQualityBadge'
import { switchMusicQuality } from '@/core/player/player'
import { updateSetting } from '@/core/common'

// 平台英文缩写映射（用户指定：酷狗=KG，网易=WY，企鹅=QQ，酷我=KW，咪咕=MG）
const SOURCE_ABBR: Record<string, string> = {
  kg: 'KG',
  wy: 'WY',
  tx: 'QQ',
  kw: 'KW',
  mg: 'MG',
  qs: 'QS',
  local: '本地',
  xm: 'XM',
  bilibili: 'BILI',
  gitee: 'GITEE',
}

// 【第 203 轮】音质弹层六档（高→低）。选择后按目标档重新取流；不可用/超时由
// getMusicUrlInfo 的固定天梯自动降级，最终达成档由 playerState.quality 回传。
const QUALITY_OPTIONS: Array<{ q: LX.Quality, key: string }> = [
  { q: 'master', key: 'quality_lossless_master' },
  { q: 'atmos', key: 'quality_lossless_atmos' },
  { q: 'flac24bit', key: 'quality_lossless_24bit' },
  { q: 'flac', key: 'quality_lossless' },
  { q: '320k', key: 'quality_high_quality' },
  { q: '128k', key: '128k' },
]

// 弹层分隔线：0.5pt 发丝线
const HAIRLINE = 0.5

/** 实际达成档归一到六个展示档（hires/192k 等存量值不另开选项）。 */
const normalizeQuality = (quality?: string | null): LX.Quality => {
  switch (quality) {
    case 'master': return 'master'
    case 'atmos':
    case 'atmos_plus': return 'atmos'
    case 'hires':
    case 'flac24bit':
    case 'flac32bit': return 'flac24bit'
    case 'flac': return 'flac'
    case '320k':
    case '192k': return '320k'
    default: return '128k'
  }
}

/**
 * 播放详情页音质/平台标。
 * 【第 203 轮】从「歌名下方的独立徽标行」移到「歌手右侧」，并改为显示**实际播放音质**
 * （降级后显示降级档）；点击音质标打开音质弹层，可选六档并重新取流。
 */
export default memo(({ size = 11 }: { size?: number }) => {
  const t = useI18n()
  const theme = useTheme()
  const playMusicInfo = usePlayMusicInfo()
  const preferredQuality = useSettingValue('player.playQuality')
  const actualQuality = usePlayerQuality()
  const modalRef = useRef<ModalType>(null)
  const switchingRef = useRef(false)

  const musicInfo = playMusicInfo.musicInfo
    ? 'progress' in playMusicInfo.musicInfo
      ? playMusicInfo.musicInfo.metadata.musicInfo
      : playMusicInfo.musicInfo
    : null

  const abbr = musicInfo?.source ? (SOURCE_ABBR[musicInfo.source] ?? musicInfo.source.toUpperCase()) : ''

  const badge = useMemo(() => {
    if (!musicInfo || musicInfo.source === 'local') return null
    // 播放链路始终以「优先播放的音质」为取流起点，详情页首帧也用同一档兜底；
    // 实际达成档回来后立刻替换（降级时显示降级后的档）。
    return getQualityBadgeByQuality(actualQuality || preferredQuality)
  }, [musicInfo, actualQuality, preferredQuality])

  if (!musicInfo) return null

  // 实际音质未知时不高亮任何选项（避免把兜底 128K 误标成「当前」）。
  const currentOption: LX.Quality | null = actualQuality ? normalizeQuality(actualQuality) : null

  const handleSelect = (q: LX.Quality) => {
    modalRef.current?.setVisible(false)
    if (switchingRef.current || q === currentOption) return
    // 【第 254 轮】弹层选择同时写回「优先播放音质」：否则下一首仍从默认档（320k）起跳，
    // 用户看到的就是「这首歌选了 Atmos，下一首直接播 HQ，高档全跳过」。
    updateSetting({ 'player.playQuality': q })
    switchingRef.current = true
    void switchMusicQuality(q).then((ok) => {
      switchingRef.current = false
      if (!ok) toast(t('quality_switch_failed'), 'long')
    })
  }

  return (
    <>
      <View style={styles.row}>
        {abbr ? <Badge type="tertiary" size={size}>{abbr}</Badge> : null}
        {badge ? (
          <TouchableOpacity
            activeOpacity={0.6}
            disabled={musicInfo.source === 'local'}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            onPress={() => { modalRef.current?.setVisible(true) }}
          >
            <Badge type={badge.type} size={size}>{t(badge.key)}</Badge>
          </TouchableOpacity>
        ) : null}
      </View>

      <Modal ref={modalRef} bgColor="rgba(0,0,0,0.35)">
        <View style={styles.overlay} pointerEvents="box-none">
          <View
            style={[
              styles.card,
              {
                // applyOpacity 的第二个参数是 0~100（不是 0~1）：97 = 磨砂半透明。
                backgroundColor: applyFixedOpacity(theme['c-content-background'], 97),
                borderColor: theme['c-border-background'],
              },
            ]}
          >
            {QUALITY_OPTIONS.map(({ q, key }, index) => {
              const current = q === currentOption
              return (
                <TouchableOpacity
                  key={q}
                  activeOpacity={0.6}
                  onPress={() => { handleSelect(q) }}
                  style={[
                    styles.item,
                    index < QUALITY_OPTIONS.length - 1
                      ? { borderBottomWidth: HAIRLINE, borderBottomColor: theme['c-border-background'] }
                      : null,
                  ]}
                >
                  <Text size={15} color={theme['c-font']}>{t(key)}</Text>
                  {current ? <Icon name="volume-higt" size={16} color={theme['c-font-label']} /> : null}
                </TouchableOpacity>
              )
            })}
          </View>
        </View>
      </Modal>
    </>
  )
})

const styles = createStyle({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: 5,
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '82%',
    maxWidth: 340,
    borderRadius: 18,
    borderWidth: 0.5,
    paddingVertical: 4,
    overflow: 'hidden',
    // iOS 浮层阴影
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 24,
  },
  item: {
    height: 48,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
})
