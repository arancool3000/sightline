import SwiftUI
import RealityKit
import ARKit
import Combine
import simd
import QuartzCore
import AVKit

enum AppKind: CaseIterable {
    case safari, photos, files, notes, weather, clock, calculator, tips

    /// What you can call it out loud.
    var spokenNames: [String] {
        switch self {
        case .safari: return ["safari", "browser", "the browser", "web", "the web", "internet", "the internet"]
        case .photos: return ["photos", "photo", "pictures", "my photos", "gallery"]
        case .files: return ["files", "my files", "documents", "file"]
        case .notes: return ["notes", "note", "my notes"]
        case .weather: return ["weather", "the weather"]
        case .clock: return ["clock", "the clock", "time"]
        case .calculator: return ["calculator", "the calculator", "calc"]
        case .tips: return ["tips", "help", "commands", "voice commands"]
        }
    }

    static func named(_ words: String) -> AppKind? {
        allCases.first { $0.spokenNames.contains(words) }
    }
}

/// A head-locked control on the screen (Crown, Control Center) that your hand
/// can pinch: hold your fingertip over it as you see it on screen.
struct HandTarget: Equatable {
    let frame: CGRect
    let action: () -> Void
    static func == (a: HandTarget, b: HandTarget) -> Bool { a.frame == b.frame }
}

/// Written by SwiftUI as the layout changes, read by the hand tracker.
final class HandTargetStore: @unchecked Sendable {
    private let lock = NSLock()
    private var targets: [String: HandTarget] = [:]
    func set(_ t: [String: HandTarget]) {
        lock.lock()
        targets = t
        lock.unlock()
    }
    func all() -> [String: HandTarget] {
        lock.lock()
        defer { lock.unlock() }
        return targets
    }
}

enum CameraMode: String {
    /// The main camera with ARKit: windows stay in your room, LiDAR, real hand depth.
    case ar
    /// The ultra wide camera with the gyroscope: the widest view, windows around you.
    case ultraWide
}

/// Runs the AR session, owns the windows in your room and turns your hands
/// (and touches) into interactions.
@MainActor
final class Spatial: NSObject, ObservableObject {
    /// Only set when something needs your attention (e.g. "Slow down").
    @Published var status = ""
    /// Everything about tracking, for Control Center.
    @Published var detail = "Starting…"
    @Published var toastText: String?
    @Published var sheet: Sheet?
    @Published var handsOn = true {
        didSet {
            if !handsOn { handGone() }
            ultra.setHandsEnabled(handsOn)
        }
    }
    @Published private(set) var cameraMode: CameraMode = .ar
    @Published private(set) var meshVisible = false
    @Published private(set) var environment: EnvironmentKind?
    @Published private(set) var immersion: Float = 0
    @Published private(set) var panoramaShown = false
    @Published var controlCenterShown = false
    /// The on-screen control your hand is over, and where your fingertip is.
    @Published private(set) var handHover: String?
    @Published private(set) var handPoint: CGPoint?
    @Published private(set) var voiceOn = true

    let voice = VoiceControl()
    let handTargets = HandTargetStore()
    /// The window voice commands like "next" or "scroll down" go to.
    private weak var focused: SpatialWindow?
    private static let voiceKey = "vision.voiceOff"
    private var buttonToken: UUID?
    private var buttonHeld = false

    let arView: ARView
    let ultra = UltraWideCamera()
    let previewView: CameraPreviewView
    private let anchor = AnchorEntity(world: .zero)
    private let hands = HandTracker()
    private let cursor: ModelEntity
    private let arConfig = ARWorldTrackingConfiguration()
    private let coaching = ARCoachingOverlayView()
    private(set) var windows: [SpatialWindow] = []
    private var home: SpatialWindow?
    private var homeShown = false
    private var updateSubscription: Cancellable?
    private(set) var hasLiDAR = false
    private var statusTime: TimeInterval = 0
    private var toastTask: Task<Void, Never>?
    private static let cameraModeKey = "vision.cameraMode"

    // Ultra Wide: a virtual camera turned by the gyroscope.
    private let headAnchor = AnchorEntity(world: .zero)
    private let headCamera = PerspectiveCamera()
    private var verticalFOV: Float = 1.2
    private var previewOrientation: UIInterfaceOrientation = .unknown

    // Environments and panoramas.
    private let environmentEntity = ModelEntity()
    private var environmentMaterial: UnlitMaterial?
    private var environmentTextures: [EnvironmentKind: TextureResource] = [:]
    private var lastEnvironment: EnvironmentKind = .nightSky
    private var environmentYaw: Float = 0
    private var builtArc: Float = -1
    private let panoramaEntity = ModelEntity()

    // Apps keep their state while their window is closed.
    private lazy var clockApp = ClockApp()
    private lazy var calculatorApp = CalculatorApp()
    private lazy var notesApp = NotesApp(spatial: self)
    private lazy var photosApp = PhotosApp(spatial: self)
    private lazy var weatherApp = WeatherApp()
    private(set) lazy var browserApp = BrowserApp(spatial: self)
    private lazy var tipsApp = TipsApp()
    private lazy var homeApp = HomeApp(spatial: self)
    private lazy var filesApp = FilesApp(spatial: self)

    // Hand state
    // Smoother when still (lower cutoff) than before: detections are noisy.
    private var tipFilter = OneEuro3(minCutoff: 0.8, beta: 3)
    private var thumbFilter = OneEuro3(minCutoff: 0.8, beta: 3)
    private var stabilizer = HandStabilizer()
    /// Recent filtered fingertips, to aim with where you were *before* a pinch.
    private var aimHistory: [(time: TimeInterval, tip: SIMD3<Float>)] = []
    /// Depth to the glass, smoothed: LiDAR at a fingertip edge is jumpy.
    private var pokeDepth: Float?
    private var sample: HandSample?
    private var lastSequence = -1
    private var handLostAt: TimeInterval = 0
    private var pinching = false
    private var interaction: Interaction = .none

