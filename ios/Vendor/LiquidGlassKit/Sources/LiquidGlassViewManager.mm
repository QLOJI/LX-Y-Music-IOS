//
//  LiquidGlassViewManager.mm
//  LiquidGlassKit (vendored from DnV1eX/LiquidGlassKit)
//
//  React Native (Paper) view manager exposing the liquid-glass view to JS as `LiquidGlassView`.
//  Lives inside the pod (mixed ObjC/Swift target) so the app target never needs to import the
//  Swift module: the manager self-registers via RCT_EXPORT_MODULE, like every RN pod's native
//  component. JS side: src/components/common/LiquidGlass.tsx (requireNativeComponent).
//
//  Usage contract (JS):
//  - Render as a leaf element (<LiquidGlass />) absolutely positioned to fill its parent.
//    **排除根契约**：捕获排除根 = 本宿主的 superview（= 玻璃 + 前景内容所在的内容
//    容器，didMoveToSuperview 自动维护）——因此 <LiquidGlass> 必须是内容容器的
//    **直接子元素**；若中间再包一层只装玻璃的 wrapper，前景会漏进捕获纹理（重影）。
//    双形态背衬 × 版本分档（liquid prop 切换，见 LGGlassViewFactory.swift）：
//      - liquid = false（默认）：系统磨砂 —— **全版本统一** UIBlurEffect(.systemMaterial)
//        外加有上限的主题染色覆层。26 的原生玻璃材质不走这条（那是系统液态观感，与
//        「关 = 磨砂」的预期相悖；LGGlassMaterial.preferNativeGlassOnIOS26 = false）。
//      - liquid = true（全 iOS 版本生效，按版本分两档）：
//          · iOS 26.2 及以上：系统原生 UIGlassEffect(.regular)（同为 LGFrostedGlassView、
//            useNativeGlass:true）—— 该档位的「专属磨砂」：系统合成零捕获成本，规避
//            自研 Metal 在 26.2+/27 的跳动/闪烁/前景碎片问题链；
//          · iOS 14～26.1：vendored Metal 液态玻璃（LiquidGlassEffectView，DnV1eX/
//            LiquidGlassKit 核心效果：折射 + 边缘光 + 主题染色，连续渲染、逐帧捕获，
//            与上游行为一致）。
//        触摸眩光（touchPoint）只在 Metal 档生效：26.2+ 档的背衬是磨砂视图、不实现
//        对应 selector，respondsToSelector 分流自然跳过。
//  - The parent container should have `borderRadius` (the host forwards it to the glass;
//    see layoutSubviews). It must NOT be relied on to clip: round 37 removed the tab bar's
//    `overflow: 'hidden'` so the lens droplet can overflow the bar vertically.
//  - `tint` prop：染色基色（不透明主题色，明暗自适应）。两种背衬都吃：磨砂档与 26.2+
//    的液态档 → 覆层基色；14～26.1 的液态档 → shader materialTint。本应用不传（纯玻璃，
//    不跟随主题色）：磨砂型走中性覆层色（浅色白/深色黑），Metal 档走 kit 预设动态色。
//  - `glassOpacity` prop：染色覆层的**用户值** 0~1（对应设置 theme.glassOpacity 0~100）。
//    实际 alpha 由 LGGlassViewFactory 内的 maxTintAlpha(0.6) 封顶。磨砂档与 26.2+ 的
//    液态档生效（后者同为磨砂视图）；14～26.1 的液态档不实现 setGlassOpacity:，
//    且设置 UI 在开关打开时隐藏该行。
//  - 主题属性（tint/glassOpacity/dark）由宿主缓存：liquid 切换会重建背衬，
//    RN 不会重推未变化的 prop，重建后由宿主重放（reapplyCachedPropsToBacking）。
//

#import <React/RCTConvert.h>
#import <React/RCTView.h>
#import <React/RCTViewManager.h>

// Mixed ObjC/Swift static-library pod: import the Swift-generated interface header.
// The emission location differs between Xcode configurations, so try the known candidates.
#if __has_include(<LiquidGlassKit/LiquidGlassKit-Swift.h>)
#import <LiquidGlassKit/LiquidGlassKit-Swift.h>
#elif __has_include("LiquidGlassKit-Swift.h")
#import "LiquidGlassKit-Swift.h"
#else
#error "LiquidGlassKit-Swift.h not found: mixed ObjC/Swift static pod interface header import failed"
#endif

// 玻璃背衬的可选定制入口（selector 是否存在由具体形态决定，宿主一律按
// respondsToSelector 分流；经此 protocol 转型让 selector 对编译器可见——
// 直接在 UIView* 上调用会报 "no visible @interface"，CI 曾因此编译失败）：
//   - LGFrostedGlassView：setGlassOpacity: / setIsDarkMode:
//     （磨砂档，以及 **26.2+ 的液态档**——该档同为此视图、只是 useNativeGlass:true）
//   - LiquidGlassEffectView：setTouchPoint: / clearTouchPoint:（触摸眩光，14～26.1 的
//     液态档；该档的浓度/明暗由主题染色表达，不实现上面两个 selector）
@protocol LGGlassBackingCustomizations <NSObject>
@optional
- (void)setGlassOpacity:(CGFloat)opacity;
- (void)setIsDarkMode:(BOOL)dark;
- (void)setTouchPoint:(CGPoint)point;
- (void)clearTouchPoint;
// 截背景时要隐藏的「玻璃组件根」：仅 Metal 液态档实现（磨砂档与 26.2+ 的液态档
// 都走系统材质，无截背景机制）。
- (void)setCaptureExclusionView:(nullable UIView *)view;
// 省电门（2026-09-30）：暂停/恢复 Metal 渲染循环（MTKView.isPaused）。仅 Metal
// 液态档实现——JS 在玻璃组件被压栈页完全覆盖（不可见）时置 true，期间停止逐帧
// draw；恢复后下一帧自动重捕获背景，无残帧。磨砂档不实现（respondsToSelector 分流）。
- (void)setPaused:(BOOL)paused;
// 实时采景会话（2026-10-02 用户第 2/9 条）：RN prop `live`，横向滑动 PagerView 的
// 手势会话期间置 true —— 采景从 30fps 基线放宽到 60fps，渲染档同步到 60fps
//（第 20 轮起两档同速，见 LiquidGlassView.syncRenderFrameRate），解决
// 「滑动时透过的画面延迟高/掉帧/像反向切入」。同样仅 Metal 液态档实现。
- (void)setRealtimeCapture:(BOOL)realtime;
@end

