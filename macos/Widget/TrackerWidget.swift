import SwiftUI
import WidgetKit

/**
 * The two limits and the running sessions, on the desktop or in Notification Center.
 *
 * The widget asks the tracker on loopback, like the menu does. It cannot start a
 * process from its sandbox, so turning the tracker on is a link the app handles.
 */
@main
struct TrackerWidgets: WidgetBundle {
    var body: some Widget {
        TrackerWidget()
    }
}

struct TrackerWidget: Widget {
    let kind = "TrackerWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            TrackerWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Claude Code limits")
        .description("How full your session and weekly limits are, and what is running.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct Entry: TimelineEntry {
    let date: Date
    /// Nil when no tracker answers.
    let snapshot: TrackerSnapshot?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        Entry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        Task { completion(Entry(date: Date(), snapshot: await TrackerClient.snapshot())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        Task {
            let entry = Entry(date: Date(), snapshot: await TrackerClient.snapshot())
            // The tracker asks Anthropic every five minutes, so sooner would show nothing new.
            // The app reloads the widget the moment the tracker starts or stops.
            let next = Calendar.current.date(byAdding: .minute, value: 5, to: entry.date)!
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

struct TrackerWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: Entry

    var body: some View {
        if let snapshot = entry.snapshot {
            running(snapshot).widgetURL(TrackerURL.open)
        } else {
            stopped.widgetURL(TrackerURL.start)
        }
    }

    @ViewBuilder
    private func running(_ snapshot: TrackerSnapshot) -> some View {
        switch family {
        case .systemSmall:
            VStack(alignment: .leading, spacing: 8) {
                title
                Spacer(minLength: 0)
                Gauges(snapshot: snapshot, compact: true)
                Spacer(minLength: 0)
                Sessions(snapshot: snapshot)
            }
        default:
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    title
                    Spacer(minLength: 0)
                    Gauges(snapshot: snapshot, compact: false)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Sessions(snapshot: snapshot)
                    ForEach(snapshot.running.prefix(3)) { session in
                        HStack(spacing: 4) {
                            Circle().fill(color(for: session.status)).frame(width: 5, height: 5)
                            Text(session.label).lineLimit(1)
                        }
                        .font(.caption2)
                    }
                    Spacer(minLength: 0)
                    Link(destination: TrackerURL.stop) {
                        Label("Stop", systemImage: "stop.circle").font(.caption2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var stopped: some View {
        VStack(alignment: .leading, spacing: 6) {
            title
            Spacer(minLength: 0)
            Image(systemName: "power.circle").font(.title).foregroundStyle(.secondary)
            Text("Tracker is off").font(.headline)
            Text("Click to start it.").font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var title: some View {
        Label("Claude Code", systemImage: "gauge.with.dots.needle.67percent")
            .font(.caption.bold())
            .foregroundStyle(.secondary)
    }

    private func color(for status: String?) -> Color {
        switch status {
        case "busy": .green
        case "waiting": .orange
        default: .secondary
        }
    }
}

private struct Gauges: View {
    let snapshot: TrackerSnapshot
    let compact: Bool

    var body: some View {
        if let limits = snapshot.limits {
            HStack(spacing: compact ? 10 : 14) {
                Ring(title: "5h", limit: limits.session, compact: compact)
                Ring(title: "Week", limit: limits.weekly, compact: compact)
            }
        } else {
            Text(snapshot.limitsGap == .unreadable ? "Limits unreadable" : "No limits").font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct Ring: View {
    let title: String
    let limit: UsageLimit
    let compact: Bool

    var body: some View {
        VStack(spacing: 3) {
            Gauge(value: min(limit.share ?? 0, 1)) {
                Text(title)
            } currentValueLabel: {
                Text(Formatting.percent(limit.share)).monospacedDigit()
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .tint(LimitColor.of(limit.share))
            .scaleEffect(compact ? 0.9 : 1)
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            if !compact, limit.resetsAt != nil {
                Text(Formatting.reset(limit.resetsAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
    }
}

private struct Sessions: View {
    let snapshot: TrackerSnapshot

    var body: some View {
        if snapshot.sessionsUnreadable {
            Text("Sessions unreadable").font(.caption2).foregroundStyle(.secondary)
        } else if snapshot.running.isEmpty {
            Text("No sessions running").font(.caption2).foregroundStyle(.secondary)
        } else {
            HStack(spacing: 6) {
                if snapshot.busy > 0 { count(snapshot.busy, "working", .green) }
                if snapshot.waiting > 0 { count(snapshot.waiting, "waiting", .orange) }
                if snapshot.busy + snapshot.waiting == 0 { count(snapshot.idle, "idle", .secondary) }
            }
            .font(.caption2)
        }
    }

    private func count(_ value: Int, _ label: String, _ color: Color) -> some View {
        HStack(spacing: 3) {
            Circle().fill(color).frame(width: 5, height: 5)
            Text("\(value) \(label)")
        }
    }
}
