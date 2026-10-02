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

// The parts of the API this side reads. Everything else is left undecoded.

struct TokenTotals: Decodable, Hashable {
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheCreate: Int

    /// What a window is billed for — cache reads are not, as on the page.
    var billed: Int { input + output + cacheCreate }
}

struct UsageWindow: Decodable, Hashable {
    let startedAt: Double
    let resetsAt: Double
    let tokens: TokenTotals
}

struct ReportedReading: Decodable, Hashable {
    let percent: Double
    let resetsAt: Double?
}

struct UsageLimit: Decodable, Hashable {
    let windowMs: Double
    let current: UsageWindow?
    let reported: ReportedReading?
    let reference: UsageWindow?

    /// How full the window is, 0–1, worked out the way the page does: the reported
    /// percentage when there is one, else this window against the heaviest on record.
    var share: Double? {
        if let percent = reported?.percent { return percent / 100 }
        guard let ceiling = reference?.tokens.billed, ceiling > 0 else { return nil }
        return Double(current?.tokens.billed ?? 0) / Double(ceiling)
    }

    /// True when `share` is Anthropic's own figure rather than a comparison with history.
    var isReported: Bool { reported != nil }

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
    struct Project: Decodable, Hashable { let name: String }
    struct Live: Decodable, Hashable { let pid: Int }

    let id: String
    let status: String
    let title: String?
    let name: String?
    let project: Project
    let live: Live?

    var label: String { title ?? name ?? project.name }
}

struct SessionList: Decodable {
    let sessions: [SessionSummary]
}

struct Health: Decodable {
    let ok: Bool
    let version: String
    let claudeDir: String
}

/// Everything the menu and the widget show, read in one go.
struct TrackerSnapshot: Hashable {
    let port: Int
    let version: String
    let limits: UsageLimits?
    /// Sessions with a live process behind them.
    let running: [SessionSummary]
    let fetchedAt: Date

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
        guard let health: Health = await get("/api/health", port: port), health.ok else { return nil }
        return health
    }

    static func snapshot(preferredPort: Int? = nil) async -> TrackerSnapshot? {
        guard let (port, health) = await findPort(preferred: preferredPort) else { return nil }
        let limits: UsageLimits? = await get("/api/limits", port: port)
        // Running sessions come back whatever the limit, so ask for as few others as possible.
        let list: SessionList? = await get("/api/sessions?limit=1", port: port)
        let running = list?.sessions.filter { $0.live != nil } ?? []
        return TrackerSnapshot(port: port, version: health.version, limits: limits, running: running, fetchedAt: Date())
    }

    private static func get<T: Decodable>(_ path: String, port: Int) async -> T? {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            return nil
        }
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
