import SwiftUI

/// A limit's colour by how full it is — the same green-to-red the page uses, without its pace tick.
enum LimitColor {
    static func of(_ share: Double?) -> Color {
        guard let share else { return .secondary }
        switch share {
        case ..<0.6: return .green
        case ..<0.8: return .yellow
        case ..<0.95: return .orange
        default: return .red
        }
    }
}
