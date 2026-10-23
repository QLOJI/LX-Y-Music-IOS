//
//  LiquidGlassEffectView.swift
//  LiquidGlass (vendored from DnV1eX/LiquidGlassKit)
//
//  Created by Alexey Demin on 2025-12-23.
//  Vendored modifications for LX Music CocoaPods static-lib build (CI: Xcode 15.4 / iOS 17.5 SDK):
//  1. iOS 26-only `UIGlassEffect` / `UIGlassContainerEffect` types removed — they do not exist
//     in the CI SDK, and type references fail to compile regardless of runtime availability
//     checks. The custom Metal implementation covers iOS 26+ as well (capture switches to the
//     public-API root-view scheme automatically on iOS 26.2+). Native UIGlassEffect can be
//     reintroduced behind `#if compiler(>=6.2)` once CI moves to Xcode 26.
//  2. Added `@objc convenience init()` plus tint/opacity/dark/touch/capture-exclusion
//     bridging methods for the React Native view manager (LiquidGlassViewManager.mm).
//     Rendering behavior is upstream-identical: continuous MTKView rendering with
//     per-frame background capture — no on-demand/power-saving layer (an earlier local
//     one was removed to stay faithful to upstream, per user decision 2026-09-28).
//  3. The effect view is the default capture-exclusion root of its LiquidGlassView:
//     during background capture the WHOLE widget (glass + contentView content) is
//     hidden, so foreground content inside the widget is never refracted into the
//     glass. NOTE (real-device fix, iOS 26.2+): in this app the RN host view is a
//     LEAF (glass backing only) and the foreground content (icons/labels/buttons)
//     are SIBLINGS in the JS parent container — so the manager resolves the
//     exclusion root to the HOST'S SUPERVIEW on mount (see LiquidGlassViewManager.mm
//     didMoveToSuperview); a root pointing at the host alone leaks the foreground
//     into the capture (ghosted/double content in the screenshot).
//     RN hosts can still redirect it via setCaptureExclusionView:.
//  4. Freeze-time settle hook（第 66 轮第 1 条）: `setPaused(true)` first runs the
//     app-registered will-freeze handler (LXGlassFreezeHook.h — the app lands a still
//     decelerating list on its predicted rest offset) and then `handlePauseForFreeze()`
//     re-captures + redraws once, so the frozen frame equals the frame shown after the
//     return transition (no stale-frame flash). Handler absent ⇒ upstream behaviour.
//  Upstream: Copyright © 2025 DnV1eX, https://github.com/DnV1eX/LiquidGlassKit
//

import UIKit

public class LiquidGlassEffectView: UIView, AnyVisualEffectView {

    public let contentView = UIView()
    public var effect: UIVisualEffect?

