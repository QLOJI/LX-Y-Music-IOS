import { memo, useRef } from 'react'
import { View, TouchableOpacity } from 'react-native'
import Text from '@/components/common/Text'
import MarqueeText from '@/components/common/MarqueeText'
import Badge from '@/components/common/Badge'
import { Icon } from '@/components/common/Icon'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { scaleSizeH } from '@/utils/pixelRatio'
import { applyOpacity } from '@/utils/colorOpacity'
import { LIST_ITEM_HEIGHT } from '@/config/constant'
import { type RowInfo } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import { designTypography } from '@/theme/DesignTokens'
// 【第 24 轮】行内样式统一：歌曲行的几何/字重/字号只有 components/common/songRowStyles.ts 一份，
// 本组件不再自带一份（此前这里的 songName 是 '600'，与「我的列表」的细体不一致 = 用户报的字体粗细不同）。
import { songRowMetrics, songRowStyles as styles } from '@/components/common/songRowStyles'
import Image from '@/components/common/Image'
import PlayingIcon from '@/components/common/PlayingIcon'
import { useIsWyLiked, useIsTxLiked, useIsKgLiked } from '@/store/user/hook'
import { handleLikeMusic, handleTxLikeMusic, handleKgLikeMusic } from './listAction'
import useCoverUrl from '@/utils/hooks/useCoverUrl'
import { getQualityBadge } from '@/utils/musicQualityBadge'

// 列表项封面：优先用自带 meta.picUrl；为空时按需动态获取（在线接口/本地内嵌/
// 网盘封面/qs 跨平台匹配），解决 cookie 歌单、WebDAV 同步、备份导入的歌单
// 「列表无封面但播放有封面」的问题（播放时 player 走同一 getPicPath 动态获取）。
// 结果带缓存与并发限制，见 core/music/coverUrl.ts。

export const ITEM_HEIGHT = scaleSizeH(LIST_ITEM_HEIGHT)

// showHighest 由组件顶层订阅后经参数传入（见文件底部的默认导出）：memo 比较器只能看到
// props，hook 订阅值必须走 prop 才能参与比较，保证开关切换时行会重渲染。
const useQualityTag = (musicInfo: LX.Music.MusicInfoOnline, showHighest: boolean) => {
  const t = useI18n()
  // 天梯只有一份：utils/musicQualityBadge.ts（2026-10-02 统一六档 Master/Atmos/24bit/SQ/HQ/128K，
  // 取不到标注时兜底 128K —— 以前这一档什么标都不显示，正是需求点名的「没有小标」）。
  const info = getQualityBadge((musicInfo.meta as LX.Music.MusicInfoMeta_online)?._qualitys, showHighest)
  return { type: info.type, text: t(info.key) }
}

type ListItemProps = {
  item: LX.Music.MusicInfoOnline
  index: number
  showSource?: boolean
  onPress: (item: LX.Music.MusicInfoOnline, index: number) => void
  onLongPress: (item: LX.Music.MusicInfoOnline, index: number) => void
  onShowMenu: (
    item: LX.Music.MusicInfoOnline,
    index: number,
    position: { x: number, y: number, w: number, h: number }
  ) => void
  selectedList: LX.Music.MusicInfoOnline[]
  rowInfo: RowInfo
  isShowAlbumName: boolean
  isShowInterval: boolean
  playingId?: string | null
  listId?: string
  showCover?: boolean
  hideMenu?: boolean
}

