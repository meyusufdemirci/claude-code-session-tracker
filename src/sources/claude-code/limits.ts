import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TrackerConfig } from '../../config.ts';
import type { FileCache } from '../../core/cache.ts';
import type { SessionTokenTotals, UsageLimits, UsageWindow } from '../../core/types.ts';
import { readLines } from './lines.ts';
import { addUsage } from './usage.ts';

/** The stretch Claude Code bills against, and calls a session limit. */
const WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * What a window's start is rounded down to.
 *
 * Not a guess. On the one rejection this was calibrated against, the window's first
 * turn landed at 08:37:29 and Claude reported it resetting at 13:30 — five hours from
 * 08:30, the half hour below. Bucketing at the same width is what lets a window's
 * start be read straight off a bucket rather than tracked separately.
 */
const BUCKET_MS = 30 * 60 * 1000;

/** How far back the yardstick looks for a heavier window than the one in progress. */
const HISTORY_DAYS = 7;

/** Matches the cap the other transcript readers work under. */
const MAX_RECORD_BYTES = 256 * 1024;

/** Claude Code's stand-in on messages it produced itself — including the rejection notice. */
const SYNTHETIC_MODEL = '<synthetic>';

/** Reading a week of history opens hundreds of files; keep the descriptor count polite. */
const MAX_OPEN_FILES = 24;

/** `<slug>/<uuid>.jsonl` — a session's own transcript. */
const TRANSCRIPT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** `<slug>/<uuid>/subagents/agent-*.jsonl`. The `.meta.json` sidecars are not transcripts. */
const SUBAGENT_FILE = /^agent-.+\.jsonl$/;

/**
 * Half an hour of billed usage, as read off one transcript.
 *
 * Cached per file version rather than merged straight into a window, because the
 * files are the part that does not change: a finished transcript yields the same
 * buckets forever, while which window those buckets fall into moves with the clock.
 */
export interface UsageBucket {
  /** Start of the half hour, in epoch milliseconds. */
  at: number;
  tokens: SessionTokenTotals;
  turns: number;
  /** A five-hour rate-limit rejection was recorded in this half hour. */
  limited: boolean;
  /** The reset time Claude reported alongside that rejection, when it carried one. */
  reportedResetAt?: number;
}

/** A transcript that bills, whether it belongs to a session or to one of its subagents. */
interface BilledFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * What the five-hour limit currently looks like, measured from `~/.claude/projects`.
 *
 * Two questions, one sweep. How full is the window in progress — which only the last
 * five hours of transcripts can answer — and how full does a window get around here,
 * which needs a week of them. The week is why this is cached per file: a finished
 * transcript is read once and never again, so the cost after the first call is the
 * handful of files still being appended to.
 */
export async function readUsageLimits(
  config: TrackerConfig,
  cache: FileCache<UsageBucket[]>,
  now: number = Date.now(),
): Promise<UsageLimits> {
  const since = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  // A transcript is append-only, so one last written before the cutoff cannot hold a
  // record after it. That makes `mtime` a sound filter, and it costs a `stat` rather
  // than a read — the same trade the session listing makes.
  const files = (await listBilledFiles(config.projectsDir)).filter((file) => file.mtimeMs >= since);
  const perFile = await mapLimit(files, MAX_OPEN_FILES, (file) => loadBuckets(file, cache));

  const merged = new Map<number, UsageBucket>();
  for (const buckets of perFile) {
    for (const bucket of buckets) {
      // A resumed session can carry records from well before the cutoff; the file
      // being recent says nothing about the records inside it.
      if (bucket.at < since) continue;
      mergeBucket(merged, bucket);
    }
  }

  const windows = chainWindows([...merged.values()].sort((a, b) => a.at - b.at));
  const last = windows.at(-1);
  const current = last && last.resetsAt > now ? last : undefined;

  // Last, not heaviest: a refusal is only evidence of where the ceiling was at the
  // time, and the most recent one is the closest that evidence gets to today.
  const lastLimited = windows.filter((window) => window.limited).at(-1);

  return {
    ...(current ? { current } : {}),
    ...(pickReference(windows, now) ?? {}),
    ...(lastLimited ? { lastLimited } : {}),
    historyDays: HISTORY_DAYS,
    generatedAt: now,
  };
}

