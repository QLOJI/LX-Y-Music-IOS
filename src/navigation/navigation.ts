import { Navigation, type Options } from 'react-native-navigation'


import {
  HOME_SCREEN,
  PLAY_DETAIL_SCREEN,
  SONGLIST_DETAIL_SCREEN,
  SIMILAR_SONGS_SCREEN,
  COMMENT_SCREEN, ARTIST_DETAIL_SCREEN, ALBUM_DETAIL_SCREEN, DOWNLOAD_MANAGER_SCREEN,
  SETTING_DETAIL_SCREEN,
} from './screenNames'

import themeState from '@/store/theme/state'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import commonState from '@/store/common/state'
import commonActions from '@/store/common/action'
import { COMPONENT_IDS } from '@/config/constant'
import { getStatusBarStyle } from './utils'
import { type ListInfoItem } from '@/store/songlist/state'
import { getCachedBgPicColor } from '@/utils/nativeModules/utils'

// const store = getStore()
// const getTheme = () => getter('common', 'theme')(store.getState())


// 集中管理各界面 push 的进行中状态，防止快速重复点击/滑动导致界面卡死。
const pendingPushes = new Set<string>()
const isTopScreen = (id: COMPONENT_IDS) => {
  const ids = commonState.componentIds
  return ids.length > 0 && ids[ids.length - 1]?.name === id
}
interface StartPushOptions {
  /** 允许顶层已是同类型页面时再次 push（如歌手详情互跳） */
  allowSameTop?: boolean
  /**
   * 顶层残留自愈：pop 事件丢失（转场被取消等）会让账本里残留“详情页在栈顶”的
   * 记录，此后用户在列表页点击会因 isTopScreen 命中而被静默吞掉（点了没反应）。
   * 开启后：命中同类型顶层时视为账本残留，清掉该条目并放行 push。
   * 仅用于“从列表页进入详情页”的场景——用户能点到列表，说明详情页必然不在栈顶。
   */
  recoverStaleTop?: boolean
}
// ---- 转场窗口（2026-10-01）：让底部玻璃在整段页面转场期间保持暂停 ----
// 现象：每次切换画面（进详情页 / 返回），底部 tab 栏和迷你播放器都会短暂闪一下。
// 原因：玻璃每帧都在采「自己背后那一块屏幕」当折射源，而转场期间那块背景是
// 「旧页正在滑走 + 新页正在盖上来」的中间态——采进胶囊就是那一下。省电门
// （useHomeCovered / useScreenCovered）只在**账本变化**时暂停：push 时新页
// setComponentId 发生在它自己 mount 之后（转场已经开始若干帧），pop 时
// screenPopped 事件也早于转场结束，两头都盖不住整段转场。
// 这里在**发起 push 的那一刻**就把玻璃按住，并按 RNN 系统默认转场时长（iOS 默认
// 0.35s）留一段窗口；pop 事件再续一次窗口（该事件无论落在转场头还是尾，这个窗口
// 都能把整段转场罩住）。窗口结束后玻璃恢复，下一帧重捕获的是已定格的背景。
const NAV_TRANSITION_SETTLE_MS = 420
let navTransitionTimer: ReturnType<typeof setTimeout> | null = null
function beginNavTransitionWindow() {
  if (navTransitionTimer) clearTimeout(navTransitionTimer)
  commonActions.setNavTransitioning(true)
  navTransitionTimer = setTimeout(() => {
    navTransitionTimer = null
    commonActions.setNavTransitioning(false)
  }, NAV_TRANSITION_SETTLE_MS)
}

