import SwiftUI
import WebKit

/// A web browser that lives in a window. The page renders in a real WebKit
/// view kept behind the camera, and snapshots of it are drawn on the glass.
/// Pinch a link to click it; pinch a text field and say what to type.
@MainActor
final class BrowserApp: NSObject, SpatialApp, WKNavigationDelegate {
    let title = "Safari"
    let size = CGSize(width: 840, height: 560)
    var dirty = true
    weak var spatial: Spatial?
    let webView: WKWebView

    /// The page area in window points (1 point = 1 CSS pixel).
    static let page = CGRect(x: 20, y: 76, width: 800, height: 464)

    private var snapshot: UIImage?
    private var showingPage = false
    private var lastSnapshot: TimeInterval = 0
    private var listeningForAddress = false
    private var typingIntoField = false
    private let favorites: [(String, String, String)] = [
        ("Wikipedia", "https://en.m.wikipedia.org", "book.fill"),
        ("YouTube", "https://m.youtube.com", "play.rectangle.fill"),
        ("BBC News", "https://www.bbc.co.uk/news", "newspaper.fill"),
        ("Apple", "https://www.apple.com", "applelogo"),
        ("Maps", "https://www.openstreetmap.org", "map.fill"),
        ("GitHub", "https://github.com", "chevron.left.forwardslash.chevron.right"),
    ]

