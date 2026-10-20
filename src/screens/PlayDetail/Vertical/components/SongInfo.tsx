import { memo, useCallback } from 'react'
import { View, TouchableOpacity, type LayoutChangeEvent } from 'react-native'
import { usePlayMusicInfo } from '@/store/player/hook'
import { useTheme } from '@/store/theme/hook'
import { navigations } from '@/navigation'
import { createStyle, toast, clipboardWriteText } from '@/utils/tools'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { handleLikeMusic, handleTxLikeMusic, handleKgLikeMusic, handleShowArtistDetail } from '@/components/OnlineList/listAction'
import playerState from '@/store/player/state'
import { useIsWyLiked, useIsTxLiked, useIsKgLiked } from '@/store/user/hook'
import { useWindowSize } from '@/utils/hooks'
import SourceQualityBadge from '../../components/SourceQualityBadge'
import { useButtonRadius } from '@/utils/buttonRadius'
import { setSpText } from '@/utils/pixelRatio'
import { designTypography } from '@/theme/DesignTokens'

// ---- 信息块的固定高度（2026-10-13 第 73 轮）------------------------------------------
//
// 用户报：「封面大小、歌曲标题、小歌词部分、下面的功能按钮等，有时会因为歌曲名称长度
// 使得位置发生变化，请把位置固定，只能通过封面显示大小调节」。
//
// 根因：本块的高度**随歌曲数据变化** —— 徽标行有/无达成档差一整个行高、专辑名有/无差一整行、
// 歌手多到 artistRow 折行再多一行。而这个实测高会进 VerticalNew 的
//   M = R − 2·containerPaddingH − paddingBottom − (SongInfo 内容高 + marginBottom)
// ⇒ M 变 ⇒ 封面可用区间 band 变 ⇒ 实际封面直径变 ⇒ 歌名栏 / 小歌词 / 功能按钮的位置全跟着漂。
//
// 修法：把整块的高度钉死在最坏配置上（SONG_INFO_CONTENT_HEIGHT），并让块内每一行的
// 纵向位置也不随数据变：
//   · 徽标行给一个定高空槽（没有达成档时也占位）—— 它下面的行不再跟着上移；
//   · artistRow 禁折行（超长歌手名收缩，不换行）—— 行数恒为 1；
//   · 歌名行 / 专辑行本来就 numberOfLines={1}，各自恒为一行。
// 于是 onLayout 回来的 height 是常量 ⇒ M 是常量 ⇒ 封面只受「封面显示大小」设置调节。
//
// 逐项镜像 VerticalNew 的 estimateSongInfoContentHeight()（首帧兜底用）——**两处必须同改**：
//   row(28) + 8 + (4 + row(9)) + (row(16) + 4) + row(14)
// row() 与 components/common/Text.tsx 的默认行高同式：round(setSpText(size) × lineHeightRatio)。
const row = (size: number) => Math.round(setSpText(size) * designTypography.lineHeightRatio)
/** 歌名行：Text size 28（numberOfLines=1）。心形图标 28 ≤ 行高，不参与定高。 */
const SONG_NAME_ROW = row(28)
/** 歌名行 → 徽标行的间距：styles.songNameRow.marginBottom（经 createStyle 的 scaleSizeH） */
const SONG_NAME_GAP = 8
/** 徽标行：SourceQualityBadge 自带 marginTop 4，行内是 size 9 的 Badge ⇒ 4 + row(9) */
const BADGE_ROW = 4 + row(9)
/** 歌手行：Text size 16，禁折行后恒为一行 */
const ARTIST_ROW = row(16)
/** 歌手行 → 专辑行的间距：styles.artistWrapper.marginBottom（经 createStyle 的 scaleSizeH） */
const ARTIST_GAP = 4
/** 专辑行：Text size 14（numberOfLines=1） */
const ALBUM_ROW = row(14)

/**
 * 信息块内容高（**不含** styles.container 自己的上下 margin —— onLayout 报的就是它）。
 * 与 VerticalNew 的 estimateSongInfoContentHeight() 逐项一致；那边是首帧兜底，这里是实测口径。
 */
export const SONG_INFO_CONTENT_HEIGHT =
  SONG_NAME_ROW + SONG_NAME_GAP + BADGE_ROW + (ARTIST_ROW + ARTIST_GAP) + ALBUM_ROW

// 两个定高样式必须是**未缩放**的值：SONG_INFO_CONTENT_HEIGHT 是按 Text 的真实行高
//（setSpText × lineHeightRatio）算出来的，若交给 createStyle 会被 scaleSizeH 再缩一次，
// 与上面那个式子对不上。所以放模块级常量里、以普通对象传下去（引用稳定，不触发重渲染）。
const containerFixedSize = { height: SONG_INFO_CONTENT_HEIGHT }
const badgeSlotFixedSize = { height: BADGE_ROW, justifyContent: 'center' as const }

