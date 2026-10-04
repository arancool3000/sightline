import SwiftUI
import UIKit
import CoreLocation
import Photos
import QuickLookThumbnailing
import UniformTypeIdentifiers
import ImageIO
import RealityKit
import PDFKit
import AVFoundation

extension SpatialApp {
    func tick(_ now: Date) {}
}

// MARK: - Home

@MainActor
final class HomeApp: SpatialApp {
    let title = "Home"
    let size = CGSize(width: 640, height: 400)
    var hasChrome: Bool { false }
    var dirty = true
    weak var spatial: Spatial?

    enum Tab: Int { case apps, environments }
    private var tab: Tab = .apps

    init(spatial: Spatial) {
        self.spatial = spatial
    }

    func show(_ tab: Tab) {
        self.tab = tab
        dirty = true
    }

    func nodes() -> [UINode] {
        struct Item {
            let id: String
            let symbol: String
            let colors: [Color]
            let title: String
            let action: () -> Void
        }
        let s = spatial
        let items: [Item]
        switch tab {
        case .apps:
            items = [
                Item(id: "safari", symbol: "safari.fill", colors: [Color(red: 0.2, green: 0.7, blue: 1), Color.blue], title: "Safari") { s?.open(.safari) },
                Item(id: "photos", symbol: "photo.on.rectangle.angled", colors: [Color.pink, Color.purple], title: "Photos") { s?.open(.photos) },
                Item(id: "files", symbol: "folder.fill", colors: [Color(red: 0.35, green: 0.65, blue: 1), Color(red: 0.1, green: 0.35, blue: 0.85)], title: "Files") { s?.open(.files) },
                Item(id: "notes", symbol: "note.text", colors: [Color.yellow, Color.orange], title: "Notes") { s?.open(.notes) },
                Item(id: "weather", symbol: "cloud.sun.fill", colors: [Color.cyan, Color.blue], title: "Weather") { s?.open(.weather) },
                Item(id: "clock", symbol: "clock.fill", colors: [Color(white: 0.3), Color(white: 0.1)], title: "Clock") { s?.open(.clock) },
                Item(id: "calc", symbol: "plus.forwardslash.minus", colors: [Color.orange, Color(red: 0.8, green: 0.35, blue: 0)], title: "Calculator") { s?.open(.calculator) },
                Item(id: "tips", symbol: "lightbulb.fill", colors: [Color.yellow, Color(red: 0.9, green: 0.6, blue: 0)], title: "Tips") { s?.open(.tips) },
            ]
        case .environments:
            items = [Item(id: "env-room", symbol: "house.fill", colors: [Color(white: 0.5), Color(white: 0.2)], title: "Your Room") { s?.setEnvironment(nil) }]
                + EnvironmentKind.allCases.map { kind in
                    Item(id: "env-\(kind.rawValue)", symbol: kind.symbol, colors: kind.colors, title: kind.title) { s?.setEnvironment(kind) }
                }
        }
        // The visionOS tab bar ornament on the left.
        var list = Look.ornament("tab", symbols: ["square.grid.2x2.fill", "mountain.2.fill"], selected: tab.rawValue, x: 0, centerY: size.height / 2) { [weak self] i in
            self?.show(Tab(rawValue: i) ?? .apps)
        }
        // Icons float on their own in staggered rows, like the Home View.
        let rows = [4, 3, 4]
        var index = 0
        for (r, count) in rows.enumerated() {
            let startX = 96 + CGFloat(4 - count) * 64
            for c in 0..<count where index < items.count {
                let item = items[index]
                index += 1
                list.append(Look.appIcon(item.id, symbol: item.symbol, colors: item.colors, title: item.title,
                                         at: CGPoint(x: startX + CGFloat(c) * 128 + 18, y: 12 + CGFloat(r) * 126), action: item.action))
            }
        }
        return list
    }
}

// MARK: - Clock

@MainActor
final class ClockApp: SpatialApp {
    let title = "Clock"
    let size = CGSize(width: 560, height: 300)
    var dirty = true
    private var lastSecond = -1
    private let cities: [(String, String)] = [("Cupertino", "America/Los_Angeles"), ("New York", "America/New_York"), ("London", "Europe/London"), ("Tokyo", "Asia/Tokyo")]

    func tick(_ now: Date) {
        let s = Calendar.current.component(.second, from: now)
        if s != lastSecond {
            lastSecond = s
            dirty = true
        }
    }

    func nodes() -> [UINode] {
        let now = Date()
        let time = DateFormatter()
        time.timeStyle = .medium
        time.dateStyle = .none
        let date = DateFormatter()
        date.dateFormat = "EEEE, d MMMM"
        var list: [UINode] = [
            Look.label("time", time.string(from: now), CGRect(x: 30, y: 26, width: 500, height: 90), size: 72, weight: .thin, align: .center),
            Look.label("date", date.string(from: now), CGRect(x: 30, y: 116, width: 500, height: 30), size: 20, weight: .medium, color: .white.opacity(0.7), align: .center),
        ]
        for (i, city) in cities.enumerated() {
            let f = DateFormatter()
            f.timeZone = TimeZone(identifier: city.1)
            f.dateFormat = "HH:mm"
            let x = 30 + CGFloat(i) * 125
            list.append(UINode("city\(i)", CGRect(x: x, y: 178, width: 115, height: 92)) {
                VStack(spacing: 4) {
                    Text(f.string(from: now)).font(.system(size: 28, weight: .light)).foregroundStyle(.white)
                    Text(city.0).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.08)))
            })
        }
        return list
    }
}

// MARK: - Calculator

@MainActor
final class CalculatorApp: SpatialApp {
    let title = "Calculator"
    let size = CGSize(width: 330, height: 500)
    var dirty = true
    private var current = "0"
    private var accumulator: Double?
    private var op: String?
    private var fresh = true

    private let keys: [[String]] = [["AC", "±", "%", "÷"], ["7", "8", "9", "×"], ["4", "5", "6", "−"], ["1", "2", "3", "+"], ["0", ".", "="]]

