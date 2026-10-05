import AppKit
import Foundation
import ServiceManagement
import WidgetKit

/**
 * Turning the tracker on and off, and keeping an eye on it while it runs.
 *
 * The tracker itself is the CLI, unchanged: on starts it with `--no-open` — or
 * asks launchd for the copy `autostart on` set up, when there is one — and off
 * sends it SIGTERM, which it treats as Ctrl+C. Off stops whichever copy is
 * answering — one this app started, one `autostart on` started, or one left
 * running in a terminal — because the switch says whether the tracker is running,
 * not whether this app happens to own it. A clean exit is also what tells the
 * LaunchAgent not to bring it back.
 */
@MainActor
final class TrackerController: ObservableObject {
    enum State: Equatable {
        case stopped
        case starting
        case running(TrackerSnapshot)
        case stopping
    }

    @Published private(set) var state: State = .stopped
    @Published private(set) var error: String?
    /// Starting found no `claude-code-session-tracker` to run.
    @Published private(set) var notInstalled = false
    @Published private(set) var installing = false
    @Published private(set) var launchesAtLogin = SMAppService.mainApp.status == .enabled

    /// Whether the user last left the tracker on, so the app brings it back next time it starts.
    @Published var wantsRunning: Bool {
        didSet { UserDefaults.standard.set(wantsRunning, forKey: Self.wantsRunningKey) }
    }

    private static let wantsRunningKey = "trackerEnabled"
    private static let pollInterval: TimeInterval = 30

    private var owned: Process?
    private var poller: Timer?
    private var lastPort: Int?

    init() {
        wantsRunning = UserDefaults.standard.object(forKey: Self.wantsRunningKey) as? Bool ?? true
    }

    var isOn: Bool {
        switch state {
        case .running, .starting: true
        case .stopped, .stopping: false
        }
    }

    var snapshot: TrackerSnapshot? {
        if case let .running(snapshot) = state { snapshot } else { nil }
    }

