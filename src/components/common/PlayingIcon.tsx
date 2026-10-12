import { useEffect, useRef } from 'react'
import { Animated, View } from 'react-native'
import { createStyle } from '@/utils/tools'
import { useIsPlay } from '@/store/player/hook'
import { useAppActive, useHomeCovered } from '@/store/common/hook'

export default ({ color = '#1cd0a6' }: { color?: string }) => {
  const isPlay = useIsPlay()
  // 省电门（2026-09-30）：本图标只用于 Home 内列表的「正在播放」行。Home 被压栈页
  // （播放详情等）覆盖时整棵列表不可见，循环动画仍在每帧驱动 —— 不可见即停，
  // 返回 Home 后 effect 依 isPlay/covered 变化自动重启，无观感差异。
  const homeCovered = useHomeCovered()
  // 【第 70 轮第 3 条】补一层前台门。上面那次覆盖门只管「Home 被压栈页盖住」，
  // 退后台 / 锁屏 / 控制中心时 Home 仍是栈顶 ⇒ 覆盖门是开的，4 条 loop 继续每帧驱动
  // （本 App 有后台音频、进程常驻，锁屏后这一转就是整夜）。不可见即停，口径与
  // 两块玻璃 / 跑马灯一致；回前台由 active 翻转自动重启，走的是**已有的那条**路径
  // （同一段 else 收势 + 重新起表），不新增收尾动画，观感与现在从压栈页返回时相同。
  const appActive = useAppActive()
  const active = isPlay && !homeCovered && appActive
  const anim1 = useRef(new Animated.Value(0.3)).current
  const anim2 = useRef(new Animated.Value(0.8)).current
  const anim3 = useRef(new Animated.Value(0.5)).current
  const anim4 = useRef(new Animated.Value(0.2)).current

  useEffect(() => {
    let a1: Animated.CompositeAnimation
    let a2: Animated.CompositeAnimation
    let a3: Animated.CompositeAnimation
    let a4: Animated.CompositeAnimation

    if (active) {
      const createAnimation = (anim: Animated.Value, duration: number, delay: number = 0) => {
        return Animated.loop(
          Animated.sequence([
            Animated.timing(anim, {
              toValue: 1,
              duration,
              useNativeDriver: true,
              delay,
            }),
            Animated.timing(anim, {
              toValue: 0.2,
              duration,
              useNativeDriver: true,
            }),
          ]),
        )
      }

      a1 = createAnimation(anim1, 400)
      a2 = createAnimation(anim2, 500, 100)
      a3 = createAnimation(anim3, 350, 200)
      a4 = createAnimation(anim4, 450, 50)

      a1.start()
      a2.start()
      a3.start()
      a4.start()
    } else {
      anim1.stopAnimation()
      anim2.stopAnimation()
      anim3.stopAnimation()
      anim4.stopAnimation()

      Animated.timing(anim1, { toValue: 0.2, duration: 200, useNativeDriver: true }).start()
      Animated.timing(anim2, { toValue: 0.4, duration: 200, useNativeDriver: true }).start()
      Animated.timing(anim3, { toValue: 0.2, duration: 200, useNativeDriver: true }).start()
      Animated.timing(anim4, { toValue: 0.3, duration: 200, useNativeDriver: true }).start()
    }

    return () => {
      a1?.stop()
      a2?.stop()
      a3?.stop()
      a4?.stop()
    }
  }, [active, anim1, anim2, anim3, anim4])

  return (
        <View style={styles.container}>
            <Animated.View style={[styles.bar, { backgroundColor: color, transform: [{ scaleY: anim1 }] }]} />
            <Animated.View style={[styles.bar, { backgroundColor: color, transform: [{ scaleY: anim2 }] }]} />
            <Animated.View style={[styles.bar, { backgroundColor: color, transform: [{ scaleY: anim3 }] }]} />
            <Animated.View style={[styles.bar, { backgroundColor: color, transform: [{ scaleY: anim4 }] }]} />
        </View>
  )
}

const styles = createStyle({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    width: 14,
    height: 14,
  },
  bar: {
    width: 2.5,
    height: '100%',
    borderRadius: 1,
  },
})
