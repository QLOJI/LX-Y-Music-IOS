//
//  LiquidGlassView.swift
//  LiquidGlass (vendored from DnV1eX/LiquidGlassKit)
//
//  Created by Alexey Demin on 2025-12-05.
//  Vendored modifications for LX Music CocoaPods static-lib build (CI: Xcode 15.4 / Swift 5.10):
//  1. `internal import` (Swift 6.0+ syntax) replaced with plain `import`.
//  2. Shader loading switched from SwiftPM-precompiled default.metallib to on-device
//     runtime compilation via MTLDevice.makeLibrary(source:) using embedded MSL sources
//     (see LiquidGlassShaderSource.swift) — CI needs no Metal compile step, and a static
//     library pod has no resource bundle to hold a metallib.
//  3. Root-view capture (iOS 26.2+): exclusion roots hide every glass widget (glass
//     output + foreground) during capture, and the capture itself is the upstream
//     presentation-layer render (LXGlassTryRenderLayer @try sandbox -> drawHierarchy
//     fallback). The intermediate scheme (drawHierarchy afterScreenUpdates:true with
//     a static-capture throttle) leaked foreground icons, refracted the glass's own
//     previous frames, and its forced per-capture commit presented the hidden state
//     to the display (periodic blinking/jumping, recorded on video).
//     See captureRootView and LICENSE-NOTES.md.
//  4. Capture commit gate (2026-10-01): "not ready" now means "within a wall-clock
//     settle window (opened at backdrop insert / view enters window / beginLiveCapture)
//     AND the frame still looks suspicious". Closes two residuals: the frame-count hold
//     cap (4 frames = unbounded wall time when cold start drops frames) and the
//     uniform-only criterion (partially-composited frames are non-uniform and were
//     committed as-is). Partial-composite criterion = near-black grid-cell fraction,
//     disabled in dark appearance; every in-window hold is hard-capped by wall clock
//     so the glass can never stay permanently transparent nor keep a previous page.
//     See commitCapturedTexture / analyzeCapture / beginCaptureSettleWindow.
//  4b. Resume-from-pause settle window (2026-10-02): the pause→resume reset now opens the
//     settle window too (a fourth anchor, see handleResumeFromPause). A resumed backdrop
//     pipeline is as "just (re)built" as the other anchors; its first frames used to be
//     committed as-is even when partially composited (non-uniform but with near-black
//     bands), which the shader refracted into a black rim on the capsule edge — the
//     user-visible flicker on the tab bar / mini player when returning to a tab page.
//  Upstream: Copyright © 2025 DnV1eX, https://github.com/DnV1eX/LiquidGlassKit
//

import UIKit
import CoreVideo
import simd
import MetalKit
import MetalPerformanceShaders

struct LiquidGlass {

    /// Maximum number of rectangles supported in the shader.
    static let maxRectangles = 16

    /// Mirror the Metal 'ShaderUniforms' exactly for buffer binding.
    struct ShaderUniforms {
        var resolution: SIMD2<Float> = .zero        // Frame size in pixels.
        var contentsScale: Float = .zero            // Scale factor. 2 for Retina; 3 for Super Retina.
        var touchPoint: SIMD2<Float> = .zero        // Touch position in points (upper-left origin).
        var shapeMergeSmoothness: Float = .zero     // Specifies the distance between elements at which they begin to merge (spacing).
        var cornerRadius: Float = .zero             // Base rounding (e.g., 24 for subtle chamfer). Circle if half the side.
        var cornerRoundnessExponent: Float = 2      // 1 = diamond; 2 = circle; 4 = squircle.
        var materialTint: SIMD4<Float> = .zero      // RGBA; e.g., subtle cyan (0.2, 0.8, 1.0, 1.0)
        var glassThickness: Float                   // Fake parallax depth (e.g., 8-16 px)
        var refractiveIndex: Float                  // 1.45-1.52 for borosilicate glass feel
        var dispersionStrength: Float               // 0.0-0.02; prismatic color split on edges
        var fresnelDistanceRange: Float             // px falloff from silhouette (e.g., 32)
        var fresnelIntensity: Float                 // 0.0-1.0; rim lighting boost
        var fresnelEdgeSharpness: Float             // Power 1.0=linear, 8.0=crisp
        var glareDistanceRange: Float               // Similar to fresnel, but for specular streaks
        var glareAngleConvergence: Float            // 0.0-π; focuses rays toward light dir
        var glareOppositeSideBias: Float            // >1.0 amplifies back-side highlights
        var glareIntensity: Float                   // 1.0-4.0; bloom-like edge fire
        var glareEdgeSharpness: Float               // Matches fresnel for consistency
        var glareDirectionOffset: Float             // Radians; tilts streak asymmetry
        var rectangleCount: Int32 = .zero           // Number of active rectangles
        var rectangles: (                           // Array of rectangles (x, y, width, height) in points, upper-left origin.
            SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>,
            SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>,
            SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>,
            SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>
        ) = (.zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero,
             .zero, .zero, .zero, .zero, .zero, .zero, .zero, .zero)
    }

    let shaderUniforms: ShaderUniforms
    let backgroundTextureSizeCoefficient: Double
    let backgroundTextureScaleCoefficient: Double
    let backgroundTextureBlurRadius: Double
    var tintColor: UIColor?
    var shadowOverlay: Bool = false

    static func thumb(magnification: Double = 1) -> Self {
        .init(
            shaderUniforms: .init(
                materialTint: .init(x: 0.9, y: 0.95, z: 1.0, w: 0.15), // Near-clear with cool bias.
                glassThickness: 10,
                refractiveIndex: 1.11,
                dispersionStrength: 5,
                fresnelDistanceRange: 70,
                fresnelIntensity: 0,
                fresnelEdgeSharpness: 0,
                glareDistanceRange: 30,
                glareAngleConvergence: 0,
                glareOppositeSideBias: 0,
                glareIntensity: 0.01,
                glareEdgeSharpness: -0.2,
                glareDirectionOffset: .pi * 0.9
            ),
            backgroundTextureSizeCoefficient: 1 / magnification,
            backgroundTextureScaleCoefficient: magnification,
            backgroundTextureBlurRadius: 0,
            shadowOverlay: true
        )
    }

    static let lens = Self.init(
        shaderUniforms: .init(
            glassThickness: 6,
            refractiveIndex: 1.1,
            dispersionStrength: 15,
            fresnelDistanceRange: 70,
            fresnelIntensity: 0,
            fresnelEdgeSharpness: 0,
            glareDistanceRange: 30,
            glareAngleConvergence: 0.1,
            glareOppositeSideBias: 1,
            glareIntensity: 0.1,
            glareEdgeSharpness: -0.1,
            glareDirectionOffset: -.pi / 4
        ),
        backgroundTextureSizeCoefficient: 1.1,
        backgroundTextureScaleCoefficient: 0.8,
        backgroundTextureBlurRadius: 0,
        shadowOverlay: true
    )

    static let regular = Self.init(
        shaderUniforms: .init(
            glassThickness: 10,
            refractiveIndex: 1.5,
            dispersionStrength: 5,
            fresnelDistanceRange: 70,
            fresnelIntensity: 0,
            fresnelEdgeSharpness: 0,
            glareDistanceRange: 30,
            glareAngleConvergence: 0.1,
            glareOppositeSideBias: 1,
            glareIntensity: 0.1,
            glareEdgeSharpness: -0.15,
            glareDirectionOffset: -.pi / 4
        ),
        backgroundTextureSizeCoefficient: 1,
        backgroundTextureScaleCoefficient: 0.2,
        backgroundTextureBlurRadius: 0.3,
        tintColor: UIColor { $0.userInterfaceStyle == .dark ? #colorLiteral(red: 0, green: 0.04958364581, blue: 0.09951775161, alpha: 0.7981493615) : #colorLiteral(red: 0.9023525731, green: 0.9509486998, blue: 1, alpha: 0.8002892298) }//.systemBackground.withAlphaComponent(0.8),
    )

    /// Vendored addition: 纯透明玻璃 —— 不随主题明暗变化、几乎无染色、不做模糊，
    /// 只保留折射与边缘光，背景直接透过（对齐 iOS 26 原生 .clear 变体的观感）。
    /// tintColor 为 nil：materialTint 直接用上面的极淡值，updateUniforms 不再覆盖。
    static let clear = Self.init(
        shaderUniforms: .init(
            materialTint: .init(x: 1, y: 1, z: 1, w: 0.08),
            glassThickness: 8,
            refractiveIndex: 1.45,
            dispersionStrength: 8,
            fresnelDistanceRange: 70,
            fresnelIntensity: 0.3,
            fresnelEdgeSharpness: 2,
            glareDistanceRange: 30,
            glareAngleConvergence: 0.1,
            glareOppositeSideBias: 1,
            glareIntensity: 0.12,
            glareEdgeSharpness: -0.15,
            glareDirectionOffset: -.pi / 4
        ),
        backgroundTextureSizeCoefficient: 1,
        backgroundTextureScaleCoefficient: 0.5,
        backgroundTextureBlurRadius: 0,
        shadowOverlay: true
    )
}

final class BackdropView: UIView {

    /// iOS 26 重构了 backdrop 私有机制，`CABackdropLayer` 可能被移除/改名。
    /// 该类不存在时 `layerClass` 退化成 `CALayer`，此时对普通 CALayer 设置私有
    /// KVC key 会抛 `NSUnknownKeyException` 导致启动崩溃。故仅在 layer 确为
    /// `CABackdropLayer` 时才写私有属性，否则标记为不可用、捕获时跳过。
    private static let backdropLayerClass: AnyClass? = NSClassFromString("CABackdropLayer")

    override class var layerClass: AnyClass {
        backdropLayerClass ?? CALayer.self
    }

    /// 真正的 CABackdropLayer 是否可用（决定 captureBackdrop 是否能工作）
    var isBackdropAvailable: Bool {
        guard let cls = BackdropView.backdropLayerClass else { return false }
        return layer.isKind(of: cls)
    }

    init() {
        super.init(frame: .zero)

        // Configure backdrop view
        isUserInteractionEnabled = false

        // 仅对真正的 CABackdropLayer 写私有属性；普通 CALayer 上写未知 key 会崩溃（iOS 26 常见）。
        guard isBackdropAvailable else { return }

        layer.setValue(false, forKey: "layerUsesCoreImageFilters")

        // Configure backdrop layer properties (private API)
        layer.setValue(true, forKey: "windowServerAware")
        layer.setValue(UUID().uuidString, forKey: "groupName")
//        layer.setValue(1.0, forKey: "scale")  // Full resolution for capture
//        layer.setValue(0.0, forKey: "bleedAmount")
//        layer.setValue(false, forKey: "allowsHitTesting")
//        layer.setValue(true, forKey: "captureOnly")
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

final class ShadowView: UIView {

    init() {
        super.init(frame: .zero)

        isUserInteractionEnabled = false
        // 注：曾用 compositingFilter = "multiplyBlendMode" 合成阴影。CA 合成滤镜在
        // 图层动画/变形期间会失效，失效时该图层直接以黑色原样绘制——表现为收起/
        // 展开转场与透镜拖动时，胶囊边缘出现粗黑弧。移除合成滤镜后阴影以普通
        // 图层渲染，动画期间稳定。
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let shadowRadius = 3.5
        let path = UIBezierPath(roundedRect: bounds.insetBy(dx: -1, dy: -shadowRadius / 2), cornerRadius: bounds.height / 2)
        let innerPill = UIBezierPath(roundedRect: bounds.insetBy(dx: 0, dy: shadowRadius / 2), cornerRadius: bounds.height / 2).reversing()
        path.append(innerPill)
        layer.shadowPath = path.cgPath
        layer.shadowRadius = shadowRadius
        layer.shadowOpacity = 0.2
        layer.shadowOffset = .init(width: 0, height: shadowRadius + 2)
    }
}

final class LiquidGlassRenderer {
    @MainActor static let shared = LiquidGlassRenderer()

    let device: MTLDevice
    /// nil 表示 shader 编译失败（如 iOS 26 Metal 运行时更严格）：此时玻璃退化为透明，
    /// 不致命崩溃，App 仍可正常使用。
    let pipelineState: MTLRenderPipelineState?

    private init() {
        guard let device = MTLCreateSystemDefaultDevice() else {
            fatalError("Metal not supported")
        }
        self.device = device
        self.pipelineState = LiquidGlassRenderer.buildPipeline(device: device)
    }

    /// 运行时编译 shader 并构建渲染管线；任何一步失败返回 nil（降级透明，不崩溃）。
    private static func buildPipeline(device: MTLDevice) -> MTLRenderPipelineState? {
        do {
            // Runtime shader compilation happens on-device, so the CI toolchain never
            // needs a Metal compiler and no metallib resource bundle is required.
            // (Upstream loads a SwiftPM-precompiled default.metallib here instead.)
            // 两个 MSL 必须各自独立编译：两份源码都定义了 VertexOutput（上游是两个
            // .metal 编译单元进同一个 metallib），拼成一个 source 会报重定义错误。
            let vertexLibrary = try device.makeLibrary(source: LiquidGlassShaderSource.vertex, options: nil)
            let fragmentLibrary = try device.makeLibrary(source: LiquidGlassShaderSource.fragment, options: nil)

            guard let vertexFunction = vertexLibrary.makeFunction(name: "fullscreenQuad"),
                  let fragmentFunction = fragmentLibrary.makeFunction(name: "liquidGlassEffect") else {
                return nil
            }

            let pipelineDescriptor = MTLRenderPipelineDescriptor()
            pipelineDescriptor.vertexFunction = vertexFunction
            pipelineDescriptor.fragmentFunction = fragmentFunction
            pipelineDescriptor.colorAttachments[0].pixelFormat = .bgra8Unorm  // Match MTKView

            return try device.makeRenderPipelineState(descriptor: pipelineDescriptor)
        } catch {
            print("[LiquidGlass] shader/pipeline build failed, falling back to transparent glass: \(error)")
            return nil
        }
    }
}

/// 全部存活玻璃实例的 weak 注册表（非隔离存储，init/deinit 均可安全访问）。
/// 截背景时必须互相排除：若只隐藏 self，屏幕上其它玻璃（底部栏透镜、迷你播放器
/// 等都是 LiquidGlassView）的 Metal 暗色内容会被 drawHierarchy 画进背景纹理，
/// 经折射偏移后形成胶囊旁黑影（迷你播放器右侧 / 切 tab 时透镜周围）。
private final class GlassInstanceRegistry {
    static let shared = GlassInstanceRegistry()
    let instances = NSHashTable<AnyObject>.weakObjects()

    private init() {
        // 【第 73 轮】滚动实时档的入口 —— 与冻结钩子**方向相反**的那条桥（那条是 Kit 调 App，
        // 这条是 App 调 Kit，见 LXGlassFreezeHook.h）。注册一次、之后只读，缺席时（本行没跑到）
        // App 侧的调用是空操作，玻璃行为与上游一致。
        // 非捕获闭包才能变成 C 函数指针：这里只引用注册表自己这个静态单例。
        LXGlassSetScrollActivityFn { GlassInstanceRegistry.shared.noteScrollActivity() }
        // 【第 124 轮】返回转场开始：App 在派发 pop 命令之前登记的这一脚会刷新所有
        // 暂停态玻璃的冻结帧（不恢复渲染，见 LXGlassFreezeHook.h 的第三条桥）。
        LXGlassSetRefreshFrozenFramesFn { GlassInstanceRegistry.shared.refreshFrozenFrames() }
        // 【第 153 轮】导航转场开始 / 结束的锚点：按「哪一屏」冻结 / 放开玻璃。
        LXGlassSetFreezeInViewFn { view, recapture in
            guard let view else { return }
            let target = Unmanaged<UIView>.fromOpaque(UnsafeRawPointer(view)).takeUnretainedValue()
            GlassInstanceRegistry.shared.freezeGlasses(in: target, recapture: recapture != 0)
        }
        LXGlassSetScreenSettledFn { view in
            guard let view else { return }
            let target = Unmanaged<UIView>.fromOpaque(UnsafeRawPointer(view)).takeUnretainedValue()
            GlassInstanceRegistry.shared.screenSettledGlasses(in: target)
        }
        // 【第 160 轮】JS 转场窗口：窗口内一律不采景（唯一能准确覆盖整段转场的信号）。
        LXGlassSetNavTransitionFn { active in
            GlassInstanceRegistry.shared.noteNavTransition(active: active != 0)
        }
    }

    /// JS 转场窗口的硬闸期限（窗口 420ms + 余量；每次开窗/续期都重新计时）。
    private var navTransitionGateUntil: TimeInterval = 0

    var isNavigationTransitionActive: Bool { CACurrentMediaTime() < navTransitionGateUntil }

    func noteNavTransition(active: Bool) {
        let now = CACurrentMediaTime()
        // JS 的窗口是 420ms；留 180ms 余量盖住最后几拍合成。
        navTransitionGateUntil = active ? now + 0.6 : now + 0.1
    }

    /// 转场开始：这一屏的玻璃从这一刻起停止采景（不暂停渲染，画面保持静止）。
    func freezeGlasses(in view: UIView, recapture: Bool) {
        for instance in instances.allObjects {
            guard let glass = instance as? LiquidGlassView,
                  glass.window != nil,
                  glass.isDescendant(of: view) else { continue }
            glass.beginNavigationFreeze(recapture: recapture)
        }
    }

    /// 这一屏的转场已经结束：允许采景，但再等两帧让最终合成落地。
    func screenSettledGlasses(in view: UIView) {
        for instance in instances.allObjects {
            guard let glass = instance as? LiquidGlassView,
                  glass.isDescendant(of: view) else { continue }
            glass.screenDidSettle()
            glass.endNavigationFreeze()
        }
    }

    // MARK: - 【第 73 轮】滚动实时档

    /// 滚动窗口的期限（墙钟秒）：现在 < 它 = 用户刚滚过。全局一份 —— 「用户正在滚动」本来
    /// 就是全局状态（同一时刻只有一根手指在一个列表上），在屏的每块玻璃读的都是同一个期限。
    private var scrollActiveUntil: TimeInterval = 0

    /// 现在是否处于「用户正在上下滚动」的窗口内。
    /// 与 isReentryLiveActive 同式：墙钟现算 —— 到期不需要谁来清，读的时候自己就过期了。
    /// 主线程读写（滚动事件在主线程；本类的到期定时器也挂主线程）。
    var isScrollActive: Bool { CACurrentMediaTime() < scrollActiveUntil }

    /// 滚动窗口时长：覆盖「相邻两拍滚动事件之间的间隔」并留出收尾余量。
    /// 必须比一帧长得多（手指按着不动时事件也会停，取一帧会在慢速拖动里反复掉档），
    /// 也不能长过手感本身的意义 —— 停手后最多再多花这 0.3s 的实时档代价（60fps 采景是
    /// 这条路径上手调过的上限，见 liveCaptureMinInterval 的注释）。
    private static let scrollLiveHoldDuration: TimeInterval = 0.3

    /// 到期回落定时器是否已经挂上（同时最多一个，见 scheduleScrollExpiry）
    private var scrollExpiryScheduled = false

    /// App 侧的用户滚动每帧回调一次（AppDelegate 的 scrollViewDidScroll swizzle →
    /// LXGlassNotifyScrollActivity → 本方法；同步、主线程，60~120 次/秒）。
    ///
    /// **热路径**：窗口内的续期只写一个时刻就返回 —— 不碰玻璃、不挂定时器、不做任何分配。
    /// 只有「从静止进入滚动」的那一脚要动手：把在屏玻璃提到实时档，并挂上到期回落。
    func noteScrollActivity() {
        let now = CACurrentMediaTime()
        let wasActive = now < scrollActiveUntil
        scrollActiveUntil = now + Self.scrollLiveHoldDuration
        guard !wasActive else { return }
        syncScrollLiveFrameRate()
        scheduleScrollExpiry()
    }

    /// 窗口到期后把在屏玻璃落回静止档。与 reentry 窗口同形态（见 LiquidGlassView 的
    /// scheduleReentryLiveExpiry）：一次性定时器、到点现算，不做每帧检查。
    /// 窗口在这期间被续期（用户还在滚）就再等一拍 —— 别把正在滑动的玻璃打回静止档。
    private func scheduleScrollExpiry() {
        guard !scrollExpiryScheduled else { return }
        scrollExpiryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.scrollLiveHoldDuration) { [weak self] in
            guard let self else { return }
            self.scrollExpiryScheduled = false
            if CACurrentMediaTime() < self.scrollActiveUntil {
                self.scheduleScrollExpiry()
                return
            }
            self.syncScrollLiveFrameRate()
        }
    }

    /// 把当前档位重新算一遍（进入滚动 / 窗口到期两个方向共用这一处）。
    /// 提档还是落档不在这里判断：各实例按 isScrollActive 现算（全类唯一的赋值点仍是
    /// LiquidGlassView.syncRenderFrameRate）—— 两处各判一次的话，两个方向迟早会漂移。
    private func syncScrollLiveFrameRate() {
        for instance in instances.allObjects {
            guard let glass = instance as? LiquidGlassView else { continue }
            glass.syncScrollLiveFrameRate()
        }
    }

    func add(_ view: LiquidGlassView) {
        instances.add(view)
    }

    /// 本窗口内需要从截屏排除的「玻璃组件根」（按身份去重 + 去掉互相包含的子根）：
    /// 每个实例解析为 captureExclusionView（nil → 所在 LiquidGlassEffectView → 实例
    /// 自身）。隐藏父级根即同时覆盖其下所有玻璃的 MTK 输出与玻璃上方的前景内容；
    /// 单独隐藏 MTK 不够——挂在玻璃上方的前景（RN 图标/按钮）也会被截进背景纹理。
    ///
    /// 【第 141 轮】排除根再往上收一层：本工程的迷你播放器把玻璃包在**只装玻璃**的
    /// 绝对定位 wrapper 里（PlayerBar 的 glassHost），封面/标题/歌词/按钮是该 wrapper
    /// 的**兄弟**——只隐藏 RN 宿主父级仍会把前景截进背景纹理，返回落点的根视图采景
    /// 于是把「自己的标题/歌词 + 胶囊暗缘」折射成重影与黑边（用户第 141 轮截图）。
    /// 这里从宿主父级往上找第一个「含其它非零子视图」的祖先（最多 3 层、且不能比
    /// 玻璃大出一圈），才把整块控件连同前景一起隐藏；找不到就退回原层级，绝不爬到
    /// 整屏（那会把要采的背景也藏掉）。
    func exclusionRoots(in window: UIWindow?) -> [UIView] {
        var roots: [UIView] = []
        var seen = Set<ObjectIdentifier>()
        for instance in instances.allObjects {
            guard let glass = instance as? LiquidGlassView, glass.window === window else { continue }
            let base = glass.captureExclusionView ?? (glass.superview as? LiquidGlassEffectView) ?? glass
            let root = Self.resolveExclusionRoot(base, glassBounds: glass.bounds)
            if seen.insert(ObjectIdentifier(root)).inserted { roots.append(root) }
        }
        return roots.filter { view in !roots.contains { $0 !== view && view.isDescendant(of: $0) } }
    }

    /// 见 exclusionRoots 的第 141 轮说明。纯几何判据，不依赖 RN 层级约定。
    private static func resolveExclusionRoot(_ base: UIView, glassBounds: CGRect) -> UIView {
        let maxWidth = glassBounds.width + 96
        let maxHeight = glassBounds.height + 96
        var root = base
        var depth = 0
        while depth < 3, let parent = root.superview {
            let bounds = parent.bounds
            guard bounds.width > 1, bounds.height > 1 else { break }
            if bounds.width > maxWidth || bounds.height > maxHeight { break }
            let hasForegroundSibling = parent.subviews.contains { sub in
                sub !== root && sub.bounds.width > 1 && sub.bounds.height > 1
            }
            if hasForegroundSibling { return parent }
            root = parent
            depth += 1
        }
        return base
    }

    /// 【第 157 轮】返回命令派发前：给暂停态玻璃按 **model** 重锁一次冻结帧。
    ///
    /// 现象：切入与切回时透过的画面差几像素（上下偏移）。冻结帧是在推页那一拍采的，
    /// 而列表在刹车之后还可能再落几像素；返回时背景已到最终位置，冻结帧落后 → 偏移。
    /// 返回开始这一刻主界面已经静止，按模型树采一帧就是返回后的真实背景，比推页时
    /// 那一张更准。只处理**暂停态**玻璃（返回侧按住门覆盖的正是它们），不碰其它屏。
    private var lastFrozenRefreshAt: TimeInterval = 0

    func refreshFrozenFrames() {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.refreshFrozenFrames() }
            return
        }
        guard UIApplication.shared.applicationState == .active else { return }
        let now = CACurrentMediaTime()
        guard now - lastFrozenRefreshAt >= 0.2 else { return }
        lastFrozenRefreshAt = now
        for instance in instances.allObjects {
            guard let glass = instance as? LiquidGlassView,
                  glass.window != nil,
                  glass.isPaused else { continue }
            glass.refreshFrozenFrameFromModel()
        }
    }
}

