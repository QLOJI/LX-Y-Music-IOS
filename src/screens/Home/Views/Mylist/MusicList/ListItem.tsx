import { memo, useRef } from 'react'
import { View, TouchableOpacity } from 'react-native'
import { LIST_ITEM_HEIGHT } from '@/config/constant'
import { Icon } from '@/components/common/Icon'
import { type RowInfo } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useAssertApiSupport } from '@/store/common/hook'
import { scaleSizeH } from '@/utils/pixelRatio'
import { applyOpacity } from '@/utils/colorOpacity'
import Text from '@/components/common/Text'
import MarqueeText from '@/components/common/MarqueeText'
import Badge, { type BadgeType } from '@/components/common/Badge'
import Image from '@/components/common/Image'
import PlayingIcon from '@/components/common/PlayingIcon'
import { useI18n } from '@/lang'
import { useIsWyLiked, useIsTxLiked, useIsKgLiked } from '@/store/user/hook'
import { handleLikeMusic, handleTxLikeMusic, handleKgLikeMusic } from '@/components/OnlineList/listAction'
import useCoverUrl from '@/utils/hooks/useCoverUrl'
import { getQualityBadge } from '@/utils/musicQualityBadge'
import { designTypography } from '@/theme/DesignTokens'
import { useButtonRadius } from '@/utils/buttonRadius'
// 【第 24 轮】行内样式统一：歌曲行的几何/字重/字号只有 components/common/songRowStyles.ts 一份
// （此前本组件的封面盒、副标题字号、爱心/⋮ 按钮几何与 OnlineList 各行其是 = 用户报的「位置不统一」）。
import { songRowMetrics, songRowStyles as styles } from '@/components/common/songRowStyles'

export const ITEM_HEIGHT = scaleSizeH(LIST_ITEM_HEIGHT)

// 列表项封面：优先用自带 meta.picUrl；为空时按需动态获取（在线接口/本地内嵌/
// 网盘封面/qs 跨平台匹配），解决 cookie 歌单、WebDAV 同步、备份导入的歌单
// 「列表无封面但播放有封面」的问题（播放时 player 走同一 getPicPath 动态获取）。
// 结果带缓存与并发限制，见 core/music/coverUrl.ts。

// showHighest 由组件顶层订阅后经参数传入（见文件底部的默认导出）：memo 比较器只能看到
// props，hook 订阅值必须走 prop 才能参与比较，保证开关切换时行会重渲染。
const useQualityTag = (musicInfo: LX.Music.MusicInfo, showHighest: boolean) => {
  const t = useI18n()
  // 本地文件没有「在线音质档」可言：保持不显示小标，不参与下面的 128K 兜底
  // （把本地无损文件标成 128K 比不标更糟；需求说的「没有小标统一改 128K」指的是在线曲目）
  if (musicInfo.source === 'local') return { type: null as BadgeType | null, text: '' }
  // 天梯只有一份：utils/musicQualityBadge.ts（2026-10-02 统一六档 Master/Atmos/24bit/SQ/HQ/128K，
  // 取不到标注时兜底 128K；此前这里的 192k 会显示成小写 '192k' 的野串，现已归入 HQ）
  const info = getQualityBadge((musicInfo.meta as LX.Music.MusicInfoMeta_online)?._qualitys, showHighest)
  return { type: info.type as BadgeType | null, text: t(info.key) }
}

type ListItemProps = {
  item: LX.Music.MusicInfo
  index: number
  activeIndex: number
  onPress: (item: LX.Music.MusicInfo, index: number) => void
  onLongPress: (item: LX.Music.MusicInfo, index: number) => void
  onShowMenu: (
    item: LX.Music.MusicInfo,
    index: number,
    position: { x: number, y: number, w: number, h: number }
  ) => void
  selectedList: LX.Music.MusicInfo[]
  rowInfo: RowInfo
  isShowAlbumName: boolean
  isShowInterval: boolean
  showCover: boolean
  onScrollBeginDrag?: () => void
}

