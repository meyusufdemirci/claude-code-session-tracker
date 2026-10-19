import SwiftUI

/// The panel the menu bar item opens: the switch, the two limits, and what is running.
struct MenuContent: View {
    @EnvironmentObject private var controller: TrackerController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Divider()

            if let update = controller.snapshot?.update {
                UpdateNotice(update: update)
                Divider()
            }

            if let snapshot = controller.snapshot {
                if let limits = snapshot.limits {
                    LimitRow(title: "Session limit", limit: limits.session)
                    AutoContinueNote(status: snapshot.autoContinue, limit: limits.session, clock: "five_hour")
                    LimitRow(title: "Weekly limit", limit: limits.weekly)
                    AutoContinueNote(status: snapshot.autoContinue, limit: limits.weekly, clock: "weekly")
                } else {
                    Text(snapshot.limitsMessage)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Divider()
                sessions(snapshot)
            } else if controller.notInstalled || controller.installing {
                installPrompt
            } else {
                Text(stoppedText)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let error = controller.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            footer
        }
        .padding(14)
        .frame(width: 300)
        .task { await controller.refresh() }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Session Tracker").font(.headline)
                Text(statusText).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if controller.state == .starting || controller.state == .stopping {
                ProgressView().controlSize(.small)
            }
            Toggle("", isOn: Binding(get: { controller.isOn }, set: controller.setOn))
                .toggleStyle(.switch)
                .labelsHidden()
                .disabled(controller.state == .starting || controller.state == .stopping || controller.installing)
        }
    }

    private var statusText: String {
        switch controller.state {
        case let .running(snapshot): "Running on 127.0.0.1:\(snapshot.port) · v\(snapshot.version)"
        case .starting: "Starting…"
        case .stopping: "Stopping…"
        case .stopped: "Off"
        }
    }

    private var stoppedText: String {
        controller.state == .starting
            ? "Reading ~/.claude…"
            : "The tracker is off. Turn it on to see your limits and sessions."
    }

    @ViewBuilder
    private func sessions(_ snapshot: TrackerSnapshot) -> some View {
        if snapshot.sessionsUnreadable {
            Text("The sessions could not be read: this app and tracker v\(snapshot.version) are out of step.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } else if snapshot.running.isEmpty {
            Text("No Claude Code sessions running.").foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    StatusCount(count: snapshot.busy, label: "working", color: .green)
                    StatusCount(count: snapshot.waiting, label: "waiting", color: .orange)
                    StatusCount(count: snapshot.idle, label: "idle", color: .secondary)
                }
                .font(.caption)
                ForEach(snapshot.running.prefix(5)) { session in
                    HStack(spacing: 6) {
                        Circle().fill(color(for: session.status)).frame(width: 6, height: 6)
                        Text(session.label).lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 4)
                        if let auto = snapshot.autoContinue, auto.enabled, auto.isReady, let waiting = auto.pending(session: session.id) {
                            Label(Formatting.reset(waiting.continues), systemImage: "arrow.clockwise")
                                .labelStyle(.titleAndIcon)
                                .font(.caption)
                                .foregroundStyle(.orange)
                                .help("Continues automatically after the limit resets")
                        } else {
                            Text(session.projectName).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .font(.callout)
                }
            }
        }
    }

    private var installPrompt: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("The tracker is not installed.")
            Text("brew install meyusufdemirci/tap/claude-code-session-tracker")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button(controller.installing ? "Installing…" : "Install and start") {
                    Task { await controller.install() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(controller.installing)
                if controller.installing { ProgressView().controlSize(.small) }
            }
            Text("Uses npm instead when Homebrew is not installed. This can take a minute.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button("Open dashboard") { Task { await controller.openDashboard() } }
                    .keyboardShortcut("o")
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .keyboardShortcut("q")
            }
            Toggle("Open at login", isOn: Binding(get: { controller.launchesAtLogin }, set: controller.setLaunchesAtLogin))
                .toggleStyle(.checkbox)
                .font(.caption)
            if let auto = controller.snapshot?.autoContinue {
                Toggle("Auto continue paused sessions", isOn: Binding(get: { auto.enabled }, set: controller.setAutoContinue))
                    .toggleStyle(.checkbox)
                    .font(.caption)
                    .help("When a limit stops your sessions, continue them once it resets. Needs the session-tracker Claude Code plugin.")
            }
        }
    }

    private func color(for status: String?) -> Color {
        switch status {
        case "busy": .green
        case "waiting": .orange
        default: .secondary
        }
    }
}

/// A newer tracker is out: Update does it all, and the command is there when it cannot.
private struct UpdateNotice: View {
    @EnvironmentObject private var controller: TrackerController
    let update: UpdateInfo
    @State private var copied = false