    func launch() {
        poller = Timer.scheduledTimer(withTimeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        Task {
            await refresh()
            if wantsRunning {
                if snapshot == nil { await start() }
            } else {
                await keepOff()
            }
        }
    }

    func handle(_ url: URL) {
        guard url.scheme == TrackerURL.scheme else { return }
        Task {
            switch url.host {
            case "start": await start()
            case "stop": await stop()
            case "toggle": await (isOn ? stop() : start())
            case "open": await openDashboard()
            default: break
            }
        }
    }

    func setOn(_ on: Bool) {
        Task { await (on ? start() : stop()) }
    }

    func refresh() async {
        if case .starting = state { return }
        if case .stopping = state { return }
        apply(await TrackerClient.snapshot(preferredPort: lastPort))
    }

    func start() async {
        wantsRunning = true
        error = nil
        if let snapshot = await TrackerClient.snapshot(preferredPort: lastPort) {
            apply(snapshot)
            return
        }

        state = .starting
        // `autostart on` already names the copy to run, so On brings that one back
        // rather than whichever copy is first on PATH, which may be another version.
        if agentLoaded() {
            let started = kickstartAgent() ? await answered(while: { true }) : false
            if !started {
                error = "The tracker did not start. See \(Self.logPath.path)."
                apply(nil)
            }
            return
        }

        let process: Process
        if let owned, owned.isRunning {
            // Still coming up from an earlier try: wait on it rather than start a second copy.
            process = owned
        } else {
            do {
                process = try spawnTracker()
                owned = process
            } catch {
                self.error = error.localizedDescription
                state = .stopped
                return
            }
        }

        if await answered(while: { process.isRunning }) { return }
        // Read off `process`, not `owned`: its exit handler may already have let go of it.
        if process.isRunning {
            // Slow, not gone. It stays owned, so Off and Quit still stop it, and the next refresh picks it up.
            error = "The tracker is taking a while to start. See \(Self.logPath.path)."
        } else {
            if owned === process { owned = nil }
            if process.terminationStatus == Self.notFoundStatus {
                notInstalled = true
            } else {
                error = "The tracker did not start. See \(Self.logPath.path)."
            }
        }
        apply(nil)
    }

    /// Wait for the tracker to answer, for as long as `alive` holds. Reading a large `~/.claude` the first time can take a few seconds.
    private func answered(while alive: () -> Bool) async -> Bool {
        for _ in 0..<40 {
            try? await Task.sleep(for: .milliseconds(250))
            if let snapshot = await TrackerClient.snapshot(preferredPort: lastPort) {
                apply(snapshot)
                return true
            }
            if !alive() { break }
        }
        return false
    }

    /**
     * Left off, stay off.
     *
     * `autostart on` starts the tracker at every login whatever the switch said,
     * about when this app opens, so its copy is watched for briefly and stopped. A
     * copy started any other way was started on purpose and is left alone.
     */
    private func keepOff() async {
        guard agentLoaded() else { return }
        for _ in 0..<10 {
            if wantsRunning { return }
            if let pid = agentPID(),
               let found = await TrackerClient.findPort(preferred: lastPort),
               listeners(on: found.port).contains(pid) {
                await stop()
                return
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /**
     * Install the tracker, then start it.
     *
     * Homebrew when there is one, since that also brings the `node` it runs on;
     * otherwise npm, which means Node is already there. Either way it is the user's
     * own login shell doing it, as if they had typed it, and its output goes to the log.
     */
    func install() async {
        installing = true
        error = nil
        defer { installing = false }

        let script = """
        command -v brew >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
        if command -v brew >/dev/null 2>&1; then
          exec brew install meyusufdemirci/tap/claude-code-session-tracker
        elif command -v npm >/dev/null 2>&1; then
          exec npm install -g claude-code-session-tracker
        else
          echo "Neither Homebrew nor npm is installed." >&2
          exit \(Self.notFoundStatus)
        fi
        """
        let status: Int32
        do {
            status = try await withCheckedThrowingContinuation { continuation in
                do {
                    _ = try loginShell(script) { continuation.resume(returning: $0.terminationStatus) }
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        } catch {
            self.error = error.localizedDescription
            return
        }

        switch status {
        case 0:
            notInstalled = false
            await start()
        case Self.notFoundStatus:
            error = "Neither Homebrew nor npm is installed. Install Homebrew from brew.sh, then try again."
        default:
            error = "The install failed. See \(Self.logPath.path)."
        }
    }

    func stop() async {
        wantsRunning = false
        error = nil
        state = .stopping

        owned?.terminate()
        owned = nil
        // Whatever else is answering: started at login, or from a terminal.
        for port in TrackerClient.ports where await TrackerClient.health(port: port) != nil {
            for pid in listeners(on: port) { kill(pid, SIGTERM) }
        }

        for _ in 0..<20 {
            if await TrackerClient.findPort(preferred: lastPort) == nil { break }
            try? await Task.sleep(for: .milliseconds(250))
        }
        state = .stopped
        apply(await TrackerClient.snapshot(preferredPort: lastPort))
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Stop only the copy this app started — one started elsewhere outlives the menu bar.
    func stopOwned() {
        owned?.terminate()
    }

    func openDashboard() async {
        if snapshot == nil { await start() }
        if let url = snapshot?.dashboard { NSWorkspace.shared.open(url) }
    }

    func setLaunchesAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            self.error = error.localizedDescription
        }
        launchesAtLogin = SMAppService.mainApp.status == .enabled
    }

    private func apply(_ snapshot: TrackerSnapshot?) {
        let next: State = snapshot.map { .running($0) } ?? .stopped
        if let snapshot {
            lastPort = snapshot.port
            notInstalled = false
        }
        let changed = next.isRunning != state.isRunning
        state = next
        if changed { WidgetCenter.shared.reloadAllTimelines() }
    }

    // Starting it

    static let logPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/claude-code-session-tracker.log")

    /**
     * The CLI, run from a login shell.
     *
     * An app opened from Finder gets launchd's bare PATH, which finds neither the
     * tracker nor the `node` its `#!/usr/bin/env node` asks for. The user's login
     * shell finds both wherever they put them — Homebrew, a global npm prefix, a
     * version manager — so it is asked rather than guessed at. It is asked as an
     * interactive shell too: nvm, fnm and the like set PATH from `.zshrc` or
     * `.bashrc`, which a login shell alone does not read.
     *
     * `defaults write com.meyusufdemirci.claude-code-session-tracker.app trackerCommand
     * 'node ~/src/claude-code-session-tracker/src/cli.ts'` runs another copy instead,
     * such as a source checkout.
     */
    private func spawnTracker() throws -> Process {
        let port = lastPort ?? TrackerClient.defaultPort
        let script: String
        if let command = UserDefaults.standard.string(forKey: "trackerCommand"), !command.isEmpty {
            script = "exec \(command) --no-open --port \(port)"
        } else {
            script = """
            command -v claude-code-session-tracker >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
            command -v claude-code-session-tracker >/dev/null 2>&1 || { echo "claude-code-session-tracker is not on PATH." >&2; exit \(Self.notFoundStatus); }
            exec claude-code-session-tracker --no-open --port \(port)
            """
        }

        return try loginShell(script) { [weak self] process in
            Task { @MainActor in
                guard let self else { return }
                if self.owned === process { self.owned = nil }
                await self.refresh()
            }
        }
    }

    /// What a script exits with when the program it needs is not there — the shell's own "command not found".
    private static let notFoundStatus: Int32 = 127

    /// Run a script in the user's interactive login shell, its output appended to the log.
    private func loginShell(_ script: String, onExit: @escaping @Sendable (Process) -> Void) throws -> Process {
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let log = Self.logPath
        try FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: log)
        // The child gets its own copy of the descriptor when it starts, so this one is done with either way.
        defer { try? handle.close() }
        handle.seekToEndOfFile()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-l", "-i", "-c", script]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = handle
        process.standardError = handle
        process.terminationHandler = onExit
        try process.run()
        return process
    }

    /// The processes listening on a loopback port.
    private func listeners(on port: Int) -> [pid_t] {
        run("/usr/sbin/lsof", "-nP", "-t", "-iTCP:\(port)", "-sTCP:LISTEN").output
            .split(whereSeparator: \.isNewline).compactMap { pid_t($0) }
    }

    // The LaunchAgent `autostart on` writes

    private static let agentLabel = "com.meyusufdemirci.claude-code-session-tracker"
    private var agentTarget: String { "gui/\(getuid())/\(Self.agentLabel)" }

    /// Whether `autostart on` has been run, so launchd has a tracker of its own to start.
    private func agentLoaded() -> Bool {
        run("/bin/launchctl", "print", agentTarget).status == 0
    }

    private func kickstartAgent() -> Bool {
        run("/bin/launchctl", "kickstart", agentTarget).status == 0
    }

    /// The agent's tracker, nil while it is not running.
    private func agentPID() -> pid_t? {
        let output = run("/bin/launchctl", "print", agentTarget).output
        guard let match = output.firstMatch(of: /\bpid = (\d+)/) else { return nil }
        return pid_t(match.1)
    }

    private func run(_ tool: String, _ arguments: String...) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return (-1, "")
        }
        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        return (process.terminationStatus, output)
    }
}

private extension TrackerController.State {
    var isRunning: Bool {
        if case .running = self { true } else { false }
    }
}
