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
    // 原内联 12 与旧 designRadius.sm 同值：改用令牌引用，让迷你封面跟随
    // 本次倒角整体下调（12→6，向 REF 同元素 2~4 的量级靠拢），以后调整只改令牌
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
