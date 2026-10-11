#!/usr/bin/env node
/**
 * sim-r63-tabbar-scroll-gate.js —— 「谁有资格驱动 Tab 栏收起」的作用域门（第 63 轮第 1 条）。
 *
 * 需求原话（2026-10-11）：
 *   「当迷你播放器栏和底部 tab 栏展开时，然后突然进入例如播放详情页，变为合并状态，
 *     底部 tab 栏和迷你播放器栏透过的画面没有更新，然后点击左上角返回按钮、右滑返回主界面的
 *     最后一瞬间，透过的画面会闪一下（应该是在刷新画面），请改为不要闪」。
 *
 * 根因（本轮实锚）：-[RCTScrollView scrollViewDidScroll:] 的 swizzle 是**全 App 通吃**的 ——
 *   播放详情页的歌词列表挂载即程序化 scrollToOffset 到当前行（offset 普遍 > 48），于是
 *   「进入播放详情页」这一个动作本身就满足了收起条件，把 Home 的 tab 栏收起了。而那一刻
 *   Home 的两块玻璃正被第 61 轮的转场按住门冻着（sim-glass-nav-hold.js 的 B~G 段）：
 *   被盖住期间它们不重采纹理，收起态那 220ms 的布局动画就把冻结纹理与已经移动的图层错开
 *   半条栏 —— 用户看到的「透过的画面没有更新」；返回时松开按住门重采对齐，就是「最后一瞬间
 *   闪一下」。两现象同一根因，所以修法只有一条：**把驱动者的范围收窄**。
 *
 * 修法 = 三门（顺序即口径，全部 fail-closed）：
 *   ① 挂着窗口：host.window == nil 直接 return（离屏视图的滚动不算数）；
 *   ② 有资格驱动：LXScrollViewDrivesTabBar —— 最近的 UIViewController 属于主界面
 *      （nav 的根屏、非 RNN 模态栈）、主界面正露着（nav.viewControllers.lastObject == vc，
 *      没被压栈页盖住）、不在转场里（vc / nav 的 transitionCoordinator 都为 nil）；
 *   ③ 状态机本体一字未动（48 / 2 迟滞区、isTracking 才清手动展开、manualExpanded 守卫），
 *      且「同值早退」保留 —— 滚动事件本身不过桥，只有状态变化才发一次通知。
 *
 * 为什么必须靠契约脚本：门「漏在哪一侧」都不会崩、也过得了 tsc/eslint（本工程根本没有）。
 *   门被摘掉 = 用户报的现场原样回来（只是更隐蔽：要先进详情页再返回才看得见）；把 fail-closed
 *   写成 fail-open（拿不到 VC 就放行）= 权限反转，压栈页的滚动照样通吃；firstObject /
 *   lastObject 两条门写反 = 恰好反过来（只有被盖住时才驱动）；transitionCoordinator 门去掉 =
 *   转场里照驱动（第 61 轮按住门期间又叠加一次布局动画）。带反例自检，且 tamper 锚点必须唯一命中。
 *
 * 已知边界（写在这里免得被当成缺失）：
 *   · 本机没有 Xcode / 真机：这里只做**静态结构断言**，响应链上溯与 RNN 的导航栈形状都
 *     无法真跑；「压栈页的列表视图到底挂在哪个 VC 下」按 RNN 7.39.2 的常规行为推定。
 *   · 只收窄了「这一条驱动路径」。用户报的「透过的画面没有更新 / 返回闪一下」若还有**其它**
 *     被盖住期间的几何变化来源（例如 Home 自身布局被外部 props 改动），仍可能在松开按住门时
 *     出现一次对齐刷新 —— 本轮无法在真机上排除，如实记在交付里。
 *
 * 运行（本机没有 node）：
 *   python "C:\Users\Q\AppData\Local\Temp\lx-jsrun\run.py" scripts/sim-r63-tabbar-scroll-gate.js --brief
 * 退出码：不变量全过、且全部反例被拦下时为 0，否则 1。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = 'src'

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// 只去整行 `//` 注释（行尾注释保留；断言锚点全都不是注释）
const stripComments = (s) => s.split('\n').map((line) => {
  const at = line.indexOf('//')
  return at < 0 ? line : line.slice(0, at)
}).join('\n')

const F = {
  native: 'ios/LxMusicMobile/AppDelegate.mm',
  utils: 'src/utils/nativeModules/utils.ts',
  collapse: 'src/utils/tabBarCollapse.ts',
  tabBar: 'src/components/layout/ModernTabBar.tsx',
}

const REAL = {
  native: read(F.native),
  utils: read(F.utils),
  collapse: read(F.collapse),
  tabBar: read(F.tabBar),
}

/** 取 C 函数 / ObjC 方法体：签名命中处起，到第一个位于行首的 `}` 为止 */
const bodyOf = (s, signature) => {
  const start = s.indexOf(signature)
  if (start < 0) return null
  const rest = s.slice(start)
  const end = /\n\}\n/.exec(rest)
  return end ? rest.slice(0, end.index) : null
}

