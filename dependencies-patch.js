// Patch dependency sources after install when upstream packages need local integration fixes.

const fs = require('node:fs')
const path = require('node:path')

const rootPath = __dirname
const equalizerAudioMixSwiftSource = fs.readFileSync(path.join(rootPath, 'patches/ios/LXEqualizerAudioMix.swift'), 'utf8')
const sharedIRKernelSource = fs.readFileSync(path.join(rootPath, 'ios/LxMusicMobile/LXSharedIRConvolutionKernel.hpp'), 'utf8')
const sharedIRBridgeHeaderSource = fs.readFileSync(path.join(rootPath, 'patches/ios/LXSharedIRConvolutionBridge.h'), 'utf8')
const sharedIRBridgeSource = fs.readFileSync(path.join(rootPath, 'patches/ios/LXSharedIRConvolutionBridge.mm'), 'utf8')

/**
 * @typedef {{ from: string, to: string }} PatchChange
 * @typedef {{ filePath: string, changes: PatchChange[] }} PatchTarget
 */

/** @type {PatchTarget[]} */
const patchTargets = [
  // react-native-pager-view 6.7.1 的两个原生横滑闩锁修复（2026-10-01，P0）。
  // 症状：推荐/歌单/搜索/我的/设置五页滑不动（或整片页面区连点带滑都失效），
  // 而底部 tab 栏正常、重启才好。根因都在库的 iOS 实现里，且 JS 侧无从感知/修复：
  // ① goTo: 越界早退不恢复 userInteractionEnabled：goTo: 先 disableSwipe
  //    （reactPageViewController.view.userInteractionEnabled = NO）再判断越界，
  //    越界时直接 return —— 交互永久关闭；enableSwipe 只在
  //    setReactViewControllers: 的两处回调里被调用，JS 侧没有任何 API 能改回来。
  // ② scrollView 的横滑开关有两个互相独立的闩锁（scrollEnabled 与
  //    panGestureRecognizer.enabled），shouldScroll: 只写前者，手势回调只写后者，
  //    任一侧被改写/丢弃后 JS 的 scrollEnabled prop 因 prop diff 不再下发，
  //    闩锁就永久停在 NO。
  // 详见 src/screens/Home/Vertical/Main.tsx 中 resyncPagerScroll 与 pagerCell 的注释。
  {
    filePath: 'node_modules/react-native-pager-view/ios/RNCPagerView.m',
    changes: [
      {
        from: `- (void)shouldScroll:(BOOL)scrollEnabled {
    _scrollEnabled = scrollEnabled;
    if (self.reactPageViewController.view) {
        self.scrollView.scrollEnabled = scrollEnabled;
    }
}
`,
        to: `- (void)shouldScroll:(BOOL)scrollEnabled {
    _scrollEnabled = scrollEnabled;
    if (self.reactPageViewController.view) {
        self.scrollView.scrollEnabled = scrollEnabled;
        // LX patch(2026-10-01): panGestureRecognizer.enabled 与 scrollEnabled 是横滑
        // 开关在原生侧的两个独立闩锁（本方法只写前者，手势回调只写后者），任何一侧
        // 卡在 NO 都表现为「五页滑不动，点击与 tab 栏正常」。统一以 JS 下发的
        // scrollEnabled 为准；比较后再写，避免给进行中的手势制造无谓的 enabled 抖动。
        if (self.scrollView.panGestureRecognizer.enabled != scrollEnabled) {
            self.scrollView.panGestureRecognizer.enabled = scrollEnabled;
        }
    }
}
`,
      },
      {
        from: `    if (numberOfPages == 0 || index < 0 || index > numberOfPages - 1) {
        return;
    }
`,
        to: `    if (numberOfPages == 0 || index < 0 || index > numberOfPages - 1) {
        // LX patch(2026-10-01): 上面的 disableSwipe 已经把
        // reactPageViewController.view.userInteractionEnabled 置为 NO，越界时直接
        // return 会让它永久停在 NO——整片页面区连点带滑全部失效，而 JS 侧没有任何
        // API 能修回来（enableSwipe 只在 setReactViewControllers: 的回调里调用）。
        // 越界本身不切页，但必须把交互恢复。
        [self enableSwipe];
        return;
    }
`,
      },
    ],
  },
  // react-native 0.73.11：RCTViewManager 的 pointerEvents 兜底分支缺 break（防复发根治）。
  // 症状同上一条：一旦某个**不响应 setPointerEvents: 的自定义原生宿主**（PagerView 就是，
  // 它的宿主是裸 UIView）收到 pointerEvents 的任意非 nil 值，"auto" / "box-none" /
  // "box-only" 都会被 RCTConvert 映射成 RCTPointerEventsUnspecified，撞穿到
  // RCTPointerEventsNone 分支 → view.userInteractionEnabled = NO → 整块区域连点带滑全死。
  // （RCTView 子类走本方法开头的 early-return，不受影响；所以标准 <View> 上的 pointerEvents
  // 语义一直是对的——这也是为什么本仓把 pointerEvents 挪到普通 View 上能绕过它。）
  // 现在 App 里没有任何 PagerView 传 pointerEvents（六处用法逐一核对过），所以这条
  // **不是当前故障的原因**，是防复发：以后谁手滑把 pointerEvents 挂回宿主也不会致命。
  // 上游 0.84 就是这么修的（补 break）。
  {
    filePath: 'node_modules/react-native/React/Views/RCTViewManager.m',
    changes: [
      {
        from: `      view.userInteractionEnabled = YES;
    case RCTPointerEventsNone:
`,
        to: `      view.userInteractionEnabled = YES;
      // LX patch(2026-10-01): 补上缺失的 break。原文注释说 "auto may override a
      // parent's none"，但缺了 break 就变成 "auto 等于 none"——对自定义原生宿主
      // （PagerView 这类不响应 setPointerEvents: 的视图）整块 UIE=NO，表现为
      // 「页面连点带滑全死、只有 tab 栏能用」。与上游 0.84 的修法一致。
      break;
    case RCTPointerEventsNone:
`,
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift',
    changes: [
      {
        from: `import Foundation
import MediaPlayer
import SwiftAudioEx

@objc(RNTrackPlayer)
public class RNTrackPlayer: RCTEventEmitter {
`,
        to: `import Foundation
import MediaPlayer
import SwiftAudioEx

private let lxTrackPlayerLifecycleNotification = Notification.Name("LXTrackPlayerLifecycle")

@objc(RNTrackPlayer)
public class RNTrackPlayer: RCTEventEmitter {
`,
      },
      {
        from: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()

    // MARK: - Lifecycle Methods
`,
        to: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()

    private func lifecycleStateName(_ state: AVPlayerWrapperState) -> String {
        switch state {
        case .idle: return "idle"
        case .ready: return "ready"
        case .playing: return "playing"
        case .paused: return "paused"
        case .loading: return "loading"
        default: return "unknown"
        }
    }

    private func postLifecycleEvent(_ event: String, state: AVPlayerWrapperState? = nil, position: Double? = nil, rate: Float? = nil, extra: [String: Any] = [:]) {
        var userInfo = extra
        let lifecycleState = state ?? player.playerState
        userInfo["event"] = event
        userInfo["state"] = lifecycleStateName(lifecycleState)
        userInfo["position"] = position ?? player.currentTime
        userInfo["rate"] = rate ?? player.rate
        userInfo["track"] = player.currentIndex

        NotificationCenter.default.post(name: lxTrackPlayerLifecycleNotification, object: self, userInfo: userInfo)
    }

    // MARK: - Lifecycle Methods
`,
      },
      {
        from: `    @objc(destroy)
    public func destroy() {
        print("Destroying player")
        self.player.stop()
        self.player.nowPlayingInfoController.clear()
        try? AVAudioSession.sharedInstance().setActive(false)
        hasInitialized = false
    }
`,
        to: `    @objc(destroy)
    public func destroy() {
        print("Destroying player")
        self.player.stop()
        self.player.nowPlayingInfoController.clear()
        postLifecycleEvent("destroy", state: .idle, position: 0, rate: 0)
        try? AVAudioSession.sharedInstance().setActive(false)
        hasInitialized = false
    }
`,
      },
      {
        from: `    @objc(reset:rejecter:)
    public func reset(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Resetting player.")
        player.stop()
        resolve(NSNull())
        DispatchQueue.main.async {
            UIApplication.shared.endReceivingRemoteControlEvents();
        }
    }
`,
        to: `    @objc(reset:rejecter:)
    public func reset(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Resetting player.")
        player.stop()
        postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)
        resolve(NSNull())
        DispatchQueue.main.async {
            UIApplication.shared.endReceivingRemoteControlEvents();
        }
    }
`,
      },
      {
        from: `    @objc(seekTo:resolver:rejecter:)
    public func seek(to time: Double, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Seeking to \\(time) seconds")
        player.seek(to: time)
        resolve(NSNull())
    }
`,
        to: `    @objc(seekTo:resolver:rejecter:)
    public func seek(to time: Double, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Seeking to \\(time) seconds")
        player.seek(to: time)
        postLifecycleEvent("seek", position: time)
        resolve(NSNull())
    }
`,
      },
      {
        from: `    @objc(stop:rejecter:)
    public func stop(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Stopping playback")
        player.stop()
        resolve(NSNull())
    }
`,
        to: `    @objc(stop:rejecter:)
    public func stop(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Stopping playback")
        player.stop()
        postLifecycleEvent("stop", state: .idle, position: 0, rate: 0)
        resolve(NSNull())
    }
`,
      },
      {
        from: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
    }
`,
        to: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
      },
      {
        from: `    func handleAudioPlayerFailed(error: Error?) {
        sendEvent(withName: "playback-error", body: ["error": error?.localizedDescription])
    }
`,
        to: `    func handleAudioPlayerFailed(error: Error?) {
        sendEvent(withName: "playback-error", body: ["error": error?.localizedDescription])
        postLifecycleEvent("error", extra: ["error": error?.localizedDescription ?? ""])
    }
`,
      },
      {
        from: `        var capabilitiesStr = options["capabilities"] as? [String] ?? []
        if (capabilitiesStr.contains("play") && capabilitiesStr.contains("pause")) {
            capabilitiesStr.append("togglePlayPause");
        }
        let capabilities = capabilitiesStr.compactMap { Capability(rawValue: $0) }
`,
        to: `        let capabilitiesStr = options["capabilities"] as? [String] ?? []
        let capabilities = capabilitiesStr.compactMap { Capability(rawValue: $0) }
`,
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift',
    changes: [
      {
        from: `import Foundation
import MediaPlayer
import SwiftAudioEx

private let lxTrackPlayerLifecycleNotification = Notification.Name("LXTrackPlayerLifecycle")
`,
        to: `import Foundation
import AVFoundation
import MediaPlayer
import SwiftAudioEx

private let lxTrackPlayerLifecycleNotification = Notification.Name("LXTrackPlayerLifecycle")
`,
      },
      {
        from: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()

    private func lifecycleStateName(_ state: AVPlayerWrapperState) -> String {
`,
        to: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()
    private var equalizerEnabled = false
    private var equalizerGains = LXEqualizerAudioMixController.normalizeGains([])
    private var equalizerTapProcessor: LXEqualizerAudioMixController?
    private weak var equalizedPlayerItem: AVPlayerItem?

    private func lifecycleStateName(_ state: AVPlayerWrapperState) -> String {
`,
      },
      {
        from: `    deinit {
        reset(resolve: { _ in }, reject: { _, _, _  in })
    }
`,
        to: `    deinit {
        NotificationCenter.default.removeObserver(self, name: lxSoundEffectConfigNotification, object: nil)
        reset(resolve: { _ in }, reject: { _, _, _  in })
    }
`,
      },
      {
        from: `        setupInterruptionHandling();

        // configure if player waits to play
`,
        to: `        setupInterruptionHandling();
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(handleSoundEffectConfigChanged),
                                               name: lxSoundEffectConfigNotification,
                                               object: nil)

        // configure if player waits to play
`,
      },
      {
        from: `    @objc(destroy)
    public func destroy() {
        print("Destroying player")
        self.player.stop()
        self.player.nowPlayingInfoController.clear()
        postLifecycleEvent("destroy", state: .idle, position: 0, rate: 0)
        try? AVAudioSession.sharedInstance().setActive(false)
        hasInitialized = false
    }
`,
        to: `    @objc(destroy)
    public func destroy() {
        print("Destroying player")
        self.player.stop()
        equalizedPlayerItem = nil
        equalizerTapProcessor = nil
        self.player.nowPlayingInfoController.clear()
        postLifecycleEvent("destroy", state: .idle, position: 0, rate: 0)
        try? AVAudioSession.sharedInstance().setActive(false)
        hasInitialized = false
    }
`,
      },
      {
        from: `    @objc(reset:rejecter:)
    public func reset(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Resetting player.")
        player.stop()
        postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)
        resolve(NSNull())
        DispatchQueue.main.async {
            UIApplication.shared.endReceivingRemoteControlEvents();
        }
    }
`,
        to: `    @objc(reset:rejecter:)
    public func reset(resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        print("Resetting player.")
        player.stop()
        equalizedPlayerItem = nil
        equalizerTapProcessor = nil
        postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)
        resolve(NSNull())
        DispatchQueue.main.async {
            UIApplication.shared.endReceivingRemoteControlEvents();
        }
    }
`,
      },
      {
        from: `    @objc(updateNowPlayingMetadata:resolver:rejecter:)
    public func updateNowPlayingMetadata(metadata: [String: Any], resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        Metadata.update(for: player, with: metadata)
    }

    // MARK: - QueuedAudioPlayer Event Handlers
`,
        to: `    @objc(updateNowPlayingMetadata:resolver:rejecter:)
    public func updateNowPlayingMetadata(metadata: [String: Any], resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        Metadata.update(for: player, with: metadata)
    }

    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        applySoundEffectConfig(notification.userInfo)
        refreshEqualizerAudioMix()
    }

    private func applySoundEffectConfig(_ userInfo: [AnyHashable: Any]?) {
        equalizerEnabled = userInfo?["enabled"] as? Bool ?? false
        let inputGains = userInfo?["gains"] as? [NSNumber] ?? []
        equalizerGains = LXEqualizerAudioMixController.normalizeGains(inputGains.map { $0.floatValue })
        equalizerTapProcessor?.updateConfig(enabled: equalizerEnabled, gains: equalizerGains)
    }

    private func refreshEqualizerAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        if equalizedPlayerItem === currentItem, let processor = equalizerTapProcessor {
            processor.updateConfig(enabled: equalizerEnabled, gains: equalizerGains)
            return
        }

        guard equalizerEnabled else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(enabled: equalizerEnabled, gains: equalizerGains)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        equalizedPlayerItem = currentItem
        equalizerTapProcessor = processor
    }

    // MARK: - QueuedAudioPlayer Event Handlers
`,
      },
      {
        from: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
        to: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshEqualizerAudioMix()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
      },
      {
        from: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
        to: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshEqualizerAudioMix()
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift',
    changes: [
      {
        from: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()
    private var equalizerEnabled = false
    private var equalizerGains = LXEqualizerAudioMixController.normalizeGains([])
    private var equalizerTapProcessor: LXEqualizerAudioMixController?
    private weak var equalizedPlayerItem: AVPlayerItem?
`,
        to: `    private var hasInitialized = false
    private let player = QueuedAudioPlayer()
    private var soundEffectConfig = LXSoundEffectConfiguration()
    private var soundEffectTapProcessor: LXEqualizerAudioMixController?
    private weak var soundEffectPlayerItem: AVPlayerItem?
`,
      },
      {
        from: `        self.player.stop()
        equalizedPlayerItem = nil
        equalizerTapProcessor = nil
        self.player.nowPlayingInfoController.clear()
`,
        to: `        self.player.stop()
        soundEffectPlayerItem?.audioMix = nil
        soundEffectPlayerItem = nil
        soundEffectTapProcessor = nil
        self.player.nowPlayingInfoController.clear()
`,
      },
      {
        from: `        player.stop()
        equalizedPlayerItem = nil
        equalizerTapProcessor = nil
        postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)
`,
        to: `        player.stop()
        soundEffectPlayerItem?.audioMix = nil
        soundEffectPlayerItem = nil
        soundEffectTapProcessor = nil
        postLifecycleEvent("reset", state: .idle, position: 0, rate: 0)
`,
      },
      {
        from: `    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        applySoundEffectConfig(notification.userInfo)
        refreshEqualizerAudioMix()
    }

    private func applySoundEffectConfig(_ userInfo: [AnyHashable: Any]?) {
        equalizerEnabled = userInfo?["enabled"] as? Bool ?? false
        let inputGains = userInfo?["gains"] as? [NSNumber] ?? []
        equalizerGains = LXEqualizerAudioMixController.normalizeGains(inputGains.map { $0.floatValue })
        equalizerTapProcessor?.updateConfig(enabled: equalizerEnabled, gains: equalizerGains)
    }

    private func refreshEqualizerAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        if equalizedPlayerItem === currentItem, let processor = equalizerTapProcessor {
            processor.updateConfig(enabled: equalizerEnabled, gains: equalizerGains)
            return
        }

        guard equalizerEnabled else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(enabled: equalizerEnabled, gains: equalizerGains)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            equalizedPlayerItem = nil
            equalizerTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        equalizedPlayerItem = currentItem
        equalizerTapProcessor = processor
    }
`,
        to: `    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        let nextConfig = LXSoundEffectConfiguration.fromUserInfo(notification.userInfo)
        if Thread.isMainThread {
            soundEffectConfig = nextConfig
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.soundEffectConfig = nextConfig
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMixOnMainThread() {
        if Thread.isMainThread {
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        if soundEffectPlayerItem !== currentItem {
            soundEffectPlayerItem?.audioMix = nil
        }

        if let processor = soundEffectTapProcessor, soundEffectPlayerItem === currentItem {
            processor.updateConfig(soundEffectConfig)
            if soundEffectConfig.isActive {
                if currentItem.audioMix == nil, let audioMix = processor.makeAudioMix(for: currentItem.asset) {
                    currentItem.audioMix = audioMix
                }
            } else {
                currentItem.audioMix = nil
                soundEffectTapProcessor = nil
                soundEffectPlayerItem = nil
            }
            return
        }

        guard soundEffectConfig.isActive else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(config: soundEffectConfig)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        soundEffectPlayerItem = currentItem
        soundEffectTapProcessor = processor
    }
`,
      },
      {
        from: `    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        soundEffectConfig = LXSoundEffectConfiguration.fromUserInfo(notification.userInfo)
        soundEffectTapProcessor?.updateConfig(soundEffectConfig)
        refreshSoundEffectAudioMix()
    }

    private func refreshSoundEffectAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        if soundEffectPlayerItem !== currentItem {
            soundEffectPlayerItem?.audioMix = nil
        }

        if let processor = soundEffectTapProcessor, soundEffectPlayerItem === currentItem {
            processor.updateConfig(soundEffectConfig)
            if soundEffectConfig.isActive {
                if currentItem.audioMix == nil, let audioMix = processor.makeAudioMix(for: currentItem.asset) {
                    currentItem.audioMix = audioMix
                }
            } else {
                currentItem.audioMix = nil
                soundEffectTapProcessor = nil
                soundEffectPlayerItem = nil
            }
            return
        }

        guard soundEffectConfig.isActive else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(config: soundEffectConfig)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        soundEffectPlayerItem = currentItem
        soundEffectTapProcessor = processor
    }
`,
        to: `    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        soundEffectConfig = LXSoundEffectConfiguration.fromUserInfo(notification.userInfo)
        refreshSoundEffectAudioMix()
    }

    private func refreshSoundEffectAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        if soundEffectPlayerItem !== currentItem {
            soundEffectPlayerItem?.audioMix = nil
        }

        if let processor = soundEffectTapProcessor, soundEffectPlayerItem === currentItem {
            processor.updateConfig(soundEffectConfig)
            if soundEffectConfig.isActive {
                if currentItem.audioMix == nil, let audioMix = processor.makeAudioMix(for: currentItem.asset) {
                    currentItem.audioMix = audioMix
                }
            } else {
                currentItem.audioMix = nil
                soundEffectTapProcessor = nil
                soundEffectPlayerItem = nil
            }
            return
        }

        guard soundEffectConfig.isActive else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(config: soundEffectConfig)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        soundEffectPlayerItem = currentItem
        soundEffectTapProcessor = processor
    }
`,
      },
      {
        from: `    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        soundEffectConfig = LXSoundEffectConfiguration.fromUserInfo(notification.userInfo)
        refreshSoundEffectAudioMix()
    }

    private func refreshSoundEffectAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        if soundEffectPlayerItem !== currentItem {
            soundEffectPlayerItem?.audioMix = nil
        }

        if let processor = soundEffectTapProcessor, soundEffectPlayerItem === currentItem {
            processor.updateConfig(soundEffectConfig)
            if soundEffectConfig.isActive {
                if currentItem.audioMix == nil, let audioMix = processor.makeAudioMix(for: currentItem.asset) {
                    currentItem.audioMix = audioMix
                }
            } else {
                currentItem.audioMix = nil
                soundEffectTapProcessor = nil
                soundEffectPlayerItem = nil
            }
            return
        }

        guard soundEffectConfig.isActive else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(config: soundEffectConfig)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        soundEffectPlayerItem = currentItem
        soundEffectTapProcessor = processor
    }
`,
        to: `    @objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        let nextConfig = LXSoundEffectConfiguration.fromUserInfo(notification.userInfo)
        if Thread.isMainThread {
            soundEffectConfig = nextConfig
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.soundEffectConfig = nextConfig
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMixOnMainThread() {
        if Thread.isMainThread {
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        if soundEffectPlayerItem !== currentItem {
            soundEffectPlayerItem?.audioMix = nil
        }

        if let processor = soundEffectTapProcessor, soundEffectPlayerItem === currentItem {
            processor.updateConfig(soundEffectConfig)
            if soundEffectConfig.isActive {
                if currentItem.audioMix == nil, let audioMix = processor.makeAudioMix(for: currentItem.asset) {
                    currentItem.audioMix = audioMix
                }
            } else {
                currentItem.audioMix = nil
                soundEffectTapProcessor = nil
                soundEffectPlayerItem = nil
            }
            return
        }

        guard soundEffectConfig.isActive else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(config: soundEffectConfig)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        soundEffectPlayerItem = currentItem
        soundEffectTapProcessor = processor
    }
`,
      },
      {
        from: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshEqualizerAudioMix()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
        to: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshSoundEffectAudioMixOnMainThread()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
      },
      {
        from: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshEqualizerAudioMix()
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
        to: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshSoundEffectAudioMixOnMainThread()
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
      },
      {
        from: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshSoundEffectAudioMix()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
        to: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshSoundEffectAudioMixOnMainThread()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }
`,
      },
      {
        from: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshSoundEffectAudioMix()
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
        to: `    func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshSoundEffectAudioMixOnMainThread()
        var dictionary: [String: Any] = [ "position": player.currentTime ]
`,
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift',
    changes: [
      {
        // mixWithOthers 需要 .default 路由策略才能生效：longFormAudio 是“独占式长音频”策略，
        // 会忽略混音选项，导致“关闭其他应用播放时自动暂停”设置下音乐仍被系统中断。
        // 仅在未请求混音时沿用 longFormAudio（保留长音频路由）。
        from: `        // Progressively opt into AVAudioSession policies for background audio
        // and AirPlay 2.
        if #available(iOS 13.0, *) {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, policy: sessionCategory == .ambient ? .default : .longFormAudio, options: sessionCategoryOptions)
        } else if #available(iOS 11.0, *) {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, policy: sessionCategory == .ambient ? .default : .longForm, options: sessionCategoryOptions)
        } else {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, options: sessionCategoryOptions)
        }`,
        to: `        // mixWithOthers 需要 .default 路由策略才能生效：longFormAudio 是“独占式长音频”策略，
        // 会忽略混音选项，导致“关闭其他应用播放时自动暂停”设置下音乐仍被系统中断。
        // 仅在未请求混音时沿用 longFormAudio（保留长音频路由）。
        let useLongFormAudioPolicy = sessionCategory != .ambient && !sessionCategoryOptions.contains(.mixWithOthers)
        // Progressively opt into AVAudioSession policies for background audio
        // and AirPlay 2.
        if #available(iOS 13.0, *) {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, policy: useLongFormAudioPolicy ? .longFormAudio : .default, options: sessionCategoryOptions)
        } else if #available(iOS 11.0, *) {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, policy: useLongFormAudioPolicy ? .longForm : .default, options: sessionCategoryOptions)
        } else {
            try? AVAudioSession.sharedInstance().setCategory(sessionCategory, mode: sessionCategoryMode, options: sessionCategoryOptions)
        }`,
      },
      {
        from: `        player.event.queueIndex.addListener(self, handleAudioPlayerQueueIndexChange)
    }