final class LiquidGlassView: MTKView {

    // var 而非 let：LiquidGlassEffectView.setGlassTintColor 会写入 tintColor 成员。
    // Swift 的可变性规则下，经 let 属性访问 struct 连成员赋值都被拒绝（需要写回整个属性）。
    var liquidGlass: LiquidGlass

    var commandQueue: MTLCommandQueue!
    var uniformsBuffer: MTLBuffer!
    var zeroCopyBridge: ZeroCopyBridge!

    // Background texture for the shader
    private var backgroundTexture: MTLTexture?

    /// 采景几何的参考尺寸（点）。nil（默认）→ 用自身 bounds，其它玻璃实例行为不变。
    ///
    /// 透镜抬起后按加速度做挤压/拉伸，bounds 逐帧变化（±30%，见 LiquidLensView.
    /// maxScaleDeviation）。采景矩形若跟着 bounds 走，CABackdropLayer 每帧都在变尺寸
    /// ——尺寸一变就必须整幅重新向 window server 要 backdrop，高速度拖动下合成跟不上，
    /// drawHierarchy 读到半张没合成的黑条，被 shader 折射进胶囊，就是用户报的
    /// 「滑动速度快后看见黑色线条」。锁定成静止尺寸后，拖动期间采景层只平移不缩放；
    /// 挤压/拉伸的观感全部由 shader 形状（updateUniforms 仍用 bounds）承担。
    var captureReferenceSize: CGSize?

    /// 连续均匀帧最多沿用上一帧纹理的帧数，见 commitCapturedTexture。
    private static let maxUniformHoldFrames = 4
    private var consecutiveUniformFrames = 0

    // MARK: - 未就绪判定：墙钟沉降窗口（2026-10-01）

    // 关掉 commitCapturedTexture 的两个残留窗口（背景见该函数的长注释）：
    //  ① 沿用上限从「帧数」改成「墙钟」——帧数口径在冷启动掉帧时无法预期；
    //  ② 判据从「整幅均匀」扩到「半成品形态」（近黑格子占比），并带深色逃逸。
    // 以下所有状态的共同点：只影响「什么时候接受背景纹理」，绝不让玻璃多画/少画内容。

    /// 沉降窗口开启时刻（墙钟秒，CACurrentMediaTime）。0 = 尚未开启过。
    /// 为什么必须用墙钟：窗口要对齐的是「render server 合成完 backdrop 需要多久」——
    /// 一件与渲染帧率无关的事。帧数上限（maxUniformHoldFrames）在冷启动掉帧时
    /// 4 帧可能横跨几百 ms，与合成耗时没有对应关系。
    private var captureSettleStartedAt: TimeInterval = 0

    /// 最近一次捕获的稀疏网格里近黑格子占比是否过高（半成品形态候选）。
    /// 由 analyzeCapture 每次采样时重写；commitCapturedTexture 只在沉降窗口内采信。
    private var lastCaptureHadPartialBlack = false

    /// 沉降窗口时长（墙钟秒）——**唯一**的时间口径：形态判据有效期与沿用硬上限共用它。
    ///
    /// 2026-10-02（用户第 19 轮第 1 条）把两条时限合并成一条：原实现把「形态判据有效期」
    /// 定成 0.35s、「沿用硬上限」定成 0.6s，于是 0.35~0.6s 之间到达的**带状**半成品帧
    /// （非均匀，均匀判据看不见它，形态判据却已过期）会被无条件提交，黑边照闪。
    /// 现在两条判据同生共死：窗口一关，形态判据与均匀沿用同时放行，不存在「一条还有效、
    /// 另一条已失效」的缝。
    ///
    /// 标定：窗口自**第一帧真实采景**起算（见 reanchorCaptureSettleWindowIfNeeded），
    /// 正常合成 1~2 拍（30~60fps）即完成，0.6s 给冷启动掉帧留了约 10~30 倍余量。
    /// 这是「玻璃永久透明」与「玻璃永久留着上一页内容」两条红线共用的安全阀：
    /// 任何调参都不允许删掉它或让它失效（见 sim-glass-firstmount-contract.js 的 A 段）。
    private static let captureSettleDuration: TimeInterval = 0.6

    /// 窗口开启后是否还没等到「第一帧真实采景」（见 reanchorCaptureSettleWindowIfNeeded）。
    private var captureSettlePendingReanchor = false

    // MARK: - 第五个沉降窗口锚点：采景几何尺寸变化（2026-10-11，第 52 轮）

    /// 上一次采景矩形的尺寸（见 noteCaptureGeometry）。.zero = 还没采过。
    ///
    /// 现象（用户第 52 轮第 1 条）：「主界面下滑到底部（Tab 栏收起）再上滑到顶部，
    /// 碰撞顶部一瞬间，迷你播放器栏右边出现很粗的黑色弧线」。
    /// 成因链：收起/展开是逐帧变形动画（PlayerBar 的 220ms collapseAnim，
    /// bottom + paddingLeft 同帧插值）⇒ 胶囊宽/高逐帧变化 ⇒ 本类 bounds 逐帧变化
    /// ⇒ captureSize 逐帧变化 ⇒ backdropView.frame 逐帧变化 ⇒ CABackdropLayer 每一次
    /// 都要整幅重新向 window server 要 backdrop。展开时采景矩形**变大**，新长出来的
    /// 右/下侧那一带还没合成，drawHierarchy(afterScreenUpdates: false) 读到的是黑带；
    /// 黑带帧**非均匀**（均匀判据看不见它），而稳态下窗口早已过期
    ///（isInsideCaptureSettleWindow 恒 false）⇒ 半成品判据不参与 ⇒
    /// commitCapturedTexture 走无条件提交 ⇒ shader 的 clamp_to_edge 边缘折射把黑带
    /// 弯进胶囊右端圆头 = 用户看到的那道「很粗的黑色弧线」。
    ///
    /// 修法：把「采景几何尺寸变了」也当成一次「合成源刚重新建立」，与其余四个锚点
    /// 同口径开沉降窗口——窗口只「允许沿用可疑帧」，干净帧照常提交，0.6s 到点
    /// 无条件放行 ⇒ 不存在永久透明 / 永久旧帧的路径，最坏是收展动画期间玻璃多显示
    /// 一两帧旧背景（动画本身只有 220ms，且透镜的静止尺寸锁定已把同类问题封在
    /// captureReferenceSize 那条注释里）。
    private var lastCaptureGeometry = CGSize.zero

    /// 几何变化的判定容差（点）。逐帧动画每帧位移远大于它（220ms 内宽变化约 290pt），
    /// 取 0.5 只为滤掉浮点噪声与亚像素抖动，避免稳态下被误触发、反复重开窗口。
    private static let captureGeometryEpsilon: CGFloat = 0.5

    /// 【第 162 轮】采景基准尺寸连续多久没变才允许采景。底栏收起/展开由 React 逐帧改
    /// 宽度（布局驱动，presentation 与 model 一致），祖先动画门看不出来；这段时间采进去
    /// 的画面会整体偏约 1/3，下一帧又对齐 —— 用户看到的「等了一下，画面左移一瞬再回来」。
    private static let geometryStableHold: TimeInterval = 0.12
    private var lastObservedBaseSize = CGSize.zero
    private var lastObservedBaseSizeAt: TimeInterval = 0

    /// 采景矩形**刚变大**、且这一帧还没被提交（2026-10-11，第 56 轮第 1 条）。
    ///
    /// 第 52 轮的第五锚点只做到「尺寸变化 ⇒ 开沉降窗口」，而窗口**只允许沿用**——
    /// 真正沿用与否取决于 lastCaptureHadPartialBlack 这个稀疏网格启发式，可 shader 的
    /// 边缘折射（clamp_to_edge）采的恰是纹理**最外一圈**：黑带整条落在网格采样点之间就漏判
    /// ⇒ 无条件提交 ⇒ 粗黑弧照旧。用户第 56 轮第 1 条复报「上次还是没有解决」，就是这条缝。
    ///
    /// 所以这里改成结构性的判据：尺寸**变大**这一帧，采景直接沿用上一帧纹理，不采信任何
    /// 启发式。理由：矩形刚变大时，新长出来那一带在 CABackdropLayer 里还没合成，这一帧的
    /// 采景必然带黑带；它的正确内容要等下一次合成（≈1~2 拍）才拿得到。
    /// · 只在「变大」方向生效：变小（收起）没有新长出来的区域，玻璃照旧实时，不冻结。
    /// · previous == nil 时不沿用（照常走既有判据）——绝不制造「永久透明」。
    /// · 标记在 commitCapturedTexture 里消费（无论沿用与否都清掉），否则「沿用 → 标记还在
    ///   → 下一帧继续沿用」会自锁到窗口上限。
    private var captureGeometryGrewPending = false

    /// 上一次**被接受**（写进 backgroundTexture）的采景时刻（墙钟秒，2026-10-11，第 56 轮第 2 条）。
    /// 见 maxStaleHoldAge。
    private var lastCommitAcceptedAt: TimeInterval = 0

    /// 沿用的画面最多可以「多旧」（墙钟秒）。超过它就不再沿用，宁可把这一帧半成品画出去。
    ///
    /// 为什么需要它（第 56 轮第 2 条「返回动画结束时闪一下」）：
    /// 沿用（shouldHold ⇒ 把上一帧纹理挂回背景）等价于「把上一次接受的画面继续挂在
    /// 玻璃上」——静止场景下这是对的（背景没变，沿用 = 画面不动），但在**返回动画**这种背景
    /// 正在大幅变化的场景里：恢复渲染那一刻的 previous 是**暂停前**那一帧（push 之前的页面
    /// 内容），沿用它就是让玻璃在整段返回动画里显示旧页面，等沉降窗口放行时画面猛地跳回
    /// 当前内容 —— 正是用户第 16/52/56 轮反复报的「返回动画结束时闪一下、透过的画面才刷新」。
    /// 150ms ≈ 静止档 4~5 拍：足够桥过「合成还没跟上」的短暂滞后（沿用机制的本意），又短到
    /// 旧画面来不及在动画里留下可见的中段跳变。同时它也是 captureGeometryGrewPending 那条
    /// 新沿用路径的安全阀（那条路径本身不带时间上限）。
    /// 冷启动（backgroundTexture == nil：沿用结果是保持透明，而不是显示旧内容）不受此门约束，
    /// 第 16/19 轮那套行为逐字保留。
    private static let maxStaleHoldAge: TimeInterval = 0.15

    /// 【第 62 轮第 1 条】暂停恢复后的**静默窗**：handleResumeFromPause 之后的头 120ms 里，
    /// 无论这一帧采景看着干不干净，都不换画面（继续挂着手上的纹理）。
    ///
    /// 用户现场：「底部 tab 栏和迷你播放器栏透过的画面固定了，但是在点击左上角返回按钮、
    /// 右滑返回主界面的最后一瞬间，会出现短暂的闪一下（应该是在刷新画面）」。玻璃在第 61 轮
    /// 之后整段转场都被按住，恢复时刻就是转场收尾——那一瞬间的采景落在「合成源刚建立」
    /// 的窗口里：分类出来的可疑帧（均匀 / 带近黑条带）本应被沿用门挡住，但恢复时
    /// lastCommitAcceptedAt 还是 push 之前的时刻（早已超过 maxStaleHoldAge），陈旧度门当场
    /// 把沿用翻掉、把可疑帧画了出去 —— 那一下就是用户看到的「闪一下」，紧跟着真实内容到达
    /// 又换一次（用户措辞「然后移动位置后，又会出现一次」）。
    /// 静默窗与陈旧度门配合：窗内不换（最坏也只是把手上那张**内容本来就对**的画面多挂一会儿），
    /// 窗（120ms）短于陈旧度门的 150ms，所以它不会把旧画面留过 maxStaleHoldAge。
    /// 只对「手上已有纹理」（backgroundTexture != nil）生效——冷启动那种 previous == nil
    /// 的「沿用等于保持透明」不受影响（第 16/19 轮行为逐字保留）。
    private var resumeQuietUntil: TimeInterval = 0

    /// 静默窗长度（墙钟秒）。120ms ≈ 7 拍（60fps）：足够跨过恢复瞬间那次合成的滞后，
    /// 又短到用户感知不到「画面停在上一帧」。
    private static let resumeQuietDuration: TimeInterval = 0.12

