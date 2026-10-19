import Foundation

/**
 * Reading the tracker the CLI serves, shared by the menu bar app and the widget.
 *
 * Both only ever ask; neither reads `~/.claude` itself. The tracker is the one
 * program that knows how to, and asking it keeps the numbers here identical to the
 * ones on the page.
 */

/// The URL scheme the app answers, so the widget can ask it to start, stop or open the tracker.
enum TrackerURL {
    static let scheme = "claude-code-session-tracker"
    static let start = URL(string: "\(scheme)://start")!
    static let stop = URL(string: "\(scheme)://stop")!
    static let toggle = URL(string: "\(scheme)://toggle")!
    static let open = URL(string: "\(scheme)://open")!
}

// The parts of the API this side reads. Everything else is left undecoded, and
// what is read is optional wherever the app can do without it: a field the tracker
// renames or drops then costs one number, not the whole answer.

struct TokenTotals: Decodable, Hashable {
    let input: Int?
    let output: Int?
    let cacheCreate: Int?

    /// What a window is billed for — cache reads are not, as on the page.
    var billed: Int { (input ?? 0) + (output ?? 0) + (cacheCreate ?? 0) }
}

struct UsageWindow: Decodable, Hashable {
    let resetsAt: Double?
    let tokens: TokenTotals?
}

struct ReportedReading: Decodable, Hashable {
    let percent: Double?
    let resetsAt: Double?
    /// The one model this bar bills, when the plan has no all-models week.
    let scope: String?
}

struct UsageLimit: Decodable, Hashable {
    let current: UsageWindow?
    let reported: ReportedReading?
    let reference: UsageWindow?

    /// How full the window is, 0–1, worked out the way the page does: the reported
    /// percentage when there is one, else this window against the heaviest on record.
    var share: Double? {
        if let percent = reported?.percent { return percent / 100 }
        guard let ceiling = reference?.tokens?.billed, ceiling > 0 else { return nil }
        return Double(current?.tokens?.billed ?? 0) / Double(ceiling)
    }

    /// True when `share` is Anthropic's own figure rather than a comparison with history.
    var isReported: Bool { reported?.percent != nil }

    var resetsAt: Date? {
        guard let ms = reported?.resetsAt ?? current?.resetsAt else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }
}

struct UsageLimits: Decodable, Hashable {
    let session: UsageLimit
    let weekly: UsageLimit
}

struct SessionSummary: Decodable, Hashable, Identifiable {
    struct Project: Decodable, Hashable { let name: String? }
    struct Live: Decodable, Hashable { let pid: Int? }

    let id: String
    let status: String?
    let title: String?
    let name: String?
    let project: Project?
    let live: Live?

    var projectName: String { project?.name ?? "" }
    var label: String { title ?? name ?? project?.name ?? id }
}

struct SessionList: Decodable {
    let sessions: [SessionSummary]
}

/// Whether a newer tracker is out, as the tracker asked the npm registry. Trackers before 0.12 have no such endpoint.
struct UpdateInfo: Decodable, Hashable {
    struct Install: Decodable, Hashable {
        /// `idle`, `installing`, `restarting` or `failed`.
        let state: String
        let step: String?
        let error: String?
    }

    let current: String
    let latest: String?
    let available: Bool
    /// The one command that updates this copy, for how it was installed.
    let command: String
    let notesUrl: String?
    /// The tracker can update itself; when false, `installBlocked` says why and `command` is the way.
    let canInstall: Bool?
    let installBlocked: String?
    let install: Install?

    var notes: URL? { notesUrl.flatMap(URL.init(string:)) }
    var isBusy: Bool { install?.state == "installing" || install?.state == "restarting" }
}

/// Auto continue's switch and the sessions waiting on it. Trackers before 0.13 have no such endpoint.
struct AutoContinueStatus: Decodable, Hashable {
    struct Pending: Decodable, Hashable {
        let sessionId: String
        /// `five_hour` or `weekly`: which limit stopped the session.
        let clock: String
        let resetsAt: Double
        let continueAt: Double

        var continues: Date { Date(timeIntervalSince1970: continueAt / 1000) }
        var resets: Date { Date(timeIntervalSince1970: resetsAt / 1000) }
    }

    let enabled: Bool
    /// `ready`, `missing`, `outdated` or `disabled`: whether the plugin's hook is there to do the waiting.
    let plugin: String
    let pending: [Pending]

    var isReady: Bool { plugin == "ready" }

    func pending(for clock: String) -> [Pending] { pending.filter { $0.clock == clock } }

    func pending(session id: String) -> Pending? { pending.first { $0.sessionId == id } }
}

struct Health: Decodable {
    let ok: Bool
    let version: String
    let claudeDir: String
}

/// Why a part of a snapshot is missing.
enum Gap: Hashable {
    /// The tracker has no such answer: an older one without the endpoint, or nothing to measure.
    case unavailable
    /// It answered in a shape this app does not know — the two are out of step.
    case unreadable
}