// 自研 LiquidLensView（液态透镜，LiquidGlassView(.lens) 引擎）的定制入口：
// 染色（nil=kit 预设动态色）/ 圆角 / 捕获排除根透传。宿主按 respondsToSelector
// 分流（部分入口为桥接面保留的空操作，见 LiquidLensView.swift）。
// 注：拖拽手势层已整体移除（2026-09-29 用户定案：上游无对应实现）——frames 合并
// 与透镜眩光的桥接入口（setLensFrames/setLensTouchPoint）随之删除，kit 本体的
// frames/touchPoint 能力不受影响。
@protocol LGLensCustomizations <NSObject>
@optional
- (void)setLensTintColor:(UIColor *)color;
- (void)setLensGlassOpacity:(CGFloat)opacity;
- (void)setLensCornerRadius:(CGFloat)radius;
- (void)setCaptureExclusionView:(nullable UIView *)view;
// 【第 38 轮】采景基准尺寸覆盖（CGSizeZero = 不覆盖，回落到透镜自身 bounds）。
// 水珠 morph 期间宿主把它锁成整段动画的最大外接尺寸：采景矩形/像素缓冲的尺寸一变，
// CABackdropLayer 就得整幅重新向 window server 要 backdrop（高帧率下合成跟不上就是
// 「黑线条 / 半张黑条」，见 LiquidGlassView.captureReferenceSize 的长注释）——
// 逐帧改尺寸的 morph 必须绕开这条路。
- (void)setLensCaptureReferenceSize:(CGSize)size;
@end

// Host view: an RCTView so all standard RN view props (borderRadius, overflow, pointerEvents,
// opacity, shadow*) keep working; the glass backing（双形态 × 版本分档，见
// LGGlassViewFactory.swift：磨砂全版本 systemMaterial；开关打开的 26.2+ 走系统原生
// UIGlassEffect(.regular)、14～26.1 走 vendored Metal，liquid prop 切换）sits inside a
// rounded clipping container. LGGlassViewFactory selects the backing.
// 主题属性（tint/glassOpacity/dark）缓存在宿主：liquid 切换会重建背衬，
// RN 不会重推未变化的 prop，重建后由宿主重放（reapplyCachedPropsToBacking）。
// 圆角曲线统一 circular（2026-09-29 定案「玻璃圆角与透镜一致」）：透镜
// （LiquidLensView）强制 circular → shader cornerRoundnessExponent=2 正圆角；
// 宿主原用 continuous（squircle 指数 4）端头偏方、视觉圆角显小，与透镜不一致。
// 统一后底部 tab 栏 / 迷你播放器 / 收起圆钮的玻璃端头与透镜同为正圆角。
// 注：常量名在旧 SDK(UIViewCornerCurveContinuous)与新 SDK(Xcode 26 起的 UICornerCurve
// 系列)间不一致,直接用底层字符串值,两端 SDK 均可编译且运行时行为相同。
// 注：不做按压玻璃形变——玻璃材质自带高对比边缘光，在裁剪容器内任何内缩都会让
// 材质自身的边缘线在胶囊内露出（方角/底边/内缘线均源于此），已验证两次故整体移除。
@interface LGLiquidGlassHostView : RCTView
/** 实际玻璃材质视图（磨砂 / 26.2+ 系统原生玻璃 / vendored Metal 液态玻璃），
    tint 作用于此；触摸眩光仅 Metal 档（26.2+ 档为磨砂视图，无对应 selector） */
@property (nonatomic, readonly) UIView *glassBacking;
/// 切换磨砂 ↔ 液态背衬：按缓存的主题属性重建背衬（liquid 全版本生效，见工厂；
/// 26.2+ 的液态档同为磨砂视图、仅材质换成系统原生玻璃）
- (void)applyLiquidMode:(BOOL)liquid;
/// 以下为 RN prop 的宿主入口：更新缓存并应用到当前背衬（respondsToSelector 分流）
- (void)applyTint:(UIColor *)tint;
- (void)applyGlassOpacity:(CGFloat)opacity;
- (void)applyDark:(BOOL)dark;
/// 实时采景会话（RN prop `live`）：更新缓存并应用到当前背衬（respondsToSelector 分流）
- (void)applyRealtimeCapture:(BOOL)realtime;
@end

@implementation LGLiquidGlassHostView {
  // _glassView = 圆角裁剪容器（圆角作用层）；_glassBacking = 内部玻璃材质视图
  // （磨砂档与 26.2+ 的液态档 = LGFrostedGlassView；14～26.1 的液态档 =
  // vendored Metal LiquidGlassEffectView）。
  // 分两层：UIKit 官方推荐的圆角毛玻璃做法，圆角裁剪容器让玻璃形状与宿主完全一致。
  UIView *_glassView;
  UIView *_glassBacking;
  // 主题属性缓存：liquid 切换重建背衬后由 reapplyCachedPropsToBacking 重放
  // （RN 只推送变化的 prop，未变化的不会自动重发，必须由宿主重放）。
  BOOL _liquid;
  BOOL _dark;
  BOOL _paused;
  BOOL _realtime;
  CGFloat _glassOpacity;
  UIColor *_tint;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    _glassOpacity = 0.4;
    // 宿主 init 时主题尚未下发，先按浅色磨砂建；随后 dark/liquid prop 会按需切换
    // （dark 只重建磨砂材质层；liquid 重建整个背衬，缓存属性由宿主重放）。
    [self installGlassBacking:[LGGlassViewFactory createGlassBackingWithDark:NO liquid:NO]];
    self.clipsToBounds = YES;
    // 常量名在旧 SDK(UIViewCornerCurveContinuous)与新 SDK(Xcode 26 起的 UICornerCurve 系列)间不一致,
    // 直接用底层字符串值,两端 SDK 均可编译且运行时行为相同。
    self.layer.cornerCurve = @"circular";
  }
  return self;
}

