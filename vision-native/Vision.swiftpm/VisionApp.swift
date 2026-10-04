import SwiftUI
import ARKit
import RealityKit
import WebKit
import UniformTypeIdentifiers

@main
struct VisionApp: App {
    var body: some SwiftUI.Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
    }
}

struct ContentView: View {
    @StateObject private var spatial = Spatial()

    var body: some View {
        let store = spatial.handTargets
        ZStack {
            // The browser's real web view renders here, hidden behind the
            // camera; its snapshots are what you see in the Safari window.
            Color.clear
                .frame(width: 1, height: 1)
                .overlay(alignment: .topLeading) {
                    WebHost(webView: spatial.browserApp.webView)
                        .frame(width: BrowserApp.page.width, height: BrowserApp.page.height)
                }
                .allowsHitTesting(false)

            if spatial.cameraMode == .ultraWide {
                CameraPreview(view: spatial.previewView)
                    .ignoresSafeArea()
            }
            ARContainer(spatial: spatial)
                .ignoresSafeArea()

            // Head-locked system UI, as on visionOS. Every control here can
            // be pinched by hand as well as touched.
            VStack(spacing: 10) {
                ZStack(alignment: .top) {
                    HStack(alignment: .top) {
                        VoiceIndicator(voice: spatial.voice, status: spatial.status, voiceOn: spatial.voiceOn)
                        Spacer()
                        DigitalCrown(spatial: spatial)
                            .handTarget("crown", hovered: spatial.handHover == "crown") {}
                    }
                    Image(systemName: spatial.controlCenterShown ? "chevron.up" : "chevron.down")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 56, height: 30)
                        .background(.ultraThinMaterial, in: Capsule())
                        .overlay(Capsule().strokeBorder(Color.white.opacity(0.25), lineWidth: 0.8))
                        .contentShape(Capsule())
                        .onTapGesture { spatial.controlCenterShown.toggle() }
                        .handTarget("cc-toggle", hovered: spatial.handHover == "cc-toggle") { spatial.controlCenterShown.toggle() }
                }
                if spatial.controlCenterShown {
                    ControlCenter(spatial: spatial)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                Spacer()
                DictationDone(voice: spatial.voice, hovered: spatial.handHover == "dictation-done")
                if let toast = spatial.toastText {
                    Text(toast)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                        .background(.ultraThinMaterial, in: Capsule())
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .padding(16)
            .animation(.spring(duration: 0.35), value: spatial.toastText)
            .animation(.spring(duration: 0.35), value: spatial.controlCenterShown)

            // Where your fingertip is when it's over an on-screen control.
            Color.clear
                .ignoresSafeArea()
                .overlay(alignment: .topLeading) {
                    if let p = spatial.handPoint {
                        Circle()
                            .fill(Color.white.opacity(0.3))
                            .overlay(Circle().strokeBorder(Color.white, lineWidth: 2))
                            .frame(width: 22, height: 22)
                            .position(p)
                    }
                }
                .allowsHitTesting(false)
        }
        .onPreferenceChange(HandTargetsKey.self) { targets in
            store.set(targets)
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onAppear { UIDevice.current.isBatteryMonitoringEnabled = true }
        .sheet(item: $spatial.sheet) { sheet in
            SheetView(sheet: sheet, spatial: spatial)
        }
    }
}

// MARK: - Hand-pinchable on-screen controls

struct HandTargetsKey: PreferenceKey {
    static let defaultValue: [String: HandTarget] = [:]
    static func reduce(value: inout [String: HandTarget], nextValue: () -> [String: HandTarget]) {
        value.merge(nextValue()) { $1 }
    }
}

extension View {
    /// Registers this control so a pinch with your fingertip over it presses it.
    func handTarget(_ id: String, hovered: Bool, action: @escaping () -> Void) -> some View {
        self
            .scaleEffect(hovered ? 1.1 : 1)
            .brightness(hovered ? 0.12 : 0)
            .animation(.easeOut(duration: 0.15), value: hovered)
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: HandTargetsKey.self, value: [id: HandTarget(frame: geo.frame(in: .global), action: action)])
                }
            )
    }
}

