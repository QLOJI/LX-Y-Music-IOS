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

    func add(_ view: LiquidGlassView) {
        instances.add(view)
    }

    /// 本窗口内需要从截屏排除的「玻璃组件根」（按身份去重 + 去掉互相包含的子根）：
    /// 每个实例解析为 captureExclusionView（nil → 所在 LiquidGlassEffectView → 实例
    /// 自身）。隐藏父级根即同时覆盖其下所有玻璃的 MTK 输出与玻璃上方的前景内容；
    /// 单独隐藏 MTK 不够——挂在玻璃上方的前景（RN 图标/按钮）也会被截进背景纹理。
    func exclusionRoots(in window: UIWindow?) -> [UIView] {
        var roots: [UIView] = []
        var seen = Set<ObjectIdentifier>()
        for instance in instances.allObjects {
            guard let glass = instance as? LiquidGlassView, glass.window === window else { continue }
            let root = glass.captureExclusionView ?? (glass.superview as? LiquidGlassEffectView) ?? glass
            if seen.insert(ObjectIdentifier(root)).inserted { roots.append(root) }
        }
        return roots.filter { view in !roots.contains { $0 !== view && view.isDescendant(of: $0) } }
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

    /// 采景尺寸变化 = 第五个沉降窗口锚点（见 lastCaptureGeometry）。
    /// 只比尺寸**不比原点**：原点平移（透镜拖动、列表滚动时玻璃不动）不需要重新合成，
    /// 那正是 captureReferenceSize 注释里已被接受的现状；而尺寸变化必然是
    /// 「CABackdropLayer 整幅重合成」，才是黑带的来源。
    private func noteCaptureGeometry(_ captureSize: CGSize) {
        let changed = abs(captureSize.width - lastCaptureGeometry.width) > Self.captureGeometryEpsilon ||
            abs(captureSize.height - lastCaptureGeometry.height) > Self.captureGeometryEpsilon
        lastCaptureGeometry = captureSize
        if changed { beginCaptureSettleWindow() }
    }

    /// 半成品判据（二要素之一）：网格单元格的最大通道值 ≤ 该值视为「近黑」。
    /// 取 8/255：render server 未合成的区域是纯黑（个位数），真实内容即使很暗也
    /// 极少整片 ≤8（8/255 以下在屏幕上已几乎不可辨内容）。
    private static let partialBlackValueThreshold: UInt8 = 8

    /// 半成品判据（二要素之二）：近黑格子占比 ≥ 该比例 → 判为「部分合成未完成」。
    /// 标定依据（2026-10-01 阈值核算，用户实测形态 = 「边缘一圈黑、中间正常」）：
    /// 采样网格每轴 16~17 格（sampleCapture：ceil(dim / floor(dim/16))，2x 机短条
    /// 可到 22 行）。最外 1 格厚的边环 = NM-(N-2)(M-2) = 2N+2M-4 格：
    /// 16×16 → 60/256 ≈ 23.4%；17×17 → 64/289 ≈ 22.2%；最差实际网格
    /// 17×22 → 74/374 ≈ 19.8%。原 0.35 高过上述全部值——「一圈黑边」整类形态
    /// 都会漏过（黑边照常提交，bug 残留）。取 0.18：低于最差实际网格 19.8%
    /// 且留余量；误触发（真实暗内容恰好 ≥18%）的代价被沉降窗口（≤0.6s）封顶
    /// ——最坏只让玻璃晚接受到窗口到点，不画错内容、不永久透明
    ///（见 commitCapturedTexture 与 captureSettleDuration 注释）。
    private static let partialBlackRatioThreshold: Double = 0.18

    /// 半成品判据（三要素之三，2026-10-02 第 19 轮补）：**外圈**近黑占比 ≥ 该比例。
    /// 为什么单独盯外圈：shader 边缘采样折射的恰是纹理最外一圈（clamp_to_edge），
    /// 而部分合成常常只吃掉一条边——1 格厚的单侧黑带占全网格只有 17/374 ≈ 4.5%
    /// （全网格阈值 0.18 接不住），却占外圈 N/(2N+2M-4)：17×17 → 17/64 ≈ 26.6%、
    /// 最差实际网格 17×22 → 17/74 ≈ 23.0%。取 0.20：低于上述两值且留余量，
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
    /// 实时档 60fps：与 liveCaptureMinInterval(16.7ms) **同速**（透镜抬起 / 横滑会话）。
    private static let liveFramesPerSecond = 60
    /// 把渲染帧率同步到当前采景档。**全类唯一给 preferredFramesPerSecond 赋值的地方** ——
    /// 档位由 isLiveCaptureActive 两个标志唯一决定，任何会话开始/结束都走这里，
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

    /// 当前是否处于「实时采景」档：采景间隔用 liveCaptureMinInterval(60fps)，
    /// 渲染帧率同档提到 liveFramesPerSecond(60fps)（见 syncRenderFrameRate）。
    private var isLiveCaptureActive: Bool { liveCaptureRequested || realtimeCaptureRequested }

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

    /// 跨实例共享的捕获节流（全局 33ms）：捕获已在主线程执行（见 captureRootView），
    /// 必须限制主线程占用；玻璃实例（迷你播放条/Tab 栏/透镜）各自独立渲染线程，
    /// 用锁保护检查-设置。
    private static let globalCaptureLock = NSLock()
    private static var globalLastCaptureAt: TimeInterval = 0

    /// 采景节流（**每实例**，2026-10-02，用户第 5 条）：两次采景之间的最小墙钟间隔。
    /// 完整说明见 shouldThrottleCapture。取 30fps（= idleFramesPerSecond 的静止态基线）。
    private static let captureMinInterval: TimeInterval = 0.0333
    /// 显式高刷会话（liveCaptureRequested：透镜抬起/跟手、收起圆钮重新入层级）的采景
    /// 间隔：60fps，比静止态基线宽一倍，但仍封顶——见 shouldThrottleCapture 的说明。
    private static let liveCaptureMinInterval: TimeInterval = 0.0167
    /// 本实例最近一次**被接受的**采景时刻（墙钟秒）。只由 shouldThrottleCapture 读写，
    /// 都在渲染帧内（与 captureBackdrop 同一线程），不需要锁。
    private var lastCaptureAt: TimeInterval = 0
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
//        layer.shouldRasterize = true
//        clipsToBounds = true
//        autoResizeDrawable = false
//        contentMode = .center
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
        if window != nil {
            beginCaptureSettleWindow()
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

    func captureBackground() {
        // 本帧的形态判据只属于本帧（2026-10-01）：analyzeCapture 会重写此标记；
        // 捕获提前返回（节流 / 缺窗口 / backdrop 不可用）时也保持 false，
        // 避免把上一帧的「半成品」印象带进下一次提交。
        lastCaptureHadPartialBlack = false
        if #available(iOS 26.2, *) {
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
    ///  ① 丢掉旧纹理（backgroundTexture = nil）：沿用分支从此无可沿用，只能「继续透明，
    ///     等本次真实背景」，页面背景直接透出来 —— 用户要看的是**当前**画面；
    ///  ② 清掉「未就绪沿用」的全部痕迹（均匀帧计数、半成品标记、变化检测基准）；
    ///  ③ 立刻同步采一次（复位节流 + captureBackground），让恢复后的**第一帧** draw
    ///     就用上当前背景，而不是等下一个 tick（30fps 档下最多 33ms 的旧画面）；
    ///  ④ 重开墙钟沉降窗口（beginCaptureSettleWindow，2026-10-02 用户第 16 轮第 1 条）——
    ///     暂停恢复同样属于「合成源刚建立」，恢复后最初的半成品帧（非均匀但带近黑条带）
    ///     必须按未就绪沿用（previous 刚被置 nil ⇒ 透明），否则黑边会被折射进胶囊边缘。
    ///
    /// 剩余代价：CAMetalLayer 上那一帧旧图像必然要显示到下一次 draw 为止（≤1 拍），
    /// 这是暂停式省电门的固有代价；本次复位把「多次沿用旧帧 / 等到下一 tick」压到
    /// 「最多一拍」。渲染档与采景档重新同步（第 20 轮：两者同速，见 syncRenderFrameRate）
    /// ——静止档下一拍 ≤33ms，与既有静止态上限一致。
    func handleResumeFromPause() {
        backgroundTexture = nil
        consecutiveUniformFrames = 0
        lastCaptureHadPartialBlack = false
        lastCaptureAt = 0
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
        // 这里补上与其余锚点同口径的开窗：窗口内未就绪帧沿用 previous，而 previous 刚被置 nil
        // → 显示为透明（页面背景直出），等本次会话第一帧可信背景，绝不会把半成品折射进玻璃边缘。
        // 顺序：先开窗再 captureBackground，采到的这一帧本身也在窗口覆盖内。
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
        guard let rootView = findRootView() else { return }

        let sizeCoefficient = liquidGlass.backgroundTextureSizeCoefficient
        let scaleCoefficient = layer.contentsScale * liquidGlass.backgroundTextureScaleCoefficient

        // Determine our on-screen rect in the root view coordinate space.
        // IMPORTANT: During `UIView.animate`, the view's *model* layer jumps to the final frame
        // immediately; the in-flight position lives in the *presentation* layer. Using the
        // presentation layer makes the captured background track the view while it animates.
        let currentLayer = layer.presentation() ?? layer
        let frameInRoot = currentLayer.convert(currentLayer.bounds, to: rootView.layer)

        // Expand capture area around the MTKView center (in root view coordinates).
        // 【尺寸】与背景像素缓冲同源（captureBaseSize，见 layoutSubviews 的 setupBuffer），
        // 【中心】跟随 presentation 保持动画位置跟踪：逐帧变形动画（迷你播放器收窄/放出、
        // 透镜挤压/拉伸）期间 presentation 尺寸比 model 慢一拍，若用 presentation 尺寸，
        // 变宽瞬间缓冲右/下侧会留下一条没画到的黑带，被 shader 折射进胶囊边缘。
        // 再外扩 1 缓冲像素盖住 Int 取整缝隙，保证缓冲无未绘制纹理，
        // clamp_to_edge 边缘采样不会读到黑边。
        let baseSize = captureBaseSize
        let devicePixel = 1.0 / scaleCoefficient
        let captureSize = CGSize(width: baseSize.width * sizeCoefficient + devicePixel * 2,
                                 height: baseSize.height * sizeCoefficient + devicePixel * 2)
        let captureRectInRoot = CGRect(x: frameInRoot.midX - captureSize.width / 2,
                                       y: frameInRoot.midY - captureSize.height / 2,
                                       width: captureSize.width,
                                       height: captureSize.height)

        // 【全局 33ms 节流 + 主线程捕获】26.2+/27 的 renderInContext 不可靠读取渲染线程
        // 上的未提交模型变更（排除失效 → 前景/玻璃本体漏进捕获：图标黑帽、按钮黑块、
        // 玻璃惨白，26.2+/27 真机实锤）；而提交隐藏态（commit/flush）又会闪屏。唯一跨
        // 版本确定的做法：捕获整体搬到主线程执行——hide → render → restore → commit，
        // restore 先于 commit，render server 永远看不到隐藏态（不闪）；主线程的
        // renderInContext 读模型必然含排除（不漏）。全局节流（跨实例共享）限制主线程
        // 占用；首帧（无纹理）不节流。
        if backgroundTexture != nil {
            var throttled = false
            Self.globalCaptureLock.lock()
            let now = CACurrentMediaTime()
            if now - Self.globalLastCaptureAt < 0.033 { throttled = true } else { Self.globalLastCaptureAt = now }
            Self.globalCaptureLock.unlock()
            if throttled { return }
        }

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

                let rootViewLayer = rootView.layer.presentation() ?? rootView.layer
                let rendered = self.useLayerRender && LXGlassTryRenderLayer(rootViewLayer, context)
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
    private func shouldThrottleCapture(_ now: TimeInterval) -> Bool {
        guard backgroundTexture != nil else { return false }
        // 实时档 = 透镜抬起（liveCaptureRequested）**或** RN `live` prop（横滑会话，
        // realtimeCaptureRequested）：两者都放宽到 liveCaptureMinInterval(60fps)。
        let interval = isLiveCaptureActive ? Self.liveCaptureMinInterval : Self.captureMinInterval
        if now - lastCaptureAt < interval { return true }
        lastCaptureAt = now
        return false
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
        let capturedTexture = zeroCopyBridge.render { context in
            context.scaleBy(x: scaleCoefficient, y: scaleCoefficient)

            UIGraphicsPushContext(context)
            backdropView.drawHierarchy(in: backdropView.bounds, afterScreenUpdates: false)
            UIGraphicsPopContext()

            if let buffer = zeroCopyBridge.pixelBuffer {
                capturedIsUniform = self.analyzeCapture(buffer, now: captureStartedAt)
            }
        }
        commitCapturedTexture(capturedTexture, previous: previousTexture, isUniform: capturedIsUniform)

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
        let stepX = max(w / 16, 1)
        let stepY = max(h / 16, 1)
        var grid: [UInt8] = []
        grid.reserveCapacity(17 * 17)
        var columns = 0
        var y = 0
        while y < h {
            let row = y * bpr
            var x = 0
            var rowColumns = 0
            while x < w {
                let o = row + x * 4 // BGRA
                let r = Int(ptr[o + 2])
                let g = Int(ptr[o + 1])
                let b = Int(ptr[o])
                grid.append(UInt8(max(r, max(g, b))))
                rowColumns += 1
                x += stepX
            }
            if columns == 0 { columns = rowColumns }
            y += stepY
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
    private func commitCapturedTexture(_ texture: MTLTexture?, previous: MTLTexture?, isUniform: Bool) {
        let now = CACurrentMediaTime()
        var shouldHold = false
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
        if shouldHold {
            backgroundTexture = previous
            return
        }
        backgroundTexture = texture
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

//        setNeedsDisplay()
//        draw(bounds)
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
        // Auto-capture background from superview if enabled（上游一致：连续渲染 +
        // 每帧捕获，实时折射；多玻璃实例互拍的黑影排除见 captureRootView）
        if autoCapture {
            captureBackground()
        }

        // 背景纹理未就绪（刚挂载/缓冲尺寸未定，setupBuffer 尚未跑出有效像素缓冲）
        // 时跳过本帧：视图保持透明，等下一帧再画，避免闪黑
        guard backgroundTexture != nil else { return }

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
