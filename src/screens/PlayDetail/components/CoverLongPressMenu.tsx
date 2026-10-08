import { useCallback, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import type { View } from 'react-native'
import Menu, { type MenuType, type Menus } from '@/components/common/Menu'
import { addTask } from '@/core/download'
import { getPicUrl } from '@/core/music/online'
import settingState from '@/store/setting/state'
import { saveImageToPictures } from '@/utils/image'
import { toast } from '@/utils/tools'

/**
 * 播放详情页封面的长按菜单：下载歌曲 / 下载封面（**唯一实现**）。
 *
 * 【第 21 轮·优化 2（2026-10-03）】以前这段菜单内联在竖屏 Pic.tsx 里，横屏封面压根没有
 * 长按入口（用户报「横屏没有下载封面」）；而且「下载封面」自己攒了一套写沙盒 Pictures
 * 的代码，用户保存完在任何相册里都找不到。现在菜单抽成本组件，横竖屏共用：
 *  - 菜单项与动作只有这一份（竖屏 Vertical/Pic.tsx、横屏 Horizontal/Pic.tsx 都接它）；
 *  - 「下载封面」不再自己拼路径，统一走 utils/image.ts 的 saveImageToPictures
 *    （iOS 写系统相册 + 删临时文件，见那里的说明）。
 *
 * 用法（锚点由父组件提供 —— 菜单要贴着实际封面弹）：
 *   const coverRef = useRef<View>(null)
 *   const menuRef = useRef<CoverLongPressMenuType>(null)
 *   <TouchableWithoutFeedback onLongPress={() => menuRef.current?.show()}>
 *     <View ref={coverRef} collapsable={false}>…封面…</View>
 *   </TouchableWithoutFeedback>
 *   <CoverLongPressMenu ref={menuRef} anchorRef={coverRef} musicInfo={playMusicInfo.musicInfo} />
 */
export interface CoverLongPressMenuType {
  /** 以 anchorRef 指向的封面视图为锚点弹出菜单（长按回调里调用；无歌曲信息时不弹） */
  show: () => void
  hide: () => void
}

export interface CoverLongPressMenuProps {
  /**
   * 封面容器。类型写成 `{ current: View | null }` 是为了同时兼容 React 18/19 的
   * RefObject 定义（两边只差可空性），父组件直接传自己的 useRef 即可。
   */
  anchorRef: { current: View | null }
  /** 当前播放歌曲（playerState.playMusicInfo.musicInfo）；为空时不弹菜单 */
  musicInfo: LX.Player.PlayMusicInfo['musicInfo'] | null
}

const menus: Menus = [
  { action: 'download_song', label: '下载歌曲' },
  { action: 'download_pic', label: '下载封面' },
]

export default forwardRef<CoverLongPressMenuType, CoverLongPressMenuProps>(({ anchorRef, musicInfo }, ref) => {
  const menuRef = useRef<MenuType>(null)
  const [visible, setVisible] = useState(false)

  useImperativeHandle(ref, () => ({
    show() {
      const anchor = anchorRef.current
      if (!anchor || !musicInfo) return
      anchor.measure((x, y, w, h, px, py) => {
        setVisible(true)
        // 等 Menu 挂载进 Modal 之后再 show（Menu 内部再等一帧才 setVisible(true)）
        requestAnimationFrame(() => {
          menuRef.current?.show({ x: px, y: py, w, h })
        })
      })
    },
    hide() {
      menuRef.current?.hide()
      setVisible(false)
    },
  }), [anchorRef, musicInfo])

  const handleMenuPress = useCallback(({ action }: Menus[number]) => {
    if (!musicInfo) return
    switch (action) {
      case 'download_song':
        addTask(musicInfo as LX.Music.MusicInfo, settingState.setting['player.playQuality'])
        break
      case 'download_pic':
        void (async() => {
          try {
            toast('正在下载封面...', 'short')
            const picUrl = await getPicUrl({ musicInfo: musicInfo as LX.Music.MusicInfoOnline, isRefresh: true })
            const result = await saveImageToPictures(picUrl, `${musicInfo.name}_${musicInfo.singer}`)
            if (!result) return
            toast(result.savedToPhotos ? '封面已保存到相册' : `封面已保存到: ${result.path}`, 'long')
          } catch (err: any) {
            toast(`下载封面失败: ${err?.message ?? err}`, 'long')
          }
        })()
        break
      default:
        break
    }
  }, [musicInfo])

  return visible
    ? <Menu ref={menuRef} menus={menus} onPress={handleMenuPress} onHide={() => { setVisible(false) }} />
    : null
})