/// Everything the menu and the widget show, read in one go.
struct TrackerSnapshot: Hashable {
    let port: Int
    let version: String
    let limits: UsageLimits?
    /// Why `limits` is nil.
    let limitsGap: Gap?
    /// Sessions with a live process behind them.
    let running: [SessionSummary]
    /// The session list came back in a shape this app does not know, so `running` is empty rather than true.
    let sessionsUnreadable: Bool
    /// Set only when a newer version is out.
    let update: UpdateInfo?
    /// Nil on a tracker too old to have auto continue.
    let autoContinue: AutoContinueStatus?
    let fetchedAt: Date

    /// What to say in place of the limits, so a tracker this app cannot read is not mistaken for a quiet one.
    var limitsMessage: String {
        limitsGap == .unreadable
            ? "The limits could not be read: this app and tracker v\(version) are out of step."
            : "Tracker v\(version) reports no limits."
    }

    var busy: Int { running.filter { $0.status == "busy" }.count }
    var waiting: Int { running.filter { $0.status == "waiting" }.count }
    var idle: Int { running.count - busy - waiting }

    var dashboard: URL { URL(string: "http://127.0.0.1:\(port)")! }
}

enum TrackerClient {
    static let defaultPort = 3099
    /// The CLI steps forward up to 20 times when its port is taken, so the tracker is somewhere in here.
    static let ports = defaultPort...(defaultPort + 20)

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 5
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    /// The port a tracker answers on, trying `preferred` first. Nil when none is running.
    static func findPort(preferred: Int? = nil) async -> (port: Int, health: Health)? {
        var candidates = Array(ports)
        if let preferred {
            candidates.removeAll { $0 == preferred }
            candidates.insert(preferred, at: 0)
        }
        for port in candidates {
            if let health = await health(port: port) { return (port, health) }
        }
        return nil
    }

    /// The tracker's health, or nil when what answers on `port` is not the tracker.
    static func health(port: Int) async -> Health? {
        guard case let .value(health) = await get("/api/health", port: port) as Fetched<Health>, health.ok else { return nil }
        return health
    }

    static func snapshot(preferredPort: Int? = nil) async -> TrackerSnapshot? {
        guard let (port, health) = await findPort(preferred: preferredPort) else { return nil }
        let limits: Fetched<UsageLimits> = await get("/api/limits", port: port)
        // Running sessions come back whatever the limit, so ask for as few others as possible.
        let list: Fetched<SessionList> = await get("/api/sessions?limit=1", port: port)
        let update: Fetched<UpdateInfo> = await get("/api/update", port: port)
        let autoContinue: Fetched<AutoContinueStatus> = await get("/api/auto-continue", port: port)
        return TrackerSnapshot(
            port: port,
            version: health.version,
            limits: limits.value,
            limitsGap: limits.gap,
            running: list.value?.sessions.filter { $0.live != nil } ?? [],
            sessionsUnreadable: list.gap == .unreadable,
            update: update.value.flatMap { $0.available || $0.isBusy ? $0 : nil },
            autoContinue: autoContinue.value,
            fetchedAt: Date()
        )
    }

    /// Ask the tracker to update itself and restart as the new version. It answers at once; the snapshot follows it.
    static func installUpdate(port: Int) async -> String? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/update/install") else { return "Bad port" }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // The tracker only takes this from its own origin, as it does from its own page.
        request.setValue("http://127.0.0.1:\(port)", forHTTPHeaderField: "Origin")
        guard let (data, response) = try? await session.data(for: request) else { return "The tracker did not answer." }
        if (response as? HTTPURLResponse)?.statusCode == 202 { return nil }
        struct Failure: Decodable { let error: String }
        return (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "The tracker refused the update."
    }

    /// Turn auto continue on or off. Nil when the tracker took it, else why not.
    static func setAutoContinue(_ enabled: Bool, port: Int) async -> String? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/auto-continue") else { return "Bad port" }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("http://127.0.0.1:\(port)", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{\"enabled\":\(enabled)}".utf8)
        guard let (data, response) = try? await session.data(for: request) else { return "The tracker did not answer." }
        if (response as? HTTPURLResponse)?.statusCode == 200 { return nil }
        struct Failure: Decodable { let error: String }
        return (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "The tracker refused to change auto continue."
    }

    private enum Fetched<T> {
        case value(T)
        case missing(Gap)

        var value: T? {
            if case let .value(value) = self { value } else { nil }
        }

        var gap: Gap? {
            if case let .missing(gap) = self { gap } else { nil }
        }
    }

    private static func get<T: Decodable>(_ path: String, port: Int) async -> Fetched<T> {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)"),
              let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return .missing(.unavailable) }
        guard let value = try? JSONDecoder().decode(T.self, from: data) else { return .missing(.unreadable) }
        return .value(value)
    }
}

enum Formatting {
    static func percent(_ share: Double?) -> String {
        guard let share else { return "–" }
        return "\(Int((share * 100).rounded()))%"
    }

    /// "18:00" today, "Sat 12:00" further out.
    static func reset(_ date: Date?) -> String {
        guard let date else { return "" }
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.setLocalizedDateFormatFromTemplate(Calendar.current.isDateInToday(date) ? "Hm" : "EEEHm")
        return formatter.string(from: date)
    }
}
