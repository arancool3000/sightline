import Foundation
import QuartzCore

/// Finds freezes on a phone nobody can attach a debugger to.
///
/// The main thread leaves breadcrumbs ("redraw Safari", "start voice"…). A
/// background watchdog pings the main thread; if it doesn't answer for a few
/// seconds, the current breadcrumb is saved, and the next launch reports
/// where the app got stuck.
final class Diagnostics: @unchecked Sendable {
    static let shared = Diagnostics()

    private let lock = NSLock()
    private var step = "launch"
    private var phase = "startup"
    private var lastPong = CACurrentMediaTime()
    private var stalledStep: String?
    private var stallStart: TimeInterval = 0
    private var started = false
    private static let freezeKey = "vision.lastFreeze"

    /// Launched with -smoketest: print a heartbeat for the CI freeze test.
    let smokeTest = ProcessInfo.processInfo.arguments.contains("-smoketest")

    /// Where the main thread is now.
    func mark(_ s: String) {
        lock.lock()
        step = s
        lock.unlock()
    }

    /// The bigger picture ("startup", "opening Photos"…), kept alongside the
    /// step so a freeze between frames still says what was going on.
    func setPhase(_ s: String) {
        lock.lock()
        phase = s
        lock.unlock()
    }

    /// What the previous launch got stuck on, if it froze (cleared on read).
    func takeLastFreeze() -> String? {
        let d = UserDefaults.standard
        let s = d.string(forKey: Self.freezeKey)
        d.removeObject(forKey: Self.freezeKey)
        return s
    }

    func start() {
        lock.lock()
        if started {
            lock.unlock()
            return
        }
        started = true
        lastPong = CACurrentMediaTime()
        lock.unlock()
        let thread = Thread { [self] in watch() }
        thread.name = "vision.watchdog"
        thread.qualityOfService = .utility
        thread.start()
    }

    private func watch() {
        while true {
            DispatchQueue.main.async { [self] in
                lock.lock()
                lastPong = CACurrentMediaTime()
                lock.unlock()
            }
            Thread.sleep(forTimeInterval: 0.5)
            lock.lock()
            let silent = CACurrentMediaTime() - lastPong
            let current = "\(phase) / \(step)"
            lock.unlock()
            if silent > 2.5 {
                if stalledStep == nil {
                    stalledStep = current
                    stallStart = CACurrentMediaTime() - silent
                }
                let seconds = Int(CACurrentMediaTime() - stallStart)
                UserDefaults.standard.set("\(stalledStep ?? current) (stuck \(seconds)s)", forKey: Self.freezeKey)
                print("[Vision] FREEZE main thread silent \(String(format: "%.1f", silent))s at: \(stalledStep ?? current)")
            } else if let s = stalledStep {
                // It recovered: a long hitch, not a hang. Keep it only if it was bad.
                let seconds = CACurrentMediaTime() - stallStart
                if seconds < 6 { UserDefaults.standard.removeObject(forKey: Self.freezeKey) }
                print("[Vision] recovered after \(String(format: "%.1f", seconds))s at: \(s)")
                stalledStep = nil
            }
        }
    }
}