/**
 * Input, output and newly-cached tokens — the measure a window is sized by.
 *
 * Cache reads are left out. They are billed at a fraction of the rest and outweigh
 * it roughly fifty to one, so counting them would produce a number that moves with
 * how long a conversation is rather than with how much work was asked of the model.
 */
export function billedTokens(tokens: SessionTokenTotals | undefined): number {
  return tokens ? tokens.input + tokens.output + tokens.cacheCreate : 0;
}

/**
 * The heaviest window that has already closed.
 *
 * Closed, because the window in progress must never become its own denominator —
 * it would read 100% full from its first turn onwards. Nothing is returned when
 * there is no closed window to compare against yet, and the page says so rather
 * than inventing a ceiling.
 */
function pickReference(
  windows: readonly UsageWindow[],
  now: number,
): { reference: UsageWindow } | undefined {
  let best: UsageWindow | undefined;
  for (const window of windows) {
    if (window.resetsAt > now) continue;
    if (!best || billedTokens(window.tokens) > billedTokens(best.tokens)) best = window;
  }
  return best && billedTokens(best.tokens) > 0 ? { reference: best } : undefined;
}

/**
 * Lay half hours end to end into five-hour windows.
 *
 * A window opens on the first billed turn after the previous one emptied and runs
 * five hours from there, so a run of continuous work chains one window straight into
 * the next while a quiet afternoon leaves a gap that belongs to neither.
 */
function chainWindows(buckets: readonly UsageBucket[]): UsageWindow[] {
  const windows: UsageWindow[] = [];
  let open: UsageWindow | undefined;

  for (const bucket of buckets) {
    if (!open || bucket.at >= open.resetsAt) {
      open = {
        startedAt: bucket.at,
        resetsAt: bucket.at + WINDOW_MS,
        resetsAtIsReported: false,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        turns: 0,
        limited: false,
      };
      windows.push(open);
    }

    open.tokens.input += bucket.tokens.input;
    open.tokens.output += bucket.tokens.output;
    open.tokens.cacheRead += bucket.tokens.cacheRead;
    open.tokens.cacheCreate += bucket.tokens.cacheCreate;
    open.turns += bucket.turns;
    if (bucket.limited) open.limited = true;
    // Claude told us when this one empties, which beats deriving it from a rounded
    // start. Later buckets are then chained against Claude's answer, not ours.
    if (bucket.reportedResetAt !== undefined) {
      open.resetsAt = bucket.reportedResetAt;
      open.resetsAtIsReported = true;
    }
  }

  return windows;
}

function mergeBucket(into: Map<number, UsageBucket>, bucket: UsageBucket): void {
  const existing = into.get(bucket.at);
  if (!existing) {
    into.set(bucket.at, {
      at: bucket.at,
      tokens: { ...bucket.tokens },
      turns: bucket.turns,
      limited: bucket.limited,
      ...(bucket.reportedResetAt !== undefined ? { reportedResetAt: bucket.reportedResetAt } : {}),
    });
    return;
  }

  existing.tokens.input += bucket.tokens.input;
  existing.tokens.output += bucket.tokens.output;
  existing.tokens.cacheRead += bucket.tokens.cacheRead;
  existing.tokens.cacheCreate += bucket.tokens.cacheCreate;
  existing.turns += bucket.turns;
  if (bucket.limited) existing.limited = true;
  if (bucket.reportedResetAt !== undefined) existing.reportedResetAt = bucket.reportedResetAt;
}

async function loadBuckets(file: BilledFile, cache: FileCache<UsageBucket[]>): Promise<UsageBucket[]> {
  const cached = cache.get(file.path, file);
  if (cached) return cached;

  let buckets: UsageBucket[];
  try {
    buckets = await scanBuckets(file.path);
  } catch {
    // Deleted between the `stat` and the read, or unreadable some other way. One
    // missing transcript understates a window; failing the whole strip loses all of them.
    return [];
  }

  cache.set(file.path, file, buckets);
  return buckets;
}

/** Every record shape this reader touches. All `unknown`: the format is private and moves. */
interface TranscriptRecord {
  type?: unknown;
  timestamp?: unknown;
  message?: unknown;
  quotaLimits?: unknown;
}

/**
 * One transcript's billed usage, gathered into half hours.
 *
 * The turn-collapsing rule is `usage.ts`'s: one assistant turn is written as one
 * record per content block and every one of them repeats the turn's totals, so the
 * previous record's id is remembered and a repeat is skipped. Turns are contiguous,
 * which is what makes remembering only the previous one enough.
 */
