import {
  collectMusic,
  dislikeMusic,
  pause,
  play,
  playNext,
  playPrev,
  togglePlay,
  uncollectMusic,
} from '@/core/player/player'
import { markManualPause } from '@/core/player/manualPause'

export type PlayerAction =
  | 'play'
  | 'pause'
  | 'skipNext'
  | 'skipPrev'
  | 'togglePlay'
  | 'collect'
  | 'uncollect'
  | 'dislike'

export const handlePlayerAction = async(action: PlayerAction) => {
  switch (action) {
    case 'play':
      play()
      break
    case 'pause':
      // 【第 22 轮】deeplink 的暂停同样是用户主动动作：落「手动暂停」闸门
      //（core/player/manualPause.ts），防止之后被自动续播路径拉起。
      markManualPause()
      void pause()
      break
    case 'skipNext':
      void playNext()
      break
    case 'skipPrev':
      void playPrev()
      break
    case 'togglePlay':
      togglePlay()
      break
    case 'collect':
      collectMusic()
      break
    case 'uncollect':
      uncollectMusic()
      break
    case 'dislike':
      void dislikeMusic()
      break
    // default: throw new Error('Unknown action: ' + (action as any ?? ''))
  }
}
