//
//  LiquidLensView.swift
//  LiquidGlass (vendored from DnV1eX/LiquidGlassKit)
//
//  Created by Alexey Demin on 2025-12-19.
//  Vendored modifications for LX Music CocoaPods static-lib build:
//  1. `internal import` (Swift 6.0+ syntax) replaced with plain `import`.
//  2. `restingBackgroundColor` / `setLifted(...)` / `setLensCornerRadius(...)` marked
//     `@objc` and a small `LGLensFactory` added — the React Native view manager
//     (LiquidGlassViewManager.mm) drives the lens from ObjC, and Swift members are
//     not ObjC-visible without explicit @objc.
//  3. Resting pill follows upstream: a semi-transparent white pill (white 0.3 alpha)
//     rests under the selected tab and crossfades with the lifted glass. (It was
//     removed once to keep the lens motion-only — it leaked through the crossfade as
//     a square base; restored when the app decided to fully align with upstream.)
//  4. Lens body aligned to upstream 2eb41c5: lifting morphs into the real
//     `LiquidGlassView(.lens)` (Metal refraction + rim light, same engine as the bar
//     glass). The frosted-blur stand-in from the era when the Metal path was disabled
//     lived here and was reverted in the same pass that brought the Metal path back.
//  5. 2026-09-29: the drag/long-press gesture layer lives entirely in the RN host
//     (LiquidGlassViewManager.mm) and upstream has no such layer — removed by user
//     decision ("上游没有的也不要"). The frames-merge / touch-point glare bridge
//     methods that only the gesture machine consumed went with it; LiquidGlassView's
//     own frames/touchPoint capabilities (kit core) remain untouched.
//  Upstream: Copyright © 2025 DnV1eX, https://github.com/DnV1eX/LiquidGlassKit
//

import UIKit
import MetalKit

/// A custom implementation of the private _UILiquidLensView used in UITabBar.
/// Provides a resting state with a semi-transparent white pill that morphs
/// into a LiquidGlassView when lifted.
public final class LiquidLensView: UIView, AnyLiquidLensView {

    // MARK: - Acceleration Constants

    /// Time window for calculating average acceleration (in seconds).
    private let accelerationWindowDuration: TimeInterval = 0.3

    /// Coefficient to convert acceleration to scale transform.
    private let accelerationScaleCoefficient: CGFloat = 0.00005

    /// Maximum scale deviation from 1.0 (clamped for visual stability).
    private let maxScaleDeviation: CGFloat = 0.3

    /// 挤压/拉伸目标的低通系数（指数平滑，见 applyAccelerationSize）。加速度是从
    /// 离散位置样本里二阶差分出来的，天然带尖峰；即使采样修正后仍会逐帧抖，
    /// 直接写进 frame 就是 120Hz 的高频胀缩（用户报的「抖动太厉害」）。
    /// 0.18 在 ProMotion 上仍是即时跟手的手感，但把逐帧抖动压成一次平滑过渡。
    private let scaleSmoothingFactor: CGFloat = 0.18

    /// 低通状态：当前实际生效的缩放量（0 = 未变形）。
    private var smoothedScale: CGFloat = 0

    // MARK: - Position Tracking

    private var positionHistory: [(position: CGPoint, timestamp: TimeInterval)] = []
    private var displayLink: CADisplayLink?

    // MARK: - Private Stored Views (weak references)

    private weak var liftedContainerView: UIView?
    private weak var liftedContentView: UIView?
    private weak var overridePunchoutView: UIView?

    // MARK: - Private Properties

    /// Whether the view is currently in lifted state.
    private var isLifted = false

    /// The liquid glass content mode.
    private var liftedContentMode: Int = 0

    /// The liquid glass style.
    private var style: Int = 0

    /// Whether the view warps content below it.
    private var warpsContentBelow: Bool = false

    // MARK: - Private Views

    /// The resting background view - semi-transparent white pill shown in resting state.
    private let restingPillView = UIView()

    /// 抬起态的液态玻璃（对齐上游：LiquidGlassView(.lens) —— Metal 折射 + 边缘光 +
    /// frames 多矩形合并，与底部栏玻璃同源同引擎）。历史上的磨砂代餐已随 Metal 路径
    /// 恢复一并退场。
    private let liquidGlassView = LiquidGlassView(.lens)

    // MARK: - Protocol Properties