const ListItem = memo(
  ({
    item,
    index,
    activeIndex,
    onPress,
    onShowMenu,
    onLongPress,
    selectedList,
    rowInfo,
    isShowAlbumName,
    isShowInterval,
    showCover,
    qualityShowHighest,
  }: ListItemProps & { qualityShowHighest: boolean }) => {
    const theme = useTheme()
    const buttonOpacity = useSettingValue('theme.buttonOpacity')
    // 封面 54×54；点赞/更多图标按钮高度为行高 ITEM_HEIGHT=scaleSizeH(70) 的 80% ≈ 56
    const buttonRadius = useButtonRadius()
    // 【第 22 轮·图三/图四】下载任务转成的播放项（判据 'progress' in item，见 LocalDownload 的
    // taskToPlayItem）**没有** source / name / singer，显示数据全挂在 item.metadata.musicInfo 上；
    // 播放器内核刻意保留这个结构（'progress' in musicInfo 是任务项判据，歌词/封面/URL 都依赖它，
    // 不能改）。此前本组件直接读 item.source 并在下方 .toUpperCase()，播「下载 / 本地」歌曲后
    // 长按迷你播放器或进入试听列表，渲染期就抛
    // `TypeError: Cannot read property 'toUpperCase' of undefined` 整页崩。
    // 这里统一取「显示用信息」：任务项取 metadata.musicInfo，其余就是 item 自己；
    // 下面所有展示 / 点赞 / 音质 / API 支持判断都读 info，而 onPress / onLongPress / onShowMenu
    // 仍回传原始 item（播放链路要继续拿任务结构）。
    const info: LX.Music.MusicInfo = 'progress' in item
      ? ((item as unknown as LX.Download.ListItem).metadata?.musicInfo ?? item)
      : item
    const coverUrl = useCoverUrl(info)
    // 汽水(qs) 等音源经 filterListDetail 构造的歌曲可能不带 meta 字段，这里兜底避免
    // 下方 item.meta.xxx 访问 undefined 时整行抛错、导致整列表空白（尤其播放态重渲染时）。
    const meta = (info.meta ?? {}) as any
    const isSelected = selectedList.includes(item)
    const isSupported = useAssertApiSupport(info.source)
    const moreButtonRef = useRef<TouchableOpacity>(null)

    const isWyLiked = useIsWyLiked(meta.songId)
    const txSongId = meta.id
    const isNumericId = txSongId && /^\d+$/.test(String(txSongId))
    // 这里必须用上面的安全 meta（而不是 item.meta）：本地/下载任务转播放项、汽水(qs)等
    // 经 filterListDetail 构造的歌曲没有 meta 字段，长按迷你播放器跳转到本页时会在渲染期
    // 抛 `Cannot read property 'songmid' of undefined` 整列表崩掉（用户第 11 轮第 13 条）。
    const txSongMid = isNumericId
      ? String(txSongId)
      : (meta.songmid || meta.strMediaMid || (typeof info.id === 'string' && info.id.startsWith('tx_') ? info.id.slice(3) : info.id))
    const isTxLiked = useIsTxLiked(txSongMid)
    const isKgLiked = useIsKgLiked(meta.hash || meta.songId)
    // 【第 22 轮】下面全部改读 info：任务项的 source 在 metadata.musicInfo 上（item.source 是 undefined）
    const showLikeButton = info.source === 'wy' || info.source === 'tx' || info.source === 'kg'
    const isLiked = info.source === 'wy' ? isWyLiked : info.source === 'tx' ? isTxLiked : info.source === 'kg' ? isKgLiked : false

    const handleLike = () => {
      if (info.source === 'wy') {
        handleLikeMusic(info as LX.Music.MusicInfoOnline)
      } else if (info.source === 'tx') {
        handleTxLikeMusic(info as LX.Music.MusicInfoOnline)
      } else if (info.source === 'kg') {
        handleKgLikeMusic(info as LX.Music.MusicInfoOnline)
      }
    }

    const tagInfo = useQualityTag(info, qualityShowHighest)

    const handleShowMenu = () => {
      if (moreButtonRef.current?.measure) {
        moreButtonRef.current.measure((fx, fy, width, height, px, py) => {
          onShowMenu(item, index, {
            x: Math.ceil(px),
            y: Math.ceil(py),
            w: Math.ceil(width),
            h: Math.ceil(height),
          })
        })
      }
    }

    const active = activeIndex == index
    const singer = `${info.singer}${isShowAlbumName && meta.albumName ? `·${meta.albumName}` : ''}`

    return (
      <View
        style={{
          ...styles.listItem,
          width: rowInfo.rowWidth,
          height: ITEM_HEIGHT,
          // 选中行高亮底色：只改颜色 alpha 随「按钮透明度」淡出，不用容器 opacity——否则文字图标会一起变淡
          backgroundColor: isSelected ? applyOpacity(theme['c-primary-background-hover'], buttonOpacity) : 'rgba(0,0,0,0)',
          opacity: isSupported ? 1 : 0.5,
        }}
      >
        <TouchableOpacity
          style={styles.listItemLeft}
          onPress={() => {
            onPress(item, index)
          }}
          onLongPress={() => {
            onLongPress(item, index)
          }}
        >


          <View style={showCover ? styles.sn : styles.snIndex}>
            {showCover ? (
              <Image
                url={coverUrl}
                style={[
                  styles.albumArt,
                  // 歌曲封面 54×54：按自身高度折算半高
                  { borderRadius: buttonRadius(54) },
                ]}
              />
            ) : active ? (
              <PlayingIcon />
            ) : (
              <Text color={theme['c-font']} size={songRowMetrics.indexTextSize} style={styles.indexText}>
                {index + 1}
              </Text>
            )}
          </View>
          <View style={styles.itemInfo}>
            {/* 【第 30 轮·图十】歌名过长不再截断成「...」：跑马灯从右到左滚动。
                别名保留原来的灰字样式，故走 children（变更检测仍看 text）。 */}
            <MarqueeText
              text={info.alias ? `${info.name} (${info.alias})` : info.name}
              color={active ? theme['c-primary-font'] : theme['c-font']}
              size={designTypography.body}
              style={styles.songName}
            >
              {info.name}
              {info.alias ? <Text color={theme['c-font-label']}> ({info.alias})</Text> : null}
            </MarqueeText>
            <View style={styles.listItemSingle}>
              {/* 【第 22 轮】source 必须带存在性判断：任务项在极端情况（metadata 缺失）下取不到
                  音源，不能让一个徽标把整页渲染打崩（用户报的崩溃点就是这行 .toUpperCase()） */}
              {info.source ? <Badge>{info.source.toUpperCase()}</Badge> : null}
              {tagInfo.type ? <Badge type={tagInfo.type}>{tagInfo.text}</Badge> : null}
              {info.source !== 'local' && meta.fee === 1 ? <Badge type="vip">VIP</Badge> : null}
              {info.source === 'wy' && meta.originCoverType === 2 ? <Badge type="normal">cover</Badge> : null}
              <Text
                style={styles.listItemSingleText}
                size={songRowMetrics.metaTextSize}
                color={active ? theme['c-primary-alpha-200'] : theme['c-500']}
                numberOfLines={1}
              >
                {singer}
              </Text>
            </View>
          </View>
          {isShowInterval ? (
            <Text
              size={songRowMetrics.metaTextSize}
              style={styles.interval}
              color={active ? theme['c-primary-alpha-400'] : theme['c-500']}
              numberOfLines={1}
            >
              {info.interval}
            </Text>
          ) : null}
        </TouchableOpacity>
        {/* 【第 24 轮】爱心位恒占位：无收藏能力的音源此前不留位，时长与 ⋮ 会一起右移一个按钮宽 */}
        {showLikeButton ? (
          <TouchableOpacity
            onPress={handleLike}
            style={[
              styles.likeButton,
              // 图标按钮 40×40：按自身高度折算半高
              { borderRadius: buttonRadius(songRowMetrics.iconButtonSize) },
            ]}
          >
            <Icon
              name={isLiked ? 'love-filled' : 'love'}
              size={songRowMetrics.iconSize}
              color={isLiked ? theme['c-liked'] : theme['c-350']}
            />
          </TouchableOpacity>
        ) : <View style={styles.likeButton} />}
        <TouchableOpacity
          onPress={handleShowMenu}
          ref={moreButtonRef}
          style={[
            styles.moreButton,
            // 图标按钮 40×40：按自身高度折算半高
            { borderRadius: buttonRadius(songRowMetrics.iconButtonSize) },
          ]}
        >
          <Icon name="dots-vertical" style={{ color: theme['c-350'] }} size={songRowMetrics.iconSize} />
        </TouchableOpacity>
      </View>
    )
  },
  (prevProps, nextProps) => {
    return !!(
      prevProps.item === nextProps.item &&
      prevProps.index === nextProps.index &&
      prevProps.isShowAlbumName === nextProps.isShowAlbumName &&
      prevProps.isShowInterval === nextProps.isShowInterval &&
      prevProps.activeIndex != nextProps.index &&
      nextProps.activeIndex != nextProps.index &&
      nextProps.selectedList.includes(nextProps.item) ==
      prevProps.selectedList.includes(nextProps.item) &&
      prevProps.showCover === nextProps.showCover &&
      prevProps.qualityShowHighest === nextProps.qualityShowHighest
    )
  },
)

// 「显示最高音质」开关改为订阅式：列表已挂载时切开关也要重渲染（此前在 useQualityTag 里
// 同步读 settingState，切开关列表不更新）。订阅值必须从组件顶层经 prop 传进加了 memo 的
// 行组件、纳入其比较器，否则这次仅因开关变化的重渲染会被 memo 挡掉（hook 值进不了比较器）。
export default (props: ListItemProps) => {
  const qualityShowHighest = useSettingValue('common.quality_show_highest')
  return <ListItem {...props} qualityShowHighest={qualityShowHighest} />
}

