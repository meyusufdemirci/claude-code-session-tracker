import { readFile } from 'node:fs/promises';

/**
 * The weekly reset Claude Code last heard from the server.
 *
 * Claude Code caches its own usage readout in the account file, under
 * `cachedUsageUtilization`, and that is the one place on this machine where the
 * weekly clock is written down as a date rather than guessed at. The percentages
 * beside it go stale — they are refreshed only when something asks the server, which
 * may have been days ago — but the reset does not: weekly windows are exactly seven
 * days apart, so any reset it has ever named still says where every week since
 * begins. Stepping it forward is the whole point; its age does not matter.
 *
 * `seven_day` is the bar that covers every model. The `seven_day_opus` and
 * `seven_day_sonnet` entries beside it are separate clocks on separate models, and
 * reading one of those as *the* weekly window would put its edges days from where
 * they belong.
 */
export async function readWeeklyReset(path: string): Promise<number | undefined> {
  let parsed: unknown;
  try {
    // A few hundred kilobytes, parsed once per poll. Small enough to read whole
    // rather than keep a cache in step with a file Claude Code rewrites constantly.
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // No account file, or one caught mid-write. Neither is an error: it only means
    // the week has to be counted back from now instead of pinned.
    return undefined;
  }

  const utilization = obj(obj(obj(parsed)?.['cachedUsageUtilization'])?.['utilization']);
  const raw = obj(utilization?.['seven_day'])?.['resets_at'];
  if (typeof raw !== 'string') return undefined;

  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
