import playerActions from '@/store/player/action'

export const setNowPlayTime = (time: number) => {
  playerActions.setNowPlayTime(time)
}

/** 用户主动 seek 的进度写入：绕过「开局自动位置不回退」守卫（这是用户意图）。 */
export const setUserProgress = (currentTime: number) => {
  playerActions.setProgressTime(currentTime)
}

export const setMaxplayTime = (time: number) => {
  playerActions.setMaxplayTime(time)
}

export const setProgress = (currentTime: number, totalTime: number) => {
  playerActions.setProgress(currentTime, totalTime)
}

