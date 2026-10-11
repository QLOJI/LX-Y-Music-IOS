import { useLrcPlay } from '@/plugins/lyric'
import { useStatusText } from '@/store/player/hook'
// import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'

export default ({ autoUpdate }: { autoUpdate: boolean }) => {
  const theme = useTheme()
  const { text } = useLrcPlay(autoUpdate)
  const statusText = useStatusText()
  // console.log('render status')

  // 【第 62 轮第 4 条】用户原话：「暂停时，迷你播放器栏的歌词区域显示空白，改为正常显示
  // 当前加载歌词」。旧写法是 `statusText || (isPlay ? text : statusText)` —— 暂停时整个
  // 表达式落到 statusText，而那个字段只在「链接获取中 / 加载中 / 缓存中…」这类瞬时状态里
  // 非空，常态是空串 ⇒ 一暂停这一行就空掉。
  // 歌词文案本身与播放态无关（useLrcPlay 的 text 就是当前行，暂停时停在最后一行不动），
  // 优先级：瞬时状态文案 > 当前歌词行。顺带去掉 useIsPlay：这里不再需要订阅播放态，
  // 少一次 playStateChanged 重渲染。
  const status = statusText || text

  return (
    <Text numberOfLines={1} size={12} color={theme['c-font']}>
      {status}
    </Text>
  )
}

// const styles = createStyle({
//   text: {
//     // fontSize: 10,
//     // lineHeight: 18,
//     // height: 18,
//     // height: '100%',
//     // backgroundColor: 'rgba(0,0,0,0.2)',
//   },
// })
