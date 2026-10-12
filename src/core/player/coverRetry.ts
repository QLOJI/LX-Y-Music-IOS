import { AppState } from 'react-native'
import { isActive } from '@/utils/tools'
import { getPicPath } from '@/core/music'
import { setLoadErrorPicUrl, setMusicInfo } from '@/core/player/playInfo'
import playerState from '@/store/player/state'

/**
 * 【第 67 轮】播放器级「封面自愈」驱动器。
 *
 * 用户原话（2026-10-12）：「当我网络不太好，然后歌曲封面没有加载出来，然后换了好的网络后，
 * 封面不会自动加载了，需要增加自动刷新机制」。
 *
 * 为什么这是个结构性洞：封面 URL 一旦失败过一次，工程里有两条路会把它**永久焊死**，
 * 而没有任何一处会把它解开 ——
 *   ① `playerState.loadErrorPicUrl`（在 `components/player/PlayerBar/components/Pic.tsx`
 *      的 onError 里写入）：`core/player/player.ts` 的两处 `getPicPath` 回调都拿它当
 *      「这个 URL 试过了、别再设了」的判据，而这个账本**全仓没有任何清除点**；
 *   ② 同一个 onError 还会把 `musicInfo.pic` 置成 null —— 于是封面 URL 从播放器状态里彻底
 *      消失，连重试的入口（一个 URL）都没有了。
 * 原生那条链路（锁屏 / 灵动岛的 MPMediaItemArtwork）另有一份同样的焊死（`AppDelegate.mm`
 * 的 `LXNowPlayingArtworkTask`）：第 67 轮在原生侧一并修掉，并加了同一套退避重试
 * （见 `LXSetNowPlayingArtwork` 完成回调的注释）—— 两层各自独立生效，谁也不依赖谁。
 *
 * 本模块负责 JS 这半边：网络 / 音源恢复后**自己把封面取回来**。
 * 三个触发点（工程里没有 NetInfo 依赖，也不为这个功能引一个 —— 那要动 pod 与权限面）：
 *   · 图片真的加载失败时（`Pic.tsx` 的 onError → `notifyCoverLoadError`）；
 *   · 切歌（换了歌就是一次新机会；同时兜住「起播时 getPicPath 自己就失败了、连一张图都
 *     没试过」那条路 —— 那条路根本不会触发 onError）；
 *   · 回到前台（网络多半就是在这段时间里恢复的，立刻补一次，不等退避台阶走完）。
 *
 * 节奏：3s → 6s → 12s → 24s → 48s → 60s 封顶，之后每 60s 一次，直到封面到手为止。
 * 60s 封顶是为了「这一首的封面地址真的是死链」时不要变成请求风暴；不设次数上限，是因为
 * 用户报的正是「网络恢复后封面再也不回来」，任何有限次数都会在长断网下退化回同一个洞。
 * 只在前台计时（后台主线程定时器本来就停摆，且后台重试没有意义）；换歌清零重来。
 * 封面正常时**一拍都不会排**（`runCoverRetry` 第一件事就是判「封面已经好了 → 收摊」），
 * 所以稳态下这个模块不产生任何常驻定时器。
 */
const COVER_RETRY_BASE_MS = 3000
const COVER_RETRY_MAX_MS = 60000

let retryTimer: ReturnType<typeof setTimeout> | null = null
/** 这一轮重试属于哪首歌：歌曲变了就清零台阶，避免新歌一起步就等 60s */
let retryMusicId: string | null = null
let retryAttempt = 0

function clearRetryTimer() {
  if (retryTimer != null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/** 封面现在是好的吗（有 URL、且不是那个失败过的 URL）—— 判据与 `core/init/common.ts` 的动态背景同源 */
function isCoverOk() {
  const pic = playerState.musicInfo.pic
  return typeof pic == 'string' && pic.length > 0 && pic != playerState.loadErrorPicUrl
}

function armRetry() {
  clearRetryTimer()
  const attempt = retryAttempt
  const delay = Math.min(COVER_RETRY_BASE_MS * 2 ** attempt, COVER_RETRY_MAX_MS)
  retryTimer = setTimeout(() => {
    retryTimer = null
    retryAttempt += 1
    void runCoverRetry()
  }, delay)
}

async function runCoverRetry() {
  const musicInfo = playerState.playMusicInfo.musicInfo
  // 没在放歌 / 已经换歌：这一轮作废（换歌那条路会由 kickCoverRetry 另起一轮）
  if (!musicInfo || musicInfo.id != retryMusicId) return
  // 封面已经好了：收摊（常态下每首歌最多走到这里一次，之后再也没有定时器）
  if (isCoverOk()) return
  // 后台不重试：主线程定时器本就停摆，回到前台由 AppState 那条立刻补一次
  if (!isActive()) {
    armRetry()
    return
  }

  // 解开焊死的第 ① 条：不清这个账本，`player.ts` 里
  // `playerState.loadErrorPicUrl == url` 那道门会把取回来的同一个 URL 再挡掉一次
  if (playerState.loadErrorPicUrl) setLoadErrorPicUrl('')

  try {
    const url = await getPicPath({ musicInfo, listId: playerState.playMusicInfo.listId })
    // 期间换了歌 / 停了：本次结果作废（新歌有自己的那一轮）
    if (musicInfo.id != playerState.playMusicInfo.musicInfo?.id) return
    if (url && playerState.musicInfo.pic != url) {
      // 解开焊死的第 ② 条：把 URL 放回播放器状态，Image / FastImage 才有东西可重试
      setMusicInfo({ pic: url })
      // 与 player.ts 的既有口径一致：picUpdated 会把新封面重新发布给原生
      //（锁屏 / 灵动岛的封面走 updatePic → delayUpdateMusicInfo，这一脚不能省）
      global.app_event.picUpdated()
    }
  } catch {
    // getPicPath 自己失败（音源不可达等）：什么都不做，交给下一拍
  }
  armRetry()
}

/** 停止重试并清账（封面好了会自己停；换歌 / 停播时也走这里） */
export function stopCoverRetry() {
  clearRetryTimer()
  retryMusicId = null
  retryAttempt = 0
}

/**
 * 起一轮 / 续一轮重试（幂等）。封面加载失败（`Pic.tsx` 的 onError）、切歌、回前台
 * 三个触发点都走这里。
 */
export function kickCoverRetry() {
  const id = playerState.playMusicInfo.musicInfo?.id ?? null
  if (id == null) {
    stopCoverRetry()
    return
  }
  // 换歌：台阶从头走（新歌不该继承上一首走到一半的 60s 台阶）
  if (id != retryMusicId) {
    retryMusicId = id
    retryAttempt = 0
  }
  // 已经有一拍在等：什么都不用做，那一拍会走到同一段逻辑
  if (retryTimer != null) return
  armRetry()
}

/**
 * 封面加载失败的通知口。`Pic.tsx` 的 onError 调它（**替代**直接调 `setLoadErrorPicUrl`：
 * 记完账顺手把重试起起来，避免「记了账却没人重试」这种两处各写一半的写法）。
 */
export function notifyCoverLoadError(url: string) {
  if (url) setLoadErrorPicUrl(url)
  kickCoverRetry()
}

/** 注册两个触发点（由 `core/init/player/player.ts` 调一次） */
export function initCoverRetry() {
  AppState.addEventListener('change', (state) => {
    // 回到前台：网络可能刚恢复，立刻补一次，不等退避台阶
    if (state == 'active') kickCoverRetry()
  })
  global.state_event.on('playMusicInfoChanged', () => {
    kickCoverRetry()
  })
}
