import SwiftUI
import UIKit
import CoreLocation

extension SpatialApp {
    func tick(_ now: Date) {}
}

// MARK: - Home

@MainActor
final class HomeApp: SpatialApp {
    let title = "Home"
    let size = CGSize(width: 560, height: 320)
    var dirty = true
    weak var spatial: Spatial?

    init(spatial: Spatial) {
        self.spatial = spatial
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
        let items: [Item] = [
            Item(id: "clock", symbol: "clock.fill", colors: [Color(white: 0.3), Color(white: 0.1)], title: "Clock") { s?.open(.clock) },
            Item(id: "calc", symbol: "plus.forwardslash.minus", colors: [Color.orange, Color(red: 0.8, green: 0.35, blue: 0)], title: "Calculator") { s?.open(.calculator) },
            Item(id: "notes", symbol: "note.text", colors: [Color.yellow, Color.orange], title: "Notes") { s?.open(.notes) },
            Item(id: "photos", symbol: "photo.on.rectangle.angled", colors: [Color.pink, Color.purple], title: "Photos") { s?.open(.photos) },
            Item(id: "weather", symbol: "cloud.sun.fill", colors: [Color.cyan, Color.blue], title: "Weather") { s?.open(.weather) },
            Item(id: "safari", symbol: "safari.fill", colors: [Color(red: 0.2, green: 0.7, blue: 1), Color.blue], title: "Safari") { s?.open(.safari) },
            Item(id: "mesh", symbol: "cube.transparent", colors: [Color.mint, Color.teal], title: "LiDAR Mesh") { s?.toggleMesh() },
            Item(id: "here", symbol: "scope", colors: [Color.indigo, Color.purple], title: "Bring Here") { s?.bringWindowsHere() },
        ]
        return items.enumerated().map { i, item in
            let col = CGFloat(i % 4)
            let row = CGFloat(i / 4)
            return Look.appIcon(item.id, symbol: item.symbol, colors: item.colors, title: item.title,
                                at: CGPoint(x: 36 + col * 132, y: 30 + row * 146), action: item.action)
        }
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

// MARK: - Notes

struct Note: Codable, Identifiable {
    var id: UUID
    var text: String
    var date: Date
}

@MainActor
final class NotesApp: SpatialApp {
    let title = "Notes"
    let size = CGSize(width: 620, height: 380)
    var dirty = true
    weak var spatial: Spatial?
    private var notes: [Note] = []
    private var selected: UUID?
    private let key = "vision.notes"

    init(spatial: Spatial) {
        self.spatial = spatial
        if let data = UserDefaults.standard.data(forKey: key), let saved = try? JSONDecoder().decode([Note].self, from: data) {
            notes = saved
        }
        if notes.isEmpty {
            notes = [Note(id: UUID(), text: "Welcome to Notes\nTap Edit to type with the keyboard. Notes stay on this iPhone.", date: Date())]
        }
        selected = notes.first?.id
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(notes) { UserDefaults.standard.set(data, forKey: key) }
    }

    func text(_ id: UUID) -> String { notes.first { $0.id == id }?.text ?? "" }

    func save(_ id: UUID, text: String) {
        guard let i = notes.firstIndex(where: { $0.id == id }) else { return }
        notes[i].text = text
        notes[i].date = Date()
        notes.sort { $0.date > $1.date }
        persist()
        dirty = true
    }

    func nodes() -> [UINode] {
        var list: [UINode] = [
            Look.label("title", "Notes", CGRect(x: 26, y: 20, width: 140, height: 40), size: 28, weight: .bold),
            Look.symbolButton("new", "square.and.pencil", CGRect(x: 170, y: 20, width: 40, height: 40)) { [weak self] in
                guard let self else { return }
                let note = Note(id: UUID(), text: "", date: Date())
                self.notes.insert(note, at: 0)
                self.selected = note.id
                self.persist()
                self.spatial?.sheet = .note(note.id)
            },
        ]
        for (i, note) in notes.prefix(5).enumerated() {
            let lines = note.text.split(separator: "\n", omittingEmptySubsequences: false)
            let title = lines.first.map(String.init) ?? ""
            let id = note.id
            let on = id == selected
            list.append(UINode("note\(i)", CGRect(x: 16, y: 72 + CGFloat(i) * 58, width: 210, height: 52), radius: 14, action: { [weak self] in
                self?.selected = id
            }) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title.isEmpty ? "New Note" : title).font(.system(size: 16, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                    Text(note.date, style: .date).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                }
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(on ? 0.16 : 0)))
            })
        }
        if let note = notes.first(where: { $0.id == selected }) {
            list.append(UINode("body", CGRect(x: 250, y: 24, width: 350, height: 270)) {
                Text(note.text.isEmpty ? "Empty note" : note.text)
                    .font(.system(size: 17))
                    .foregroundStyle(.white.opacity(note.text.isEmpty ? 0.4 : 1))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            })
            let id = note.id
            list.append(Look.pill("edit", "Edit", CGRect(x: 250, y: 312, width: 160, height: 46), fill: .white, textColor: .black) { [weak self] in
                self?.spatial?.sheet = .note(id)
            })
            list.append(Look.pill("delete", "Delete", CGRect(x: 424, y: 312, width: 120, height: 46)) { [weak self] in
                guard let self else { return }
                self.notes.removeAll { $0.id == id }
                if self.notes.isEmpty { self.notes = [Note(id: UUID(), text: "", date: Date())] }
                self.selected = self.notes.first?.id
                self.persist()
            })
        }
        return list
    }
}