- (void)installGlassBacking:(UIView *)backing {
  // liquid 切换会重复安装：先移除旧容器（背衬随容器一起移除）。
  [_glassView removeFromSuperview];
  // 玻璃材质视图包进圆角裁剪容器：容器圆角+裁剪让玻璃形状与宿主完全一致。
  // 容器与背景层都不参与命中测试：触摸一律穿透到上层的 RN 内容视图
  // （Tab 项、播放条按钮、宿主手势）
  UIView *container = [[UIView alloc] init];
  container.userInteractionEnabled = NO;
  container.backgroundColor = [UIColor clearColor];
  container.clipsToBounds = YES;
  container.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  // 显式铺满宿主「当前」尺寸：autoresizing 只在**宿主 bounds 变化的那一刻**按增量重排子视图。
  // 挂载路径（init 时宿主还是 .zero，随后由 RN 布局到实际尺寸）本来就依赖那一次增量，这里取到
  // 零尺寸与原行为逐字等价；但 liquid 开关切换会**在宿主尺寸已定型之后**重建背衬
  // （applyLiquidMode: → 本方法），此刻之后不会再有任何 bounds 变化，容器于是永久停在 0×0 ——
  // 背衬整树（材质层 + 染色覆层）零尺寸，玻璃不可见，glassOpacity 也没有可着色的对象。
  // 这正是「取消勾选液态玻璃后，底部 tab 栏与迷你播放器的玻璃不透明度滑条拖了没反应」：
  // 两个消费点在同一次设置变更里各自重建、同时失效。显式写入后两条路径得到同一几何，
  // 紧接着的 reapplyCachedPropsToBacking 也会立即作用在可见背衬上。
  container.frame = CGRectMake(0, 0, CGRectGetWidth(self.bounds), CGRectGetHeight(self.bounds));
  backing.userInteractionEnabled = NO;
  backing.backgroundColor = [UIColor clearColor];
  backing.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  backing.frame = container.bounds;
  [container addSubview:backing];
  [self addSubview:container];
  container.layer.cornerRadius = self.layer.cornerRadius;
  container.layer.cornerCurve = self.layer.cornerCurve;
  backing.layer.cornerRadius = self.layer.cornerRadius;
  backing.layer.cornerCurve = self.layer.cornerCurve;
  // 边缘立体感（替代已移除的 ShadowView 阴影环）：0.5pt 半透明暗缘线。
  // 普通 layer border 无合成滤镜/混合模式，任何动画下稳定不产生黑边；
  // 外圈氛围阴影已移除（用户反馈胶囊下方有「底子」），立体感由玻璃自身
  // 边缘光 + 此内缘线提供。
  container.layer.borderWidth = 0.5;
  container.layer.borderColor = [UIColor colorWithWhite:0 alpha:0.12].CGColor;
  _glassBacking = backing;
  _glassView = container;
  // 截背景排除根 = JS 父容器（本宿主的 superview）：宿主是叶子（只装玻璃背衬），
  // 前景内容（tab 图标/播放条按钮/文字）是父容器的**其它子节点**——排除根若指宿主，
  // 捕获时前景仍会被画进玻璃的背景捕获纹理，经 shader 降采样折射成重影/黑影
  // （真机 iOS 26.2+ 截图实锤：LX/歌词/Tab 图标全部重影）。隐藏父容器整树 =
  // 同时排除玻璃输出与前景。挂载前 superview 为空先退回宿主自身，didMoveToSuperview
  // 挂载/重挂时自动改指父容器。磨砂档与 26.2+ 的液态档（同为磨砂视图）不实现该
  // selector（respondsToSelector 分流），二者都走系统材质、无捕获机制。
  id<LGGlassBackingCustomizations> backingForCapture = (id<LGGlassBackingCustomizations>)backing;
  if ([backingForCapture respondsToSelector:@selector(setCaptureExclusionView:)]) {
    [backingForCapture setCaptureExclusionView:self.superview ?: self];
  }
  // 新背衬不携带任何旧属性：重放缓存的主题属性（tint/glassOpacity/dark）
  [self reapplyCachedPropsToBacking];
}

// 把缓存的主题属性重放到当前背衬。各 apply* 方法内部按 respondsToSelector 分流：
// 磨砂档与 26.2+ 的液态档实现 setGlassOpacity:/setIsDarkMode:；14～26.1 的液态档
// 不实现（该档的明暗/浓度由主题染色表达、设置 UI 已隐藏对应行）。
- (void)reapplyCachedPropsToBacking {
  [self applyTint:_tint];
  [self applyGlassOpacity:_glassOpacity];
  [self applyDark:_dark];
  // 省电门不是 backing 持有的持久语义（MTKView 属性随背衬重建重置）：
  // 覆盖状态下切液态开关重建背衬，重放 _paused 让新背衬立即回到暂停态。
  [self applyPaused:_paused];
  // 同理：实时采景会话（横滑进行中恰好切换液态开关重建背衬）也要重放，否则新背衬
  // 会掉回 30fps 档、玻璃在剩余滑动里又是慢一拍（用户第 9 条）。
  [self applyRealtimeCapture:_realtime];
}

// 切换磨砂 ↔ 液态背衬（liquid prop 驱动，全 iOS 版本实际切换；26.2+ 的液态档
// 换来的仍是磨砂视图——只是材质由 UIBlurEffect 变成系统原生玻璃，见工厂）
- (void)applyLiquidMode:(BOOL)liquid {
  if (liquid == _liquid) return;
  _liquid = liquid;
  [self installGlassBacking:[LGGlassViewFactory createGlassBackingWithDark:_dark liquid:_liquid]];
}

- (void)applyTint:(UIColor *)tint {
  _tint = tint;
  [LGGlassViewFactory applyGlassTint:_glassBacking tint:_tint];
}

- (void)applyGlassOpacity:(CGFloat)opacity {
  _glassOpacity = opacity;
  // 经 protocol 转型：UIView* 上直接调未声明 selector 编译不过（CI 曾因此失败）
  id<LGGlassBackingCustomizations> backing = (id<LGGlassBackingCustomizations>)_glassBacking;
  if ([backing respondsToSelector:@selector(setGlassOpacity:)]) {
    [backing setGlassOpacity:_glassOpacity];
  }
}

- (void)applyDark:(BOOL)dark {
  _dark = dark;
  id<LGGlassBackingCustomizations> backing = (id<LGGlassBackingCustomizations>)_glassBacking;
  if ([backing respondsToSelector:@selector(setIsDarkMode:)]) {
    [backing setIsDarkMode:_dark];
  }
}

// 省电门：暂停/恢复 Metal 渲染循环。仅 Metal 液态档实现 setPaused:（磨砂档/
// 26.2+ 液态档是系统材质视图，respondsToSelector 分流后 no-op）。paused 状态由
// JS 按「玻璃所在屏幕是否为栈顶」驱动，被覆盖期间零逐帧 draw。
- (void)applyPaused:(BOOL)paused {
  _paused = paused;
  id<LGGlassBackingCustomizations> backing = (id<LGGlassBackingCustomizations>)_glassBacking;
  if ([backing respondsToSelector:@selector(setPaused:)]) {
    [backing setPaused:_paused];
  }
}

// 实时采景会话（RN prop `live`）。仅 Metal 液态档实现 setRealtimeCapture:（磨砂档 /
// 26.2+ 液态档是系统材质视图，respondsToSelector 分流后 no-op —— 系统材质的背景
// 由系统自己实时处理，本就没有采景节流这回事）。
- (void)applyRealtimeCapture:(BOOL)realtime {
  _realtime = realtime;
  id<LGGlassBackingCustomizations> backing = (id<LGGlassBackingCustomizations>)_glassBacking;
  if ([backing respondsToSelector:@selector(setRealtimeCapture:)]) {
    [backing setRealtimeCapture:_realtime];
  }
}

- (void)layoutSubviews {
  [super layoutSubviews];
  // RN 设置在宿主 RCTView 上的圆角转发给玻璃容器与材质视图（自研路径的
  // shader uniforms.cornerRadius 驱动折射形状；原生路径由圆角容器裁剪）。
  // 玻璃严格填满宿主（autoresizing 维护 frame），不向裁剪区外预伸——超界部分在
  // 容器逐帧变形时会导致玻璃效果采样出错（黑边）。
  _glassView.layer.cornerRadius = self.layer.cornerRadius;
  _glassView.layer.cornerCurve = self.layer.cornerCurve;
  _glassBacking.layer.cornerRadius = self.layer.cornerRadius;
  _glassBacking.layer.cornerCurve = self.layer.cornerCurve;
}

