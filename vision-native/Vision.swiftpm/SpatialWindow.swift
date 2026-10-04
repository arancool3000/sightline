import SwiftUI
import RealityKit
import simd

// MARK: - Window content model
//
// A window's UI is a list of nodes with known frames (in window points).
// We render the nodes with SwiftUI into a texture for the 3D panel, and use
// the same frames to hit-test your fingertip, pinch or touch — so buttons in
// the air behave exactly like buttons on screen.

struct UINode: Identifiable {
    let id: String
    let frame: CGRect
    let radius: CGFloat
    let action: (() -> Void)?
    /// Like `action`, but told where inside the node it was pressed (e.g. a web page).
    let onPoint: ((CGPoint) -> Void)?
    let view: AnyView

    var isLive: Bool { action != nil || onPoint != nil }

    @MainActor
    init<Content: View>(_ id: String, _ frame: CGRect, radius: CGFloat = 14, action: (() -> Void)? = nil,
                        onPoint: ((CGPoint) -> Void)? = nil, @ViewBuilder content: () -> Content) {
        self.id = id
        self.frame = frame
        self.radius = radius
        self.action = action
        self.onPoint = onPoint
        self.view = AnyView(content())
    }
}

@MainActor
protocol SpatialApp: AnyObject {
    var title: String { get }
    var size: CGSize { get }
    /// Set when the content changed and the texture must be redrawn.
    var dirty: Bool { get set }
    func nodes() -> [UINode]
    /// Called every frame (e.g. a clock sets `dirty` once a second).
    func tick(_ now: Date)
    /// The part of the window drawn as glass. Anything outside it (like a
    /// tab bar ornament) floats beside the glass.
    var glassRect: CGRect { get }
    /// False for content without glass, bar or close button (the Home View).
    var hasChrome: Bool { get }
    /// An extra 3D entity on the window (e.g. a video), in window-local metres.
    var attachment: Entity? { get }
    /// A voice command for this window (already lowercased, no punctuation).
    /// Return true if it was handled.
    func handleVoice(_ words: String) -> Bool
    func didClose()
}

extension SpatialApp {
    var glassRect: CGRect { CGRect(origin: .zero, size: size) }
    var hasChrome: Bool { true }
    var attachment: Entity? { nil }
    func handleVoice(_ words: String) -> Bool { false }
    func didClose() {}
}

/// visionOS glass. A real blur of the room isn't possible on a texture, so
/// this is a translucent tint with the bright top edge visionOS has.
struct Glass: View {
    var cornerRadius: CGFloat = 40

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        ZStack {
            shape.fill(LinearGradient(colors: [Color(white: 0.27).opacity(0.72), Color(white: 0.17).opacity(0.8)], startPoint: .top, endPoint: .bottom))
            shape.fill(LinearGradient(colors: [Color.white.opacity(0.1), .clear], startPoint: .top, endPoint: .center))
            shape.strokeBorder(LinearGradient(colors: [Color.white.opacity(0.45), Color.white.opacity(0.07), Color.white.opacity(0.2)], startPoint: .top, endPoint: .bottom), lineWidth: 1.4)
        }
    }
}

struct WindowCanvas: View {
    let size: CGSize
    let glass: CGRect?
    let nodes: [UINode]
    let hovered: String?
    let pressed: String?

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let glass {
                Glass()
                    .frame(width: glass.width, height: glass.height)
                    .offset(x: glass.minX, y: glass.minY)
            }
            ForEach(nodes) { node in
                let live = node.isLive
                node.view
                    .frame(width: node.frame.width, height: node.frame.height)
                    .overlay {
                        if live && (hovered == node.id || pressed == node.id) {
                            RoundedRectangle(cornerRadius: node.radius, style: .continuous)
                                .fill(Color.white.opacity(pressed == node.id ? 0.26 : 0.13))
                        }
                    }
                    // visionOS lifts what you look at, and presses it in.
                    .scaleEffect(pressed == node.id ? 0.95 : (live && hovered == node.id ? 1.05 : 1))
                    .offset(x: node.frame.minX, y: node.frame.minY)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .environment(\.colorScheme, .dark)
    }
}

