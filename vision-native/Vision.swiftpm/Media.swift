import AVFoundation
import RealityKit
import UIKit

/// Plays a video on a surface inside a window (RealityKit's VideoMaterial),
/// so nothing full-screen needs a touch to dismiss.
@MainActor
final class VideoSurface {
    let entity = ModelEntity()
    private(set) var player: AVPlayer?
    private var endObserver: NSObjectProtocol?

    var isPlaying: Bool { (player?.rate ?? 0) > 0 }
    var isActive: Bool { player != nil }

    init() {
        entity.isEnabled = false
    }

    /// Shows the video aspect-fit inside `rect` (window points). With a zero
    /// `videoSize` (audio), nothing is drawn but it still plays.
    func play(_ item: AVPlayerItem, videoSize: CGSize, in rect: CGRect, windowSize: CGSize) {
        stop()
        let player = AVPlayer(playerItem: item)
        self.player = player
        if videoSize.width > 0, videoSize.height > 0 {
            let mpp = SpatialWindow.metresPerPoint
            let scale = min(rect.width / videoSize.width, rect.height / videoSize.height)
            let w = Float(videoSize.width * scale) * mpp
            let h = Float(videoSize.height * scale) * mpp
            entity.model = ModelComponent(mesh: .generatePlane(width: w, height: h, cornerRadius: 0.006),
                                          materials: [VideoMaterial(avPlayer: player)])
            entity.position = SIMD3<Float>(Float(rect.midX - windowSize.width / 2) * mpp,
                                           Float(windowSize.height / 2 - rect.midY) * mpp, 0.003)
            entity.isEnabled = true
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak player] _ in
            player?.seek(to: .zero)
            player?.pause()
        }
        player.play()
    }

    func toggle() {
        guard let player else { return }
        if player.rate > 0 { player.pause() } else { player.play() }
    }

    func skip(_ seconds: Double) {
        guard let player else { return }
        let t = max(0, player.currentTime().seconds + seconds)
        player.seek(to: CMTime(seconds: t, preferredTimescale: 600))
    }

    func stop() {
        player?.pause()
        player = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        entity.isEnabled = false
        entity.model = nil
    }

    /// The upright size of a video file's picture, or zero for audio.
    static func naturalSize(of url: URL) async -> CGSize {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let loaded = try? await track.load(.naturalSize, .preferredTransform) else { return .zero }
        let r = CGRect(origin: .zero, size: loaded.0).applying(loaded.1)
        return CGSize(width: abs(r.width), height: abs(r.height))
    }
}