const ListItem = memo(
  ({
    item,
    index,
    showSource,
    onPress,
    onLongPress,
    onShowMenu,
    selectedList,
    rowInfo,
    isShowAlbumName,
    playingId,
    isShowInterval,
    listId: _listId,
    showCover = true,
    hideMenu = false,
    qualityShowHighest,
  }: ListItemProps & { qualityShowHighest: boolean }) => {
    const theme = useTheme()
    const buttonOpacity = useSettingValue('theme.buttonOpacity')
    // 封面 54、图标按钮 40 都取各自静态样式里写死的高度，由 buttonRadius 折算半高
    const buttonRadius = useButtonRadius()
    const isPlaying = playingId === item.id
    const isSelected = selectedList.includes(item)
    const coverUrl = useCoverUrl(item)
    // 本地/下载任务转播放项、汽水(qs)等经 filterListDetail 构造的歌曲可能不带 meta 字段，
    // 这里兜底避免下方 meta.xxx 访问 undefined 时整行抛错（用户第 11 轮第 13 条，
    // Mylist/MusicList/ListItem.tsx 同一类崩溃）。
    const meta = (item.meta ?? {}) as any
    const isWyLiked = useIsWyLiked(meta.songId)
    const txSongId = meta.id
    const isNumericId = txSongId && /^\d+$/.test(String(txSongId))
    const txSongMid = isNumericId
      ? String(txSongId)
      : (meta.songmid || meta.strMediaMid || (typeof item.id === 'string' && item.id.startsWith('tx_') ? item.id.slice(3) : item.id))
    const isTxLiked = useIsTxLiked(txSongMid)
    const isKgLiked = useIsKgLiked(meta.hash || meta.songId)

    const moreButtonRef = useRef<TouchableOpacity>(null)
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

    const showLikeButton = item.source === 'wy' || item.source === 'tx' || item.source === 'kg'
    const isLiked = item.source === 'wy' ? isWyLiked : item.source === 'tx' ? isTxLiked : item.source === 'kg' ? isKgLiked : false

    const handleLike = () => {
      if (item.source === 'wy') {
        handleLikeMusic(item)
      } else if (item.source === 'tx') {
        handleTxLikeMusic(item)
      } else if (item.source === 'kg') {
        handleKgLikeMusic(item)
      }
    }

    const tagInfo = useQualityTag(item, qualityShowHighest)
    const historySource = (item as LX.Music.MusicInfoOnline & { playHistorySource?: LX.Player.PlayHistorySource }).playHistorySource
    const singer = `${item.singer}${isShowAlbumName && meta.albumName ? `·${meta.albumName}` : ''}`

    return (
      <View
        style={{
          ...styles.listItem,
          width: rowInfo.rowWidth,
          height: ITEM_HEIGHT,
          // 播放中/选中的行高亮底色：只改颜色 alpha 随「按钮透明度」淡出，不用容器 opacity——否则文字图标会一起变淡
          // 【第 46 轮】底色改用专门的歌曲行语义 token（比原先的 c-primary-background-hover 深一档），
          // 后者还兼着评论输入框等非行面；见 theme/themes/index.ts。
          backgroundColor: isPlaying || isSelected ? applyOpacity(theme['c-list-item-background-selected'], buttonOpacity) : 'rgba(0,0,0,0)',
        }}
      >
        <TouchableOpacity
          style={styles.listItemLeft}
          onPress={() => { onPress(item, index) }}
          onLongPress={() => { onLongPress(item, index) }}
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
            ) : isPlaying ? (
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
              text={item.alias ? `${item.name} (${item.alias})` : item.name}
              size={designTypography.body}
              style={styles.songName}
              color={isPlaying ? theme['c-primary-font'] : theme['c-font']}
            >
              {item.name}
              {item.alias ? <Text color={theme['c-font-label']}> ({item.alias})</Text> : null}
            </MarqueeText>
            <View style={styles.listItemSingle}>
              {/* 【第 22 轮】source 加存在性判断：与 Mylist/MusicList/ListItem 同一条防线 ——
                  缺 source 的数据（下载任务转播放项等）绝不能靠一个徽标把整页渲染打崩 */}
              {showSource && item.source ? <Badge type="tertiary">{item.source.toUpperCase()}</Badge> : null}
              {tagInfo.type ? <Badge type={tagInfo.type}>{tagInfo.text}</Badge> : null}
              {meta.fee === 1 ? <Badge type="vip">VIP</Badge> : null}
              {item.source === 'wy' && meta.originCoverType === 2 ? <Badge type="normal">cover</Badge> : null}
              {historySource ? <Badge type="normal">{historySource}</Badge> : null}
              <Text
                style={styles.listItemSingleText}
                size={songRowMetrics.metaTextSize}
                color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
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
              color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
              numberOfLines={1}
            >
              {item.interval}
            </Text>
          ) : null}
        </TouchableOpacity>

        {/* 【第 24 轮】爱心位必须**恒占位**：此前无爱心（不支持收藏的音源）的行会让
            时长与 ⋮ 一起右移一个按钮的宽度，「时间/爱心/三个点」因此行行不齐。
            不可点时渲染等宽空 View（几何同 styles.likeButton，含左右 margin）。 */}
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

        {hideMenu ? null : (
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
        )}
      </View>
    )
  },
  (prevProps, nextProps) => {
    return !!(
      prevProps.item === nextProps.item &&
      prevProps.index === nextProps.index &&
      prevProps.showSource === nextProps.showSource &&
      prevProps.isShowAlbumName === nextProps.isShowAlbumName &&
      prevProps.isShowInterval === nextProps.isShowInterval &&
      prevProps.listId === nextProps.listId &&
      prevProps.playingId === nextProps.playingId &&
      prevProps.hideMenu === nextProps.hideMenu &&
      (prevProps.item as any).playHistorySource === (nextProps.item as any).playHistorySource &&
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