// 挂载/重挂/脱离层级时同步排除根：排除根 = JS 父容器（见 installGlassBacking 注释——
// 前景内容是父容器的其它子节点，只排除宿主会漏掉前景）。脱离层级（superview = nil）
// 时置空回退 kit 默认解析；液态开关重建背衬后由 installGlassBacking 以当时 superview 重设。
- (void)didMoveToSuperview {
  [super didMoveToSuperview];
  id<LGGlassBackingCustomizations> backing = (id<LGGlassBackingCustomizations>)_glassBacking;
  if (![backing respondsToSelector:@selector(setCaptureExclusionView:)]) return;
  [backing setCaptureExclusionView:self.superview];
}

// touchPoint 眩光（kit 能力）：手指在栏体空白区域按下/移动时，玻璃高光跟随手指。
// 触摸落在 tab 项/按钮上时由对应视图接管，此宿主收不到——效果为部分区域生效，可接受。
// 仅 14～26.1 的液态档（Metal）有效：26.2+ 与磨砂档的背衬是磨砂视图、没有该 selector，
// updateGlassTouchPoint 的 respondsToSelector 守卫直接返回。
- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  [super touchesBegan:touches withEvent:event];
  [self updateGlassTouchPoint:touches.anyObject];
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  [super touchesMoved:touches withEvent:event];
  [self updateGlassTouchPoint:touches.anyObject];
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  [super touchesEnded:touches withEvent:event];
  [self clearGlassTouchPoint];
}

- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  [super touchesCancelled:touches withEvent:event];
  [self clearGlassTouchPoint];
}

- (void)updateGlassTouchPoint:(UITouch *)touch {
  if (touch == nil) return;
  id<LGGlassBackingCustomizations> glass = (id<LGGlassBackingCustomizations>)_glassBacking;
  if (![glass respondsToSelector:@selector(setTouchPoint:)]) return;
  [glass setTouchPoint:[touch locationInView:_glassBacking]];
}

- (void)clearGlassTouchPoint {
  id<LGGlassBackingCustomizations> glass = (id<LGGlassBackingCustomizations>)_glassBacking;
  if (![glass respondsToSelector:@selector(clearTouchPoint)]) return;
  [glass clearTouchPoint];
}

@end

@interface LiquidGlassViewManager : RCTViewManager
@end

@implementation LiquidGlassViewManager

RCT_EXPORT_MODULE(LiquidGlassView)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (UIView *)view {
  return [[LGLiquidGlassHostView alloc] init];
}

// 主题染色：玻璃材质色跟随 App 主题（JS 传入主题氛围色 rgba 字符串）。
// 磨砂档与 26.2+ 的液态档 → 染色覆层基色；14～26.1 的液态档 → shader materialTint
// （工厂内按背衬类型分派）。
RCT_CUSTOM_VIEW_PROPERTY(tint, NSString, LGLiquidGlassHostView) {
  if (json == nil) return;
  [view applyTint:[RCTConvert UIColor:json]];
}

// 染色覆层的**用户值**（0~1，对应设置 theme.glassOpacity 0~100）。
// json 为 nil（prop 未传/重置）时回默认 0.4。磨砂档与 26.2+ 的液态档生效（前者的
// 覆层、后者同为 LGFrostedGlassView）；14～26.1 的液态档不实现该 selector，且设置 UI
// 在开关打开时隐藏该行。原生侧会再乘 maxTintAlpha(0.6) 封顶，见 LGGlassViewFactory.swift。
RCT_CUSTOM_VIEW_PROPERTY(glassOpacity, NSNumber, LGLiquidGlassHostView) {
  [view applyGlassOpacity:(json != nil ? [json floatValue] : 0.4)];
}

// App 主题明暗（JS 传 theme.isDark）。
// 系统材质（UIBlurEffect / UIGlassEffect）是**动态材质**，按 traitCollection.userInterfaceStyle
// 解析明暗；而本项目在 window 层没有统一 override，App 主题可与系统明暗不一致 ——
// 不下发就会在「App 深色 + 系统浅色」时渲染出一层亮色磨砂，与整体配色相反。
// UIVisualEffectView 不支持事后改 overrideUserInterfaceStyle，backing 内部会重建材质层；
// tint / glassOpacity 由 backing 自身持有，重建不丢，宿主无需重建 backing。
// json 为 nil（prop 未传/重置）时回默认浅色 NO。
RCT_CUSTOM_VIEW_PROPERTY(dark, NSNumber, LGLiquidGlassHostView) {
  [view applyDark:(json != nil ? [json boolValue] : NO)];
}

// 液态玻璃开关（设置 theme.liquidGlass，全 iOS 版本实际生效）：
// 切换时重建背衬（磨砂 ↔ 26.2+ 的系统原生玻璃 / 14～26.1 的 vendored Metal 液态玻璃），
// 缓存的主题属性由宿主重放。
// json 为 nil（prop 未传/重置）时回磨砂。
RCT_CUSTOM_VIEW_PROPERTY(liquid, NSNumber, LGLiquidGlassHostView) {
  [view applyLiquidMode:(json != nil ? [json boolValue] : NO)];
}

// 省电门（JS 传「玻璃所在屏幕是否被压栈页覆盖」）：覆盖期间暂停 Metal 逐帧渲染，
// 恢复时先做一次性复位（丢旧纹理 + 立刻重捕获，见 LiquidGlassView.handleResumeFromPause，
// 2026-10-02 用户第 2 条「返回主界面时玻璃里先闪一帧旧画面」）再继续渲染。磨砂档 no-op。
// json 为 nil（prop 未传/重置）时回 NO（渲染）。
RCT_CUSTOM_VIEW_PROPERTY(paused, NSNumber, LGLiquidGlassHostView) {
  [view applyPaused:(json != nil ? [json boolValue] : NO)];
}

// 实时采景（JS 传「横向滑动 PagerView 的手势会话是否进行中」，2026-10-02 用户第 2/9 条）：
// 会话期间采景从静止态基线 30fps 放宽到 60fps、渲染档同步到 60fps（第 20 轮起两档
// 同速，见 LiquidGlassView 的 setRealtimeCapture / syncRenderFrameRate）。
// 磨砂档 / 26.2+ no-op（系统材质无采景节流）。
// json 为 nil（prop 未传/重置）时回 NO（回到静止态基线）。
RCT_CUSTOM_VIEW_PROPERTY(live, NSNumber, LGLiquidGlassHostView) {
  [view applyRealtimeCapture:(json != nil ? [json boolValue] : NO)];
}

@end

// ============================================================================
// LiquidGlassLens —— Tab 切换的液态透镜药丸（上游 LiquidLensView）
// ============================================================================
// 用法（JS，见 src/components/common/LiquidLens.tsx + ModernTabBar）：
// - 组件本身是一条横向条带（RN 绝对定位放在 tab 图标带上），透镜药丸在其内部；
// - `x` prop：药丸目标中心 X（相对本组件）。首次设置直接落位，之后由原生
//   UIView 弹簧动画滑动过去（避免 RN 布局逐帧过桥的卡顿）；滑动期间透镜
//   抬起（LiquidGlassView(.lens) morph），内部的 CADisplayLink 跟踪自身位置
//   做加速度挤压/拉伸变形，落定回落静止药丸；
// - 切页交互只有快速点击（上层 tab Pressable → JS setNavActiveId → x 更新）。
//   长按/横滑拖拽切页已整体移除（2026-09-29 用户定案：上游 LiquidGlassKit 无
//   此手势层，凡上游没有的本地发明一律不要）；
// - 静止态药丸常显（上游 resting 状态：半透明白色药丸常驻选中 tab）；`pillColor`
//   prop 可覆盖药丸底色（JS 当前不传，走 Swift 默认白 30%）。

