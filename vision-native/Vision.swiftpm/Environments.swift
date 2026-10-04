import SwiftUI
import RealityKit

/// visionOS-style Environments: a world drawn around you that replaces the
/// room as you turn the Digital Crown. Each one is painted here as an
/// equirectangular image (no downloads), then wrapped on the inside of a sphere.
enum EnvironmentKind: String, CaseIterable {
    case nightSky, sunset, lake, moon

    var title: String {
        switch self {
        case .nightSky: return "Night Sky"
        case .sunset: return "Sunset Dunes"
        case .lake: return "Mountain Lake"
        case .moon: return "The Moon"
        }
    }

    var spokenNames: [String] {
        switch self {
        case .nightSky: return ["night sky", "the night sky", "night", "stars", "starry night"]
        case .sunset: return ["sunset", "sunset dunes", "dunes", "the desert", "desert"]
        case .lake: return ["lake", "mountain lake", "the lake", "mountains", "the mountains"]
        case .moon: return ["moon", "the moon"]
        }
    }

    var symbol: String {
        switch self {
        case .nightSky: return "moon.stars.fill"
        case .sunset: return "sun.haze.fill"
        case .lake: return "water.waves"
        case .moon: return "globe.americas.fill"
        }
    }

    var colors: [Color] {
        switch self {
        case .nightSky: return [Color(red: 0.2, green: 0.2, blue: 0.5), Color(red: 0.03, green: 0.04, blue: 0.15)]
        case .sunset: return [Color(red: 1, green: 0.6, blue: 0.35), Color(red: 0.6, green: 0.25, blue: 0.4)]
        case .lake: return [Color(red: 0.45, green: 0.75, blue: 0.95), Color(red: 0.1, green: 0.35, blue: 0.5)]
        case .moon: return [Color(white: 0.55), Color(white: 0.12)]
        }
    }

    @MainActor
    func render() -> CGImage? {
        let renderer = ImageRenderer(content: EnvironmentArt(kind: self).frame(width: 2048, height: 1024))
        renderer.scale = 1
        return renderer.cgImage
    }
}

/// Deterministic random numbers, so an environment looks the same every time.
struct SeededRandom {
    var state: UInt64
    mutating func next() -> CGFloat {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return CGFloat(Double(state >> 11) / Double(UInt64(1) << 53))
    }
}

/// x = longitude (the middle of the image is straight ahead), y = latitude
/// (the horizon is the middle row). Everything wraps seamlessly at the edges.
struct EnvironmentArt: View {
    let kind: EnvironmentKind

    var body: some View {
        Canvas { ctx, size in
            switch kind {
            case .nightSky: Self.nightSky(&ctx, size)
            case .sunset: Self.sunset(&ctx, size)
            case .lake: Self.lake(&ctx, size)
            case .moon: Self.moon(&ctx, size)
            }
        }
    }

    /// A seamless mountain line: sines with whole numbers of cycles across the width.
    static func ridge(_ size: CGSize, base: CGFloat, height: CGFloat, seed: UInt64, octaves: Int = 5) -> Path {
        var rng = SeededRandom(state: seed)
        let cycles: [CGFloat] = [2, 3, 5, 8, 13, 21, 34]
        var waves: [(k: CGFloat, a: CGFloat, p: CGFloat)] = []
        var total: CGFloat = 0
        for i in 0..<octaves {
            let a = 1 / CGFloat(i + 1)
            waves.append((cycles[i % cycles.count], a, rng.next() * 2 * .pi))
            total += a
        }
        var path = Path()
        path.move(to: CGPoint(x: 0, y: size.height))
        var x: CGFloat = 0
        while x <= size.width {
            let t = x / size.width * 2 * .pi
            var v: CGFloat = 0
            for w in waves { v += w.a * sin(w.k * t + w.p) }
            path.addLine(to: CGPoint(x: x, y: base - height * (v + total) / (2 * total)))
            x += 8
        }
        path.addLine(to: CGPoint(x: size.width, y: size.height))
        path.closeSubpath()
        return path
    }

