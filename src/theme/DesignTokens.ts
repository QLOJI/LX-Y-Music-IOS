export const designSpacing = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
} as const

export const designRadius = {
  // 倒角二次下调（对齐 REF lx-music-mobile-ios-adaptation 的圆角参数）。
  // REF 全工程只有**一个**圆角常量 `BorderRadius.normal = 4`（见本工程 theme/Typography.js
  // 里遗留的同名令牌），歌曲封面 / 卡片 / 输入框 / 菜单一律用它；只有 Popup 顶角给到 8。
  // 本工程上一轮已把 md 从 18 收到 8，观感仍明显比 REF 圆，故这一轮直接落到 REF 值：
  //   sm 6 → 4（= REF normal，小件：列表行内小方块、输入框、chips）
  //   md 8 → 4（= REF normal；封面与卡片主圆角，46 处引用，改此一处即全局生效）
  //   lg 12 → 8（= REF 的 Popup 顶角；本工程 lg 主要就用在弹窗/面板顶角与卡片）
  //   xl 16 → 12（当前 0 引用，仅保持梯度不出现「越小的档反而越大」）
  // sm 与 md 同值不是笔误：REF 本来就只有一个档，令牌保留两个名字只是为了让
  // 78 处调用点不必改名 —— 不要为了「看起来有梯度」再把其中一个调回去。
  sm: 4,
  md: 4,
  lg: 8,
  xl: 12,
  // 玻璃胶囊统一圆角（2026-09-29 定案）：= 透镜圆角（56 药丸的胶囊半高）。
  // tab 栏玻璃 / 迷你播放器玻璃 / 透镜同值；端头曲线由原生宿主统一 circular，
  // 观感完全一致（原 continuous squircle 端头偏方、视觉圆角显小，统一后即
  // 「圆角适当加大」的效果）。
  // **不随本次下调**：glass 与原生透镜胶囊半高绑定（ModernTabBar/PlayerBar），
  // 改动会与透镜端头错位（原生 LiquidGlassView 还会把值钳到短边一半）。
  glass: 28,
  pill: 999,
} as const

export const designTypography = {
  title: 20,
  body: 15,
  caption: 13,
  // 全局默认行高比例（A-6 收敛约定）：Text 组件在调用方未显式传 lineHeight 时的兜底
  // 基线，页面级显式 lineHeight 仍优先覆盖。
  // A-8（2026-10-01）：「所有界面的文字间距缩小点」—— 1.2 → 1.15。
  // 这是**全局唯一旋钮**：本工程的 Text/AnimatedText/AnimatedColorText 三个组件都用
  // 它算默认行高（未显式传 lineHeight 的调用点全部随之收紧），歌词两条路径显式传了
  // lineHeight，不受影响（歌词行距另有需求，见 A-6a）。
  // 1.15 是下限：再低 CJK 字形（满 em 框）相邻两行会视觉相接，34pt 大标题还会被裁掉
  // 顶部笔画（Discovery 大标题注释有同款警示）。若后续还要更紧，只能按页面逐个调，
  // 不要动这个值。
  lineHeightRatio: 1.15,
} as const

/** 交互动效时长的单一来源。
 *
 *  2026-10-01 定案：quick 由 150 → **200**（「所有跳转 / 歌词反应等动画放慢一点」）。
 *  此前 quick = 150 在本工程内 **0 引用**，实际活跃的动效时长散落在 120/180/200/220/
 *  300/350 各处、各写各的，所以只改这个数字不会有任何可见效果 —— 必须由调用点
 *  引用本常量（歌词换行滑动、进度条 seek 过渡、面板淡入等）。新写动画请一律取用
 *  本常量，不要再内联魔数。 */
export const designMotion = {
  quick: 200,
  standard: 250,
  smooth: 350,
} as const

export type DesignSpacingToken = keyof typeof designSpacing

