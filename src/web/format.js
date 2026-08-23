/**
 * How numbers and moments are written, wherever they are written.
 *
 * Both pages read the same data and have to say it the same way — a token count
 * with the reader's own thousands separator, a share rounded down so it never
 * contradicts the colour beside it. One copy, so the two cannot drift apart.
 */

/** Thousands separators, in the reader's own locale. */
export function formatCount(value) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

/** `12.3K`, `4.1M` — a table cell has no room for a comma-grouped count. */
export function formatCompactCount(value) {
  return compactCountFormat.format(value);
}
const compactCountFormat = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * A share as a whole percent, except near zero, where `0%` would read as none at all.
 *
 * Rounded down, not to nearest, so the number stays on the same side of the colour
 * thresholds as the cell it explains — 19.96% is orange, and must not say `20%`.
 */
export function formatShare(share) {
  const percent = share * 100;
  // The exception the line above is about: nothing spent is the one case `0%` states
  // exactly, and `0.0%` there reads as a rounding rather than as an empty window.
  if (percent <= 0) return '0%';
  return percent >= 1 ? `${Math.floor(percent)}%` : `${percent.toFixed(1)}%`;
}

export function formatAgo(at) {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Clock time alone: a window's start and its reset are both today or tomorrow. */
export function formatClock(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** `19 Aug` — enough to place a day in the month behind you. */
export function formatDay(at) {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * An absolute moment, because this is where you check exactly when — with the
 * relative half after it, because that is the part you read without doing sums.
 */
export function formatStamp(at) {
  return at ? `${new Date(at).toLocaleString()} · ${formatAgo(at)}` : '—';
}
