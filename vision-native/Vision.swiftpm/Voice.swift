import Foundation
import Speech
import AVFoundation

/// Hands-free control: voice commands that are always listening, and dictation
/// in place of the keyboard. Speech is recognised on the iPhone when it can
/// be; a short pause ends each utterance.
@MainActor
final class VoiceControl: ObservableObject {
    @Published private(set) var listening = false
    /// What you're saying right now.
    @Published private(set) var heard = ""
    @Published private(set) var dictating = false
    @Published private(set) var problem: String?

    /// A finished command utterance.
    var onCommand: ((String) -> Void)?

    private var dictationText: ((String) -> Void)?
    private var dictationEnded: (() -> Void)?
    private let recognizer = SFSpeechRecognizer()
    private let engine = AVAudioEngine()
    private let box = RequestBox()
    private var task: SFSpeechRecognitionTask?
    private var generation = 0
    private var lastChange = Date()
    private var timer: Timer?
    private var wanted = false

    static let stopPhrases: Set<String> = ["done", "im done", "stop dictation", "stop dictating", "end dictation", "finish", "finished", "thats it", "thats all"]

    /// The audio thread hands buffers to whichever request is current.
    final class RequestBox: @unchecked Sendable {
        private let lock = NSLock()
        private var request: SFSpeechAudioBufferRecognitionRequest?
        func set(_ r: SFSpeechAudioBufferRecognitionRequest?) {
            lock.lock()
            let old = request
            request = r
            lock.unlock()
            old?.endAudio()
        }
        func append(_ buffer: AVAudioPCMBuffer) {
            lock.lock()
            let r = request
            lock.unlock()
            r?.append(buffer)
        }
    }

    // MARK: Start / stop

    func start() {
        wanted = true
        guard !listening else { return }
        SFSpeechRecognizer.requestAuthorization { status in
            Task { @MainActor in self.afterSpeechPermission(status) }
        }
    }

    private func afterSpeechPermission(_ status: SFSpeechRecognizerAuthorizationStatus) {
        guard status == .authorized else {
            problem = "Turn on Speech Recognition for Vision in Settings"
            return
        }
        AVAudioApplication.requestRecordPermission { granted in
            Task { @MainActor in
                guard granted else {
                    self.problem = "Turn on the Microphone for Vision in Settings"
                    return
                }
                if self.wanted { self.startAudio() }
            }
        }
    }

    func stop() {
        wanted = false
        if dictating { endDictation() }
        timer?.invalidate()
        timer = nil
        task?.cancel()
        task = nil
        box.set(nil)
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        listening = false
        heard = ""
    }

    private func startAudio() {
        guard !engine.isRunning else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .mixWithOthers])
            try session.setActive(true)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else {
                problem = "No microphone"
                return
            }
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(box))
            engine.prepare()
            try engine.start()
        } catch {
            problem = "The microphone couldn't start"
            return
        }
        listening = true
        problem = nil
        startTask()
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkPause() }
        }
    }

    nonisolated private static func tap(_ box: RequestBox) -> AVAudioNodeTapBlock {
        { buffer, _ in box.append(buffer) }
    }

    // MARK: Recognition

    private func startTask() {
        task?.cancel()
        generation += 1
        heard = ""
        guard let recognizer, recognizer.isAvailable else {
            problem = "Speech recognition isn't available right now"
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        request.addsPunctuation = dictating
        request.taskHint = dictating ? .dictation : .search
        box.set(request)
        task = recognizer.recognitionTask(with: request, resultHandler: Self.handler(self, generation))
    }

    nonisolated private static func handler(_ voice: VoiceControl, _ gen: Int) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { [weak voice] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in voice?.received(text, isFinal: isFinal, failed: failed, generation: gen) }
        }
    }

    private func received(_ text: String?, isFinal: Bool, failed: Bool, generation gen: Int) {
        guard gen == generation, listening else { return }
        if let text, text != heard {
            heard = text
            lastChange = Date()
        }
        if isFinal || (failed && !heard.isEmpty) {
            finishUtterance()
        } else if failed {
            // Recognition stops after long silences or interruptions: start afresh.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 500_000_000)
                if self.listening, gen == self.generation { self.startTask() }
            }
        }
    }

    private func checkPause() {
        guard listening, !heard.isEmpty else { return }
        let pause: TimeInterval = dictating ? 1.6 : 0.8
        if Date().timeIntervalSince(lastChange) > pause { finishUtterance() }
    }

    private func finishUtterance() {
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        startTask()
        guard !text.isEmpty else { return }
        guard dictating else {
            onCommand?(text)
            return
        }
        let words = Self.normalize(text)
        if Self.stopPhrases.contains(words) {
            endDictation()
            return
        }
        for phrase in Self.stopPhrases where words.hasSuffix(" " + phrase) {
            // "…and that's the end. Done." keeps the text and stops.
            let keep = text.split(separator: " ").dropLast(phrase.split(separator: " ").count).joined(separator: " ")
            dictationText?(Self.spokenFormatting(keep))
            endDictation()
            return
        }
        dictationText?(Self.spokenFormatting(text))
    }

    // MARK: Dictation

    /// Sends each spoken phrase to `onText` until you say "done" (or
    /// `endDictation()` is called), then calls `onEnd`.
    func beginDictation(onText: @escaping (String) -> Void, onEnd: @escaping () -> Void) {
        if dictating {
            let previous = dictationEnded
            dictationEnded = nil
            previous?()
        }
        dictationText = onText
        dictationEnded = onEnd
        dictating = true
        if listening { startTask() } else { start() }
    }

    func endDictation() {
        guard dictating else { return }
        dictating = false
        let end = dictationEnded
        dictationText = nil
        dictationEnded = nil
        end?()
        if listening { startTask() }
    }

    // MARK: Text helpers

    /// Lowercase words only: "Open Photos!" -> "open photos".
    nonisolated static func normalize(_ s: String) -> String {
        let kept = s.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == " " || $0 == "-" }
        return String(String.UnicodeScalarView(kept)).replacingOccurrences(of: "-", with: " ")
            .split(separator: " ").joined(separator: " ")
    }

    /// "new line" and "new paragraph" become line breaks.
    nonisolated static func spokenFormatting(_ s: String) -> String {
        var t = s
        for (pattern, replacement) in [("(?i)[ ,.]*new paragraph[ ,.]*", "\n\n"), ("(?i)[ ,.]*new line[ ,.]*", "\n")] {
            t = t.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        return t
    }
}
