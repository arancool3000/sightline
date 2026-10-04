import AVFoundation
import CoreMotion
import UIKit
import simd

/// The ultra wide camera plus the motion sensors, for when the view should be
/// as wide as possible.
///
/// ARKit only tracks the room with the main wide camera (its LiDAR depth and
/// motion fusion are calibrated to it, and it owns the camera while it runs),
/// so this mode trades room anchoring for field of view: the gyroscope turns
/// your view (3 degrees of freedom), and windows hang around you in a sphere.
final class UltraWideCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    let isAvailable: Bool
    let isUltraWide: Bool
    /// Horizontal field of view of the frames, in degrees.
    private(set) var horizontalFOV: Float = 104
    /// Width / height of the frames.
    private(set) var videoAspect: Float = 16.0 / 9.0
    /// Called on the capture queue for every frame while hands are enabled.
    var onFrame: ((CVPixelBuffer, TimeInterval) -> Void)?

    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "vision.ultrawide", qos: .userInteractive)
    private let motion = CMMotionManager()
    private let lock = NSLock()
    private var configured = false
    private var handsEnabled = true
    private var sensorOrientation = simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0))

    override init() {
        let ultra = AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back)
        isUltraWide = ultra != nil
        isAvailable = ultra != nil || AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
        super.init()
    }

    // MARK: Start / stop

    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            run()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted { DispatchQueue.main.async { self.run() } }
            }
        default:
            break
        }
    }

    func stop() {
        motion.stopDeviceMotionUpdates()
        queue.async { self.session.stopRunning() }
    }

    private func run() {
        if !configured { configure() }
        if motion.isDeviceMotionAvailable {
            motion.deviceMotionUpdateInterval = 1.0 / 120
            motion.startDeviceMotionUpdates(using: .xArbitraryZVertical)
        }
        queue.async { self.session.startRunning() }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device)
        else { return }
        session.beginConfiguration()
        if session.canSetSessionPreset(.hd1920x1080) { session.sessionPreset = .hd1920x1080 }
        if session.canAddInput(input) { session.addInput(input) }
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()

        horizontalFOV = device.activeFormat.videoFieldOfView
        let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        if dims.height > 0 { videoAspect = Float(dims.width) / Float(dims.height) }
        configured = true
    }

    // MARK: Orientation

    /// The phone's orientation in RealityKit's world (y up), or nil before the
    /// first sensor reading.
    func attitude() -> simd_quatf? {
        guard let q = motion.deviceMotion?.attitude.quaternion else { return nil }
        let device = simd_quatf(ix: Float(q.x), iy: Float(q.y), iz: Float(q.z), r: Float(q.w))
        return Self.worldFromReference * device
    }

    /// Core Motion's reference frame has z up; RealityKit's world has y up.
    private static let worldFromReference = simd_quatf(angle: -.pi / 2, axis: SIMD3<Float>(1, 0, 0))

    /// Rotates camera axes (x right, y up on screen) into the phone's axes
    /// for a landscape screen. The camera sensor's own frames are always in
    /// the `.landscapeRight` layout (home side on the right).
    static func screenRotation(_ orientation: UIInterfaceOrientation) -> simd_quatf {
        simd_quatf(angle: orientation == .landscapeLeft ? .pi / 2 : -.pi / 2, axis: SIMD3<Float>(0, 0, 1))
    }

    func setSensorOrientation(_ q: simd_quatf) {
        lock.lock()
        sensorOrientation = q
        lock.unlock()
    }

    func setHandsEnabled(_ on: Bool) {
        lock.lock()
        handsEnabled = on
        lock.unlock()
    }

    /// Intrinsics for a frame, from the lens's field of view.
    func cameraModel(for buffer: CVPixelBuffer) -> CameraModel {
        let w = Float(CVPixelBufferGetWidth(buffer))
        let h = Float(CVPixelBufferGetHeight(buffer))
        let fx = (w / 2) / tan(horizontalFOV * .pi / 360)
        lock.lock()
        let q = sensorOrientation
        lock.unlock()
        return CameraModel(fx: fx, fy: fx, cx: w / 2, cy: h / 2,
                           resolution: CGSize(width: CGFloat(w), height: CGFloat(h)), transform: simd_float4x4(q))
    }

    // MARK: Frames

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        lock.lock()
        let enabled = handsEnabled
        lock.unlock()
        guard enabled, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        onFrame?(buffer, CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds)
    }
}

/// Full-screen live view of the ultra wide camera, behind the 3D content.
final class CameraPreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

    init(session: AVCaptureSession) {
        super.init(frame: .zero)
        previewLayer.session = session
        previewLayer.videoGravity = .resizeAspectFill
        backgroundColor = .black
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func setRotation(for orientation: UIInterfaceOrientation) {
        let angle: CGFloat = orientation == .landscapeLeft ? 180 : 0
        if let c = previewLayer.connection, c.isVideoRotationAngleSupported(angle) {
            c.videoRotationAngle = angle
        }
    }
}
