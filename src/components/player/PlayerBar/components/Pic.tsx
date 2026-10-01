import { StyleSheet, View } from 'react-native'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { scaleSizeH } from '@/utils/pixelRatio'
import { designRadius } from '@/theme/DesignTokens'
import Image from '@/components/common/Image'
import { useCallback } from 'react'
import { setLoadErrorPicUrl, setMusicInfo } from '@/core/player/playInfo'

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
    setLoadErrorPicUrl(url as string)
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
