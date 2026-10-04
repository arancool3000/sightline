import SwiftUI
import SafariServices
import ARKit
import RealityKit
import Photos
import AVKit
import QuickLook
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
    @State private var controlCenter = false

    var body: some View {
        ZStack {
            if spatial.cameraMode == .ultraWide {
                CameraPreview(view: spatial.previewView)
                    .ignoresSafeArea()
            }
            ARContainer(spatial: spatial)
                .ignoresSafeArea()

            // Head-locked system UI, as on visionOS: the Control Center
            // chevron at the top and the Digital Crown at the top right.
            VStack(spacing: 10) {
                ZStack(alignment: .top) {
                    HStack(alignment: .top) {
                        if !spatial.status.isEmpty {
                            Text(spatial.status)
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(.ultraThinMaterial, in: Capsule())
                        }
                        Spacer()
                        DigitalCrown(spatial: spatial)
                    }
                    Button {
                        withAnimation(.spring(duration: 0.35)) { controlCenter.toggle() }
                    } label: {
                        Image(systemName: controlCenter ? "chevron.up" : "chevron.down")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 52, height: 28)
                            .background(.ultraThinMaterial, in: Capsule())
                            .overlay(Capsule().strokeBorder(Color.white.opacity(0.25), lineWidth: 0.8))
                    }
                    .buttonStyle(.plain)
                }
                if controlCenter {
                    ControlCenter(spatial: spatial) {
                        withAnimation(.spring(duration: 0.35)) { controlCenter = false }
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
                Spacer()
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
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onAppear { UIDevice.current.isBatteryMonitoringEnabled = true }
        .sheet(item: $spatial.sheet) { sheet in
            SheetView(sheet: sheet, spatial: spatial)
        }
    }
}

/// Tap: Home (or leave a panorama). Hold: recenter. Drag up and down: turn
/// the Crown to change immersion in an environment.
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
    let close: () -> Void

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
            HStack(spacing: 14) {
                CCButton(title: "Home", symbol: "circle.grid.3x3.fill", on: false) {
                    spatial.toggleHome()
                    close()
                }
                CCButton(title: "Recenter", symbol: "scope", on: false) {
                    spatial.recenter()
                    close()
                }
                CCButton(title: "Hands", symbol: spatial.handsOn ? "hand.raised.fill" : "hand.raised.slash", on: spatial.handsOn) {
                    spatial.handsOn.toggle()
                }
                CCButton(title: "Ultra Wide", symbol: "camera.aperture", on: spatial.cameraMode == .ultraWide) {
                    spatial.setCameraMode(spatial.cameraMode == .ar ? .ultraWide : .ar)
                }
                CCButton(title: "LiDAR Mesh", symbol: "cube.transparent", on: spatial.meshVisible) {
                    spatial.toggleMesh()
                }
                CCButton(title: "Environments", symbol: "mountain.2.fill", on: spatial.environment != nil) {
                    spatial.showEnvironments()
                    close()
                }
            }
            if spatial.environment != nil {
                HStack(spacing: 12) {
                    Image(systemName: "mountain.2")
                    Slider(value: Binding(get: { Double(spatial.immersion) }, set: { spatial.setImmersion(Float($0)) }))
                        .tint(.white)
                    Image(systemName: "mountain.2.fill")
                }
                .foregroundStyle(.secondary)
            }
            Text(spatial.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(18)
        .frame(maxWidth: 560)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 32, style: .continuous).strokeBorder(Color.white.opacity(0.2), lineWidth: 0.8))
    }
}

struct CCButton: View {
    let title: String
    let symbol: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(on ? Color.black : Color.white)
                    .frame(width: 54, height: 54)
                    .background(Circle().fill(on ? Color.white : Color.white.opacity(0.16)))
                Text(title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .buttonStyle(.plain)
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

// 2D sheets for things that need the keyboard, a full browser or a system picker.
struct SheetView: View {
    let sheet: Sheet
    @ObservedObject var spatial: Spatial
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        switch sheet {
        case .note(let id):
            NavigationStack {
                TextEditor(text: $text)
                    .font(.body)
                    .padding()
                    .navigationTitle("Note")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { dismiss() }
                        }
                    }
            }
            .onAppear { text = spatial.noteText(id) }
            .onDisappear { spatial.saveNote(id, text: text) }
        case .safari(let url):
            SafariView(url: url).ignoresSafeArea()
        case .urlEntry:
            NavigationStack {
                Form {
                    TextField("Search or enter website", text: $text)
                        .keyboardType(.webSearch)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { open() }
                }
                .navigationTitle("Safari")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Go") { open() } }
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
            }
        case .folderPicker:
            FolderPicker { url in spatial.addFolder(url) }
                .ignoresSafeArea()
        case .quickLook(let url):
            QuickLookView(url: url).ignoresSafeArea()
        case .video(let asset):
            AssetVideoView(asset: asset)
        }
    }

    private func open() {
        let q = text.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        let url: URL?
        if q.contains(".") && !q.contains(" ") {
            url = URL(string: q.hasPrefix("http") ? q : "https://\(q)")
        } else {
            var c = URLComponents(string: "https://duckduckgo.com/")
            c?.queryItems = [URLQueryItem(name: "q", value: q)]
            url = c?.url
        }
        dismiss()
        if let url {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 450_000_000)
                spatial.sheet = .safari(url)
            }
        }
    }
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
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

struct QuickLookView: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> UINavigationController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return UINavigationController(rootViewController: controller)
    }

    func updateUIViewController(_ vc: UINavigationController, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

struct AssetVideoView: View {
    let asset: PHAsset
    @State private var player: AVPlayer?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let player {
                VideoPlayer(player: player).ignoresSafeArea()
            } else {
                ProgressView().tint(.white)
            }
        }
        .onAppear {
            let options = PHVideoRequestOptions()
            options.isNetworkAccessAllowed = true
            options.deliveryMode = .automatic
            PHImageManager.default().requestPlayerItem(forVideo: asset, options: options) { item, _ in
                guard let item else { return }
                DispatchQueue.main.async {
                    let p = AVPlayer(playerItem: item)
                    player = p
                    p.play()
                }
            }
        }
        .onDisappear { player?.pause() }
    }
}

enum Sheet: Identifiable {
    case note(UUID)
    case safari(URL)
    case urlEntry
    case folderPicker
    case quickLook(URL)
    case video(PHAsset)

    var id: String {
        switch self {
        case .note(let id): return "note-\(id.uuidString)"
        case .safari(let url): return "safari-\(url.absoluteString)"
        case .urlEntry: return "url"
        case .folderPicker: return "folders"
        case .quickLook(let url): return "ql-\(url.absoluteString)"
        case .video(let asset): return "video-\(asset.localIdentifier)"
        }
    }
}