    /// 【第 122 轮】「恢复 / 定格后的第一帧干净采景必须立刻接替旧纹理」标记。
    ///
    /// 现象（用户第 73/74 轮原话，第 122 轮复报）：「静态情况下可以实时显示，上下左右
    /// 滑动界面再切入切回，透过的画面会显示在移动前的画面……动画结束时产生更新的闪烁」。
    /// 成因：handleResumeFromPause 打开了 120ms 恢复静默窗（resumeQuietUntil），又把
    /// lastCommitAcceptedAt 锚到恢复时刻（陈旧度门 150ms）——于是**恢复那一下同步采到的
    /// 当前画面被「沿用」掉**，转场剩下 300ms 挂的都是转场前那张旧纹理；动画结束进下一次
    /// resume 时同一套窗口再挡一遍，干净帧到点才放行 = 收尾闪一下。
    ///
    /// 修法：恢复 / 冻结时置位本标记；commitCapturedTexture 里只要这一帧**看着干净**
    ///（非均匀、且未被半成品判据命中），就无视静默窗 / 沉降窗口 / 陈旧度门的沿用，
    /// 直接提交。可疑帧仍照旧沿用（黑边保护不变），标记留给下一帧继续尝试 —— 它有界：
    /// 沿用本身仍受 maxStaleHoldAge 墙钟约束，不会把旧画面永久钉住。
    private var acceptNextCleanCapture = false

    /// 定格后仍没采到干净帧时的补采次数（第 122 轮）。复位 / 定格那一拍若恰好撞上
    /// CABackdropLayer 尚未重新合成，干净帧要再等一两拍才到；而冻结之后显示链已停，
    /// 不补采就整段转场挂着旧纹理。只在这条路径上、只补有限次数，且采到干净帧即停。
    private var freezeCaptureRetryRemaining = 0

    /// 挂一次补采（【第 141 轮】20ms ≈ 1~2 拍；快速返回要求冻结帧尽快收敛，40ms 在
    /// 短转场里只剩两次机会）。paused 状态下手动 capture + draw 是 MTKView 官方支持的
    /// 手动渲染路径，调用方无需先恢复渲染。
    private func scheduleFreezeCaptureRetry() {
        guard acceptNextCleanCapture, freezeCaptureRetryRemaining > 0 else { return }
        freezeCaptureRetryRemaining -= 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { [weak self] in
            guard let self, self.acceptNextCleanCapture else { return }
            // 只复位本实例节流：20ms 已跨过全局闸门的节拍粒度，不必再动全局闸门
            //（那会多出一处复位点，与「定格四步里的唯一复位」口径冲突）。
            self.lastCaptureAt = 0
            self.captureBackground()
            self.draw(self.bounds)
            self.scheduleFreezeCaptureRetry()
        }
    }

    /// 采景尺寸变化 = 第五个沉降窗口锚点（见 lastCaptureGeometry）。
    /// 只比尺寸**不比原点**：原点平移（透镜拖动、列表滚动时玻璃不动）不需要重新合成，
    /// 那正是 captureReferenceSize 注释里已被接受的现状；而尺寸变化必然是
    /// 「CABackdropLayer 整幅重合成」，才是黑带的来源。
    private func noteCaptureGeometry(_ captureSize: CGSize) {
        let grew = captureSize.width > lastCaptureGeometry.width + Self.captureGeometryEpsilon ||
            captureSize.height > lastCaptureGeometry.height + Self.captureGeometryEpsilon
        let changed = grew ||
            abs(captureSize.width - lastCaptureGeometry.width) > Self.captureGeometryEpsilon ||
            abs(captureSize.height - lastCaptureGeometry.height) > Self.captureGeometryEpsilon
        lastCaptureGeometry = captureSize
        // 变大 ⇒ 标一帧「沿用」（见 captureGeometryGrewPending）
        if grew { captureGeometryGrewPending = true }
        if changed { beginCaptureSettleWindow() }
    }

    /// 半成品判据（二要素之一）：网格单元格的最大通道值 ≤ 该值视为「近黑」。
    /// 取 8/255：render server 未合成的区域是纯黑（个位数），真实内容即使很暗也
    /// 极少整片 ≤8（8/255 以下在屏幕上已几乎不可辨内容）。
    private static let partialBlackValueThreshold: UInt8 = 8

    /// 半成品判据（二要素之二）：近黑格子占比 ≥ 该比例 → 判为「部分合成未完成」。
    /// 标定依据（2026-10-01 阈值核算；2026-10-11 第 56 轮按固定网格重算，
    /// 用户实测形态 = 「边缘一圈黑、中间正常」）：
    /// 采样网格固定 17 列 × 17 行、首尾贴边（sampleCapture；宽/高不足 17 像素时按
    /// 实际尺寸，网格越小边环占比越高）。最外 1 格厚的边环 = NM-(N-2)(M-2) = 2N+2M-4 格：
    /// 17×17 → 64/289 ≈ 22.2%（最坏口径的下限；16×16 → 60/256 ≈ 23.4%）。
    /// 原 0.35 高过上述全部值——「一圈黑边」整类形态
    /// 都会漏过（黑边照常提交，bug 残留）。取 0.18：低于 22.2%
    /// 且留余量；误触发（真实暗内容恰好 ≥18%）的代价被沉降窗口（≤0.6s）封顶
    /// ——最坏只让玻璃晚接受到窗口到点，不画错内容、不永久透明
    ///（见 commitCapturedTexture 与 captureSettleDuration 注释）。
    private static let partialBlackRatioThreshold: Double = 0.18

    /// 半成品判据（三要素之三，2026-10-02 第 19 轮补）：**外圈**近黑占比 ≥ 该比例。
    /// 为什么单独盯外圈：shader 边缘采样折射的恰是纹理最外一圈（clamp_to_edge），
    /// 采样网格首尾贴边后（见 sampleCapture）统计的正是那一圈；而部分合成常常只吃掉
    /// 一条边——1 格厚的单侧黑带占全网格只有 17/289 ≈ 5.9%
    /// （全网格阈值 0.18 接不住），却占外圈 N/(2N+2M-4)：17×17 → 17/64 ≈ 26.6%
    ///（网格更小则占比更高，这是最坏口径的下限）。取 0.20：低于 26.6% 且留余量，
    /// 又放过外圈偶发的零星暗格（外圈 ≤20% 暗格不判未就绪）。
    private static let partialBlackEdgeRatioThreshold: Double = 0.20

    /// 外圈判据的「近黑」门槛：比全网格口径（8/255）放宽到 24/255——0.2x 降采样
    /// 加钳边过滤会把未合成区域的纯黑抹成深灰，8/255 只认严格纯黑，深灰黑带照漏。
    private static let partialBlackEdgeValueThreshold: UInt8 = 24

    /// 是否处于沉降窗口内（now = 当前墙钟）。上限由「开启时刻 + 常量」现算：
    /// 到点后本函数恒返回 false，不存在绕过路径。
    private func isInsideCaptureSettleWindow(_ now: TimeInterval) -> Bool {
        guard captureSettleStartedAt > 0 else { return false }
        return now - captureSettleStartedAt < Self.captureSettleDuration
    }

    /// 开启（或重置）沉降窗口。五个锚点（见各自调用点）：
    /// ① captureBackdrop：backdropView 插入层级——合成源刚建立，最初的捕获不可信；
    /// ② didMoveToWindow：26.2+ 走根视图捕获，没有 backdropView 插入点，视图进窗口
    ///    是同一件事（层级刚建立、页面与合成都还没就绪）；
    /// ③ beginLiveCapture：透镜抬起/收起圆钮重新入层级，纹理已重置、重新采景；
    /// ④ handleResumeFromPause（2026-10-02，用户第 16 轮第 1 条）：暂停恢复 = 合成源
    ///    刚重新建立。此前本复位路径重置了纹理却没重置窗口（captureSettleStartedAt 还是
    ///    上一次的过期值 → 窗口判据恒 false），恢复后最初的半成品帧被原样接收、黑边被
    ///    折射进胶囊边缘（tab 栏 / 迷你播放器黑边闪烁）。
    /// ⑤ noteCaptureGeometry（2026-10-11，用户第 52 轮第 1 条）：采景矩形的**尺寸**变了
    ///    ——逐帧变形动画（Tab 栏收起/展开）期间 CABackdropLayer 每帧整幅重合成，
    ///    新长出来的那一侧还没合成就是黑带。详见 lastCaptureGeometry 注释。
    private func beginCaptureSettleWindow() {
        captureSettleStartedAt = CACurrentMediaTime()
        captureSettlePendingReanchor = true
    }

    /// 第一帧真实采景到达时把窗口重新起算（每个锚点事件只生效一次）。
    /// 锚点（backdrop 插入 / 进窗口 / 抬起 / 暂停恢复 / 采景几何变化）与「第一帧真的
    /// 采到像素」之间可能隔着冷启动的主线程长任务；窗口若从锚点墙钟起算，半成品首帧
    /// 到达时窗口往往已经过期——那几帧正是「很粗的黑边」的载体（用户第 19 轮第 1 条：
    /// 「第一次进入软件时就会发生」）。改从首帧起算后，窗口覆盖的是真实帧流。
    private func reanchorCaptureSettleWindowIfNeeded(_ now: TimeInterval) {
        guard captureSettlePendingReanchor else { return }
        captureSettlePendingReanchor = false
        captureSettleStartedAt = now
    }

    // MARK: - 渲染帧率 = 采景档（2026-10-03，第 20 轮优化项 ②①）

    /// 静止档 30fps：与 captureMinInterval(33ms ≈ 30Hz) **同速**。
    ///
    /// 口径（本类帧率的唯一模型）：帧率只画得出采景给到的东西 —— 背景纹理在两次
    /// 采景之间是同一张，而 shader 没有任何随时间变化的 uniform（见 ShaderUniforms：
    /// resolution / 形状参数 / touchPoint，全由输入驱动），此时多画的帧逐帧输出相同，
    /// 纯属重复绘制（白烧 GPU + 每帧唤醒 CPU）。因此渲染帧率一律跟随采景档：
    /// 静止 = 30fps、实时会话 = 60fps，见 syncRenderFrameRate。
    /// （此前另有一条「背景一变化就升到 120fps、静默 0.4s 降回」的自适应升档 ——
    /// 采景被 33ms 全局节流压在 30Hz，升上去的帧全是重复绘制，已删除。）
    private static let idleFramesPerSecond = 30
    /// 实时档 60fps：与 liveCaptureMinInterval(16.7ms) **同速**（透镜抬起 / 横滑 /
    /// 滚动会话）。【第 140 轮】用户反馈 120fps 档发热明显变高，实时档退回 60；
    /// 契约里的定值同步回退。
    private static let liveFramesPerSecond = 60
    /// 把渲染帧率同步到当前采景档。**全类唯一给 preferredFramesPerSecond 赋值的地方** ——
    /// 档位由 isLiveCaptureActive 四路会话唯一决定（透镜抬起 / RN live / 重新入窗口实时窗口 /
    /// 用户正在滚动，见其定义），任何会话开始/结束都走这里，
    /// 不会再出现「标志已落、帧率还挂在旧档」的中间态。
    private func syncRenderFrameRate() {
        preferredFramesPerSecond = isLiveCaptureActive ? Self.liveFramesPerSecond : Self.idleFramesPerSecond
    }
    /// 显式高刷（透镜抬起/跟手期间由 LiquidLensView 打开）：期间采景间隔放宽到 60fps，
    /// 渲染档随之提到 liveFramesPerSecond（见 syncRenderFrameRate）
    private var liveCaptureRequested = false

    /// 实时采景会话（2026-10-02 用户第 2/9 条）：由 RN prop `live` 驱动，横滑
    /// PagerView 的手势会话期间由 JS 置 true。
    ///
    /// 为什么必须与 liveCaptureRequested 分开记：两者来源不同、且**会同时为真**
    /// （横滑时透镜抬起 = liveCaptureRequested，底部两块玻璃跟手 = 本标志），
    /// 任何一个为真都该按实时档采景，谁也不许把对方关掉 —— 共用一个布尔量的话，
    /// 透镜落下（endLiveCapture）会把仍在滑动中的底栏玻璃一起打回 30fps 档。
    private var realtimeCaptureRequested = false

    /// 重新入窗口后的实时采景窗口起点（CACurrentMediaTime 秒）；0 = 不在窗口内。
    ///
    /// 【第 61 轮第 3 条】暂停态（MTKView.isPaused）自此**完全由 JS 决定**，本类不再
    /// 自行恢复渲染。第 58～60 轮曾在 didMoveToWindow 里「重新入窗口 = 这一屏正在被露出来
    /// ⇒ 当场自恢复 + 重采」（pauseRequested / resumedFromReentry / resumeFromReentryIfPaused /
    /// suspendWhileDetached / clearReentryResume 一整条通道，已整体删除）。真机实锤那条通道
    /// 判断反了：返回转场期间玻璃背后其实还是**正在向右滑走的那一页**（页面向右走、玻璃不动），
    /// 重采进胶囊就是用户第 60/61 轮反复报的「透过的画面是由右向左滑入的，这个方向是反的」。
    /// 现在整段转场由 JS 的转场按住门按住（navigation/transitionWindow.ts + useGlassNavHold）
    /// = 保持转场前那一帧；转场结束、JS 下发 paused=false 时才由 handleResumeFromPause 接管
    /// （保留旧纹理 → 重采 → 立即画一帧）。
    private var reentryLiveStartedAt: TimeInterval = 0
    /// 实时窗口时长：覆盖一次标准 pop 转场（约 0.35s）加收尾余量。
    private static let reentryLiveDuration: TimeInterval = 0.9

    /// 重新入窗口的实时窗口是否还在（见 reentryLiveStartedAt / scheduleReentryLiveExpiry）。
    private var isReentryLiveActive: Bool {
        reentryLiveStartedAt > 0 && CACurrentMediaTime() - reentryLiveStartedAt < Self.reentryLiveDuration
    }

    /// 【第 73 轮】用户正在上下滚动（滚动实时档的窗口，期限在 GlassInstanceRegistry 上）。
    /// 读的是全局窗口：在屏的每块玻璃都跟着同一次滚动一起进 / 出实时档。
    private var isScrollLiveActive: Bool { GlassInstanceRegistry.shared.isScrollActive }

    /// 当前是否处于「实时采景」档：采景间隔用 liveCaptureMinInterval(60fps)，
    /// 渲染帧率同档提到 liveFramesPerSecond(60fps)（见 syncRenderFrameRate）。
    private var isLiveCaptureActive: Bool { liveCaptureRequested || realtimeCaptureRequested || isReentryLiveActive || isScrollLiveActive }

    /// 【第 73 轮】滚动实时档的档位重算入口 —— 由 GlassInstanceRegistry 在「进入滚动」与
    /// 「窗口到期」两个方向各调一次（它拿不到本类的私有成员，故留这一个 fileprivate 转发）。
    ///
    /// 现象（用户第 73 轮第 4 条）：「上下滑动过程优化，目前感觉画面有点抖动，不平滑流畅」。
    /// 成因与第 9 条的横滑一字不差（见 setRealtimeCapture 的长注释）：背景每一帧都在动，
    /// 而采景被限在静止态基线 30fps（shouldThrottleCapture），前景（列表）以 60~120fps 在动
    /// —— 玻璃里透过的画面系统性落后 1~3 拍，与玻璃周围擦身而过的内容对不上、且自身以 30Hz
    /// 跳动，观感就是「抖」。第 20 轮「降到 30fps 与采景同速、画面无可见差异」的前提
    /// **只对静止背景成立**（那一档本来就是为静止画面定的）。
    ///
    /// 与横滑（realtimeCaptureRequested）分开记的理由同 liveCaptureRequested（见其注释）：
    /// 来源不同、且会同时为真（滚动窗口有 0.3s 尾巴，横滑手势必然与之重叠），共用一个标志
    /// 会让先结束的一方把另一方关掉。
    /// 档位仍然只由 syncRenderFrameRate 按 isLiveCaptureActive 现算 —— 这里不做方向判断。
    fileprivate func syncScrollLiveFrameRate() {
        syncRenderFrameRate()
    }

    /// Whether to automatically capture superview on each frame.
    /// Set to false for manual control via `captureBackground()`.
    var autoCapture: Bool = true

    /// 捕获背景时要隐藏的「玻璃组件根」。nil → 所在 LiquidGlassEffectView（覆盖其
    /// contentView 里的前景）→ 自身。RN 宿主通过 setCaptureExclusionView: 把它指向
    /// **JS 父容器**（宿主的 superview）：宿主是叶子（只装玻璃背衬），前景内容
    /// （tab 图标/播放条按钮）是父容器的其它子节点——只排除宿主会漏掉前景，
    /// 被打进背景纹理后经 0.2x 降采样折射成重影/黑影（真机 iOS 26.2+ 截图实锤）。
    weak var captureExclusionView: UIView?

    /// layer.render 沙盒（LXGlassTryRenderLayer）是否可用：iOS 26 上对整窗私有图层
    /// 渲染有 NSException 崩溃前科，累计 2 次异常后停用，降级 drawHierarchy
    /// （闪烁但不崩）。正常设备永不停用。
    private var useLayerRender = true
    private var layerRenderFailures = 0

    /// 跨实例共享的捕获闸门（公平轮转）：捕获已在主线程执行（见 captureRootView），
    /// 必须限制主线程占用；玻璃实例（迷你播放条/Tab 栏/透镜）各自独立渲染线程，
    /// 用锁保护检查-放行。
    private static let globalCaptureLock = NSLock()
    /// 最近一次**被放行**的全局采景时刻（墙钟秒）；0 = 闸门刚复位（下一帧必放行）。
    private static var globalLastCaptureAt: TimeInterval = 0
    /// 全局闸门的等待队列（FIFO：实例身份 + 入队时刻）。见 requestGlobalCaptureSlot。
    private static var globalCaptureQueue: [(id: ObjectIdentifier, at: TimeInterval)] = []
    /// 闸门抖动余量（秒）【第 59 轮第 1 条】：显示链路的 60Hz 节拍是 16.667ms，与
    /// liveCaptureMinInterval(16.7ms) 只差 0.3ms —— 逐帧比较时那一拍会被判成「还没到」
    /// 而整帧丢弃，实时档实际掉到 30Hz（「滑动中透过的画面延迟很高」的隐身来源之一）。
    /// 留 2ms 余量让「恰好 16.67ms 的一拍」稳定通过；静止档 33.3ms 从 31.3ms 起放行，
    /// 频率不变（渲染档本身就是 30fps 的 33.3ms 一拍）。
    private static let captureGateJitterGuard: TimeInterval = 0.002
    /// 【第 127 轮】全局采景名额的授予间隔缩放（相对实时/静止档的单实例间隔）。
    ///
    /// 一块玻璃的采景间隔是 16.7ms（实时）/ 33.3ms（静止），但名额闸门此前要求
    /// **合计**也只有这么多：两块常驻玻璃（Tab 栏 + 迷你播放器）在实时档各只分到
    /// 约 30fps，画面逐帧更新却看起来一顿一顿。取 0.5 后实时档每 8.35ms 放一个名额，
    /// 两块玻璃各 60fps；静止档每 16.65ms 放一个名额（两块各 30fps，与引擎档一致）。
    /// 主线程占用 = 每块玻璃一帧最多一次整树渲染，次数与各自的渲染帧率同阶，仍然有界。
    private static let globalCaptureSlotScale: TimeInterval = 0.5

