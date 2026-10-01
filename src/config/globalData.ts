import { version } from '../../package.json'
import { createAppEventHub } from '@/event/appEvent'
import { createListEventHub } from '@/event/listEvent'
import { createDislikeEventHub } from '@/event/dislikeEvent'
import { createStateEventHub } from '@/event/stateEvent'
if (process.versions == null) {
  // @ts-expect-error
  process.versions = {
    app: version,
  }
} else process.versions.app = version

global.lx = {
  fontSize: 0.9,
  playerStatus: {
    isInitialized: false,
    isRegisteredService: false,
    isIniting: false,
    ignoreTrackPlayerLifecycle: false,
    userPaused: false,
    suppressUserPaused: false,
  },
  isCarMode: false,

  playerError: false,
  restorePlayInfo: null,

  isScreenKeepAwake: false,

  isPlayedStop: false,

  isEnableLog: true,
  isEnableSyncLog: false,
  isEnableUserApiLog: false,

  playerTrackId: '',

  gettingUrlId: '',

  qualityList: {},
  apis: {},
  apiInitPromise: [Promise.resolve(false), true, () => { }],

  settingActiveId: 'basic',

  homePagerIdle: true,

  // 见 core/common.ts 的 forceSyncNavActiveId()：一次性标记，请求 Home 的 PagerView
  // 强制同步到当前 navActiveId（绕过 setNavActiveId 的同值短路）。
  homePagerForceSync: false,

  // 见 event/appEvent.ts 的 jumpListPosition()：一次性标记，表示「本次切到『我的』
  // 是为了定位当前播放歌曲」。由「我的」歌曲列表挂载时消费并复位。
  // 用于兜住时序：长按迷你播放器封面时该列表可能尚未挂载，200ms 后补发的
  // jumpListPosition 事件会丢，只能靠这个标记在挂载时补做定位。
  jumpMyListPosition: false,
}

global.app_event = createAppEventHub() as typeof globalThis.app_event
global.list_event = createListEventHub()
global.dislike_event = createDislikeEventHub()
global.state_event = createStateEventHub()
