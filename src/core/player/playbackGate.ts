/**
 * 【第 188 轮】「引擎是否真的在出声」的单向读取门。
 *
 * 起播时 UI 一按播放就进入 isPlay，但音频可能还在取链/缓冲。锁屏 / 灵动岛的原生
 * Now Playing 时钟只认元数据里的正 playbackRate：提前发正速率 = 原生时钟从 0 开始
 * 按墙钟外推，等引擎真正出声再校正 → 0:05 → 0:02 的回退/冻结。
 *
 * playProgress 在慢校准/引擎事件里确认「playing 且非 buffering」后置 true；
 * 切歌 / 缓冲 / 暂停 / 停止置 false。playList / nowPlaying / resourceLoader 在发布
 * 元数据前读它：未确认时发 rate 0 + UI 进度（并丢弃引擎快照戳），确认后再发真速率
 * 与快照。这样锁屏时间与音频一起从真实位置按秒前进。
 *
 * 独立成模块是为了避免 playProgress ↔ playList 的循环依赖；只有布尔读写。
 */
let confirmed = false

export const setPlaybackConfirmed = (value: boolean) => {
  confirmed = value
}

export const isPlaybackConfirmed = () => confirmed