`,
        to: `        player.event.queueIndex.addListener(self, handleAudioPlayerQueueIndexChange)
        // ≈ HTMLMediaElement 的 seeked：AVPlayer seek completion（引擎真正到达落点，
        // 无论是否经历缓冲）。发起时的 "seek" lifecycle 事件带请求目标；本事件带引擎
        // 真实落点，控制中心歌词时钟据此精确重锚，并转发 JS 触发歌词重锚。
        player.event.seek.addListener(self, handleAudioPlayerSeekCompleted)
    }
`,
      },
      {
        from: `    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {`,
        to: `    // ≈ HTMLMediaElement 的 seeked：seek completion 回调（SeekEventData = (seconds: Int, didFinish: Bool)）。
    // 同时发 lifecycle 通知（控制中心歌词时钟重锚到真实落点）与 JS 事件（歌词重锚触发）。
    private func handleAudioPlayerSeekCompleted(_ data: (seconds: Int, didFinish: Bool)) {
        postLifecycleEvent("seeked", position: Double(data.seconds))
        sendEvent(withName: "player-seeked", body: ["position": Double(data.seconds), "finished": data.didFinish])
    }

    func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {`,
      },
      {
        from: `            "playback-queue-ended",
            "playback-state",`,
        to: `            "playback-queue-ended",
            "playback-state",
            "player-seeked",`,
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/react-native-track-player.podspec',
    changes: [
      {
        from: '  s.source_files = "ios/**/*.{h,m,swift}"',
        to: '  s.source_files = "ios/**/*.{h,m,mm,swift}"',
      },
    ],
  },
  {
    filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/Support/RNTrackPlayer-Bridging-Header.h',
    changes: [
      {
        from: `#import <React/RCTConvert.h>
`,
        to: `#import <React/RCTConvert.h>
#import "LXSharedIRConvolutionBridge.h"
`,
      },
    ],
  },
]

const patchFile = async({ filePath, changes }) => {
  const resolvedPath = path.join(rootPath, filePath)
  console.log(`Patching ${filePath}`)

  const file = await fs.promises.readFile(resolvedPath, 'utf8')
  const eol = file.includes('\r\n') ? '\r\n' : '\n'
  let normalizedFile = file.replace(/\r\n/g, '\n')
  const originalFile = normalizedFile

  for (const { from, to } of changes) {
    if (normalizedFile.includes(to)) continue
    if (!normalizedFile.includes(from)) continue
    normalizedFile = normalizedFile.replace(from, to)
  }

  if (normalizedFile != originalFile) await fs.promises.writeFile(resolvedPath, normalizedFile.replace(/\n/g, eol))
}

const walkFiles = async(dirPath, visitor) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) await walkFiles(entryPath, visitor)
    else await visitor(entryPath)
  }
}

const findFile = async(dirPath, fileName) => {
  let matchedPath = null
  await walkFiles(dirPath, async(filePath) => {
    if (matchedPath || path.basename(filePath) != fileName) return
    matchedPath = filePath
  })
  return matchedPath
}

const patchFileByRegex = async({ filePath, pattern, replacement }) => {
  const resolvedPath = path.join(rootPath, filePath)
  console.log(`Patching ${filePath}`)

  const file = await fs.promises.readFile(resolvedPath, 'utf8')
  const eol = file.includes('\r\n') ? '\r\n' : '\n'
  const normalizedFile = file.replace(/\r\n/g, '\n')
  if (normalizedFile.includes(replacement.trim())) return
  const nextFile = normalizedFile.replace(pattern, replacement)

  if (nextFile == normalizedFile) throw new Error('Patch pattern not found')
  if (nextFile != normalizedFile) await fs.promises.writeFile(resolvedPath, nextFile.replace(/\n/g, eol))
}

const ensureFileContent = async({ filePath, content }) => {
  const resolvedPath = path.join(rootPath, filePath)
  console.log(`Ensuring ${filePath}`)

  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true })
  const file = await fs.promises.readFile(resolvedPath, 'utf8').catch(() => '')
  const eol = file.includes('\r\n') ? '\r\n' : '\n'
  const normalizedFile = file.replace(/\r\n/g, '\n')
  const normalizedContent = content.replace(/\r\n/g, '\n')

  if (normalizedFile == normalizedContent) return
  await fs.promises.writeFile(resolvedPath, normalizedContent.replace(/\n/g, eol))
}

const patchSwiftAudioSeek = async() => {
  const baseDir = path.join(rootPath, 'node_modules/react-native-track-player/ios/RNTrackPlayer')
  if (!fs.existsSync(baseDir)) {
    console.log('Skip SwiftAudio seek patch: react-native-track-player source not found')
    return
  }
  const wrapperPath = await findFile(baseDir, 'AVPlayerWrapper.swift')
  if (!wrapperPath) {
    console.log('Skip SwiftAudio seek patch: AVPlayerWrapper.swift not found')
    return
  }

  const relativePath = path.relative(rootPath, wrapperPath)
  await patchFileByRegex({
    filePath: relativePath,
    pattern: /func seek\(to seconds: TimeInterval\) \{[\s\S]*?func seek\(by seconds: TimeInterval\) \{/,
    replacement: `func seek(to seconds: TimeInterval) {
        // if the player is loading then we need to defer seeking until it's ready.
        if (avPlayer.currentItem == nil) {
            timeToSeekToAfterLoading = seconds
        } else {
            let time = CMTimeMakeWithSeconds(seconds, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
            let performSeek = { [weak self] (completion: @escaping (Bool) -> Void) in
                guard let self = self else {
                    completion(false)
                    return
                }
                self.currentItem?.cancelPendingSeeks()
                self.avPlayer.seek(to: time, toleranceBefore: CMTime.zero, toleranceAfter: CMTime.zero, completionHandler: completion)
            }

            performSeek { [weak self] finished in
                guard let self = self else { return }
                let currentTime = self.avPlayer.currentTime().seconds
                if finished && !currentTime.isNaN && abs(currentTime - seconds) > 0.2 {
                    performSeek { [weak self] retryFinished in
                        guard let self = self else { return }
                        self.delegate?.AVWrapper(seekTo: Double(seconds), didFinish: retryFinished)
                    }
                    return
                }
                self.delegate?.AVWrapper(seekTo: Double(seconds), didFinish: finished)
            }
        }
    }
    func seek(by seconds: TimeInterval) {`,
  })
}

const patchTrackPlayerSoundEffectRefresh = async() => {
  const filePath = 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift'

  await patchFileByRegex({
    filePath,
    pattern: /@objc private func handleSoundEffectConfigChanged\(_ notification: Notification\) \{[\s\S]*?\n\s{4}\/\/ MARK: - QueuedAudioPlayer Event Handlers/,
    replacement: `@objc private func handleSoundEffectConfigChanged(_ notification: Notification) {
        let nextConfig = LXSoundEffectConfiguration.fromUserInfo(notification.userInfo)
        if Thread.isMainThread {
            soundEffectConfig = nextConfig
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.soundEffectConfig = nextConfig
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMixOnMainThread() {
        if Thread.isMainThread {
            refreshSoundEffectAudioMix()
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.refreshSoundEffectAudioMix()
        }
    }

    private func refreshSoundEffectAudioMix() {
        guard let currentItem = player.currentPlayerItem else {
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        if soundEffectPlayerItem !== currentItem {
            soundEffectPlayerItem?.audioMix = nil
        }

        if let processor = soundEffectTapProcessor, soundEffectPlayerItem === currentItem {
            processor.updateConfig(soundEffectConfig)
            if soundEffectConfig.isActive {
                if currentItem.audioMix == nil, let audioMix = processor.makeAudioMix(for: currentItem.asset) {
                    currentItem.audioMix = audioMix
                }
            } else {
                currentItem.audioMix = nil
                soundEffectTapProcessor = nil
                soundEffectPlayerItem = nil
            }
            return
        }

        guard soundEffectConfig.isActive else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        let processor = LXEqualizerAudioMixController(config: soundEffectConfig)
        guard let audioMix = processor.makeAudioMix(for: currentItem.asset) else {
            currentItem.audioMix = nil
            soundEffectPlayerItem = nil
            soundEffectTapProcessor = nil
            return
        }

        currentItem.audioMix = audioMix
        soundEffectPlayerItem = currentItem
        soundEffectTapProcessor = processor
    }

    // MARK: - QueuedAudioPlayer Event Handlers`,
  })

  await patchFileByRegex({
    filePath,
    pattern: /func handleAudioPlayerStateChange\(state: AVPlayerWrapperState\) \{[\s\S]*?\n\s{4}\}/,
    replacement: `func handleAudioPlayerStateChange(state: AVPlayerWrapperState) {
        refreshSoundEffectAudioMixOnMainThread()
        sendEvent(withName: "playback-state", body: ["state": state.rawValue])
        postLifecycleEvent("state", state: state)
    }`,
  })

  await patchFileByRegex({
    filePath,
    pattern: /func handleAudioPlayerQueueIndexChange\(previousIndex: Int\?, nextIndex: Int\?\) \{[\s\S]*?\n\s{8}var dictionary: \[String: Any\] = \[ "position": player.currentTime \]/,
    replacement: `func handleAudioPlayerQueueIndexChange(previousIndex: Int?, nextIndex: Int?) {
        refreshSoundEffectAudioMixOnMainThread()
        var dictionary: [String: Any] = [ "position": player.currentTime ]`,
  })
}

// 【第 21 轮·优化 1】RNTP 中断结束分支：拿不到 AVAudioSessionInterruptionOptionKey 时
// 不能直接 return。
// RNTP（上游 lyswhut fork，commit d4a062f7）原样是：
//     guard let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt else { return }
// iOS 在不少抢占场景（车机蓝牙 + 导航播报，正是用户第 21 轮报的那条链）不带这个 key：
// 于是原生侧既不发 remote-duck 的「打断结束」，JS 也就永远等不到恢复时机 —— 表现为
// 「播报结束后不恢复播放」。这里改成缺省 0（等价于「没有 shouldResume」），事件照发；
// 中断本身没结束的判定（began 分支）与「要不要恢复」的决策都交给 JS（service.ts：
// permanent 且超过 30s 才保持暂停，短暂中断照旧恢复）。
const patchTrackPlayerInterruptionEndAlwaysEmit = async() => {
  const filePath = 'node_modules/react-native-track-player/ios/RNTrackPlayer/RNTrackPlayer.swift'

  await patchFileByRegex({
    filePath,
    pattern: /guard let optionsValue =\s*\n\s*userInfo\[AVAudioSessionInterruptionOptionKey\] as\? UInt else \{\s*\n\s*return\s*\n\s*\}/,
    replacement: `// 【LX 第 21 轮·优化 1】缺 AVAudioSessionInterruptionOptionKey 时按 0 处理，
            // 不再直接 return 把「打断结束」这件事整个吞掉：iOS 在车机蓝牙 + 导航播报
            // 等抢占场景不带这个 key，吞掉事件会让 JS 永远收不到结束通知、播报结束后不恢复。
            // 事件照发（permanent=true），是否恢复播放交给 JS 判定。
            let optionsValue = (userInfo[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0`,
  })
}

;(async() => {
  for (const target of patchTargets) {
    try {
      await patchFile(target)
    } catch (err) {
      console.error(`Patch ${target.filePath} failed: ${err.message}`)
    }
  }
  try {
    await patchSwiftAudioSeek()
  } catch (err) {
    console.error(`Patch SwiftAudio seek failed: ${err.message}`)
  }
  try {
    await patchTrackPlayerSoundEffectRefresh()
  } catch (err) {
    console.error(`Patch TrackPlayer sound effect refresh failed: ${err.message}`)
  }
  try {
    await patchTrackPlayerInterruptionEndAlwaysEmit()
  } catch (err) {
    console.error(`Patch TrackPlayer interruption end failed: ${err.message}`)
  }
  try {
    await ensureFileContent({
      filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/LXEqualizerAudioMix.swift',
      content: equalizerAudioMixSwiftSource,
    })
  } catch (err) {
    console.error(`Ensure LXEqualizerAudioMix.swift failed: ${err.message}`)
  }
  try {
    await ensureFileContent({
      filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/LXSharedIRConvolutionKernel.hpp',
      content: sharedIRKernelSource,
    })
    await ensureFileContent({
      filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/LXSharedIRConvolutionBridge.h',
      content: sharedIRBridgeHeaderSource,
    })
    await ensureFileContent({
      filePath: 'node_modules/react-native-track-player/ios/RNTrackPlayer/LXSharedIRConvolutionBridge.mm',
      content: sharedIRBridgeSource,
    })
  } catch (err) {
    console.error(`Ensure shared IR bridge failed: ${err.message}`)
  }
  // 横滑闩锁补丁的存在性自检（2026-10-01，P0）。
  // patchFile 对「from 串不匹配」是**静默跳过**的（上游改了源码、或文件被别的工具动过），
  // 而这个补丁失效的代价是「推荐/歌单/搜索/我的/设置五页滑不动」重现——
  // 所以在收尾时显式验一次，让 npm install 的日志里直接能看见，而不是等人去 diff
  // node_modules。只读不写，任何异常都不影响安装。
  try {
    const pagerViewPath = path.join(rootPath, 'node_modules/react-native-pager-view/ios/RNCPagerView.m')
    if (fs.existsSync(pagerViewPath)) {
      const pagerViewSource = (await fs.promises.readFile(pagerViewPath, 'utf8')).replace(/\r\n/g, '\n')
      const missing = []
      if (!pagerViewSource.includes('self.scrollView.panGestureRecognizer.enabled = scrollEnabled;')) {
        missing.push('shouldScroll: 同步 panGestureRecognizer.enabled')
      }
      if (!pagerViewSource.includes('[self enableSwipe];\n        return;')) {
        missing.push('goTo: 越界恢复 enableSwipe')
      }
      if (missing.length) {
        console.error(`[pager-view] 横滑闩锁补丁未生效（${missing.join('；')}）——`
          + '五页横滑可能再次失效，请检查 react-native-pager-view 的版本与源码是否变化。')
      } else {
        console.log('[pager-view] 横滑闩锁补丁已生效（shouldScroll 同步 pan + goTo 越界恢复交互）。')
      }
    }
    const rnViewManagerPath = path.join(rootPath, 'node_modules/react-native/React/Views/RCTViewManager.m')
    if (fs.existsSync(rnViewManagerPath)) {
      const rnSource = (await fs.promises.readFile(rnViewManagerPath, 'utf8')).replace(/\r\n/g, '\n')
      if (rnSource.includes('break;\n    case RCTPointerEventsNone:')) {
        console.log('[react-native] pointerEvents 兜底分支 break 补丁已生效。')
      } else {
        console.error('[react-native] RCTViewManager 的 pointerEvents break 补丁未生效——'
          + '若将来把 pointerEvents 挂到 PagerView 这类原生宿主上，页面会连点带滑全死。')
      }
    }
  } catch (err) {
    console.error(`Verify pager-view swipe patch failed: ${err.message}`)
  }
  console.log('\nDependencies patch finished.\n')
})()
