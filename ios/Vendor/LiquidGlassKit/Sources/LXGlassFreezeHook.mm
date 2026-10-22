//
//  LXGlassFreezeHook.mm
//  LiquidGlass (vendored from DnV1eX/LiquidGlassKit)
//
//  Vendored addition（第 66 轮第 1 条）：玻璃「冻结前」回调口的存储侧。
//  为什么用函数指针钩子而不是 NSNotification：kit 是静态库 pod、App 目标从不 import 它的
//  头，通知名要在两边各写一遍字符串（写错 = 静默失效，且 grep 不出谁在听）；函数指针是
//  类型化的，注册点缺席时就是 NULL、行为退回上游（见 .h 的契约段）。
//
#import "LXGlassFreezeHook.h"

// 单写者：App 启动时（+load）写一次，之后只读；读取发生在主线程的冻结路径上。
// 指针要么是 NULL、要么是加载完的函数地址 —— 不存在「读到半个指针」的竞态，
// 也就不需要锁、不需要派发。
static LXGlassWillFreezeFn LXGlassWillFreezeHandler = NULL;

void LXGlassSetWillFreezeFn(LXGlassWillFreezeFn fn) {
  LXGlassWillFreezeHandler = fn;
}

BOOL LXGlassNotifyWillFreeze(void) {
  LXGlassWillFreezeFn handler = LXGlassWillFreezeHandler;
  if (handler == NULL) return NO;
  return handler();
}

// 【第 73 轮第 4 条】反方向的桥（App → Kit 的滚动活动）的存储侧，口径与上面完全一致：
// 单写者（Kit 侧 GlassInstanceRegistry 初始化时写一次）、之后只读；读取发生在主线程的
// 滚动事件里（60~120 次/秒），同样不需要锁、不需要派发。
static LXGlassScrollActivityFn LXGlassScrollActivityHandler = NULL;

void LXGlassSetScrollActivityFn(LXGlassScrollActivityFn fn) {
  LXGlassScrollActivityHandler = fn;
}

void LXGlassNotifyScrollActivity(void) {
  LXGlassScrollActivityFn handler = LXGlassScrollActivityHandler;
  if (handler == NULL) return;
  handler();
}

// 【第 124 轮】返回转场开始前的冻结帧刷新（App → Kit）。存储侧口径与上面完全一致：
// 单写者（Kit 侧 GlassInstanceRegistry 初始化时写一次）、之后只读；读取发生在主线程
// （App 的 pop 入口），不需要锁、不需要派发。
static LXGlassRefreshFrozenFramesFn LXGlassRefreshFrozenFramesHandler = NULL;

void LXGlassSetRefreshFrozenFramesFn(LXGlassRefreshFrozenFramesFn fn) {
  LXGlassRefreshFrozenFramesHandler = fn;
}

void LXGlassNotifyRefreshFrozenFrames(void) {
  LXGlassRefreshFrozenFramesFn refreshHandler = LXGlassRefreshFrozenFramesHandler;
  if (refreshHandler == NULL) return;
  refreshHandler();
}

// 【第 153 轮】按「哪一屏」冻结 / 结束冻结。存储口径同上：单写者、之后只读、主线程。
static LXGlassFreezeInViewFn LXGlassFreezeInViewHandler = NULL;
static LXGlassScreenSettledFn LXGlassScreenSettledHandler = NULL;

void LXGlassSetFreezeInViewFn(LXGlassFreezeInViewFn fn) {
  LXGlassFreezeInViewHandler = fn;
}

void LXGlassSetScreenSettledFn(LXGlassScreenSettledFn fn) {
  LXGlassScreenSettledHandler = fn;
}

void LXGlassNotifyFreezeInView(void *view) {
  LXGlassFreezeInViewFn fn = LXGlassFreezeInViewHandler;
  if (!fn) return;
  fn(view);
}

void LXGlassNotifyScreenSettled(void *view) {
  LXGlassScreenSettledFn fn = LXGlassScreenSettledHandler;
  if (!fn) return;
  fn(view);
}
