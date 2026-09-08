import type { TrackerConfig } from '../../config.ts';
import type { FileCache } from '../../core/cache.ts';
import type {
  ReportedLimitReading,
  SessionTokenTotals,
  UsageLimit,
  UsageLimits,
  UsageWindow,
} from '../../core/types.ts';
import {
  billedTokens,
  mergeBuckets,
  readUsageBuckets,
  type FileUsage,
  type UsageBucket,
} from './buckets.ts';
import { readReportedUsage, type ReportedLimit } from './quota.ts';

/** The stretch Claude Code bills against, and calls a session limit. */
const WINDOW_MS = 5 * 60 * 60 * 1000;

/** The stretch Claude Code bills the weekly limit against. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** How far back the five-hour yardstick looks for a heavier window than the one in progress. */
const HISTORY_DAYS = 7;

/**
 * How far back the weekly yardstick looks.
 *
 * Four weeks, because a week can only be measured against other whole weeks and
 * one of them is always the week in progress — so anything shorter would leave a
 * yardstick drawn from a single sample.
 */
const WEEK_HISTORY_DAYS = 28;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What both limits currently look like, measured from `~/.claude/projects`.
 *
 * Two clocks, one sweep. How full is the window in progress — which only the last
 * five hours of transcripts can answer — and how full does a window get around here,
 * which needs weeks of them. `buckets.ts` does that reading and caches it per file;
 * everything here is the arithmetic of laying clocks over what it found.
 *
 * The weekly limit rides along for free. It is the same turns counted against a
 * longer clock, so the only thing it adds to the sweep is the older end of the
 * history — and one pass over the files answers both.
 *
 * Which project billed a half hour, and which model, is read on the same pass and
 * ignored here: a limit is billed to the account, so the projects are folded
 * together before either clock sees them.
 *
 * None of that arithmetic can say how full a window is, because the ceiling it would
 * be a share of is enforced server-side and never written down. Claude Code's own
 * cached readout can, and does — so it is read alongside and carried through as
 * `reported`, which is what keeps this tool and Claude Code quoting the same
 * percentage for the same window.
 */
export async function readUsageLimits(
  config: TrackerConfig,
  cache: FileCache<FileUsage>,
  now: number = Date.now(),
): Promise<UsageLimits> {
  // The wider of the two histories: the weekly yardstick needs four weeks, the
  // five-hour one a single week, and the files are only worth walking once.
  const since = now - WEEK_HISTORY_DAYS * DAY_MS;
  const buckets = mergeBuckets(await readUsageBuckets(config, cache, { since }));
  // Where both clocks actually fall, and how full the server says they are. Read
  // alongside the transcripts because it answers what they cannot.
  const reported = await readReportedUsage(config.claudeJsonPath);

  return {
    session: measureFiveHour(buckets, now, reported?.session, reported?.fetchedAt),
    weekly: measureWeekly(buckets, now, reported?.weekly, reported?.fetchedAt),
    generatedAt: now,
  };
}

/**
 * Claude Code's reading, kept only while it still describes the window in progress.
 *
 * A percentage outlives its window: the file keeps saying 88% long after the five
 * hours it was 88% of have emptied, because nothing rewrites it until Claude Code
 * next asks the server. Past its own reset it is a fact about a window nobody is in,
 * and the card falls back to the yardstick rather than showing a bar that will not
 * move until the next prompt.
 */
function attachReported(
  reported: ReportedLimit | undefined,
  fetchedAt: number | undefined,
  now: number,
): { reported: ReportedLimitReading } | undefined {
  if (!reported || (reported.resetsAt !== undefined && reported.resetsAt <= now)) return undefined;
  return {
    reported: {
      percent: reported.percent,
      fetchedAt: fetchedAt ?? 0,
      ...(reported.resetsAt !== undefined ? { resetsAt: reported.resetsAt } : {}),
    },
  };
}

/**
 * The five-hour limit, from the last week of half hours.
 *
 * Deliberately narrower than the sweep that fed it: the yardstick is the heaviest
 * window of the last seven days, and handing it four weeks would quietly change
 * what the number on the page is a share of.
 */
