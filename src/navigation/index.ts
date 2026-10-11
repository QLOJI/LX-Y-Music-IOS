import { Navigation } from 'react-native-navigation'
import * as screenNames from './screenNames'
import * as navigations from './navigation'
import registerScreens from './registerScreens'
import { onAppLaunched } from './regLaunchedEvent'

let unRegisterEvent: ReturnType<
ReturnType<typeof Navigation.events>['registerScreenPoppedListener']
>

// 【第 56 轮第 2 条】返回方向的提前锚点（componentWillAppear）。
// 该事件在**转场动画开始之前**触发，比 screenPopped（动画结束）早一整段动画——右滑返回
// 不经过 JS 的 pop 三入口、开不出露出门，只能靠它把玻璃的复位边沿从「动画收尾」挪到
// 「动画开始」（判据与理由见 navigation.handleScreenWillAppear）。
// 类型与可用性都按「可选」处理：RNN 版本未必注册了这个监听器（工程没装 node_modules，
// 无法在编译期核实），运行时 typeof 守卫 + try/catch，拿不到就静默跳过——
// 退化行为 = 改动前（screenPopped 收尾），不会因为桥不认识这个方法而启动报错。
interface ScreenWillAppearRegistry {
  registerComponentWillAppearListener?: (
    listener: (event: { componentId: string }) => void,
  ) => { remove: () => void }
}
let unRegisterWillAppearEvent: { remove: () => void } | null = null

const registerWillAppearAnchor = () => {
  if (unRegisterWillAppearEvent) unRegisterWillAppearEvent.remove()
  unRegisterWillAppearEvent = null
  try {
    const registry = Navigation.events() as unknown as ScreenWillAppearRegistry
    if (typeof registry.registerComponentWillAppearListener != 'function') return
    unRegisterWillAppearEvent = registry.registerComponentWillAppearListener(({ componentId }) => {
      navigations.handleScreenWillAppear(componentId)
    })
  } catch {}
}

const init = (callback: () => void | Promise<void>) => {
  // Register all screens on launch
  registerScreens()

  if (unRegisterEvent) unRegisterEvent.remove()

  Navigation.setDefaultOptions({
    // animations: {
    //   setRoot: {
    //     waitForRender: true,
    //   },
    // },
  })
  unRegisterEvent = Navigation.events().registerScreenPoppedListener(({ componentId }) => {
    navigations.handleScreenPopped(componentId)
  })
  registerWillAppearAnchor()
  onAppLaunched(() => {
    console.log('Register app launched listener')
    void callback()
  })
}

export * from './utils'
export * from './event'
export * from './hooks'

export { init, screenNames, navigations }
