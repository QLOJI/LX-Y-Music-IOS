import playerActions from '@/store/player/action'

export const setNowPlayTime = (time: number, allowBackward = false) => {
  playerActions.setNowPlayTime(time, allowBackward)
}

export const setMaxplayTime = (time: number) => {
  playerActions.setMaxplayTime(time)
}

export const setProgress = (currentTime: number, totalTime: number) => {
  playerActions.setProgress(currentTime, totalTime)
}

