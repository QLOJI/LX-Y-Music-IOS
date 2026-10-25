// 图片缓存纪元：下拉刷新时 +1，所有远程图在 URL 末尾加 #lxcb=<纪元>。
// Fragment 不发给服务器（签名 URL 不受影响），但 FastImage/SDWebImage 按完整 URL 做缓存键，
// 等于换了一张新图 → 重新下载，从而让下拉刷新真的刷新封面。
let epoch = 0
const listeners = new Set<(epoch: number) => void>()

export const getImageEpoch = () => epoch

export const subscribeImageEpoch = (listener: (epoch: number) => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const bumpImageEpoch = () => {
  epoch += 1
  for (const listener of Array.from(listeners)) listener(epoch)
}