// MARK: - Window in the room

enum WindowRegion: Equatable {
    case content(String?)
    case bar
    case close
}

struct WindowHit {
    let window: SpatialWindow
    let distance: Float
    let point: SIMD3<Float>
    let region: WindowRegion
}

@MainActor
final class SpatialWindow {
    /// Metres per window point: a 600-pt window is 36 cm wide.
    static let metresPerPoint: Float = 0.0006

    let app: SpatialApp
    let root = Entity()
    private let panel: ModelEntity
    private let bar: ModelEntity
    private let closeButton: ModelEntity
    private var texture: TextureResource?
    private(set) var nodes: [UINode] = []
    var hovered: String? { didSet { if hovered != oldValue { needsRedraw = true } } }
    var pressed: String? { didSet { if pressed != oldValue { needsRedraw = true } } }
    var barHighlighted = false { didSet { if barHighlighted != oldValue { updateBar() } } }
    var needsRedraw = true

    /// Where the window wants to be; the actual pose glides there.
    var targetPosition = SIMD3<Float>(0, 0, -0.6)
    var targetOrientation = simd_quatf(angle: 0, axis: SIMD3<Float>(0, 1, 0))
    var onWall = false

    var size: CGSize { app.size }
    var widthM: Float { Float(size.width) * Self.metresPerPoint }
    var heightM: Float { Float(size.height) * Self.metresPerPoint }
    var position: SIMD3<Float> { root.position }
    var orientation: simd_quatf { root.orientation }
    /// Direction the window faces (toward you).
    var normal: SIMD3<Float> { root.orientation.act(SIMD3<Float>(0, 0, 1)) }

    private static let barOffset: Float = 0.026
    private static let closeOffsetX: Float = -0.078

    init(app: SpatialApp) {
        self.app = app
        let w = Float(app.size.width) * Self.metresPerPoint
        let h = Float(app.size.height) * Self.metresPerPoint
        panel = ModelEntity(mesh: .generatePlane(width: w, height: h, cornerRadius: 0.02), materials: [UnlitMaterial(color: .black)])
        bar = ModelEntity(mesh: .generatePlane(width: 0.11, height: 0.012, cornerRadius: 0.006), materials: [UnlitMaterial(color: .white)])
        closeButton = ModelEntity(mesh: .generatePlane(width: 0.022, height: 0.022, cornerRadius: 0.011), materials: [UnlitMaterial(color: .gray)])
        // The bar and close button sit under the glass, not under ornaments.
        let glass = app.glassRect
        let gx = Float(glass.midX - app.size.width / 2) * Self.metresPerPoint
        let gy = Float(app.size.height / 2 - glass.maxY) * Self.metresPerPoint
        bar.position = SIMD3(gx, gy - Self.barOffset, 0.001)
        closeButton.position = SIMD3(gx + Self.closeOffsetX, gy - Self.barOffset, 0.001)
        root.addChild(panel)
        if app.hasChrome {
            root.addChild(bar)
            root.addChild(closeButton)
        }
        if let attachment = app.attachment { root.addChild(attachment) }
        // Windows open with a small grow, like visionOS.
        root.scale = SIMD3<Float>(repeating: 0.86)
        updateBar()
        if let tex = Self.closeTexture {
            var m = UnlitMaterial()
            m.color = .init(tint: .white, texture: .init(tex))
            m.blending = .transparent(opacity: .init(floatLiteral: 1))
            closeButton.model?.materials = [m]
        }
    }

    private func updateBar() {
        var m = UnlitMaterial(color: UIColor(white: 1, alpha: barHighlighted ? 1 : 0.65))
        m.blending = .transparent(opacity: .init(floatLiteral: barHighlighted ? 1 : 0.7))
        bar.model?.materials = [m]
    }

