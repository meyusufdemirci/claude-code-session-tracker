import AppKit
import SwiftUI

/**
 * A menu bar switch for the tracker, and the home its widget needs.
 *
 * No window and no Dock icon (`LSUIElement`): the whole app is the menu bar item.
 * It is also what the widget's links open, since a widget cannot start a process.
 */
@main
struct SessionTrackerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuContent()
                .environmentObject(delegate.controller)
        } label: {
            MenuBarLabel(controller: delegate.controller)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let controller = TrackerController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.launch()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        urls.forEach(controller.handle)
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.stopOwned()
    }
}

/// The icon, and the five-hour window's share beside it while the tracker runs.
struct MenuBarLabel: View {
    @ObservedObject var controller: TrackerController

    var body: some View {
        if let snapshot = controller.snapshot {
            Image(systemName: "gauge.with.dots.needle.67percent")
            if let share = snapshot.limits?.session.share {
                Text(Formatting.percent(share))
            }
        } else {
            Image(systemName: "gauge.with.dots.needle.0percent")
        }
    }
}