    func nodes() -> [UINode] {
        var list: [UINode] = [
            Look.label("display", format(Double(current) ?? 0, raw: current), CGRect(x: 20, y: 30, width: 290, height: 80), size: 58, weight: .light, align: .trailing),
        ]
        let keySize: CGFloat = 64
        let gap: CGFloat = 10
        for (r, row) in keys.enumerated() {
            var x: CGFloat = 22
            for k in row {
                let wide = k == "0"
                let w = wide ? keySize * 2 + gap : keySize
                let frame = CGRect(x: x, y: 128 + CGFloat(r) * (keySize + gap), width: w, height: keySize)
                let isOp = ["÷", "×", "−", "+", "="].contains(k)
                let isFn = ["AC", "±", "%"].contains(k)
                let label = k == "AC" && !(current == "0" && fresh) ? "C" : k
                let lit = isOp && fresh && op == k
                list.append(UINode("k\(k)", frame, radius: keySize / 2, action: { [weak self] in self?.press(k) }) {
                    Text(label)
                        .font(.system(size: isOp ? 30 : 26, weight: .medium))
                        .foregroundStyle(lit ? Color.orange : Color.white)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: wide ? .leading : .center)
                        .padding(.leading, wide ? 24 : 0)
                        .background(Capsule().fill(lit ? Color.white : isOp ? Color.orange : isFn ? Color.white.opacity(0.35) : Color.white.opacity(0.16)))
                })
                x += w + gap
            }
        }
        return list
    }

    private func apply(_ a: Double, _ b: Double, _ o: String) -> Double {
        switch o {
        case "+": return a + b
        case "−": return a - b
        case "×": return a * b
        case "÷": return a / b
        default: return b
        }
    }

    private func press(_ k: String) {
        let value = Double(current) ?? 0
        switch k {
        case "0"..."9" where k.count == 1:
            current = (fresh || current == "0") ? k : String((current + k).prefix(15))
            fresh = false
        case ".":
            if fresh {
                current = "0."
                fresh = false
            } else if !current.contains(".") {
                current += "."
            }
        case "AC":
            if current != "0" && !fresh {
                current = "0"
                fresh = true
            } else {
                current = "0"
                accumulator = nil
                op = nil
                fresh = true
            }
        case "±":
            if fresh && op != nil {
                current = "-0"
                fresh = false
            } else {
                current = current.hasPrefix("-") ? String(current.dropFirst()) : "-" + current
            }
        case "%":
            if let a = accumulator, op == "+" || op == "−" {
                current = clean(a * value / 100)
            } else {
                current = clean(value / 100)
            }
            fresh = true
        case "=":
            if let a = accumulator, let o = op {
                current = clean(apply(a, value, o))
                accumulator = nil
                op = nil
                fresh = true
            }
        default:
            if let a = accumulator, let o = op, !fresh {
                current = clean(apply(a, value, o))
            }
            accumulator = Double(current) ?? 0
            op = k
            fresh = true
        }
        dirty = true
    }

    private func clean(_ v: Double) -> String {
        guard v.isFinite else { return "Error" }
        if v == v.rounded() && abs(v) < 1e15 { return String(Int64(v)) }
        return String(format: "%.10g", v)
    }

    private func format(_ v: Double, raw: String) -> String {
        if raw == "Error" { return raw }
        if raw.hasSuffix(".") || (raw.contains(".") && raw.hasSuffix("0")) { return raw }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 8
        return f.string(from: NSNumber(value: v)) ?? raw
    }
}

// MARK: - Photos (your whole library)

@MainActor
final class PhotosApp: SpatialApp {
    let title = "Photos"
    let size = CGSize(width: 780, height: 480)
    var glassRect: CGRect { CGRect(x: 96, y: 0, width: 684, height: 480) }
    var dirty = true
    weak var spatial: Spatial?

    enum Tab: Int, CaseIterable {
        case library, favorites, panoramas, videos
        var title: String {
            switch self {
            case .library: return "Library"
            case .favorites: return "Favorites"
            case .panoramas: return "Panoramas"
            case .videos: return "Videos"
            }
        }
        var symbol: String {
            switch self {
            case .library: return "photo.on.rectangle"
            case .favorites: return "heart.fill"
            case .panoramas: return "pano.fill"
            case .videos: return "video.fill"
            }
        }
    }

    private var tab: Tab = .library
    private var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    private var assets: PHFetchResult<PHAsset>?
    private var thumbs: [String: UIImage] = [:]
    private var requested: Set<String> = []
    private var page = 0
    private var viewing: Int?
    private var full: UIImage?
    private var fullID: String?
    private var started = false
    private let manager = PHCachingImageManager()
    private let perPage = 15
    private let video = VideoSurface()
    private var videoFor: String?

    var attachment: Entity? { video.entity }

    init(spatial: Spatial) {
        self.spatial = spatial
    }

    func didClose() {
        stopVideo()
    }

    private func stopVideo() {
        video.stop()
        videoFor = nil
    }

    /// The part of the viewer a video plays in (controls sit below it).
    private var videoRect: CGRect {
        let g = glassRect
        return CGRect(x: g.minX + 20, y: 80, width: g.width - 40, height: g.height - 80 - 80)
    }

    private func playVideo(_ asset: PHAsset) {
        let id = asset.localIdentifier
        guard videoFor != id else { return }
        stopVideo()
        videoFor = id
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .automatic
        let size = CGSize(width: asset.pixelWidth, height: asset.pixelHeight)
        PHImageManager.default().requestPlayerItem(forVideo: asset, options: options) { [weak self] item, _ in
            guard let item else { return }
            Task { @MainActor in
                guard let self, self.videoFor == id else { return }
                self.video.play(item, videoSize: size, in: self.videoRect, windowSize: self.size)
                self.dirty = true
            }
        }
    }