const startPush = (id: COMPONENT_IDS, options: StartPushOptions = {}) => {
  if (pendingPushes.has(id)) return false
  if (isTopScreen(id)) {
    if (!options.allowSameTop && !options.recoverStaleTop) return false
    const ids = commonState.componentIds
    const stale = ids[ids.length - 1]
    if (stale) commonActions.removeComponentId(stale.id)
  }
  pendingPushes.add(id)
  // 玻璃转场窗口：必须在 Navigation.push 之前开，晚一帧就会采到转场中间态
  beginNavTransitionWindow()
  // 安全兜底：即使 push 的 Promise 始终不结算（如 RNN 返回 undefined 或原生转场挂起），
  // 也确保锁最终释放，避免界面永久卡死只能重启。
  setTimeout(() => { endPush(id) }, 800)
  return true
}
const endPush = (id: COMPONENT_IDS) => { pendingPushes.delete(id) }
// pop 完成（返回按钮/系统返回）时统一处理：清账本条目 + 立即释放该类型页面的
// push 锁。pop 已完成即不存在进行中的同名 push；若不释放，用户“返回后立刻
// 再点同一入口”会在 800ms 兜底锁窗口内被静默吞掉（表现为点了没反应）。
export const handleScreenPopped = (componentId: string) => {
  const target = commonState.componentIds.find(item => item.id === componentId)
  commonActions.removeComponentId(componentId)
  // 转场窗口续期：见 beginNavTransitionWindow。该事件可能落在返回转场的开头
  // （此时正好罩住整段返回动画），也可能落在结尾（再晚 420ms 恢复，背景已定格，
  // 代价只是这一小段继续暂停渲染）。
  beginNavTransitionWindow()
  if (target) endPush(target.name)
}
const guardPush = async(promise: Promise<string> | undefined, id: COMPONENT_IDS): Promise<void> => {
  try {
    await promise
  } catch {}
  endPush(id)
}

/**
 * 页面容器的原生背景色（push 转场期间 / 首屏挂载时可见）。
 *
 * 这些时刻页面内容还没画出来，原生容器只显示这一块纯色；而开了动态背景/自定义背景的页面
 * 实际是「整屏模糊封面 + 底色」的图片背景，浅色主题的 c-content-background 是纯白，
 * 白色容器与彩色封面形成明显色差——这正是「点迷你播放器进播放详情页闪白」的原生侧来源。
 *
 * 因此优先用该封面图的平均色（页面背景层解析后已缓存，见 utils.getCachedBgPicColor）：
 * 转场底色与目的页背景接近，不再有白色块跳动。取不到时（未开背景图 / 冷启动第一次进页面，
 * 平均色还没算出来）退回主题底色，与改动前行为一致。
 */
const getPushBackgroundColor = (theme: LX.ActiveTheme) => {
  const bgPic = commonState.bgPic || settingState.setting['theme.customBgPicPath']
  if (!bgPic) return theme['c-main-background']
  return getCachedBgPicColor(bgPic, Number(settingState.setting['theme.blur']) || 0) ?? theme['c-content-background']
}

// 方向策略（一个包适配 iPhone/iPad）：
// 各页面已显式声明 orientation: ['portrait', 'landscape']，实际可旋转范围由系统级
// Info.plist 裁决——iPhone 系统仅竖屏 -> 实际只能竖屏；iPad 系统竖横均支持 -> 可竖可横
// （横屏时走响应式横屏布局）。不再提供手动横屏开关。
// 注意：RNN 只识别 options.layout.orientation，写在 options 顶层不会生效。

/**
 * 全 app 所有 push 的统一 options（播放详情 / 歌单详情 / 评论 / 歌手 / 专辑 / 设置详情 /
 * 下载管理 / 相似歌曲，共 8 个入口共用这一处定义）。
 *
 * 【改这里之前先读完：为什么绝不配置 animation(s)】
 * 本工程曾给 push 配 RNN 自定义转场（translationX 全屏滑动，模板以注释死代码残留在本文件
 * 下方 pushSettingScreen 中）。但 RNN iOS 的自定义转场依赖 uiManagerDidPerformMounting 时序
 * 启动、且被取消时永不回调 completeTransition——真实事故是「JS 空闲（未播放音乐）时 push
 * 整栈卡死、转场期间被再次导航同样卡死」。此后全 app 移除了所有自定义转场与共享元素转场，
 * 统一走 RNN 系统默认转场。
 * 「所有页面跳转都用歌曲评论页的转场参数」就落地在这个决定上：评论页当前同样没有任何自定义
 * 参数、走系统默认；把 8 处 push 收敛到本工厂即达成一致。新增 animations /
 * sharedElementTransitions 字段 = 回退到已踩爆的坑，禁止。
 *
 * 工厂只收口那些「本来就该一致、却各写各的」的字段：topBar / statusBar / navigationBar /
 * layout（含安全区）。唯一页面级例外：pushSettingDetailScreen 单独保留 gestureEnabled: false。
 */
export const pagePushOptions = (theme: LX.ActiveTheme): Options => ({
  topBar: {
    visible: false,
    height: 0,
    drawBehind: false,
  },
  statusBar: {
    drawBehind: true,
    visible: true,
    style: getStatusBarStyle(theme.isDark),
    backgroundColor: 'transparent',
  },
  navigationBar: {
    visible: true,
    backgroundColor: theme['c-content-background'],
  },
  layout: {
    orientation: ['portrait', 'landscape'],
    componentBackgroundColor: getPushBackgroundColor(theme),
    fitSystemWindows: false,
    // @ts-expect-error RNN 运行期支持的安全区选项，当前类型未声明
    safeAreaInsets: {
      top: 'always',
      bottom: 'always',
    },
  },
})


