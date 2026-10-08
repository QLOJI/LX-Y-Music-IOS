import { useCallback, useEffect, useRef } from 'react'
import { useHorizontalMode } from '@/utils/hooks'
import PageContent from '@/components/PageContent'
import { setComponentId, setNavActiveId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import Vertical from './Vertical'
import Horizontal from './Horizontal'
import { navigations } from '@/navigation'
import ArtistSelectorManager from '@/components/ArtistSelectorManager'
import settingState from '@/store/setting/state'
import { useI18n } from '@/lang'
import { AppState, BackHandler } from 'react-native'
import { toast } from '@/utils/tools.ts'
import commonState from '@/store/common/state'
import { useBackHandler } from '@/utils/hooks/useBackHandler.ts'

import { setSearchText as setSearchState } from '@/core/search/search'
import DownloadBall from '@/components/DownloadBall'
interface Props {
  componentId: string
}

export default ({ componentId }: Props) => {
  const isHorizontalMode = useHorizontalMode()
  const t = useI18n()
  const lastBackPressed = useRef(0)
  useEffect(() => {
    setComponentId(COMPONENT_IDS.home, componentId)

    // 冷启动（Home 第一次挂载）时按设置打开播放详情页
    if (settingState.setting['player.startupPushPlayDetailScreen']) {
      navigations.pushPlayDetailScreen(componentId)
    }

    // 【第 34 轮第 2 条】同一个开关要覆盖「每次进入软件」，不能只管冷启动那一次。
    // 用户原话：「勾选"启动后打开播放详情页"选项后，设置为每次进入软件都会打开播放详情页，
    // 而且会有一个跳转动画，动画时间和所有跳转动画时间一样」。
    // 病根：这个 effect 的依赖是 [componentId]，只在 Home 挂载时跑一次；从后台切回前台
    // 时页面早已挂载，判断根本不会重新执行（用户看到的「只有冷启动那次会开」）。
    // 现在补一条前后台监听：**从后台回到前台**就按设置再走一次同一个入口。
    //   · 只认 background → active：iOS 在来电 / 控制中心 / 系统弹窗这类「短暂非活跃」时
    //     给的是 inactive（不是 background），把 inactive 也算进来的话，拉一下控制中心
    //     回来就会莫名跳一次播放详情页；从后台回来才是用户说的「进入软件」。
    //   · 点灵动岛「跳转到播放详情页」的用户诉求走的也是这条路径：点灵动岛 = 把 App 拉回前台，
    //     入口与点 App 图标无法区分（系统不提供区分信号），所以点图标回来也会开这一页。
    //   · 转场不做任何自定义：pushPlayDetailScreen 内部走 pagePushOptions（系统默认转场），
    //     与全 app 所有跳转同一套动画 —— 这正是用户要求的「动画时间和所有跳转动画一样」。
    //   · 重复保护交给 pushPlayDetailScreen 自己的守卫（播放详情页已在栈顶时不 push、
    //     没有正在播放的歌时不 push），这里不另立一套。
    // 用宽类型存上一次的前后台状态：本工程没有 node_modules（装不了类型），不引具体类型名
    let lastAppState: string = AppState.currentState
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      const prevState = lastAppState
      lastAppState = nextState
      if (nextState !== 'active' || prevState !== 'background') return
      if (!settingState.setting['player.startupPushPlayDetailScreen']) return
      navigations.pushPlayDetailScreen(componentId)
    })

    const handleGlobalSearch = (text: string) => {
      setSearchState(text)
      setNavActiveId('nav_search')
    }

    global.app_event.on('triggerSearch', handleGlobalSearch)

    return () => {
      global.app_event.off('triggerSearch', handleGlobalSearch)
      appStateSubscription.remove()
    }
  }, [componentId])

  useBackHandler(
    useCallback(() => {
      if (commonState.componentIds.length > 1) {
        return false
      }

      if (commonState.navActiveId === 'nav_setting') {
        return false
      }

      if (commonState.navActiveId === 'nav_play_history') {
        setNavActiveId(commonState.lastNavActiveId)
        return true
      }

      const now = Date.now()
      if (lastBackPressed.current && now - lastBackPressed.current < 2000) {
        BackHandler.exitApp()
        return true
      }

      lastBackPressed.current = now
      toast(t('exit_app_tip_double_press'))
      return true
    }, [t]),
  )

  return (
    <>
      <PageContent>{isHorizontalMode ? <Horizontal componentId={componentId} /> : <Vertical componentId={componentId} />}</PageContent>
      <ArtistSelectorManager />
      {/* 网易/QQ/酷狗登录弹窗管理器已迁至 SettingDetail：RN Modal 仅在其宿主视图
          挂在窗口上时才会呈现（RCTModalHostView 的 shouldBePresented 检查 self.window），
          Home 被 push 的原生页面覆盖后视图树脱离窗口，挂在 Home 里的弹窗永远无法呈现，
          表现为设置详情页里的登录按钮点了没反应。 */}
      <DownloadBall />
    </>
  )
}