    func handleVoice(_ t: String) -> Bool {
        switch t {
        case "next", "next photo", "next video", "next one": if viewing != nil { step(1) } else { turnPage(1) }
        case "previous", "previous photo", "previous video", "back one", "last one": if viewing != nil { step(-1) } else { turnPage(-1) }
        case "page down", "scroll down", "more", "down": turnPage(1)
        case "page up", "scroll up", "up": turnPage(-1)
        case "back", "go back", "close photo", "all photos":
            stopVideo()
            viewing = nil
            full = nil
            fullID = nil
        case "first", "open first", "first photo", "show first", "open it", "open":
            if assets?.count ?? 0 > 0 { viewing = page * perPage }
        case "library", "all", "show library": select(.library)
        case "favorites", "favourites", "show favorites", "show favourites": select(.favorites)
        case "panoramas", "panorama", "show panoramas": select(.panoramas)
        case "videos", "show videos": select(.videos)
        case "play", "pause", "stop", "resume", "play video", "pause video": video.toggle()
        case "skip", "forward", "skip forward": video.skip(15)
        case "rewind", "skip back": video.skip(-15)
        case "immerse", "stand inside", "go inside", "enter panorama":
            if let i = viewing, let assets, i < assets.count, assets.object(at: i).mediaSubtypes.contains(.photoPanorama) { immerse(assets.object(at: i)) } else { return false }
        default:
            // "open 3" / "photo 3": the number on the current page.
            let parts = t.split(separator: " ")
            if parts.count == 2, ["open", "photo", "video", "show", "number"].contains(String(parts[0])),
               let n = Self.number(String(parts[1])), n >= 1, n <= perPage, let assets, page * perPage + n - 1 < assets.count {
                viewing = page * perPage + n - 1
                return true
            }
            return false
        }
        dirty = true
        return true
    }

    static func number(_ word: String) -> Int? {
        if let n = Int(word) { return n }
        let words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"]
        return words.firstIndex(of: word).map { $0 + 1 }
    }

    private func turnPage(_ d: Int) {
        guard let assets else { return }
        let pages = max(1, (assets.count + perPage - 1) / perPage)
        page = max(0, min(pages - 1, page + d))
    }