export async function pushHomeScreen() {
  // iOS 安全区适配：默认给所有 screen 顶部/底部均保留安全区。
  // 顶部安全区刘海/状态栏由 RNN 原生统一处理，避免 SizeView 在 iOS 上
  // StatusBar.currentHeight 为 0 导致 Header 被刘海遮挡。
  Navigation.setDefaultOptions({
    layout: {
      // @ts-expect-error RNN 运行期支持的安全区选项，当前类型未声明
      safeAreaInsets: {
        top: 'always',
        bottom: 'always',
      },
    },
  })

  /*
    Navigation.setDefaultOptions({
      topBar: {
        background: {
          color: '#039893',
        },
        title: {
          color: 'white',
        },
        backButton: {
          title: '', // Remove previous screen name from back button
          color: 'white',
        },
        buttonColor: 'white',
      },
      statusBar: {
        style: 'light',
      },
      layout: {
        orientation: ['portrait'],
      },
      bottomTabs: {
        titleDisplayMode: 'alwaysShow',
      },
      bottomTab: {
        textColor: 'gray',
        selectedTextColor: 'black',
        iconColor: 'gray',
        selectedIconColor: 'black',
      },
    })
  */

  const theme = themeState.theme

  return Navigation.setRoot({
    root: {
      stack: {
        children: [
          {
            component: {
              name: HOME_SCREEN,
              options: {
                topBar: {
                  visible: false,
                  height: 0,
                  drawBehind: false,
                },
                statusBar: {
                  drawBehind: true,
                  visible: true,
                  style: getStatusBarStyle(theme.isDark),
                  backgroundColor: 'transparent',
                },
                navigationBar: {
                  visible: true,
                  backgroundColor: theme['c-content-background'],
                },
                layout: {
                  orientation: ['portrait', 'landscape'],
                  componentBackgroundColor: getPushBackgroundColor(theme),
                  fitSystemWindows: false,
                  // @ts-expect-error RNN 运行期支持的安全区选项，当前类型未声明
                  safeAreaInsets: {
                    top: 'always',
                    bottom: 'always',
                  },
                },
                gestureEnabled: false,
              },
            },
          },
        ],
      },
    },
  })
}

export function pushPlayDetailScreen(componentId: string) {
  if (!startPush(COMPONENT_IDS.playDetail)) return
  // 未载入任何歌曲时不打开播放详情页，避免空状态导致卡死
  if (!playerState.playMusicInfo.musicInfo) {
    endPush(COMPONENT_IDS.playDetail)
    return
  }
  requestAnimationFrame(() => {
    const theme = themeState.theme

    void guardPush(Navigation.push(componentId, {
      component: {
        name: PLAY_DETAIL_SCREEN,
        // 转场与 options 统一走 pagePushOptions：系统默认转场，不能加自定义 animations
        // （历史卡死事故与理由见该常量注释）。
        options: pagePushOptions(theme),
      },
    }),
    COMPONENT_IDS.playDetail)
  })
}

export function pushSonglistDetailScreen(componentId: string, info: ListInfoItem) {
  if (!startPush(COMPONENT_IDS.songlistDetail)) return
  const theme = themeState.theme

  requestAnimationFrame(() => {
    void guardPush(Navigation.push(componentId, {
      component: {
        name: SONGLIST_DETAIL_SCREEN,
        passProps: {
          info,
          // 独立 push 时没有外部 onBack，详情页的返回按钮需要 componentId 才能pop自己
          componentId,
        },
        // 转场与 options 统一走 pagePushOptions（详见该常量注释）
        options: pagePushOptions(theme),
      },
    }),
    COMPONENT_IDS.songlistDetail)
  })
}
export function pushCommentScreen(componentId: string) {
  if (!startPush(COMPONENT_IDS.comment)) return
  /*
    Navigation.setDefaultOptions({
      topBar: {
        background: {
          color: '#039893',
        },
        title: {
          color: 'white',
        },
        backButton: {
          title: '', // Remove previous screen name from back button
          color: 'white',
        },
        buttonColor: 'white',
      },
      statusBar: {
        style: 'light',
      },
      layout: {
        orientation: ['portrait'],
      },
      bottomTabs: {
        titleDisplayMode: 'alwaysShow',
      },
      bottomTab: {
        textColor: 'gray',
        selectedTextColor: 'black',
        iconColor: 'gray',
        selectedIconColor: 'black',
      },
    })
  */
  requestAnimationFrame(() => {
    const theme = themeState.theme

    void guardPush(Navigation.push(componentId, {
      component: {
        name: COMMENT_SCREEN,
        // 评论页是「统一转场」的基准：同样不配自定义参数、走系统默认，详见 pagePushOptions 注释
        options: pagePushOptions(theme),
      },
    }),
    COMPONENT_IDS.comment)
  })
}

