import ARKit
import Vision
import simd
import QuartzCore

/// One hand observation, in world space (metres).
struct HandSample {
    var indexTip: SIMD3<Float>
    var thumbTip: SIMD3<Float>
    /// Thumb–index gap relative to hand size (2D), for phones without depth.
    var pinchRatio: Float
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
        r.maximumHandCount = 1
        return r
    }()

    /// Latest result and a counter that changes with every processed frame.
    func take() -> (HandSample?, Int) {
        lock.lock()
        defer { lock.unlock() }
        return (latest, sequence)
    }

    /// Call every frame from the main thread; frames arriving while the
    /// previous one is still being processed are skipped.
    func process(_ frame: ARFrame) {
        lock.lock()
        if busy || frame.timestamp == lastFrameTime {
            lock.unlock()
            return
        }
        busy = true
        lastFrameTime = frame.timestamp
        lock.unlock()

        // Copy what we need: holding on to ARFrames stalls ARKit.
        let pixelBuffer = frame.capturedImage
        let depth = frame.smoothedSceneDepth?.depthMap ?? frame.sceneDepth?.depthMap ?? frame.estimatedDepthData
        let intrinsics = frame.camera.intrinsics
        let cameraTransform = frame.camera.transform
        let resolution = frame.camera.imageResolution
        let time = frame.timestamp

        queue.async { [weak self] in
            guard let self else { return }
            let started = CACurrentMediaTime()
            var sample: HandSample?
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
            do {
                try handler.perform([self.request])
                if let observation = self.request.results?.first {
                    sample = Self.makeSample(observation, depth: depth, intrinsics: intrinsics,
                                             cameraTransform: cameraTransform, resolution: resolution, time: time)
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

    private static func makeSample(_ obs: VNHumanHandPoseObservation, depth: CVPixelBuffer?, intrinsics: simd_float3x3,
                                   cameraTransform: simd_float4x4, resolution: CGSize, time: TimeInterval) -> HandSample? {
        guard
            let tip = try? obs.recognizedPoint(.indexTip), tip.confidence > 0.3,
            let thumb = try? obs.recognizedPoint(.thumbTip), thumb.confidence > 0.3,
            let wrist = try? obs.recognizedPoint(.wrist),
            let middle = try? obs.recognizedPoint(.middleMCP)
        else { return nil }

        let w = Float(resolution.width)
        let h = Float(resolution.height)
        // Vision: normalized, origin bottom-left. Image pixels: origin top-left.
        func pixel(_ p: VNRecognizedPoint) -> SIMD2<Float> {
            SIMD2(Float(p.location.x) * w, (1 - Float(p.location.y)) * h)
        }
        let tipPx = pixel(tip)
        let thumbPx = pixel(thumb)
        let handSizePx = simd_distance(pixel(wrist), pixel(middle))
        let pinchRatio = simd_distance(tipPx, thumbPx) / max(handSizePx, 1)

        let fx = intrinsics[0][0]
        let fy = intrinsics[1][1]
        let cx = intrinsics[2][0]
        let cy = intrinsics[2][1]

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
        let thumbDepth = depthAt(thumb)

        func world(_ px: SIMD2<Float>, _ d: Float) -> SIMD3<Float> {
            // ARKit camera space: x right, y up, looking down -z.
            let c = SIMD4<Float>((px.x - cx) * d / fx, -(px.y - cy) * d / fy, -d, 1)
            let p = cameraTransform * c
            return SIMD3(p.x, p.y, p.z)
        }
        return HandSample(indexTip: world(tipPx, tipDepth), thumbTip: world(thumbPx, thumbDepth),
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