    func tick(_ now: Date) {
        guard !started else { return }
        started = true
        if status == .notDetermined {
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] newStatus in
                Task { @MainActor in
                    self?.status = newStatus
                    self?.reload()
                }
            }
        } else {
            reload()
        }
    }

    private func select(_ t: Tab) {
        stopVideo()
        tab = t
        reload()
    }

    private func reload() {
        page = 0
        viewing = nil
        full = nil
        dirty = true
        guard status == .authorized || status == .limited else { return }
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        switch tab {
        case .library:
            assets = PHAsset.fetchAssets(with: options)
        case .favorites:
            options.predicate = NSPredicate(format: "favorite == YES")
            assets = PHAsset.fetchAssets(with: options)
        case .panoramas:
            options.predicate = NSPredicate(format: "(mediaSubtypes & %d) != 0", Int(PHAssetMediaSubtype.photoPanorama.rawValue))
            assets = PHAsset.fetchAssets(with: .image, options: options)
        case .videos:
            assets = PHAsset.fetchAssets(with: .video, options: options)
        }
        if thumbs.count > 400 {
            thumbs.removeAll()
            requested.removeAll()
        }
    }

    private func thumbnail(_ asset: PHAsset) -> UIImage? {
        let id = asset.localIdentifier
        if let image = thumbs[id] { return image }
        if requested.insert(id).inserted {
            let options = PHImageRequestOptions()
            options.deliveryMode = .opportunistic
            options.resizeMode = .fast
            options.isNetworkAccessAllowed = true
            manager.requestImage(for: asset, targetSize: CGSize(width: 240, height: 240), contentMode: .aspectFill, options: options) { [weak self] image, _ in
                guard let image else { return }
                Task { @MainActor in
                    self?.thumbs[id] = image
                    self?.dirty = true
                }
            }
        }
        return nil
    }

    private func loadFull(_ asset: PHAsset) {
        let id = asset.localIdentifier
        guard fullID != id else { return }
        fullID = id
        full = nil
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true
        manager.requestImage(for: asset, targetSize: CGSize(width: 1800, height: 1800), contentMode: .aspectFit, options: options) { [weak self] image, _ in
            guard let image else { return }
            Task { @MainActor in
                guard let self, self.fullID == id else { return }
                self.full = image
                self.dirty = true
            }
        }
    }

    /// Wraps a panorama around you, at full resolution.
    private func immerse(_ asset: PHAsset) {
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true
        let aspect = CGFloat(asset.pixelWidth) / CGFloat(max(asset.pixelHeight, 1))
        let width = min(8192, CGFloat(asset.pixelWidth))
        spatial?.toast("Opening panorama…")
        manager.requestImage(for: asset, targetSize: CGSize(width: width, height: width / aspect), contentMode: .aspectFit, options: options) { [weak self] image, info in
            let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
            guard let image, !degraded else { return }
            Task { @MainActor in
                self?.spatial?.showPanorama(image)
                self?.dirty = true
            }
        }
    }

    private static func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    private func message(_ title: String, _ detail: String) -> UINode {
        let g = glassRect
        return UINode("message", CGRect(x: g.minX + 40, y: 110, width: g.width - 80, height: 180)) {
            VStack(spacing: 10) {
                Image(systemName: "photo.on.rectangle.angled").font(.system(size: 44)).foregroundStyle(.white.opacity(0.7))
                Text(title).font(.system(size: 21, weight: .semibold)).foregroundStyle(.white)
                Text(detail).font(.system(size: 15)).foregroundStyle(.white.opacity(0.65)).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    func nodes() -> [UINode] {
        let g = glassRect
        var list = Look.ornament("tab", symbols: Tab.allCases.map(\.symbol), selected: tab.rawValue, x: 14, centerY: size.height / 2) { [weak self] i in
            self?.select(Tab(rawValue: i) ?? .library)
        }
        switch status {
        case .authorized, .limited:
            break
        case .notDetermined:
            list.append(message("Allow access to your photos", "Choose Allow Full Access to see your whole library here."))
            return list
        default:
            list.append(message("Photos access is off", "Turn it on in Settings ▸ Vision ▸ Photos ▸ Full Access."))
            list.append(Look.pill("settings", "Open Settings", CGRect(x: g.midX - 90, y: 310, width: 180, height: 46), fill: .white, textColor: .black) {
                Self.openSettings()
            })
            return list
        }
        guard let assets else { return list }
        if let i = viewing, i < assets.count {
            return list + viewer(assets.object(at: i))
        }

        list.append(Look.label("title", tab.title, CGRect(x: g.minX + 28, y: 22, width: 220, height: 40), size: 28, weight: .bold))
        list.append(Look.label("count", "\(assets.count) items", CGRect(x: g.minX + 28, y: 58, width: 220, height: 18), size: 13, color: .white.opacity(0.6)))
        if status == .limited {
            list.append(Look.pill("full", "Allow Full Access", CGRect(x: g.maxX - 320, y: 24, width: 180, height: 40)) { Self.openSettings() })
        }
        let pages = max(1, (assets.count + perPage - 1) / perPage)
        if pages > 1 {
            list.append(Look.symbolButton("pgprev", "chevron.up", CGRect(x: g.maxX - 124, y: 24, width: 40, height: 40)) { [weak self] in
                guard let self else { return }
                self.page = max(0, self.page - 1)
            })
            list.append(Look.symbolButton("pgnext", "chevron.down", CGRect(x: g.maxX - 74, y: 24, width: 40, height: 40)) { [weak self] in
                guard let self else { return }
                self.page = min(pages - 1, self.page + 1)
            })
        }
        if assets.count == 0 {
            list.append(message("Nothing here yet", tab == .panoramas ? "Take a panorama with the Camera app, then stand inside it here." : "Photos you take will show up here."))
            return list
        }
        let tile: CGFloat = 116
        for slot in 0..<perPage {
            let index = page * perPage + slot
            guard index < assets.count else { break }
            let asset = assets.object(at: index)
            let image = thumbnail(asset)
            let isVideo = asset.mediaType == .video
            let isPano = asset.mediaSubtypes.contains(.photoPanorama)
            let duration = String(format: "%d:%02d", Int(asset.duration) / 60, Int(asset.duration) % 60)
            let frame = CGRect(x: g.minX + 28 + CGFloat(slot % 5) * (tile + 13), y: 86 + CGFloat(slot / 5) * (tile + 12), width: tile, height: tile)
            list.append(UINode("p\(index)", frame, radius: 16, action: { [weak self] in
                self?.viewing = index
            }) {
                ZStack(alignment: .bottomTrailing) {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFill().frame(width: tile, height: tile).clipped()
                    } else {
                        Color.white.opacity(0.08)
                    }
                    Text("\(slot + 1)").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Color.black.opacity(0.45)))
                        .padding(5)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    if isVideo {
                        Text(duration).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white).shadow(radius: 2).padding(6)
                    } else if isPano {
                        Image(systemName: "pano.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).shadow(radius: 2).padding(6)
                    }
                }
                .frame(width: tile, height: tile)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            })
        }
        return list
    }

    private func viewer(_ asset: PHAsset) -> [UINode] {
        let g = glassRect
        if asset.mediaType == .video {
            return videoViewer(asset)
        }
        if video.isActive { stopVideo() }
        loadFull(asset)
        let image = full
        var list: [UINode] = [
            UINode("full", g) {
                ZStack {
                    Color.black.opacity(0.35)
                    if let image {
                        Image(uiImage: image).resizable().scaledToFit()
                    } else {
                        Text("Loading…").font(.system(size: 17, weight: .medium)).foregroundStyle(.white.opacity(0.7))
                    }
                }
                .frame(width: g.width, height: g.height)
                .clipShape(RoundedRectangle(cornerRadius: 40, style: .continuous))
            },
            Look.symbolButton("back", "chevron.backward", CGRect(x: g.minX + 20, y: 20, width: 46, height: 46)) { [weak self] in
                self?.viewing = nil
                self?.full = nil
                self?.fullID = nil
            },
            Look.symbolButton("prev", "chevron.left", CGRect(x: g.minX + 20, y: g.midY - 23, width: 46, height: 46)) { [weak self] in self?.step(-1) },
            Look.symbolButton("next", "chevron.right", CGRect(x: g.maxX - 66, y: g.midY - 23, width: 46, height: 46)) { [weak self] in self?.step(1) },
        ]
        if asset.mediaSubtypes.contains(.photoPanorama) {
            let inside = spatial?.panoramaShown ?? false
            list.append(Look.pill("immerse", inside ? "Exit Panorama" : "Immerse", CGRect(x: g.midX - 90, y: g.maxY - 70, width: 180, height: 46), fill: .white, textColor: .black) { [weak self] in
                guard let self else { return }
                if self.spatial?.panoramaShown == true { self.spatial?.hidePanorama() } else { self.immerse(asset) }
            })
        }
        return list
    }

    private func videoViewer(_ asset: PHAsset) -> [UINode] {
        let g = glassRect
        playVideo(asset)
        let playing = video.isPlaying
        let rect = videoRect
        return [
            UINode("screen", rect, radius: 16) {
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.black.opacity(0.6))
                    .overlay(Text("Loading video…").font(.system(size: 15)).foregroundStyle(.white.opacity(0.6)))
            },
            Look.symbolButton("back", "chevron.backward", CGRect(x: g.minX + 20, y: 20, width: 46, height: 46)) { [weak self] in
                self?.stopVideo()
                self?.viewing = nil
            },
            Look.symbolButton("prev", "backward.end.fill", CGRect(x: g.midX - 150, y: g.maxY - 66, width: 52, height: 52)) { [weak self] in self?.step(-1) },
            Look.symbolButton("rew", "gobackward.15", CGRect(x: g.midX - 86, y: g.maxY - 66, width: 52, height: 52)) { [weak self] in self?.video.skip(-15) },
            Look.symbolButton("play", playing ? "pause.fill" : "play.fill", CGRect(x: g.midX - 26, y: g.maxY - 70, width: 60, height: 60)) { [weak self] in self?.video.toggle() },
            Look.symbolButton("ffw", "goforward.15", CGRect(x: g.midX + 46, y: g.maxY - 66, width: 52, height: 52)) { [weak self] in self?.video.skip(15) },
            Look.symbolButton("next", "forward.end.fill", CGRect(x: g.midX + 110, y: g.maxY - 66, width: 52, height: 52)) { [weak self] in self?.step(1) },
        ]
    }

    private func step(_ d: Int) {
        guard let i = viewing, let assets, assets.count > 0 else { return }
        viewing = (i + d + assets.count) % assets.count
        dirty = true
    }
}