    /// 静止药丸底色（上游 restingBackgroundColor，默认白 30%；宿主可经 pillColor
    /// prop 覆盖——JS 当前不传，走默认）。
    @objc public var restingBackgroundColor: UIColor? {
        get { restingPillView.backgroundColor }
        set { restingPillView.backgroundColor = newValue }
    }

    /// Vendored addition: 玻璃染色（LiquidGlassView.tintColor → shader materialTint）。
    /// nil（默认）= 用 .lens 预设的玻璃动态色 —— 对齐本项目「纯玻璃不随主题色」定案，
    /// 不要传主题色。
    @objc public func setLensTintColor(_ color: UIColor?) {
        liquidGlassView.liquidGlass.tintColor = color
    }

    /// Vendored addition: 捕获排除根透传（mm 宿主在挂载时指向 JS 父容器）。透镜叠在
    /// tab 图标/文字**上方**（JS 里 LiquidLens 先于 tab 项渲染），这些前景若不排除
    /// 会被画进透镜的背景捕获纹理、折射进药丸（与栏体玻璃同源的重影问题）。
    @objc public func setCaptureExclusionView(_ view: UIView?) {
        liquidGlassView.captureExclusionView = view
    }

    /// Vendored addition: 仅对磨砂覆层有意义（0~1）。液态形态无对应参数，
    /// 保留空操作维持 OC 桥接面（mm 按 respondsToSelector 分流继续传值）。
    @objc public func setLensGlassOpacity(_ opacity: CGFloat) {
    }

    // MARK: - Initialization

    convenience public init() {
        self.init(restingBackground: nil)
    }

    public init(restingBackground backgroundView: UIView?) {
        super.init(frame: .zero)
        commonInit()
        if let backgroundView {
            restingPillView.addSubview(backgroundView)
        }
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        clipsToBounds = false

        // Setup resting pill view - semi-transparent white
        restingPillView.backgroundColor = UIColor.white.withAlphaComponent(0.3)
        restingPillView.isUserInteractionEnabled = false
        addSubview(restingPillView)

        // Setup liquid glass view - initially hidden（上游行为：lift 时才 addSubview）
        liquidGlassView.isUserInteractionEnabled = false
        liquidGlassView.alpha = 0
        // Not added to view hierarchy initially - only shown when lifted
    }

    // MARK: - Layout

    /// 圆角覆盖（Vendored addition）：默认 -1 = 胶囊圆角（min(w,h)/2）；宿主 tab 栏
    /// 传入与其一致的圆角后，透镜呈与栏体圆角对齐的圆角矩形而非胶囊。
    private var cornerRadiusOverride: CGFloat = -1

    @objc public func setLensCornerRadius(_ radius: CGFloat) {
        guard cornerRadiusOverride != radius else { return }
        cornerRadiusOverride = radius
        setNeedsLayout()
    }

    public override func layoutSubviews() {
        super.layoutSubviews()

        // Update resting pill to fill bounds with pill shape
        restingPillView.frame = bounds
        restingPillView.layer.cornerRadius = cornerRadiusOverride >= 0
            ? cornerRadiusOverride
            : min(bounds.width, bounds.height) / 2
        // 静止药丸与抬起玻璃同为胶囊形态：不跟随系统默认曲线（iOS 26 起默认
        // continuous 会让贴边的圆角呈方形超椭圆观感）
        restingPillView.layer.cornerCurve = .circular

        // Vendored：抬起期间宿主任何一次重布局（圆角 override 更新、尺寸变化、
        // span 退出复位 frame）都同步重申玻璃的圆角与 circular 曲线，保证任何
        // 状态下透镜都是标准胶囊/圆角矩形，不会退化为方形。
        // layer.cornerRadius 由 LiquidGlassView.updateUniforms 同步进 shader
        // （折射形状跟随），无需单独传 uniforms。
        if isLifted {
            let halfShortSide = min(bounds.width, bounds.height) / 2
            liquidGlassView.layer.cornerRadius = cornerRadiusOverride >= 0
                ? min(cornerRadiusOverride, halfShortSide)
                : halfShortSide
            liquidGlassView.layer.cornerCurve = .circular

            // 采景基准 = 药丸的静止尺寸（见 LiquidGlassView.captureReferenceSize）：
            // 挤压/拉伸只改 shader 形状，采景矩形与像素缓冲始终保持这个尺寸不动。
            liquidGlassView.captureReferenceSize = bounds.size
        }
    }