    static func stars(_ ctx: inout GraphicsContext, _ size: CGSize, count: Int, below: CGFloat, seed: UInt64) {
        var rng = SeededRandom(state: seed)
        for _ in 0..<count {
            let x = rng.next() * size.width
            let y = pow(rng.next(), 1.25) * below
            let r = 0.8 + rng.next() * 1.8
            ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: r, height: r)), with: .color(.white.opacity(0.3 + rng.next() * 0.7)))
        }
    }

    static func nightSky(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let horizon = size.height / 2
        ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .linearGradient(
            Gradient(colors: [Color(red: 0.01, green: 0.02, blue: 0.07), Color(red: 0.05, green: 0.07, blue: 0.2), Color(red: 0.2, green: 0.15, blue: 0.33)]),
            startPoint: .zero, endPoint: CGPoint(x: 0, y: horizon)))
        ctx.drawLayer { layer in
            layer.addFilter(.blur(radius: 60))
            layer.opacity = 0.35
            layer.fill(Path(ellipseIn: CGRect(x: size.width * 0.12, y: size.height * 0.1, width: size.width * 0.76, height: size.height * 0.15)),
                       with: .color(Color(red: 0.75, green: 0.72, blue: 1)))
        }
        stars(&ctx, size, count: 1600, below: horizon, seed: 7)
        ctx.fill(ridge(size, base: horizon + 8, height: 110, seed: 3), with: .color(Color(red: 0.09, green: 0.1, blue: 0.19)))
        ctx.fill(ridge(size, base: horizon + 48, height: 80, seed: 11, octaves: 6), with: .color(Color(red: 0.02, green: 0.02, blue: 0.05)))
    }

    static func sunset(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let horizon = size.height / 2
        ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .linearGradient(
            Gradient(colors: [Color(red: 0.16, green: 0.09, blue: 0.32), Color(red: 0.75, green: 0.35, blue: 0.5), Color(red: 1, green: 0.62, blue: 0.38)]),
            startPoint: .zero, endPoint: CGPoint(x: 0, y: horizon)))
        let sun = CGPoint(x: size.width / 2, y: horizon - 30)
        ctx.fill(Path(ellipseIn: CGRect(x: sun.x - 420, y: sun.y - 420, width: 840, height: 840)), with: .radialGradient(
            Gradient(colors: [Color(red: 1, green: 0.92, blue: 0.75), Color(red: 1, green: 0.7, blue: 0.45).opacity(0.5), .clear]),
            center: sun, startRadius: 0, endRadius: 420))
        ctx.fill(Path(ellipseIn: CGRect(x: sun.x - 42, y: sun.y - 42, width: 84, height: 84)), with: .color(Color(red: 1, green: 0.96, blue: 0.85)))
        let layers: [(CGFloat, CGFloat, UInt64, Color)] = [
            (horizon + 10, 60, 21, Color(red: 0.78, green: 0.45, blue: 0.33)),
            (horizon + 70, 80, 22, Color(red: 0.6, green: 0.32, blue: 0.24)),
            (horizon + 160, 100, 23, Color(red: 0.4, green: 0.2, blue: 0.16)),
        ]
        for (base, height, seed, color) in layers {
            ctx.fill(ridge(size, base: base, height: height, seed: seed, octaves: 3), with: .color(color))
        }
    }

    static func lake(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let horizon = size.height / 2
        ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .linearGradient(
            Gradient(colors: [Color(red: 0.22, green: 0.45, blue: 0.8), Color(red: 0.55, green: 0.75, blue: 0.95), Color(red: 0.85, green: 0.9, blue: 0.95)]),
            startPoint: .zero, endPoint: CGPoint(x: 0, y: horizon)))
        ctx.drawLayer { layer in
            layer.addFilter(.blur(radius: 24))
            var rng = SeededRandom(state: 41)
            for _ in 0..<26 {
                let w = 120 + rng.next() * 260
                let rect = CGRect(x: rng.next() * size.width, y: 120 + rng.next() * (horizon - 260), width: w, height: w * 0.32)
                layer.fill(Path(ellipseIn: rect), with: .color(.white.opacity(0.55)))
            }
        }
        let mountains = ridge(size, base: horizon + 2, height: 170, seed: 5, octaves: 6)
        ctx.fill(mountains, with: .linearGradient(Gradient(colors: [Color(red: 0.42, green: 0.48, blue: 0.56), Color(red: 0.2, green: 0.27, blue: 0.3)]),
                                                  startPoint: CGPoint(x: 0, y: horizon - 170), endPoint: CGPoint(x: 0, y: horizon)))
        ctx.fill(ridge(size, base: horizon + 2, height: 60, seed: 9), with: .color(Color(red: 0.12, green: 0.22, blue: 0.16)))
        let water = Path(CGRect(x: 0, y: horizon, width: size.width, height: size.height - horizon))
        ctx.fill(water, with: .linearGradient(Gradient(colors: [Color(red: 0.3, green: 0.45, blue: 0.55), Color(red: 0.04, green: 0.12, blue: 0.18)]),
                                              startPoint: CGPoint(x: 0, y: horizon), endPoint: CGPoint(x: 0, y: size.height)))
        ctx.drawLayer { layer in
            layer.clip(to: water)
            layer.opacity = 0.3
            layer.translateBy(x: 0, y: 2 * horizon)
            layer.scaleBy(x: 1, y: -1)
            layer.fill(mountains, with: .color(Color(red: 0.35, green: 0.42, blue: 0.48)))
        }
        var rng = SeededRandom(state: 77)
        for _ in 0..<220 {
            let y = horizon + 6 + pow(rng.next(), 2) * (size.height - horizon - 6)
            let w = 20 + rng.next() * 90
            ctx.fill(Path(CGRect(x: rng.next() * size.width, y: y, width: w, height: 1.5)), with: .color(.white.opacity(0.08 + rng.next() * 0.12)))
        }
    }

    static func moon(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let horizon = size.height / 2
        ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))
        stars(&ctx, size, count: 2200, below: horizon, seed: 13)
        let earth = CGRect(x: size.width / 2 - 70, y: horizon - 300, width: 140, height: 140)
        ctx.fill(Path(ellipseIn: earth), with: .linearGradient(Gradient(colors: [Color(red: 0.3, green: 0.55, blue: 0.95), Color(red: 0.1, green: 0.3, blue: 0.6)]),
                                                                startPoint: CGPoint(x: earth.minX, y: earth.minY), endPoint: CGPoint(x: earth.maxX, y: earth.maxY)))
        ctx.drawLayer { layer in
            layer.clip(to: Path(ellipseIn: earth))
            var rng = SeededRandom(state: 5)
            for _ in 0..<9 {
                let rect = CGRect(x: earth.minX + rng.next() * 110, y: earth.minY + rng.next() * 120, width: 30 + rng.next() * 50, height: 10 + rng.next() * 14)
                layer.fill(Path(ellipseIn: rect), with: .color(.white.opacity(0.75)))
            }
            layer.fill(Path(ellipseIn: earth.offsetBy(dx: 46, dy: 18)), with: .color(.black.opacity(0.7)))
        }
        ctx.fill(ridge(size, base: horizon + 4, height: 26, seed: 31, octaves: 4), with: .linearGradient(
            Gradient(colors: [Color(white: 0.55), Color(white: 0.22)]), startPoint: CGPoint(x: 0, y: horizon), endPoint: CGPoint(x: 0, y: size.height)))
        var rng = SeededRandom(state: 99)
        for _ in 0..<160 {
            let depth = pow(rng.next(), 1.6)
            let y = horizon + 24 + depth * (size.height - horizon - 24)
            let w = (8 + rng.next() * 70) * (0.3 + depth * 1.4)
            let rect = CGRect(x: rng.next() * size.width, y: y, width: w, height: w * (0.15 + depth * 0.35))
            ctx.fill(Path(ellipseIn: rect), with: .color(Color(white: 0.16).opacity(0.55)))
            ctx.stroke(Path(ellipseIn: rect.offsetBy(dx: 0, dy: -1)), with: .color(Color(white: 0.7).opacity(0.25)), lineWidth: 1)
        }
    }
}