    /// Re-render the SwiftUI content into the panel's texture.
    func redraw() {
        nodes = app.nodes()
        let canvas = WindowCanvas(size: size, glass: app.hasChrome ? app.glassRect : nil, nodes: nodes, hovered: hovered, pressed: pressed)
        let renderer = ImageRenderer(content: canvas)
        renderer.scale = 2
        guard let image = renderer.cgImage else { return }
        do {
            if let texture {
                try texture.replace(withImage: image, options: .init(semantic: .color))
            } else {
                let tex = try TextureResource.generate(from: image, options: .init(semantic: .color))
                texture = tex
                var m = UnlitMaterial()
                m.color = .init(tint: .white, texture: .init(tex))
                m.blending = .transparent(opacity: .init(floatLiteral: 1))
                panel.model?.materials = [m]
            }
        } catch {
            print("Texture update failed: \(error)")
        }
        needsRedraw = false
        app.dirty = false
    }

    /// Glide toward the target pose (smooth, frame-rate independent).
    func animate(dt: Float) {
        let k = 1 - exp(-dt * 16)
        root.position += (targetPosition - root.position) * k
        root.orientation = simd_slerp(root.orientation, targetOrientation, k)
        root.scale += (SIMD3<Float>(repeating: 1) - root.scale) * (1 - exp(-dt * 9))
    }

    func snapToTarget() {
        root.position = targetPosition
        root.orientation = targetOrientation
    }

    // MARK: Hit testing

    /// Window-local position of a world point: x/y in window points (origin
    /// top-left of the panel) and z = metres in front of the panel.
    func local(_ world: SIMD3<Float>) -> (x: CGFloat, y: CGFloat, z: Float) {
        let l = root.orientation.inverse.act(world - root.position)
        let x = CGFloat(l.x / Self.metresPerPoint) + size.width / 2
        let y = size.height / 2 - CGFloat(l.y / Self.metresPerPoint)
        return (x, y, l.z)
    }

    func world(x: CGFloat, y: CGFloat, z: Float = 0) -> SIMD3<Float> {
        let lx = Float(x - size.width / 2) * Self.metresPerPoint
        let ly = Float(size.height / 2 - y) * Self.metresPerPoint
        return root.position + root.orientation.act(SIMD3(lx, ly, z))
    }

    func region(x: CGFloat, y: CGFloat) -> WindowRegion? {
        let glass = app.glassRect
        let barY = glass.maxY + CGFloat(Self.barOffset / Self.metresPerPoint)
        if app.hasChrome, abs(y - barY) < 26 {
            let closeX = glass.midX + CGFloat(Self.closeOffsetX / Self.metresPerPoint)
            if abs(x - closeX) < 26 { return .close }
            if abs(x - glass.midX) < 110 { return .bar }
        }
        guard x >= 0, y >= 0, x <= size.width, y <= size.height else { return nil }
        let node = nodes.last { $0.isLive && $0.frame.insetBy(dx: -6, dy: -6).contains(CGPoint(x: x, y: y)) }
        return .content(node?.id)
    }

    func hit(origin: SIMD3<Float>, direction: SIMD3<Float>) -> WindowHit? {
        let n = normal
        let denom = simd_dot(direction, n)
        guard abs(denom) > 1e-4 else { return nil }
        let t = simd_dot(root.position - origin, n) / denom
        guard t > 0 else { return nil }
        let p = origin + direction * t
        let l = local(p)
        guard let r = region(x: l.x, y: l.y) else { return nil }
        return WindowHit(window: self, distance: t, point: p, region: r)
    }