    /// 采景节流（**每实例**，2026-10-02，用户第 5 条）：两次采景之间的最小墙钟间隔。
    /// 完整说明见 shouldThrottleCapture。取 30fps（= idleFramesPerSecond 的静止态基线）。
    private static let captureMinInterval: TimeInterval = 0.0333
    /// 显式高刷会话（liveCaptureRequested：透镜抬起/跟手、收起圆钮重新入层级）的采景
    /// 间隔：60fps（16.7ms），比静止态基线宽一倍，但仍封顶——见 shouldThrottleCapture 的说明。
    private static let liveCaptureMinInterval: TimeInterval = 0.0167
    /// 本实例最近一次**被接受的**采景时刻（墙钟秒）。只由 shouldThrottleCapture 读写，
    /// 都在渲染帧内（与 captureBackdrop 同一线程），不需要锁。
    private var lastCaptureAt: TimeInterval = 0

    /// 【第 67 轮·省电】静止帧不重复绘制（去重呈现）。
    ///
    /// 本类 shader **没有任何时间分量**（`ShaderUniforms` 只有 resolution / contentsScale /
    /// touchPoint / 形状与折射参数 / 矩形列表，见文件头部的结构体定义与
    /// LiquidGlassShaderSource.swift 的 MSL 侧同名结构体），也就是说
    /// **一帧的输出完全由「背景纹理 + uniformsBuffer」两样输入决定**：
    /// 输入逐字节相同 ⇒ 输出逐像素相同（kit 自己的注释也写了这一点，见 init 里
    /// 「输入不变则每帧输出逐帧相同」）。
    ///
    /// 而稳态下（列表静止、没有转场、没有手势）采景每 33.3ms 会被 `shouldThrottleCapture`
    /// 或全局闸门挡下一部分，`commitCapturedTexture` 也常常把「沿用上一张」判出来 ——
    /// 这些帧里 draw() 仍会跑完整条路径：全屏三角带的片元着色（SDF + 折射采样）
    /// → present(drawable) → commit()，一秒钟三十次，**输出和上一帧一模一样**。
    /// 这就是「不播放音乐时也在发热」里属于玻璃的那一份：GPU 与主线程都为同一张图白转。
    ///
    /// 两个计数分别记「背景纹理被赋值」与「uniformsBuffer 被重写」的次数：
    ///   · 纹理只在 `beginLiveCapture`(丢纹理) / `commitCapturedTexture`(提交或沿用) 里赋值，
    ///     赋值即自增 —— 注意**沿用上一张（把 previous 交给背景纹理）也算**，
    ///     （这条注释刻意不写出那两行赋值的原文：契约脚本里有以它们为锚点的反例，
    ///     注释里复现同样的字面量会让不带缩进的锚点先命中文档注释、替换变成空操作）
    ///     因为「刚才真的采了一帧并且决定了要沿用」这件事本身不必省（保守：宁可多画一帧）；
    ///   · uniforms 只在 `updateUniforms()` 末尾自增，而它是**唯一**写 uniformsBuffer 的地方，
    ///     只在 layoutSubviews 里被调用（几何 / 圆角 / 色调 / 融合矩形 / touchPoint 全在里面读）。
    /// 于是「两次快照相等」= 本帧输出与上一次 present 的那帧逐像素相同 ⇒ 不画、不 present。
    ///
    /// 只有「什么都没变」才跳过，所以观感零差异；`hasPresentedFrame` 保证首帧必画；
    /// 纹理被丢掉 / 重新入窗 / 从暂停恢复这三条路径会把 `hasPresentedFrame` 复位，
    /// 让恢复后的第一帧仍然强制 present（CAMetalLayer 的内容在这些时刻可能已被系统回收，
    /// 那种情况下「和上一帧相同」这个前提不再成立）。
    private var textureRevision: UInt64 = 0
    private var uniformsRevision: UInt64 = 0
    private var hasPresentedFrame = false

    var touchPoint: CGPoint? = nil

    var frames: [CGRect] = []

    // Backdrop capture view (stays in superview, contains only CABackdropLayer)
    private let backdropView = BackdropView()

    init(_ liquidGlass: LiquidGlass) {
        self.liquidGlass = liquidGlass

        super.init(frame: .zero, device: LiquidGlassRenderer.shared.device)

        GlassInstanceRegistry.shared.add(self)

        // shadowOverlay（黑色边缘阴影环）已移除：其黑色环影在转场/拖动中被感知为
        // "黑弧"，且 multiplyBlend 合成在动画期间会失效变黑块。玻璃边缘定义由
        // shader 自身的 fresnel/glare 提供，不再叠加阴影环。
        setupMetal()
        // 30fps = 静止档（与采景节流同速，见 idleFramesPerSecond 注释）：MTKView 默认按
        // 屏幕刷新率（本工程 Info.plist 解锁了 CADisableMinimumFrameDurationOnPhone，
        // ProMotion 下即 120Hz）连续 draw，玻璃内容是静止的——输入不变则每帧输出逐帧相同，
        // 高刷下纯属白烧 GPU/CPU。透镜抬起 / 横滑会话由 syncRenderFrameRate 提到 60fps。
        // 注意：这里只降本视图的渲染帧率，不改 Info.plist 的全局高刷开关。
        syncRenderFrameRate()
    }

    required init(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    deinit {
        GlassInstanceRegistry.shared.instances.remove(self)
    }

    /// 视图进入窗口 = 一次新的「刚插入层级」（2026-10-01）：开启墙钟沉降窗口（见
    /// captureSettleDuration 与 commitCapturedTexture）。
    /// 26.2+ 走根视图捕获、没有 backdropView 的插入点，这是该路径唯一的锚点；
    /// 14~26.1 与 backdropView 插入点重复锚定也无害——两个锚点都在同一瞬间附近，
    /// 晚开的锚点只是把窗口开启时刻整体后移（上限始终从开启时刻现算，不会因此失效）。
    override func didMoveToWindow() {
        super.didMoveToWindow()
        // 移出窗口（本屏被压栈页覆盖）不做任何事：暂停与否由 JS 省电门（paused）唯一决定，
        // 第 61 轮起本类没有任何「自行暂停 / 自行恢复」的记账（见 reentryLiveStartedAt 注释）。
        guard window != nil else { return }
        // 【第 67 轮】重新入层级：CAMetalLayer 上的内容可能随上一次移出窗口一并没掉，
        // 「与上一帧相同 ⇒ 跳过」这个前提在这里不成立 —— 强制下一帧 present 一次
        hasPresentedFrame = false
        beginCaptureSettleWindow()
        // 【第 58 轮第 2 条】实时采景窗口：整屏重新入窗口 = 一段转场开始（返回 / 首次挂载），
        // 这一段背景整幅在移动，静止档（30fps）采景会系统性落后 1~3 拍 —— 用户看到的就是
        // 「透过的画面不是底部实时的画面、有错位、动画延迟也很高」。窗口固定时长、
        // 到期自动落回静止档（见 scheduleReentryLiveExpiry），不依赖 JS 事件（右滑那条
        // 路径没有 JS 事件）。
        reentryLiveStartedAt = CACurrentMediaTime()
        // 【第 59 轮第 1 条】转场第一拍就要采到当前画面：全局闸门若正卡在上一段会话的
        // 格子里，本实例的首帧要等到下一格（最多 16.7ms + 本帧），转场开头露出的那一下
        // 就已经是旧画面了。复位闸门 = 首帧放行（见 resetGlobalCaptureGate）。
        Self.resetGlobalCaptureGate()
        scheduleReentryLiveExpiry()
        syncRenderFrameRate()
    }

    /// 实时窗口到期后把渲染 / 采景档落回静止档。一次性定时器（每次入窗口一个），
    /// 不做每帧检查：draw 跑在渲染线程上，preferredFramesPerSecond 只从主线程改。
    private func scheduleReentryLiveExpiry() {
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.reentryLiveDuration) { [weak self] in
            self?.syncRenderFrameRate()
        }
    }

    func setupMetal() {
        guard let device else { return }

        commandQueue = device.makeCommandQueue()!

        // Uniforms buffer (update per frame)
        uniformsBuffer = device.makeBuffer(length: MemoryLayout<LiquidGlass.ShaderUniforms>.stride, options: [])!

        zeroCopyBridge = .init(device: device)

        // Make view transparent so we can see the effect
        isOpaque = false
        layer.isOpaque = false
        // 清屏色全透明：空帧（纹理未就绪等）不改变画面，避免闪黑
        clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)