// 【危险·勿恢复】下面这段被整体注释的 pushSettingScreen 里保留着 RNN 自定义转场
// （translationX 全屏滑动 duration:300）模板——它正是当年导致「整栈卡死」事故的写法，
// 仅作历史留档，禁止照抄恢复；原因见上方 pagePushOptions 注释。
// export function pushSettingScreen(componentId: string) {
//   /*
//     Navigation.setDefaultOptions({
//       topBar: {
//         background: {
//           color: '#039893',
//         },
//         title: {
//           color: 'white',
//         },
//         backButton: {
//           title: '', // Remove previous screen name from back button
//           color: 'white',
//         },
//         buttonColor: 'white',
//       },
//       statusBar: {
//         style: 'light',
//       },
//       layout: {
//         orientation: ['portrait'],
//       },
//       bottomTabs: {
//         titleDisplayMode: 'alwaysShow',
//       },
//       bottomTab: {
//         textColor: 'gray',
//         selectedTextColor: 'black',
//         iconColor: 'gray',
//         selectedIconColor: 'black',
//       },
//     })
//   */
//     const theme = themeState.theme

//     void Navigation.push(componentId, {
//       component: {
//         name: SETTING_SCREEN,
//         options: {
//           topBar: {
//             visible: false,
//             height: 0,
//             drawBehind: false,
//           },
//           statusBar: {
//             drawBehind: true,
//             visible: true,
//             style: getStatusBarStyle(theme.isDark),
//             backgroundColor: 'transparent',
//           },
//           navigationBar: {
//             // visible: false,
//             backgroundColor: theme['c-content-background'],
//           },
//           layout: {
//             componentBackgroundColor: theme['c-content-background'],
//             fitSystemWindows: false,
//           },
//           animations: {
//             push: {
//               content: {
//                 translationX: {
//                   from: windowSizeTools.getSize().width,
//                   to: 0,
//                   duration: 300,
//                 },
//               },
//             },
//             pop: {
//               content: {
//                 translationX: {
//                   from: 0,
//                   to: windowSizeTools.getSize().width,
//                   duration: 300,
//                 },
//               },
//             },
//           },
//         },
//       },
//   })
// }

/*
export function pushSingleScreenApp() {
  Navigation.setRoot({
    root: {
      stack: {
        children: [{
          component: {
            name: SINGLE_APP_SCREEN,
            options: {
              topBar: {
                title: {
                  text: 'SINGLE SCREEN APP',
                },
                leftButtons: [
                  {
                    id: 'nav_user_btn',
                    icon: require('assets/icons/ic_nav_user.png'),
                    color: 'white',
                  },
                ],
                rightButtons: [
                  {
                    id: 'nav_logout_btn',
                    icon: require('assets/icons/ic_nav_logout.png'),
                    color: 'white',
                  },
                ],
              },
            },
          },
        }],
      },
    },
  })
}

export function pushTabBasedApp() {
  Navigation.setRoot({
    root: {
      bottomTabs: {
        children: [{
          stack: {
            children: [{
              component: {
                name: TAB1_SCREEN,
                options: {
                  topBar: {
                    title: {
                      text: 'TAB 1',
                    },
                    leftButtons: [
                      {
                        id: 'nav_user_btn',
                        icon: require('assets/icons/ic_nav_user.png'),
                        color: 'white',
                      },
                    ],
                    rightButtons: [
                      {
                        id: 'nav_logout_btn',
                        icon: require('assets/icons/ic_nav_logout.png'),
                        color: 'white',
                      },
                    ],
                  },
                },
              },
            }],
            options: {
              bottomTab: {
                icon: require('assets/icons/ic_tab_home.png'),
                testID: 'FIRST_TAB_BAR_BUTTON',
                text: 'Tab1',
              },
            },
          },
        },
        {
          stack: {
            children: [{
              component: {
                name: TAB2_SCREEN,
                options: {
                  topBar: {
                    title: {
                      text: 'TAB 2',
                    },
                    leftButtons: [
                      {
                        id: 'nav_user_btn',
                        icon: require('assets/icons/ic_nav_user.png'),
                        color: 'white',
                      },
                    ],
                    rightButtons: [
                      {
                        id: 'nav_logout_btn',
                        icon: require('assets/icons/ic_nav_logout.png'),
                        color: 'white',
                      },
                    ],
                  },
                },
              },
            }],
            options: {
              bottomTab: {
                icon: require('assets/icons/ic_tab_menu.png'),
                testID: 'SECOND_TAB_BAR_BUTTON',
                text: 'Tab2',
              },
            },
          },
        }],
      },
    },
  })
}
 */
