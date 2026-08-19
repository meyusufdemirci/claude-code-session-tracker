import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A session file's claim that some process is running. */
export interface LivenessCandidate {
  pid: number;
  /** `procStart` as written by Claude Code, e.g. `Wed Aug 19 05:30:26 2026`. */
  procStart?: string | undefined;
}

/** Second-granularity clocks on both sides, so allow a little slack when comparing. */
const START_TIME_TOLERANCE_MS = 2_000;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Narrow a list of session records down to the ones whose process is really running.
 *
 * Two gates, because either one alone lies:
 *
 * 1. `process.kill(pid, 0)` — cheap, but a recycled pid answers yes for a session
 *    that ended hours ago. Session files are not cleaned up reliably, so this
 *    happens in practice.
 * 2. Start-time comparison against `ps` — a recycled pid belongs to a process that
 *    started at a different moment, which is what actually rules it out.
 *
 * The second gate is best-effort: where `ps` is unavailable (Windows) or gives us
 * nothing, we fall back to the signal check rather than reporting an empty machine.
 */
export async function filterAlive<T extends LivenessCandidate>(candidates: T[]): Promise<T[]> {
  const signalled = candidates.filter((candidate) => respondsToSignal(candidate.pid));
  if (signalled.length === 0) return [];

  const started = await readProcessStartTimes([...new Set(signalled.map((c) => c.pid))]);
  if (started === null) return signalled;

  // Decided per record rather than per pid: two records can name the same pid, and
  // only the one whose start time matches describes the process that is running.
  return signalled.filter((candidate) => {
    const actual = started.get(candidate.pid);
    // Gone between the signal and the `ps` call — it was exiting as we looked.
    if (actual === undefined) return false;
    // No claim to check against; the signal is all the evidence there is.
    if (candidate.procStart === undefined) return true;
    return startTimesMatch(candidate.procStart, actual);
  });
}

/** Does signal 0 reach this pid? `EPERM` means it exists but belongs to someone else. */
function respondsToSignal(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/**
 * Start time per pid, in one `ps` call for the whole set.
 *
 * Returns `null` when the probe itself is unusable, which the caller reads as
 * "unknown", not as "nothing is running". Out-of-range pids would make `ps` bail
 * on the entire batch, but those never reach here — the signal check drops them.
 */
async function readProcessStartTimes(pids: number[]): Promise<Map<number, number> | null> {
  if (process.platform === 'win32') return null;

  let stdout: string;
  try {
    ({ stdout } = await run('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
      timeout: 5_000,
      windowsHide: true,
    }));
  } catch {
    return null;
  }

  const times = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [rawPid, ...rest] = trimmed.split(/\s+/);
    const pid = Number.parseInt(rawPid ?? '', 10);
    const parsed = parseCtime(rest.join(' '));
    if (Number.isInteger(pid) && parsed) times.set(pid, parsed.asLocal);
  }
  // `ps` ran but told us nothing we could read — treat the probe as unavailable.
  return times.size === 0 ? null : times;
}

/**
 * Compare the recorded start time with the real one.
 *
 * `ps` prints local time. Claude Code writes `procStart` in UTC — verified: a
 * session recorded `05:30:26` that `ps` reports as `08:30:26` in a UTC+3 zone.
 * That is undocumented and could change, so we accept either reading. Both
 * matching a *recycled* pid would need its start to land exactly one whole
 * timezone offset away, to the second.
 */
function startTimesMatch(claimed: string, actualLocalMs: number): boolean {
  const parsed = parseCtime(claimed);
  if (!parsed) return true; // Unparseable claim: do not use it to hide a live session.
  return (
    Math.abs(actualLocalMs - parsed.asUtc) <= START_TIME_TOLERANCE_MS ||
    Math.abs(actualLocalMs - parsed.asLocal) <= START_TIME_TOLERANCE_MS
  );
}

/**
 * Parse `Www Mmm [D]D HH:MM:SS YYYY` (the C `ctime` format both sides use).
 *
 * The string carries no zone, so we return both readings and let the caller
 * decide. `Date.parse` is not an option: it would silently assume local.
 */
function parseCtime(value: string): { asUtc: number; asLocal: number } | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 5) return null;

  const [, rawMonth, rawDay, rawTime, rawYear] = parts;
  const clock = (rawTime ?? '').split(':');

  const month = MONTHS[rawMonth?.slice(0, 3).toLowerCase() ?? ''];
  const day = toInt(rawDay);
  const year = toInt(rawYear);
  const hour = toInt(clock[0]);
  const minute = toInt(clock[1]);
  const second = toInt(clock[2]);

  if (
    month === undefined ||
    day === null ||
    year === null ||
    hour === null ||
    minute === null ||
    second === null
  ) {
    return null;
  }

  return {
    asUtc: Date.UTC(year, month, day, hour, minute, second),
    asLocal: new Date(year, month, day, hour, minute, second).getTime(),
  };
}

function toInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) ? parsed : null;
}