        isPaused = false
    }

    // MARK: - Background Capture

    /// 【第 139 轮】返回冻结帧用「本屏根视图 + model 几何」采一次最终 Home 画面。
    /// 转场在途位移只存在于 render 树，`captureRootView` 按 model 渲染，抓到的就是
    /// 返回后的静止内容（不会再出现「右→左滑入」或滑动后的错位）。窗口有界，
    /// 只在冻结刷新那一拍生效；稳态仍按系统版本选路。
    private var forceRootViewCaptureUntil: TimeInterval = 0

    func captureBackground() {
        // 本帧的形态判据只属于本帧（2026-10-01）：analyzeCapture 会重写此标记；
        // 捕获提前返回（节流 / 缺窗口 / backdrop 不可用）时也保持 false，
        // 避免把上一帧的「半成品」印象带进下一次提交。
        lastCaptureHadPartialBlack = false
        // 【第 162 轮】记录「采景基准尺寸」的变化时刻（每一拍都观察，即使下面会提前返回）。
        let geometryNow = CACurrentMediaTime()
        let baseSize = captureBaseSize
        if lastObservedBaseSize == .zero {
            lastObservedBaseSize = baseSize
            lastObservedBaseSizeAt = geometryNow
        } else if abs(baseSize.width - lastObservedBaseSize.width) > 0.5 ||
                  abs(baseSize.height - lastObservedBaseSize.height) > 0.5 {
            lastObservedBaseSize = baseSize
            lastObservedBaseSizeAt = geometryNow
        }
        // 转场结束后的窗口内：底栏还在逐帧改尺寸就不采（布局驱动的动画，祖先动画门看不见）。
        // 用户已经开始滚列表就不拦：那种一帧偏移在滚动里看不出来，而冻住会明显卡顿。
        if geometryNow < navigationAnimGateUntil,
           geometryNow - lastObservedBaseSizeAt < Self.geometryStableHold,
           !isScrollLiveActive,
           !allowCaptureDuringTransition { return }
        // 同一窗口内：窗口里还有滚动视图在动画（分页回位 / 列表惯性）也不采 ——
        // 那是「等了一下之后横向偏一段」的另一条来源。
        if geometryNow < navigationAnimGateUntil,
           isAnyScrollViewAnimating(),
           !isScrollLiveActive,
           !allowCaptureDuringTransition { return }
        // 【第 160 轮】JS 转场窗口期间一律不采：只有 JS 知道整段窗口，且不依赖动画是否
        // 可见（快照 / 自定义转场同样挡住）。抓在转场中间的那一帧就是「透过画面整体
        // 平移一段再回来」。用户已经在滚列表就不拦（转场早已结束）。
        if GlassInstanceRegistry.shared.isNavigationTransitionActive,
           !isScrollLiveActive,
           !allowCaptureDuringTransition { return }
        // 【第 152 轮】冻结帧保持期 / 采景源还在做转场：这一帧不采。转场中的窗口合成是
        // 「左边已经换成新页、右边还是上一页」，采进去就是用户看到的左边那一下闪；
        // 保持手上那张静止画面，等转场落地后的完整合成再采。
        // 用户在滚列表（返回后立刻上手）就立即解除保持，别让玻璃在滚动中定格。
        if navigationFrozen, !allowCaptureDuringTransition { return }
        if CACurrentMediaTime() < awaitingScreenSettleUntil, !isScrollLiveActive, !allowCaptureDuringTransition { return }
        // 返回收起后的这一段：玻璃自己 / 底栏容器 / 所属那屏只要还有位移动画就不采
        // —— 模型几何与屏幕位置不一致时采到的内容会横向跳一下。只在转场结束前后的
        // 窗口内生效，普通滚动时底栏收展不在这里拦（否则滚动会卡顿）。
        if CACurrentMediaTime() < navigationAnimGateUntil,
           isGlassOrAncestorAnimating(),
           !allowCaptureDuringTransition { return }
        if skipNextCaptureOnce {
            skipNextCaptureOnce = false
            return
        }
        let forceRootOnce = forceRootCaptureOnce
        forceRootCaptureOnce = false
        if forceRootOnce || CACurrentMediaTime() < forceRootViewCaptureUntil {
            captureRootView()
        } else if #available(iOS 26.2, *) {
            captureRootView()
        } else {
            captureBackdrop()
        }
    }

    /// 采景矩形与背景像素缓冲共用的基准尺寸（点）。两者必须同源，否则缓冲边缘会留下
    /// 没画到的黑带、被折射进胶囊（见 captureBackdrop 的尺寸注释）。
    private var captureBaseSize: CGSize {
        if let reference = captureReferenceSize, reference.width > 1, reference.height > 1 {
            return reference
        }
        return bounds.size
    }

    /// 透镜抬起/跟手期间由 LiquidLensView 调用：
    /// ① 丢掉上一次抬起留下的背景纹理——那是上一次会话（上一次点击的 tab 位置的页面）
    ///    内容，重新抬起后的最初几帧会把它画出来，就是用户说的「点歌单再点搜索，
    ///    椭圆背景里短暂留着歌单的背景」；
    /// ② 把采景间隔放宽到 60fps（渲染档随之提档，见 syncRenderFrameRate）：抬起期间
    ///    背景每帧都在变，30fps 的采景滞后（最多 ~33ms 外加合成队列）在跟手拖动和切页
    ///    动画里肉眼可见。
    func beginLiveCapture() {
        liveCaptureRequested = true
        consecutiveUniformFrames = 0
        backgroundTexture = nil
        // 【第 67 轮】新会话：纹理被丢掉（draw 会因 backgroundTexture == nil 整帧不画），
        // 恢复后第一帧必须真的画出去，所以连同「已 present」标记一起复位
        textureRevision &+= 1
        hasPresentedFrame = false
        // 新会话第一帧必须立刻采到（全局闸门也要复位，别卡在上一段的格子里）
        lastCaptureAt = 0
        Self.resetGlobalCaptureGate()
        // 2026-10-01：抬起 = 新的采景会话（纹理已丢，重新开始）。重开沉降窗口：
        // 透镜/收起圆钮的上一帧（previous）此时恒为 nil，窗口内沿用 = 继续透明，
        // 等的是本次会话的第一帧可信背景，不会把上一次抬起/上一页的内容带进来
        //（旧内容已在上一行被丢弃）。
        beginCaptureSettleWindow()
        syncRenderFrameRate()
    }

    /// 透镜落下后调用：采景档落回静止档，渲染档随之同步降回（见 syncRenderFrameRate）。
    /// 第 20 轮起渲染帧率只跟采景档，不再按内容变化自适应升降（那条路径整段删掉，
    /// 理由见 idleFramesPerSecond 注释）。
    func endLiveCapture() {
        liveCaptureRequested = false
        syncRenderFrameRate()
    }

    /// RN prop `live` 的落点（Bridge → LGLiquidGlassHostView.applyRealtimeCapture:
    /// → LiquidGlassEffectView.setRealtimeCapture:）：横向滑动 PagerView 的手势会话
    /// 期间置 true，会话结束（态 'idle' 或静默看门狗超时）置 false。
    ///
    /// 要解决的现象（用户第 9 条）：「底部的液态玻璃透过的画面，在推荐/歌单/搜索/我的/
    /// 设置界面左右滑动时……透过的画面延迟很高，掉帧严重」。背景每一帧都在变，而采景
    /// 此前被限在静止态基线 30fps（shouldThrottleCapture），前景以 60~120fps 在动 ——
    /// 透过画面系统性落后 1~3 拍，快速滑动时的欠采样还会让运动看起来「反向切入」。
    /// 进实时档后与透镜抬起同档（60fps 采景，渲染档随之同步到 60fps，见
    /// syncRenderFrameRate）：这是工程里既有的、已被接受的「实时」口径
    ///（抬起的透镜用同一档，观感无异议）。
    /// 不整段旁路节流：三块玻璃各自每帧调 drawHierarchy 是上一轮「整条底部区域掉帧」
    /// 的成因，60fps 是这条路径上手调过的上限。
    func setRealtimeCapture(_ realtime: Bool) {
        guard realtimeCaptureRequested != realtime else { return }
        realtimeCaptureRequested = realtime
        // 会话开始/结束都立刻放行下一次采景：开始的那一刻若正卡在 30fps 的节流窗口里，
        // 第一帧真实内容要再等最多 33ms 才采到 —— 那正是「滑动刚开始时玻璃里还是旧位置
        // 的画面、然后猛地跳一下」的相位滞后来源（用户第 9 条「延迟很高」的起点）。
        lastCaptureAt = 0
        Self.resetGlobalCaptureGate()
        consecutiveUniformFrames = 0
        // 渲染档只跟采景档走（第 20 轮：两个档位各自与对应采景间隔同速，
        // 见 syncRenderFrameRate）——开始会话提到 live 档、结束落回静止档，
        // 两条路都收敛到这一个赋值点。
        syncRenderFrameRate()
    }

    /// 从暂停（MTKView.isPaused = true，省电门）恢复时的一次性复位（2026-10-02 用户第 2 条）。
    ///
    /// 现象：「切走再返回主界面，底部 tab 栏/迷你播放器显示出来的一瞬间，液态玻璃透过的
    /// 画面存在闪烁」。成因是**暂停期间纹理没有任何失效点**：暂停只是停止 draw，MTKView
    /// 的 CAMetalLayer 保留着暂停前最后呈现的那一帧 —— 那帧里折射的是「上一次可见时刻」
    /// 的背景（例如 push 之前的 Home）。恢复后第一次采景若被 commitCapturedTexture 判为
    /// 未就绪（返回/转场途中常见的整幅均匀、或半成品帧），它会把 previous（= 暂停前那一帧）
    /// 原样画出去，于是用户先看到一截旧画面，过几帧才跳回当前画面。
    ///
    /// 复位三件事：
    ///  ① **保留**旧纹理（2026-10-11，第 56 轮第 2 条把这里从「丢掉」改成「保留」，理由见
    ///     函数内「改动 ① 反转」）：恢复后每一帧都有一张背景可画，draw() 不会因为
    ///     backgroundTexture == nil 而整帧不 present（那种情况下 CAMetalLayer 上留着的
    ///     是**暂停前那一帧的位图**——几何已变、内容也旧，用户看到的就是那一下闪烁）；
    ///  ② 清掉「未就绪沿用」的全部痕迹（均匀帧计数、半成品标记、变化检测基准）；
    ///  ③ 立刻同步采一次（复位节流 + captureBackground），让恢复后的**第一帧** draw
    ///     就用上当前背景，而不是等下一个 tick（30fps 档下最多 33ms 的旧画面）；
    ///  ④ 重开墙钟沉降窗口（beginCaptureSettleWindow，2026-10-02 用户第 16 轮第 1 条）——
    ///     暂停恢复同样属于「合成源刚建立」，恢复后最初的半成品帧（非均匀但带近黑条带）
    ///     必须按未就绪沿用，否则黑边会被折射进胶囊边缘。沿用到的 previous 现在是
    ///     **暂停前刚放下的那张画面**（改动 ① 反转后它一定存在），由陈旧度门
    ///     （maxStaleHoldAge，见 commitCapturedTexture）兜底：恢复后超过 150ms 就不再挂它。
    ///
    /// 剩余代价：CAMetalLayer 上那一帧旧图像必然要显示到下一次 draw 为止（≤1 拍），
    /// 这是暂停式省电门的固有代价；本次复位把「多次沿用旧帧 / 等到下一 tick」压到
    /// 「最多一拍」。渲染档与采景档重新同步（第 20 轮：两者同速，见 syncRenderFrameRate）
    /// ——静止档下一拍 ≤33ms，与既有静止态上限一致。
    /// 改动 ① 反转（2026-10-11，第 56 轮第 2 条「返回动画结束时闪一下」）：
    /// 旧写法丢掉纹理的用意是「别把上一页内容留在玻璃里」，代价却在恢复的那一刻才显形——
    /// 恢复后最初几帧只要被判未就绪，沿用分支拿到的 previous 就是 nil ⇒ draw() 的
    /// `guard backgroundTexture != nil` 直接返回、**这一帧不 present** ⇒ CAMetalLayer 上
    /// 仍是暂停前那一帧的位图（内容与几何都是旧的），直到第一帧「干净」采景到达才整体换掉。
    /// 那一下换掉正落在返回动画收尾处，就是用户反复报的闪烁。第 61 轮起整段转场
    /// （含右滑返回，那条路径没有 JS 转场事件，靠 handleScreenPopped 续期）都由 JS 按住：
    /// 从 push 起玻璃就一直处于暂停态，直到转场按住门结束才恢复——恢复时刻就是
    /// 「转场结束」，所有差别都被压到那一刻一起呈现（本函数就是为这一下准备的）。
    /// 保留纹理后：恢复期每一帧都有可画的背景（内容就是用户刚刚看到的那一张，视觉连续），
    /// 第一帧干净采景到达时自然接替；旧画面最多多留 maxStaleHoldAge（150ms），超过就被
    /// 陈旧度门放行——不会把上一页内容永久留在玻璃里。
    /// 【第 134 轮】恢复落点不在同一拍强制提交（`afterScreenUpdates:true` 会在恢复那一拍
    /// 提交整屏，用户看到的就是「每次返回闪一下」与收展卡顿）。第 143 轮起强制提交只给
    /// 切回 live 的**第一帧 CABackdrop**（下一拍，见 forceFreshFirstBackdropCapture）；
    /// 第 147 轮返回冻结帧改为 CABackdrop 静态预采，恢复后由正常采景接替。
    func handleResumeFromPause() {
        consecutiveUniformFrames = 0
        // 【第 127 轮】恢复（返回 / 回前台）也按实时档跑一段：返回转场与露出动画里
        // 玻璃要和背景同帧跟手，静止档 30fps 会明显一顿一顿。0.9s 后自动落回静止档。
        let resumeNow = CACurrentMediaTime()
        // 【第 153 轮】返回期沿用冻结帧：切入那一刻定格的画面就是返回后的背景（App 侧
        // 已在转场开始前刹车）。转场没结束就恢复（边缘返回 / 慢速手势）时禁采 ——
        // 此时合成是「左边已到位、右边还是上一页」，采到就是那一下闪。
        let settledRecently = resumeNow - screenSettledAt < Self.screenSettleRecentDuration
        let wasFrozen = freezeFrameLocked
        let waitForScreenSettle = wasFrozen && isCaptureSourceMoving() && !settledRecently
        freezeFrameLocked = false
        if wasFrozen {
            // 冻结帧恢复一律同源：不走模型根视图、不强制提交 —— 换源那一下的几何差
            // 就是用户看到的「缩放 / 闪」。
            forceRootCaptureOnNextResume = false
            forceFreshFirstBackdropCapture = false
            skipNextCaptureOnce = false
            frozenFrameUsesBackdrop = false
        }
        if waitForScreenSettle {
            awaitingScreenSettleUntil = resumeNow + Self.screenSettleTimeout
        }
        reentryLiveStartedAt = resumeNow
        scheduleReentryLiveExpiry()
        lastCaptureHadPartialBlack = false
        lastCaptureAt = 0
        Self.resetGlobalCaptureGate()
        syncRenderFrameRate()
        // 2026-10-02（用户第 16 轮第 1 条：「底部 tab 栏和迷你播放器栏边缘又出现瞬间闪烁的
        // 黑边，分别在进入软件时、从其他页面切回到有底部栏界面时」）：暂停恢复也是一次
        // 「合成源刚建立」——暂停期间 render server 对这条 backdrop 链路的合成就停摆了，
        // 恢复后最初几帧与冷启动/backdrop 插入同态：整幅均匀 or 半成品（非均匀但带近黑条带，
        // 纯均匀判据看不见它），被 commitCapturedTexture 原样接收 → shader 把近黑条带折射到
        // 胶囊边缘 = 用户看到的黑边闪一下。
        // 上面三处锚点（backdrop 插入 / didMoveToWindow / beginLiveCapture）都会开沉降窗口，
        // 唯独本复位路径漏了（它重置了纹理却不重置窗口，captureSettleStartedAt 还是上一次
        // 早已过期的值 → isInsideCaptureSettleWindow 恒 false → 半成品判据与墙钟沿用全失效）。
        // 这里补上与其余锚点同口径的开窗：窗口内未就绪帧沿用 previous（改动 ① 反转后
        // previous 恒为暂停前那张画面，沿用 = 画面先不动，而不是「透明」），最多挂
        // maxStaleHoldAge（150ms）就被陈旧度门放行——既不会把半成品折射进玻璃边缘，
        // 也不会把上一页内容整段留在玻璃里。
        // 顺序：先开窗再 captureBackground，采到的这一帧本身也在窗口覆盖内。
        //
        // 【第 62 轮第 1 条】恢复静默窗 + 重新锚定「上一张被接受的画面」的时刻：
        // 上面那条沉降窗口（captureSettleDuration = 0.6s）在恢复路径上**一直是失效的**——
        // commitCapturedTexture 的陈旧度门拿 lastCommitAcceptedAt 判断「手上这张画面有多旧」，
        // 而恢复时这个时刻还是 push 之前写下的（玻璃整段转场都被按住，中间没有任何一次
        // 「接受」），于是 now - lastCommitAcceptedAt 必然 > maxStaleHoldAge(0.15)，
        // 沿用门刚打开就被陈旧度门当场翻掉：恢复第一帧的**可疑采景被直接画出去**，
        // 一两拍后真实内容到达再换一次 —— 用户第 62 轮第 1 条看到的「最后一瞬间闪一下
        // （像在刷新画面）」，以及紧随其后的第二次。
        // 语义上这里没有说谎：此刻手上挂着的纹理内容就是**当下**这一页（第 61 轮口径下
        // 它整段转场都对），它就是「刚被接受的画面」。所以把锚点挪到恢复时刻，
        // 让沿用门在这之后仍然只有 150ms 的有效期（上限不变），再叠一个 120ms 的静默窗
        // 兜住启发式漏判的干净可疑帧。
        lastCommitAcceptedAt = resumeNow
        resumeQuietUntil = resumeNow + Self.resumeQuietDuration
        // 【第 67 轮】暂停期间 CAMetalLayer 的内容可能已被系统回收（App 挂后台再回来、
        // 图层被移出层级又移回）：此时「本帧输入没变 ⇒ 输出与上一帧相同」不成立，
        // 强制复位「已 present」，让恢复后的第一帧一定画出去（本函数末尾的 draw(bounds)
        // 就是为此存在的那一脚）
        // 【第 122 轮】恢复的第一帧：干净就必须立刻接替旧纹理（否则整段返回都在展示
        // 转场前那张「移动前」的画面，收尾才刷新 —— 用户复报的错位 + 结束闪烁）。
        // 放在 hasPresentedFrame 复位之前：定格四步的文档锚点要求那行与
        // beginCaptureSettleWindow / captureBackground 紧邻。
        // 【第 142 轮】覆盖冻结档的每一次恢复（返回 / push 的新屏露出 / 从无玻璃页回来）
        // 都先用本屏模型根视图采一帧当前画面：前景已由排除根隐藏，内容与 model 终态一致，
        // 不依赖 window server 上一次提交（CABackdrop 在刚恢复时可能还是切走前那张 →
        // 「不滑动就一直是旧画面」）。采完立即进 live，恢复后完成的加载/布局继续跟上。
        // 可见性档（收展）不置本标记：那条恢复路径不额外做整树采景。
        // 【第 147 轮】冻结帧来自 CABackdrop 静态预采（同源）时例外：不换模型帧、不强制
        // 提交，保持手上这张当前帧，由静默窗后的 live 接替 —— 换源 / 强制提交都会在返回
        // 收尾或用户开始滑动时造成短暂不一致。
        let usedBackdropFrozen = frozenFrameUsesBackdrop
        frozenFrameUsesBackdrop = false
        let forceRootOnResume = forceRootCaptureOnNextResume && !waitForScreenSettle
        forceRootCaptureOnNextResume = false
        if forceRootOnResume, !usedBackdropFrozen {
            // 只让恢复落点这一帧走模型根视图；随后第一帧 live 用强制提交的 CABackdrop
            // 接替（见 forceFreshFirstBackdropCapture），不再开 120ms 的整树采景窗口。
            forceRootCaptureOnce = true
        }
        if usedBackdropFrozen { skipNextCaptureOnce = true }
        // 【第 148 轮】预采冻结帧与 live 同源：恢复后先让它挂完 120ms 静默窗，别让转场
        // 收尾那一两拍（合成可能还没完全落地）的 live 采景立刻接替 —— 那一下就是用户
        // 看到的「返回主界面时闪一下、透过画面和背景短暂不一致」。
        acceptNextCleanCapture = !usedBackdropFrozen
        hasPresentedFrame = false
        beginCaptureSettleWindow()
        captureBackground()
        // 复位之后还差最后一脚（2026-10-02，用户第 11 轮第 10 条：
        // 「还是存在返回主界面，底部玻璃显示瞬间闪烁……瞬间闪烁一下切换到实际透过的画面」）：
        // captureBackground 只换了**背景纹理**，屏幕上显示的仍是 CAMetalLayer 里暂停前
        // 呈现的那一帧——真正改写它的只有 draw()+present，而 draw 本来只发生在 display link
        // 的下一个 tick。返回转场一开始玻璃就被逐步露出，这一拍（乃至 settlement 期间被判定
        // 未就绪时的若干拍沿用）的旧画面就是用户看到的「先闪一下旧画面、再跳到当前画面」。
        // 这里复位后**立刻同步画一帧**：直接调用本类自己的 draw(_:)，不依赖 MTKView.draw()
        // 的路由语义（有 delegate 与无 delegate 的路径不同，本类没有 delegate）。
        // MTKView 在 isPaused == YES 时手动 draw 是官方支持的手动渲染路径（setPaused 也要到
        // 复位之后才把 isPaused 置回 false），所以这一帧一定画得出去；drawable / 渲染描述符
        // 未就绪时 draw(_:) 内部按既有分支安全返回（保持原样等下一 tick，不会崩、不会画错）。
        if forceRootOnResume || usedBackdropFrozen {
            // 这一脚只呈现手上那张帧；关掉 autoCapture，避免同一拍又走一次 CABackdrop。
            let autoCaptureEnabled = autoCapture
            autoCapture = false
            draw(bounds)
            autoCapture = autoCaptureEnabled
            // 模型根视图帧与 live 不同源：下一拍 live 强制提交当前合成后接替。
            // CABackdrop 预采帧与 live 同源：不强制，交给静默窗后的正常采景接替。
            if !usedBackdropFrozen { forceFreshFirstBackdropCapture = true }
        } else {
            draw(bounds)
        }
    }

    /// 返回转场开始的冻结帧刷新：用与 live **同源**的 CABackdrop 按静态画面采一帧并同步
    /// 画出去，**不改变 isPaused**。【第 147 轮】不再用模型根视图、也不做转场补采 ——
    /// 冻结帧与 live 同源同几何，整段转场展示这张静态画面；恢复落点保持它，由 live 在
    /// 静默窗后接替。
    func refreshFrozenFrame(firstTick: Bool) {
        if firstTick {
            // 清掉可能残留的根视图状态，保证这一帧走 CABackdrop（与 live 同源）。
            forceRootViewCaptureUntil = 0
            forceRootCaptureOnce = false
            freezeCaptureRetryRemaining = 0
            forceFreshFirstBackdropCapture = true
            acceptNextCleanCapture = true
            lastCaptureAt = 0
            captureBackground()
            frozenFrameUsesBackdrop = true
            hasPresentedFrame = (false)
            let autoCaptureEnabled = autoCapture
            autoCapture = false
            draw(bounds)
            autoCapture = autoCaptureEnabled
            return
        }
        acceptNextCleanCapture = true
        lastCaptureAt = 0
        captureBackground()
        draw(bounds)
    }

    /// 【第 66 轮第 1 条】冻结前的一次性「定格」采景 —— 与 handleResumeFromPause 对称，
    /// 但只做它的一半（理由见下方「为什么不照恢复路径把沉降窗口也开上」）。
    ///
    /// 现象（用户原话）：「迷你播放器栏和底部 tab 栏透过的画面，例如正在向下滑动当前列表，
    /// 然后突然点击进入播放详情页，迷你播放器栏和底部 tab 栏透过的画面是停留在进入播放详情页
    /// 前的画面，而返回时，向下滑动的列表还会向下移动一点距离，这样……就会和进入详情页前的
    /// 画面不一致，造成短暂的显示错误并闪一下。」
    ///
    /// 成因两段，本函数管第二段：
    ///   ① **列表还在滑**：App 侧在冻结前把正在惯性滑行的列表按预测落点贴住
    ///      （AppDelegate.mm 的 LXGlassSettleDeceleratingScrollView，由 LXGlassNotifyWillFreeze
    ///      触发，见 LiquidGlassEffectView.setPaused）—— 列表的落点与「返回后」一致了。
    ///   ② **冻结帧还是旧的**：采景走 30fps 节拍（captureMinInterval 33.3ms），这一拍根本
    ///      来不及把「贴完落点之后」的画面采进纹理；暂停发生在同一拍之内，CAMetalLayer 上
    ///      留着的仍是贴着落点**之前**那一帧 —— 于是返回时恢复路径采到的新画面与冻结帧差
    ///      一段距离，用户看到的就是那一下闪。
    ///
    /// 本函数把这一帧补上，三件事：
    ///   · `lastCaptureAt = 0` + `Self.resetGlobalCaptureGate()`：复位本实例节流与全局闸门，
    ///     让**这一帧必须真采**（否则它落在 33ms 节流窗里，captureBackground 直接 return，
    ///     定格就白做了）；
    ///   · `captureBackground()`：采一帧当下画面（此刻列表已经贴完落点）；
    ///   · `draw(bounds)`：立刻同步画一帧 —— 与恢复路径同口径，captureBackground 只换背景
    ///     **纹理**，屏幕上显示的仍是 CAMetalLayer 里上一次 present 的那一帧，真正改写它的
    ///     只有 draw + present（与 handleResumeFromPause 末尾那一脚同理）。
    /// 调用方（LiquidGlassEffectView.setPaused）随后才把 isPaused 落下去 —— 顺序不能反：
    /// 先定格、后采景、再暂停。
    ///
    /// 为什么不照 handleResumeFromPause 把沉降窗口 / 静默窗也开上：
    /// 那条路径开窗的前提是「合成源**刚建立**」（backdrop 刚插入 / 刚从暂停恢复），窗内
    /// 未就绪的采景一律沿用旧纹理 —— 在这里沿用等于把「贴着落点之前」的旧帧挂回来，恰好
    /// 抵消本函数。而冻结发生在正常浏览中途：刚恢复 120ms 内的二次 push 不可能发生
    /// （返回转场本身就有 350ms），采到半成品帧的前提（合成源刚建立 / 采景矩形刚变大）
    /// 都不成立，所以这里只做「复位节流 + 采一帧 + 画一帧」。
    /// 渲染档（syncRenderFrameRate）同样不动：暂停态与采景档无关，多调一次只是白算。
    func handlePauseForFreeze() {
        forceFreshFirstBackdropCapture = false
        frozenFrameUsesBackdrop = false
        // 【第 152 轮】这张定格就是返回期要展示的画面（App 侧已刹车，画面不会再动）。
        freezeFrameLocked = true
        awaitingScreenSettleUntil = 0
        lastCaptureAt = 0
        Self.resetGlobalCaptureGate()
        // 【第 67 轮】定格这一脚要的就是「真正改写 CAMetalLayer」（第 66 轮第 1 条：冻结帧
        // 必须等于贴完落点之后的画面）。正常路径上 captureBackground 会赋值一次纹理、
        // 去重呈现自然放行；但万一本帧采景被全局闸门挡掉，也要在这一脚强制 present 一次
        // （代价最多是多画一帧与上一帧相同的画面，不会少画）
        // 【第 122 轮】定格帧同理：干净就立刻提交（冻结帧必须等于此刻的真实背景，
        // 否则返回时展示的仍是更早那张）。可疑帧照旧沿用。
        // 冻结后显示链已停：第一拍若采到可疑帧，补采有限几次，直到拿到干净帧
        //（最多 3 次 ≈ 120ms，且只在本玻璃真的还挂着旧纹理时才继续）。
        // 这两行必须放在 hasPresentedFrame 之前：定格四步的锚点要求
        // `hasPresentedFrame = false` 与 `captureBackground()` 紧邻。
        acceptNextCleanCapture = true
        freezeCaptureRetryRemaining = 3
        scheduleFreezeCaptureRetry()
        hasPresentedFrame = false
        captureBackground()
        draw(bounds)
    }

    /// Captures the background content via root View using layer render.
    ///
    /// iOS 26.2+ 无 CABackdropLayer 可用（系统重构 backdrop 私有机制），退化为公开 API
    /// 整树截图。捕获必须排除两类污染，否则真机（iOS 26.2+/27）出现黑影涂抹：
    /// ① 玻璃组件的**前景内容**（tab 图标/播放条按钮，挂在玻璃上方）被打进背景纹理，
    ///    再被 shader 以 0.2x 降采样折射放大 → 图标形状的软黑影；
    /// ② 玻璃自身/其它玻璃的**上一帧输出**被再捕获再折射，反馈迭代成大团模糊黑块。
    /// 两者都由「捕获时临时隐藏全部玻璃组件根（含前景）」解决。
    ///
    /// 渲染方式（对齐上游 DnV1eX/LiquidGlassKit captureRootView）：
    /// presentation layer 的 layer.render(in:) —— 同步读取 layer 树画进 context，
    /// **不经 render server 提交**：隐藏态不会呈现给显示器。历史方案
    /// drawHierarchy(afterScreenUpdates: true) 的强制提交会把隐藏态刷到屏幕上——
    /// 观看者周期性看到玻璃组件整条消失（露出背后列表），录屏逐帧可见 = 玻璃「跳动」。
    /// iOS 26 上 layer.render 对整窗私有图层有 NSException 崩溃前科（Swift 无法捕获
    /// ObjC 异常）→ ObjC @try 沙盒（LXGlassTryRenderLayer）：异常时本次降级
    /// drawHierarchy（闪烁但不崩），累计 2 次异常本实例停用 layer.render 路径。
    func captureRootView() {
        // 【第 73 轮第 5 条】采景源不再是「整个 App 的根视图」，而是「包含本玻璃的那一屏」
        //（findCaptureSourceView，现象与理由见该方法的注释）。下面几何 / 排除 / 闸门 / 渲染
        // 一行不动：它们本来就都以 rootView 为基准，把基准换成同一屏的更近祖先正是这条修复
        // 的全部——采样矩形与所渲染的那棵树仍然同源（第 60 轮第 1 条）。
        guard let rootView = findCaptureSourceView() else { return }

        let sizeCoefficient = liquidGlass.backgroundTextureSizeCoefficient
        let scaleCoefficient = layer.contentsScale * liquidGlass.backgroundTextureScaleCoefficient

        // Determine our on-screen rect in the root view coordinate space.
        // 【第 60 轮第 1 条】几何一律取 **model（静止态）**，与下面渲染的那棵树**同源**。
        // 判据：`render(in:)` 画的是 layer 树的 model 值 —— UIKit 的转场动画挂在 render
        // 树上，对 render 不可见。所以**采样窗口也必须按 model 算**，否则窗口在画面里挪，
        // 而贴图是贴在这一层上、被合成器按同一条在途变换一起搬走的：
        //   层向右走 o(T)、窗口也向右挪 o(T) ⇒ 透过玻璃看到的画面相对玻璃**向左**流 o(T)。
        // 用户第 60 轮原话「当我右滑时，底部 tab 栏和迷你播放器栏透过的画面是从右向左
        // 滑入的，反了」正是这个反向；同源之后贴图与它背后的真实内容严丝合缝（层被搬到
        // 哪里，贴图就跟着到哪里），「拉伸 / 错位 / 撕裂」随之消失。
        // 历史：这里原取 presentation()（上游「让捕获跟踪动画中的视图」的写法）—— 拿在途
        // 矩形去截 model 的画面，截到的是「模型位置上那一块」，而玻璃自己已经按在途位置
        // 被画到别处，两者相差的正是这一帧的位移。
        let frameInRoot = layer.convert(layer.bounds, to: rootView.layer)

        // Expand capture area around the MTKView center (in root view coordinates).
        // 【尺寸】与背景像素缓冲同源（captureBaseSize，见 layoutSubviews 的 setupBuffer）：
        // 尺寸与中心现在都是 model 值（同一次布局的结果），不会出现「中心在途、尺寸静止」
        // 那种一帧内自相矛盾的组合（逐帧变形动画期间正是它把缓冲右/下侧留出一条没画到的
        // 黑带、被 shader 折进胶囊边缘）。再外扩 1 缓冲像素盖住 Int 取整缝隙，保证缓冲
        // 无未绘制纹理，clamp_to_edge 边缘采样不会读到黑边。
        let baseSize = captureBaseSize
        let devicePixel = 1.0 / scaleCoefficient
        let captureSize = CGSize(width: baseSize.width * sizeCoefficient + devicePixel * 2,
                                 height: baseSize.height * sizeCoefficient + devicePixel * 2)
        let captureRectInRoot = CGRect(x: frameInRoot.midX - captureSize.width / 2,
                                       y: frameInRoot.midY - captureSize.height / 2,
                                       width: captureSize.width,
                                       height: captureSize.height)

        // 【全局闸门 + 主线程捕获】26.2+/27 的 renderInContext 不可靠读取渲染线程
        // 上的未提交模型变更（排除失效 → 前景/玻璃本体漏进捕获：图标黑帽、按钮黑块、
        // 玻璃惨白，26.2+/27 真机实锤）；而提交隐藏态（commit/flush）又会闪屏。唯一跨
        // 版本确定的做法：捕获整体搬到主线程执行——hide → render → restore → commit，
        // restore 先于 commit，render server 永远看不到隐藏态（不闪）；主线程的
        // renderInContext 读模型必然含排除（不漏）。全局节流（跨实例共享）限制主线程
        // 占用【第 59 轮第 1 条：闸门改为按实时档定节拍 + FIFO 轮转，见 requestGlobalCaptureSlot】；
        // 首帧（无纹理）必放行（不排队也不看间隔，见该方法）。
        if !requestGlobalCaptureSlot(CACurrentMediaTime()) { return }

        // 第五个沉降窗口锚点（2026-10-11，第 52 轮第 1 条）：本帧的采景几何与上一帧
        // 不同（逐帧变形动画 / 尺寸变化）⇒ 合成源要整幅重做，本帧与随后几帧可能带着
        // 未合成的黑带，必须让半成品判据重新生效（见 noteCaptureGeometry）。
        // 放在节流之后：被跳过的帧不产生任何采景相关状态，与「被跳过的帧不采景」同口径。
        noteCaptureGeometry(captureSize)

        let previousTexture = backgroundTexture
        let captureStartedAt = CACurrentMediaTime()
        var capturedIsUniform = false
        var capturedTexture: MTLTexture?
        let captureWork = { [weak self] in
            guard let self, let win = self.window else { return }
            capturedTexture = self.zeroCopyBridge.render { context in
                // Hide every glass widget root in this window (self included)：覆盖各玻璃的
                // MTK 输出与其上方前景内容，截到纯净背景。主线程上 hide → render →
                // restore → commit：restore 先于 commit，render server 永远看不到隐藏态
                //（不闪屏）；renderInContext 读模型必然含排除（不漏，全版本确定）。
                let hiddenRoots = GlassInstanceRegistry.shared.exclusionRoots(in: win).filter { !$0.layer.isHidden }
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                for root in hiddenRoots { root.layer.isHidden = true }

                // Transform to render the portion of root view under our capture rect:
                context.scaleBy(x: scaleCoefficient, y: scaleCoefficient)
                context.translateBy(x: -captureRectInRoot.origin.x, y: -captureRectInRoot.origin.y)

                // 【第 60 轮第 1 条】渲染整棵 layer 树的 model 值，与上面的采样矩形同源。
                // render(in:) 本来就不认 render 树上的动画，取 presentation() 只是把**根层**
                // 的在途几何单独搬进来、与子层（model）自相矛盾 —— 这是「错位」的另一半。
                let rendered = self.useLayerRender && LXGlassTryRenderLayer(rootView.layer, context)
                if rendered {
                    self.layerRenderFailures = 0
                } else {
                    if self.useLayerRender {
                        self.layerRenderFailures += 1
                        if self.layerRenderFailures >= 2 { self.useLayerRender = false }
                    }
                    // 降级路径：drawHierarchy 走标准 UIView 渲染路径（对私有 layer 兼容性
                    // 更好），但 afterScreenUpdates: true 会把 pending 变更（含隐藏态）呈现
                    // 给显示器——主线程路径下这是暂态降级（layer.render 连续两次异常才
                    // 启用），偶发闪烁可接受性优先于永久泄漏。
                    UIGraphicsPushContext(context)
                    rootView.drawHierarchy(in: rootView.bounds, afterScreenUpdates: true)
                    UIGraphicsPopContext()
                }

                if let buffer = self.zeroCopyBridge.pixelBuffer {
                    capturedIsUniform = self.analyzeCapture(buffer, now: captureStartedAt)
                }

                for root in hiddenRoots { root.layer.isHidden = false }
                CATransaction.commit()
            }
        }
        if Thread.isMainThread {
            captureWork()
        } else {
            DispatchQueue.main.sync(execute: captureWork)
        }
        commitCapturedTexture(capturedTexture, previous: previousTexture, isUniform: capturedIsUniform)

        blurTexture()
    }
    /// 本帧是否因采景节流而跳过（每实例，2026-10-02，用户第 5 条）。
    ///
    /// 起因：「滑入推荐、歌单界面时，底部的 tab 和迷你播放器区域液态效果明显掉帧，
    /// 而且滑动松手会自动切入的动画也很不流畅」。页面在滑动 = 背景每一帧都在变：
    /// 一屏三块玻璃（Tab 栏 / 迷你播放器 / 抬起的透镜）若各自高刷调 drawHierarchy，
    /// 合计每秒数百次。而这条采景路径是**主线程同步**的（drawHierarchy 要等 render
    /// server 交出 backdrop 内容，上游注释即写 "Noticeable rendering delay"），
    /// 直接与 pager 动画抢主线程，表现为整条底部区域和吸附动画一起掉帧。
    ///
    /// 口径：把「采景」这一步压回静止态的基线——30fps/实例（三块合计 90 次/秒本就是
    /// 工程既有的、可接受的稳态），显式高刷会话放宽到 60fps。第 20 轮起**渲染帧率与
    /// 采景档同速**（syncRenderFrameRate）：玻璃自身的形变、跟手位置、透镜的
    /// 挤压/拉伸在实时档（60fps）仍按 60fps 走，静止档渲染成 30fps —— 那一档采景
    /// 本来就是 30Hz，渲染再快也只是重画同一张纹理。代价是折射内容的更新率下降，
    /// 而该内容本身就是 0.2x 降采样的模糊结果（透镜 0.8x，故给它更高的 60fps），
    /// 30fps 与 120fps 的观感差异远小于它让出的主线程时间。
    ///
    /// 首帧（backgroundTexture == nil）不节流：挂载后 / 抬起会话开始的第一帧必须立刻
    /// 拿到纹理，否则 draw() 的「无纹理则跳过本帧」会让玻璃一直透明（见 beginLiveCapture）。
    /// 全局闸门：本帧是否拿到跨实例的采景名额（true = 允许采，false = 本帧让行）。
    ///
    /// 旧口径（2026-10-01 ~ 第 58 轮）是「距上一次**全局**采景不足固定 0.033s 就丢弃」，
    /// 两个毛病在返回/滑动转场里同时发作（第 59 轮第 1 条：拉伸 / 错位 / 撕裂 / 延迟高）：
    ///  ① 固定 0.033s、**不看实时档**：转场里三块玻璃都进了实时档（一个 60fps 采景名额），
    ///     却全被这道闸门压回合计 30 次/秒 —— 与实时档的承诺（见 isLiveCaptureActive）
    ///     直接矛盾，谁申请都没用；
    ///  ② 先到先得 = 可独占：每 16.7ms 提交一帧的实例每次都满足 33ms，块块都抢到名额，
    ///     另外两块玻璃却总被判「刚采过」——三块均分（约 10 次/秒/块）退化成一个饱死、
    ///     两个饿死。转场里整幅背景在移动，饿死那一块拿的还是几十毫秒前的位置所对应的
    ///     矩形内容，被 shader 当背景折射出来就是「拉伸 / 错位 / 撕裂」。
    ///
    /// 现在两道都改：**节拍按实时档选**（实时 16.7ms / 静止 33.3ms），**名额按 FIFO 轮转**
    /// （这一格没轮到的实例入队等下一格）。全员公平 → 每块玻璃在最需要的时候拿到
    /// 总名额里属于它的那一份（实时档三块各约 20 次/秒，且**没有饿死的**），
    /// 而全局主线程占用仍有界（每格至多一次整树渲染，这是本闸门存在的全部理由）。
    /// 首帧（挂载 / 抬起会话 / 刚丢纹理）不排队也不看间隔：那一刻玻璃还没有任何可画的
    /// 背景，放行它是 draw() 不整帧跳过的前提；但它照样**记账**（占用本格名额），
    /// 免得同一拍里两块玻璃一起上主线程。
    private func requestGlobalCaptureSlot(_ now: TimeInterval) -> Bool {
        let me = ObjectIdentifier(self)
        let firstFrame = backgroundTexture == nil
        let interval = isLiveCaptureActive ? Self.liveCaptureMinInterval : Self.captureMinInterval
        Self.globalCaptureLock.lock()
        defer { Self.globalCaptureLock.unlock() }
        // 【第 127 轮】名额节拍 = 单实例档位 × globalCaptureSlotScale（见常量注释）。
        // 队首过期仍按单实例间隔清理：等待者最多等一整拍，与旧口径一致。
        let slotInterval = interval * Self.globalCaptureSlotScale
        // 排队超过一整格还没回来的实例（被暂停 / 实时档已结束 / 已被移除）不再占位：
        // 队首永远等不到人的话，后面的实例会被一个死名字无辜拖住。
        Self.globalCaptureQueue.removeAll { now - $0.at >= interval }
        if firstFrame {
            Self.globalCaptureQueue.removeAll { $0.id == me }
            Self.globalLastCaptureAt = now
            return true
        }
        if now - Self.globalLastCaptureAt < slotInterval - Self.captureGateJitterGuard {
            if !Self.globalCaptureQueue.contains(where: { $0.id == me }) {
                Self.globalCaptureQueue.append((me, now))
            }
            return false
        }
        // 本格已到：只有队首（或根本不在队列里的实例）能拿 —— 排队顺序 = 谁先来等。
        if let head = Self.globalCaptureQueue.first, head.id != me { return false }
        if !Self.globalCaptureQueue.isEmpty { Self.globalCaptureQueue.removeFirst() }
        Self.globalLastCaptureAt = now
        return true
    }

    /// 进入实时档 / 重新入窗口 / 暂停恢复时复位全局闸门：让本实例的**第一帧**立刻能采
    ///（返回转场的第一拍采到的就是当前画面），并把等待队列一并清空 —— 上一段会话留下的
    /// 排队次序对新会话没有意义（那些实例这一格本来就该重新竞争）。
    /// 复位是幂等的：多个实例几乎同时入窗口时，最坏只是多放行一帧（可接受）。
    private static func resetGlobalCaptureGate() {
        globalCaptureLock.lock()
        globalLastCaptureAt = 0
        globalCaptureQueue.removeAll()
        globalCaptureLock.unlock()
    }

    private func shouldThrottleCapture(_ now: TimeInterval) -> Bool {
        guard backgroundTexture != nil else { return false }
        // 实时档 = 透镜抬起（liveCaptureRequested）**或** RN `live` prop（横滑会话，
        // realtimeCaptureRequested）：两者都放宽到 liveCaptureMinInterval(60fps)。
        let interval = isLiveCaptureActive ? Self.liveCaptureMinInterval : Self.captureMinInterval
        if now - lastCaptureAt < interval { return true }
        lastCaptureAt = now
        return false
    }

    /// 【第 143 轮】覆盖恢复后**第一条 CABackdrop** 必须强制提交当前窗口合成。
    ///
    /// 现象（用户原话）：「返回收尾时透过的画面会缩放一下，像是静止时和返回时透镜的倍数
    /// 不一样……滑动页面返回收尾还会闪一下」。恢复落点先用模型根视图采景（内容与 model
    /// 终态一致），0.12s 后切回 live；若此刻 `afterScreenUpdates:false` 仍读到切走前那次
    /// 提交（滑动后尤其明显），透过画面会整体跳到旧滚动位置 —— 相对于根视图那帧就像是
    /// 缩放/闪一下。这里只给切回 live 的**第一帧**强制提交：窗口此刻已经静止，提交不会
    /// 露出隐藏态，也不会在恢复同一拍提交整屏（第 134 轮那种闪烁不会再出现）。
    private var forceFreshFirstBackdropCapture = false
    /// 【第 142 轮】下一次恢复是否先用模型根视图采第一帧（见 handleResumeFromPause）。
    private var forceRootCaptureOnNextResume = false
    /// 【第 143 轮】下一次采景**只这一帧**走模型根视图（恢复落点用）。用一次性标记而不是
    /// 时间窗：时间窗会让恢复后头几拍 live 全部做整树渲染（60fps × 两块玻璃 = 十余次
    /// 全屏渲染挤在 120ms 里），那本身就是可感知的顿挫 / 发烫面。
    private var forceRootCaptureOnce = false

    /// 【第 147 轮】返回冻结帧来自 **CABackdrop 静态预采**（与 live 同源同几何）。
    /// 返回刷新那一拍按静态画面采一帧并 present；整段转场展示它；恢复落点保持同一张，
    /// 交给静默窗后的 live 接替 —— 不换源（模型根视图帧与 live 帧的微小几何差就是
    /// 用户看到的「缩放 / 短暂不一致」），也不在恢复后强行提交（那会撞上用户开始滑动）。
    private var frozenFrameUsesBackdrop = false
    /// 预采冻结帧的恢复落点跳过显式采景（保持手上这张同源帧）。
    private var skipNextCaptureOnce = false

    /// 【第 152 轮】冻结帧锁存：覆盖冻结时定格的那张画面就是返回期展示的画面。
    private var freezeFrameLocked = false
    /// 【第 153 轮】所在屏幕最后一次「转场结束」（viewDidAppear）的时刻。
    private var screenSettledAt: TimeInterval = 0
    /// 禁采期限：转场中 / 刚结束那一两拍不采景。
    private var awaitingScreenSettleUntil: TimeInterval = 0
    private static let screenSettleTimeout: TimeInterval = 1.0
    private static let screenSettleRecentDuration: TimeInterval = 0.4
    /// 【第 154/158 轮】转场结束后继续禁采一段时间：viewDidAppear 之后底栏的收起/展开
    /// 动画（220ms）与分页回位可能才开始，这一段的模型几何与屏幕位置不一致，采进去就是
    /// 「透过画面向左跳一下再跳回来」。0.3s 盖住它们；用户开始滚动时立即解除。
    private static let postSettleCaptureHold: TimeInterval = 0.3

    /// 【第 154 轮】转场期间只禁采、不暂停渲染：玻璃继续把手上那张纹理画出去（静止），
    /// 但不采新帧。暂停/恢复本身也会让画面在转场里变一次，静止切入时的封面闪就是这么来的。
    private var navigationFrozen = false
    /// 【第 157 轮】返回开始那一拍按 model 重锁冻结帧时，放行一次采景。
    private var allowCaptureDuringTransition = false
    /// 【第 158 轮】转场结束前后：这段窗口里祖先还在做位移动画就不采景。
    private var navigationAnimGateUntil: TimeInterval = 0

    /// 返回开始：按模型树重采一张当前背景当作冻结帧（见注册表的 refreshFrozenFrames）。
    func refreshFrozenFrameFromModel() {
        guard window != nil else { return }
        // 屏幕还在搬（边缘返回手势 / screenPopped 落在转场中）就先不重锁：模型渲染本身
        // 没问题，但这条路径的窗口合成回退会把移动中的背景采进来，正是那次横向跳。
        guard !isGlassOrAncestorAnimating() else { return }
        allowCaptureDuringTransition = true
        forceRootCaptureOnce = true
        handlePauseForFreeze()
        allowCaptureDuringTransition = false
        freezeFrameLocked = true
    }

    func beginNavigationFreeze(recapture: Bool) {
        guard !navigationFrozen else { return }
        // 上一屏刚结束的禁采窗口不能挡住这次的定格补采。
        awaitingScreenSettleUntil = 0
        if recapture {
            // 刚刹过车：必须按 **model** 采。窗口合成比滚动位置晚一拍，
            // 读合成就是「列表停了、透过画面还在刹车前的位置（上下偏移）」。
            // 模型树里的滚动位置在刹车那一刻已经是最终值。
            forceRootCaptureOnce = true
            handlePauseForFreeze()
        }
        freezeFrameLocked = true
        navigationFrozen = true
    }

    func endNavigationFreeze() {
        navigationFrozen = false
    }

    /// App 在目标页 viewDidAppear 时调进来：这一屏的转场已经结束（再等两帧落地）。
    func screenDidSettle() {
        let now = CACurrentMediaTime()
        screenSettledAt = now
        awaitingScreenSettleUntil = now + Self.postSettleCaptureHold
        // 收起/展开动画可能比禁采期更晚才收尾：这 2s 内只要还在搬、或尺寸还在变，就不采。
        navigationAnimGateUntil = now + 2.0
    }

    /// 由 LiquidGlassEffectView.setPaused 的恢复分支置位（覆盖冻结档：返回 / push 后露出 /
    /// 从无玻璃页回来）。可见性档（收展）恢复不走这里，避免收展时多一次整树采景。
    func prepareRootCaptureOnResume() {
        forceRootCaptureOnNextResume = true
    }

    /// 可见性档（收展）恢复不用这条：清掉可能残留的标记，避免收展动画中间多一次整树采景。
    func cancelRootCaptureOnResume() {
        forceRootCaptureOnNextResume = false
    }

    /// Captures the background content via CABackdropLayer using drawHierarchy.
    /// Noticeable rendering delay.
    func captureBackdrop() {
        // iOS 26 上 CABackdropLayer 可能不可用（见 BackdropView），不可用则跳过捕获，
        // 玻璃退化为透明（不崩溃，仅失去背后折射内容）。
        guard backdropView.isBackdropAvailable else { return }
        guard let superview else { return }

        // 采景节流（2026-10-02，见 shouldThrottleCapture）：放在几何计算之前——被跳过的帧
        // 不做任何采景相关的事。backdropView 的位置会在下一个被接受的帧里重算后再采，
        // 采样矩形始终是当时的实际位置，不会采错区域；而该视图只比玻璃本体大 1 像素左右，
        // 位置滞后至多 33ms 也不会在屏幕上露出来。
        if shouldThrottleCapture(CACurrentMediaTime()) { return }

        let sizeCoefficient = liquidGlass.backgroundTextureSizeCoefficient
        let scaleCoefficient = layer.contentsScale * liquidGlass.backgroundTextureScaleCoefficient

        // Calculate frame using presentation layer for smooth animation tracking.
        // 尺寸与缓冲同源（captureBaseSize）+ 1 缓冲像素外扩，理由同 captureRootView：
        // 逐帧变形动画期间 presentation 尺寸滞后一拍，会在缓冲边缘留下黑带。
        // 透镜的 captureReferenceSize 锁成静止尺寸，挤压/拉伸期间这里只变中心不变尺寸
        // ——尺寸一变 CABackdropLayer 就得整幅重合成，高速度拖动下就是那些黑线条。
        let baseSize = captureBaseSize
        let currentLayer = layer.presentation() ?? layer
        let frameInSuperview = currentLayer.convert(currentLayer.bounds, to: superview.layer)
        let devicePixel = 1.0 / scaleCoefficient
        let captureSize = CGSize(width: baseSize.width * sizeCoefficient + devicePixel * 2,
                                 height: baseSize.height * sizeCoefficient + devicePixel * 2)
        let captureOrigin = CGPoint(x: frameInSuperview.midX - captureSize.width / 2,
                                    y: frameInSuperview.midY - captureSize.height / 2)

        // 第五个沉降窗口锚点（2026-10-11，第 52 轮第 1 条）：采景矩形尺寸变了 ⇒ 下一行
        // 改 backdropView.frame 会让 CABackdropLayer 整幅重新合成，新长出来的那一侧
        //（展开时是右/下侧）在合成完成前是黑带。先开窗再改 frame，本帧的采样就已经在
        // 窗口覆盖内——展开瞬间那道「很粗的黑色弧线」正是在这里进来的。
        noteCaptureGeometry(captureSize)

        // Position backdrop view and layer
        backdropView.frame = CGRect(origin: captureOrigin, size: captureSize)

        // Ensure backdrop view is in superview (below us)
        if backdropView.superview !== superview {
            superview.insertSubview(backdropView, belowSubview: self)
            // 2026-10-01：backdrop 源刚进层级，render server 尚未合成它——重开墙钟
            // 沉降窗口（见 captureSettleDuration 与 commitCapturedTexture）。
            // 下面注释记录的「冷启动最初若干帧采到整幅均匀黑」就发生在这一刻之后。
            beginCaptureSettleWindow()
        }

        // Capture using drawHierarchy (gets windowserver-composited content)
        // 冷启动黑闪修复（iOS 14~18 真机录屏实锤：应用冷启动时玻璃整条闪黑数帧）：
        // CABackdropLayer 进入层级后的最初若干帧，render server 尚未合成 backdrop
        // 源内容，drawHierarchy 捕获到的是整幅均匀黑 → shader 当背景折射 = 闪黑。
        // 捕获后做稀疏采样判定（见 analyzeCapture/commitCapturedTexture）：
        // 未就绪帧（整幅均匀 / 半成品形态）沿用上一帧纹理——沉降窗口内按墙钟上限
        //（captureSettleDuration，自本次会话首帧真实采景起算），窗口外整幅均匀仍按
        // maxUniformHoldFrames 帧沿用，形态判据不再参与（见 commitCapturedTexture）。
        let previousTexture = backgroundTexture
        let captureStartedAt = CACurrentMediaTime()
        var capturedIsUniform = false
        // 【第 143 轮】第一条 CABackdrop 强制提交一次当前合成（见
        // forceFreshFirstBackdropCapture）：切回 live 的那一帧必须是当前画面，不能读到
        // 滑动前/转场前的那次提交。
        // 【第 150 轮】返回实时化窗口内不再每帧强制提交：整屏提交和转场动画抢合成器，
        // 表现就是转场卡顿抖动 + 透过画面掉帧撕裂。常规路径只滞后一帧已完成合成。
        let forceFreshComposite = forceFreshFirstBackdropCapture
        let capturedTexture = zeroCopyBridge.render { context in
            context.scaleBy(x: scaleCoefficient, y: scaleCoefficient)

            UIGraphicsPushContext(context)
            if forceFreshComposite {
                backdropView.drawHierarchy(in: backdropView.bounds, afterScreenUpdates: true)
            } else {
                backdropView.drawHierarchy(in: backdropView.bounds, afterScreenUpdates: false)
            }
            UIGraphicsPopContext()

            if let buffer = zeroCopyBridge.pixelBuffer {
                capturedIsUniform = self.analyzeCapture(buffer, now: captureStartedAt)
            }
        }
        commitCapturedTexture(capturedTexture, previous: previousTexture, isUniform: capturedIsUniform)
        forceFreshFirstBackdropCapture = false

        blurTexture()
    }

    /// 稀疏采样（约 16x16 网格）取每点最大通道值：均匀判定、帧间变化检测与半成品形态
    /// 判据共用一次扫描。需在 CVPixelBuffer 锁定期内调用（zeroCopyBridge.render 的闭包内）。
    /// 返回每行的采样列数（columns）——外圈口径要靠它把一维网格还原成行列，见 analyzeCapture。
    private static func sampleCapture(_ buffer: CVPixelBuffer) -> (values: [UInt8], columns: Int) {
        let w = CVPixelBufferGetWidth(buffer)
        let h = CVPixelBufferGetHeight(buffer)
        let bpr = CVPixelBufferGetBytesPerRow(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return ([], 0) }
        let ptr = base.assumingMemoryBound(to: UInt8.self)
        // 采样点位置（2026-10-11，第 56 轮第 1 条修的外圈盲区）：固定 17 列 × 17 行，
        // **首尾各落在缓冲边界上**（0 与 w-1 / h-1），中间等距。
        // 旧写法 stepX = w/16、从 0 起步长，右/下缘最后至多 stepX-1 像素永不入样；而 shader
        // 的边缘折射（sampler 的 clamp_to_edge，见 LiquidGlassShaderSource）采的恰是纹理
        // **最外一圈**——黑带整条落在那一段里就是「判据看不见、shader 照样把黑带放大成粗弧」。
        // 首尾贴边后，外圈口径统计的正是 shader 真正采样的那一圈；中间等距保证网格仍是
        // 规整矩形（analyzeCapture 靠它还原行列）。
        let columns = min(17, w)
        let rows = min(17, h)
        guard columns > 0, rows > 0 else { return ([], 0) }
        var xs: [Int] = []
        xs.reserveCapacity(columns)
        for i in 0 ..< columns {
            xs.append(columns <= 1 ? 0 : (i * (w - 1)) / (columns - 1))
        }
        var grid: [UInt8] = []
        grid.reserveCapacity(17 * 17)
        for j in 0 ..< rows {
            let y = rows <= 1 ? 0 : (j * (h - 1)) / (rows - 1)
            let row = y * bpr
            for x in xs {
                let o = row + x * 4 // BGRA
                let r = Int(ptr[o + 2])
                let g = Int(ptr[o + 1])
                let b = Int(ptr[o])
                grid.append(UInt8(max(r, max(g, b))))
            }
        }
        return (grid, columns)
    }

    /// 捕获统计（在 render 闭包内、缓冲锁定期调用）：
    /// ① 均匀帧判定——CABackdropLayer 未就绪时的捕获是整幅均匀黑，真实背景（含内容）
    ///    必然非均匀；
    /// ② 半成品形态（2026-10-01；2026-10-02 第 19 轮扩口径）——部分合成帧（一半真实
    ///    背景、一半黑条，即本文件 captureReferenceSize 注释里的「半张没合成的黑条」）
    ///    是**非均匀**的，① 看不见它。在同一次扫描里统计两个近黑占比写进
    ///    lastCaptureHadPartialBlack，供 commitCapturedTexture 在沉降窗口内采信：
    ///    全网格口径（边缘一圈黑）+ **外圈**口径（单侧/双侧黑带，见常量注释）。
    ///
    /// 第 20 轮（2026-10-03，耗电契约 ②①）删掉了原 ② 帧间变化检测——它按采样差把
    /// preferredFramesPerSecond 提到高刷、停一会儿再降回。但背景捕获有全局 33ms 节流：
    /// 提上去的那段渲染每一帧画的都是同一张纹理（shader 无随时间变化的 uniform），
    /// 白烧 GPU 还每帧唤醒 CPU。渲染档现在只跟采景档（syncRenderFrameRate），
    /// 采样网格只服务下面两个未就绪判据。
    ///
    /// 返回 isUniform。
    private func analyzeCapture(_ buffer: CVPixelBuffer, now: TimeInterval) -> Bool {
        // 首帧真实采景 = 窗口真正的起算点：锚点与首帧之间的墙钟可能整个被冷启动长任务
        // 吃掉，按锚点起算窗口会在首帧到达前过期（见 reanchorCaptureSettleWindowIfNeeded）
        reanchorCaptureSettleWindowIfNeeded(now)
        let (grid, columns) = Self.sampleCapture(buffer)

        guard !grid.isEmpty, columns > 0 else {
            lastCaptureHadPartialBlack = false
            return true
        }
        let rows = grid.count / columns
        let gridIsRectangular = rows > 0 && rows * columns == grid.count
        var minV: UInt8 = 255
        var maxV: UInt8 = 0
        var nearBlackCount = 0
        var edgeCellCount = 0
        var edgeNearBlackCount = 0
        for (index, value) in grid.enumerated() {
            if value < minV { minV = value }
            if value > maxV { maxV = value }
            if value <= Self.partialBlackValueThreshold { nearBlackCount += 1 }
            guard gridIsRectangular else { continue }
            let row = index / columns
            let col = index % columns
            if row == 0 || row == rows - 1 || col == 0 || col == columns - 1 {
                edgeCellCount += 1
                if value <= Self.partialBlackEdgeValueThreshold { edgeNearBlackCount += 1 }
            }
        }
        // 半成品形态判据（2026-10-01；2026-10-02 第 19 轮补外圈口径）：
        // ① 全网格近黑占比（形态 = 边缘一圈黑：最差实际网格 ≈19.8%）；
        // ② 外圈近黑占比（形态 = 单侧/双侧黑带：单侧占外圈 26.6%，但只占全网格 5.9%）。
        // 两个口径都只在沉降窗口内被采信，稳态（窗口外）不参与任何判定。
        let totalRatio = Double(nearBlackCount) / Double(grid.count)
        let edgeRatio = edgeCellCount > 0 ? Double(edgeNearBlackCount) / Double(edgeCellCount) : 0
        lastCaptureHadPartialBlack = totalRatio >= Self.partialBlackRatioThreshold ||
            edgeRatio >= Self.partialBlackEdgeRatioThreshold
        return Int(maxV) - Int(minV) <= 3
    }

    /// 捕获结果落地。未就绪帧沿用上一帧纹理——但必须有上限：
    /// 真实背景也可能恰好均匀（纯色底/暗色主题），无上限地沿用就等于把上一个页面的
    /// 内容永久留在透镜里（真机「点歌单再点搜索，椭圆背景里还是歌单的背景」）。
    /// 多缓冲（ZeroCopyBridge）保证「上一帧纹理」的内容真的还是上一帧的。
    ///
    /// 2026-10-01（本轮）：把「未就绪」判定从「是否整幅均匀」扩成「是否处于刚进入
    /// 层级的墙钟沉降窗口内、且画面仍可疑」，关掉两个残留窗口：
    /// ① 原上限是**帧数**（maxUniformHoldFrames）：冷启动掉帧时 4 帧可能横跨几百 ms，
    ///    与「backdrop 合成需要多久」没有对应关系；合成慢于 4 帧时第 5 帧就把整幅
    ///    均匀黑无条件提交（用户：「不论是首次进入软件……都会显示一瞬间的黑边阴影」）。
    ///    窗口内改用墙钟口径（CACurrentMediaTime），到 captureSettleDuration 强制放行。
    /// ② 原判据只挡「整幅均匀」：**部分合成**（一半真实背景、一半黑条）是非均匀的，
    ///    走下面的 else 分支直接落到无条件提交，把带黑边的半成品画出去（用户措辞是
    ///    「黑**边**」，形态上更贴这一条）。窗口内新增形态判据：稀疏网格里近黑格子
    ///    占比过高视为未就绪。
    ///
    /// 2026-10-02（用户第 19 轮第 1 条「老 bug 又出现了……第一次进入软件时就会发生」）
    /// 补三个漏口：
    /// ③ 形态判据与均匀沿用原先各用一条时限（0.35s / 0.6s）：0.35~0.6s 之间到达的
    ///    带状半成品被无条件提交 → 合并为单一时限（见 captureSettleDuration），窗口
    ///    从**首帧真实采景**起算（见 reanchorCaptureSettleWindowIfNeeded）；
    /// ④ 形态判据原先只有「全网格近黑占比」，标定只覆盖「一整圈黑边」，单侧黑带
    ///    只占全网格 5.9%、接不住 → 补外圈口径（partialBlackEdgeRatioThreshold）；
    /// ⑤ 原先深色外观整条逃逸（!isDarkAppearance）：Info.plist 没有 UIUserInterfaceStyle，
    ///    系统深色 + 应用浅色页面是最常见的组合，恰好把守卫关掉 → 取消逃逸，判据在
    ///    深色外观下同样生效（命中时最坏只是把本来就接近黑的画面多挡到窗口上限，
    ///    观感与真背景几乎无差；窗口上限仍在）。
    /// 最坏结局 = 玻璃晚出现一会儿：上限由墙钟常量现算，到点必然接受当前帧，
    /// 不存在「永久透明」或「永久留着上一页内容」的路径（沿用值恰是 previous，
    /// 窗口只是延后接受当前帧，从不改写当前帧）。
    /// 2026-10-11（第 56 轮第 1 条）：新增**结构性**判据「采景矩形刚变大 ⇒ 这一帧沿用」。
    /// 第 52 轮把「尺寸变化」接到了沉降窗口上（第五锚点，见 noteCaptureGeometry），但窗口
    /// 里沿用与否仍取决于 16×16 稀疏网格启发式，而 shader 的边缘折射（clamp_to_edge）采的
    /// 恰是纹理最外一圈——黑带整条落在采样点之间就漏判。用户第 56 轮第 1 条复报的粗黑弧
    /// 就是这条缝：迷你播放器展开/收起撞顶时高度跳变，新长出来那一带在 CABackdropLayer 里
    /// 还没合成，这一帧的采景必然带黑带。变大 ⇒ 无条件沿用（有 previous 时），不看启发式。
    /// 标记在这里消费并**无条件清掉**：否则「沿用 → 标记还在 → 下一帧继续沿用」会自锁
    /// 到窗口上限（最坏结局仍是玻璃晚出现一会儿，不会永久冻结）。
    private func commitCapturedTexture(_ texture: MTLTexture?, previous: MTLTexture?, isUniform: Bool) {
        let now = CACurrentMediaTime()
        let geometryGrew = captureGeometryGrewPending
        captureGeometryGrewPending = false
        var shouldHold = geometryGrew && previous != nil
        if isUniform {
            consecutiveUniformFrames += 1
            if consecutiveUniformFrames <= Self.maxUniformHoldFrames {
                // 冷启动 / 刚挂载（previous == nil）时这一帧是「backdrop 还没合成」的
                // 整幅均匀色，绝不能画出去：previous 为 nil 时这次赋值等于「继续没有
                // 背景纹理」，draw() 见 backgroundTexture == nil 会跳过本帧、视图保持
                // 透明（页面背景直接透出来），等真实背景的第一帧到了再显形。
                // 2026-10-01 修复：原实现写成 `..., let previous`，只有**已有上一帧**时
                // 才沿用，而冷启动第一帧恰恰是 previous == nil —— 整幅黑被当背景提交，
                // 就是「迷你播放器/底部 Tab 栏一出来就闪一下很粗的黑边」。
                // 上限仍保留：真实均匀背景（纯色底/暗色主题）最多挡 maxUniformHoldFrames
                // 帧，之后照常接受，不会把上一页内容永久留在玻璃里。
                shouldHold = true
            }
            // 墙钟口径（2026-10-01）：沉降窗口内均匀帧不再受帧数上限约束——冷启动
            // 掉帧时「4 帧」的时间跨度无法预期，帧数口径在合成跟不上时会在第 5 帧
            // 漏出整幅黑。窗口内继续沿用，最迟 captureSettleDuration 到点放行。
            if !shouldHold, isInsideCaptureSettleWindow(now) {
                shouldHold = true
            }
        } else {
            consecutiveUniformFrames = 0
            // 半成品形态判据（2026-10-01；2026-10-02 第 19 轮扩口径）：部分合成帧非均匀，
            // 上面的均匀判据看不见它。两个口径（全网格近黑占比 / 外圈近黑占比）都只在
            // 沉降窗口内采信，窗口与均匀沿用共用同一条时限——不再有「形态判据已过期、
            // 均匀沿用还在生效」的缝（原 0.35s vs 0.6s 就是黑边漏出的那条缝）。
            // 深色外观不再逃逸：详见 commitCapturedTexture 的文档注释 ⑤。
            if lastCaptureHadPartialBlack,
               isInsideCaptureSettleWindow(now) {
                shouldHold = true
            }
        }
        // 【第 62 轮第 1 条】恢复静默窗（见 resumeQuietUntil 的文档注释）：暂停恢复后的头
        // 120ms 一律不换画面。这一条**不看启发式**——恢复瞬间的采景是不是「半成品」由稀疏
        // 网格猜，猜漏一次用户就看到一次闪；这里用墙钟直接盖住那段窗口。
        // 采景矩形刚变大（geometryGrew）时**不参与**：那条路径手上是「旧尺寸」的纹理，
        // 多挂 120ms 等于让新长出来的区域多拉 120ms 的旧图（第 56 轮那条结构性沿用本来
        // 只挂一帧），不值得。尺寸没变时才谈「内容对不对」。
        // 放在陈旧度门**之前**求值：陈旧度门仍有最终否决权（它的上限 150ms 比本窗的 120ms
        // 长，正常情况下不会打架；真打起来以「不挂太旧的画面」为准）。
        if !shouldHold, !geometryGrew, now < resumeQuietUntil, backgroundTexture != nil, previous != nil {
            shouldHold = true
        }
        // 【第 122 轮】恢复 / 定格后的第一帧干净采景：静默窗、沉降窗口、几何沿用全部让行。
        // 「干净」= 非均匀且未被半成品判据命中 —— 可疑帧仍按既有策略沿用，黑边保护不变。
        // 标记只在真正消费到干净帧时清掉，否则留给后续帧继续尝试（沿用仍有墙钟上限）。
        if acceptNextCleanCapture, !isUniform, !lastCaptureHadPartialBlack {
            acceptNextCleanCapture = false
            shouldHold = false
        }
        // 陈旧度门（2026-10-11，第 56 轮第 2 条）：沿用到手的画面不能「太旧」——
        // 超过 maxStaleHoldAge 就宁可把这一帧半成品画出去，也不再挂旧画面。
        // 只对「手上已经有一张旧图」（backgroundTexture != nil）生效：冷启动那种
        // 「previous == nil ⇒ 沿用等于保持透明」不受影响（第 16/19 轮行为逐字保留）。
        if shouldHold, backgroundTexture != nil, now - lastCommitAcceptedAt > Self.maxStaleHoldAge {
            shouldHold = false
        }
        if shouldHold {
            backgroundTexture = previous
            // 【第 67 轮】沿用也是「本帧真的采了一帧、并有结论」：同样自增纹理修订号，
            // 让 draw() 照常画这一帧（去重只省「什么都没做」的帧，不省「刚做了什么」的帧）
            textureRevision &+= 1
            return
        }
        backgroundTexture = texture
        textureRevision &+= 1
        lastCommitAcceptedAt = now
    }

    func blurTexture() {
        #if targetEnvironment(simulator)
        // 模拟器上 MetalPerformanceShaders 内核不可用（初始化即断言崩溃）。
        // 跳过高斯模糊只损失一点背景柔化，保住模拟器可用性；真机路径不受影响。
        return
        #else
        // σ < 1 的模糊半径不足一像素级，视觉上完全不可辨（.regular 预设 0.3 即走
        // 此路径直接跳过）；MPS pass + 同步 waitUntilCompleted 的每帧 GPU 往返
        // 纯属浪费——这是捕获路径上除 drawHierarchy 外唯一的同步阻塞点，砍掉它
        // 是玻璃与列表性能隔离的第二刀。
        guard liquidGlass.backgroundTextureBlurRadius >= 1.0,
              let device,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              var backgroundTexture else { return }

        // Apply GPU-accelerated Gaussian blur via MPS
        // Scale blur radius to pixels
        let sigma = Float(liquidGlass.backgroundTextureBlurRadius * layer.contentsScale)
        let blur = MPSImageGaussianBlur(device: device, sigma: sigma)
        blur.edgeMode = .clamp

        blur.encode(commandBuffer: commandBuffer, inPlaceTexture: &backgroundTexture, fallbackCopyAllocator: nil)
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()
        #endif
    }

    func updateUniforms() {
        var uniforms = liquidGlass.shaderUniforms
        let scaleFactor = layer.contentsScale

        uniforms.resolution = .init(x: Float(bounds.width * scaleFactor),
                                    y: Float(bounds.height * scaleFactor))
        uniforms.contentsScale = Float(scaleFactor)

        uniforms.shapeMergeSmoothness = 0.2

        // Assign rectangles from frames array, or use bounds if empty
        let effectiveFrames = frames.isEmpty ? [bounds] : frames
        uniforms.rectangleCount = Int32(min(effectiveFrames.count, LiquidGlass.maxRectangles))

        // Convert CGRect frames to SIMD4<Float> (x, y, width, height)
        var rects: [SIMD4<Float>] = []
        for i in 0..<LiquidGlass.maxRectangles {
            if i < effectiveFrames.count {
                let frame = effectiveFrames[i]
                rects.append(SIMD4<Float>(
                    Float(frame.origin.x),
                    Float(frame.origin.y),
                    Float(frame.width),
                    Float(frame.height)
                ))
            } else {
                rects.append(.zero)
            }
        }
        uniforms.rectangles = (
            rects[0], rects[1], rects[2], rects[3],
            rects[4], rects[5], rects[6], rects[7],
            rects[8], rects[9], rects[10], rects[11],
            rects[12], rects[13], rects[14], rects[15]
        )

        if let touchPoint {
            uniforms.touchPoint = .init(x: Float(touchPoint.x), y: Float(touchPoint.y))
        }

//        uniforms.cornerRoundnessExponent = (layer.cornerCurve == .continuous) ? 4 : 2
        // 圆角钳制到短边一半：传入的 borderRadius 可能超过玻璃短边一半
        // （designRadius.xl=32，而迷你播放器胶囊高约 54、半高仅 27；tab 栏高 56、
        // 半高 28；透镜被挤压拉伸时 frame 变窄使其短边更小）。UIKit 会自动收敛为
        // 圆角胶囊，但 shader 的 roundedRectangleSDF 不收敛，圆角退化会让形状 SDF
        // 在边缘算错、把黑色背景折射进胶囊边缘，表现为胶囊右侧/透镜周围的黑影。
        // 对齐 LGLiquidLensHostView.setLensCornerRadius 的钳制处理（min(宽,高)/2）。
        let maxGlassRadius = min(bounds.width, bounds.height) / 2.0
        uniforms.cornerRadius = Float(min(layer.cornerRadius, CGFloat(maxGlassRadius)))
        // squircle 圆角（对齐 kit）：宿主 layer 用 continuous 曲线时按 squircle 折射
        uniforms.cornerRoundnessExponent = (layer.cornerCurve == .continuous) ? 4 : 2

        if let tintColor = liquidGlass.tintColor {
            uniforms.materialTint = tintColor.toSimdFloat4()
        }

        uniformsBuffer.contents().assumingMemoryBound(to: LiquidGlass.ShaderUniforms.self).pointee = uniforms
        // 【第 67 轮】本函数是**唯一**向 uniformsBuffer 写内容的地方（只在 layoutSubviews
        // 里被调用）⇒ 在这里自增修订号，「uniforms 有没有变」就有一个可靠且廉价的判据
        uniformsRevision &+= 1
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        updateUniforms()

        // 形状用 bounds（挤压/拉伸要真的变形），采景矩形与像素缓冲用 captureBaseSize
        // （透镜锁静止尺寸：拖动期间缓冲不再逐帧重建，采景层不再逐帧改尺寸）
        let baseSize = captureBaseSize
        let scale = layer.contentsScale * liquidGlass.backgroundTextureSizeCoefficient * liquidGlass.backgroundTextureScaleCoefficient
        let width = Int(baseSize.width * scale)
        let height = Int(baseSize.height * scale)
        zeroCopyBridge.setupBuffer(width: width, height: height)
    }

    override func draw(_ rect: CGRect) {
        // 本帧开始时的两份修订号：采景 / 布局若改动了输入，下面会与它们不等
        let textureRevisionAtFrameStart = textureRevision
        let uniformsRevisionAtFrameStart = uniformsRevision

        // Auto-capture background from superview if enabled（上游一致：连续渲染 +
        // 每帧捕获，实时折射；多玻璃实例互拍的黑影排除见 captureRootView）
        if autoCapture {
            captureBackground()
        }

        // 背景纹理未就绪（刚挂载/缓冲尺寸未定，setupBuffer 尚未跑出有效像素缓冲）
        // 时跳过本帧：视图保持透明，等下一帧再画，避免闪黑
        guard backgroundTexture != nil else { return }

        // 【第 67 轮·省电】去重呈现：本帧既没采到/换过背景纹理，也没有任何 uniforms 变化
        // （resize / 圆角 / 色调 / 融合矩形 / touchPoint 全都只在 updateUniforms 里落到
        // uniformsBuffer），而 shader 不含时间分量 ⇒ 这帧输出与上一次 present 的逐像素相同。
        // 那就别画：省下一次全屏片元着色 + 一次 drawable 获取 + 一次 CAMetalLayer 提交
        //（稳态 30fps 下每秒 30 次，多块玻璃各算一份）。
        // 采样**放在 captureBackground 之后**、且只在「零变化」时命中：采景节流挡掉的那些帧
        // 是本条唯一要省的目标，凡是真采了一帧（含判为沿用）或布局动过的帧一律照画。
        if hasPresentedFrame,
           textureRevision == textureRevisionAtFrameStart,
           uniformsRevision == uniformsRevisionAtFrameStart {
            return
        }

        // shader/pipeline 构建失败时玻璃降级为透明（iOS 26 兼容兜底），不崩溃
        guard let pipeline = LiquidGlassRenderer.shared.pipelineState else { return }

        guard let drawable = currentDrawable,
              let renderPassDesc = currentRenderPassDescriptor,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: renderPassDesc) else { return }

        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBuffer(uniformsBuffer, offset: 0, index: 0)

        if let texture = backgroundTexture {
            encoder.setFragmentTexture(texture, index: 0)
        }

        // Draw fullscreen quad (vertices generated in vertex shader)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()

        commandBuffer.present(drawable)
        commandBuffer.commit()
        // 【第 67 轮】到这一帧为止 CAMetalLayer 上有内容了，之后再遇到「输入零变化」的帧
        // 才允许跳过（见上面那段去重呈现的说明）
        hasPresentedFrame = true
    }
}