    enum Interaction {
        case none
        case pressing(SpatialWindow, String?, CGPoint, start: TimeInterval)
        case poking(SpatialWindow, String?, CGPoint)
        case grabbing(SpatialWindow, start: SIMD3<Float>, from: SIMD3<Float>, gain: Float)
        case touchDragging(SpatialWindow, distance: Float, offset: SIMD3<Float>)
        /// Pinching an on-screen control; for the Crown, dragging turns it.
        case overlay(String, start: TimeInterval, y: CGFloat, immersion: Float, turning: Bool)
    }

    override init() {
        arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        cursor = ModelEntity(mesh: .generateSphere(radius: 0.0045), materials: [UnlitMaterial(color: .white)])
        previewView = CameraPreviewView(session: ultra.session)
        super.init()
        configure()
    }

    // MARK: - Setup

    private func configure() {
        let config = arConfig
        config.planeDetection = [.horizontal, .vertical]
        config.environmentTexturing = .automatic

        // LiDAR: a live mesh of the room. Real objects hide windows behind
        // them, and windows can snap onto walls and tables.
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
            config.sceneReconstruction = .mesh
            hasLiDAR = true
            arView.environment.sceneUnderstanding.options.insert(.occlusion)
        }

        // People occlusion keeps your hands in front of windows, and gives
        // per-pixel depth for them; LiDAR scene depth refines fingertips.
        var semantics: ARConfiguration.FrameSemantics = []
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.personSegmentationWithDepth) {
            semantics.insert(.personSegmentationWithDepth)
        }
        if ARWorldTrackingConfiguration.supportsFrameSemantics(semantics.union(.smoothedSceneDepth)) {
            semantics.insert(.smoothedSceneDepth)
        }
        config.frameSemantics = semantics
        arView.session.run(config)

        coaching.session = arView.session
        coaching.goal = .tracking
        coaching.activatesAutomatically = true
        coaching.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        arView.addSubview(coaching)

        arView.scene.addAnchor(anchor)
        anchor.addChild(cursor)
        cursor.isEnabled = false
        // Transparent when not in AR, so the ultra wide camera shows through.
        arView.backgroundColor = .clear
        headAnchor.addChild(headCamera)

        let hands = self.hands
        ultra.onFrame = { [weak ultra] buffer, time in
            guard let ultra else { return }
            hands.process(pixelBuffer: buffer, depth: nil, camera: ultra.cameraModel(for: buffer), time: time)
        }
        if UserDefaults.standard.string(forKey: Self.cameraModeKey) == CameraMode.ultraWide.rawValue, ultra.isAvailable {
            cameraMode = .ultraWide
            applyCameraMode()
        }

        arView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(handleTap(_:))))
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.maximumNumberOfTouches = 1
        arView.addGestureRecognizer(pan)

        updateSubscription = arView.scene.subscribe(to: SceneEvents.Update.self) { [weak self] event in
            let dt = Float(event.deltaTime)
            MainActor.assumeIsolated {
                self?.tick(dt: dt)
            }
        }

        voice.onCommand = { [weak self] text in self?.handleVoice(text) }
        installCameraButton()
        voiceOn = !UserDefaults.standard.bool(forKey: Self.voiceKey)

        // Show the Home View once tracking has had a moment to start, then
        // start listening (after the camera permission prompt, if any).
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            if !homeShown { toggleHome() }
            try? await Task.sleep(nanoseconds: 800_000_000)
            if voiceOn { voice.start() }
        }
    }

    // MARK: - Frame loop

    private func tick(dt rawDt: Float) {
        let dt = max(1.0 / 240, min(rawDt, 0.1))
        let now = CACurrentMediaTime()
        switch cameraMode {
        case .ar:
            if let frame = arView.session.currentFrame {
                if handsOn { hands.process(frame) }
                updateStatus(frame, now: now)
            }
        case .ultraWide:
            updateHeadCamera()
            updateUltraStatus(now: now)
        }
        updateHand(dt: dt, now: now)
        if environmentEntity.parent != nil { environmentEntity.position = head.translation }
        let date = Date()
        for w in allWindows {
            w.animate(dt: dt)
            w.app.tick(date)
            if w.needsRedraw || w.app.dirty { w.redraw() }
        }
    }

    private var allWindows: [SpatialWindow] {
        var list = windows
        if homeShown, let home { list.append(home) }
        return list
    }

    private func updateStatus(_ frame: ARFrame, now: TimeInterval) {
        guard now - statusTime > 0.5 else { return }
        statusTime = now
        var problem = ""
        switch frame.camera.trackingState {
        case .normal:
            break
        case .notAvailable:
            problem = "No tracking"
        case .limited(let reason):
            switch reason {
            case .initializing: problem = "Starting…"
            case .excessiveMotion: problem = "Slow down"
            case .insufficientFeatures: problem = "Point at more detail"
            case .relocalizing: problem = "Relocalizing"
            @unknown default: problem = "Limited tracking"
            }
        }
        publishStatus(problem: problem, parts: [problem.isEmpty ? "Tracking" : problem, hasLiDAR ? "LiDAR" : "No LiDAR"])
    }

    private func updateUltraStatus(now: TimeInterval) {
        guard now - statusTime > 0.5 else { return }
        statusTime = now
        let ready = ultra.attitude() != nil
        publishStatus(problem: ready ? "" : "Starting camera…", parts: [ultra.isUltraWide ? "Ultra Wide" : "Wide", "Gyro"])
    }

    private func publishStatus(problem: String, parts: [String]) {
        var parts = parts
        if handsOn {
            let seen = handLostAt == 0 && sample != nil
            parts.append(seen ? String(format: "Hand · %.0f fps", hands.fps) : "No hand in view")
        }
        let text = parts.joined(separator: " · ")
        if text != detail { detail = text }
        if problem != status { status = problem }
    }

    // MARK: - Hands

    private func updateHand(dt: Float, now: TimeInterval) {
        let (latest, sequence) = hands.take()
        if sequence != lastSequence {
            lastSequence = sequence
            if let latest {
                // A rejected glitch is ignored, not treated as a lost hand.
                if stabilizer.accept(latest) {
                    sample = latest
                    handLostAt = 0
                }
            } else if handLostAt == 0 {
                handLostAt = now
            }
        }
        // Ride out short dropouts (a pinch often hides fingers for a moment).
        guard handsOn, let s = sample, handLostAt == 0 || now - handLostAt < 0.4 else {
            handGone()
            return
        }
        // Filter at display rate: smooth glide between ~30 Hz detections.
        let tip = tipFilter.filter(s.indexTip, dt: dt)
        let thumb = s.thumbTip.map { thumbFilter.filter($0, dt: dt) } ?? tip
        let cam = head.translation
        let pinchPoint = (tip + thumb) / 2
        let isPinch = stabilizer.pinched

        aimHistory.append((now, tip))
        if aimHistory.count > 40 { aimHistory.removeFirst(aimHistory.count - 40) }

        // 1) Carrying a window by its bar.
        if case .grabbing(let w, let start, let from, let gain) = interaction {
            if isPinch {
                w.targetPosition = from + (pinchPoint - start) * gain
                w.targetOrientation = facing(w.targetPosition, cam)
                showCursor(at: pinchPoint, pressed: true)
                return
            }
            w.barHighlighted = false
            snapToSurface(w)
            interaction = .none
            pinching = false
        }

        // 1b) Head-locked controls (Crown, Control Center): where your
        //     fingertip appears on screen, pinch to press.
        let screen = screenPoint(of: tip)
        if case .overlay(let id, let start, let y0, let immersion0, var turning) = interaction {
            if isPinch {
                if id == "crown", let screen {
                    if abs(screen.y - y0) > 14 { turning = true }
                    if turning { setImmersion(immersion0 - Float(screen.y - y0) / 160) }
                    interaction = .overlay(id, start: start, y: y0, immersion: immersion0, turning: turning)
                }
                setHandPoint(screen, hover: id)
                return
            }
            interaction = .none
            pinching = false
            if id == "crown" {
                if !turning {
                    if now - start > 0.6 { recenter() } else { crownPressed() }
                }
            } else if let screen, overlayTarget(at: screen)?.id == id {
                overlayTarget(at: screen)?.target.action()
            }
            return
        }
        if let screen, let over = overlayTarget(at: screen) {
            cursor.isEnabled = false
            clearHover(except: nil)
            setHandPoint(screen, hover: over.id)
            if isPinch && !pinching {
                pinching = true
                interaction = .overlay(over.id, start: now, y: screen.y, immersion: immersion, turning: false)
            } else if !isPinch {
                pinching = false
            }
            return
        }
        setHandPoint(nil, hover: nil)

        // 2) Direct touch (only with real LiDAR depth: guessed depth is too
        //    rough to tell touching from hovering).
        if s.measuredDepth, let near = nearestWindow(to: tip) {
            let (w, rawL) = near
            let z = (pokeDepth ?? rawL.z) * 0.6 + rawL.z * 0.4
            pokeDepth = z
            let l = (x: rawL.x, y: rawL.y, z: z)
            let region = w.region(x: l.x, y: l.y, sticky: w.hovered)
            var id: String?
            if case .content(let nodeID)? = region { id = nodeID }
            clearHover(except: w)
            w.hovered = id
            w.barHighlighted = region == .bar
            showCursor(at: w.world(x: l.x, y: l.y, z: 0.002), pressed: l.z < 0.012)
            switch interaction {
            case .poking(let pw, let pid, let point):
                if l.z > 0.025 {
                    if pw === w, pid == id {
                        focused = pw
                        pw.activate(pid, at: point)
                    }
                    pw.pressed = nil
                    interaction = .none
                }
            default:
                if l.z < 0.012 {
                    if region == .close {
                        close(w)
                        return
                    }
                    if region == .bar {
                        interaction = .grabbing(w, start: tip, from: w.targetPosition, gain: 1)
                        w.onWall = false
                        focused = w
                        return
                    }
                    w.pressed = id
                    interaction = .poking(w, id, CGPoint(x: l.x, y: l.y))
                }
            }
            pinching = isPinch
            return
        } else {
            pokeDepth = nil
            if case .poking(let pw, _, _) = interaction {
                pw.pressed = nil
                interaction = .none
            }
        }

        // 3) At a distance: aim along the line from your eye through your
        //    fingertip, pinch to tap.
        let direction = simd_normalize(tip - cam)
        let hit = hitWindows(origin: cam, direction: direction)
        updateHover(hit)
        if let hit {
            showCursor(at: hit.point + hit.window.normal * 0.002, pressed: isPinch)
        } else {
            cursor.isEnabled = false
        }

        if isPinch && !pinching {
            pinching = true
            // Closing a pinch pulls the fingertip down, so press what you
            // were pointing at a moment ago.
            let before = aimHistory.last(where: { now - $0.time >= 0.2 })?.tip ?? tip
            guard let hit = hitWindows(origin: cam, direction: simd_normalize(before - cam)) ?? hit else { return }
            updateHover(hit)
            switch hit.region {
            case .bar:
                let gain = max(1, simd_distance(cam, hit.window.position) / max(0.15, simd_distance(cam, pinchPoint)))
                interaction = .grabbing(hit.window, start: pinchPoint, from: hit.window.targetPosition, gain: gain)
                hit.window.onWall = false
                focused = hit.window
            case .close:
                close(hit.window)
            case .content(let id):
                hit.window.pressed = id
                let l = hit.window.local(hit.point)
                interaction = .pressing(hit.window, id, CGPoint(x: l.x, y: l.y), start: now)
            }
        } else if !isPinch && pinching {
            pinching = false
            if case .pressing(let w, let id, let point, let start) = interaction {
                // A quick pinch counts even if tracking wobbled off the
                // button; a slow one must end on it.
                var onIt = false
                if let hit, hit.window === w, case .content(let hitID) = hit.region, hitID == id { onIt = true }
                if onIt || now - start < 0.7 {
                    focused = w
                    w.activate(id, at: point)
                }
                w.pressed = nil
            }
            interaction = .none
        }
    }

    private func handGone() {
        cursor.isEnabled = false
        setHandPoint(nil, hover: nil)
        switch interaction {
        case .grabbing(let w, _, _, _):
            w.barHighlighted = false
            snapToSurface(w)
        case .pressing(let w, _, _, _), .poking(let w, _, _):
            w.pressed = nil
        default:
            break
        }
        if case .touchDragging = interaction {} else { interaction = .none }
        pinching = false
        tipFilter.reset()
        thumbFilter.reset()
        stabilizer.reset()
        aimHistory.removeAll()
        pokeDepth = nil
        clearHover(except: nil)
    }

    private func setHandPoint(_ p: CGPoint?, hover: String?) {
        if hover != handHover { handHover = hover }
        guard hover != nil, let p else {
            if handPoint != nil { handPoint = nil }
            return
        }
        if let old = handPoint, abs(old.x - p.x) < 1.5, abs(old.y - p.y) < 1.5 { return }
        handPoint = p
    }

    /// The smallest on-screen control under a point (with a little slack).
    private func overlayTarget(at p: CGPoint) -> (id: String, target: HandTarget)? {
        let all = handTargets.all()
        if let current = handHover, let t = all[current], t.frame.insetBy(dx: -24, dy: -24).contains(p) {
            return (current, t)
        }
        var best: (id: String, target: HandTarget)?
        for (id, t) in all where t.frame.insetBy(dx: -10, dy: -10).contains(p) {
            if best == nil || t.frame.width * t.frame.height < best!.target.frame.width * best!.target.frame.height {
                best = (id, t)
            }
        }
        return best
    }

    /// Where a point in the room appears on the screen.
    private func screenPoint(of p: SIMD3<Float>) -> CGPoint? {
        switch cameraMode {
        case .ar:
            return arView.project(p)
        case .ultraWide:
            let v = headCamera.orientation.inverse.act(p - headCamera.position)
            let size = arView.bounds.size
            guard v.z < -0.01, size.width > 0, size.height > 0 else { return nil }
            let tanV = tan(verticalFOV / 2)
            let x = (v.x / -v.z) / (tanV * Float(size.width / size.height))
            let y = (v.y / -v.z) / tanV
            return CGPoint(x: CGFloat((x + 1) / 2) * size.width, y: CGFloat((1 - y) / 2) * size.height)
        }
    }

    private func showCursor(at p: SIMD3<Float>, pressed: Bool) {
        cursor.position = p
        cursor.scale = SIMD3<Float>(repeating: pressed ? 0.55 : 1)
        cursor.isEnabled = true
    }

    private func clearHover(except keep: SpatialWindow?) {
        for w in allWindows where w !== keep {
            w.hovered = nil
            w.barHighlighted = false
        }
    }

    private func updateHover(_ hit: WindowHit?) {
        for w in allWindows {
            if let hit, hit.window === w {
                if case .content(let id) = hit.region { w.hovered = id } else { w.hovered = nil }
                w.barHighlighted = hit.region == .bar
            } else {
                w.hovered = nil
                w.barHighlighted = false
            }
        }
    }

    /// A window whose glass your fingertip is right at (within reach).
    private func nearestWindow(to p: SIMD3<Float>) -> (SpatialWindow, (x: CGFloat, y: CGFloat, z: Float))? {
        var best: (SpatialWindow, (x: CGFloat, y: CGFloat, z: Float))?
        for w in allWindows {
            let l = w.local(p)
            guard l.x > -12, l.x < w.size.width + 12, l.y > -12, l.y < w.size.height + 70 else { continue }
            guard l.z > -0.05, l.z < 0.06 else { continue }
            if best == nil || abs(l.z) < abs(best!.1.z) { best = (w, l) }
        }
        return best
    }

    private func hitWindows(origin: SIMD3<Float>, direction: SIMD3<Float>) -> WindowHit? {
        var best: WindowHit?
        for w in allWindows {
            if let h = w.hit(origin: origin, direction: direction, sticky: w.hovered), best == nil || h.distance < best!.distance {
                best = h
            }
        }
        return best
    }

    // MARK: - Touch (always works too)

    @objc private func handleTap(_ g: UITapGestureRecognizer) {
        let p = g.location(in: arView)
        guard let ray = screenRay(p), let hit = hitWindows(origin: ray.origin, direction: ray.direction) else { return }
        switch hit.region {
        case .close: close(hit.window)
        case .content(let id):
            let l = hit.window.local(hit.point)
            focused = hit.window
            hit.window.activate(id, at: CGPoint(x: l.x, y: l.y))
        case .bar: break
        }
    }

    @objc private func handlePan(_ g: UIPanGestureRecognizer) {
        guard let ray = screenRay(g.location(in: arView)) else { return }
        let cam = head.translation
        switch g.state {
        case .began:
            if let hit = hitWindows(origin: ray.origin, direction: ray.direction), hit.region == .bar {
                interaction = .touchDragging(hit.window, distance: hit.distance, offset: hit.window.targetPosition - hit.point)
                hit.window.barHighlighted = true
                hit.window.onWall = false
            }
        case .changed:
            if case .touchDragging(let w, let d, let offset) = interaction {
                w.targetPosition = ray.origin + ray.direction * d + offset
                w.targetOrientation = facing(w.targetPosition, cam)
            }
        case .ended, .cancelled, .failed:
            if case .touchDragging(let w, _, _) = interaction {
                w.barHighlighted = false
                snapToSurface(w)
                interaction = .none
            }
        default:
            break
        }
    }

    /// The ray from your eye through a point on the screen.
    private func screenRay(_ p: CGPoint) -> (origin: SIMD3<Float>, direction: SIMD3<Float>)? {
        if cameraMode == .ar { return arView.ray(through: p) }
        let size = arView.bounds.size
        guard size.width > 0, size.height > 0 else { return nil }
        let tanV = tan(verticalFOV / 2)
        let x = (Float(p.x / size.width) * 2 - 1) * tanV * Float(size.width / size.height)
        let y = (1 - Float(p.y / size.height) * 2) * tanV
        return (headCamera.position, simd_normalize(headCamera.orientation.act(SIMD3<Float>(x, y, -1))))
    }

    // MARK: - Camera modes

    /// Where your eye is: ARKit's camera, or the gyro camera in Ultra Wide.
    private var head: Transform {
        switch cameraMode {
        case .ar: return arView.cameraTransform
        case .ultraWide: return Transform(scale: .one, rotation: headCamera.orientation, translation: headCamera.position)
        }
    }

    private var headYaw: Float {
        let c2 = head.matrix.columns.2
        return atan2(c2.x, c2.z)
    }

    func setCameraMode(_ mode: CameraMode) {
        guard mode != cameraMode else { return }
        guard mode == .ar || ultra.isAvailable else {
            toast("No ultra wide camera on this iPhone")
            return
        }
        cameraMode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: Self.cameraModeKey)
        applyCameraMode()
        toast(mode == .ultraWide ? "Ultra Wide: windows float around you" : "AR: windows stay in your room")
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 800_000_000)
            self.recenter(quiet: true)
        }
    }

    private func applyCameraMode() {
        handGone()
        switch cameraMode {
        case .ar:
            ultra.stop()
            if headAnchor.scene != nil { arView.scene.removeAnchor(headAnchor) }
            arView.cameraMode = .ar
            arView.environment.background = .cameraFeed()
            coaching.activatesAutomatically = true
            arView.session.run(arConfig, options: [.resetTracking, .removeExistingAnchors])
        case .ultraWide:
            arView.session.pause()
            coaching.activatesAutomatically = false
            coaching.setActive(false, animated: false)
            if meshVisible { toggleMesh() }
            arView.cameraMode = .nonAR
            arView.environment.background = .color(.clear)
            if headAnchor.scene == nil { arView.scene.addAnchor(headAnchor) }
            headCamera.position = .zero
            ultra.setHandsEnabled(handsOn)
            ultra.start()
        }
        updateOcclusion()
    }

    private func updateHeadCamera() {
        guard let attitude = ultra.attitude() else { return }
        let orientation = arView.window?.windowScene?.interfaceOrientation ?? .landscapeRight
        headCamera.orientation = attitude * UltraWideCamera.screenRotation(orientation)
        ultra.setSensorOrientation(attitude * UltraWideCamera.screenRotation(.landscapeRight))
        let size = arView.bounds.size
        if size.width > 0, size.height > 0 {
            // The preview fills the screen, so match the visible part of the lens.
            let tanH = tan(ultra.horizontalFOV * .pi / 360)
            let tanV = tanH / max(Float(size.width / size.height), ultra.videoAspect)
            verticalFOV = 2 * atan(tanV)
            headCamera.camera.fieldOfViewInDegrees = verticalFOV * 180 / .pi
        }
        if orientation != previewOrientation {
            previewOrientation = orientation
            previewView.setRotation(for: orientation)
        }
    }

    // MARK: - Environments

    func setEnvironment(_ kind: EnvironmentKind?) {
        if let kind {
            applyEnvironment(kind)
            immersion = 1
        } else {
            environment = nil
            immersion = 0
        }
        refreshEnvironment()
    }

    /// The Digital Crown: 0 is your room, 1 is fully immersed.
    func setImmersion(_ value: Float) {
        let v = max(0, min(1, value))
        if v > 0, environment == nil { applyEnvironment(lastEnvironment) }
        immersion = v
        refreshEnvironment()
        ultra.showImmersion(v)
    }

    private func applyEnvironment(_ kind: EnvironmentKind) {
        if environmentTextures[kind] == nil, let image = kind.render(),
           let texture = try? TextureResource.generate(from: image, options: .init(semantic: .color)) {
            environmentTextures[kind] = texture
        }
        guard let texture = environmentTextures[kind] else {
            toast("Couldn't draw \(kind.title)")
            return
        }
        var material = UnlitMaterial()
        material.color = .init(tint: .white, texture: .init(texture))
        environmentMaterial = material
        environment = kind
        lastEnvironment = kind
        environmentYaw = headYaw
        builtArc = -1
    }

    /// Like visionOS, the environment opens up from in front of you and
    /// wraps all the way round as immersion goes up.
    private func refreshEnvironment() {
        let visible = environment != nil && immersion > 0.001
        if visible, let material = environmentMaterial {
            let arc = max(0.3, immersion * 2 * .pi)
            if abs(arc - builtArc) > 0.02, let mesh = Meshes.sphereSegment(radius: 20, arc: arc) {
                environmentEntity.model = ModelComponent(mesh: mesh, materials: [material])
                builtArc = arc
            }
            environmentEntity.orientation = simd_quatf(angle: environmentYaw, axis: SIMD3<Float>(0, 1, 0))
            environmentEntity.position = head.translation
            if environmentEntity.parent == nil { anchor.addChild(environmentEntity) }
        } else {
            environmentEntity.removeFromParent()
        }
        updateOcclusion()
    }

    func showEnvironments() {
        if !homeShown { showHome() }
        homeApp.show(.environments)
    }

    // MARK: - Panoramas

    /// Wraps a panorama around you on a curved wall, centred where you look.
    func showPanorama(_ image: UIImage) {
        guard let cg = image.cgImage,
              let texture = try? TextureResource.generate(from: cg, options: .init(semantic: .color)) else {
            toast("Couldn't open that panorama")
            return
        }
        let aspect = Float(image.size.width / max(image.size.height, 1))
        let verticalAngle: Float = 1.0
        let radius: Float = 2.6
        guard let mesh = Meshes.cylinderSegment(radius: radius, height: 2 * radius * tan(verticalAngle / 2),
                                                arc: min(2 * .pi, aspect * verticalAngle)) else { return }
        var material = UnlitMaterial()
        material.color = .init(tint: .white, texture: .init(texture))
        panoramaEntity.model = ModelComponent(mesh: mesh, materials: [material])
        panoramaEntity.position = head.translation
        panoramaEntity.orientation = simd_quatf(angle: headYaw, axis: SIMD3<Float>(0, 1, 0))
        if panoramaEntity.parent == nil { anchor.addChild(panoramaEntity) }
        panoramaShown = true
        updateOcclusion()
        toast("Look around. Press the Crown to leave.")
    }

    func hidePanorama() {
        panoramaEntity.removeFromParent()
        panoramaShown = false
        photosApp.dirty = true
        updateOcclusion()
    }

    /// LiDAR occlusion would let real walls poke through environments and panoramas.
    private func updateOcclusion() {
        guard hasLiDAR, cameraMode == .ar else { return }
        if environmentEntity.parent != nil || panoramaShown {
            arView.environment.sceneUnderstanding.options.remove(.occlusion)
        } else {
            arView.environment.sceneUnderstanding.options.insert(.occlusion)
        }
    }

    // MARK: - Camera Control as the Digital Crown

    /// Camera Control (and Volume Up, which iOS treats the same): click for
    /// Home, hold to recenter. Volume Down: Control Center. In Ultra Wide,
    /// light-press Camera Control and slide for immersion or environment.
    private func installCameraButton() {
        ultra.onImmersion = { [weak self] value in self?.setImmersion(value) }
        ultra.onEnvironment = { [weak self] index in
            let kinds = EnvironmentKind.allCases
            self?.setEnvironment(index > 0 && index <= kinds.count ? kinds[index - 1] : nil)
        }
        guard #available(iOS 17.2, *) else { return }
        let interaction = AVCaptureEventInteraction(primary: { [weak self] event in
            self?.hardwareButton(event.phase, primary: true)
        }, secondary: { [weak self] event in
            self?.hardwareButton(event.phase, primary: false)
        })
        arView.addInteraction(interaction)
    }

    @available(iOS 17.2, *)
    private func hardwareButton(_ phase: AVCaptureEventPhase, primary: Bool) {
        switch phase {
        case .began:
            buttonHeld = false
            guard primary else { return }
            let token = UUID()
            buttonToken = token
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 600_000_000)
                guard self.buttonToken == token else { return }
                self.buttonHeld = true
                self.recenter()
            }
        case .ended:
            buttonToken = nil
            guard !buttonHeld else { return }
            if primary { crownPressed() } else { controlCenterShown.toggle() }
        case .cancelled:
            buttonToken = nil
        @unknown default:
            break
        }
    }

    // MARK: - Digital Crown

    func crownPressed() {
        if panoramaShown {
            hidePanorama()
        } else {
            toggleHome()
        }
    }

    /// Long-press the Crown: bring everything back in front of you.
    func recenter(quiet: Bool = false) {
        bringWindowsHere(quiet: true)
        if environment != nil {
            environmentYaw = headYaw
            refreshEnvironment()
        }
        if panoramaShown {
            panoramaEntity.position = head.translation
            panoramaEntity.orientation = simd_quatf(angle: headYaw, axis: SIMD3<Float>(0, 1, 0))
        }
        if !quiet { toast("Recentered") }
    }

    // MARK: - Placement

    private func facing(_ position: SIMD3<Float>, _ cam: SIMD3<Float>) -> simd_quatf {
        let d = cam - position
        return simd_quatf(angle: atan2(d.x, d.z), axis: SIMD3<Float>(0, 1, 0))
    }

    /// Put a window in front of you, rotated `yawOffset` to the side.
    private func place(_ w: SpatialWindow, yawOffset: Float, distance: Float = 0.55) {
        let t = head
        let cam = t.translation
        let c2 = t.matrix.columns.2
        var forward = -SIMD3<Float>(c2.x, c2.y, c2.z)
        forward.y = max(-0.35, min(0.35, forward.y))
        forward = simd_normalize(forward)
        forward = simd_quatf(angle: yawOffset, axis: SIMD3<Float>(0, 1, 0)).act(forward)
        w.targetPosition = cam + forward * distance
        w.targetOrientation = facing(w.targetPosition, cam)
        w.onWall = false
    }

    private static let offsets: [Float] = [0, -0.72, 0.72, -1.44, 1.44, -2.1, 2.1]

    func open(_ kind: AppKind) {
        let app: SpatialApp
        switch kind {
        case .clock: app = clockApp
        case .calculator: app = calculatorApp
        case .notes: app = notesApp
        case .photos: app = photosApp
        case .weather: app = weatherApp
        case .safari: app = browserApp
        case .tips: app = tipsApp
        case .files:
            filesApp.refresh()
            app = filesApp
        }
        if let existing = windows.first(where: { $0.app === app }) {
            place(existing, yawOffset: 0)
            focused = existing
            return
        }
        let w = SpatialWindow(app: app)
        place(w, yawOffset: Self.offsets[min(windows.count, Self.offsets.count - 1)] * (homeShown ? 1 : 0.5))
        w.snapToTarget()
        anchor.addChild(w.root)
        windows.append(w)
        focused = w
        w.redraw()
        if homeShown { hideHome() }
    }

    func close(_ w: SpatialWindow) {
        if w === home {
            hideHome()
            return
        }
        w.app.didClose()
        w.root.removeFromParent()
        windows.removeAll { $0 === w }
        if focused === w { focused = windows.last }
        if case .pressing(let iw, _, _, _) = interaction, iw === w { interaction = .none }
        if case .poking(let iw, _, _) = interaction, iw === w { interaction = .none }
        if case .grabbing(let iw, _, _, _) = interaction, iw === w { interaction = .none }
    }

    func toggleHome() {
        homeShown ? hideHome() : showHome()
    }

    func showHome() {
        let w = home ?? SpatialWindow(app: homeApp)
        home = w
        place(w, yawOffset: 0, distance: 0.6)
        w.snapToTarget()
        if w.root.parent == nil { anchor.addChild(w.root) }
        w.needsRedraw = true
        homeShown = true
    }

    func hideHome() {
        home?.root.removeFromParent()
        homeShown = false
    }

    func bringWindowsHere(quiet: Bool = false) {
        for (i, w) in windows.enumerated() {
            place(w, yawOffset: Self.offsets[min(i, Self.offsets.count - 1)])
        }
        if homeShown, let home { place(home, yawOffset: 0, distance: 0.6) }
        if !quiet { toast("Windows moved in front of you") }
    }

    /// After you let go of a window near a wall or table, stick it there
    /// (LiDAR finds the surface).
    private func snapToSurface(_ w: SpatialWindow) {
        guard cameraMode == .ar else { return }
        let n = w.targetOrientation.act(SIMD3<Float>(0, 0, 1))
        let query = ARRaycastQuery(origin: w.targetPosition + n * 0.05, direction: -n, allowing: .estimatedPlane, alignment: .any)
        guard let result = arView.session.raycast(query).first else { return }
        let c3 = result.worldTransform.columns.3
        let c1 = result.worldTransform.columns.1
        let point = SIMD3<Float>(c3.x, c3.y, c3.z)
        guard simd_distance(point, w.targetPosition) < 0.18 else { return }
        var normal = simd_normalize(SIMD3<Float>(c1.x, c1.y, c1.z))
        if abs(normal.y) < 0.5 {
            if simd_dot(normal, n) < 0 { normal = -normal }
            normal.y = 0
            normal = simd_normalize(normal)
            w.targetPosition = point + normal * 0.004
            w.targetOrientation = simd_quatf(angle: atan2(normal.x, normal.z), axis: SIMD3<Float>(0, 1, 0))
            w.onWall = true
            toast("Placed on the wall")
        } else if normal.y > 0.8, point.y < w.targetPosition.y {
            w.targetPosition.y = point.y + w.heightM / 2 + 0.045
            toast("Standing on the surface")
        }
    }

    func toggleMesh() {
        guard cameraMode == .ar else {
            toast("The LiDAR mesh needs AR mode")
            return
        }
        meshVisible.toggle()
        if meshVisible {
            arView.debugOptions.insert(.showSceneUnderstanding)
        } else {
            arView.debugOptions.remove(.showSceneUnderstanding)
        }
        toast(meshVisible ? (hasLiDAR ? "Showing the LiDAR mesh" : "This iPhone has no LiDAR") : "Mesh hidden")
    }

    // MARK: - Bridges for apps and sheets

    func toast(_ text: String) {
        toastText = text
        toastTask?.cancel()
        toastTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if !Task.isCancelled { self?.toastText = nil }
        }
    }

    func addFolder(_ url: URL) {
        filesApp.addLocation(url)
        open(.files)
    }


    // MARK: - Voice

    func setVoice(_ on: Bool) {
        voiceOn = on
        UserDefaults.standard.set(!on, forKey: Self.voiceKey)
        if on {
            voice.start()
            toast("Listening. Say “what can I say” for ideas.")
        } else {
            voice.stop()
            toast("Voice is off. Turn it on in Control Center.")
        }
    }

    func browse(_ query: String) {
        open(.safari)
        browserApp.go(query)
    }

    private func app(for kind: AppKind) -> SpatialApp {
        switch kind {
        case .clock: return clockApp
        case .calculator: return calculatorApp
        case .notes: return notesApp
        case .photos: return photosApp
        case .weather: return weatherApp
        case .safari: return browserApp
        case .files: return filesApp
        case .tips: return tipsApp
        }
    }

    /// The words after the first `count` words of what was said, keeping
    /// dots and capitals ("go to BBC.co.uk" -> "BBC.co.uk").
    private static func tail(_ raw: String, dropping count: Int) -> String {
        raw.split(separator: " ").dropFirst(count).joined(separator: " ")
            .trimmingCharacters(in: CharacterSet(charactersIn: " .?!,"))
    }

    private func handleVoice(_ raw: String) {
        var t = VoiceControl.normalize(raw)
        var dropped = 0
        for prefix in ["hey vision ", "ok vision ", "okay vision ", "vision "] where t.hasPrefix(prefix) {
            t = String(t.dropFirst(prefix.count))
            dropped = prefix.split(separator: " ").count
        }
        guard !t.isEmpty, t.split(separator: " ").count <= 10 else { return }
        let rawTail = Self.tail(raw, dropping: dropped)
        if systemCommand(t, raw: rawTail) {
            toast("“\(rawTail)”")
            return
        }
        // Then the window you last used, then any other open window.
        var order: [SpatialWindow] = []
        if let focused, windows.contains(where: { $0 === focused }) { order.append(focused) }
        order += windows.reversed().filter { $0 !== focused }
        for w in order where w.app.handleVoice(t) {
            focused = w
            w.app.dirty = true
            toast("“\(rawTail)”")
            return
        }
    }

    private func systemCommand(_ t: String, raw: String) -> Bool {
        switch t {
        case "home", "go home", "show home", "home view", "open home", "home screen":
            if !homeShown { showHome() }
        case "hide home", "close home":
            hideHome()
        case "recenter", "re center", "recentre", "re centre", "center", "centre", "bring windows here", "come here", "bring it here", "bring them here":
            recenter(quiet: true)
        case "control center", "control centre", "open control center", "open control centre", "show control center", "show control centre":
            controlCenterShown = true
        case "close control center", "close control centre", "hide control center", "hide control centre":
            controlCenterShown = false
        case "ultra wide", "ultrawide", "ultra wide on", "ultra wide mode", "wide mode", "zoom out", "point five":
            setCameraMode(.ultraWide)
        case "ar mode", "ar", "normal camera", "main camera", "ultra wide off", "zoom in", "augmented reality":
            setCameraMode(.ar)
        case "hands on", "hand tracking on", "track my hands", "turn on hands":
            handsOn = true
        case "hands off", "hand tracking off", "stop tracking my hands", "turn off hands":
            handsOn = false
        case "show mesh", "mesh on", "lidar mesh", "show lidar", "show the mesh":
            if !meshVisible { toggleMesh() }
        case "hide mesh", "mesh off", "hide the mesh":
            if meshVisible { toggleMesh() }
        case "stop listening", "voice off", "turn off voice", "stop voice control":
            setVoice(false)
        case "environments", "show environments", "open environments":
            showEnvironments()
        case "my room", "exit environment", "leave environment", "environment off", "no environment", "back to my room", "close environment", "show my room":
            setEnvironment(nil)
        case "more immersion", "immerse more", "more immersive", "turn it up", "more", "crown up":
            setImmersion(immersion + 0.25)
        case "less immersion", "immerse less", "less immersive", "turn it down", "less", "crown down":
            setImmersion(immersion - 0.25)
        case "full immersion", "fully immersed", "all the way":
            setImmersion(1)
        case "close", "close window", "close this", "close it", "close this window":
            if let w = focused ?? windows.last { close(w) } else if homeShown { hideHome() }
        case "close all", "close everything", "close all windows":
            for w in windows { close(w) }
        case "exit panorama", "leave panorama", "close panorama":
            hidePanorama()
        case "what can i say", "help", "show commands", "voice commands", "what can you do":
            open(.tips)
        case "new note", "take a note", "make a note", "write a note":
            open(.notes)
            notesApp.newNote()
        default:
            return otherCommand(t, raw: raw)
        }
        return true
    }

    private func otherCommand(_ t: String, raw: String) -> Bool {
        let words = t.split(separator: " ").map(String.init)
        // Environments by name: "night sky", "go to the moon".
        for kind in EnvironmentKind.allCases {
            for name in kind.spokenNames where [name, "go to " + name, "open " + name, "show " + name, name + " environment", "take me to " + name].contains(t) {
                setEnvironment(kind)
                return true
            }
        }
        // Apps: "photos", "open photos", "close photos".
        if let kind = AppKind.named(t) {
            open(kind)
            return true
        }
        for verb in ["open ", "launch ", "show ", "start ", "go to ", "show me "] where t.hasPrefix(verb) {
            if let kind = AppKind.named(String(t.dropFirst(verb.count))) {
                open(kind)
                return true
            }
        }
        if t.hasPrefix("close "), let kind = AppKind.named(String(t.dropFirst(6))) {
            let target = app(for: kind)
            if let w = windows.first(where: { $0.app === target }) { close(w) }
            return true
        }
        // The web: "search for …", "google …", "go to apple.com".
        for prefix in ["search the web for ", "search for ", "look up ", "google ", "search ", "find "] where t.hasPrefix(prefix) {
            browse(Self.tail(raw, dropping: prefix.split(separator: " ").count))
            return true
        }
        if t.hasPrefix("go to "), raw.contains(".") || words.contains("dot") {
            browse(Self.tail(raw, dropping: 2))
            return true
        }
        return false
    }
}