    /// `point` is where it was pressed, in window points.
    func activate(_ id: String?, at point: CGPoint? = nil) {
        guard let id, let node = nodes.first(where: { $0.id == id }) else { return }
        if let onPoint = node.onPoint {
            let p = point ?? CGPoint(x: node.frame.midX, y: node.frame.midY)
            onPoint(CGPoint(x: p.x - node.frame.minX, y: p.y - node.frame.minY))
        } else {
            node.action?()
        }
        app.dirty = true
    }

    // Small "×" texture for the close button, rendered once.
    private static let closeTexture: TextureResource? = {
        let view = ZStack {
            Circle().fill(Color(white: 0.3).opacity(0.9))
            Image(systemName: "xmark").font(.system(size: 22, weight: .bold)).foregroundStyle(.white)
        }
        .frame(width: 64, height: 64)
        let r = ImageRenderer(content: view)
        r.scale = 2
        guard let cg = r.cgImage else { return nil }
        return try? TextureResource.generate(from: cg, options: .init(semantic: .color))
    }()
}

// MARK: - Shared building blocks for app UIs

@MainActor
enum Look {
    static func label(_ id: String, _ text: String, _ frame: CGRect, size: CGFloat = 17, weight: Font.Weight = .regular,
                      color: Color = .white, align: Alignment = .leading) -> UINode {
        UINode(id, frame) {
            Text(text)
                .font(.system(size: size, weight: weight))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: align)
        }
    }

    static func pill(_ id: String, _ text: String, _ frame: CGRect, fill: Color = Color.white.opacity(0.16),
                     textColor: Color = .white, action: @escaping () -> Void) -> UINode {
        UINode(id, frame, radius: frame.height / 2, action: action) {
            Text(text)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(textColor)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Capsule().fill(fill))
        }
    }

    static func symbolButton(_ id: String, _ symbol: String, _ frame: CGRect, action: @escaping () -> Void) -> UINode {
        UINode(id, frame, radius: frame.height / 2, action: action) {
            Image(systemName: symbol)
                .font(.system(size: frame.height * 0.42, weight: .semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Circle().fill(Color.white.opacity(0.14)))
        }
    }

    /// A visionOS tab bar ornament: a vertical glass capsule of symbols.
    static func ornament(_ prefix: String, symbols: [String], selected: Int, x: CGFloat, centerY: CGFloat,
                         select: @escaping (Int) -> Void) -> [UINode] {
        let height = CGFloat(symbols.count) * 58 + 12
        let top = centerY - height / 2
        var list: [UINode] = [
            UINode("\(prefix)-bg", CGRect(x: x, y: top, width: 66, height: height), radius: 33) {
                Capsule().fill(Color(white: 0.2).opacity(0.78))
                    .overlay(Capsule().strokeBorder(Color.white.opacity(0.28), lineWidth: 1))
            },
        ]
        for (i, symbol) in symbols.enumerated() {
            let on = i == selected
            list.append(UINode("\(prefix)\(i)", CGRect(x: x + 7, y: top + 9 + CGFloat(i) * 58, width: 52, height: 52), radius: 26, action: { select(i) }) {
                Image(systemName: symbol)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(on ? Color.black : Color.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Circle().fill(on ? Color.white : Color.clear))
            })
        }
        return list
    }

    static func appIcon(_ id: String, symbol: String, colors: [Color], title: String, at origin: CGPoint, action: @escaping () -> Void) -> UINode {
        UINode(id, CGRect(x: origin.x, y: origin.y, width: 92, height: 118), radius: 46, action: action) {
            VStack(spacing: 8) {
                ZStack {
                    Circle().fill(LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom))
                    Circle().fill(LinearGradient(colors: [Color.white.opacity(0.45), .clear], startPoint: .top, endPoint: .center))
                    Image(systemName: symbol).font(.system(size: 34, weight: .semibold)).foregroundStyle(.white)
                }
                .frame(width: 84, height: 84)
                .shadow(color: .black.opacity(0.35), radius: 6, y: 4)
                Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(.white).lineLimit(1)
                    .shadow(color: .black.opacity(0.7), radius: 3, y: 1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }
}