    var liquidGlassView: LiquidGlassView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let liquidGlassView {
                insertSubview(liquidGlassView, belowSubview: contentView)
            }
        }
    }

    /// RN bridge entry: creates the view with the `.regular` glass preset（磨砂液态玻璃）.
    @objc public convenience init() {
        self.init(effect: LiquidGlassEffect(style: .regular, isNative: false))
    }

    public required init(effect: LiquidGlassEffect) {
        self.effect = effect

        super.init(frame: .zero)

        let liquidGlassView = LiquidGlassView(effect.style.liquidGlass)
        addSubview(liquidGlassView)
        self.liquidGlassView = liquidGlassView
        // 默认捕获排除根 = 效果视图自身：截背景时整个玻璃组件（MTK 输出 + contentView
        // 内容）一起隐藏，前景内容永远不会被折射进玻璃（真机黑影的来源之一）。
        liquidGlassView.captureExclusionView = self

        setupContentView()
    }

    public required init(effect: LiquidGlassContainerEffect) {
        self.effect = effect

        super.init(frame: .zero)

        setupContentView()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setupContentView() {
        addSubview(contentView)
        contentView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            contentView.topAnchor.constraint(equalTo: topAnchor),
            contentView.bottomAnchor.constraint(equalTo: bottomAnchor),
            contentView.leadingAnchor.constraint(equalTo: leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: trailingAnchor)
        ])
    }

    public override func layoutSubviews() {
        super.layoutSubviews()

        liquidGlassView?.frame = contentView.frame
        liquidGlassView?.layer.cornerRadius = layer.cornerRadius
        liquidGlassView?.layer.cornerCurve = layer.cornerCurve
    }

    /// RN bridge entry: forward tint changes into the immutable glass preset.
    @objc public func setGlassTintColor(_ color: UIColor?) {
        // 不能写成 liquidGlassView?.liquidGlass.tintColor = color：
        // Swift 不允许经可选链给「struct 成员」赋值（链式临时值不可写），
        // 须先解包引用，再改 let 持有的 struct 的 var 成员
        if let liquidGlassView {
            liquidGlassView.liquidGlass.tintColor = color
        }
    }

    /// RN bridge entry: 截背景时要隐藏的「玻璃组件根」（默认 = 效果视图自身）。RN 宿主
    /// 把前景内容（图标/按钮）挂在宿主视图上而非 contentView，须重定向到宿主才能把
    /// 前景一并排除在背景捕获之外（否则折射成图标形状的黑影，iOS 26.2+/27 真机实测）。
    @objc public func setCaptureExclusionView(_ view: UIView?) {
        liquidGlassView?.captureExclusionView = view
    }

    /// RN bridge entry: pause/resume the Metal render loop (`MTKView.isPaused`).
    /// Power-saving gate (2026-09-30): the JS side sets paused=true while the glass
    /// widget is fully covered by a pushed screen — the widget cannot be seen then,
    /// so pausing the per-frame draw has no visible effect; resume is immediate and
    /// the next draw re-captures the backdrop (no stale frame). Only the vendored
    /// Metal band carries a render loop; the frosted backing has no such selector
    /// and the manager skips it via respondsToSelector.
    ///
    /// 覆盖冻结档的当前值（RN prop `paused`）。与下面的 hiddenPaused 合成
    /// `MTKView.isPaused`：两档任一为真就停渲染，但**只有这一档**会触发冻结那两步。
    private var freezePaused = false

    /// 可见性档的当前值（RN prop `hiddenPaused`，【第 72 轮】）。玻璃只是**自己不可见**
    /// （Tab 栏收起/展开时另一块玻璃完全不可见）时置 true。
    private var hiddenPaused = false

    /// 【第 61 轮第 3 条】这条 prop 现在是暂停态的**唯一**来源（原来的覆盖期 ∨ 转场按住期，
    /// 见 navigation/transitionWindow.ts）：第 58～60 轮 LiquidGlassView 还会在重新入窗口时
    /// 无视本值自行恢复渲染（pauseRequested 那条通道），已整体删除——它正是「返回时透过的
    /// 画面反向流」的成因。本方法负责三件事：冻结前定格一帧（【第 66 轮第 1 条】）、恢复时
    /// 做一次性复位，然后把 isPaused 落下去。
    ///
    /// 【第 72 轮】本方法只承载**覆盖冻结档**（玻璃被压栈页完全覆盖 / 转场按住 / App 退后台）：
    /// 这一档的暂停是要付代价的 —— 冻结时那两步会「让 App 把还会自己动一下的内容贴到落点 +
    /// 重采定格帧」，而它们只在「冻结前后用户看到的是同一块画面」时成立。玻璃**自己不透明地
    /// 藏起来**（收起/展开时另一块玻璃不可见）是另一档语义，走 setHiddenPaused，绝不触发定格。
    /// 两档合并（旧形态：paused 里或上 collapsed）的后果 = 列表每次滚过收起门限、或每次展开
    /// 都会把正在惯性滑行的列表贴到预测落点，惯性被当场掐断 —— 用户第 72 轮原话：
    /// 「还原上下滑动速度，现在配置后，存在滑动跳动，使用体验很差」。
    @objc public func setPaused(_ paused: Bool) {
        freezePaused = paused
        // 恢复（true → false）时先做一次性复位再解除暂停（2026-10-02 用户第 2 条）：
        // 暂停只是停 draw，CAMetalLayer 上仍留着暂停前那帧（折射的是上一次可见时刻的
        // 背景）。不复位的话，恢复后第一次采景若被判「未就绪」就会把那一帧原样画出去
        // ——用户看到的「返回主界面时玻璃里先是旧画面、过一会儿才跳回当前画面」。
        // 判定「此前确实处于暂停态」用 isPaused 本身：首挂载/背衬重建时 isPaused 已是
        // false，此时不需要也没有旧画面可丢（否则会白白多做一次同步采景）。
        // 【第 142 轮】覆盖冻结档恢复：先用模型根视图采第一帧（不依赖 window server 上一次
        // 提交），恢复后的加载 / 布局变化再由 live 接手。只给这一档（返回 / push 露出 /
        // 从无玻璃页回来）；可见性档恢复不加这一步。
        if !paused { liquidGlassView?.prepareRootCaptureOnResume() }
        if !paused, liquidGlassView?.isPaused == true {
            liquidGlassView?.handleResumeFromPause()
        }
        // 冻结（false → true）前【第 66 轮第 1 条】用户原话：「迷你播放器栏和底部 tab 栏透过
        // 的画面，例如正在向下滑动当前列表，然后突然点击进入播放详情页……返回时，向下滑动的
        // 列表还会向下移动一点距离……造成短暂的显示错误并闪一下。」
        // 顺序不能反，两步都在 isPaused = true **之前**：
        //   ① LXGlassNotifyWillFreeze：让 App 把「冻结之后还会自己动一下」的内容落到它将要
        //      停的位置（本工程 = 惯性滑行的 Home 列表贴到预测落点，见 AppDelegate.mm 的
        //      LXGlassSettleDeceleratingScrollView）。没人注册时它什么都不做。
        //   ② handlePauseForFreeze：重采「贴完之后」的画面并立刻 present —— 冻结帧于是
        //      等于返回后第一帧的画面，用户看不到新旧两帧的差（闪一下消失）。
        // 幂等：重复置 true（RN 重放缓存 prop / 液态开关导致背衬重建）不再触发；
        // 漏掉 ② 的话 App 侧那一贴会把冻结帧与新画面拉得更开，画面只会更花。
        // 【第 72 轮】判据是 isPaused 本身（= 两档的合成）：可见性档已经把这块玻璃停住时，
        // 覆盖冻结档再翻过来不必重复定格 —— 那一步正是「列表被掐停」的来源，而这块玻璃
        // 此刻根本不可见，定格帧没有意义（重新可见时 setHiddenPaused 会做一次性复位重采）。
        if paused, liquidGlassView?.isPaused == false {
            _ = LXGlassNotifyWillFreeze()
            liquidGlassView?.handlePauseForFreeze()
        }
        // 两档合成：可见性档为真时，覆盖冻结档解除（回到前台 / 转场结束 / 回到 Home）
        // 不得把这块不可见的玻璃又叫醒逐帧渲染（那是纯白烧的电，第 70 轮第 3 条的发热面）。
        liquidGlassView?.isPaused = paused || hiddenPaused
    }

    /// RN bridge entry（RN prop `hiddenPaused`）: power-saving gate for the **visibility**
    /// axis（【第 72 轮】），与 setPaused 的覆盖冻结档分开。
    ///
    /// 为什么必须分开：本工程唯一注册了 LXGlassNotifyWillFreeze 的消费方是 App 侧，它会把
    /// 正在惯性滑行的 Home 列表**贴到预测落点**（LXGlassSettleDeceleratingScrollView）——
    /// 这是为「冻结帧要和返回后第一帧重合」服务的。而 Tab 栏的收起/展开是**列表滚动顺手**
    /// 触发的（滚过收起门限就翻一次），把它并进 paused 就等于：用户每滚一次，列表惯性被
    /// 贴落点当场掐断一次，观感是「上下滑动跳动、速度被改动」。可见性档只做一件事：停渲染。
    /// 冻结那两步（通知 App 贴落点 + 重采定格帧）在本方法里**一次都不许出现** —— 契约
    /// scripts/sim-r66-glass-freeze-settle.js 正反两侧都钉住这一条。
    @objc public func setHiddenPaused(_ paused: Bool) {
        if hiddenPaused == paused { return }
        hiddenPaused = paused
        // 重新可见（true → false）时做与 setPaused 恢复路径相同的**一次性复位**：
        // 隐藏期间玻璃可能停了几十秒（收起态是长时间驻留状态），缓存纹理与沿用痕迹
        // 早已过期，不复位就是「露出来第一眼是旧画面、过一会儿才跳回当前画面」。
        // 条件是「确实由本档停着」（freezePaused == false）且此前真的处于暂停态；
        // 覆盖冻结档也停着的时候（freezePaused == true）交给 setPaused 的恢复分支。
        if !paused, freezePaused == false { liquidGlassView?.cancelRootCaptureOnResume() }
        if !paused, freezePaused == false, liquidGlassView?.isPaused == true {
            liquidGlassView?.handleResumeFromPause()
        }
        liquidGlassView?.isPaused = freezePaused || paused
    }

    /// RN bridge entry: realtime capture session (RN prop `live`), see
    /// LiquidGlassView.setRealtimeCapture(_:). 横向滑动 PagerView 的手势会话期间
    /// 由 JS 置 true：采景从静止态基线 30fps 放宽到 60fps，渲染档随之同步到
    /// 60fps（第 20 轮起两档同速，见 syncRenderFrameRate），
    /// 解决「滑动时透过的画面延迟高、掉帧、像反向切入」。同一口径已被抬起的透镜
    /// （LiquidLensView → beginLiveCapture）使用。仅 Metal 液态档实现该 selector，
    /// 磨砂档由 manager 的 respondsToSelector 分流为 no-op。
    @objc public func setRealtimeCapture(_ realtime: Bool) {
        liquidGlassView?.setRealtimeCapture(realtime)
    }

    /// RN bridge entry: 手指位置驱动的眩光（玻璃坐标系）；越界/停止时调 clearTouchPoint 清除
    @objc public func setTouchPoint(_ point: CGPoint) {
        liquidGlassView?.touchPoint = point
    }

    @objc public func clearTouchPoint() {
        liquidGlassView?.touchPoint = nil
    }
}