extension UIColor {
    func toSimdFloat4() -> SIMD4<Float> {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return .init(x: Float(r), y: Float(g), z: Float(b), w: Float(a))
    }
}

// Helpers: Lerp for damping, UIColor to Half4
//private func lerp(_ a: SIMD2<Float>, _ b: SIMD2<Float>, _ t: Float) -> SIMD2<Float> {
//    return a * (1 - t) + b * t
//}

extension UIView {
    /// 【第 73 轮第 5 条】采景源：**包含本玻璃的那一屏**，不是整个 App 的根视图。
    ///
    /// 用户原话（第 73 轮第 5 条）：「静态情况下，液态播放透过的画面在切入切回时可以实时
    /// 显示，当我上下左右滑动界面再切入切回时，透过的画面会显示在移动前的画面，而此时画面
    /// 已移动后了……使透过的画面在切回过程中能保证画面真实」。
    ///
    /// 关键就在 findRootView() 给的是 window.rootViewController.view —— **整棵 App 树**：
    /// 转场中间根视图里同时挂着两屏（压栈进来的新屏 model 位置就是最终位置，位移只在
    /// render 树上），而本类一律按 model 取几何、按 model 渲染（见 captureRootView 的第 60
    /// 轮第 1 条注释）⇒ 贴着本玻璃的那块矩形采到的是**别的屏**的内容。玻璃把别的屏的画面
    /// 贴在自己身后，切回时露出来的就是一张与本屏当前内容对不上的画面（第 60/61 轮那条
    /// 「透过的画面是由右向左滑入的，方向是反的」正是同一件事的另一面）。
    ///
    /// 收窄到「响应链上最近的、其视图确实包含本玻璃的那个 UIViewController 的视图」之后，
    /// 采景恒等于**本屏自己的静止态内容**：玻璃挂在哪一屏就只可能采到那一屏，跨屏污染
    /// 结构上不可能发生；本屏自己的行进位移也不会跟进来（几何与内容同源、同屏）。
    /// 三条判据：控制器要有**已加载**的视图（viewIfLoaded —— 不为了采景把没加载的视图
    /// 拉起来）、视图确实包含本玻璃（isDescendant(of:) —— 防响应链上挂着别的控制器）、
    /// 视图比本玻璃宽出一圈余量（采景矩形 = 玻璃矩形 × backgroundTextureSizeCoefficient，
    /// 最大档 1.1 —— 候选视图太小的话矩形会伸到视图外，缓冲边缘没画到的黑带会被折射进
    /// 玻璃边缘）。都不满足就继续往上找；整条响应链上没有 ⇒ 逐字回退 findRootView()
    /// （宿主被直接塞进窗口、还没有任何控制器接手这类形态）。
    /// 【第 162 轮】窗口里是否还有滚动视图在动画（presentation 的 contentOffset 与 model
    /// 不一致）。分页程序化回位、列表惯性都走这条；它们在转场后的一小段里会让背景横移。
    func isAnyScrollViewAnimating() -> Bool {
        guard let window else { return false }
        var found = false
        func walk(_ view: UIView) {
            if found { return }
            if let scrollView = view as? UIScrollView {
                let model = scrollView.contentOffset
                if let presentation = scrollView.layer.presentation() {
                    let visible = presentation.bounds.origin
                    if abs(visible.x - model.x) > 1.0 || abs(visible.y - model.y) > 1.0 {
                        found = true
                        return
                    }
                }
            }
            for subview in view.subviews { walk(subview) }
        }
        walk(window)
        return found
    }

