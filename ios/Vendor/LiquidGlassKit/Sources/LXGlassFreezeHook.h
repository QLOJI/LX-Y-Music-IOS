#import <Foundation/Foundation.h>

//! Vendored addition（第 66 轮第 1 条）: 玻璃「冻结前」的回调口。
//!
//! 背景：液态档（vendored Metal）逐帧把背后的画面采进纹理再折射。玻璃被压栈页盖住 /
//! 转场期间渲染循环被暂停省电（LiquidGlassEffectView.setPaused），CAMetalLayer 上留着
//! 「暂停前最后一次画的」那一帧；返回时恢复采景 —— 只要这一帧与返回后的实时画面不一致，
//! 用户就会看到「闪一下」。
//!
//! 而「背后还有东西会自己再动一下」这类事只有 App 侧知道。本工程的具体形态：Home 列表正在
//! 惯性下滑时点进播放详情页，列表在冻结之后还会往前滑一段 —— App 侧在冻结那一刻按速度把
//! 它直接贴到预测落点（AppDelegate.mm 的 LXGlassSettleDeceleratingScrollView），玻璃随后
//! 重采「贴完之后」的画面当冻结帧，两边就一致了。
//!
//! 契约：
//!   · App 侧用 LXGlassSetWillFreezeFn 注册一个 HANDLER（本工程在 AppDelegate.mm 的
//!     +load 里注册，早于 main、早于任何 UI）；
//!   · 玻璃侧在**把 isPaused 落下去之前**调用 LXGlassNotifyWillFreeze()：同步、主线程；
//!     多块玻璃各自被暂停时各调一次（迷你播放器 / tab 栏 / 透镜），HANDLER 必须自己幂等；
//!   · 没注册就什么都不做（返回 false）—— 本钩子是可选增强，缺席时玻璃行为与上游一致。
//!
//! extern "C" 守卫：实现是 .mm（ObjC++），无守卫时定义按 C++ 规则修饰（_Z…），
//! 而 umbrella header 以纯 ObjC 编译给 Swift、期望未修饰的 C 符号 —— 无守卫 = 链接期
//! Undefined symbols（同 LXGlassLayerRender.h，CI 2046cb4 实锤）。
#ifdef __cplusplus
extern "C" {
#endif

/// App 侧实现的「冻结前」处理：返回 true 表示它改动了屏幕内容（本工程 = 把正在惯性滑行的
/// 列表贴到了预测落点），玻璃据此知道冻结帧必须重采；返回 false = 什么都没动。
typedef BOOL (*LXGlassWillFreezeFn)(void);

/// 注册（传 NULL 注销）。App 只在启动时注册一次。
void LXGlassSetWillFreezeFn(LXGlassWillFreezeFn fn);

/// 由玻璃在冻结前同步调用：跑一遍已注册的处理。没注册返回 false。
BOOL LXGlassNotifyWillFreeze(void);

//! Vendored addition（第 73 轮第 4 条）: 滚动实时档 —— 与上面那条**方向相反**的桥
//!（上面是 Kit 叫 App 冻结前贴落点，这条是 App 告诉 Kit「用户正在滚动」）。
//!
//! 背景：「用户正在上下滚动」这件事只有 App 侧知道（滚动回调在 App 的 swizzle 里，
//! 见 AppDelegate.mm 的 LX_RCTScrollView_scrollViewDidScroll），而玻璃的采景 / 渲染默认
//! 压在静止档 30fps（LiquidGlassView.idleFramesPerSecond，为**静止背景**定的档）。
//! 列表以 60~120fps 在动、玻璃里透过的画面停在 30fps ⇒ 系统性落后 1~3 拍，用户看到的就是
//! 「上下滑动时画面有点抖动，不平滑流畅」。收到本回调后玻璃在「滚动窗口」（0.3s，
//! 到期自动落回静止档）内走实时档：60fps 采景 + 60fps 渲染 —— 与横滑的 `live` prop、
//! 透镜抬起同一档（同一套 isLiveCaptureActive / syncRenderFrameRate）。
//!
//! 契约：
//!   · App 侧在**每个用户主动的滚动事件**里同步调用（主线程，60~120 次/秒）：判据与
//!     tab 栏收起状态机同一道门（LXGlassIsUserDrivenScroll：手指接触期间 + 松手后的惯性），
//!     程序化滚动（歌词自动跟随那类）不算 —— 不为了看不见的手势把全屏玻璃提到 60fps；
//!   · Kit 侧在 GlassInstanceRegistry 初始化时用 LXGlassSetScrollActivityFn 登记实现，
//!     实现必须便宜：只有「从静止进入滚动」的那一脚会去碰玻璃，窗口内的续期只写一个时刻；
//!   · 没登记就什么都不做 —— 与冻结钩子同口径（可选增强，缺席时玻璃行为与上游一致）。
typedef void (*LXGlassScrollActivityFn)(void);

/// 注册（传 NULL 注销）。Kit 只在注册表初始化时注册一次。
void LXGlassSetScrollActivityFn(LXGlassScrollActivityFn fn);

/// 由 App 在用户主动的滚动事件里同步调用：把这一脚的时刻记成「滚动窗口」。
void LXGlassNotifyScrollActivity(void);

//! Vendored addition（第 124 轮）: 返回转场开始时的「冻结帧刷新」桥（App → Kit）。
//!
//! 背景：转场期间玻璃由 JS 的按住门（paused=true）暂停渲染，CAMetalLayer 上留着冻结
//! 那一刻的画面；而返回时整段动画展示的就是它 —— 只要用户在冻结前上下滑过、或列表在
//! 冻结前后又被贴过落点，返回里透过玻璃看到的就是「移动前」的旧画面，直到动画收尾
//! 恢复渲染才刷新（用户看到的错位 + 末尾闪一下）。
//!
//! App 在返回命令派发前调用一次本桥：Kit 对每块**仍处于暂停态**的玻璃同步重采一帧
//! 当前背景并 present，**不改变 isPaused** —— 返回转场仍是整段静止（第 75 轮口径），
//! 只是静止在「主界面移动后」的当前帧。
//!
//! 契约与上面两条桥一致：单写者（Kit 注册表初始化时登记一次）、之后只读；调用必须在
//! 主线程；没登记就什么都不做（可选增强，缺席时玻璃行为与上游一致）。
typedef void (*LXGlassRefreshFrozenFramesFn)(void);

/// 注册（传 NULL 注销）。Kit 只在注册表初始化时注册一次。
void LXGlassSetRefreshFrozenFramesFn(LXGlassRefreshFrozenFramesFn fn);

/// 由 App 在返回命令派发前同步/主线程调用：刷新所有暂停态玻璃的冻结帧。
void LXGlassNotifyRefreshFrozenFrames(void);

//! Vendored addition（第 153 轮）: 导航转场开始 / 结束时按「哪一屏」冻结玻璃（App → Kit）。
//!
//! 背景：JS 的 paused prop 要经过 React 渲染 + 过桥，常常晚于 push 动画的第一帧；
//! 冻结帧一旦在动画开始后才采，就与返回后的背景差一截，返回收尾换帧必然闪。
//! App 在 -viewWillDisappear:（转场开始前、窗口还是干净的）里调第一条桥：
//! 这一屏里的玻璃按刹车后的画面定格；-viewDidAppear:（转场真正结束）里调第二条：
//! 放开导航冻结、按静止后的完整合成恢复采景。两条都同步、主线程。
//!
//! view 参数按 void * 传递（头文件不引 UIKit）；调用期间对象一定存活。
typedef void (*LXGlassFreezeInViewFn)(void *view);
typedef void (*LXGlassScreenSettledFn)(void *view);

/// 注册（传 NULL 注销）。Kit 只在注册表初始化时注册一次。
void LXGlassSetFreezeInViewFn(LXGlassFreezeInViewFn fn);
void LXGlassSetScreenSettledFn(LXGlassScreenSettledFn fn);

/// 由 App 在 viewWillDisappear 里同步调用：冻结这一屏里的玻璃（含定格）。
void LXGlassNotifyFreezeInView(void *view);

/// 由 App 在 viewDidAppear 里同步调用：这一屏的转场已经结束。
void LXGlassNotifyScreenSettled(void *view);

//! Vendored addition（第 154 轮）: 惯性刹车时刻（App → Kit）。
//!
//! 用户在触摸按下那一刻就把正在惯性滑行的滚动视图停住（UIWindow sendEvent 锚点）。
//! 冻结转场开始时，玻璃据此判断手上那张纹理是不是刹车之后采的：不是就补采一帧，
//! 保证冻结画面 = 返回后的背景。
typedef void (*LXGlassScrollBrakeFn)(void);

void LXGlassSetScrollBrakeFn(LXGlassScrollBrakeFn fn);
void LXGlassNotifyScrollBrake(void);

#ifdef __cplusplus
}
#endif
