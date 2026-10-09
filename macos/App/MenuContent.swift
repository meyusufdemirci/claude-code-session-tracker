import SwiftUI

/// The panel the menu bar item opens: the switch, the two limits, and what is running.
struct MenuContent: View {
    @EnvironmentObject private var controller: TrackerController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Divider()

            if let snapshot = controller.snapshot {
                if let limits = snapshot.limits {
                    LimitRow(title: "Session limit", limit: limits.session)
                    LimitRow(title: "Weekly limit", limit: limits.weekly)
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
                        Text(session.projectName).foregroundStyle(.secondary).lineLimit(1)
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