    /// 【第 158 轮】玻璃自己或任一祖先（底栏容器 / 所在那屏 / 导航容器）是否还在做位移动画。
    /// 转场刚结束时底栏的收起/展开、页面回位都发生在这一段：模型几何与屏幕上的位置不一致，
    /// 此时采到的内容会在玻璃里横向跳一下。
    func isGlassOrAncestorAnimating() -> Bool {
        var view: UIView? = self
        var depth = 0
        while let current = view, depth < 12 {
            let model = current.layer
            if let presentation = model.presentation() {
                if abs(presentation.position.x - model.position.x) > 0.5 ||
                   abs(presentation.position.y - model.position.y) > 0.5 ||
                   abs(presentation.bounds.width - model.bounds.width) > 0.5 ||
                   abs(presentation.bounds.height - model.bounds.height) > 0.5 {
                    return true
                }
                // 转场大多用 transform 平移/缩放：只看 position 会漏掉，采到移动中的背景
                // 就是「透过的画面整体左移一段再回来」。
                let inFlight = presentation.transform
                let settled = model.transform
                if abs(inFlight.m41 - settled.m41) > 0.5 ||
                   abs(inFlight.m42 - settled.m42) > 0.5 ||
                   abs(inFlight.m11 - settled.m11) > 0.01 ||
                   abs(inFlight.m22 - settled.m22) > 0.01 {
                    return true
                }
            }
            view = current.superview
            depth += 1
        }
        return false
    }