/// A visual effect that renders a glass material.
public class LiquidGlassEffect: UIVisualEffect {

    public enum Style {
        case regular, clear

        var liquidGlass: LiquidGlass {
            switch self {
            case .regular: .regular
            case .clear: .clear
            }
        }
    }
    let style: Style

    let isNative: Bool

    /// Enables interactive behavior for the glass effect.
    public var isInteractive = false

    /// A tint color applied to the glass.
    public var tintColor: UIColor?

    /// Creates a glass effect with the specified style.
    /// - Parameters:
    ///   - style: The glass effect style.
    ///   - isNative: No-op in the vendored build (native `UIGlassEffect` removed, see header).
    public init(style: Style, isNative: Bool = true) {
        self.style = style
        self.isNative = isNative
        super.init()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// A `LiquidGlassContainerEffect` renders multiple glass elements into a combined effect.
///
/// When using `LiquidGlassContainerEffect` with a `VisualEffectView` you can
/// add individual glass elements to the visual effect view's contentView by nesting `VisualEffectView`'s
/// configured with `LiquidGlassEffect`. In that configuration, the glass container will render all glass elements
/// in one combined view, behind the visual effect view's `contentView`.
public class LiquidGlassContainerEffect: UIVisualEffect {

    let isNative: Bool

    /// The spacing specifies the distance between elements at which they begin to merge.
    public var spacing = 10.0

    /// Creates a combined glass effect.
    /// - Parameters:
    ///   - isNative: No-op in the vendored build (native `UIGlassContainerEffect` removed, see header).
    public init(isNative: Bool = true) {
        self.isNative = isNative
        super.init()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

public protocol AnyVisualEffectView: UIView {
    var contentView: UIView { get }
    var effect: UIVisualEffect? { get set }
}

extension UIVisualEffectView: AnyVisualEffectView { }

public func VisualEffectView(effect: UIVisualEffect?) -> AnyVisualEffectView {
    if effect is LiquidGlassEffect {
        // Native `UIGlassEffect` path (iOS 26+) removed in the vendored build — see header.
        return LiquidGlassEffectView(effect: effect as! LiquidGlassEffect)
    } else if effect is LiquidGlassContainerEffect {
        // Native `UIGlassContainerEffect` path (iOS 26+) removed in the vendored build — see header.
        return LiquidGlassEffectView(effect: effect as! LiquidGlassContainerEffect)
    } else {
        return UIVisualEffectView(effect: effect)
    }
}
