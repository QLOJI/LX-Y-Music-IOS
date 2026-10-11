import { Navigation } from 'react-native-navigation'
import * as screenNames from './screenNames'
import * as navigations from './navigation'
import registerScreens from './registerScreens'
import { onAppLaunched } from './regLaunchedEvent'

let unRegisterEvent: ReturnType<
ReturnType<typeof Navigation.events>['registerScreenPoppedListener']
>

// 【第 56 轮第 2 条 → 第 61 轮第 3 条撤销】这里曾经注册过一个 componentWillAppear 提前
// 锚点（判据「即将出现的那一屏在账本里且不是栈顶」），用来把玻璃的**复位重采**边沿从
// screenPopped 挪到转场开始。返回方向改成**全程按住**之后它没有用武之地（不再复位重采），
// 整段删除——同时也去掉了「RNN 到底有没有这个监听器」这个工程内无法编译期核实的依赖。

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
  onAppLaunched(() => {
    console.log('Register app launched listener')
    void callback()
  })
}

export * from './utils'
export * from './event'
export * from './hooks'

export { init, screenNames, navigations }
