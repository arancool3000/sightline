import SwiftUI
import PhotosUI
import SafariServices
import ARKit
import RealityKit

@main
struct VisionApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
    }
}

struct ContentView: View {
    @StateObject private var spatial = Spatial()
    @State private var photoItems: [PhotosPickerItem] = []

    var body: some View {
        ZStack {
            ARContainer(spatial: spatial)
                .ignoresSafeArea()

            // System controls that stay on the glass (like visionOS's
            // Digital Crown and Control Center).
            VStack {
                HStack(alignment: .top) {
                    Text(spatial.status)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(.ultraThinMaterial, in: Capsule())
                    Spacer()
                    VStack(spacing: 10) {
                        CircleButton(symbol: "circle.grid.3x3.fill") { spatial.toggleHome() }
                        CircleButton(symbol: "scope") { spatial.bringWindowsHere() }
                        CircleButton(symbol: spatial.handsOn ? "hand.raised.fill" : "hand.raised.slash") { spatial.handsOn.toggle() }
                    }
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
        .sheet(item: $spatial.sheet) { sheet in
            SheetView(sheet: sheet, spatial: spatial)
        }
        .photosPicker(isPresented: $spatial.showPhotoPicker, selection: $photoItems, maxSelectionCount: 30, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task { @MainActor in
                var images: [UIImage] = []
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                        images.append(image)
                    }
                }
                spatial.addPhotos(images)
                photoItems = []
            }
        }
    }
}

struct CircleButton: View {
    let symbol: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 44, height: 44)
                .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
    }
}

struct ARContainer: UIViewRepresentable {
    let spatial: Spatial
    func makeUIView(context: Context) -> ARView { spatial.arView }
    func updateUIView(_ uiView: ARView, context: Context) {}
}

// 2D sheets for things that need the keyboard or a full browser.
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

enum Sheet: Identifiable {
    case note(UUID)
    case safari(URL)
    case urlEntry

    var id: String {
        switch self {
        case .note(let id): return "note-\(id.uuidString)"
        case .safari(let url): return "safari-\(url.absoluteString)"
        case .urlEntry: return "url"
        }
    }
}
