import { readFile } from 'node:fs/promises';

/**
 * The grain a reset is rounded to.
 *
 * The server writes a window's end as the instant before the next one opens —
 * `16:59:59.870550` for a window that empties at five — so a reset taken literally
 * puts every card a minute behind the tool it is reading. A minute is also the
 * finest either window is ever shown at, so nothing is lost by settling it here.
 */
const MINUTE_MS = 60 * 1000;

/**
 * Claude Code's own reading of one limit.
 *
 * A percentage of the real ceiling — the only one on this machine that is a share
 * of the quota the server actually enforces, rather than of something we measured
 * and picked as a stand-in for it.
 */
export interface ReportedLimit {
  /** How full Claude Code last saw this limit, 0–100. */
  percent: number;
  /** When the window it describes empties, when the readout named one. */
  resetsAt?: number;
}

/** Both limits as the account file last cached them, and when that was. */
export interface ReportedUsage {
  /** When Claude Code last asked the server. The percentages are only as new as this. */
  fetchedAt: number;
  /** The five-hour bar Claude Code calls a session limit. */
  session?: ReportedLimit;
  /** The seven-day bar that covers every model. */
  weekly?: ReportedLimit;
}

/**
 * The usage readout Claude Code last heard from the server.
 *
 * Claude Code caches it in the account file under `cachedUsageUtilization`, and it
 * is the one place on this machine where either limit is written down as a share of
 * the real ceiling — the quota itself is enforced server-side and appears nowhere
 * else. It is what Claude Code's own `/usage` shows, so reading it here is what
 * keeps the two from quoting different numbers for the same window.
 *
 * The percentages go stale between fetches — they are refreshed only when something
 * asks the server — which is why `fetchedAt` comes back with them and the caller
 * decides what an old reading is still worth. The resets do not go stale in the same
 * way: windows are exactly five hours and seven days apart, so any reset the file has
 * ever named still says where later windows begin.
 *
 * `seven_day` is the bar that covers every model. The `seven_day_opus` and
 * `seven_day_sonnet` entries beside it are separate clocks on separate models, and
 * reading one of those as *the* weekly window would put its edges days from where
 * they belong.
 */
export async function readReportedUsage(path: string): Promise<ReportedUsage | undefined> {
  let parsed: unknown;
  try {
    // A few hundred kilobytes, parsed once per poll. Small enough to read whole
    // rather than keep a cache in step with a file Claude Code rewrites constantly.
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // No account file, or one caught mid-write. Neither is an error: it only means
    // both limits fall back to what the transcripts alone can say.
    return undefined;
  }

  const cached = obj(obj(parsed)?.['cachedUsageUtilization']);
  const utilization = obj(cached?.['utilization']);
  if (!utilization) return undefined;

  const fetchedAt = cached?.['fetchedAtMs'];
  return {
    fetchedAt: typeof fetchedAt === 'number' ? fetchedAt : 0,
    ...spread('session', reading(utilization['five_hour'])),
    ...spread('weekly', reading(utilization['seven_day'])),
  };
}

/** One entry of the readout, kept only when it says something we can use. */
function reading(value: unknown): ReportedLimit | undefined {
  const entry = obj(value);
  if (!entry) return undefined;

  const percent = entry['utilization'];
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;

  const raw = entry['resets_at'];
  const at = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return {
    percent,
    ...(Number.isFinite(at) ? { resetsAt: Math.round(at / MINUTE_MS) * MINUTE_MS } : {}),
  };
}

function spread<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