/** 取 `@implementation X` 到它的 `@end` */
const implOf = (s, name) => {
  const start = s.indexOf(`@implementation ${name}`)
  if (start < 0) return null
  const end = s.indexOf('@end', start)
  return end < 0 ? null : s.slice(start, end)
}

/** src 下所有 .ts/.tsx（与 check-i18n-keys.js 同一走法） */
const collectFiles = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) {
      if (name !== 'node_modules') collectFiles(p, out)
    } else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const SRC_FILES = collectFiles(path.join(ROOT, SRC)).map((p) => [
  path.relative(ROOT, p).replace(/\\/g, '/'),
  fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'),
])

// ---------------------------------------------------------------------------
// 不变量 ①：原生 —— 三门（挂着窗口 / 有资格驱动 / 状态机本体不动）
// ---------------------------------------------------------------------------

const nativeInvariants = (src) => {
  const reasons = []
  const code = stripComments(src)

  // —— ①-a 沿响应链找最近的 UIViewController ——
  const nearest = bodyOf(code, 'static UIViewController *LXNearestViewController(UIView *view) {')
  if (nearest == null) {
    reasons.push('找不到 LXNearestViewController（「这个滚动视图属于谁」没有落点，门就无从谈起）')
  } else {
    if (!nearest.includes('UIResponder *responder = view;')) {
      reasons.push('上溯起点不是视图本身（从别处起头会拿到不相干的 VC）')
    }
    if (!nearest.includes('if ([responder isKindOfClass:[UIViewController class]]) return (UIViewController *)responder;')) {
      reasons.push('上溯不判 UIViewController（拿不到所属 VC，就没有「是不是主界面」可判）')
    }
    if (!nearest.includes('responder = responder.nextResponder;')) {
      reasons.push('不上溯响应链（只看一层：RN 的列表视图走不到屏幕 VC）')
    }
    if (!nearest.includes('return nil;')) {
      reasons.push('上溯失败不返回 nil（拿不到 VC 时的行为不确定 = 门可能放行）')
    }
  }

  // —— ①-b LXScrollViewDrivesTabBar：四条门，顺序不变，全部 fail-closed ——
  const drives = bodyOf(code, 'static BOOL LXScrollViewDrivesTabBar(UIView *view) {')
  if (drives == null) {
    reasons.push('找不到 LXScrollViewDrivesTabBar（第 63 轮的收窄门被整体摘掉）')
  } else {
    const gates = [
      ['vc 判空', 'if (vc == nil) return NO;'],
      ['取导航栈', 'UINavigationController *nav = vc.navigationController;'],
      ['栈判空', 'if (nav == nil) return NO;'],
      ['RNN 模态栈排除', 'if (nav.presentingViewController != nil) return NO;'],
      ['属于主界面（根屏）', 'if (nav.viewControllers.firstObject != vc) return NO;'],
      ['主界面正露着（没被压栈页盖住）', 'if (nav.viewControllers.lastObject != vc) return NO;'],
      ['VC 不在转场里', 'if (vc.transitionCoordinator != nil) return NO;'],
      ['导航栈不在转场里', 'if (nav.transitionCoordinator != nil) return NO;'],
      ['放行', 'return YES;'],
    ]
    const positions = []
    for (const [label, needle] of gates) {
      const at = drives.indexOf(needle)
      if (at < 0) reasons.push(`LXScrollViewDrivesTabBar 缺「${label}」这条门（${needle}）`)
      positions.push([label, at])
    }
    for (let i = 1; i < positions.length; i++) {
      const [prevLabel, prevAt] = positions[i - 1]
      const [label, at] = positions[i]
      if (prevAt >= 0 && at >= 0 && at < prevAt) {
        reasons.push(`LXScrollViewDrivesTabBar 门序倒了：「${label}」跑到「${prevLabel}」前面`)
      }
    }
    if (drives.split('return YES;').length - 1 !== 1) {
      reasons.push('LXScrollViewDrivesTabBar 有多个放行口（门必须是「全过才 YES」的单出口）')
    }
    if (drives.includes('return YES;') && !/return NO;[\s\S]*return YES;\s*$/m.test(drives)) {
      reasons.push('LXScrollViewDrivesTabBar 不是 fail-closed（末尾放行前没有一票否决的 NO 门）')
    }
    // 只认导航栈，不许退回「看 tabBar 在不在窗口上」这类间接判据
    if (!drives.includes('vc.navigationController')) {
      reasons.push('LXScrollViewDrivesTabBar 不取所属 VC 的 navigationController（判不出「是不是主界面」）')
    }
  }

  // —— ①-c swizzle：先调原实现 → 挂窗口门 → 资格门 → 才读 offset 进状态机 ——
  const sw = bodyOf(code, 'static void LX_RCTScrollView_scrollViewDidScroll(id self, SEL _cmd, UIScrollView *scrollView) {')
  if (sw == null) {
    reasons.push('找不到 LX_RCTScrollView_scrollViewDidScroll（滚动跟踪器的入口没了）')
  } else {
    const steps = [
      ['先调原实现', 'if (LXOrigRCTScrollViewDidScroll != NULL) {'],
      ['原实现调用', '((void (*)(id, SEL, UIScrollView *))LXOrigRCTScrollViewDidScroll)(self, _cmd, scrollView);'],
      ['取宿主视图', 'UIView *host = [self isKindOfClass:[UIView class]] ? (UIView *)self : (UIView *)scrollView;'],
      ['门一：挂着窗口', 'if (host.window == nil) return;'],
      ['门二：有资格驱动', 'if (!LXScrollViewDrivesTabBar(host)) return;'],
      ['读 offset', 'CGPoint offset = scrollView.contentOffset;'],
      ['状态机：收起支', 'if (offset.y > 48) {'],
    ]
    const positions = []
    for (const [label, needle] of steps) {
      const at = sw.indexOf(needle)
      if (at < 0) reasons.push(`swizzle 缺「${label}」（${needle}）`)
      positions.push([label, at])
    }
    for (let i = 1; i < positions.length; i++) {
      const [prevLabel, prevAt] = positions[i - 1]
      const [label, at] = positions[i]
      if (prevAt >= 0 && at >= 0 && at < prevAt) {
        reasons.push(`swizzle 顺序倒了：「${label}」跑到「${prevLabel}」前面`)
      }
    }
    if (sw.indexOf('LXOrigRCTScrollViewDidScroll)(self, _cmd, scrollView);') < 0) {
      reasons.push('swizzle 不再把原实现叫下去（RCTScrollView 自己的滚动逻辑被吞了）')
    }
  }

  // —— ①-d 状态机本体不得被收窄顺手改坏（第 31/35/58 轮口径）——
  if (sw != null) {
    if (!sw.includes('if (offset.y > 48) {')) {
      reasons.push('收起阈值不再是 48（列表刚离开顶部就收起 / 或再也收不起）')
    }
    if (!sw.includes('} else if (offset.y <= 2) {')) {
      reasons.push('展开阈值不再是 ≤ 2（迟滞区被拆 = 顶部抖动来回切换）')
    }
    if ((sw.match(/offset\.y >/g) || []).length !== 1 || (sw.match(/offset\.y <=/g) || []).length !== 1) {
      reasons.push('状态机多了第三条偏移分支（(2, 48] 迟滞区「保持当前状态」的口径被改）')
    }
    const atTracking = sw.indexOf('if (scrollView.isTracking) LXTabBarManualExpanded = NO;')
    const atCollapse = sw.indexOf('if (!LXTabBarManualExpanded) LXSetTabBarCollapsed(YES);')
    if (atTracking < 0) {
      reasons.push('收起支不再区分「主动拖动」与惯性滑行（点手动展开会被残留惯性瞬间收回）')
    }
    if (atCollapse < 0) {
      reasons.push('收起支不再受手动展开标记约束（点击展开失效）')
    }
    if (atTracking >= 0 && atCollapse >= 0 && atTracking > atCollapse) {
      reasons.push('收起支顺序倒了：先判手动展开再清标记（同一次拖动里手动展开永远清不掉）')
    }
    if (!sw.includes('LXTabBarManualExpanded = NO;\n    LXSetTabBarCollapsed(NO);')) {
      reasons.push('回顶展开支没清手动展开标记（回顶后仍停在被盖住的收起态）')
    }
  }

  // —— ①-e 通知只在状态真变化时发（滚动事件不过桥的性能口径）——
  const setFn = bodyOf(code, 'static void LXSetTabBarCollapsed(BOOL collapsed) {')
  if (setFn == null) {
    reasons.push('找不到 LXSetTabBarCollapsed（状态变化没有唯一出口）')
  } else {
    const atGuard = setFn.indexOf('if (LXTabBarCollapsedState == collapsed) return;')
    const atAssign = setFn.indexOf('LXTabBarCollapsedState = collapsed;')
    const atPost = setFn.indexOf('postNotificationName:LXTabBarCollapseChangedNotification')
    if (atGuard < 0) reasons.push('LXSetTabBarCollapsed 没有同值早退（每个滚动事件都会过桥发一次事件）')
    if (atAssign < 0) reasons.push('LXSetTabBarCollapsed 不记账（状态永远不变 = JS 侧收不到）')
    if (atPost < 0) reasons.push('LXSetTabBarCollapsed 不发通知（原生状态机与 JS 侧断链）')
    if (atGuard >= 0 && atAssign >= 0 && atGuard > atAssign) reasons.push('同值早退排在记账之后（等于没有早退）')
    if (atAssign >= 0 && atPost >= 0 && atAssign > atPost) reasons.push('先发通知后记账（JS 会收到重复事件）')
    if (!setFn.includes('@{ @"collapsed": @(collapsed) }')) {
      reasons.push('通知载荷不是 { collapsed } 双保险形态（JS 侧兼容分支的另一半失效）')
    }
  }

  // —— ①-f 安装点：取原实现必须在替换之前（否则存下来的是自己）——
  const setup = implOf(src, 'LXTabBarCollapseSetup')
  if (setup == null) {
    reasons.push('找不到 LXTabBarCollapseSetup（swizzle 没有安装点了）')
  } else {
    const atGet = setup.indexOf('class_getInstanceMethod([RCTScrollView class], @selector(scrollViewDidScroll:))')
    const atNil = setup.indexOf('if (method == nil) return;')
    const atSave = setup.indexOf('LXOrigRCTScrollViewDidScroll = method_getImplementation(method);')
    const atSwap = setup.indexOf('method_setImplementation(method, (IMP)LX_RCTScrollView_scrollViewDidScroll);')
    if (atGet < 0) reasons.push('安装点不取 RCTScrollView 的 scrollViewDidScroll:')
    if (atNil < 0) reasons.push('安装点不判 method == nil（RN 换版本会直接崩）')
    if (atSave < 0) reasons.push('安装点不保存原实现（换掉之后就再也叫不回去了）')
    if (atSwap < 0) reasons.push('安装点不替换实现（跟踪器根本没生效）')
    if (atGet >= 0 && atSave >= 0 && atGet > atSave) reasons.push('先存后取（保存下来的是自己，递归调用）')
    if (atSave >= 0 && atSwap >= 0 && atSave > atSwap) reasons.push('先替换后保存（存下来的是自己的实现，递归调用）')
  }

  // —— ①-g 手动展开通道（点左下角圆钮）：置标记在展开之前 ——
  const expand = bodyOf(code, 'RCT_EXPORT_METHOD(setTabBarExpanded) {')
  if (expand == null) {
    reasons.push('找不到 setTabBarExpanded（收起后没法手动展开）')
  } else {
    const atMark = expand.indexOf('LXTabBarManualExpanded = YES;')
    const atOpen = expand.indexOf('LXSetTabBarCollapsed(NO);')
    if (atMark < 0 || atOpen < 0) {
      reasons.push('setTabBarExpanded 不同时做「置手动展开标记 + 展开」')
    } else if (atMark > atOpen) {
      reasons.push('setTabBarExpanded 先展开后置标记（列表残留惯性会立刻把它收回去）')
    }
    if (!expand.includes('dispatch_get_main_queue()')) {
      reasons.push('setTabBarExpanded 不在主队列上改状态（跨线程写状态机）')
    }
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 不变量 ②：JS 侧 —— 单一来源（只有这一条桥，没有第二个驱动者）
// ---------------------------------------------------------------------------

const jsInvariants = (files, utilsSrc, collapseSrc) => {
  const reasons = []
  const utils = stripComments(utilsSrc)
  const collapse = stripComments(collapseSrc)

  // —— ②-a 桥：iOS 专属、事件名与原生一致、两种载荷都认 ——
  const bridge = bodyOf(utils, 'export const onTabBarCollapseChanged = ')
  if (bridge == null) {
    reasons.push('utils.ts 缺 onTabBarCollapseChanged（原生状态机与 JS 侧断链）')
  } else {
    if (!bridge.includes('if (!isIOS || !UtilsModule) return () => {}')) {
      reasons.push('桥没有 iOS / 原生未就绪的降级（其它平台会抛）')
    }
    if (!bridge.includes("addListener('tabBarCollapseChanged'")) {
      reasons.push('桥监听的事件名不是 tabBarCollapseChanged（与原生 sendEventWithName 对不上）')
    }
    if (!bridge.includes("typeof event == 'boolean' ? event : !!event?.collapsed")) {
      reasons.push('桥只认一种载荷（原生发的是 NSNumber，另一种形态会拿到 undefined → 永远展开）')
    }
    if (!bridge.includes('eventListener.remove()')) {
      reasons.push('桥不返回解绑函数（反复挂载会堆监听者）')
    }
  }

  // —— ②-b 单例：只订阅、只认变化、没有第二个写入口 ——
  if (!collapse.includes('if (inited) return')) {
    reasons.push('tabBarCollapse.ts 的 init 不幂等（重复挂原生监听者）')
  }
  const atCallback = collapse.indexOf('onTabBarCollapseChanged((v) => {')
  const atSame = collapse.indexOf('if (collapsed === v) return')
  const atAssign = collapse.indexOf('collapsed = v')
  if (atCallback < 0) reasons.push('tabBarCollapse.ts 不再订阅原生事件（状态永远停在初始值）')
  if (atSame < 0) reasons.push('tabBarCollapse.ts 去掉同值早退（同一次状态变化通知所有监听者重渲染）')
  if (atAssign < 0) reasons.push('tabBarCollapse.ts 不记账（订阅了也不更新）')
  if (atSame >= 0 && atAssign >= 0 && atSame > atAssign) reasons.push('同值早退排在记账之后（等于没有早退）')
  const assignCount = (collapse.match(/^\s*collapsed = /gm) || []).length
  if (assignCount !== 1) {
    reasons.push(`tabBarCollapse.ts 有 ${assignCount} 处「collapsed = 」（只许有唯一的记账点，多了就是第二个真源）`)
  }

  // —— ②-c 单一来源：事件名只许在桥里出现一次，消费者只许经单例 ——
  const eventFiles = files.filter(([, c]) => c.includes("'tabBarCollapseChanged'")).map(([p]) => p)
  if (eventFiles.length !== 1 || eventFiles[0] !== F.utils) {
    reasons.push(`'tabBarCollapseChanged' 出现在 ${eventFiles.length} 个文件里（${eventFiles.join(' / ') || '无'}）——多一处直连原生事件就是绕过单例的第二个驱动源`)
  }
  const hookFiles = files.filter(([, c]) => c.includes('onTabBarCollapseChanged')).map(([p]) => p).sort()
  const hookExpect = [F.utils, F.collapse].sort()
  if (hookFiles.join('|') !== hookExpect.join('|')) {
    reasons.push(`onTabBarCollapseChanged 的使用方是 ${hookFiles.join(' / ')}（应恰好是「桥 + 单例」两处）`)
  }
  const readers = files.filter(([, c]) => c.includes('useTabBarCollapsed')).map(([p]) => p)
  if (readers.length < 2 || !readers.includes(F.tabBar)) {
    reasons.push(`useTabBarCollapsed 的消费方是 ${readers.join(' / ')}（tab 栏与迷你播放器都该读同一份状态）`)
  }

  return reasons
}

// ---------------------------------------------------------------------------
// 反例自检：任一门被摘掉 / 写反 / 顺序颠倒，都必须被拦下
// ---------------------------------------------------------------------------

const runCounterExamples = () => {
  const results = []
  const ce = (name, detail, ok) => results.push({ name, detail, ok: !!ok })

  // g1 资格门被整体摘掉：全 App 通吃回来了（用户报的现场）
  const g1 = REAL.native.replace('  if (!LXScrollViewDrivesTabBar(host)) return;\n', '')
  ce('g1 资格门被摘掉', '压栈页的滚动又能收起 Home 的 tab 栏',
    g1 !== REAL.native && nativeInvariants(g1).length > 0)

  // g2 「主界面正露着」这条门被删：被盖住期间照样驱动（玻璃被冻着时布局动画错位）
  const g2 = REAL.native.replace('  if (nav.viewControllers.lastObject != vc) return NO;   // 主界面被压栈页盖住\n', '')
  ce('g2 「主界面正露着」门被删', '被盖住期间照驱动 = 冻结纹理与图层错开',
    g2 !== REAL.native && nativeInvariants(g2).length > 0)

  // g3 fail-closed 反转成 fail-open：拿不到 VC 就放行
  const g3 = REAL.native.replace('  if (vc == nil) return NO;\n', '  if (vc == nil) return YES;\n')
  ce('g3 拿不到 VC 时放行', '门反转成 fail-open（权限失效）',
    g3 !== REAL.native && nativeInvariants(g3).length > 0)

  // g4 「是不是主界面」的判据换成根屏之外的东西（只看有没有导航栈）
  const g4 = REAL.native.replace('  if (nav.viewControllers.firstObject != vc) return NO;  // 不是根屏（不是主界面）\n', '')
  ce('g4 根屏判据被删', '任何压栈页都成了「主界面」',
    g4 !== REAL.native && nativeInvariants(g4).length > 0)

  // g5 两门顺序颠倒（先判资格再看窗口）
  const g5 = REAL.native.replace(
    '  if (host.window == nil) return;\n  if (!LXScrollViewDrivesTabBar(host)) return;\n',
    '  if (!LXScrollViewDrivesTabBar(host)) return;\n  if (host.window == nil) return;\n',
  )
  ce('g5 两门顺序颠倒', '离屏视图也走一遍资格判定（门序即口径）',
    g5 !== REAL.native && nativeInvariants(g5).length > 0)

  // g6 原实现不再叫下去（RCTScrollView 自己的滚动逻辑被吞）
  const g6 = REAL.native.replace(
    '  if (LXOrigRCTScrollViewDidScroll != NULL) {\n' +
    '    ((void (*)(id, SEL, UIScrollView *))LXOrigRCTScrollViewDidScroll)(self, _cmd, scrollView);\n' +
    '  }\n',
    '',
  )
  ce('g6 原实现不再叫下去', 'swizzle 吞掉 RCTScrollView 自己的逻辑',
    g6 !== REAL.native && nativeInvariants(g6).length > 0)

  // g7 收起阈值被改小：列表刚离开顶部就收起
  const g7 = REAL.native.replace('  if (offset.y > 48) {\n', '  if (offset.y > 4) {\n')
  ce('g7 收起阈值被改', '迟滞区口径被改（顶部抖动来回切换）',
    g7 !== REAL.native && nativeInvariants(g7).length > 0)

  // g8 收起支不再区分主动拖动（手动展开会被残留惯性瞬间收回）
  const g8 = REAL.native.replace('    if (scrollView.isTracking) LXTabBarManualExpanded = NO;\n', '')
  ce('g8 主动拖动判据被删', '点手动展开后被残留惯性收回',
    g8 !== REAL.native && nativeInvariants(g8).length > 0)

  // g9 同值早退被拆：每个滚动事件都过桥
  const g9 = REAL.native.replace('  if (LXTabBarCollapsedState == collapsed) return;\n', '')
  ce('g9 同值早退被拆', '滚动事件不过桥的性能口径被打破',
    g9 !== REAL.native && nativeInvariants(g9).length > 0)

  // g10 安装点先替换后保存（存下来的是自己 → 递归）
  const g10 = REAL.native.replace(
    '  LXOrigRCTScrollViewDidScroll = method_getImplementation(method);\n' +
    '  method_setImplementation(method, (IMP)LX_RCTScrollView_scrollViewDidScroll);\n',
    '  method_setImplementation(method, (IMP)LX_RCTScrollView_scrollViewDidScroll);\n' +
    '  LXOrigRCTScrollViewDidScroll = method_getImplementation(method);\n',
  )
  ce('g10 先替换后保存', '存下来的是自己 = 无限递归',
    g10 !== REAL.native && nativeInvariants(g10).length > 0)

  // g11 手动展开先展开后置标记（残留惯性立刻收回）
  const g11 = REAL.native.replace(
    '    LXTabBarManualExpanded = YES;\n    LXSetTabBarCollapsed(NO);\n',
    '    LXSetTabBarCollapsed(NO);\n    LXTabBarManualExpanded = YES;\n',
  )
  ce('g11 手动展开顺序颠倒', '点展开后被列表残留惯性瞬间收回',
    g11 !== REAL.native && nativeInvariants(g11).length > 0)

  // g12 JS 桥丢掉「NSNumber 载荷」兼容分支（原生发的是 @(collapsed)）
  const g12 = REAL.utils.replace(
    "    handler(typeof event == 'boolean' ? event : !!event?.collapsed)\n",
    '    handler(event as boolean)\n',
  )
  ce('g12 桥只认一种载荷', '收到 NSNumber 形态时永远判成展开',
    g12 !== REAL.utils && jsInvariants(SRC_FILES, g12, REAL.collapse).length > 0)

  // g13 JS 单例去掉同值早退（同一次变化通知所有监听者重渲染）
  const g13 = REAL.collapse.replace('    if (collapsed === v) return\n', '')
  ce('g13 单例去掉同值早退', '无谓重渲染（收起态每秒都在通知）',
    g13 !== REAL.collapse && jsInvariants(SRC_FILES, REAL.utils, g13).length > 0)

  // g14 第二个驱动源：某个组件直连原生事件，绕开单例
  const g14 = SRC_FILES.map(([p, c]) => (p === F.tabBar
    ? [p, c.replace("import { useTabBarCollapsed", "const _direct = NativeEventEmitter.addListener('tabBarCollapseChanged')\nimport { useTabBarCollapsed")]
    : [p, c]))
  ce('g14 出现第二个驱动源', '组件直连原生事件 = 单例被架空',
    g14.find(([p]) => p === F.tabBar)[1] !== REAL.tabBar &&
    jsInvariants(g14, REAL.utils, REAL.collapse).length > 0)

  return results
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

console.log('=== sim-r63-tabbar-scroll-gate ===')
console.log('「谁有资格驱动 Tab 栏收起」的作用域门：主界面自己 + 主界面正露着 + 不在转场里（第 63 轮第 1 条）')
console.log()

const checks = [
  ['原生 AppDelegate.mm（VC 上溯 / 四+N 条门与门序 / swizzle 顺序 / 状态机本体不动 / 同值早退 / 安装点次序 / 手动展开通道）', () => nativeInvariants(REAL.native)],
  ['JS（桥的事件名与载荷兼容 / 单例只订阅不设第二个真源 / 全仓单一来源扫描）', () => jsInvariants(SRC_FILES, REAL.utils, REAL.collapse)],
]

let invOk = true
const passCount = []
for (const [name, fn] of checks) {
  const reasons = fn()
  if (reasons.length === 0) {
    passCount.push(name)
    console.log(`\n[${name}]\n  PASS`)
  } else {
    invOk = false
    console.log(`\n[${name}]`)
    ;[...new Set(reasons)].forEach((r) => console.log('  FAIL ' + r))
  }
}

console.log('\n[反例自检]')
const ceResults = runCounterExamples()
let ceAllOk = true
for (const r of ceResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name} —— ${r.detail}`)
  if (!r.ok) ceAllOk = false
}

const allOk = invOk && ceAllOk
console.log(`\n结果：${allOk ? 'ALL PASS' : '有失败项'}（不变量 ${passCount.length}/${checks.length}；反例 ${ceResults.filter((r) => r.ok).length}/${ceResults.length}）`)
process.exit(allOk ? 0 : 1)
