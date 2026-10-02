import { memo, useRef } from 'react'
import { View, TouchableOpacity } from 'react-native'
import { LIST_ITEM_HEIGHT } from '@/config/constant'
import { Icon } from '@/components/common/Icon'
import { createStyle, type RowInfo } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useAssertApiSupport } from '@/store/common/hook'
import { scaleSizeH } from '@/utils/pixelRatio'
import { applyOpacity } from '@/utils/colorOpacity'
import Text from '@/components/common/Text'
import Badge, { type BadgeType } from '@/components/common/Badge'
import Image from '@/components/common/Image'
import PlayingIcon from '@/components/common/PlayingIcon'
import { useI18n } from '@/lang'
import { useIsWyLiked, useIsTxLiked, useIsKgLiked } from '@/store/user/hook'
import { handleLikeMusic, handleTxLikeMusic, handleKgLikeMusic } from '@/components/OnlineList/listAction'
import useCoverUrl from '@/utils/hooks/useCoverUrl'
import { getQualityBadge } from '@/utils/musicQualityBadge'
import { designRadius, designSpacing } from '@/theme/DesignTokens'
import { useButtonRadius } from '@/utils/buttonRadius'

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
    const coverUrl = useCoverUrl(item)
    // 汽水(qs) 等音源经 filterListDetail 构造的歌曲可能不带 meta 字段，这里兜底避免
    // 下方 item.meta.xxx 访问 undefined 时整行抛错、导致整列表空白（尤其播放态重渲染时）。
    const meta = (item.meta ?? {}) as any
    const isSelected = selectedList.includes(item)
    const isSupported = useAssertApiSupport(item.source)
    const moreButtonRef = useRef<TouchableOpacity>(null)

    const isWyLiked = useIsWyLiked(meta.songId)
    const txSongId = meta.id
    const isNumericId = txSongId && /^\d+$/.test(String(txSongId))
    const txSongMid = isNumericId
      ? String(txSongId)
      : (item.meta as any).songmid || (item.meta as any).strMediaMid || (typeof item.id === 'string' && item.id.startsWith('tx_') ? item.id.slice(3) : item.id)
    const isTxLiked = useIsTxLiked(txSongMid)
    const isKgLiked = useIsKgLiked(meta.hash || meta.songId)
    const showLikeButton = item.source === 'wy' || item.source === 'tx' || item.source === 'kg'
    const isLiked = item.source === 'wy' ? isWyLiked : item.source === 'tx' ? isTxLiked : item.source === 'kg' ? isKgLiked : false

    const handleLike = () => {
      if (item.source === 'wy') {
        handleLikeMusic(item as LX.Music.MusicInfoOnline)
      } else if (item.source === 'tx') {
        handleTxLikeMusic(item as LX.Music.MusicInfoOnline)
      } else if (item.source === 'kg') {
        handleKgLikeMusic(item as LX.Music.MusicInfoOnline)
      }
    }

    const tagInfo = useQualityTag(item, qualityShowHighest)

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
    const singer = `${item.singer}${isShowAlbumName && meta.albumName ? `·${meta.albumName}` : ''}`

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
              <Text color={theme['c-font']} size={12}>
                {index + 1}
              </Text>
            )}
          </View>
          <View style={styles.itemInfo}>
            <Text color={active ? theme['c-primary-font'] : theme['c-font']} numberOfLines={1}>
              {item.name}
              {item.alias ? <Text color={theme['c-font-label']}> ({item.alias})</Text> : null}
            </Text>
            <View style={styles.listItemSingle}>
              <Badge>{item.source.toUpperCase()}</Badge>
              {tagInfo.type ? <Badge type={tagInfo.type}>{tagInfo.text}</Badge> : null}
              {item.source !== 'local' && meta.fee === 1 ? <Badge type="vip">VIP</Badge> : null}
              {item.source === 'wy' && meta.originCoverType === 2 ? <Badge type="normal">cover</Badge> : null}
              <Text
                style={styles.listItemSingleText}
                size={11}
                color={active ? theme['c-primary-alpha-200'] : theme['c-500']}
                numberOfLines={1}
              >
                {singer}
              </Text>
            </View>
          </View>
          {isShowInterval ? (
            <Text
              size={11}
              color={active ? theme['c-primary-alpha-400'] : theme['c-500']}
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
              // 图标按钮：行高 ITEM_HEIGHT=scaleSizeH(70) 的 80% ≈ 56
              { borderRadius: buttonRadius(56) },
            ]}
          >
            <Icon name={isLiked ? 'love-filled' : 'love'} size={16} color={isLiked ? theme['c-liked'] : theme['c-350']} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={handleShowMenu}
          ref={moreButtonRef}
          style={[
            styles.moreButton,
            // 图标按钮：行高 ITEM_HEIGHT=scaleSizeH(70) 的 80% ≈ 56
            { borderRadius: buttonRadius(56) },
          ]}
        >
          <Icon name="dots-vertical" style={{ color: theme['c-350'] }} size={12} />
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

const styles = createStyle({
  listItem: {
    // width: '50%',
    flexDirection: 'row',
    flexWrap: 'nowrap',
    // 与 OnlineList/ListItem 保持一致：左右各留 16pt，封面（盒宽 70 居中溢出 8pt）
    // 实际落在距屏幕边缘 24pt，与页头对齐；右侧 more 按钮 paddingRight 收窄为 8，
    // 使按钮右缘同样落在 24pt。列表整体不再贴边。
    paddingLeft: designSpacing.md,
    paddingRight: designSpacing.md,
    alignItems: 'center',
    // borderBottomWidth: BorderWidths.normal,
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
    // paddingTop: 10,
    // paddingBottom: 10,
    paddingRight: 2,
  },
  // listItemTitle: {
  //   flexGrow: 0,
  //   flexShrink: 1,
  // },
  listItemSingle: {
    paddingTop: 3,
    flexDirection: 'row',
    // alignItems: 'flex-end',
  },
  listItemSingleText: {
    // backgroundColor: 'rgba(0,0,0,0.2)',
    flexGrow: 0,
    flexShrink: 1,
    fontWeight: '300',
    // fontSize: 15,
  },
  // listItemBadge: {
  //   // fontSize: 10,
  //   paddingLeft: 5,
  //   paddingTop: 2,
  //   alignSelf: 'flex-start',
  // },
  listItemRight: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    justifyContent: 'center',
  },

  moreButton: {
    height: '80%',
    paddingLeft: 10,
    paddingRight: 8,
    // paddingTop: 10,
    // paddingBottom: 10,
    // backgroundColor: 'rgba(0,0,0,0.2)',
    justifyContent: 'center',
  },
  likeButton: {
    height: '80%',
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
})
