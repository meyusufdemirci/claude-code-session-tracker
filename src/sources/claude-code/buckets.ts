import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TrackerConfig } from '../../config.ts';
import type { FileCache } from '../../core/cache.ts';
import type { SessionTokenTotals } from '../../core/types.ts';
import { readLines } from './lines.ts';
import { addUsage } from './usage.ts';

/**
 * One sweep of every transcript that bills, cut into half hours.
 *
 * This is the expensive read in the whole tool — hundreds of files and a gigabyte
 * of transcripts — and two features want it: the limit cards, which count these
 * half hours against Claude's two clocks, and the history page, which asks where
 * they went. So the sweep lives here and knows about neither. It answers one
 * question — when was each token billed, by which project, on which model — and
 * leaves every reading of that answer to its callers.
 *
 * The cost after the first call is the handful of files still being appended to:
 * a finished transcript yields the same buckets forever, so it is read once per
 * version of itself and remembered.
 */

/**
 * What a half hour is floored to.
 *
 * Not a guess. On the one rejection this was calibrated against, the window's first
 * turn landed at 08:37:29 and Claude reported it resetting at 13:30 — five hours from
 * 08:30, the half hour below. Bucketing at the same width is what lets a five-hour
 * window's start be read straight off a bucket rather than tracked separately.
 */
export const BUCKET_MS = 30 * 60 * 1000;

/** Matches the cap the other transcript readers work under. */
const MAX_RECORD_BYTES = 256 * 1024;

/** Claude Code's stand-in on messages it produced itself — including the rejection notice. */
const SYNTHETIC_MODEL = '<synthetic>';

/** Reading a month of history opens hundreds of files; keep the descriptor count polite. */
const MAX_OPEN_FILES = 24;

/** `<slug>/<uuid>.jsonl` — a session's own transcript. */
const TRANSCRIPT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** `<slug>/<uuid>/subagents/agent-*.jsonl`. The `.meta.json` sidecars are not transcripts. */
const SUBAGENT_FILE = /^agent-.+\.jsonl$/;

/** What one model was billed inside one half hour. */
export interface ModelUsage {
  tokens: SessionTokenTotals;
  turns: number;
}

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
  /**
   * The same tokens and turns, split by the model that answered.
   *
   * A split of the turns that named a model, which on every transcript seen so far
   * is all of them. A turn that named none still counts in `tokens` and `turns`
   * above, so this can sum to less than they do and must never sum to more — which
   * is the honest way round: the total is measured, the attribution is read.
   */
  byModel: Record<string, ModelUsage>;
  /** A five-hour rate-limit rejection was recorded in this half hour. */
  fiveHourLimited: boolean;
  /** The reset time Claude reported alongside that rejection, when it carried one. */
  fiveHourResetsAt?: number;
  /** A weekly rate-limit rejection was recorded in this half hour. */
  weeklyLimited: boolean;
  /**
   * The all-models weekly reset Claude reported alongside it.
   *
   * The only thing in a transcript that says where the weekly clock actually falls.
   * A refusal on one model's own weekly clock leaves this unset: it marks the week
   * as limited without being allowed to place its edges.
   */
  weeklyResetsAt?: number;
}

/**
 * What one transcript came to, beyond the half hours it was cut into.
 *
 * The sweep is already inside every billed file, and these are the facts a half
 * hour cannot hold: a bucket knows what was billed between 09:00 and 09:30, not
 * which session billed it, nor how large the window had grown by the time it did.
 * Reading them here costs nothing — the file is open and the turns are going past
 * either way — and it is the only place they can be read without opening it again.
 */
export interface FileRollup {
  /** The session this file bills to: its own id, or the parent's when it is a subagent's. */
  sessionId: string;
  /** True when the file is a subagent's transcript rather than a session's own. */
  subagent: boolean;
  /** When the first and last billed turn landed. Absent on a file that billed nothing. */
  firstAt?: number;
  lastAt?: number;
  /**
   * The first billed turn's usage, and the last's.
   *
   * Kept whole rather than reduced to a number here: what they are worth saying
   * about depends on the question, and the sweep is not the place that asks it.
   */
  first?: SessionTokenTotals;
  last?: SessionTokenTotals;
  turns: number;
  tokens: SessionTokenTotals;
}

/** One transcript's whole reading — what the cache holds, and what a re-read would cost. */
export interface FileUsage {
  buckets: UsageBucket[];
  rollup: FileRollup;
}

/**
 * One project's half hours, kept apart from every other project's.
 *
 * Attribution that costs nothing: the sweep already walks `projects/<slug>/…`, so
 * which project billed a file is known at the moment its name is read, without
 * opening it. The slug is carried rather than decoded — what directory it came
 * from is a fact, whereas the working directory it stands for is a lookup, and
 * that belongs to whoever is about to put a name on screen.
 */