async function scanBuckets(path: string): Promise<UsageBucket[]> {
  const buckets = new Map<number, UsageBucket>();
  let previousTurn: string | undefined;

  for await (const line of readLines(path, MAX_RECORD_BYTES)) {
    if (line.truncated) continue;

    const text = line.text.trim();
    if (!text) continue;

    let record: TranscriptRecord;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      record = parsed as TranscriptRecord;
    } catch {
      continue;
    }

    const at = timestampOf(record);
    if (at === undefined) continue;

    const rejection = fiveHourRejection(record);
    if (rejection) {
      const bucket = bucketAt(buckets, at);
      bucket.limited = true;
      if (rejection.resetsAt !== undefined) bucket.reportedResetAt = rejection.resetsAt;
      continue;
    }

    if (record.type !== 'assistant') continue;
    const message = obj(record.message);
    if (!message) continue;
    // Claude Code writes its own notices as assistant records under a stand-in model.
    // Nobody was billed for those, so they must not open a bucket or count as a turn.
    if (str(message.model) === SYNTHETIC_MODEL) continue;

    const turn = str(message.id);
    if (turn !== undefined && turn === previousTurn) continue;
    previousTurn = turn;

    const usage = obj(message.usage);
    if (!usage) continue;

    const bucket = bucketAt(buckets, at);
    addUsage(bucket.tokens, usage);
    bucket.turns += 1;
  }

  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

function bucketAt(buckets: Map<number, UsageBucket>, at: number): UsageBucket {
  const start = Math.floor(at / BUCKET_MS) * BUCKET_MS;
  let bucket = buckets.get(start);
  if (!bucket) {
    bucket = {
      at: start,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      turns: 0,
      limited: false,
    };
    buckets.set(start, bucket);
  }
  return bucket;
}

/**
 * The one thing Claude Code writes down about the limit itself: the turn it refused.
 *
 * `rateLimitType` separates the five-hour window from the weekly one, which resets on
 * a different clock and would put a window's start in the wrong place entirely.
 */
function fiveHourRejection(record: TranscriptRecord): { resetsAt?: number } | undefined {
  const quota = obj(record.quotaLimits);
  if (!quota) return undefined;
  if (str(quota['status']) !== 'rejected') return undefined;
  if (str(quota['rateLimitType']) !== 'five_hour') return undefined;

  // Seconds on the wire, milliseconds everywhere in this tool.
  const seconds = num(quota['resetsAt']);
  return seconds === undefined ? {} : { resetsAt: seconds * 1000 };
}

/**
 * Every transcript that bills, under `~/.claude/projects`.
 *
 * Wider than the session listing's own sweep on purpose. That one wants sessions, and
 * a subagent is not one; this wants tokens, and a subagent's turns are billed to the
 * same window as the session that spawned it.
 */
async function listBilledFiles(projectsDir: string): Promise<BilledFile[]> {
  let projects: import('node:fs').Dirent[];
  try {
    projects = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    // No projects directory means no history — not an error.
    return [];
  }

  const perProject = await Promise.all(
    projects
      .filter((entry) => entry.isDirectory())
      .map((entry) => listProject(join(projectsDir, entry.name))),
  );
  return perProject.flat();
}

async function listProject(dir: string): Promise<BilledFile[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = await Promise.all(
    entries.map(async (entry): Promise<BilledFile[]> => {
      // A session's own transcript, and the folder beside it holding its subagents'.
      if (entry.isDirectory()) return listSubagents(join(dir, entry.name, 'subagents'));
      if (!TRANSCRIPT_FILE.test(entry.name)) return [];
      const file = await statFile(join(dir, entry.name));
      return file ? [file] : [];
    }),
  );
  return found.flat();
}

async function listSubagents(dir: string): Promise<BilledFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // A session with no subagents has no such folder, which is the common case.
    return [];
  }

  const found = await Promise.all(
    names.map((name) => (SUBAGENT_FILE.test(name) ? statFile(join(dir, name)) : undefined)),
  );
  return found.filter((file): file is BilledFile => file !== undefined);
}

async function statFile(path: string): Promise<BilledFile | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return undefined;
    return { path, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    // Deleted between the readdir and the stat.
    return undefined;
  }
}

function timestampOf(record: TranscriptRecord): number | undefined {
  const raw = str(record.timestamp);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