// MARK: - Files

@MainActor
final class FilesApp: SpatialApp {
    let title = "Files"
    let size = CGSize(width: 820, height: 480)
    var dirty = true
    weak var spatial: Spatial?

    struct Location {
        let name: String
        let url: URL
        let symbol: String
        let bookmark: Data?
    }

    /// What's open in the preview pane. Everything stays in the window.
    enum Preview {
        case image(UIImage)
        case pdf(PDFDocument, page: Int)
        case text([String], page: Int)
        case picture(UIImage?)
        case media(video: Bool)
    }

    private var locations: [Location] = []
    private var selected = 0
    private var path: [URL] = []
    private var items: [URL] = []
    private var isFolder: [URL: Bool] = [:]
    private var thumbs: [URL: UIImage] = [:]
    private var requested: Set<URL> = []
    private var page = 0
    private var preview: (url: URL, kind: Preview)?
    private var pdfImage: (key: String, image: UIImage)?
    private var errorText: String?
    private let bookmarksKey = "vision.folders"
    private let perPage = 15
    private let player = VideoSurface()

    var attachment: Entity? { player.entity }

    private var x0: CGFloat { 244 }
    private var previewRect: CGRect { CGRect(x: x0, y: 74, width: size.width - x0 - 20, height: size.height - 74 - 76) }