@interface LGLiquidLensHostView : RCTView
@end

// 【第 37 轮新增样式】水珠态几何：长按激活拖动时，透镜从「与槽等宽的胶囊」长成
// 直径 = kLGDropletScale × 栏高的圆，纵向溢出栏体上下边缘。
// 【第 38 轮】1.45 → 1.30（用户反馈「变大气泡有点大了，减小一点」）：在
// iPhone 16 Pro Max（栏高 56 / 槽宽 ~78）下水珠直径 81 → 73pt，纵向溢出 12.6 → 8.4pt，
// 仍在栏体上下各冒出一头（参考图的核心特征），横向 ≈ 槽宽的 93%、不再比整个图标位还宽。
// 由于透镜是正方形 frame，Swift 侧取 min(w,h)/2 恰好画成正圆。
static const CGFloat kLGDropletScale = 1.30;

// 【第 38 轮】水珠 morph（长按胀开 / 松手缩回）的逐帧补间参数。
// 为什么不再用 UIView 弹簧动画（第 37 轮的写法）：透镜的可见形态是 Metal 玻璃，
// 它的**形状来自 shader 每帧现读的 bounds**（LiquidGlassView.updateUniforms 的
// resolution + 圆角），而 UIView 动画只动 CoreAnimation 的呈现层 —— 模型 bounds 在
// 动画开始的瞬间就写到了终点，于是透镜按终点尺寸渲染、动画形同虚设（用户看到的就是
// 「长按 / 松手都是瞬变，没有由大变小/由小变大的过程」）。
// 改成宿主自己用 CADisplayLink 逐帧推进一个 0..1 的进度、每帧把**模型几何**写实
// （setNeedsLayout + layoutIfNeeded），玻璃的每一帧都按当帧尺寸重新算 SDF，
// 过程真正可见；而且这是模型层补间，跟手通道的 [lens.layer removeAllAnimations]
// （followX 每次写入都会调）绝不会把它打断。
// 弹簧取近临界阻尼（ω = sqrt(170) ≈ 13 rad/s，ζ = 26 / (2·13) ≈ 0.99）：≈0.3s 平滑到位、
// 无可见回弹；长按中途松手时目标翻转，进度与速度**接力**（不重置），过渡自然。
static const CGFloat kLGDropletSpringStiffness = 170.0;
static const CGFloat kLGDropletSpringDamping = 26.0;
static const CGFloat kLGDropletRestProgress = 0.002; // 进度与目标差 < 此值
static const CGFloat kLGDropletRestVelocity = 0.02;  // 且速度 < 此值 ⇒ 视为到位、停表

@implementation LGLiquidLensHostView {
  // 恒为自研 LiquidLensView（LGLensFactory 统一创建）。上游亦为自研复刻，
  // 从不调用系统私有 _UILiquidLensView（其不响应本组件方法面，且形状不可控）；
  // 自研类编译期遵循 AnyLiquidLensView 方法面
  UIView<AnyLiquidLensView> *_lens;
  CGFloat _x;
  BOOL _hasX;
  CGFloat _pillWidth;
  CGFloat _lastWidth; // 上一次布局的宿主宽度（等比重映射的基准，0 = 尚未布局）
  // 水珠态（第 37 轮新增样式，JS 经 droplet prop 下发）
  BOOL _droplet;
  // 【第 38 轮】水珠 morph 的逐帧补间状态（见 setDroplet: 与文件顶部常量注释）：
  // _dropletProgress 0..1（0 = 与槽等宽的胶囊，1 = 水珠满径），_dropletTarget 是它的
  // 目标值，_dropletVelocity 是弹簧积分器的速度，_dropletLink 是驱动它们的显示链接。
  CGFloat _dropletProgress;
  CGFloat _dropletTarget;
  CGFloat _dropletVelocity;
  CFTimeInterval _dropletLastTimestamp;
  CADisplayLink *_dropletLink;
  // 【第 37 轮第 1 条】「在途的点击弹簧被跟手一笔打断」标记。
  // setTargetX:animated:YES 的 completion 原本在 finished == NO 时直接 return，
  // 把「落回静止药丸」整个跳过——而跟手通道（followX）每一次写入都会
  // [lens.layer removeAllAnimations]，于是「点击弹簧在途时来了一笔跟手」就必然
  // 让 finished == NO ⇒ 透镜永远停在抬起态（用户看到的就是那个「椭圆形气泡」，
  // 即抬起玻璃本身：宽度 ≠ 槽宽、上下还带形变），点一下才会由新的点击弹簧收尾。
  // 标记的语义：本笔跟手打断了点击弹簧，弹簧的 completion 必须补做落回；
  // 若换成新的点击弹簧（animated:YES 分支）则清掉标记，由新弹簧自己负责收尾。
  BOOL _followTookOver;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    _lens = [LGLensFactory createLens];
    // 透镜本体不参与命中测试：触摸穿透到上层的 tab Pressable
    _lens.userInteractionEnabled = NO;
    // 首次落位前先隐藏；落位后静止态常显（对齐上游 LiquidLensView 的静止
    // 状态：半透明白色药丸常驻在选中 tab 上，未交互时持续可见）
    _lens.alpha = 0;
    _lens.autoresizingMask = UIViewAutoresizingFlexibleHeight;
    [self addSubview:_lens];
    _pillWidth = 56.0;
    // 挤压/拉伸变形（以及第 37 轮的水珠态）都会越界：透镜自身从不裁剪。
    // 第 37 轮起外层 tab 栏也不再裁剪（ModernTabBar 的 bar 样式 overflow: 'visible'，
    // 水珠要纵向溢出栏体），越界部分直接可见。
    self.clipsToBounds = NO;
  }
  return self;
}