    // MARK: - Protocol Methods

    public func setLiftedContainerView(_ containerView: UIView?) {
        liftedContainerView = containerView
    }

    public func setLiftedContentView(_ contentView: UIView?) {
        liftedContentView = contentView
    }

    public func setOverridePunchoutView(_ punchoutView: UIView?) {
        overridePunchoutView = punchoutView
    }

    @objc public func setLifted(_ lifted: Bool, animated: Bool, alongsideAnimations: (() -> Void)?, completion: ((Bool) -> Void)?) {
        guard isLifted != lifted else {
            completion?(true)
            return
        }

        isLifted = lifted

        if lifted {
            liftUp(animated: animated, alongsideAnimations: alongsideAnimations, completion: completion)
        } else {
            liftDown(animated: animated, alongsideAnimations: alongsideAnimations, completion: completion)
        }
    }

    public func setLiftedContentMode(_ contentMode: Int) {
        self.liftedContentMode = contentMode
    }

    public func setStyle(_ style: Int) {
        self.style = style
    }

    public func setWarpsContentBelow(_ warpsContentBelow: Bool) {
        self.warpsContentBelow = warpsContentBelow
    }

    // MARK: - Private Lift Animation

    /// Morphs to the liquid glass view（上游 liftUp：0.4 spring / damping 0.7）。
    private func liftUp(animated: Bool, alongsideAnimations: (() -> Void)?, completion: ((Bool) -> Void)?) {
        // Prepare liquid glass view at same position
        liquidGlassView.frame = bounds
        // 抬起玻璃的圆角按 override 与短边一半现算并强制 circular 曲线：透镜恒为
        // 圆角胶囊，不跟随系统默认（continuous 指数 4 会呈方形超椭圆观感）。
        let halfShortSide = min(bounds.width, bounds.height) / 2
        liquidGlassView.layer.cornerRadius = cornerRadiusOverride >= 0
            ? min(cornerRadiusOverride, halfShortSide)
            : halfShortSide
        liquidGlassView.layer.cornerCurve = .circular
        liquidGlassView.alpha = 0
        addSubview(liquidGlassView)

        // 采景几何：基准锁成静止药丸尺寸（挤压/拉伸不再逐帧改采景矩形尺寸）
        liquidGlassView.captureReferenceSize = bounds.size
        // 抬起/跟手期间背景每帧都在变：丢掉上一次抬起留下的背景纹理（那是上次点击
        // 位置的页面内容），并把刷新率拉满；落下后由 endLiveCapture 交回自适应帧率。
        liquidGlassView.beginLiveCapture()

        // Start position tracking for acceleration-based squash/stretch
        startPositionTracking()

        let animations = {
            // Fade out resting pill
            self.restingPillView.alpha = 0

            // Fade in liquid glass
            self.liquidGlassView.alpha = 1

            alongsideAnimations?()
        }

        let animationCompletion: (Bool) -> Void = { finished in
            completion?(finished)
        }

        if animated {
            UIView.animate(
                withDuration: 0.4,
                delay: 0,
                usingSpringWithDamping: 0.7,
                initialSpringVelocity: 0,
                options: [.beginFromCurrentState, .allowUserInteraction],
                animations: animations,
                completion: animationCompletion
            )
        } else {
            animations()
            animationCompletion(true)
        }
    }

    /// Morphs back to resting (hidden, aligned upstream liftDown: 0.5 spring / damping 0.8).
    private func liftDown(animated: Bool, alongsideAnimations: (() -> Void)?, completion: ((Bool) -> Void)?) {
        // Stop position tracking
        stopPositionTracking()

        // Prepare resting pill for fade in
        restingPillView.alpha = 0

        let animations = {
            // Fade in resting pill
            self.restingPillView.alpha = 1

            // Fade out liquid glass（回落为静止药丸常显）
            self.liquidGlassView.alpha = 0

            alongsideAnimations?()
        }

        let animationCompletion: (Bool) -> Void = { finished in
            // 交回自适应帧率（回落动画期间背景仍在变，LiquidGlassView 会自己再提上去）
            self.liquidGlassView.endLiveCapture()
            guard finished else {
                completion?(finished)
                return
            }
            // Clean up liquid glass view
            self.liquidGlassView.removeFromSuperview()
            self.liquidGlassView.alpha = 1
            completion?(finished)
        }

        if animated {
            UIView.animate(
                withDuration: 0.5,
                delay: 0,
                usingSpringWithDamping: 0.8,
                initialSpringVelocity: 0,
                options: [.beginFromCurrentState, .allowUserInteraction],
                animations: animations,
                completion: animationCompletion
            )
        } else {
            animations()
            animationCompletion(true)
        }
    }

