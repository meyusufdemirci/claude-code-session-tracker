import type { TrackerConfig } from '../../config.ts';
import type { FileCache } from '../../core/cache.ts';
import type {
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
import { readWeeklyReset } from './quota.ts';

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
  // The one date on this machine that says where the weekly clock falls. Read
  // alongside the transcripts because it answers what they cannot.
  const weeklyReset = await readWeeklyReset(config.claudeJsonPath);

  return {
    session: measureFiveHour(buckets, now),
    weekly: measureWeekly(buckets, now, weeklyReset),
    generatedAt: now,
  };
}

/**
 * The five-hour limit, from the last week of half hours.
 *
 * Deliberately narrower than the sweep that fed it: the yardstick is the heaviest
 * window of the last seven days, and handing it four weeks would quietly change
 * what the number on the page is a share of.
 */
function measureFiveHour(buckets: readonly UsageBucket[], now: number): UsageLimit {
  const since = now - HISTORY_DAYS * DAY_MS;
  const windows = chainWindows(buckets.filter((bucket) => bucket.at >= since));
  const last = windows.at(-1);
  const current = last && last.resetsAt > now ? last : undefined;

  return {
    windowMs: WINDOW_MS,
    clock: 'chained',
    historyDays: HISTORY_DAYS,
    ...summarize(windows, current, now),
  };
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
  cachedReset?: number,
): UsageLimit {
  const reported = cachedReset ?? refusedWeeklyReset(buckets);
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
    ...summarize(windows, current, now),
  };
}

/** The window in progress, the yardstick, and the last refusal — the three every limit reports. */
function summarize(
  windows: readonly UsageWindow[],
  current: UsageWindow | undefined,
  now: number,
): Pick<UsageLimit, 'current' | 'reference' | 'lastLimited'> {
  // Last, not heaviest: a refusal is only evidence of where the ceiling was at the
  // time, and the most recent one is the closest that evidence gets to today.
  const lastLimited = windows.filter((window) => window.limited).at(-1);

  return {
    ...(current ? { current } : {}),
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
      block = {
        startedAt: start,
        resetsAt: start + WEEK_MS,
        // Every edge here is Claude's own reset stepped by whole weeks, so when the
        // anchor came from a refusal, so did this.
        resetsAtIsReported: anchored,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        turns: 0,
        limited: false,
      };
      blocks.set(start, block);
    }

    block.tokens.input += bucket.tokens.input;
    block.tokens.output += bucket.tokens.output;
    block.tokens.cacheRead += bucket.tokens.cacheRead;
    block.tokens.cacheCreate += bucket.tokens.cacheCreate;
    block.turns += bucket.turns;
    if (bucket.weeklyLimited) block.limited = true;
  }

  return [...blocks.values()].sort((a, b) => a.startedAt - b.startedAt);
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
    if (bucket.fiveHourLimited) open.limited = true;
    // Claude told us when this one empties, which beats deriving it from a rounded
    // start. Later buckets are then chained against Claude's answer, not ours.
    if (bucket.fiveHourResetsAt !== undefined) {
      open.resetsAt = bucket.fiveHourResetsAt;
      open.resetsAtIsReported = true;
    }
  }

  return windows;
}