- (void)layoutSubviews {
  [super layoutSubviews];
  CGFloat width = self.bounds.size.width;
  // 宿主宽度变化（iPad 旋转等）：目标位等比静默重映射（x 公式为
  // (index+0.5)*w/count，等比映射结果与 JS 按新宽度重算的值完全一致），
  // 随后 JS 经 onLayout 重推的 x 会被 setTargetX 的同位守卫拦截，
  // 不会在旋转瞬间凭空播一次「淡入滑动淡出」闪现。onLayout 链路必然
  // 晚于本布局轮，顺序有保证。
  if (_hasX && _lastWidth > 0 && width > 0 && fabs(width - _lastWidth) > 0.5) {
    _x = _x * (width / _lastWidth);
  }
  _lastWidth = width;
  CGFloat height = self.bounds.size.height;
  // 【第 37 轮新增样式 / 第 38 轮改为逐帧补间】水珠态：正方形 frame（边长 =
  // kLGDropletScale × 栏高），中心仍锁在槽心 (_x, h/2) —— 纵向溢出栏体上下边缘由
  // JS 侧解除栏体裁剪后可见（见 ModernTabBar 的 bar 样式：overflow: 'visible'）。
  // Swift 侧的静止药丸/抬起玻璃都按 bounds 现算，正方形 bounds + 圆角 override = -1
  // ⇒ min(w,h)/2 = 正圆，即水珠。
  // 第 38 轮起不再只有「药丸 / 水珠」两个端点：_dropletProgress（0..1）由
  // stepDropletAnimation: 逐帧推进，这里按进度在两端之间插值（宽 槽宽→水珠径、
  // 高 栏高→水珠径），**每一帧都是真的写进 bounds 的模型几何** —— 玻璃的形状由
  // shader 每帧现读 bounds 现算，所以 morph 过程肉眼可见（第 37 轮用 UIView 弹簧
  // 动画呈现层，模型 bounds 一瞬间就到终点，玻璃按终点尺寸渲染，形同瞬变）。
  // 逐帧取整是对齐 Metal 采景/着色栅格（同 LiquidLensView.applySpeedSize 的取整
  // 注释：非整数尺寸会让采景栅格落在半像素上、边缘出现暗色接缝）。
  BOOL dropletGeometry = height > 0 && (_droplet || _dropletProgress > 0);
  // 取整必须用 C 函数 round()：这里曾写成 Swift 风格的 (…).rounded()，
  // 而 ObjC++ 里 CGFloat（= double）是标量、没有成员函数 —— clang 直接判错，
  // CI（LiquidGlassKit 目标 CompileC）实锤编译失败。Swift 侧（LiquidLensView.swift）
  // 的 .rounded() 是合法 Swift，不受影响。
  CGFloat dropletSide = round(height * kLGDropletScale);
  if (dropletGeometry) {
    CGFloat progress = _dropletProgress < 0 ? 0 : (_dropletProgress > 1 ? 1 : _dropletProgress);
    CGFloat lensWidth = round(_pillWidth + (dropletSide - _pillWidth) * progress);
    CGFloat lensHeight = round(height + (dropletSide - height) * progress);
    _lens.bounds = CGRectMake(0, 0, lensWidth, lensHeight);
    _lens.center = CGPointMake(_x, height / 2.0);
  } else {
    _lens.frame = CGRectMake(0, 0, _pillWidth, height);
    _lens.center = CGPointMake(_x, height / 2.0);
  }
  // 圆角对齐宿主（JS 条带样式当前未设 borderRadius → 宿主 cornerRadius = 0，
  // 不推送圆角，透镜走默认胶囊 = min(宽,高)/2 = 28，与栏体 designRadius.glass
  // 一致；若未来 JS 设了圆角，此处钳制后推送），但必须钳制到
  // 不超过胶囊几何极限（min(宽,高)/2）：圆角大于短边一半时自研 shader 的圆角
  // SDF 不做钳制，会把透镜画成近矩形。钳制后高 56 的透镜取 28 = 标准圆角胶囊，
  // 且与栏体圆角在视觉上一致（UIKit 对 layer.cornerRadius 同样按短边一半收敛）。
  id<LGLensCustomizations> lensCustom = (id<LGLensCustomizations>)_lens;
  if ([lensCustom respondsToSelector:@selector(setLensCornerRadius:)]) {
    if (dropletGeometry) {
      // 水珠态 **及 morph 的每一个中间帧** 都走「胶囊几何极限」（override = -1 ⇒
      // min(w,h)/2）。不能沿用栏体圆角：正方形 bounds 下推送 28 会画成圆角方形，
      // 不是水珠；而 morph 中间态（宽 > 高）取 min/2 恰好是标准胶囊 —— 第 38 轮把
      // 「只在水珠态用极限值」放宽到「整段 morph 都用极限值」，两端点与旧口径完全
      // 等价（进度 0 = 胶囊 28 / 进度 1 = 正圆），中间帧则从胶囊连续长成正圆。
      [lensCustom setLensCornerRadius:-1];
    } else if (self.bounds.size.height > 0 && _pillWidth > 0 && self.layer.cornerRadius > 0) {
      // 几何无效（首帧未布局 / RN 样式尚未应用）时不推送圆角：此时短边一半 = 0，
      // 推送 0 会把透镜 override 毒化成 0，下一次抬起玻璃即被 shader 画成矩形
      // （「透镜偶发变矩形」）。跳过本次，等几何有效的下一轮 layout 再对齐。
      CGFloat radius = MIN(MIN(self.layer.cornerRadius, _pillWidth / 2.0), self.bounds.size.height / 2.0);
      [lensCustom setLensCornerRadius:radius];
    }
  }
  // 【第 38 轮】采景基准尺寸：morph 期间锁成整段动画的**最大外接尺寸**（宽取两端较大
  // 者 = 槽宽，高取两端较大者 = 水珠径；两条插值都单调，最大值即全程上界）。
  // 为什么必须锁：采景矩形与背景像素缓冲都用这个尺寸（captureBaseSize），尺寸一变
  // CABackdropLayer 就得整幅重新向 window server 要 backdrop —— 0.3s 的 morph 若逐帧
  // 改尺寸，合成跟不上就会采到半张没合成的画面（LiquidGlassView.captureReferenceSize
  // 注释里的「黑线条 / 半张黑条」）。锁成常量后一整段 morph 只重建一次缓冲，
  // 形状变化全部交给 shader（updateUniforms 仍按 bounds 现算）。
  // 非水珠态推 CGSizeZero = 撤销覆盖，回落「采景基准 = 透镜 bounds」的旧口径。
  if ([lensCustom respondsToSelector:@selector(setLensCaptureReferenceSize:)]) {
    if (dropletGeometry) {
      [lensCustom setLensCaptureReferenceSize:CGSizeMake(MAX(_pillWidth, dropletSide), MAX(height, dropletSide))];
    } else {
      [lensCustom setLensCaptureReferenceSize:CGSizeZero];
    }
  }
}

// 挂载/重挂/脱离层级时同步排除根（= JS 父容器，即栏体玻璃的同一排除根）：透镜
// 叠在 tab 图标/文字上方，前景不排除会被折射进药丸。脱离层级置空回退默认解析。
- (void)didMoveToSuperview {
  [super didMoveToSuperview];
  id<LGLensCustomizations> lens = (id<LGLensCustomizations>)_lens;
  if (![lens respondsToSelector:@selector(setCaptureExclusionView:)]) return;
  [lens setCaptureExclusionView:self.superview];
}