    init(spatial: Spatial) {
        self.spatial = spatial
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        locations = [Location(name: "On My iPhone", url: docs, symbol: "iphone", bookmark: nil)]
        for data in (UserDefaults.standard.array(forKey: bookmarksKey) as? [Data]) ?? [] {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) {
                _ = url.startAccessingSecurityScopedResource()
                locations.append(Location(name: url.lastPathComponent, url: url, symbol: Self.symbol(for: url), bookmark: data))
            }
        }
        load()
    }

    private static func symbol(for url: URL) -> String {
        url.path.contains("Mobile Documents") ? "icloud.fill" : "folder.fill"
    }

    /// A folder you picked during setup. The bookmark keeps access to it
    /// (and everything inside) across launches.
    func addLocation(_ url: URL) {
        _ = url.startAccessingSecurityScopedResource()
        guard let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) else {
            spatial?.toast("Couldn't keep access to that folder")
            return
        }
        locations.append(Location(name: url.lastPathComponent, url: url, symbol: Self.symbol(for: url), bookmark: data))
        persist()
        select(locations.count - 1)
    }

    func refresh() {
        if preview == nil { load() }
    }

    func didClose() {
        closePreview()
    }

    private func persist() {
        UserDefaults.standard.set(locations.compactMap(\.bookmark), forKey: bookmarksKey)
    }

    private func remove(_ i: Int) {
        guard i > 0, i < locations.count else { return }
        locations[i].url.stopAccessingSecurityScopedResource()
        locations.remove(at: i)
        persist()
        select(0)
    }

    private func select(_ i: Int) {
        closePreview()
        selected = i
        path = []
        load()
    }

    private var folder: URL { path.last ?? locations[selected].url }

    private func load() {
        page = 0
        errorText = nil
        let keys: [URLResourceKey] = [.isDirectoryKey, .isPackageKey]
        do {
            let urls = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])
            var folders: [URL: Bool] = [:]
            for url in urls {
                let values = try? url.resourceValues(forKeys: Set(keys))
                folders[url] = (values?.isDirectory ?? false) && !(values?.isPackage ?? false)
            }
            isFolder = folders
            items = urls.sorted { a, b in
                let fa = folders[a] ?? false
                let fb = folders[b] ?? false
                if fa != fb { return fa }
                return a.lastPathComponent.localizedStandardCompare(b.lastPathComponent) == .orderedAscending
            }
        } catch {
            items = []
            errorText = "Can't open this folder"
        }
        dirty = true
    }

    private func goUp() {
        if preview != nil {
            closePreview()
        } else if !path.isEmpty {
            path.removeLast()
            load()
        }
    }

    private func closePreview() {
        player.stop()
        preview = nil
        pdfImage = nil
        dirty = true
    }

    // MARK: Opening

    private func open(_ url: URL) {
        if isFolder[url] == true {
            path.append(url)
            load()
            return
        }
        closePreview()
        let type = UTType(filenameExtension: url.pathExtension)
        if let type, type.conforms(to: .image), let image = Self.downsample(url, maxPixels: 1800) {
            preview = (url, .image(image))
        } else if let type, type.conforms(to: .pdf), let doc = PDFDocument(url: url), doc.pageCount > 0 {
            preview = (url, .pdf(doc, page: 0))
        } else if let type, type.conforms(to: .audiovisualContent) {
            let isVideo = type.conforms(to: .movie) || type.conforms(to: .video)
            preview = (url, .media(video: isVideo))
            let rect = previewRect
            let windowSize = size
            Task { @MainActor in
                let natural = isVideo ? await VideoSurface.naturalSize(of: url) : .zero
                guard self.preview?.url == url else { return }
                self.player.play(AVPlayerItem(url: url), videoSize: natural, in: rect, windowSize: windowSize)
                self.dirty = true
            }
        } else if let type, type.conforms(to: .text), let text = Self.readText(url) {
            preview = (url, .text(Self.paginate(text), page: 0))
        } else {
            preview = (url, .picture(nil))
            let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 560, height: 360), scale: 2, representationTypes: .thumbnail)
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { [weak self] representation, _ in
                let image = representation?.uiImage
                Task { @MainActor in
                    guard let self, self.preview?.url == url else { return }
                    self.preview = (url, .picture(image))
                    if image == nil { self.errorText = "Vision can't show this kind of file" }
                    self.dirty = true
                }
            }
        }
        dirty = true
    }

    private static func readText(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
        let head = data.prefix(400_000)
        return String(data: head, encoding: .utf8) ?? String(data: head, encoding: .isoLatin1)
    }

    /// Pages of about 1,100 characters, broken at line ends where possible.
    private static func paginate(_ text: String) -> [String] {
        var pages: [String] = []
        var current = ""
        for line in text.components(separatedBy: "\n") {
            var rest = Substring(line)
            repeat {
                let room = 1100 - current.count
                if rest.count <= room {
                    current += rest + "\n"
                    rest = ""
                } else if room < 120 {
                    pages.append(current)
                    current = ""
                } else {
                    current += rest.prefix(room) + "\n"
                    rest = rest.dropFirst(room)
                }
                if current.filter({ $0 == "\n" }).count >= 22 {
                    pages.append(current)
                    current = ""
                }
            } while !rest.isEmpty
        }
        if !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pages.isEmpty { pages.append(current) }
        return pages
    }

    static func downsample(_ url: URL, maxPixels: CGFloat) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }

    private func thumbnail(_ url: URL) -> UIImage? {
        if let image = thumbs[url] { return image }
        if requested.insert(url).inserted {
            let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 128, height: 128), scale: 2, representationTypes: .all)
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { [weak self] representation, _ in
                guard let image = representation?.uiImage else { return }
                Task { @MainActor in
                    self?.thumbs[url] = image
                    self?.dirty = true
                }
            }
        }
        return nil
    }

    private func turn(_ d: Int) {
        guard let preview else {
            let pages = max(1, (items.count + perPage - 1) / perPage)
            page = max(0, min(pages - 1, page + d))
            dirty = true
            return
        }
        switch preview.kind {
        case .pdf(let doc, let p):
            self.preview = (preview.url, .pdf(doc, page: max(0, min(doc.pageCount - 1, p + d))))
        case .text(let pages, let p):
            self.preview = (preview.url, .text(pages, page: max(0, min(pages.count - 1, p + d))))
        case .media:
            player.skip(Double(d) * 15)
        default:
            break
        }
        dirty = true
    }

    // MARK: Voice

    func handleVoice(_ t: String) -> Bool {
        switch t {
        case "back", "go back", "up", "close file", "close preview": goUp()
        case "next", "next page", "page down", "scroll down", "down": turn(1)
        case "previous", "previous page", "page up", "scroll up": turn(-1)
        case "play", "pause", "stop", "resume": player.toggle()
        default:
            for prefix in ["open ", "show ", "go to "] where t.hasPrefix(prefix) {
                let name = String(t.dropFirst(prefix.count))
                if let n = PhotosApp.number(name), n >= 1, page * perPage + n - 1 < items.count {
                    open(items[page * perPage + n - 1])
                    return true
                }
                if let i = locations.firstIndex(where: { VoiceControl.normalize($0.name) == name }) {
                    select(i)
                    return true
                }
                let match = items.first { VoiceControl.normalize($0.deletingPathExtension().lastPathComponent) == name }
                    ?? items.first { VoiceControl.normalize($0.lastPathComponent).hasPrefix(name) }
                    ?? items.first { VoiceControl.normalize($0.lastPathComponent).contains(name) }
                if let match {
                    open(match)
                    return true
                }
            }
            return false
        }
        return true
    }

    // MARK: Drawing

    func nodes() -> [UINode] {
        var list: [UINode] = [
            UINode("sidebar", CGRect(x: 10, y: 10, width: 214, height: size.height - 20), radius: 30) {
                RoundedRectangle(cornerRadius: 30, style: .continuous).fill(Color.white.opacity(0.06))
            },
            Look.label("title", "Files", CGRect(x: 32, y: 22, width: 170, height: 38), size: 28, weight: .bold),
        ]
        for (i, location) in locations.prefix(6).enumerated() {
            let on = i == selected
            list.append(UINode("loc\(i)", CGRect(x: 20, y: 72 + CGFloat(i) * 50, width: 194, height: 44), radius: 14, action: { [weak self] in
                self?.select(i)
            }) {
                HStack(spacing: 10) {
                    Image(systemName: location.symbol).font(.system(size: 16, weight: .semibold)).foregroundStyle(Color(red: 0.45, green: 0.75, blue: 1)).frame(width: 24)
                    Text(location.name).font(.system(size: 16, weight: .medium)).foregroundStyle(.white).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(on ? 0.18 : 0)))
            })
        }
        list.append(Look.pill("addfolder", "+ Add Folder", CGRect(x: 26, y: size.height - 116, width: 182, height: 42)) { [weak self] in
            // Choosing a folder is part of setup: the system picker needs the touchscreen.
            self?.spatial?.toast("Use the touchscreen to pick a folder")
            self?.spatial?.sheet = .folderPicker
        })
        if selected > 0 {
            list.append(Look.pill("removefolder", "Remove", CGRect(x: 26, y: size.height - 66, width: 182, height: 40), fill: Color.red.opacity(0.35)) { [weak self] in
                guard let self else { return }
                self.remove(self.selected)
            })
        }
        if let preview {
            return list + previewNodes(preview.url, preview.kind)
        }

        var titleX = x0
        if !path.isEmpty {
            list.append(Look.symbolButton("up", "chevron.backward", CGRect(x: x0, y: 20, width: 42, height: 42)) { [weak self] in self?.goUp() })
            titleX += 54
        }
        let name = path.isEmpty ? locations[selected].name : folder.lastPathComponent
        list.append(Look.label("folder", name, CGRect(x: titleX, y: 22, width: 380, height: 38), size: 24, weight: .bold))
        let pages = max(1, (items.count + perPage - 1) / perPage)
        if pages > 1 {
            list.append(Look.symbolButton("pgprev", "chevron.up", CGRect(x: size.width - 118, y: 22, width: 40, height: 40)) { [weak self] in self?.turn(-1) })
            list.append(Look.symbolButton("pgnext", "chevron.down", CGRect(x: size.width - 68, y: 22, width: 40, height: 40)) { [weak self] in self?.turn(1) })
        }
        if items.isEmpty {
            let text = errorText ?? (selected == 0 && path.isEmpty
                ? "Empty. Put files in the Files app ▸ On My iPhone ▸ Vision, or add a folder such as iCloud Drive."
                : "This folder is empty")
            list.append(UINode("empty", CGRect(x: x0, y: 120, width: size.width - x0 - 30, height: 200)) {
                VStack(spacing: 10) {
                    Image(systemName: "folder").font(.system(size: 44)).foregroundStyle(.white.opacity(0.6))
                    Text(text).font(.system(size: 16)).foregroundStyle(.white.opacity(0.7)).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            })
            return list
        }
        for slot in 0..<perPage {
            let index = page * perPage + slot
            guard index < items.count else { break }
            let url = items[index]
            let isDir = isFolder[url] == true
            let image = isDir ? nil : thumbnail(url)
            let frame = CGRect(x: x0 + CGFloat(slot % 5) * 112, y: 76 + CGFloat(slot / 5) * 128, width: 104, height: 120)
            list.append(UINode("f\(index)", frame, radius: 16, action: { [weak self] in self?.open(url) }) {
                VStack(spacing: 6) {
                    Group {
                        if isDir {
                            Image(systemName: "folder.fill").font(.system(size: 50)).foregroundStyle(Color(red: 0.45, green: 0.75, blue: 1))
                        } else if let image {
                            Image(uiImage: image).resizable().scaledToFit()
                        } else {
                            Image(systemName: "doc.fill").font(.system(size: 42)).foregroundStyle(.white.opacity(0.75))
                        }
                    }
                    .frame(width: 72, height: 66)
                    Text(url.lastPathComponent).font(.system(size: 12, weight: .medium)).foregroundStyle(.white)
                        .lineLimit(2).multilineTextAlignment(.center)
                }
                .padding(.top, 8)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .overlay(alignment: .topLeading) {
                    Text("\(slot + 1)").font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.7)).padding(6)
                }
            })
        }
        return list
    }

    private func previewNodes(_ url: URL, _ kind: Preview) -> [UINode] {
        let rect = previewRect
        var list: [UINode] = [
            Look.symbolButton("back", "chevron.backward", CGRect(x: x0, y: 20, width: 42, height: 42)) { [weak self] in self?.closePreview() },
            Look.label("name", url.lastPathComponent, CGRect(x: x0 + 54, y: 22, width: size.width - x0 - 80, height: 38), size: 19, weight: .semibold),
        ]
        var pageText: String?
        var paged = false
        switch kind {
        case .image(let image):
            list.append(UINode("preview", rect) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            })
        case .pdf(let doc, let p):
            let key = "\(url.path)#\(p)"
            if pdfImage?.key != key, let pdfPage = doc.page(at: p) {
                pdfImage = (key, pdfPage.thumbnail(of: CGSize(width: rect.width * 2, height: rect.height * 2), for: .mediaBox))
            }
            let image = pdfImage?.image
            list.append(UINode("preview", rect) {
                ZStack {
                    if let image { Image(uiImage: image).resizable().scaledToFit() }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            })
            pageText = "Page \(p + 1) of \(doc.pageCount)"
            paged = doc.pageCount > 1
        case .text(let pages, let p):
            list.append(UINode("preview", rect) {
                Text(pages[p]).font(.system(size: 13, design: .monospaced)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.black.opacity(0.25)))
            })
            pageText = "Page \(p + 1) of \(pages.count)"
            paged = pages.count > 1
        case .picture(let image):
            let note = errorText
            list.append(UINode("preview", rect) {
                VStack(spacing: 10) {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFit()
                    } else {
                        Image(systemName: "doc.fill").font(.system(size: 60)).foregroundStyle(.white.opacity(0.6))
                        Text(note ?? "Making a preview…").font(.system(size: 16)).foregroundStyle(.white.opacity(0.7))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            })
        case .media(let isVideo):
            let playing = player.isPlaying
            if !isVideo {
                list.append(UINode("preview", rect) {
                    Image(systemName: "waveform").font(.system(size: 80, weight: .light)).foregroundStyle(.white.opacity(0.7))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                })
            }
            let mid = rect.midX
            list.append(Look.symbolButton("rew", "gobackward.15", CGRect(x: mid - 92, y: size.height - 66, width: 52, height: 52)) { [weak self] in self?.player.skip(-15) })
            list.append(Look.symbolButton("play", playing ? "pause.fill" : "play.fill", CGRect(x: mid - 30, y: size.height - 70, width: 60, height: 60)) { [weak self] in self?.player.toggle() })
            list.append(Look.symbolButton("ffw", "goforward.15", CGRect(x: mid + 40, y: size.height - 66, width: 52, height: 52)) { [weak self] in self?.player.skip(15) })
        }
        if paged {
            let mid = rect.midX
            list.append(Look.symbolButton("prevpage", "chevron.left", CGRect(x: mid - 150, y: size.height - 62, width: 46, height: 46)) { [weak self] in self?.turn(-1) })
            list.append(Look.symbolButton("nextpage", "chevron.right", CGRect(x: mid + 104, y: size.height - 62, width: 46, height: 46)) { [weak self] in self?.turn(1) })
        }
        if let pageText {
            list.append(Look.label("pages", pageText, CGRect(x: rect.midX - 90, y: size.height - 52, width: 180, height: 26), size: 15, weight: .medium, color: .white.opacity(0.75), align: .center))
        }
        return list
    }
}

