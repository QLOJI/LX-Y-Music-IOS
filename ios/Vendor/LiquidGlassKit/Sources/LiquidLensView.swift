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

    // MARK: - Deformation Constants（2026-10-01 由「加速度驱动」改为「速度驱动」）

    // 历史：上游用**加速度**（位置的二阶差分）驱动挤压/拉伸。在本宿主里它是错的：
    //   · 二阶差分对采样抖动极其敏感 —— 位置样本本身带亚像素抖动/丢帧，除以 dt² 后
    //     量级被放大到恒定撞上 ±maxScaleDeviation 钳位，逐帧在「拉长/压扁」之间翻转，
    //     就是用户报的「抖动太厉害」「一会儿圆一会儿扁」；
    //   · 加速度在弹簧/减速过程里会**反号**：同样的移动先拉长再压扁，形状来回摆，
    //     不符合用户给的运动规则；
    //   · 点击切页走 UIView 弹簧，模型值在动画开始就已到终点（见 updatePositionTracking
    //     的 presentation 采样说明），二阶差分几乎恒为 0 —— 那条路径要么不形变、
    //     要么被一次「模型值瞬移」喂出一个巨大假加速度。
    // 现在按用户指定的规则改：**滑动快就扁、速度慢就正常**（速度大小单调驱动，
    // 不反号，静止时回正）。以下常量按「pt/s」标定。

    /// 位置样本窗口：只保留最近这段时间内的样本（秒）。窗口外的样本没有速度意义。
    private let sampleWindowDuration: TimeInterval = 0.12

    /// 速度 → 形变量系数（每 1pt/s 的形变量）。
    /// 标定：150pt/s 以下不动（慢滑＝正常）；约 1600pt/s 触顶 maxScaleDeviation（快滑＝扁）。
    private let speedScaleCoefficient: CGFloat = 0.00013

    /// 静止阈值（pt/s）：低于它完全不形变 —— 用户规则「速度慢就正常」。
    private let idleSpeedThreshold: CGFloat = 150

    /// 最大形变量（±）。比上游 0.3 保守：本宿主的药丸是**整槽宽**（≈屏宽/5），
    /// 0.3 会让它横向溢出到相邻槽、纵向压掉三成高度，观感是「一坨」而不是「一片」。
    private let maxScaleDeviation: CGFloat = 0.18

    /// 形变目标的低通系数（指数平滑，见 applySpeedSize）。速度是从离散位置样本里
    /// 差分出来的，天然带尖峰；即使做了跳变剔除，直接写进 frame 仍是 120Hz 的
    /// 高频胀缩。0.18 在 ProMotion 上仍是即时跟手的手感，但把逐帧抖动压成一次平滑过渡。
    private let scaleSmoothingFactor: CGFloat = 0.18

    /// 单帧位移超过这个值（pt）判定为**跳变**，不是手指的真实运动：宿主重布局把
    /// `_lens.frame` 复位、点击弹簧把模型值一次性写到终点、跟手大跳都会产生这种样本。
    /// 喂给速度估计只会得到荒谬的巨大速度（形变瞬间打死到最大），故整段历史作废重开。
    /// 真实快滑的量级参考：120Hz 下 2000pt/s ≈ 16.7pt/帧，远小于本阈值。
    private let teleportDistance: CGFloat = 48

    /// 相邻样本的最大时间间隔（秒）：超过就不构成有效速度对（丢帧/停顿后不跨段求速度）。
    private let maxSampleGap: TimeInterval = 0.1      // JS 线程卡顿（跟手帧间隔变大）容差

    /// 速度样本的新鲜度（秒）：最后一个样本比这还旧，说明药丸已经停住 —— 速度按 0 处理，
    /// 形变回正（否则会永久定格在最后一次的形变尺寸上）。
    private let sampleFreshness: TimeInterval = 0.05

    /// 低通状态：当前实际生效的缩放量（0 = 未变形，恒 ≥ 0）。
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

    /// 采景基准尺寸覆盖（Vendored addition，第 38 轮）：`.zero`（默认）= 不覆盖，
    /// 采景基准回落为透镜自身 bounds（与第 26 轮以来的行为完全一致，收缩/拉伸
    /// 那套速度形变继续走这条路）。
    ///
    /// 为什么需要：「长按水珠」的放大/收缩是**模型尺寸逐帧插值**（宿主
    /// LiquidGlassViewManager.mm 的 CADisplayLink 弹簧），透镜 bounds 从药丸
    /// (t_x × h) 一路变到正圆 (side × side)。若采景基准跟着 bounds 走，每帧都得
    /// 改一次 CABackdropLayer 的尺寸 ⇒ 整幅重新向 window server 要 backdrop，
    /// 120Hz 下合成追不上，drawHierarchy 读到半张没合成的黑条被折射进玻璃
    /// （就是 captureReferenceSize 注释里那条「黑色线条 / 半张黑条」红线的成因）。
    ///
    /// 宿主因此在变形期间把基准锁成「药丸与正圆的外接矩形」（两个尺寸都随进度
    /// 单调插值 ⇒ 外接矩形在整个变形过程中恒定），回落为药丸后立刻推 `.zero`
    /// 交还给 bounds。采景矩形是**以透镜中心为中心**、按基准尺寸外扩的（见
    /// LiquidGlassView.captureBackdrop 的 captureOrigin 计算），给一个比 bounds 大
    /// 的基准只是让采景框对称地多盖一圈背景，画面上不可见。
    private var captureReferenceOverride: CGSize = .zero

    @objc public func setLensCaptureReferenceSize(_ size: CGSize) {
        guard captureReferenceOverride != size else { return }
        captureReferenceOverride = size
        // 抬起态：立即重申一次基准（不等下一次 layout —— 宿主推这个值的时机正是
        // 变形起点/终点，慢一帧就等于让采景矩形在变形首帧变一次尺寸）。
        applyCaptureReferenceIfLifted()
        setNeedsLayout()
    }

    /// 当前生效的采景基准：覆盖值有效（宽高都 > 1，与 LiquidGlassView.captureBaseSize
    /// 的有效性判据同口径）就用覆盖值，否则回落 bounds.size。
    private var effectiveCaptureReference: CGSize {
        let override = captureReferenceOverride
        if override.width > 1, override.height > 1 { return override }
        return bounds.size
    }

    /// 抬起态下把基准与圆角重申给玻璃层（layoutSubviews 与本 setter 共用一份）。
    private func applyCaptureReferenceIfLifted() {
        guard isLifted else { return }
        liquidGlassView.captureReferenceSize = effectiveCaptureReference
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
            // 第 38 轮起：水珠变形期间宿主会推来一个「外接矩形」覆盖值（见
            // captureReferenceOverride），此时基准恒等于外接矩形，采景矩形连尺寸
            // 都不用改（更谈不上重合成）。
            liquidGlassView.captureReferenceSize = effectiveCaptureReference
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
        // 第 38 轮：水珠变形期间取宿主推来的外接矩形覆盖值（见 captureReferenceOverride）。
        liquidGlassView.captureReferenceSize = effectiveCaptureReference
        // 抬起/跟手期间背景每帧都在变：丢掉上一次抬起留下的背景纹理（那是上次点击
        // 位置的页面内容），并把刷新率拉满；落下后由 endLiveCapture 交回自适应帧率。
        liquidGlassView.beginLiveCapture()

        // Start position tracking for speed-based squash/stretch
        // （2026-10-01：由加速度驱动改为速度驱动，见下方 Deformation Constants 的说明）
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

    // MARK: - Position Tracking & Speed Deformation

    private func startPositionTracking() {
        positionHistory.removeAll()
        smoothedScale = 0
        // 先记一个种子样本：displayLink 首帧到达之前**已经发生**的位移（抬起透镜本身
        // 带 0.4s 弹簧，期间位置可能在动）才有参照点，第一帧就能算出速度。
        positionHistory.append((position: currentSampledPosition(), timestamp: CACurrentMediaTime()))
        displayLink = CADisplayLink(target: self, selector: #selector(updatePositionTracking))
        displayLink?.add(to: .main, forMode: .common)
    }

    /// 采样位置：动画在途时取**呈现值**。
    /// `layer.position` 是模型值 —— UIView 弹簧动画一开始模型值就已经写到终点了，
    /// 读模型值等于「看不到运动」：点击切页那条路径要么完全不形变，要么被一次模型值
    /// 瞬移喂出一个巨大假速度。presentation() 反映当前屏幕上的真实位置，弹簧、减速、
    /// 跟手三种运动都能被正确采样。图层尚未提交渲染时 presentation() 为 nil，回退模型值。
    private func currentSampledPosition() -> CGPoint {
        return layer.presentation()?.position ?? layer.position
    }

    private func stopPositionTracking() {
        displayLink?.invalidate()
        displayLink = nil
        positionHistory.removeAll()
        // Reset liquid glass view to original bounds
        smoothedScale = 0
        liquidGlassView.frame = bounds
        // 形变量归零的同时把圆角也复原：回落是 0.5s 的淡出，若留着一个「按压扁尺寸
        // 收敛过的圆角」，淡出期间的胶囊端头会偏方（shader 圆角不做钳制）。
        let halfShortSide = min(bounds.width, bounds.height) / 2
        liquidGlassView.layer.cornerRadius = cornerRadiusOverride >= 0
            ? min(cornerRadiusOverride, halfShortSide)
            : halfShortSide
    }

    @objc private func updatePositionTracking() {
        let currentTime = CACurrentMediaTime()
        let currentPosition = currentSampledPosition()

        // 只在位置真的变化时记一个样本：displayLink 按屏幕刷新率回调（ProMotion 最高
        // 120Hz），而药丸中心只在跟手（followX 到达，JS 帧率且不均匀）或弹簧动画推进时
        // 才变化。逐帧无条件记账会让「位置没变」的帧算出速度 = 0、紧接着位置跳变的帧
        // 算出巨大速度；这个 0 / 巨大 交替的序列做差分会被无限放大。跳过硬采样点后，
        // dt 恢复成「两次真实位移之间的时间」，速度才有物理意义。
        if let last = positionHistory.last {
            if currentPosition != last.position {
                let dt = currentTime - last.timestamp
                let dx = abs(currentPosition.x - last.position.x)
                if dt > 0, dt <= maxSampleGap, dx <= teleportDistance {
                    positionHistory.append((position: currentPosition, timestamp: currentTime))
                } else {
                    // 跳变 / 断片：宿主重布局复位 _lens.frame、点击弹簧的模型值瞬移、
                    // 手势被系统抢占后的位置突跳都会产生这种样本 —— 它们不是手指运动，
                    // 喂给速度估计只会得到荒谬的巨大速度（形变瞬间打死到最大），
                    // 也就是用户看到的「抽搐」。整段作废重开，等下一个真实位移。
                    positionHistory.removeAll()
                    positionHistory.append((position: currentPosition, timestamp: currentTime))
                }
            }
        } else {
            positionHistory.append((position: currentPosition, timestamp: currentTime))
        }

        // 时间窗裁剪每个 tick 都要做（包括没有新样本的 tick）：手指停住后若旧样本一直
        // 留在表里，速度会是一个非零常量，透镜会被永久定格在变形尺寸上不回正。
        let cutoffTime = currentTime - sampleWindowDuration
        if positionHistory.first.map({ $0.timestamp < cutoffTime }) ?? false {
            positionHistory.removeAll { $0.timestamp < cutoffTime }
        }

        applySpeedSize(currentSpeed(at: currentTime))
    }

    /// 最近一次真实位移的速度（pt/s，带符号，X 方向）。
    /// 只取最近两个样本：一个样本对就是一次真实位移（跳变/超时/断片样本已在上面剔除），
    /// 不需要也不该做二阶差分 —— 那正是「一会儿圆一会儿扁 + 抖动」的来源。
    private func currentSpeed(at time: TimeInterval) -> CGFloat {
        guard positionHistory.count >= 2 else { return 0 }
        let curr = positionHistory[positionHistory.count - 1]
        let prev = positionHistory[positionHistory.count - 2]
        // 最后一个样本已经过期（手指停住 / 手势结束）：视为静止 → 形变回正。
        guard time - curr.timestamp <= sampleFreshness else { return 0 }
        let dt = curr.timestamp - prev.timestamp
        guard dt > 0 else { return 0 }
        return (curr.position.x - prev.position.x) / dt
    }

    /// 速度驱动形变（用户规则：滑动快就扁，速度慢就正常）。
    /// 形变量恒 ≥ 0 —— 横向拉长 / 纵向压扁只有一种符号，运动过程中不会来回翻转；
    /// 低于静止阈值不形变，静止后低通把形变平滑收回 0。
    private func applySpeedSize(_ speed: CGFloat) {
        let magnitude = abs(speed)
        let scaleFactor = (magnitude - idleSpeedThreshold) * speedScaleCoefficient
        let target = max(0, min(maxScaleDeviation, scaleFactor))

        // 低通：把目标值按指数平滑逼近期望值，而不是逐帧直接写进 frame。
        // 速度信号在 ProMotion（120Hz 采样）上仍带残余尖峰，直接驱动 frame 就是每帧
        // 胀缩抖动；平滑后单帧位移被限制在目标的 18%，视觉上是一次连续过渡而非高频
        // 振荡（0.18 在 120Hz 下一帧即走完近两成，跟手性没有可感知损失）。
        smoothedScale += (target - smoothedScale) * scaleSmoothingFactor

        // Apply opposite scale to width and height to create squash/stretch effect
        // 速度越大 → 沿运动方向横向拉长、纵向压扁（形状只有这一种，不反号）
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

        // 圆角必须跟着压扁后的短边一起收敛：宿主推来的是静止尺寸下的圆角（高 56 → 28），
        // 压扁到 0.82 倍后高只剩 ~46，28 > 46/2 —— 自研 shader 的圆角 SDF 不做钳制
        // （见 LiquidGlassViewManager.mm 的说明），会把透镜画成近矩形而不是胶囊。
        let halfShortSide = min(newWidth, newHeight) / 2
        let radius = cornerRadiusOverride >= 0 ? min(cornerRadiusOverride, halfShortSide) : halfShortSide
        if abs(liquidGlassView.layer.cornerRadius - radius) > 0.5 {
            liquidGlassView.layer.cornerRadius = radius
        }
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
