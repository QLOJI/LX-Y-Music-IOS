import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { designSpacing } from '@/theme/DesignTokens'
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type ReactElement } from 'react'
import { ScrollView, View } from 'react-native'
import HistorySearch, { type HistorySearchType } from './HistorySearch'
import HotSearch, { type HotSearchType } from './HotSearch'

interface BlankViewProps {
  header?: ReactElement
  onSearch: (keyword: string) => void
}
type Source = LX.OnlineSource | 'all'

export interface BlankViewType {
  show: (source: Source) => void
}

export default forwardRef<BlankViewType, BlankViewProps>(({ header, onSearch }, ref) => {
  // const [listType, setListType] = useState<SearchState['searchType']>('music')
  const [visible, setVisible] = useState(false)
  const hotSearchRef = useRef<HotSearchType>(null)
  const historySearchRef = useRef<HistorySearchType>(null)
  const isShowHotSearch = useSettingValue('search.isShowHotSearch')
  const isShowHistorySearch = useSettingValue('search.isShowHistorySearch')
  const t = useI18n()
  const theme = useTheme()

  // 区块间距（A-4）：热门搜索 / 历史搜索 两个区块之间也用 lg(24)，与 content.paddingTop
  // 同值 —— 需求原文是「间距和前后不一致」，此前是「上方 16 / 区块间 16 / 标题下 8」三套
  // 互不相干的数字，读起来忽紧忽松。
  const cardStyle = useMemo(
    () => ({
      marginBottom: designSpacing.lg,
    }),
    [],
  )

  const handleShow = (source: Source) => {
    hotSearchRef.current?.show(source)
    historySearchRef.current?.show()
  }

  useImperativeHandle(
    ref,
    () => ({
      show(source) {
        if (visible) handleShow(source)
        else {
          setVisible(true)
          requestAnimationFrame(() => {
            handleShow(source)
          })
        }
      },
    }),
    [visible],
  )

  // 骨架（搜索框 + 类型选择器 + 区块容器）随组件挂载立刻渲染，不再等 show()：
  // 以前 `visible` 为 false 时整棵返回 null，点「取消」时结果列表先卸载、空白页又晚一帧
  // 才出现，中间那几帧整页空白就是用户看到的「整屏闪一下」（用户第 11 轮第 5 条）。
  // visible 现在只用于「首帧挂载后补一次数据拉取」的判断，不再参与渲染。
  return isShowHotSearch || isShowHistorySearch ? (
    <ScrollView>
      {header}
      <View style={styles.content}>
        {isShowHotSearch ? (
          <View style={cardStyle}>
            <HotSearch ref={hotSearchRef} onSearch={onSearch} />
          </View>
        ) : null}
        {isShowHistorySearch ? (
          <View style={cardStyle}>
            <HistorySearch ref={historySearchRef} onSearch={onSearch} />
          </View>
        ) : null}
      </View>
    </ScrollView>
  ) : (
    <View style={styles.welcome}>
      <Text size={22} color={theme['c-font-label']}>
        {t('search__welcome')}
      </Text>
    </View>
  )
})

const styles = createStyle({
  content: {
    // 「热门搜索/历史搜索」上方与搜索类型选择器之间的固定间距。
    // A-2：此前只有 paddingBottom/Horizontal，区块标题顶端几乎贴住上方胶囊行。
    // A-4（2026-10-01）：用户再次反馈「热门搜索这几个字已经靠紧了上方的歌曲/歌单/歌手/专辑栏，
    // 下方的文字间距又很大」—— md(16) 不够。这里改 lg(24)。
    // 第 19 轮第 2 条（2026-10-02）：标题自身的下间距不再单独取值，统一回 controlGap(12)，
    // 与「搜索平台」区块的「标题→胶囊」间距（HeaderBar.platformContent.paddingVertical）同值 ——
    // 用户原话「热门搜索和历史搜索下面与按钮的间距，要和搜索平台和下面按钮的间距一致，
    // 确保整个画面间距一致」。24 > 12，仍保持「标题离上一区块远、离自己的内容近」的分组关系。
    paddingTop: designSpacing.lg,
    paddingBottom: 180,
    paddingHorizontal: designSpacing.lg,
  },
  welcome: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