export function pushArtistDetailScreen(componentId: string, artistInfo: { id: string, mid?: string, name: string, picUrl?: string, source?: string }) {
  // allowSameTop: 允许从「歌手详情页」跳转到另一个「歌手详情页」（如相似歌手入口），
  // 否则 startPush 会因 isTopScreen(ARTIST_DETAIL) 直接拦截，导致相似歌手点击无响应。
  if (!startPush(COMPONENT_IDS.ARTIST_DETAIL, { allowSameTop: true })) return
  const theme = themeState.theme
  void guardPush(Navigation.push(componentId, {
    component: {
      name: ARTIST_DETAIL_SCREEN,
      passProps: {
        artistInfo,
      },
      // 转场与 options 统一走 pagePushOptions（详见该常量注释）
      options: pagePushOptions(theme),
    },
  }),
  COMPONENT_IDS.ARTIST_DETAIL)
}

export function pushAlbumDetailScreen(componentId: string, albumInfo: any) {
  if (!startPush(COMPONENT_IDS.ALBUM_DETAIL_SCREEN)) return
  const theme = themeState.theme
  void guardPush(Navigation.push(componentId, {
    component: {
      name: ALBUM_DETAIL_SCREEN,
      passProps: {
        albumInfo,
      },
      // 转场与 options 统一走 pagePushOptions（详见该常量注释）
      options: pagePushOptions(theme),
    },
  }),
  COMPONENT_IDS.ALBUM_DETAIL_SCREEN)
}

export function pushSettingDetailScreen(componentId: string, settingId: string) {
  if (!startPush(COMPONENT_IDS.SETTING_DETAIL, { recoverStaleTop: true })) return
  const theme = themeState.theme
  void guardPush(Navigation.push(componentId, {
    component: {
      name: SETTING_DETAIL_SCREEN,
      passProps: {
        settingId,
      },
      options: {
        ...pagePushOptions(theme),
        // 唯一页面级例外：关闭侧滑返回。原始理由是「边缘滑动会打断转场，RNN iOS 自定义
        // 转场被取消时不回调 completeTransition，整个导航栈失去交互（卡死）」；自定义转场
        // 现已全部移除，理论上可像评论页一样放开侧滑，但设置页高频进出、且本工程出过
        // 整栈卡死事故，未做真机回归前不擅自放开（是否放开请主控/真机裁决）。
        gestureEnabled: false,
      },
    },
  }), COMPONENT_IDS.SETTING_DETAIL)
}


export function pushDownloadManagerScreen(componentId: string) {
  if (!startPush(COMPONENT_IDS.DOWNLOAD_MANAGER)) return
  const theme = themeState.theme
  void guardPush(Navigation.push(componentId, {
    component: {
      name: DOWNLOAD_MANAGER_SCREEN,
      // 转场与 options 统一走 pagePushOptions（详见该常量注释）
      options: pagePushOptions(theme),
    },
  }),
  COMPONENT_IDS.DOWNLOAD_MANAGER)
}


export function pushSimilarSongsScreen(componentId: string, similarSongs: LX.Music.MusicInfoOnline[]) {
  if (!startPush(COMPONENT_IDS.SIMILAR_SONGS_SCREEN)) return
  const theme = themeState.theme
  void guardPush(Navigation.push(componentId, {
    component: {
      name: SIMILAR_SONGS_SCREEN,
      passProps: {
        similarSongs,
      },
      // 转场与 options 统一走 pagePushOptions（详见该常量注释）
      options: pagePushOptions(theme),
    },
  }),
  COMPONENT_IDS.SIMILAR_SONGS_SCREEN)
}
