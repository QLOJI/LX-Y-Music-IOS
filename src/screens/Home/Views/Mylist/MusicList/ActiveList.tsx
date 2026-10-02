import { forwardRef, useImperativeHandle, useMemo, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'

import { Icon } from '@/components/common/Icon'
import { BorderWidths } from '@/theme'
import { useTheme } from '@/store/theme/hook'
import { useActiveListId, useListFetching } from '@/store/list/hook'
import listState from '@/store/list/state'
import { createStyle } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import Text from '@/components/common/Text'
import { LIST_IDS } from '@/config/constant'
import Loading from '@/components/common/Loading'

export interface ActiveListProps {
  onShowSearchBar: () => void
  onScrollToTop: () => void
  showCover: boolean
  onToggleView: () => void
  onBack?: () => void
}
export interface ActiveListType {
  setVisibleBar: (visible: boolean) => void
}

export default forwardRef<ActiveListType, ActiveListProps>(
  ({ onShowSearchBar, onScrollToTop, showCover, onToggleView, onBack }, ref) => {
    const theme = useTheme()
    // 图标按钮 height: '100%' 铺满返回栏行高 44：按 44 折算半高
    const buttonRadius = useButtonRadius()
    const currentListId = useActiveListId()
    const fetching = useListFetching(currentListId)
    const currentListName = useMemo(() => {
      switch (currentListId) {
        case LIST_IDS.TEMP:
          return global.i18n.t('list_name_temp')
        case LIST_IDS.DEFAULT:
          return global.i18n.t('list_name_default')
        case LIST_IDS.LOVE:
          return global.i18n.t('list_name_love')
        default:
          return listState.allList.find((l) => l.id === currentListId)?.name ?? ''
      }
    }, [currentListId])
    const [visibleBar, setVisibleBar] = useState(true)

    useImperativeHandle(ref, () => ({
      setVisibleBar(visible) {
        setVisibleBar(visible)
      },
    }))

    const showList = () => {
      global.app_event.changeLoveListVisible(true)
    }

    // 这里【不能】再在挂载时全局写 setActiveList(getListPrevSelectId())：
    // 1) 它是全局副作用（listState + mylistToggled 广播），而本组件只是歌曲列表的
    //    头部条，每次进入详情都会挂载一次，会覆盖掉用户刚点选的那个列表；
    // 2) getListPrevSelectId() 是异步的，返回时用户可能已经按了「返回」（本组件已
    //    卸载），迟到回调仍会把 activeListId 改回上次的列表 —— 而 NewListUI 里
    //    「activeListId != default 就打开详情覆盖层」的 effect 会因此把用户刚关掉的
    //    详情页重新打开，表现为「返回后再次进入」状态错乱。
    // 当前列表由 NewListUI.handleItemPress 在打开前写入、列表数据由 List 挂载时按
    // getListPrevSelectId() 载入，此处无需也不应再写。

    return (
      <TouchableOpacity
        onPress={onBack || showList}
        onLongPress={onScrollToTop}
        style={{
          ...styles.currentList,
          opacity: visibleBar ? 1 : 0,
          borderBottomColor: theme['c-border-background'],
        }}
      >
        <Icon
          style={styles.currentListIcon}
          color={theme['c-button-font']}
          name={onBack ? 'chevron-left' : 'chevron-right'}
          // 返回态的箭头尺寸与「设置 → 基本设置」返回按钮里的 chevron-left 一致（20）：
          // 配合 44 行高 + 槽位左右内边距 12 + 图标左内边距 12，glyph 中心正好落在
          // 基本设置返回按钮的中心（12 + 12 + 20/2 = 12 + 44/2 = 34pt）。
          size={onBack ? 20 : 12}
        />
        {fetching ? <Loading color={theme['c-button-font']} style={styles.loading} /> : null}
        {onBack
          ? (
              // 用户第 16 轮第 4 条：从「我的」进入某个列表（试听列表/我的收藏/同步列表等）时，
              // 返回栏正中显示列表名称，替代原来的「返回」两个字——不显示名字根本认不出进的是哪个列表。
              // 绝对定位 + 左右对称内边距：名称在整个栏（含两侧按钮）的水平中心，长名截断时也不被
              // 箭头/按钮挤压；pointerEvents 关掉是为了让点击穿透到整行的 onPress（返回）。
              <View style={styles.currentListName} pointerEvents="none">
                <Text style={styles.currentListNameText} numberOfLines={1} color={theme['c-button-font']}>
                  {currentListName}
                </Text>
              </View>
            )
          : (
              <Text style={styles.currentListText} numberOfLines={1} color={theme['c-button-font']}>
                {currentListName}
              </Text>
            )}
        <TouchableOpacity style={[styles.currentListBtns, { borderRadius: buttonRadius(44) }]} onPress={onToggleView}>
          <Icon color={theme['c-button-font']} name={showCover ? 'menu' : 'album'} />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.currentListBtns, { borderRadius: buttonRadius(44) }]} onPress={onShowSearchBar}>
          <Icon color={theme['c-button-font']} name="search-2" />
        </TouchableOpacity>
      </TouchableOpacity>
    )
  },
)

const styles = createStyle({
  currentList: {
    flexDirection: 'row',
    paddingRight: 2,
    // 行高 44 = 「设置 → 基本设置」返回按钮（44x44）的高度：固定槽位的高度由这一行撑起，
    // 槽内的返回栏/多选栏/搜索栏都是 absolute 铺满，所以行高一致 → 三根横条的垂直中心
    // 也一致。这里写 height（而不是槽位上写死高度）是为了让缩放口径与设置页按钮一致：
    // 设置页按钮的 44 也在 createStyle 里，两处都按 global.lx.fontSize 同步缩放，
    // 用户改字号后中心依然对齐（顶边则走不缩放的 BAR_SLOT_ALIGN_PADDING_TOP）。
    height: 44,
    alignItems: 'center',
    borderBottomWidth: BorderWidths.normal,
    // backgroundColor: 'rgba(0,0,0,0.2)',
  },
  currentListIcon: {
    // 12 = 基本设置返回按钮内 20 号图标两侧的留白 ((44 - 20) / 2)：
    // 槽位左右内边距同为 12，于是本图标的 glyph 左缘/中心与设置页返回按钮完全重合。
    paddingLeft: 12,
    paddingRight: 10,
    // paddingTop: 10,
    // paddingBottom: 0,
  },
  currentListText: {
    flex: 1,
    // minWidth: 70,
    // paddingLeft: 10,
    paddingRight: 10,
    // paddingTop: 10,
    // paddingBottom: 10,
  },
  // 【第 16 轮第 4 条】返回态（onBack）的列表名：整栏水平居中。
  // 左右内边距按两侧「最宽遮挡物」取值：右侧 = 两个 46pt 图标按钮 + 容器 paddingRight 2；
  // 左侧 = 箭头槽（paddingLeft 12 + 20 图标 + paddingRight 10 = 42）与 loading（marginRight 5）
  // 里更宽的那个，取右侧值 96 ≥ 两者，保证名称既居中又不压住任何按钮。
  currentListName: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingLeft: 96,
    paddingRight: 96,
    alignItems: 'center',
  },
  currentListNameText: {
    textAlign: 'center',
  },
  loading: {
    marginRight: 5,
  },
  currentListBtns: {
    width: 46,
    justifyContent: 'center',
    alignItems: 'center',
    height: '100%',
    // backgroundColor: 'rgba(0,0,0,0.2)',
  },
})