// MARK: - Weather (live, Open-Meteo)

@MainActor
final class WeatherApp: SpatialApp {
    let title = "Weather"
    let size = CGSize(width: 560, height: 340)
    var dirty = true
    private var started = false
    private var place = "Locating…"
    private var temperature: Double?
    private var condition = ""
    private var high: Double?
    private var low: Double?
    private var hours: [(String, Double, String)] = []
    private let manager = CLLocationManager()

    private struct Forecast: Decodable {
        struct Current: Decodable {
            let temperature_2m: Double
            let weather_code: Int
            let time: String
        }
        struct Hourly: Decodable {
            let time: [String]
            let temperature_2m: [Double]
            let weather_code: [Int]
        }
        struct Daily: Decodable {
            let temperature_2m_max: [Double]
            let temperature_2m_min: [Double]
        }
        let current: Current
        let hourly: Hourly
        let daily: Daily
    }

    func tick(_ now: Date) {
        guard !started else { return }
        started = true
        Task { @MainActor in await load() }
    }

    private func load() async {
        var coordinate = CLLocationCoordinate2D(latitude: 51.5072, longitude: -0.1276)
        var name = "London"
        manager.requestWhenInUseAuthorization()
        if let location = await currentLocation() {
            coordinate = location.coordinate
            name = await placeName(location) ?? "My Location"
        }
        place = name
        dirty = true
        let url = URL(string: "https://api.open-meteo.com/v1/forecast?latitude=\(coordinate.latitude)&longitude=\(coordinate.longitude)&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=2")!
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let f = try JSONDecoder().decode(Forecast.self, from: data)
            temperature = f.current.temperature_2m
            condition = Self.describe(f.current.weather_code).0
            high = f.daily.temperature_2m_max.first
            low = f.daily.temperature_2m_min.first
            let nowHour = String(f.current.time.prefix(13))
            let start = max(0, f.hourly.time.firstIndex { String($0.prefix(13)) >= nowHour } ?? 0)
            hours = (start..<min(start + 6, f.hourly.time.count)).map { i in
                let hour = Int(f.hourly.time[i].dropFirst(11).prefix(2)) ?? 0
                return (i == start ? "Now" : String(format: "%02d", hour), f.hourly.temperature_2m[i], Self.describe(f.hourly.weather_code[i]).1)
            }
        } catch {
            condition = "Weather unavailable"
        }
        dirty = true
    }

    private func currentLocation() async -> CLLocation? {
        await withTaskGroup(of: CLLocation?.self) { group in
            group.addTask {
                do {
                    for try await update in CLLocationUpdate.liveUpdates() {
                        if let location = update.location { return location }
                    }
                } catch {}
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    private func placeName(_ location: CLLocation) async -> String? {
        let marks = try? await CLGeocoder().reverseGeocodeLocation(location)
        return marks?.first?.locality ?? marks?.first?.name
    }

    static func describe(_ code: Int) -> (String, String) {
        switch code {
        case 0: return ("Clear", "sun.max.fill")
        case 1, 2: return ("Partly Cloudy", "cloud.sun.fill")
        case 3: return ("Cloudy", "cloud.fill")
        case 45, 48: return ("Fog", "cloud.fog.fill")
        case 51...57: return ("Drizzle", "cloud.drizzle.fill")
        case 61...67, 80...82: return ("Rain", "cloud.rain.fill")
        case 71...77, 85, 86: return ("Snow", "cloud.snow.fill")
        case 95...99: return ("Thunderstorm", "cloud.bolt.rain.fill")
        default: return ("—", "thermometer.medium")
        }
    }

    func nodes() -> [UINode] {
        var list: [UINode] = [
            Look.label("place", place, CGRect(x: 30, y: 24, width: 500, height: 28), size: 20, weight: .semibold, align: .center),
            Look.label("temp", temperature.map { "\(Int($0.rounded()))°" } ?? "—", CGRect(x: 30, y: 52, width: 500, height: 96), size: 80, weight: .thin, align: .center),
            Look.label("cond", condition, CGRect(x: 30, y: 148, width: 500, height: 28), size: 19, weight: .medium, align: .center),
        ]
        if let high, let low {
            list.append(Look.label("hl", "H:\(Int(high.rounded()))°  L:\(Int(low.rounded()))°", CGRect(x: 30, y: 176, width: 500, height: 24), size: 16, color: .white.opacity(0.7), align: .center))
        }
        for (i, h) in hours.enumerated() {
            list.append(UINode("h\(i)", CGRect(x: 30 + CGFloat(i) * 84, y: 222, width: 76, height: 96)) {
                VStack(spacing: 6) {
                    Text(h.0).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white.opacity(0.75))
                    Image(systemName: h.2).symbolRenderingMode(.multicolor).font(.system(size: 24))
                    Text("\(Int(h.1.rounded()))°").font(.system(size: 18, weight: .medium)).foregroundStyle(.white)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.08)))
            })
        }
        return list
    }
}

