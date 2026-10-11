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
