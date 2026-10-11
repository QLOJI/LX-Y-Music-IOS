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

#ifdef __cplusplus
}
#endif