export interface ProjectUsage {
  slug: string;
  /** Sorted by time, and only half hours that hold usage exist at all. */
  buckets: UsageBucket[];
}

/** The stretch of time a sweep covers, in epoch milliseconds. */
export interface BucketWindow {
  /** Inclusive. Buckets before this are dropped even when a recent file holds them. */
  since: number;
  /** Exclusive. Left off, the sweep runs to the end of what is on disk. */
  until?: number;
}

/**
 * Every billed half hour in `window`, by project.
 *
 * `mtime` does the coarse work: a transcript is append-only, so one last written
 * before `since` cannot hold a record after it, and a `stat` settles that without
 * opening anything. What survives is read, bucketed, and cached per file version —
 * then filtered again by bucket, because a resumed session can carry records from
 * well before the cutoff and the file being recent says nothing about the records
 * inside it.
 *
 * There is deliberately no `mtime` filter at the other end: a file written after
 * `until` can still hold records before it, so the upper bound is only ever settled
 * per bucket.
 */
export async function readUsageBuckets(
  config: TrackerConfig,
  cache: FileCache<FileUsage>,
  window: BucketWindow,
): Promise<ProjectUsage[]> {
  const read = await readUsageFiles(config, cache, window);

  const projects = new Map<string, Map<number, UsageBucket>>();
  for (const { file, usage } of read) {
    let merged = projects.get(file.slug);
    if (!merged) {
      merged = new Map<number, UsageBucket>();
      projects.set(file.slug, merged);
    }

    for (const bucket of usage.buckets) {
      if (bucket.at < window.since) continue;
      if (window.until !== undefined && bucket.at >= window.until) continue;
      mergeBucket(merged, bucket);
    }
  }

  return [...projects.entries()]
    .map(([slug, merged]) => ({
      slug,
      buckets: [...merged.values()].sort((a, b) => a.at - b.at),
    }))
    // A project whose every bucket fell outside the window is not in the window.
    .filter((project) => project.buckets.length > 0);
}

/**
 * Every billed transcript in `window`, with what the sweep read out of each.
 *
 * The sweep proper: one `stat` per file, a read of the ones that survive it, and a
 * cache entry per version of each. Both readings above it are groupings of this —
 * by project for the history page, by session for the profile — which is what keeps
 * a gigabyte of transcripts to a single pass however many questions are asked of it.
 *
 * Files are returned whole rather than filtered by `window`: a bucket's place on the
 * clock is the caller's business, and a rollup is a fact about the file itself,
 * which no window can narrow without changing what it means.
 */
export async function readUsageFiles(
  config: TrackerConfig,
  cache: FileCache<FileUsage>,
  window: BucketWindow,
): Promise<BilledFileUsage[]> {
  const files = (await listBilledFiles(config.projectsDir)).filter(
    (file) => file.mtimeMs >= window.since,
  );
  const perFile = await mapLimit(files, MAX_OPEN_FILES, (file) => loadBuckets(file, cache));
  return files.map((file, index) => ({ file, usage: perFile[index] ?? emptyUsage(file) }));
}

function emptyUsage(file: BilledFile): FileUsage {
  return {
    buckets: [],
    rollup: {
      sessionId: file.sessionId,
      subagent: file.subagent,
      turns: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    },
  };
}

/**
 * The same half hours with the projects folded together.
 *
 * What the limit clocks want: they bill one account, not one project, so a turn in
 * one repository and a turn in another an hour later belong to the same window.
 */
export function mergeBuckets(projects: readonly ProjectUsage[]): UsageBucket[] {
  const merged = new Map<number, UsageBucket>();
  for (const project of projects) {
    for (const bucket of project.buckets) mergeBucket(merged, bucket);
  }
  return [...merged.values()].sort((a, b) => a.at - b.at);
}

/**
 * Input, output and newly-cached tokens — the measure usage is sized by.
 *
 * Cache reads are left out. They are billed at a fraction of the rest and outweigh
 * it roughly fifty to one, so counting them would produce a number that moves with
 * how long a conversation is rather than with how much work was asked of the model.
 *
 * It lives here rather than with either reader because both have to mean the same
 * thing by it: a project ranked on the history page and a window filled on a limit
 * card are the same tokens counted the same way, or the page contradicts the card.
 */
export function billedTokens(tokens: SessionTokenTotals | undefined): number {
  return tokens ? tokens.input + tokens.output + tokens.cacheCreate : 0;
}

/** A transcript that bills, whether it belongs to a session or to one of its subagents. */
export interface BilledFile {
  path: string;
  /** The `projects/` folder it was found under — the project that billed it. */
  slug: string;
  /** The session it bills to. A subagent's is its parent's, taken from the folder above it. */
  sessionId: string;
  subagent: boolean;
  mtimeMs: number;
  size: number;
}