    private var busy: Bool { controller.updating || update.isBusy }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: update.install?.state == "failed" ? "exclamationmark.triangle.fill" : "arrow.down.circle.fill")
                    .foregroundStyle(.orange)
                Text(title).bold()
                Spacer()
                if busy { ProgressView().controlSize(.small) }
            }
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if update.canInstall == true {
                HStack(spacing: 8) {
                    Button(busy ? "Updating…" : update.install?.state == "failed" ? "Try again" : "Update") {
                        Task { await controller.updateTracker() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
                    notesButton
                }
                .controlSize(.small)
            }

            if update.canInstall != true || update.install?.state == "failed" {
                Text(update.command)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button(copied ? "Copied" : "Copy command") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(update.command, forType: .string)
                        copied = true
                        Task {
                            try? await Task.sleep(for: .seconds(2))
                            copied = false
                        }
                    }
                    if update.canInstall != true { notesButton }
                }
                .controlSize(.small)
            }
        }
    }

    @ViewBuilder
    private var notesButton: some View {
        if let notes = update.notes {
            Button("What's new") { NSWorkspace.shared.open(notes) }
        }
    }

    private var title: String {
        switch update.install?.state {
        case "installing": "Updating to \(update.latest ?? "")…"
        case "restarting": "Restarting as \(update.latest ?? "")…"
        case "failed": "Could not update to \(update.latest ?? "")"
        default: controller.updating ? "Updating to \(update.latest ?? "")…" : "Version \(update.latest ?? "") is out"
        }
    }

    private var detail: String {
        switch update.install?.state {
        case "installing": update.install?.step ?? ""
        case "restarting": "This app updates too, and opens again by itself."
        case "failed": "\(update.install?.error ?? "") You can run it yourself:"
        default:
            update.canInstall == true
                ? "You have \(update.current). Update installs it, restarts the tracker and updates this app."
                : "You have \(update.current). \(update.installBlocked ?? "") Update with:"
        }
    }
}

/**
 * Under a limit: when it is full or has stopped sessions, what auto continue will do
 * about it — or an offer to turn it on, or why it cannot.
 */
private struct AutoContinueNote: View {
    @EnvironmentObject private var controller: TrackerController
    let status: AutoContinueStatus?
    let limit: UsageLimit
    let clock: String

    var body: some View {
        if let status, shown(status) {
            let pending = status.pending(for: clock)
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: status.enabled && status.isReady ? "arrow.clockwise" : "info.circle")
                    .foregroundStyle(status.enabled && status.isReady ? Color.green : Color.blue)
                VStack(alignment: .leading, spacing: 6) {
                    Text(text(status, pending))
                        .fixedSize(horizontal: false, vertical: true)
                    if status.isReady && !status.enabled {
                        Button("Turn on") { controller.setAutoContinue(true) }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                }
            }
            .font(.caption)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                (status.enabled && status.isReady ? Color.green : Color.blue).opacity(0.12),
                in: RoundedRectangle(cornerRadius: 6)
            )
        }
    }

    private func shown(_ status: AutoContinueStatus) -> Bool {
        (limit.share ?? 0) >= 1 || !status.pending(for: clock).isEmpty
    }

    private func text(_ status: AutoContinueStatus, _ pending: [AutoContinueStatus.Pending]) -> String {
        let count = pending.count == 1 ? "1 session" : "\(pending.count) sessions"
        guard status.isReady else {
            return status.plugin == "missing"
                ? "Auto continue needs the session-tracker Claude Code plugin to pick sessions up after the reset."
                : "Auto continue needs the session-tracker plugin updated and turned on in Claude Code."
        }
        if status.enabled {
            guard let first = pending.map(\.continues).min() else { return "Auto continue is on for this limit." }
            return "\(count) continue at \(Formatting.reset(first))"
        }
        guard let reset = pending.map(\.resets).min() else { return "Turn on auto continue to pick sessions up when this limit resets." }
        return "\(count) stopped at the limit. Turn on auto continue to resume them at \(Formatting.reset(reset))."
    }
}

private struct StatusCount: View {
    let count: Int
    let label: String
    let color: Color

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text("\(count) \(label)")
        }
    }
}

struct LimitRow: View {
    let title: String
    let limit: UsageLimit

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                Spacer()
                Text(Formatting.percent(limit.share)).monospacedDigit().bold()
            }
            ProgressView(value: min(limit.share ?? 0, 1))
                .tint(LimitColor.of(limit.share))
            HStack {
                Text(limit.reported?.scope.map { "\($0) only" } ?? (limit.isReported ? "Anthropic's reading" : "vs. your heaviest window"))
                Spacer()
                if let reset = limit.resetsAt { Text("resets \(Formatting.reset(reset))") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}
