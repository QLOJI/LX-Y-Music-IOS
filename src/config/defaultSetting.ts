const defaultSetting: LX.AppSetting = {
  version: '2.0',
  'version.autoCheckUpdate': true,
  'common.isAutoTheme': false,
  'common.isDarkMode': false,
  'common.langId': null,
  'common.apiSource': '',
  'common.sourceNameType': 'alias',
  'common.shareType': 'system',
  // 默认 false：首次安装启动时弹出协议弹窗（PactModal），同意后写入 true 不再弹出
  'common.isAgreePact': false,
  'common.autoHidePlayBar': true,
  'common.drawerLayoutPosition': 'left',
  // 「启用竖屏首页横向滚动」设置已移除：首页固定，仅通过底部 tab / 侧边栏切换页面。
  // 该键不再被读取；旧安装里残留的 true 值为死数据，无任何代码引用。
  'common.allowProgressBarSeek': true,
  'common.showBackBtn': false,
  'common.showExitBtn': false,
  'common.wy_cookie': '',
  'common.wy_serpapi_key': '',
  'common.tx_cookie': '',
  'common.kg_cookie': '',
  'common.yt_cookie': '',
  'common.isEnableLog': true,
  'common.isEnableSyncLog': false,
  'common.isEnableUserApiLog': false,
  'common.isEnableWebDAVLog': false,
  'common.isEnableSearchLog': false,
  'common.isEnablePlayerLog': false,
  'common.bilibili_multi_page': false,
  'common.quality_show_highest': false,

  'common.navStatus': {
    nav_discovery: true,
    nav_songlist: true,
    nav_top: true,
    nav_love: true,
    nav_daily_rec: true,
    nav_my_playlist: true,
    nav_followed_artists: true,
    nav_subscribed_albums: true,
    nav_webdav: true,
    nav_tx_daily_rec: true,
    nav_play_history: true,
  },

  'common.navOrder': [
    'nav_discovery',
    'nav_search',
    'nav_play_history',
    'nav_songlist',
    'nav_top',
    'nav_love',
    'nav_daily_rec',
    'nav_kg_daily_rec',
    'nav_tx_daily_rec',
    'nav_kg_playlist',
    'nav_tx_playlist',
    'nav_followed_artists',
    'nav_subscribed_albums',
    'nav_my_playlist',
    'nav_webdav',
    'nav_local_download',
    'nav_setting',
  ],

  'common.navFlatOrder': [],

  // 推荐页平台按钮顺序（平台 id 数组）。空数组 = 按默认顺序显示；
  // 排在第一位的平台为进入推荐页时的默认选中平台。
  'common.discoveryPlatformOrder': [],

  'common.sectionExpandedStatus': {
    setting_player: true,
    setting_download: true,
    setting_theme: true,
    setting_sync: true,
    setting_search: true,
    setting_list: true,
    setting_basic: true,
    setting_other: true,
    setting_backup: true,
    setting_about: true,
    setting_version: true,
    setting_basic_nav_menu: true,
    setting_basic_source_user_api: true,
  },

  'player.startupPushPlayDetailScreen': false,
  'player.togglePlayMethod': 'listLoop',
  'player.playQuality': '320k',
  'player.isSavePlayTime': true,
  'player.volume': 1,
  'player.playbackRate': 1,
  'player.cacheLimit': 0,
  'player.timeoutExit': '',
  'player.timeoutExitPlayed': true,
  'player.isAutoCleanPlayedList': false,
  'player.autoSkipOnError': true,
  'player.soundEffect.enabled': false,
  'player.soundEffect.preset': 'none',
  'player.soundEffect.convolution.fileName': '',
  'player.soundEffect.convolution.mainGain': 10,
  'player.soundEffect.convolution.sendGain': 0,
  // 以下 4 键对应「3D 环绕 / 变调」两个音效区块（另一批代理的音效设置接线需要这些键存在）
  'player.soundEffect.panner.enable': false,
  'player.soundEffect.panner.soundR': 5,
  'player.soundEffect.panner.speed': 25,
  'player.soundEffect.pitchShifter.playbackRate': 1,
  'player.soundEffect.eq.31': 0,
  'player.soundEffect.eq.62': 0,
  'player.soundEffect.eq.125': 0,
  'player.soundEffect.eq.250': 0,
  'player.soundEffect.eq.500': 0,
  'player.soundEffect.eq.1000': 0,
  'player.soundEffect.eq.2000': 0,
  'player.soundEffect.eq.4000': 0,
  'player.soundEffect.eq.8000': 0,
  'player.soundEffect.eq.16000': 0,
  'player.isHandleAudioFocus': true,
  'player.isEnableAudioPreload': false,
  'player.cacheSize': '1024',
  'player.isEnableAudioOffload': false,
  // 「原生 FLAC 播放器」开关已移除（去门控）：无损档一律走原生引擎，见 nativeFlac.ts 注释。
  // 该键不再被读取；旧安装里残留的值为死数据。
  'player.isShowLyricTranslation': true,
  'player.isShowLyricRoma': false,
  'player.isShowNotificationImage': true,
  'player.isS2t': true,
  // 返回软件时自动播放：默认开（用户明确要求「其它音频结束播放后不用回前台也会自动续播」）。
  // 仅当暂停由系统音频中断/其它音频抢占造成时才会恢复，用户主动按的暂停不会被恢复（见 service.ts）。
  'player.autoPlayOnReturn': true,
  // 蓝牙歌词：开 = 把当前歌词行推送到系统媒体信息（控制中心 / 锁屏 / 车机 / 蓝牙音箱
  // 读的都是同一份 MPNowPlayingInfoCenter，artist 字段承载歌词行）；
  // 关 = 只显示歌名·歌手，不推送歌词行。默认开，保持既有行为。
  'player.isShowBluetoothLyric': true,

  'playDetail.isCoverSpin': false,
  'playDetail.style.align': 'center',
  'playDetail.style.miniLyricAlign': 'center',
  'playDetail.style.coverSize': 100,
  'playDetail.style.coverShape': 'circle',
  'playDetail.vertical.style.lrcFontSize': 200,
  'playDetail.horizontal.style.lrcFontSize': 220,
  'playDetail.isShowLyricProgressSetting': true,
  // 小歌词逐字高亮：当前行按「已唱 / 未唱」两色推进（该行有逐字时间戳时走真实时间轴，
  // 没有则按字符数均分该行时长做线性推进）；关 = 回到整行高亮。
  // 默认开：这正是本轮「小歌词逐字效果」需求本身。
  'playDetail.isMiniLyricKaraoke': true,

  'search.isShowHotSearch': false,
  'search.isShowHistorySearch': true,
  'search.enabledSources': { kw: true, kg: true, tx: true, wy: true, mg: true, bilibili: true, git: true, all: true },

  'list.isClickPlayList': false,
  'list.isShowSource': true,
  'list.isShowAlbumName': true,
  'list.isShowInterval': true,
  'list.isSaveScrollLocation': true,
  'list.addMusicLocationType': 'top',
  'list.isAutoSaveDailyRec': true,
  'list.myListVisibility': {},
  'list.isShowCover': true,

  'menu.playLater': true,
  'menu.addTo': true,
  'menu.dislike': true,

  'menu.moveTo': true,
  'menu.changePosition': true,
  'menu.changeSource': true,
  'artistDetail.albumViewMode': 'grid',

  'download.enable': true,
  'download.path': '',
  'download.fileName': '歌名 - 歌手',
  'download.writeLyric': false,
  'download.writeRomaLyric': false,
  'download.writeEmbedLyric': true,
  'download.writeMetadata': true,
  'download.writePicture': true,
  'download.writeAlias': false,
  'download.quality': '128k',

  'sync.enable': false,
  'sync.webdav.enable': false,
  'sync.webdav.syncLists': false,
  'sync.webdav.syncPlayHistory': true,
  'sync.webdav.syncDownloadTasks': true,
  'sync.webdav.url': '',
  'sync.webdav.username': '',
  'sync.webdav.password': '',
  'webdav.downloadPath': '',
  'sync.webdav.path': '/LX_Music/',
  'sync.webdav.lastSyncTimeLists': 0,

  'theme.id': 'green',
  'theme.lightId': 'green',
  'theme.darkId': 'black',
  'theme.dynamicBg': true,
  'theme.blur': 18,
  'theme.fontShadow': false,
  'theme.glassOpacity': 40,
  // 液态玻璃（vendored LiquidGlassKit Metal 折射）开关，仅 iOS 14~26.1 生效；
  // 关闭走系统磨砂。「玻璃不透明度」设置只对磨砂形态有意义（见 ThemeScreen）。
  // 26.2+ 强制磨砂（开关已隐藏、消费点门控，2026-09-30 定案）
  'theme.liquidGlass': true,
  'theme.isLandscapeStretch': false,
  'theme.customBgPicPath': '',
  'theme.picOpacity': 76,
  'theme.subContainerOpacity': 50,
  // 播放器（迷你播放条）底边与底部 tab 栏之间的间距，0-100 线性映射到 0~20pt。
  // 100 = 标准字体下的既有距离（与旧硬编码 80 − 60 等值），0 = 播放器贴合 tab 栏。
  // 该间距**不随字体大小变化**（见 DesignTokens.tabBarBaseHeight 注释）。
  'theme.tabBarDistance': 100,
  // 按钮族（圆角 + 1px 边框 + 半透明主题底）的底色与边框不透明度，0-100。
  // 100 = 完全不透明（默认，视觉与既有版本一致）；0 = 底色/边框全透明，只剩文字。
  // 作用于底色/边框的颜色 alpha，**不是**容器 style.opacity（否则文字会一起淡出）。
  'theme.buttonOpacity': 100,
  // 按钮族圆角：0 = 直角（默认），100 = 半圆，中间值按各按钮自身高度的一半线性换算。
  // 生效值来自 useButtonRadius() 的行内覆盖（createStyle 会把圆角在加载时固化，必须在调用点覆盖），见 utils/buttonRadius.ts。
  'theme.buttonRadius': 0,
}

if (new Date().getMonth() < 2) {
  defaultSetting['theme.id'] = 'happy_new_year'
}

export default defaultSetting
