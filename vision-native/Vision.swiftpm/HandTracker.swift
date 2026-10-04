import ARKit
import Vision
import simd
import QuartzCore

/// Pinhole model of the camera a frame came from: intrinsics in pixels and
/// the camera's pose in the world (ARKit's, or the motion sensors' in Ultra Wide).
struct CameraModel {
    var fx: Float
    var fy: Float
    var cx: Float
    var cy: Float
    var resolution: CGSize
    var transform: simd_float4x4
}

/// One hand observation, in world space (metres).
struct HandSample {
    var indexTip: SIMD3<Float>
    /// Nil when the thumb is hidden (often behind the index finger mid-pinch).
    var thumbTip: SIMD3<Float>?
    /// Thumb–index gap relative to hand size (2D); nil when the thumb is hidden.
    var pinchRatio: Float?
    /// True when the 3D positions come from LiDAR / people-depth, not a guess.
    var measuredDepth: Bool
    var time: TimeInterval
}

/// Hand tracking with Apple's Vision framework (runs on the Neural Engine),
/// lifted into 3D with LiDAR depth: each fingertip's distance is read from the
/// depth map at that pixel, so you get true metric positions in the room.
///
/// Work happens on a background queue; the main thread just polls `latest`.
final class HandTracker: @unchecked Sendable {
    private let queue = DispatchQueue(label: "vision.hands", qos: .userInteractive)
    private let lock = NSLock()
    private var busy = false
    private var latest: HandSample?
    private var sequence = 0
    private var lastFrameTime: TimeInterval = 0
    private(set) var fps: Double = 0
    private let request: VNDetectHumanHandPoseRequest = {
        let r = VNDetectHumanHandPoseRequest()
        // Two, so a second hand coming into view can't steal the cursor: we
        // keep following the one nearest where the last one was.
        r.maximumHandCount = 2
        return r
    }()
    /// Last chosen index fingertip in the image (Vision's normalized space). Queue only.
    private var lastTip2D: CGPoint?

    /// Latest result and a counter that changes with every processed frame.
    func take() -> (HandSample?, Int) {
        lock.lock()
        defer { lock.unlock() }
        return (latest, sequence)
    }

    /// Call every frame from the main thread; frames arriving while the
    /// previous one is still being processed are skipped.
    func process(_ frame: ARFrame) {
        // Copy what we need: holding on to ARFrames stalls ARKit.
        let intrinsics = frame.camera.intrinsics
        let camera = CameraModel(fx: intrinsics[0][0], fy: intrinsics[1][1], cx: intrinsics[2][0], cy: intrinsics[2][1],
                                 resolution: frame.camera.imageResolution, transform: frame.camera.transform)
        let depth = frame.smoothedSceneDepth?.depthMap ?? frame.sceneDepth?.depthMap ?? frame.estimatedDepthData
        process(pixelBuffer: frame.capturedImage, depth: depth, camera: camera, time: frame.timestamp)
    }

    /// Any camera: the image in the sensor's native orientation, optional
    /// metric depth, and where the camera was. Safe to call from any thread.
    func process(pixelBuffer: CVPixelBuffer, depth: CVPixelBuffer?, camera: CameraModel, time: TimeInterval) {
        lock.lock()
        if busy || time == lastFrameTime {
            lock.unlock()
            return
        }
        busy = true
        lastFrameTime = time
        lock.unlock()

        queue.async { [weak self] in
            guard let self else { return }
            let started = CACurrentMediaTime()
            var sample: HandSample?
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
            do {
                try handler.perform([self.request])
                if let observation = Self.pick(self.request.results ?? [], near: self.lastTip2D) {
                    sample = Self.makeSample(observation, depth: depth, camera: camera, time: time)
                    self.lastTip2D = (try? observation.recognizedPoint(.indexTip))?.location
                } else {
                    self.lastTip2D = nil
                }
            } catch {
                sample = nil
            }
            let elapsed = CACurrentMediaTime() - started
            self.lock.lock()
            self.latest = sample
            self.sequence += 1
            self.busy = false
            self.fps = 0.9 * self.fps + 0.1 * (1 / max(elapsed, 1.0 / 120))
            self.lock.unlock()
        }
    }

    /// The hand to follow: nearest the previous fingertip, else the most confident.
    private static func pick(_ observations: [VNHumanHandPoseObservation], near last: CGPoint?) -> VNHumanHandPoseObservation? {
        let usable = observations.compactMap { obs -> (VNHumanHandPoseObservation, VNRecognizedPoint)? in
            guard let tip = try? obs.recognizedPoint(.indexTip), tip.confidence > 0.3 else { return nil }
            return (obs, tip)
        }
        if let last {
            return usable.min { hypot($0.1.location.x - last.x, $0.1.location.y - last.y) < hypot($1.1.location.x - last.x, $1.1.location.y - last.y) }?.0
        }
        return usable.max { $0.1.confidence < $1.1.confidence }?.0
    }