    init(spatial: Spatial) {
        self.spatial = spatial
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: CGRect(origin: .zero, size: Self.page.size), configuration: config)
        super.init()
        webView.navigationDelegate = self
    }

    // MARK: Navigation

    func go(_ text: String) {
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        let squashed = q.replacingOccurrences(of: " dot ", with: ".").replacingOccurrences(of: " ", with: "")
        let url: URL?
        if q.lowercased().hasPrefix("http") {
            url = URL(string: q)
        } else if squashed.contains("."), !squashed.hasSuffix("."), q.split(separator: " ").count <= 3 {
            url = URL(string: "https://\(squashed.lowercased())")
        } else {
            var c = URLComponents(string: "https://duckduckgo.com/")
            c?.queryItems = [URLQueryItem(name: "q", value: q)]
            url = c?.url
        }
        guard let url else { return }
        showingPage = true
        webView.load(URLRequest(url: url))
        dirty = true
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        refresh(after: 0.2)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        refresh(after: 0.1)
        refresh(after: 1.2)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        spatial?.toast("Couldn't load the page")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        spatial?.toast("Couldn't open that site")
    }

    // MARK: Snapshots

    func tick(_ now: Date) {
        let t = CACurrentMediaTime()
        if showingPage, t - lastSnapshot > 1.2 { takeSnapshot() }
    }

    private func refresh(after seconds: Double) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            self.takeSnapshot()
        }
    }

    private func takeSnapshot() {
        guard showingPage else { return }
        lastSnapshot = CACurrentMediaTime()
        webView.takeSnapshot(with: nil) { [weak self] image, _ in
            guard let image else { return }
            Task { @MainActor in
                self?.snapshot = image
                self?.dirty = true
            }
        }
    }

    // MARK: Page interaction

    private func click(_ p: CGPoint) {
        let js = """
        (function(x,y){var e=document.elementFromPoint(x,y);if(!e)return '';
        var f=e.closest('input:not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]');
        if(f){f.focus();return 'field';}
        var c=e.closest('a,button,[role=button],label,summary,select,input')||e;c.click();return 'click';})(\(p.x),\(p.y))
        """
        webView.evaluateJavaScript(js) { [weak self] result, _ in
            let kind = result as? String
            Task { @MainActor in
                guard let self else { return }
                if kind == "field" { self.typeIntoField() }
                self.refresh(after: 0.25)
                self.refresh(after: 1.0)
            }
        }
    }

    /// Dictate into the focused field; when you finish, it submits (like pressing Go).
    private func typeIntoField() {
        typingIntoField = true
        dirty = true
        spatial?.voice.beginDictation(onText: { [weak self] text in
            self?.insert(text)
        }, onEnd: { [weak self] in
            guard let self else { return }
            self.typingIntoField = false
            self.submitField()
            self.dirty = true
        })
    }

    private func insert(_ text: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]), let json = String(data: data, encoding: .utf8) else { return }
        let js = """
        (function(s){var e=document.activeElement;if(!e)return;
        if(e.isContentEditable){e.textContent+=(e.textContent?' ':'')+s;}else{e.value=(e.value?e.value+' ':'')+s;}
        e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})(\(json)[0])
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
        refresh(after: 0.15)
    }

    private func submitField() {
        let js = """
        (function(){var e=document.activeElement;if(!e)return;
        ['keydown','keypress','keyup'].forEach(function(t){e.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));});
        if(e.form){if(e.form.requestSubmit)e.form.requestSubmit();else e.form.submit();}})()
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
        refresh(after: 0.5)
        refresh(after: 1.5)
    }

    private func scroll(_ dy: CGFloat) {
        webView.evaluateJavaScript("window.scrollBy(0,\(dy))", completionHandler: nil)
        refresh(after: 0.12)
        refresh(after: 0.6)
    }

    /// "click sign in": finds a visible link or button by its words.
    private func clickText(_ words: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [words]), let json = String(data: data, encoding: .utf8) else { return }
        let js = """
        (function(q){q=q.toLowerCase();var best=null,partial=null;
        var els=document.querySelectorAll('a,button,[role=button],input[type=submit],summary');
        for(var i=0;i<els.length;i++){var e=els[i];var r=e.getBoundingClientRect();if(r.width<1||r.height<1)continue;
        var t=(e.innerText||e.value||e.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim().toLowerCase();if(!t)continue;
        var vis=r.bottom>0&&r.top<innerHeight;if(t===q){if(vis||!best)best=e;if(vis)break;}else if(!partial&&t.indexOf(q)>=0)partial=e;}
        var e=best||partial;if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true;})(\(json)[0])
        """
        webView.evaluateJavaScript(js) { [weak self] result, _ in
            let found = (result as? Bool) ?? false
            Task { @MainActor in
                if !found { self?.spatial?.toast("No link called “\(words)”") }
                self?.refresh(after: 0.3)
                self?.refresh(after: 1.2)
            }
        }
    }

    /// Pinch the address bar: say a website or a search.
    private func listenForAddress() {
        listeningForAddress = true
        dirty = true
        var said = ""
        spatial?.voice.beginDictation(onText: { [weak self] text in
            said = text
            self?.spatial?.voice.endDictation()
        }, onEnd: { [weak self] in
            guard let self else { return }
            self.listeningForAddress = false
            self.dirty = true
            if !said.isEmpty { self.go(said) }
        })
    }

    // MARK: Voice

    func handleVoice(_ t: String) -> Bool {
        switch t {
        case "scroll down", "page down", "down", "scroll": scroll(380)
        case "scroll up", "page up", "up": scroll(-380)
        case "top", "scroll to top", "go to top": webView.evaluateJavaScript("window.scrollTo(0,0)", completionHandler: nil); refresh(after: 0.15)
        case "back", "go back": if webView.canGoBack { webView.goBack() }
        case "forward", "go forward": if webView.canGoForward { webView.goForward() }
        case "reload", "refresh", "reload page": webView.reload()
        case "favorites", "start page", "new tab":
            showingPage = false
            dirty = true
        case "type", "dictate", "type here": typeIntoField()
        default:
            for prefix in ["click ", "tap ", "press ", "open link ", "select "] where t.hasPrefix(prefix) {
                clickText(String(t.dropFirst(prefix.count)))
                return true
            }
            return false
        }
        return true
    }

    // MARK: Drawing

    func nodes() -> [UINode] {
        var list: [UINode] = [
            Look.symbolButton("back", "chevron.backward", CGRect(x: 20, y: 18, width: 44, height: 44)) { [weak self] in
                if self?.webView.canGoBack == true { self?.webView.goBack() } else { self?.showingPage = false }
            },
            Look.symbolButton("fwd", "chevron.forward", CGRect(x: 72, y: 18, width: 44, height: 44)) { [weak self] in
                self?.webView.goForward()
            },
            Look.symbolButton("reload", "arrow.clockwise", CGRect(x: 124, y: 18, width: 44, height: 44)) { [weak self] in
                self?.webView.reload()
            },
        ]
        let listening = listeningForAddress || typingIntoField
        let host = showingPage ? (webView.url?.host ?? "Loading…") : "Pinch here and say a website or a search"
        let label = listeningForAddress ? "Listening… say a website or a search" : typingIntoField ? "Typing by voice… say “done” to send" : host
        list.append(UINode("address", CGRect(x: 180, y: 18, width: 440, height: 44), radius: 22, action: { [weak self] in
            self?.listenForAddress()
        }) {
            HStack(spacing: 8) {
                Image(systemName: listening ? "waveform" : "mic.fill").font(.system(size: 15, weight: .semibold))
                Text(label).font(.system(size: 15, weight: .medium)).lineLimit(1)
            }
            .foregroundStyle(listening ? Color.black : Color.white)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Capsule().fill(listening ? Color.white : Color.white.opacity(0.16)))
        })
        list.append(Look.symbolButton("home", "star.fill", CGRect(x: 632, y: 18, width: 44, height: 44)) { [weak self] in
            self?.showingPage = false
        })
        list.append(Look.symbolButton("up", "chevron.up", CGRect(x: 716, y: 18, width: 44, height: 44)) { [weak self] in self?.scroll(-380) })
        list.append(Look.symbolButton("down", "chevron.down", CGRect(x: 768, y: 18, width: 44, height: 44)) { [weak self] in self?.scroll(380) })

        let page = Self.page
        if showingPage {
            let image = snapshot
            list.append(UINode("page", page, radius: 16, onPoint: { [weak self] p in self?.click(p) }) {
                ZStack {
                    Color.white
                    if let image { Image(uiImage: image).resizable().frame(width: page.width, height: page.height) }
                }
                .frame(width: page.width, height: page.height)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            })
        } else {
            list.append(Look.label("hint", "Say “search for …”, “go to bbc.co.uk”, “scroll down” or “click …”", CGRect(x: 40, y: 92, width: 760, height: 24), size: 15, color: .white.opacity(0.65), align: .center))
            for (i, fav) in favorites.enumerated() {
                let frame = CGRect(x: 40 + CGFloat(i % 3) * 256, y: 140 + CGFloat(i / 3) * 170, width: 240, height: 150)
                let url = fav.1
                list.append(UINode("fav\(i)", frame, radius: 24, action: { [weak self] in self?.go(url) }) {
                    VStack(spacing: 10) {
                        Image(systemName: fav.2).font(.system(size: 34, weight: .semibold)).foregroundStyle(.white)
                        Text(fav.0).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Color.white.opacity(0.12)))
                })
            }
        }
        return list
    }
}