function measureFiveHour(
  buckets: readonly UsageBucket[],
  now: number,
  reported?: ReportedLimit,
  fetchedAt?: number,
): UsageLimit {
  const since = now - HISTORY_DAYS * DAY_MS;
  const recent = buckets.filter((bucket) => bucket.at >= since);
  const windows = chainWindows(recent);
  const last = windows.at(-1);
  const chained = last && last.resetsAt > now ? last : undefined;
  // Claude Code's own reset, when it has one, beats a window chained off timestamps:
  // it is the edge the server is actually billing to, and the span it marks out is
  // the one the percentage beside it was a percentage of.
  const current = reportedWindow(recent, reported?.resetsAt, now) ?? chained;

  return {
    windowMs: WINDOW_MS,
    clock: current && current !== chained ? 'reported' : 'chained',
    historyDays: HISTORY_DAYS,
    ...attachReported(reported, fetchedAt, now),
    ...summarize(windows, chained, now, current),
  };
}

/**
 * The five hours ending at the reset Claude Code reported, filled from the sweep.
 *
 * The chain is a good guess at where a window opened — five quiet hours end one — but
 * it is still a guess, and it is drawn from this machine's transcripts alone. A reported
 * reset is neither: it is the server's own edge, so the window is counted back five
 * hours from it and whatever landed inside is what the window holds. Nothing is
 * returned once that reset has passed, which is a window that has already emptied.
 */
function reportedWindow(
  buckets: readonly UsageBucket[],
  resetsAt: number | undefined,
  now: number,
): UsageWindow | undefined {
  if (resetsAt === undefined || resetsAt <= now) return undefined;

  const window = emptyWindow(resetsAt - WINDOW_MS, resetsAt, true);
  for (const bucket of buckets) {
    if (bucket.at < window.startedAt || bucket.at >= resetsAt) continue;
    addBucket(window, bucket, bucket.fiveHourLimited);
  }
  return window;
}

/**
 * The weekly limit that covers every model, cut into seven-day blocks.
 *
 * Where those blocks fall is the whole question. A five-hour window can be found in
 * the timestamps — five quiet hours end one — but nobody goes a week without running
 * Claude, so there is no gap to read a week's edge off. Claude's own clock is the
 * only true answer, and it writes that down in two places: the usage readout it
 * caches in the account file, and a weekly refusal. Either one pins the blocks and
 * they step forward in sevens from there; with neither they are counted back from
 * now, and `clock` says which happened rather than letting the page imply a reset
 * nobody knows.
 *
 * The cached readout is preferred because it is unambiguous about *which* weekly bar
 * it describes. A refusal need not be — Claude bills some models on weekly clocks of
 * their own — so only the all-models refusals are allowed to place a week.
 */
function measureWeekly(
  buckets: readonly UsageBucket[],
  now: number,
  cached?: ReportedLimit,
  fetchedAt?: number,
): UsageLimit {
  const reported = cached?.resetsAt ?? refusedWeeklyReset(buckets);
  const anchor = reported ?? now;
  const windows = blockWindows(buckets, anchor, reported !== undefined);
  // `now - 1`, not `now`: with no reported reset the anchor *is* now, and the block
  // holding this instant is the empty one about to open rather than the week behind it.
  const currentStart = blockStart(now - 1, anchor);
  const current = windows.find((window) => window.startedAt === currentStart);

  return {
    windowMs: WEEK_MS,
    clock: reported === undefined ? 'rolling' : 'reported',
    historyDays: WEEK_HISTORY_DAYS,
    ...attachReported(cached, fetchedAt, now),
    ...summarize(windows, current, now),
  };
}

/** The window in progress, the yardstick, and the last refusal — the three every limit reports. */
function summarize(
  windows: readonly UsageWindow[],
  current: UsageWindow | undefined,
  now: number,
  reportAs: UsageWindow | undefined = current,
): Pick<UsageLimit, 'current' | 'reference' | 'lastLimited'> {
  // Last, not heaviest: a refusal is only evidence of where the ceiling was at the
  // time, and the most recent one is the closest that evidence gets to today.
  const lastLimited = windows.filter((window) => window.limited).at(-1);

  return {
    // Which window is reported and which one the yardstick must skip can differ:
    // a reported five-hour window is not one of `windows`, and the chained window
    // it stands in for is still the one that must never become its own denominator.
    ...(reportAs ? { current: reportAs } : {}),
    ...(pickReference(windows, current, now) ?? {}),
    ...(lastLimited ? { lastLimited } : {}),
  };
}