- (void)setTargetX:(CGFloat)x animated:(BOOL)animated {
  // 同位守卫：目标与当前一致（JS 重渲染重推同一 x）时不重播动画——否则透镜
  // 会重新淡入再淡出，表现为"不消失/闪现"
  if (_hasX && fabs(x - _x) < 0.5) {
    _x = x;
    return;
  }
  _x = x;
  if (!_hasX) {
    // 首次落位不动画：直接停在选中 tab 上并进入静止常显态（上游 LiquidLensView
    // 的 resting 状态：半透明白色药丸常驻选中项）
    _hasX = YES;
    [self setNeedsLayout];
    _lens.alpha = 1.0;
    return;
  }
  if (animated) {
    // 点击切换：淡入 + 抬起 morph + 弹簧滑动（加速度挤压/拉伸由透镜内部
    // displayLink 跟踪位置产生），落定后先淡出再回落药丸（见 completion）
    // 新的点击弹簧接管：落回收尾由本次弹簧负责，清掉跟手打断标记
    _followTookOver = NO;
    [UIView animateWithDuration:0.1 animations:^{
      self->_lens.alpha = 1;
    }];
    [_lens setLifted:YES animated:YES alongsideAnimations:nil completion:nil];
    [UIView animateWithDuration:0.3
                          delay:0
         usingSpringWithDamping:0.8
          initialSpringVelocity:0
                        options:UIViewAnimationOptionBeginFromCurrentState |
                                UIViewAnimationOptionAllowUserInteraction
                     animations:^{
      self->_lens.center = CGPointMake(x, self.bounds.size.height / 2.0);
    } completion:^(BOOL finished) {
      // 【第 37 轮第 1 条】原写法是 `if (!finished) return;` —— 把「落回静止药丸」
      // 整个跳过。finished == NO 有两种成因，语义完全不同：
      //   ① 被**新的点击弹簧**接管（_followTookOver == NO）：新弹簧自己会在收尾时
      //      落回，这里跳过是对的（连续点击不闪）；
      //   ② 被**跟手一笔**打断（_followTookOver == YES）：跟手通道（followX）每次
      //      写入都先 [lens.layer removeAllAnimations]，弹簧必然 finished == NO，
      //      而跟手不会再补一次落回 ⇒ 透镜永远停在抬起态。用户看到的就是那个
      //      「椭圆形气泡」（抬起玻璃本身：宽度 ≠ 槽宽、边缘还带速度形变），
      //      文字自然不在它的正中心；点击换 tab 时新的弹簧收尾才把它落回。
      //      本分支必须补做落回，否则这一笔跟手就把药丸永久卡在抬起态。
      if (!finished && !self->_followTookOver) return;
      self->_followTookOver = NO;
      // 落定回落药丸（跳过 morph 动画），保持静止常显（上游 resting 状态）
      [self->_lens setLifted:NO animated:NO alongsideAnimations:nil completion:nil];
    }];
  } else {
    _lens.center = CGPointMake(x, self.bounds.size.height / 2.0);
  }
}

// 【第 37 轮第 1 条】跟手/收尾专用的直落通道（JS 的 followX prop 走这里）。
// 与 setTargetX:animated:NO 的区别只有一个，但很关键：**跳过同位守卫**。
// 守卫的判据是「新目标与 _x（上一次命令的目标）之差 < 0.5pt」，而守卫就绪的前提
// 是「显示确实停在 _x 上」。跟手通道打破了这个前提：它用 removeAllAnimations
// 停掉在途弹簧（显示冻结在当前 presentation 位置），紧接着写 _x —— 于是
// _x 是新的、显示却可能停在别处。此后所有纠正写（收尾锚回槽心、静止位重申）
// 的目标恰好都 ≈ _x，全被守卫吞掉，错位就地永久固化（这正是用户报的
// 「滑一下就不对中、点一下才好」：点击走 x prop —— 它改的是 _x，值一变守卫就放行）。
// 所以跟手通道的每一笔都必须无条件落位；JS 侧的 0.1pt 去重仍在，桥流量不变。
- (void)applyFollowX:(CGFloat)x {
  // 记账：本笔会打断在途的点击弹簧，它的 completion 需要补做落回（见上面的分支）
  _followTookOver = YES;
  _x = x;
  if (!_hasX) {
    // 首次落位（与 setTargetX 的首次分支同义）：直接落位并进入静止常显态
    _hasX = YES;
    [self setNeedsLayout];
    _lens.alpha = 1.0;
    return;
  }
  _lens.center = CGPointMake(x, self.bounds.size.height / 2.0);
}

// 【第 37 轮新增样式 / 第 38 轮改逐帧补间】水珠态开关：长按激活拖动时长成圆、
// 所有收尾路径（松手 / 抬手 / 看门狗 / 会话兜底）缩回胶囊。
// 几何在 layoutSubviews 里按 _dropletProgress 现算；本方法只负责「把进度推向目标」：
// 启动/续用 CADisplayLink，弹簧积分器逐帧推进进度并把模型几何写实（见
// stepDropletAnimation:）。长按-松手快速交替时进度与速度接力，不会从旧起点重播。
- (void)setDroplet:(BOOL)droplet {
  CGFloat target = droplet ? 1.0 : 0.0;
  // 幂等：状态与目标都没变、弹簧也停在目标上 → 零动作（JS 重发同一 prop 不重播动画）
  if (_droplet == droplet && _dropletTarget == target &&
      fabs(_dropletProgress - target) < kLGDropletRestProgress &&
      fabs(_dropletVelocity) < kLGDropletRestVelocity) {
    return;
  }
  _droplet = droplet;
  _dropletTarget = target;
  // 目标可能是在途翻转（长按途中松手）：只换目标，进度/速度接力，morph 从当前
  // 状态平滑改向 —— 这正是「大水珠变小水珠」那一段的连续感来源。
  [self startDropletAnimation];
}

