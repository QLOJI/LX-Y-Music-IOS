import { useEffect, useState } from 'react'
import { Keyboard } from 'react-native'

/**
 * 键盘显隐订阅。
 *
 * 默认只订 `keyboardDidShow` / `keyboardDidHide`（键盘**已经**弹完/收完才回调），
 * 适合「键盘落定后再排布」的场景（Popup / Dialog —— 动画中途重排会看到跳动）。
 *
 * @param {{ willShow?: boolean }} [options]
 *   willShow = true 时**同时**订 will* 与 did* 两套：
 *   iOS 的 `keyboardWillShow` 在键盘动画**开始前**就抛出，回调参数里已有
 *   endCoordinates.height，用它驱动的位移才能与键盘动画同时起跑；
 *   只订 did* 会慢一整段动画（键盘 250ms 已经升完，播放器才开始动）。
 *   同时保留 did* 是因为 Android（以及部分 iPad 外接键盘）不发 will*，只发 did*，
 *   两套都订 = 两平台都能拿到事件，重复触发只是 setState 同值、不会多渲染一帧。
 *   Android 的键盘弹出还带软输入法 resize 行为，本工程为 iOS 适配版，不额外处理。
 */
export default (options) => {
  const willShow = !!(options && options.willShow)
  const [shown, setShown] = useState(false)
  const [keyboardHeight, setKeyboardHeight] = useState(0)

  const handleKeyboardShow = (e) => {
    // const isShow = e.endCoordinates.height > 115
    // setShown(isShow)
    // setKeyboardHeight(isShow ? e.endCoordinates.height : 0)
    setShown(true)
    setKeyboardHeight(e.endCoordinates.height)
  }

  const handleKeyboardHide = () => {
    setShown(false)
    setKeyboardHeight(0)
  }

  useEffect(() => {
    const showEvents = willShow
      ? ['keyboardWillShow', 'keyboardDidShow']
      : ['keyboardDidShow']
    const hideEvents = willShow
      ? ['keyboardWillHide', 'keyboardDidHide']
      : ['keyboardDidHide']

    const subscriptions = [
      ...showEvents.map(name => Keyboard.addListener(name, handleKeyboardShow)),
      ...hideEvents.map(name => Keyboard.addListener(name, handleKeyboardHide)),
    ]

    return () => {
      subscriptions.forEach(subscription => { subscription.remove() })
    }
  }, [willShow])

  return {
    keyboardShown: shown,
    keyboardHeight,
  }
}