/** 主页大标题（34pt）所在「标题行」的统一行高（pt）。
 *
 *  为什么需要它：推荐 / 歌单 / 我的 / 搜索四个主页的标题原本各写各的 ——
 *  推荐页标题不写 lineHeight（交给 Text 兜底 = round(34 × 1.15) ≈ 39），
 *  歌单页与我的页写死 `lineHeight: 36`，于是「标题行」高度在三页里分别是
 *  42（被右上角 42pt 圆钮撑高）/ 36 / 36，标题下方的第一行内容（酷我/酷狗平台
 *  胶囊）因此上上下下差出 10pt 以上 —— 左右滑动切页时那一行会明显跳一下。
 *
 *  42 是「推荐页本来就已经是的高度」：推荐页标题行里有一个 42×42 的播放历史
 *  圆钮，行高恒为 42（alignItems: center），把它定为四页共用的基准即可让
 *  推荐页零位移，另外三页对齐过来。42 > 34 × 1.15 = 39.1，不会裁掉大标题顶部
 *  笔画（DesignTokens 里 lineHeightRatio 的 1.15 下限警示同源）。
 *
 *  经 createStyle/scaleSizeH 会乘 global.lx.fontSize，与 fontSize 同口径缩放，
 *  字号调大后标题行与胶囊行的相对关系不变。 */
export const pageTitleLineHeight = 42

/** 页面大标题行 → 其下方第一行内容（平台胶囊 / 歌单卡片）的统一间距（pt）。
 *  四个主页共用；歌单页原本 12、我的页原本 8、推荐页 16，正是「有些太近有些太远」。 */
export const pageTitleGap = designSpacing.md

/** 同一页面内相邻两行控件、以及同一行内相邻两个按钮之间的统一间距（pt）。
 *  取代此前散落的 8 / 12 两套值（最典型的是歌单页标签胶囊用 8、同页排序胶囊用 12，
 *  且标签分组行与行之间完全没有间距）。 */
export const controlGap = designSpacing.sm

/** 沉底悬浮组件（底部 tab 栏 / 迷你播放条）在安全区之上的额外留缝（pt）。
 *  安全区本身（iPhone 34 / 全面屏 iPad 20 / Home 键 iPad 0）由 useSafeAreaBottom 提供。 */
export const bottomFloatGap = 4

/** 底部 tab 栏 bar 的基准高度（pt）。与 ModernTabBar 的 height 同源，
 *  经 createStyle/scaleSizeH **会乘 global.lx.fontSize**。
 *
 *  「Tab栏距离」（theme.tabBarDistance）要用它来算播放器底边，才能和 Tab 栏顶边
 *  用同一个缩放口径 —— 这正是「间距不再随字体大小变化」的关键：两端的缩放必须
 *  一致，而不是一端缩放、另一端写死常量。 */
export const tabBarBaseHeight = 56

/** 「Tab栏距离」滑块的满刻度（pt）。
 *  = 原设计间距 (designSpacing.xl + 48) − (bottomFloatGap + tabBarBaseHeight)
 *  = 80 − 60 = 20pt，即标准字体（fontSize 1.0）下的既有距离。
 *  滑块值 0-100 线性映射到 0~本值，100 = 维持原距离，0 = 播放器贴合 Tab 栏。 */
export const tabBarDistanceMax = 20

/** 收起态悬浮行（左下角圆钮 / 收起态迷你播放器）底边距屏底的统一公式。
 *
 *  ⚠️ 圆钮（ModernTabBar）与迷你播放器（PlayerBar）**必须共用这一条**：收起态的
 *  「同排」此前修不好，就是因为两边各自写表达式（哪怕写成同值），落进设备后也要
 *  经过不同的父容器 inset 解析路径而分叉。任何一边想改底边距，都只改这里。 */
export const collapsedFloatBottom = (safeAreaBottom: number): number => safeAreaBottom + bottomFloatGap

/** 收起态圆钮与迷你播放器之间的横向间距（pt）。
 *  裸值：它只与 scaleSizeW 后的左让位相加；这里若再乘一次 fontSize，
 *  字体一变间距就会和缩放端分叉（三套缩放口径混用的老毛病）。
 *
 *  2026-10-01 定案：sm(12) → **4**。需求原文是「迷你播放器位置应该和圆钮**靠在一起**
 *  且在同一直线上」，12pt 的缝在视觉上已经是两块分开的玻璃、不成立「同排一行」；
 *  4 与收起行的底缝（bottomFloatGap）同值，整行读起来是一个整体。 */
export const collapsedPillGap = bottomFloatGap

/** 「Tab栏距离」滑块值（0~100）换算成实际 pt（裸值，不乘 fontSize）。
 *  它只与 scaleSizeH(tabBarBaseHeight) 相加，两端同口径；
 *  若此处再乘 fontSize，Tab 栏高会缩放两次、间距随字体漂移（上一版的缺陷）。 */
export const floatDistance = (settingValue: number): number => (settingValue / 100) * tabBarDistanceMax