    private static func makeSample(_ obs: VNHumanHandPoseObservation, depth: CVPixelBuffer?, camera: CameraModel,
                                   time: TimeInterval) -> HandSample? {
        guard
            let tip = try? obs.recognizedPoint(.indexTip), tip.confidence > 0.3,
            let wrist = try? obs.recognizedPoint(.wrist),
            let middle = try? obs.recognizedPoint(.middleMCP)
        else { return nil }

        let w = Float(camera.resolution.width)
        let h = Float(camera.resolution.height)
        // Vision: normalized, origin bottom-left. Image pixels: origin top-left.
        func pixel(_ p: VNRecognizedPoint) -> SIMD2<Float> {
            SIMD2(Float(p.location.x) * w, (1 - Float(p.location.y)) * h)
        }
        let thumb = (try? obs.recognizedPoint(.thumbTip)).flatMap { $0.confidence > 0.3 ? $0 : nil }
        let tipPx = pixel(tip)
        let handSizePx = simd_distance(pixel(wrist), pixel(middle))
        let pinchRatio = thumb.map { simd_distance(tipPx, pixel($0)) / max(handSizePx, 1) }

        let fx = camera.fx
        let fy = camera.fy
        let cx = camera.cx
        let cy = camera.cy

        // Distance to each fingertip: LiDAR depth where available, otherwise
        // from the hand's apparent size (wrist→knuckle ≈ 9 cm).
        let estimated = fx * 0.09 / max(handSizePx, 1)
        var measured = false
        func depthAt(_ p: VNRecognizedPoint) -> Float {
            if let depth, let d = Self.sampleDepth(depth, u: Float(p.location.x), v: 1 - Float(p.location.y)),
               d > 0.08, d < 1.6, abs(d - estimated) < max(0.25, estimated * 0.8) {
                measured = true
                return d
            }
            return estimated
        }
        let tipDepth = depthAt(tip)

        func world(_ px: SIMD2<Float>, _ d: Float) -> SIMD3<Float> {
            // ARKit camera space: x right, y up, looking down -z.
            let c = SIMD4<Float>((px.x - cx) * d / fx, -(px.y - cy) * d / fy, -d, 1)
            let p = camera.transform * c
            return SIMD3(p.x, p.y, p.z)
        }
        let thumbTip = thumb.map { world(pixel($0), depthAt($0)) }
        return HandSample(indexTip: world(tipPx, tipDepth), thumbTip: thumbTip,
                          pinchRatio: pinchRatio, measuredDepth: measured, time: time)
    }

    /// Robust depth lookup: the near end (25th percentile) of a small window,
    /// so a fingertip edge doesn't read the wall behind it.
    private static func sampleDepth(_ buffer: CVPixelBuffer, u: Float, v: Float) -> Float? {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let cxp = Int(u * Float(width))
        let cyp = Int(v * Float(height))
        var values: [Float] = []
        values.reserveCapacity(25)
        for dy in -2...2 {
            for dx in -2...2 {
                let x = cxp + dx
                let y = cyp + dy
                guard x >= 0, y >= 0, x < width, y < height else { continue }
                let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: Float32.self)
                let d = row[x]
                if d.isFinite && d > 0 { values.append(d) }
            }
        }
        guard values.count >= 4 else { return nil }
        values.sort()
        return values[values.count / 4]
    }
}

/// Makes up for glitchy detections before anything acts on them:
/// - drops a fingertip that jumps impossibly far in one frame,
/// - pinch needs the same answer on two detections in a row to start or end,
///   with separate start/stop thresholds, and a hidden thumb keeps the
///   current state instead of letting go,
/// - remembers recent aim, because closing a pinch drags the fingertip down.
struct HandStabilizer {
    private(set) var pinched = false
    private var flips = 0
    private var last: HandSample?
    private var rejected = 0

    /// False if the sample was thrown away as a glitch.
    mutating func accept(_ s: HandSample) -> Bool {
        if let last, s.time > last.time, s.time - last.time < 0.15 {
            let speed = simd_distance(s.indexTip, last.indexTip) / Float(s.time - last.time)
            // Hands don't move 3 m/s while pointing; give up after a few in
            // a row in case the hand really did move.
            if speed > 3, rejected < 3 {
                rejected += 1
                return false
            }
        }
        rejected = 0
        last = s
        var raw = pinched
        if let r = s.pinchRatio {
            if pinched {
                raw = r < 0.55
            } else {
                var start = r < 0.3
                if s.measuredDepth, let thumb = s.thumbTip { start = start && simd_distance(thumb, s.indexTip) < 0.06 }
                raw = start
            }
        }
        if raw != pinched {
            flips += 1
            if flips >= 2 {
                pinched = raw
                flips = 0
            }
        } else {
            flips = 0
        }
        return true
    }

    mutating func reset() {
        pinched = false
        flips = 0
        last = nil
        rejected = 0
    }
}

/// One Euro filter: smooth when still, responsive when moving.
struct OneEuro {
    var minCutoff: Float
    var beta: Float
    var dCutoff: Float = 1
    private var value: Float?
    private var derivative: Float = 0

    init(minCutoff: Float, beta: Float) {
        self.minCutoff = minCutoff
        self.beta = beta
    }

    private static func alpha(_ cutoff: Float, _ dt: Float) -> Float {
        let tau = 1 / (2 * Float.pi * cutoff)
        return 1 / (1 + tau / dt)
    }

    mutating func filter(_ x: Float, dt: Float) -> Float {
        guard let prev = value, dt > 0 else {
            value = x
            return x
        }
        let dx = (x - prev) / dt
        derivative += OneEuro.alpha(dCutoff, dt) * (dx - derivative)
        let cutoff = minCutoff + beta * abs(derivative)
        let next = prev + OneEuro.alpha(cutoff, dt) * (x - prev)
        value = next
        return next
    }

    mutating func reset() {
        value = nil
        derivative = 0
    }
}

struct OneEuro3 {
    private var x: OneEuro
    private var y: OneEuro
    private var z: OneEuro

    init(minCutoff: Float, beta: Float) {
        let f = OneEuro(minCutoff: minCutoff, beta: beta)
        x = f
        y = f
        z = f
    }

    mutating func filter(_ v: SIMD3<Float>, dt: Float) -> SIMD3<Float> {
        SIMD3(x.filter(v.x, dt: dt), y.filter(v.y, dt: dt), z.filter(v.z, dt: dt))
    }

    mutating func reset() {
        x.reset()
        y.reset()
        z.reset()
    }
}