    // MARK: - Position Tracking & Acceleration

    private func startPositionTracking() {
        positionHistory.removeAll()
        smoothedScale = 0
        displayLink = CADisplayLink(target: self, selector: #selector(updatePositionTracking))
        displayLink?.add(to: .main, forMode: .common)
    }

    private func stopPositionTracking() {
        displayLink?.invalidate()
        displayLink = nil
        positionHistory.removeAll()
        // Reset liquid glass view to original bounds
        smoothedScale = 0
        liquidGlassView.frame = bounds
    }

    @objc private func updatePositionTracking() {
        let currentTime = CACurrentMediaTime()
        let currentPosition = layer.position

        // 只在位置真的变化时记一个样本：displayLink 按屏幕刷新率回调（ProMotion 最高
        // 120Hz），而药丸中心只在跟手（followX 到达，JS 帧率且不均匀）或弹簧动画推进时
        // 才变化。逐帧无条件记账会让「位置没变」的帧算出 velocity = 0、紧接着位置跳变的
        // 帧算出巨大 velocity；这个 0 / 巨大 交替的序列做二阶差分（加速度）会被无限放大，
        // 再乘 coefficient 后恒定撞上 ±maxScaleDeviation 的钳位，于是缩放量逐帧在
        // +0.3 / -0.3 之间翻转 —— 透镜以屏幕刷新率反复胀缩，就是肉眼看到的剧烈抖动。
        // 跳过硬采样点后，dt 恢复成「两次真实位移之间的时间」，速度/加速度才有物理意义。
        if positionHistory.last?.position != currentPosition {
            positionHistory.append((position: currentPosition, timestamp: currentTime))
        }

        // 时间窗裁剪每个 tick 都要做（包括没有新样本的 tick）：手指停住后若旧样本一直
        // 留在表里，加速度会是一个非零常量，透镜会被永久定格在变形尺寸上不回正。
        let cutoffTime = currentTime - accelerationWindowDuration
        if positionHistory.first.map({ $0.timestamp < cutoffTime }) ?? false {
            positionHistory.removeAll { $0.timestamp < cutoffTime }
        }

        // Calculate average acceleration and apply size change
        let acceleration = calculateAverageAcceleration()
        applyAccelerationSize(acceleration)
    }

    /// Calculates the average acceleration over the position history.
    /// Returns a combined value where positive = accelerating right/up, negative = accelerating left/down.
    private func calculateAverageAcceleration() -> CGFloat {
        guard positionHistory.count >= 3 else { return 0 }

        // Calculate velocities between consecutive position samples
        var velocities: [(velocity: CGPoint, timestamp: TimeInterval)] = []
        for i in 1..<positionHistory.count {
            let prev = positionHistory[i - 1]
            let curr = positionHistory[i]
            let dt = curr.timestamp - prev.timestamp
            guard dt > 0 else { continue }
            let velocity = CGPoint(
                x: (curr.position.x - prev.position.x) / dt,
                y: (curr.position.y - prev.position.y) / dt
            )
            let midTime = (prev.timestamp + curr.timestamp) / 2
            velocities.append((velocity: velocity, timestamp: midTime))
        }

        guard velocities.count >= 2 else { return 0 }

        // Calculate accelerations between consecutive velocity samples
        var totalAccelerationX: CGFloat = 0
        var count: CGFloat = 0

        for i in 1..<velocities.count {
            let prev = velocities[i - 1]
            let curr = velocities[i]
            let dt = curr.timestamp - prev.timestamp
            guard dt > 0 else { continue }
            totalAccelerationX += (curr.velocity.x - prev.velocity.x) / dt
            count += 1
        }

        guard count > 0 else { return 0 }

        // 只取 X。透镜在 tab 栏里是纯水平跟手：宿主（LGLiquidLensHostView.layoutSubviews）
        // 每帧把 _lens.center.y 钉死在 bounds.height/2，Y 方向不存在真实位移，layer.position.y
        // 的变化只来自浮点误差/重布局的亚像素差。对它做二阶差分得到的是除以 dt² 的噪声，
        // 量级足以污染合成值（原式 avgX - avgY）—— 这正是抖动里那部分「无中生有」的激励。
        // 上游把 Y 解释为「向上加速度」，但那是给可垂直拖拽的通用透镜写的，本宿主不存在该自由度。
        return totalAccelerationX / count
    }

    /// Applies squash/stretch size change to liquidGlassView based on acceleration.
    private func applyAccelerationSize(_ acceleration: CGFloat) {
        let scaleFactor = acceleration * accelerationScaleCoefficient

        // Clamp to reasonable range for visual stability
        let clampedScale = max(-maxScaleDeviation, min(maxScaleDeviation, scaleFactor))

        // 低通：把钳位后的目标值按指数平滑逼近期望值，而不是逐帧直接写进 frame。
        // 加速度的原始信号在 ProMotion（120Hz 采样）上仍带残余尖峰，直接驱动 frame 就是
        // 每帧 ±0.3 的胀缩抖动；平滑后单帧位移被限制在目标的 18%，视觉上是一次连续过渡
        // 而非高频振荡（0.18 在 120Hz 下一帧即走完近两成，跟手性没有可感知损失）。
        smoothedScale += (clampedScale - smoothedScale) * scaleSmoothingFactor

        // Apply opposite scale to width and height to create squash/stretch effect
        // Positive acceleration → stretch width, squash height
        // Negative acceleration → squash width, stretch height
        let scaleX = 1 + smoothedScale
        let scaleY = 1 - smoothedScale

        // 取整：透镜的 Metal 背景捕获与 shader 采样都以这个 frame 为画布，非整数尺寸/原点
        // 会让采样栅格落在半像素上，边缘出现暗色接缝——也就是用户看到的「椭圆内部的黑色
        // 线条」。拉伸是连续的，取整产生的 ≤0.5pt 量化误差不可见。
        let newWidth = (bounds.width * scaleX).rounded()
        let newHeight = (bounds.height * scaleY).rounded()

        // Center the new frame within bounds
        liquidGlassView.frame = CGRect(
            x: ((bounds.width - newWidth) / 2).rounded(),
            y: ((bounds.height - newHeight) / 2).rounded(),
            width: newWidth,
            height: newHeight
        )
    }
}

@MainActor @objc public protocol AnyLiquidLensView {
    init()
    init(restingBackground backgroundView: UIView?)
    var restingBackgroundColor: UIColor? { get set }
    func setLiftedContainerView(_ containerView: UIView?)
    func setLiftedContentView(_ contentView: UIView?)
    func setOverridePunchoutView(_ punchoutView: UIView?)
    func setLifted(_ lifted: Bool, animated: Bool, alongsideAnimations: (() -> Void)?, completion: ((Bool) -> Void)?)
    func setLiftedContentMode(_ contentMode: Int)
    func setStyle(_ style: Int)
    func setWarpsContentBelow(_ warpsContentBelow: Bool)
}

public typealias UILiquidLensView = UIView & AnyLiquidLensView

/// Vendored addition: ObjC-visible construction entry. Swift initializers on UIView
/// subclasses are not exposed to ObjC without @objc, and `init()` mapping is unreliable
/// across toolchains — the RN view manager creates the lens through this factory.
@objc public final class LGLensFactory: NSObject {

    /// UIView 初始化是 MainActor 隔离的；RN 的 view 创建固定发生在主线程。
    /// 恒返回自研液态透镜（LiquidGlassView(.lens) 引擎）——与上游一致：上游
    /// LiquidLensView 本身就是对系统私有 _UILiquidLensView 的自研复刻，从不调用
    /// 该私有类。曾试验过 iOS 26+ 直接实例化系统私有类，已废弃：私有类不响应
    /// 我们的方法面（setTargetX/setLifted 等是上游自研 API 的名字，非系统
    /// selector——class_addProtocol 只挂声明不给实现），宿主直调必然
    /// unrecognized selector 闪退；且其圆角/形状由系统内部决定，无法与宿主
    /// tab 栏圆角对齐。
    @objc @MainActor public static func createLens() -> UIView {
        return LiquidLensView()
    }
}
