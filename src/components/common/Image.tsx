import FastImage from '@d11/react-native-fast-image'
import { useTheme } from '@/store/theme/hook'
import { BorderRadius } from '@/theme'
import { createStyle } from '@/utils/tools'
import { memo, useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { View, type ViewProps, Image as _Image, Text as NativeText, StyleSheet, AppState, type ImageResizeMode, type ImageStyle, type TextStyle, type ViewStyle, type StyleProp } from 'react-native'
import { useLayout } from '@/utils/hooks'

export interface ImageProps extends ViewProps {
  style: StyleProp<ViewStyle | TextStyle | ImageStyle>
  url?: string | number | null
  cache?: boolean
  resizeMode?: ImageResizeMode
  onError?: (url: string | number) => void
}


export const defaultHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
}

const EmptyPic = memo(({ style, nativeID }: { style: ImageProps['style'], nativeID: ImageProps['nativeID'] }) => {
  const theme = useTheme()
  const { onLayout, width } = useLayout()
  const size = width * 0.36

  return (
    <View style={StyleSheet.compose({ ...styles.emptyPic, backgroundColor: theme['c-primary-light-900-alpha-200'], gap: size * 0.1 }, style)} onLayout={onLayout} nativeID={nativeID}>
      <NativeText style={{ fontSize: size, color: theme['c-primary-light-400-alpha-200'] }}>L</NativeText>
      <NativeText style={{ fontSize: size, color: theme['c-primary-light-400-alpha-200'], paddingLeft: 2 }}>X</NativeText>
    </View>
  )
})
EmptyPic.displayName = 'CommonImageEmptyPic'

const Image = memo(({ url, resizeMode = 'cover', style, onError, nativeID }: ImageProps) => {
  const [isError, setError] = useState(false)
  const urlRef = useRef(url)
  urlRef.current = url

  const handleError = useCallback(() => {
    setError(true)
    onError?.(urlRef.current!)
  }, [onError])

  useEffect(() => {
    setError(false)
  }, [url])

  // 当应用从后台返回前台时，重置错误状态以重试加载图片
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && isError) {
        setError(false)
      }
    })
    return () => { subscription.remove() }
  }, [isError])

  // url 的合法形状只有三种：require 进来的资源 id（number）、URL 字符串、空（null/undefined）。
  // 之前这里写的是 `url?.startsWith('/')`：可选链只在 url 为 null/undefined 时短路，
  // 一旦 url 是个**非空对象**（例如音源 SDK getPic 没解包就返回的请求对象
  // `{ promise, cancelHttp }`，被当成封面 URL 存进歌曲 meta / 内存缓存后传到这里），
  // `url.startsWith` 求值为 undefined 再被调用 —— 渲染期直接抛
  // 「TypeError: undefined is not a function」（Fatal，整个 App 弹错误框）。
  // 现在把「不是 string 也不是 number」一律当没有封面：走空占位，不再让脏数据炸掉渲染。
  let uri: string | undefined = typeof url == 'number'
    ? _Image.resolveAssetSource(url)?.uri
    : typeof url == 'string'
      ? url.startsWith('/') ? 'file://' + url : url
      : undefined
  const showDefault = useMemo(() => !uri || isError, [isError, uri])
  // 只有 http(s) 远程封面走 FastImage（2026-10-02 需求：重复进入详情页时封面不再先消失再显示）。
  // FastImage 底层是 SDWebImage，自带内存 + 磁盘二级缓存：同一 URL 第二次进入时命中内存缓存、
  // 当帧就有图，不再像 RN Image 那样每次重新走一遍网络/磁盘解码（表现就是「短暂空白」）。
  // 本地文件（file://）、require 资源（asset://）与 data: 一律仍走 RN Image ——
  // 它们本来就是本地读取、不存在网络往返，没必要把它们也换掉去承担行为差异。
  const isRemoteUri = typeof uri == 'string' && /^https?:\/\//i.test(uri)
  // FastImage 只认 cover/contain/stretch/center 四种，RN 的 ImageResizeMode 还多一个 repeat；
  // 全仓实际只用到 cover 与 contain，其余值统一退到 cover，避免把非法串透传给原生。
  const fastResizeMode = resizeMode === 'contain'
    ? 'contain'
    : resizeMode === 'stretch'
      ? 'stretch'
      : resizeMode === 'center'
        ? 'center'
        : 'cover'
  return (
    showDefault ? <EmptyPic style={style} nativeID={nativeID} />
      : (
        isRemoteUri
          ? (
            <FastImage
              style={style as StyleProp<ImageStyle>}
              source={{
                uri: uri!,
                headers: defaultHeaders,
                // immutable：按 URL 永久缓存、不再向服务器回验。封面 URL 是 CDN 固定串，
                // 与播放详情页大封面（PlayDetail/Vertical/Pic.tsx）同一口径。
                cache: 'immutable',
                priority: 'normal',
              }}
              onError={handleError}
              resizeMode={fastResizeMode}
              nativeID={nativeID}
            />
            )
          : (
            <_Image
              style={style as StyleProp<ImageStyle>}
              source={{
                uri: uri!,
                headers: defaultHeaders,
              }}
              onError={handleError}
              resizeMode={resizeMode}
              nativeID={nativeID}
            />
            )
        )
  )
}, (prevProps, nextProps) => {
  return prevProps.url == nextProps.url &&
    prevProps.style == nextProps.style &&
    prevProps.nativeID == nextProps.nativeID
})
Image.displayName = 'CommonImage'

export const getSize = (uri: string, success: (width: number, height: number) => void, failure?: (error: any) => void) => {
  _Image.getSize(uri, success, failure)
}
export default Image

const styles = createStyle({
  emptyPic: {
    borderRadius: BorderRadius.normal,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    paddingLeft: 2,
  },
})
