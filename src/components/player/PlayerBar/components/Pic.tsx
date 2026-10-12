import { StyleSheet, View } from 'react-native'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { scaleSizeH } from '@/utils/pixelRatio'
import { designRadius } from '@/theme/DesignTokens'
import Image from '@/components/common/Image'
import { useCallback } from 'react'
import { setMusicInfo } from '@/core/player/playInfo'
import { notifyCoverLoadError } from '@/core/player/coverRetry'

// 胶囊瘦身：封面从 46 收到 40，配合容器 paddingVertical 7 把胶囊整体高度
// 从 ~64 降到 ~54（封面仍略大于 40pt 控制钮热区，视觉主体不变）
const PIC_HEIGHT = scaleSizeH(40)

const styles = StyleSheet.create({
  image: {
    width: PIC_HEIGHT,
    height: PIC_HEIGHT,
    // 迷你播放器封面走设计令牌（designRadius.sm = 4），**不接**全局「按钮圆角」设置：
    // 它不是用户点名的那八类按钮面（歌单封面/榜单/平台胶囊/搜索框/热门与历史/设置内各按钮），
    // 与小封面同族的也是令牌值。以后调整只改令牌。
    borderRadius: designRadius.sm,
  },
})

export default () => {
  const musicInfo = usePlayerMusicInfo()

  const handleError = useCallback((url: string | number) => {
    // 【第 67 轮】改走 notifyCoverLoadError：它内部就是原来的 setLoadErrorPicUrl
    //（记账口径一字未变），只是顺手把「封面自愈」那一轮重试排上（core/player/coverRetry.ts）——
    // 之前这里只记账、没有任何地方重试，于是这个账本成了永久焊点：
    // core/player/player.ts 里 `playerState.loadErrorPicUrl == url` 那道门从此永远挡着，
    // 网络恢复后封面再也回不来（用户 2026-10-12 报的就是这个）。
    notifyCoverLoadError(url as string)
    // 保留原有行为：清掉 URL，迷你播放器先显示 LX 占位图；
    // 重试成功后由 coverRetry 把 URL 放回来（并 picUpdated 重新发布给原生）。
    setMusicInfo({
      pic: null,
    })
  }, [])

  return (
    <View>
      {/* 这里曾经有一层行内 `borderRadius: buttonRadius(40)` 覆盖（全局按钮圆角默认 0），
          把令牌的 4pt 圆角压成了直角 —— 与「封面走令牌」的既有记录直接矛盾。
          已删除：圆角只由 styles.image 的令牌决定，不再有第二个真值来源。 */}
      <Image
        url={musicInfo.pic}
        style={styles.image}
        onError={handleError}
      />
    </View>
  )
}

// const styles = StyleSheet.create({
//   playInfoImg: {

//   },
// })