/** One transcript and everything the sweep read out of it. */
export interface BilledFileUsage {
  file: BilledFile;
  usage: FileUsage;
}

function mergeBucket(into: Map<number, UsageBucket>, bucket: UsageBucket): void {
  const existing = into.get(bucket.at);
  if (!existing) {
    into.set(bucket.at, {
      at: bucket.at,
      tokens: { ...bucket.tokens },
      turns: bucket.turns,
      byModel: cloneModels(bucket.byModel),
      fiveHourLimited: bucket.fiveHourLimited,
      weeklyLimited: bucket.weeklyLimited,
      ...(bucket.fiveHourResetsAt !== undefined
        ? { fiveHourResetsAt: bucket.fiveHourResetsAt }
        : {}),
      ...(bucket.weeklyResetsAt !== undefined ? { weeklyResetsAt: bucket.weeklyResetsAt } : {}),
    });
    return;
  }

  existing.tokens.input += bucket.tokens.input;
  existing.tokens.output += bucket.tokens.output;
  existing.tokens.cacheRead += bucket.tokens.cacheRead;
  existing.tokens.cacheCreate += bucket.tokens.cacheCreate;
  existing.turns += bucket.turns;
  mergeModels(existing.byModel, bucket.byModel);
  if (bucket.fiveHourLimited) existing.fiveHourLimited = true;
  if (bucket.weeklyLimited) existing.weeklyLimited = true;
  if (bucket.fiveHourResetsAt !== undefined) existing.fiveHourResetsAt = bucket.fiveHourResetsAt;
  if (bucket.weeklyResetsAt !== undefined) existing.weeklyResetsAt = bucket.weeklyResetsAt;
}

/**
 * Copied rather than shared, because the cache holds the value being merged.
 *
 * A cached bucket is handed out again on every sweep, so a merge that kept a
 * reference into one would add this call's totals to the next call's starting point.
 */
function cloneModels(byModel: Record<string, ModelUsage>): Record<string, ModelUsage> {
  const copy: Record<string, ModelUsage> = {};
  for (const [model, usage] of Object.entries(byModel)) {
    copy[model] = { tokens: { ...usage.tokens }, turns: usage.turns };
  }
  return copy;
}

function mergeModels(into: Record<string, ModelUsage>, from: Record<string, ModelUsage>): void {
  for (const [model, usage] of Object.entries(from)) {
    const existing = into[model];
    if (!existing) {
      into[model] = { tokens: { ...usage.tokens }, turns: usage.turns };
      continue;
    }
    existing.tokens.input += usage.tokens.input;
    existing.tokens.output += usage.tokens.output;
    existing.tokens.cacheRead += usage.tokens.cacheRead;
    existing.tokens.cacheCreate += usage.tokens.cacheCreate;
    existing.turns += usage.turns;
  }
}

