import { useRef, forwardRef, useImperativeHandle, useEffect } from 'react'
import Button from '@/components/common/Button'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { applyOpacity } from '@/utils/colorOpacity'
import { useButtonRadius } from '@/utils/buttonRadius'
import Modal, { type ModalType } from './Modal'
import { type ListInfoItem, type Source } from '@/store/songlist/state'
import { createStyle } from '@/utils/tools'
import { SvgIcon } from '@/components/common/Icon'
import { designRadius, designSpacing } from '@/theme/DesignTokens'

// export interface OpenListProps {
//   onTagChange: (name: string, id: string) => void
// }

interface OpenListProps {
  onOpenDetail: (item: ListInfoItem) => void
}
export interface OpenListType {
  setInfo: (source: Source) => void
}


export default forwardRef<OpenListType, OpenListProps>(({ onOpenDetail }, ref) => {
  const theme = useTheme()
  const buttonOpacity = useSettingValue('theme.buttonOpacity')
  // 「按钮圆角」：圆钮的行内覆盖（静态 borderRadius 原样保留作兜底）
  const buttonRadius = useButtonRadius()
  const modalRef = useRef<ModalType>(null)
  const songlistInfoRef = useRef<{ source: Source }>({ source: 'kw' })

  useImperativeHandle(ref, () => ({
    setInfo(source) {
      songlistInfoRef.current.source = source
    },
  }))

  useEffect(() => {
    const handleOpenModal = (source: Source) => {
      songlistInfoRef.current.source = source
      modalRef.current?.show(source)
    }
    (global.app_event as any).on('_openSonglistModal', handleOpenModal)
    return () => {
      (global.app_event as any).off('_openSonglistModal', handleOpenModal)
    }
  }, [])

  const handleOpenSonglist = (id: string) => {
    // console.log(id, songlistInfoRef.current.source)
    // navigations.pushSonglistDetailScreen(commonState.componentIds.home!, {
    //   play_count: undefined,
    //   id,
    //   author: '',
    //   name: '',
    //   img: undefined,
    //   desc: undefined,
    //   source: songlistInfoRef.current.source,
    // })
    onOpenDetail({
      play_count: undefined,
      id,
      author: '',
      name: '',
      img: undefined,
      desc: undefined,
      source: songlistInfoRef.current.source,
    })
  }

  // const handleSourceChange: ModalProps['onSourceChange'] = (source) => {
  //   songlistInfoRef.current.source = source
  // }

  return (
    <>
      <Button
        style={[
          {
            ...styles.button,
            // 「通过 ID 打开歌单」圆钮的底色随按钮透明度淡出，只改颜色 alpha，不用容器 opacity。
            backgroundColor: applyOpacity(theme['c-button-background'], buttonOpacity),
          },
          // 圆钮圆角随「按钮圆角」设置行内覆盖；高度取 styles.button 的源值 32（圆钮自身高度）
          { borderRadius: buttonRadius(32) },
        ]}
        onPress={() => modalRef.current?.show(songlistInfoRef.current.source)}
      >
        <SvgIcon name="plus" size={20} color={theme['c-primary']} />
      </Button>
      <Modal ref={modalRef} onOpenId={handleOpenSonglist} />
    </>
  )
})

const styles = createStyle({
  button: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: designSpacing.sm,
    borderRadius: designRadius.pill,
  },
})