// MARK: - Photos

@MainActor
final class PhotosApp: SpatialApp {
    let title = "Photos"
    let size = CGSize(width: 620, height: 400)
    var dirty = true
    weak var spatial: Spatial?
    private var thumbs: [UIImage] = []
    private var files: [URL] = []
    private var page = 0
    private var viewing: Int?
    private var full: UIImage?

    private var folder: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("Photos", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    init(spatial: Spatial) {
        self.spatial = spatial
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        files = urls.filter { $0.pathExtension == "jpg" }.sorted { $0.lastPathComponent > $1.lastPathComponent }
        thumbs = files.compactMap { UIImage(contentsOfFile: $0.path).map { Self.thumbnail($0) } }
    }

    static func thumbnail(_ image: UIImage) -> UIImage {
        let side: CGFloat = 260
        let scale = side / min(image.size.width, image.size.height)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    func add(_ images: [UIImage]) {
        for image in images {
            let url = folder.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(6)).jpg")
            if let data = image.jpegData(compressionQuality: 0.88) { try? data.write(to: url) }
            files.insert(url, at: 0)
            thumbs.insert(Self.thumbnail(image), at: 0)
        }
        page = 0
        viewing = nil
        dirty = true
    }

    func nodes() -> [UINode] {
        var list: [UINode] = []
        if let i = viewing, i < files.count {
            if full == nil { full = UIImage(contentsOfFile: files[i].path) }
            if let full {
                list.append(UINode("full", CGRect(x: 0, y: 0, width: size.width, height: size.height)) {
                    Image(uiImage: full)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color.black.opacity(0.6))
                        .clipShape(RoundedRectangle(cornerRadius: 34, style: .continuous))
                })
            }
            list.append(Look.symbolButton("back", "chevron.backward", CGRect(x: 20, y: 20, width: 46, height: 46)) { [weak self] in
                self?.viewing = nil
                self?.full = nil
            })
            list.append(Look.symbolButton("prev", "chevron.left", CGRect(x: 20, y: 177, width: 46, height: 46)) { [weak self] in self?.step(-1) })
            list.append(Look.symbolButton("next", "chevron.right", CGRect(x: 554, y: 177, width: 46, height: 46)) { [weak self] in self?.step(1) })
            return list
        }
        list.append(Look.label("title", "Photos", CGRect(x: 28, y: 20, width: 300, height: 40), size: 28, weight: .bold))
        list.append(Look.pill("add", "+ Add Photos", CGRect(x: 440, y: 20, width: 156, height: 42)) { [weak self] in
            self?.spatial?.showPhotoPicker = true
        })
        if thumbs.isEmpty {
            list.append(UINode("empty", CGRect(x: 60, y: 120, width: 500, height: 200)) {
                VStack(spacing: 10) {
                    Image(systemName: "photo.on.rectangle.angled").font(.system(size: 46)).foregroundStyle(.white.opacity(0.7))
                    Text("Your photos, floating in your room").font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                    Text("Add photos from your library. They stay on this iPhone.").font(.system(size: 15)).foregroundStyle(.white.opacity(0.65))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            })
            return list
        }
        let perPage = 8
        let start = page * perPage
        for slot in 0..<perPage {
            let index = start + slot
            guard index < thumbs.count else { break }
            let image = thumbs[index]
            let frame = CGRect(x: 28 + CGFloat(slot % 4) * 144, y: 78 + CGFloat(slot / 4) * 144, width: 132, height: 132)
            list.append(UINode("p\(index)", frame, radius: 18, action: { [weak self] in
                self?.viewing = index
                self?.full = nil
            }) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: frame.width, height: frame.height)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            })
        }
        let pages = (thumbs.count + perPage - 1) / perPage
        if pages > 1 {
            list.append(Look.symbolButton("pgprev", "chevron.up", CGRect(x: 600 - 52, y: 90, width: 40, height: 40)) { [weak self] in
                guard let self else { return }
                self.page = max(0, self.page - 1)
            })
            list.append(Look.symbolButton("pgnext", "chevron.down", CGRect(x: 600 - 52, y: 300, width: 40, height: 40)) { [weak self] in
                guard let self else { return }
                self.page = min(pages - 1, self.page + 1)
            })
        }
        return list
    }

    private func step(_ d: Int) {
        guard let i = viewing, !files.isEmpty else { return }
        viewing = (i + d + files.count) % files.count
        full = nil
        dirty = true
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

// MARK: - Safari

@MainActor
final class SafariApp: SpatialApp {
    let title = "Safari"
    let size = CGSize(width: 560, height: 320)
    var dirty = true
    weak var spatial: Spatial?
    private let favorites: [(String, String, String)] = [
        ("Wikipedia", "https://en.m.wikipedia.org", "book.fill"),
        ("Apple", "https://www.apple.com", "applelogo"),
        ("Maps", "https://www.openstreetmap.org", "map.fill"),
        ("News", "https://news.ycombinator.com", "newspaper.fill"),
        ("YouTube", "https://m.youtube.com", "play.rectangle.fill"),
        ("GitHub", "https://github.com", "chevron.left.forwardslash.chevron.right"),
    ]

    init(spatial: Spatial) {
        self.spatial = spatial
    }

    func nodes() -> [UINode] {
        var list: [UINode] = [
            Look.pill("search", "Search or enter website", CGRect(x: 30, y: 24, width: 500, height: 48)) { [weak self] in
                self?.spatial?.sheet = .urlEntry
            },
        ]
        for (i, fav) in favorites.enumerated() {
            let frame = CGRect(x: 30 + CGFloat(i % 3) * 170, y: 96 + CGFloat(i / 3) * 104, width: 160, height: 92)
            let url = URL(string: fav.1)!
            list.append(UINode("fav\(i)", frame, radius: 20, action: { [weak self] in
                self?.spatial?.sheet = .safari(url)
            }) {
                VStack(spacing: 8) {
                    Image(systemName: fav.2).font(.system(size: 26, weight: .semibold)).foregroundStyle(.white)
                    Text(fav.0).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.12)))
            })
        }
        return list
    }
}
