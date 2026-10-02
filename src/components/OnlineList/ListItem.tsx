import { memo, useRef } from 'react'
import { View, TouchableOpacity } from 'react-native'
import Text from '@/components/common/Text'
import Badge from '@/components/common/Badge'
import { Icon } from '@/components/common/Icon'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { scaleSizeH } from '@/utils/pixelRatio'
import { applyOpacity } from '@/utils/colorOpacity'
import { LIST_ITEM_HEIGHT } from '@/config/constant'
import { createStyle, type RowInfo } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import { designRadius, designSpacing, designTypography } from '@/theme/DesignTokens'
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
    const isWyLiked = useIsWyLiked(item.meta.songId)
    const txSongId = (item.meta as any).id
    const isNumericId = txSongId && /^\d+$/.test(String(txSongId))
    const txSongMid = isNumericId
      ? String(txSongId)
      : (item.meta as any).songmid || (item.meta as any).strMediaMid || (typeof item.id === 'string' && item.id.startsWith('tx_') ? item.id.slice(3) : item.id)
    const isTxLiked = useIsTxLiked(txSongMid)
    const isKgLiked = useIsKgLiked((item.meta as any).hash || item.meta.songId)

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
    const singer = `${item.singer}${isShowAlbumName && item.meta.albumName ? `·${item.meta.albumName}` : ''}`

    return (
      <View
        style={{
          ...styles.listItem,
          width: rowInfo.rowWidth,
          height: ITEM_HEIGHT,
          // 播放中/选中的行高亮底色：只改颜色 alpha 随「按钮透明度」淡出，不用容器 opacity——否则文字图标会一起变淡
          backgroundColor: isPlaying || isSelected ? applyOpacity(theme['c-primary-background-hover'], buttonOpacity) : 'rgba(0,0,0,0)',
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
              <Text color={theme['c-font']} size={14} style={styles.indexText}>
                {index + 1}
              </Text>
            )}
          </View>
          <View style={styles.itemInfo}>
            <Text
              numberOfLines={1}
              size={designTypography.body}
              style={styles.songName}
              color={isPlaying ? theme['c-primary-font'] : theme['c-font']}
            >
              {item.name}
              {item.alias ? <Text color={theme['c-font-label']}> ({item.alias})</Text> : null}
            </Text>
            <View style={styles.listItemSingle}>
              {showSource ? <Badge type="tertiary">{item.source.toUpperCase()}</Badge> : null}
              {tagInfo.type ? <Badge type={tagInfo.type}>{tagInfo.text}</Badge> : null}
              {item.meta.fee === 1 ? <Badge type="vip">VIP</Badge> : null}
              {item.source === 'wy' && item.meta.originCoverType === 2 ? <Badge type="normal">cover</Badge> : null}
              {historySource ? <Badge type="normal">{historySource}</Badge> : null}
              <Text
                style={styles.listItemSingleText}
                size={12}
                color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
                numberOfLines={1}
              >
                {singer}
              </Text>
            </View>
          </View>
          {isShowInterval ? (
            <Text
              size={12}
              color={isPlaying ? theme['c-primary-alpha-200'] : theme['c-500']}
              numberOfLines={1}
            >
              {item.interval}
            </Text>
          ) : null}
        </TouchableOpacity>

        {showLikeButton ? (
          <TouchableOpacity
            onPress={handleLike}
            style={[
              styles.likeButton,
              // 图标按钮 40×40：按自身高度折算半高
              { borderRadius: buttonRadius(40) },
            ]}
          >
            <Icon
              name={isLiked ? 'love-filled' : 'love'}
              size={17}
              color={isLiked ? theme['c-liked'] : theme['c-350']}
            />
          </TouchableOpacity>
        ) : null}

        {hideMenu ? null : (
          <TouchableOpacity
            onPress={handleShowMenu}
            ref={moreButtonRef}
            style={[
              styles.moreButton,
              // 图标按钮 40×40：按自身高度折算半高
              { borderRadius: buttonRadius(40) },
            ]}
          >
            <Icon name="dots-vertical" style={{ color: theme['c-350'] }} size={17} />
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

const styles = createStyle({
  listItem: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    // 左右各留 16pt：封面盒（宽 70、内容居中溢出约 8pt）叠加后，封面实际落在距屏幕
    // 边缘 24pt，与页头大标题（paddingHorizontal: lg=24）对齐；右侧 more 按钮
    // （marginRight xs=8）同样收在 24pt。列表整体不再贴边；iPad 横屏双列时
    // 两列间距对称（16+8 ｜ 8+16）。
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
    width: 70,
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: designSpacing.sm,
    paddingRight: designSpacing.sm,
  },
  snIndex: {
    width: 40,
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 5,
    paddingRight: 5,
  },
  albumArt: {
    width: 54,
    height: 54,
    borderRadius: designRadius.md,
  },
  itemInfo: {
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: designSpacing.xs,
    paddingRight: designSpacing.xs,
  },
  songName: {
    fontWeight: '600',
  },
  indexText: {
    fontWeight: '700',
  },
  listItemSingle: {
    paddingTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  listItemTimeLabel: {
    marginRight: 5,
    fontWeight: '400',
  },
  listItemSingleText: {
    flexGrow: 0,
    flexShrink: 1,
    fontWeight: '300',
  },
  listItemBadge: {
    paddingLeft: 5,
    paddingTop: 2,
    alignSelf: 'flex-start',
  },
  listItemRight: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    justifyContent: 'center',
  },
  likeButton: {
    width: 40,
    height: 40,
    marginHorizontal: designSpacing.xs,
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  moreButton: {
    width: 40,
    height: 40,
    marginRight: designSpacing.xs,
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
  },
})