async function loadBuckets(file: BilledFile, cache: FileCache<FileUsage>): Promise<FileUsage> {
  const cached = cache.get(file.path, file);
  if (cached) return cached;

  let usage: FileUsage;
  try {
    usage = await scanBuckets(file);
  } catch {
    // Deleted between the `stat` and the read, or unreadable some other way. One
    // missing transcript understates a window; failing the whole sweep loses all of them.
    return emptyUsage(file);
  }

  cache.set(file.path, file, usage);
  return usage;
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
async function scanBuckets(file: BilledFile): Promise<FileUsage> {
  const buckets = new Map<number, UsageBucket>();
  let previousTurn: string | undefined;

  // The rollup's half of the read. `first` is taken from the opening billed turn and
  // never replaced; `last` is replaced by every turn, so what survives the loop is
  // the closing one. Both are copies: the bucket they were added to is cached, and a
  // reference into it would age with the merges done to it later.
  const rollup: FileRollup = {
    sessionId: file.sessionId,
    subagent: file.subagent,
    turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  };

  for await (const line of readLines(file.path, MAX_RECORD_BYTES)) {
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

    const rejection = rejectionIn(record);
    if (rejection) {
      const bucket = bucketAt(buckets, at);
      if (rejection.clock === 'five_hour') {
        bucket.fiveHourLimited = true;
        if (rejection.resetsAt !== undefined) bucket.fiveHourResetsAt = rejection.resetsAt;
      } else {
        bucket.weeklyLimited = true;
        // A week hit on one model's clock is still a week hit, but its reset belongs
        // to that model rather than to the bar this limit draws.
        if (rejection.resetsAt !== undefined && !rejection.scoped) {
          bucket.weeklyResetsAt = rejection.resetsAt;
        }
      }
      continue;
    }

    if (record.type !== 'assistant') continue;
    const message = obj(record.message);
    if (!message) continue;
    // Claude Code writes its own notices as assistant records under a stand-in model.
    // Nobody was billed for those, so they must not open a bucket or count as a turn.
    const model = str(message.model);
    if (model === SYNTHETIC_MODEL) continue;

    const turn = str(message.id);
    if (turn !== undefined && turn === previousTurn) continue;
    previousTurn = turn;

    const usage = obj(message.usage);
    if (!usage) continue;

    const bucket = bucketAt(buckets, at);
    addUsage(bucket.tokens, usage);
    bucket.turns += 1;

    const turnUsage: SessionTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    addUsage(turnUsage, usage);
    addUsage(rollup.tokens, usage);
    rollup.turns += 1;
    rollup.first ??= turnUsage;
    rollup.firstAt ??= at;
    rollup.last = turnUsage;
    rollup.lastAt = at;

    if (model !== undefined) {
      const entry = (bucket.byModel[model] ??= {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        turns: 0,
      });
      addUsage(entry.tokens, usage);
      entry.turns += 1;
    }
  }

  return { buckets: [...buckets.values()].sort((a, b) => a.at - b.at), rollup };
}

function bucketAt(buckets: Map<number, UsageBucket>, at: number): UsageBucket {
  const start = Math.floor(at / BUCKET_MS) * BUCKET_MS;
  let bucket = buckets.get(start);
  if (!bucket) {
    bucket = {
      at: start,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      turns: 0,
      byModel: {},
      fiveHourLimited: false,
      weeklyLimited: false,
    };
    buckets.set(start, bucket);
  }
  return bucket;
}

/**
 * The one thing Claude Code writes down about a limit itself: the turn it refused.
 *
 * `rateLimitType` says which clock ran out, and the three must never be confused.
 * A weekly reset read as a five-hour one would put a window's end days from where it
 * is. And `seven_day` is not one clock but a family: the bare name is the bar across
 * every model, while `seven_day_opus` and its siblings are separate weeks on single
 * models, which is what `scoped` marks. A type we have never seen is left alone
 * rather than guessed at.
 */
function rejectionIn(
  record: TranscriptRecord,
): { clock: 'five_hour' | 'weekly'; resetsAt?: number; scoped: boolean } | undefined {
  const quota = obj(record.quotaLimits);
  if (!quota) return undefined;
  if (str(quota['status']) !== 'rejected') return undefined;

  const type = str(quota['rateLimitType']);
  const clock =
    type === 'five_hour'
      ? 'five_hour'
      : type?.startsWith('seven_day') || type === 'weekly'
        ? 'weekly'
        : undefined;
  if (!clock) return undefined;

  const scoped = clock === 'weekly' && type !== 'seven_day' && type !== 'weekly';
  // Seconds on the wire, milliseconds everywhere in this tool.
  const seconds = num(quota['resetsAt']);
  return seconds === undefined
    ? { clock, scoped }
    : { clock, resetsAt: seconds * 1000, scoped };
}

/**
 * Every transcript that bills, under `~/.claude/projects`.
 *
 * Wider than the session listing's own sweep on purpose. That one wants sessions, and
 * a subagent is not one; this wants tokens, and a subagent's turns are billed to the
 * same window as the session that spawned them — and to the same project, which is
 * why they are found under its slug rather than given one of their own.
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
      .map((entry) => listProject(join(projectsDir, entry.name), entry.name)),
  );
  return perProject.flat();
}

async function listProject(dir: string, slug: string): Promise<BilledFile[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = await Promise.all(
    entries.map(async (entry): Promise<BilledFile[]> => {
      // A session's own transcript, and the folder beside it holding its subagents'.
      // A session's folder is named after the session, which is what makes the
      // subagents inside it attributable without opening one of them.
      if (entry.isDirectory()) {
        return listSubagents(join(dir, entry.name, 'subagents'), slug, entry.name.toLowerCase());
      }
      const match = TRANSCRIPT_FILE.exec(entry.name);
      if (!match?.[1]) return [];
      const file = await statFile(join(dir, entry.name), slug, match[1].toLowerCase(), false);
      return file ? [file] : [];
    }),
  );
  return found.flat();
}

async function listSubagents(dir: string, slug: string, sessionId: string): Promise<BilledFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // A session with no subagents has no such folder, which is the common case.
    return [];
  }

  const found = await Promise.all(
    names.map((name) =>
      SUBAGENT_FILE.test(name) ? statFile(join(dir, name), slug, sessionId, true) : undefined,
    ),
  );
  return found.filter((file): file is BilledFile => file !== undefined);
}

async function statFile(
  path: string,
  slug: string,
  sessionId: string,
  subagent: boolean,
): Promise<BilledFile | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return undefined;
    return { path, slug, sessionId, subagent, mtimeMs: info.mtimeMs, size: info.size };
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