/// While dictating, a big Done you can pinch (or just say "done").
struct DictationDone: View {
    @ObservedObject var voice: VoiceControl
    let hovered: Bool

    var body: some View {
        if voice.dictating {
            Text("Done")
                .font(.headline)
                .foregroundStyle(.black)
                .padding(.horizontal, 26)
                .padding(.vertical, 10)
                .background(Capsule().fill(.white))
                .onTapGesture { voice.endDictation() }
                .handTarget("dictation-done", hovered: hovered) { voice.endDictation() }
        }
    }
}

/// The listening indicator: what you're saying, live.
struct VoiceIndicator: View {
    @ObservedObject var voice: VoiceControl
    let status: String
    let voiceOn: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !status.isEmpty {
                pill(Text(status), symbol: "exclamationmark.triangle.fill")
            }
            if let problem = voice.problem, voiceOn {
                pill(Text(problem), symbol: "mic.slash.fill")
            } else if voice.listening {
                if voice.dictating {
                    pill(Text(voice.heard.isEmpty ? "Dictating… say “done” to finish" : voice.heard).italic(), symbol: "waveform")
                } else if !voice.heard.isEmpty {
                    pill(Text(voice.heard).italic(), symbol: "waveform")
                } else {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .frame(width: 30, height: 30)
                        .background(.ultraThinMaterial, in: Circle())
                }
            }
        }
        .frame(maxWidth: 420, alignment: .leading)
        .animation(.easeOut(duration: 0.15), value: voice.heard)
    }

    private func pill(_ text: Text, symbol: String) -> some View {
        HStack(spacing: 7) {
            Image(systemName: symbol).font(.system(size: 12, weight: .semibold))
            text.font(.caption.weight(.semibold)).lineLimit(2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.ultraThinMaterial, in: Capsule())
    }
}

/// Touch: tap for Home, hold to recenter, drag up and down for immersion.
/// By hand: the same with a pinch while your fingertip is over it.
struct DigitalCrown: View {
    @ObservedObject var spatial: Spatial
    @State private var pressStart: Date?
    @State private var startImmersion: Float = 0
    @State private var turning = false

    var body: some View {
        ZStack {
            Capsule()
                .fill(LinearGradient(colors: [Color(white: 0.85), Color(white: 0.45), Color(white: 0.7)], startPoint: .leading, endPoint: .trailing))
            VStack(spacing: 4) {
                ForEach(0..<8, id: \.self) { _ in
                    Capsule().fill(Color.black.opacity(0.3)).frame(width: 20, height: 1.5)
                }
            }
        }
        .frame(width: 30, height: 60)
        .shadow(color: .black.opacity(0.4), radius: 5, y: 2)
        .scaleEffect(pressStart == nil ? 1 : 0.94)
        .contentShape(Rectangle().inset(by: -12))
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { g in
                    if pressStart == nil {
                        pressStart = Date()
                        startImmersion = spatial.immersion
                        turning = false
                    }
                    if abs(g.translation.height) > 8 { turning = true }
                    if turning { spatial.setImmersion(startImmersion - Float(g.translation.height) / 220) }
                }
                .onEnded { _ in
                    let held = pressStart.map { Date().timeIntervalSince($0) } ?? 0
                    let wasTurning = turning
                    pressStart = nil
                    turning = false
                    guard !wasTurning else { return }
                    if held > 0.6 { spatial.recenter() } else { spatial.crownPressed() }
                }
        )
        .accessibilityLabel("Digital Crown")
    }
}

struct ControlCenter: View {
    @ObservedObject var spatial: Spatial