// MARK: - Tips (what you can say)

@MainActor
final class TipsApp: SpatialApp {
    let title = "Tips"
    let size = CGSize(width: 820, height: 500)
    var dirty = true

    private let columns: [(String, [String])] = [
        ("Anywhere", [
            "“Go home” · “Recenter”",
            "“Open Photos / Files / Safari / Notes”",
            "“Close” · “Close Photos” · “Close all”",
            "“Night sky” · “Sunset” · “Lake” · “The Moon”",
            "“More / less immersion” · “My room”",
            "“Ultra wide” · “AR mode”",
            "“Control Center” · “Stop listening”",
        ]),
        ("In a window", [
            "“Next” · “Previous” · “Back” · “Scroll down”",
            "“Open 3” (the numbers on photos and files)",
            "“Open budget” (a file by its name)",
            "“Play” · “Pause” · “Skip” · “Immerse”",
            "“Search for pizza near me” · “Go to bbc.co.uk”",
            "“Click sign in” (a link by its words)",
            "“Take a note”, talk, then “done”",
        ]),
    ]

    func nodes() -> [UINode] {
        var list: [UINode] = [
            Look.label("title", "What you can do without touching", CGRect(x: 32, y: 22, width: 700, height: 40), size: 26, weight: .bold),
            Look.label("hands", "Hands: point at a button and pinch, or touch it in the air. Pinch the bar under a window to move it.",
                       CGRect(x: 32, y: 66, width: 760, height: 24), size: 15, color: .white.opacity(0.75)),
            Look.label("button", "Camera Control is the Crown: click for Home, hold to recenter. Volume Down opens Control Center. In Ultra Wide, light-press and slide for immersion.",
                       CGRect(x: 32, y: 94, width: 760, height: 40), size: 15, color: .white.opacity(0.75)),
        ]
        for (c, column) in columns.enumerated() {
            let x = 32 + CGFloat(c) * 390
            list.append(Look.label("h\(c)", "Say \(column.0.lowercased())", CGRect(x: x, y: 140, width: 370, height: 28), size: 19, weight: .semibold))
            for (i, line) in column.1.enumerated() {
                list.append(Look.label("l\(c)-\(i)", line, CGRect(x: x, y: 176 + CGFloat(i) * 42, width: 370, height: 34), size: 16, color: .white.opacity(0.9)))
            }
        }
        return list
    }
}