/// Meshes seen from the inside: environments (a slice of a sphere that grows
/// to all the way round as you turn the Crown) and panoramas (a curved wall).
/// Centred on -Z (straight ahead); both faces are emitted so culling never
/// hides them.
enum Meshes {
    static func sphereSegment(radius: Float, arc: Float, rows: Int = 36) -> MeshResource? {
        let cols = max(4, Int(72 * arc / (2 * .pi)))
        var positions: [SIMD3<Float>] = []
        var uvs: [SIMD2<Float>] = []
        for j in 0...rows {
            let v = Float(j) / Float(rows)
            let lat = (v - 0.5) * .pi
            for i in 0...cols {
                let lon = (Float(i) / Float(cols) - 0.5) * arc
                positions.append(radius * SIMD3<Float>(cos(lat) * sin(lon), sin(lat), -cos(lat) * cos(lon)))
                uvs.append(SIMD2<Float>(0.5 + lon / (2 * .pi), v))
            }
        }
        return make(positions, uvs, cols: cols, rows: rows)
    }

    static func cylinderSegment(radius: Float, height: Float, arc: Float) -> MeshResource? {
        let cols = max(8, Int(128 * arc / (2 * .pi)))
        var positions: [SIMD3<Float>] = []
        var uvs: [SIMD2<Float>] = []
        for j in 0...1 {
            let v = Float(j)
            for i in 0...cols {
                let u = Float(i) / Float(cols)
                let lon = (u - 0.5) * arc
                positions.append(SIMD3<Float>(radius * sin(lon), (v - 0.5) * height, -radius * cos(lon)))
                uvs.append(SIMD2<Float>(u, v))
            }
        }
        return make(positions, uvs, cols: cols, rows: 1)
    }

    private static func make(_ positions: [SIMD3<Float>], _ uvs: [SIMD2<Float>], cols: Int, rows: Int) -> MeshResource? {
        var indices: [UInt32] = []
        let stride = cols + 1
        for j in 0..<rows {
            for i in 0..<cols {
                let bl = UInt32(j * stride + i)
                let br = bl + 1
                let tl = UInt32((j + 1) * stride + i)
                let tr = tl + 1
                indices += [bl, br, tr, bl, tr, tl]
                indices += [bl, tr, br, bl, tl, tr]
            }
        }
        var descriptor = MeshDescriptor(name: "inside")
        descriptor.positions = MeshBuffers.Positions(positions)
        descriptor.textureCoordinates = MeshBuffers.TextureCoordinates(uvs)
        descriptor.primitives = .triangles(indices)
        return try? MeshResource.generate(from: [descriptor])
    }
}