    var body: some View {
        VStack(spacing: 14) {
            HStack(alignment: .top) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.date, style: .time).font(.system(size: 26, weight: .semibold))
                        Text(context.date.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                BatteryView()
            }
            HStack(spacing: 12) {
                button("Home", "circle.grid.3x3.fill", on: false) {
                    spatial.toggleHome()
                    spatial.controlCenterShown = false
                }
                button("Recenter", "scope", on: false) {
                    spatial.recenter()
                    spatial.controlCenterShown = false
                }
                button("Voice", spatial.voiceOn ? "mic.fill" : "mic.slash.fill", on: spatial.voiceOn) {
                    spatial.setVoice(!spatial.voiceOn)
                }
                button("Hands", spatial.handsOn ? "hand.raised.fill" : "hand.raised.slash", on: spatial.handsOn) {
                    spatial.handsOn.toggle()
                }
                button("Ultra Wide", "camera.aperture", on: spatial.cameraMode == .ultraWide) {
                    spatial.setCameraMode(spatial.cameraMode == .ar ? .ultraWide : .ar)
                }
                button("Mesh", "cube.transparent", on: spatial.meshVisible) {
                    spatial.toggleMesh()
                }
                button("Worlds", "mountain.2.fill", on: spatial.environment != nil) {
                    spatial.showEnvironments()
                    spatial.controlCenterShown = false
                }
            }
            if spatial.environment != nil {
                HStack(spacing: 12) {
                    small("imm-down", "minus") { spatial.setImmersion(spatial.immersion - 0.25) }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.18))
                            Capsule().fill(Color.white).frame(width: geo.size.width * CGFloat(spatial.immersion))
                        }
                    }
                    .frame(height: 8)
                    small("imm-up", "plus") { spatial.setImmersion(spatial.immersion + 0.25) }
                }
            }
            Text(spatial.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(18)
        .frame(maxWidth: 600)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 32, style: .continuous).strokeBorder(Color.white.opacity(0.2), lineWidth: 0.8))
    }

    private func button(_ title: String, _ symbol: String, on: Bool, action: @escaping () -> Void) -> some View {
        let id = "cc-\(title)"
        return VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(on ? Color.black : Color.white)
                .frame(width: 52, height: 52)
                .background(Circle().fill(on ? Color.white : Color.white.opacity(0.16)))
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white)
                .lineLimit(1)
                .fixedSize()
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: action)
        .handTarget(id, hovered: spatial.handHover == id, action: action)
    }

    private func small(_ id: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .bold))
            .frame(width: 38, height: 38)
            .background(Circle().fill(Color.white.opacity(0.16)))
            .contentShape(Circle())
            .onTapGesture(perform: action)
            .handTarget(id, hovered: spatial.handHover == id, action: action)
    }
}

struct BatteryView: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            let level = UIDevice.current.batteryLevel
            if level >= 0 {
                HStack(spacing: 6) {
                    Text("\(Int((level * 100).rounded()))%").font(.subheadline.weight(.semibold))
                    Image(systemName: level > 0.75 ? "battery.100percent" : level > 0.5 ? "battery.75percent" : level > 0.25 ? "battery.50percent" : "battery.25percent")
                }
            }
        }
    }
}

struct ARContainer: UIViewRepresentable {
    let spatial: Spatial
    func makeUIView(context: Context) -> ARView { spatial.arView }
    func updateUIView(_ uiView: ARView, context: Context) {}
}

struct CameraPreview: UIViewRepresentable {
    let view: CameraPreviewView
    func makeUIView(context: Context) -> CameraPreviewView { view }
    func updateUIView(_ uiView: CameraPreviewView, context: Context) {}
}

struct WebHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

// Only setup still uses a sheet: picking a folder needs the system picker.
struct SheetView: View {
    let sheet: Sheet
    @ObservedObject var spatial: Spatial

    var body: some View {
        switch sheet {
        case .folderPicker:
            FolderPicker { url in spatial.addFolder(url) }
                .ignoresSafeArea()
        }
    }
}

/// Pick any folder (iCloud Drive, On My iPhone, a USB drive…) to add to Files.
struct FolderPicker: UIViewControllerRepresentable {
    let onPick: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.delegate = context.coordinator
        picker.allowsMultipleSelection = false
        return picker
    }

    func updateUIViewController(_ vc: UIDocumentPickerViewController, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: (URL) -> Void
        init(onPick: @escaping (URL) -> Void) { self.onPick = onPick }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            if let url = urls.first { onPick(url) }
        }
    }
}

enum Sheet: Identifiable {
    case folderPicker

    var id: String {
        switch self {
        case .folderPicker: return "folders"
        }
    }
}