export default memo(({ componentId, onLayout }: {
  componentId: string
  /**
   * 根节点的布局回调（可选）。VerticalNew 用它实测「信息块顶边 → 歌名栏视觉顶边」的距离，
   * 也就是本组件 styles.container 上的 marginTop。
   *
   * 为什么需要它：封面要居中在「返回栏底边 → 歌名栏顶边」之间，而封面所在容器的 flex
   * 居中只认得信息块的**外框**顶边；外框比歌名栏视觉顶边高这一个 margin，封面因此整体
   * 偏上 margin/2（大屏约 10pt，肉眼可见）。把这个值交出去，上层才能把居中区间下边界
   * 平移到歌名栏视觉顶边。**不要删**：删掉后封面会重新偏上。
   */
  onLayout?: (event: LayoutChangeEvent) => void
}) => {
  const playMusicInfo = usePlayMusicInfo()
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  const { height: winHeight } = useWindowSize()
  const isSmallWindow = winHeight < 700
  const musicInfo = playMusicInfo.musicInfo ? ('progress' in playMusicInfo.musicInfo ? playMusicInfo.musicInfo.metadata.musicInfo : playMusicInfo.musicInfo) : null

  const handleArtistPress = (artist: { id: string | number, mid?: string, name: string }) => {
    if (!musicInfo || (musicInfo.source !== 'wy' && musicInfo.source !== 'tx' && musicInfo.source !== 'kg')) return
    // 部分音源（如 QQ）的歌手数据可能缺 id，mid 也可作为标识
    const artistId = artist.id || artist.mid
    if (!artistId) {
      // id/mid 都缺失时清空自带 artists，走歌手名搜索兜底定位
      void handleShowArtistDetail(componentId, { ...musicInfo, artists: [] } as LX.Music.MusicInfoOnline)
      return
    }
    navigations.pushArtistDetailScreen(componentId, { id: String(artistId), mid: artist.mid, name: artist.name, source: musicInfo.source })
  }

  const handleAlbumPress = () => {
    if (!musicInfo) return
    if (musicInfo.source !== 'wy' && musicInfo.source !== 'tx' && musicInfo.source !== 'kg') return
    const albumId = (musicInfo.meta as any)?.albumId || musicInfo.albumId
    const albumName = musicInfo.meta?.albumName || musicInfo.albumName
    const albumMid = (musicInfo.meta as any)?.albumMid || musicInfo.albumMid || albumId
    if (!albumId || !albumName) return
    if (musicInfo.source === 'tx') {
      navigations.pushAlbumDetailScreen(componentId, { id: String(albumId), mid: albumMid, name: albumName, source: 'tx' })
    } else {
      navigations.pushAlbumDetailScreen(componentId, { id: String(albumId), name: albumName, source: musicInfo.source })
    }
  }

  const handleLikePress = useCallback(() => {
    const info = playerState.playMusicInfo.musicInfo
    if (!info) return
    const musicInfo = 'progress' in info ? info.metadata.musicInfo : info
    if (musicInfo.source === 'wy') {
      handleLikeMusic(musicInfo as LX.Music.MusicInfoOnline)
    } else if (musicInfo.source === 'tx') {
      handleTxLikeMusic(musicInfo as LX.Music.MusicInfoOnline)
    } else if (musicInfo.source === 'kg') {
      handleKgLikeMusic(musicInfo as LX.Music.MusicInfoOnline)
    }
  }, [])

  const songName = musicInfo?.name || ''
  const artistText = musicInfo?.singer || ''
  const albumName = musicInfo?.meta?.albumName || musicInfo?.albumName || ''

  const artists = musicInfo?.artists || []

  const wySongId = (musicInfo?.source === 'wy' && musicInfo.meta?.songId) || ''
  const isWyLiked = useIsWyLiked(wySongId)

  const txLikeKey = (() => {
    if (musicInfo?.source !== 'tx') return ''
    const rawSongMid = (musicInfo.meta as any)?.songmid || (musicInfo.meta as any)?.strMediaMid || musicInfo.id
    const songMid = typeof rawSongMid === 'string' && rawSongMid.startsWith('tx_') ? rawSongMid.slice(3) : rawSongMid
    const songId = (musicInfo.meta as any)?.id
    const isNumericId = songId && /^\d+$/.test(String(songId))
    return isNumericId ? String(songId) : songMid
  })()
  const isTxLiked = useIsTxLiked(txLikeKey)

  const kgSongId = (musicInfo?.source === 'kg' && ((musicInfo.meta as any)?.hash || musicInfo.meta?.songId)) || ''
  const isKgLiked = useIsKgLiked(kgSongId)

  const isLiked = musicInfo?.source === 'wy' ? isWyLiked : musicInfo?.source === 'tx' ? isTxLiked : musicInfo?.source === 'kg' ? isKgLiked : false
  const showLikeBtn = musicInfo?.source === 'wy' || musicInfo?.source === 'tx' || musicInfo?.source === 'kg'

  const handleSongNamePress = useCallback(() => {
    const songInfo = `${songName} - ${artistText}`
    clipboardWriteText(songInfo)
    toast('已复制')
  }, [songName, artistText])

  return (
    <View onLayout={onLayout} style={[styles.container, containerFixedSize, isSmallWindow && { marginTop: 8, marginBottom: 4 }]}>
      <View style={styles.songNameRow}>
        <TouchableOpacity onPress={handleSongNamePress} activeOpacity={0.6} style={styles.songNameTouch}>
          <Text
            numberOfLines={1}
            size={28}
            color={theme['c-font']}
            style={styles.songName}
          >
            {songName}
          </Text>
        </TouchableOpacity>
        {showLikeBtn && (
          <TouchableOpacity onPress={handleLikePress} activeOpacity={0.6} style={[styles.heartBtn, { borderRadius: buttonRadius(28) /* 「按钮圆角」：点赞图标按钮，可见高度 ≈ 图标 28（styles.heartBtn 无固定高） */ }]}>
            <Icon name={isLiked ? 'love-filled' : 'love'} color={isLiked ? '#ff4d4f' : theme['c-font']} size={28} />
          </TouchableOpacity>
        )}
      </View>

      {/* 徽标行是一个定高空槽：本地文件时 SourceQualityBadge 只渲染一个 marginTop:4 的
          空 View（高度 4），在线曲目才到 4 + row(9)。不定高的话它下面的歌手行 / 专辑行
          会跟着上下跳一整个行高 —— 正是用户报的「位置会发生变化」。
          空槽的内容高度恒为 BADGE_ROW，里面有没有徽标都不改布局。 */}
      <View style={badgeSlotFixedSize}>
        <SourceQualityBadge />
      </View>

      <View style={styles.artistWrapper}>
        {artists.length > 0 ? (
          <View style={styles.artistRow}>
            {artists.map((artist, index) => (
              <TouchableOpacity key={artist.id || index} style={styles.artistItem} onPress={() => { handleArtistPress(artist) }}>
                <Text numberOfLines={1} size={16} color={(theme as unknown as Record<string, string>)['c-font-secondary']}>
                  {artist.name}
                  {index < artists.length - 1 ? '、' : ''}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : (
          <TouchableOpacity style={styles.artistItem} onPress={() => { void handleShowArtistDetail(componentId, musicInfo as LX.Music.MusicInfoOnline) }}>
            <Text numberOfLines={1} size={16} color={(theme as unknown as Record<string, string>)['c-font-secondary']}>
              {artistText}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {albumName ? (
        <TouchableOpacity onPress={handleAlbumPress} disabled={musicInfo?.source !== 'wy' && musicInfo?.source !== 'tx' && musicInfo?.source !== 'kg'}>
          <Text numberOfLines={1} size={14} color={(theme as unknown as Record<string, string>)['c-font-secondary']}>
            {albumName}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  )
})

const styles = createStyle({
  container: {
    paddingHorizontal: 20,
    marginTop: 20,
    // 歌名/歌手/专辑块 ↔ 迷你歌词块的间距（2026-09-30 用户要求「歌曲歌手名再上移一点」）。
    // 信息块整体在封面页容器里是**贴底**的（space-between 的第二段），所以加大这里的
    // marginBottom = 上面这块（歌名/歌手/专辑）整体上移，而三行歌词的位置不动。
    // 这与「改 PAGE_BOTTOM_PADDING」是两回事：那个会把歌词一起上移，见 NOTES-playdetail-and-list。
    // 小屏有更紧的 override（见下方 isSmallWindow 分支），不参与这次上移。
    marginBottom: 18,
  },
  songNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  songNameTouch: {
    flex: 1,
  },
  songName: {
    flexShrink: 1,
  },
  heartBtn: {
    paddingHorizontal: 5,
  },
  artistWrapper: {
    marginBottom: 4,
  },
  // 禁折行（2026-10-13 第 73 轮）：flexWrap:'wrap' 时歌手越多行数越多，块高随之变，
  // 封面与小歌词跟着漂（用户报的「位置会发生变化」）。改成单行 + 允许收缩后，
  // 歌手行恒为 ARTIST_ROW 高；歌手名过长时由 numberOfLines={1} 省略号截断。
  artistRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  artistItem: {
    flexShrink: 1,
  },
})