    /// 【第 152 轮】采景源所在的那一屏是否还在做转场 / 其它位移动画（push、pop、边缘返回）。
    /// 只看祖先方向：列表滚动、Tab 栏收展都不搬这一屏，不会误判。
    func isCaptureSourceMoving() -> Bool {
        guard let source = findCaptureSourceView() else { return false }
        var view: UIView? = source
        var depth = 0
        while let current = view, depth < 8 {
            let model = current.layer
            if let presentation = model.presentation() {
                if abs(presentation.position.x - model.position.x) > 0.5 ||
                   abs(presentation.position.y - model.position.y) > 0.5 ||
                   abs(presentation.bounds.width - model.bounds.width) > 0.5 ||
                   abs(presentation.bounds.height - model.bounds.height) > 0.5 {
                    return true
                }
                let inFlight = presentation.transform
                let settled = model.transform
                if abs(inFlight.m41 - settled.m41) > 0.5 ||
                   abs(inFlight.m42 - settled.m42) > 0.5 {
                    return true
                }
            }
            view = current.superview
            depth += 1
        }
        return false
    }

    func findCaptureSourceView() -> UIView? {
        var responder: UIResponder? = self
        while let current = responder {
            if let controller = current as? UIViewController,
               let sourceView = controller.viewIfLoaded,
               isDescendant(of: sourceView),
               sourceView.bounds.width >= bounds.width + 24,
               sourceView.bounds.height >= bounds.height + 24 {
                return sourceView
            }
            responder = current.next
        }
        return findRootView()
    }

    /// Finds the topmost content view owning our window.
    /// 直接对 `UIWindow.layer` 调 render/drawHierarchy 在 iOS 26 上易因私有状态栏/
    /// 键盘/RNN 容器图层抛异常崩溃；优先返回 window.rootViewController.view。
    func findRootView() -> UIView? {
        if let rootVCView = window?.rootViewController?.view {
            return rootVCView
        }
        var current: UIView? = superview
        while let parent = current?.superview {
            current = parent
        }
        return current
    }
}