/**
 * The heaviest window that has already closed.
 *
 * Closed, because the window in progress must never become its own denominator —
 * it would read 100% full from its first turn onwards. It is skipped by identity as
 * well as by clock: a rolling week ends at the very instant it is measured, so the
 * arithmetic alone would call it closed. Nothing is returned when there is no closed
 * window to compare against yet, and the page says so rather than inventing a ceiling.
 */
function pickReference(
  windows: readonly UsageWindow[],
  current: UsageWindow | undefined,
  now: number,
): { reference: UsageWindow } | undefined {
  let best: UsageWindow | undefined;
  for (const window of windows) {
    if (window === current || window.resetsAt > now) continue;
    if (!best || billedTokens(window.tokens) > billedTokens(best.tokens)) best = window;
  }
  return best && billedTokens(best.tokens) > 0 ? { reference: best } : undefined;
}

/**
 * Cut the half hours into fixed blocks of a week, laid out from `anchor`.
 *
 * Unlike the five-hour chain there is no gap to open a block on, so every boundary
 * is arithmetic from the one moment we might actually know: `anchor` is either a
 * reset Claude reported or, failing that, the moment of measurement. Only blocks
 * that hold usage are returned — a fortnight off leaves no empty weeks behind.
 */
function blockWindows(
  buckets: readonly UsageBucket[],
  anchor: number,
  anchored: boolean,
): UsageWindow[] {
  const blocks = new Map<number, UsageWindow>();

  for (const bucket of buckets) {
    const start = blockStart(bucket.at, anchor);
    let block = blocks.get(start);
    if (!block) {
      // Every edge here is Claude's own reset stepped by whole weeks, so when the
      // anchor came from a refusal, so did this.
      block = emptyWindow(start, start + WEEK_MS, anchored);
      blocks.set(start, block);
    }

    addBucket(block, bucket, bucket.weeklyLimited);
  }

  return [...blocks.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** A window with its edges settled and nothing in it yet. */
function emptyWindow(startedAt: number, resetsAt: number, resetsAtIsReported: boolean): UsageWindow {
  return {
    startedAt,
    resetsAt,
    resetsAtIsReported,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    turns: 0,
    limited: false,
  };
}

/**
 * Fold one half hour into a window.
 *
 * Which refusal marks a window limited is the caller's business — the same bucket
 * carries a five-hour flag and a weekly one, and each clock only answers for its own.
 */
function addBucket(window: UsageWindow, bucket: UsageBucket, limited: boolean): void {
  window.tokens.input += bucket.tokens.input;
  window.tokens.output += bucket.tokens.output;
  window.tokens.cacheRead += bucket.tokens.cacheRead;
  window.tokens.cacheCreate += bucket.tokens.cacheCreate;
  window.turns += bucket.turns;
  if (limited) window.limited = true;
}

/** Which week `at` falls in, counting in whole weeks from `anchor` in either direction. */
function blockStart(at: number, anchor: number): number {
  return anchor + Math.floor((at - anchor) / WEEK_MS) * WEEK_MS;
}

/**
 * The most recent all-models weekly reset Claude named on a turn it refused.
 *
 * The most recent rather than the first: the weekly clock can be moved — a plan
 * change, a promo week — and the latest thing Claude said about it is the closest
 * to true today.
 */
function refusedWeeklyReset(buckets: readonly UsageBucket[]): number | undefined {
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    const reset = buckets[index]?.weeklyResetsAt;
    if (reset !== undefined) return reset;
  }
  return undefined;
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
      open = emptyWindow(bucket.at, bucket.at + WINDOW_MS, false);
      windows.push(open);
    }

    addBucket(open, bucket, bucket.fiveHourLimited);
    // Claude told us when this one empties, which beats deriving it from a rounded
    // start. Later buckets are then chained against Claude's answer, not ours.
    if (bucket.fiveHourResetsAt !== undefined) {
      open.resetsAt = bucket.fiveHourResetsAt;
      open.resetsAtIsReported = true;
    }
  }

  return windows;
}