// 启动 morph 补间（已在跑则什么都不做）。显示链接强引用 target（self），
// 停下它的两条路：弹簧收敛（stepDropletAnimation: 末尾）与离窗（didMoveToWindow:）。
- (void)startDropletAnimation {
  if (_dropletLink) return;
  _dropletLastTimestamp = 0;
  CADisplayLink *link = [CADisplayLink displayLinkWithTarget:self selector:@selector(stepDropletAnimation:)];
  // 必须挂 .common 模式：长按期间手指按着不松 = runloop 处于 UITrackingRunLoopMode，
  // 只挂默认模式（NSDefaultRunLoopMode）的显示链接会被挂起 —— morph 会一直停在第 0 帧
  // 直到手指抬起，那就是另一种「没有变化过程」。
  [link addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
  _dropletLink = link;
}

- (void)stopDropletAnimation {
  [_dropletLink invalidate];
  _dropletLink = nil;
  _dropletLastTimestamp = 0;
}

// 显示链接回调（主线程，每个刷新帧一次，ProMotion 最高 120Hz）。
- (void)stepDropletAnimation:(CADisplayLink *)link {
  CFTimeInterval now = link.timestamp;
  CGFloat dt = _dropletLastTimestamp > 0 ? (CGFloat)(now - _dropletLastTimestamp) : (CGFloat)(1.0 / 60.0);
  _dropletLastTimestamp = now;
  // 首帧 / 掉帧 / 断片（退后台回来、桥阻塞）：步长夹到 [1/120, 1/30] 秒。半隐式欧拉
  // 的稳定性对步长敏感，一次大跳会让进度直接过冲、morph 出现一段「跳变」。
  if (dt < 1.0 / 120.0) dt = 1.0 / 120.0;
  if (dt > 1.0 / 30.0) dt = 1.0 / 30.0;
  // 近临界阻尼弹簧：a = -k·(p - target) - c·v（参数见文件顶部常量注释）
  CGFloat delta = _dropletProgress - _dropletTarget;
  _dropletVelocity += (-kLGDropletSpringStiffness * delta - kLGDropletSpringDamping * _dropletVelocity) * dt;
  _dropletProgress += _dropletVelocity * dt;
  // 夹回 [0, 1] 并同向清零速度（两端点之外没有几何意义，过冲必须就地吃掉）
  if (_dropletProgress <= 0.0) {
    _dropletProgress = 0.0;
    if (_dropletVelocity < 0.0) _dropletVelocity = 0.0;
  } else if (_dropletProgress >= 1.0) {
    _dropletProgress = 1.0;
    if (_dropletVelocity > 0.0) _dropletVelocity = 0.0;
  }
  // 每帧把**模型几何**写实：setNeedsLayout 必须先调（layoutIfNeeded 只在有脏布局时
  // 才真的跑 layoutSubviews）。droplet 分支按当帧进度重算 _lens 的 bounds/center，
  // 子视图 LiquidLensView 的 layoutSubviews 随之重排圆角/采景基准/玻璃形状。
  [self setNeedsLayout];
  [self layoutIfNeeded];
  if (fabs(_dropletProgress - _dropletTarget) < kLGDropletRestProgress &&
      fabs(_dropletVelocity) < kLGDropletRestVelocity) {
    // 到位：吸附到目标端点（消掉浮点残差）后再落一次位 —— 最后一帧的几何就是端点
    // 几何（进度恰好 0/1，采景基准与圆角同时切回静止口径），然后停表。
    _dropletProgress = _dropletTarget;
    _dropletVelocity = 0.0;
    [self setNeedsLayout];
    [self layoutIfNeeded];
    [self stopDropletAnimation];
  }
}

// 离开窗口（RN 卸载宿主 / 页面被移除）时停表：显示链接强引用 target（self），
// 不停就是「视图已卸载、链接还在每帧回调」的空转。进度保持当前值，重挂载后由下一次
// setDroplet（JS 在长按与各条收尾路径都会重发）纠正。
- (void)didMoveToWindow {
  [super didMoveToWindow];
  if (self.window == nil) [self stopDropletAnimation];
}

- (void)setPillWidth:(CGFloat)width {
  _pillWidth = width;
  [self setNeedsLayout];
}

- (UIView<AnyLiquidLensView> *)lens {
  return _lens;
}

@end

@interface LiquidGlassLensManager : RCTViewManager
@end

@implementation LiquidGlassLensManager

RCT_EXPORT_MODULE(LiquidGlassLens)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (UIView *)view {
  return [[LGLiquidLensHostView alloc] init];
}

// 药丸目标中心 X（相对本组件）；除首次外均带原生弹簧动画
RCT_CUSTOM_VIEW_PROPERTY(x, NSNumber, LGLiquidLensHostView) {
  if (json == nil) return;
  [view setTargetX:[json doubleValue] animated:YES];
}

// LX 跟手直落（B-7/C-6 横滑跟手 + A-5 长按拖动共用）：拖动期间由 JS 经
// setNativeProps 每帧写入药丸中心 X。与 x prop 的区别：x 恒定走 0.1s 淡入 +
// 0.3s 弹簧（点击切页路径），跟手必须零动画直落——否则每帧都会重启弹簧、
// 透镜永远追不上手指。进入本分支前先对透镜图层 removeAllAnimations，停掉
// 可能仍在途的点击弹簧（移除动画不改模型值，紧接着由直落分支写入新中心，
// 不会出现「先弹回旧目标再跳新位置」），并置 _followTookOver 让那颗被停掉的
// 弹簧在 completion 里补做「落回静止药丸」（第 37 轮第 1 条，见 applyFollowX）。
// 【第 37 轮第 1 条】改走 applyFollowX:（无条件落位、不吃同位守卫）：收尾锚回
// 与静止位重申也走这条通道，若它们的值与 _x 只差零点几 pt 就被守卫吞掉，
// 「显示冻结在打断点、_x 却已经是槽心」这类错位就永远纠不回来。
// 纯增量属性：原生未重编译时 JS 侧写入静默失败（followX 为可选 prop，不写不触发）。
RCT_CUSTOM_VIEW_PROPERTY(followX, NSNumber, LGLiquidLensHostView) {
  if (json == nil) return;
  [view.lens.layer removeAllAnimations];
  [view applyFollowX:[json doubleValue]];
}

// 【第 37 轮新增样式】水珠态（长按激活拖动）：true → 透镜长成圆、溢出栏体上下边缘
// （几何见 layoutSubviews 的 droplet 分支）。命令式 prop：JS 经 setNativeProps
// 下发（LiquidLens 的 setDroplet），声明式也可以传（undefined 不下发）。
// 纯增量属性：原生未重编译时静默失败，只少一个造型，不影响长按动力学。
RCT_CUSTOM_VIEW_PROPERTY(droplet, NSNumber, LGLiquidLensHostView) {
  if (json == nil) return;
  [view setDroplet:[json boolValue]];
}

// 主题染色：透镜覆层与底部栏玻璃同色（不透明基色，明暗自适应）
RCT_CUSTOM_VIEW_PROPERTY(tint, NSString, LGLiquidLensHostView) {
  if (json == nil) return;
  id<LGLensCustomizations> lens = (id<LGLensCustomizations>)view.lens;
  if (![lens respondsToSelector:@selector(setLensTintColor:)]) return;
  [lens setLensTintColor:[RCTConvert UIColor:json]];
}

// 染色覆层不透明度（0~1，用户设置 theme.glassOpacity 驱动）
RCT_CUSTOM_VIEW_PROPERTY(glassOpacity, NSNumber, LGLiquidLensHostView) {
  if (json == nil) return;
  id<LGLensCustomizations> lens = (id<LGLensCustomizations>)view.lens;
  if (![lens respondsToSelector:@selector(setLensGlassOpacity:)]) return;
  [lens setLensGlassOpacity:[json floatValue]];
}

// 按下态：药丸淡入纯透明染色药丸
RCT_CUSTOM_VIEW_PROPERTY(lifted, NSNumber, LGLiquidLensHostView) {
  if (json != nil) {
    [view.lens setLifted:[json boolValue]
                animated:YES
     alongsideAnimations:nil
              completion:nil];
  }
}

// 药丸宽度（默认 56）
// 静止药丸底色（跟随应用主题明暗，由 JS 传入 rgba 字符串；不传走 Swift 默认白 30%）
RCT_CUSTOM_VIEW_PROPERTY(pillColor, NSString, LGLiquidLensHostView) {
  if (json != nil) {
    view.lens.restingBackgroundColor = [RCTConvert UIColor:json];
  }
}

RCT_CUSTOM_VIEW_PROPERTY(pillWidth, NSNumber, LGLiquidLensHostView) {
  if (json != nil) {
    [view setPillWidth:[json doubleValue]];
  }
}

@end
