import type { TrackerConfig } from '../../config.ts';
import type { FileCache } from '../../core/cache.ts';
import type {
  SessionTokenTotals,
  UsageProfile,
  UsageProfileModel,
  UsageProfileSession,
} from '../../core/types.ts';
import type { UsageQuery } from '../source.ts';
import {
  billedTokens,
  readUsageFiles,
  type BilledFileUsage,
  type FileRollup,
  type FileUsage,
} from './buckets.ts';
import { projectNameFromPath, resolveSlugPath } from './slug.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a range with no `since` covers.
 *
 * A week, where the history page defaults to a month. The findings are about what
 * to do differently next, and a habit four weeks old is not evidence about this
 * afternoon — it is just an older habit, averaged in at the same weight.
 */
const DEFAULT_SPAN_MS = 7 * DAY_MS;

/** The widest range this will read. Matches what the history sweep will answer. */
const MAX_SPAN_MS = 90 * DAY_MS;

/**
 * What the spending in a stretch of history looked like, session by session.
 *
 * The third reading of the one sweep, beside the limit cards and the history page:
 * same files, same cache, a different grouping. Where history asks which project
 * and which hour, this asks which *session* — because every pattern worth reporting
 * is a pattern in how sessions were used, and a half hour cannot hold that.
 *
 * A session's subagents bill to it rather than standing on their own. They are
 * spawned by a turn in the session, counted against the same window, and a reader
 * looking at a heavy session wants the whole of what it cost, not the part that
 * happened to be written to the parent file.
 */
export async function readUsageProfile(
  config: TrackerConfig,
  cache: FileCache<FileUsage>,
  paths: Map<string, string>,
  query: UsageQuery = {},
  now: number = Date.now(),
): Promise<UsageProfile> {
  const range = resolveRange(query, now);
  const read = await readUsageFiles(config, cache, { since: range.since, until: range.until });

  const wanted =
    query.project === undefined ? read : read.filter(({ file }) => file.slug === query.project);

  const sessions = await rankSessions(inRange(wanted, range), paths);

  return { range, sessions, models: rankModels(wanted, range), generatedAt: now };
}

/**
 * The range actually read: the caller's, with the ends filled in and the span capped.
 *
 * `until` before `since` collapses to an empty range rather than being refused — it
 * is a date picker mid-edit, not a bad request, and an empty range reads as a panel
 * with nothing on it, which is exactly what it should be.
 */
function resolveRange(query: UsageQuery, now: number): { since: number; until: number } {
  const until = query.until ?? now;
  const since = query.since ?? until - DEFAULT_SPAN_MS;
  if (since >= until) return { since: until, until };
  return { since: Math.max(since, until - MAX_SPAN_MS), until };
}

/**
 * The files whose turns actually landed inside the range.
 *
 * `mtime` got the sweep down to a plausible set, which is all it can do: a resumed
 * transcript can be written today and hold nothing but records from last month. The
 * rollup carries when its first and last billed turn landed, so this is the filter
 * that means it.
 */
function inRange(
  read: readonly BilledFileUsage[],
  range: { since: number; until: number },
): BilledFileUsage[] {
  return read.filter(({ usage }) => {
    const { firstAt, lastAt } = usage.rollup;
    if (firstAt === undefined || lastAt === undefined) return false;
    return lastAt >= range.since && firstAt < range.until;
  });
}

/** One session's files: its own transcript, and its subagents'. */
interface SessionFiles {
  slug: string;
  own?: FileRollup;
  rollups: FileRollup[];
}

/**
 * Every session that billed in the range, heaviest first.
 *
 * A session with no transcript of its own is dropped rather than reported from its
 * subagents alone. The pair of windows is the whole point of a profile row, and only
 * the session's own file knows what it opened and closed holding — a subagent's
 * window is its own, and reading one as the parent's would say a session opened at a
 * size it never saw.
 */
async function rankSessions(
  read: readonly BilledFileUsage[],
  paths: Map<string, string>,
): Promise<UsageProfileSession[]> {
  const bySession = new Map<string, SessionFiles>();
  for (const { file, usage } of read) {
    const entry = bySession.get(usage.rollup.sessionId) ?? { slug: file.slug, rollups: [] };
    entry.rollups.push(usage.rollup);
    if (!usage.rollup.subagent) entry.own = usage.rollup;
    bySession.set(usage.rollup.sessionId, entry);
  }

  const sessions = await Promise.all(
    [...bySession.entries()].map(async ([id, entry]) => {
      const own = entry.own;
      if (!own?.first || !own.last) return undefined;

      const tokens: SessionTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      let turns = 0;
      for (const rollup of entry.rollups) {
        addTotals(tokens, rollup.tokens);
        turns += rollup.turns;
      }

      const path = await projectPath(entry.slug, paths);
      return {
        id,
        slug: entry.slug,
        project: projectNameFromPath(path),
        turns,
        opening: own.first,
        closingContext: contextOf(own.last),
        tokens,
      } satisfies UsageProfileSession;
    }),
  );

  return sessions
    .filter((session): session is UsageProfileSession => session !== undefined)
    .sort((a, b) => billedTokens(b.tokens) - billedTokens(a.tokens));
}

/**
 * Every model's share of the range, heaviest first.
 *
 * Taken from the buckets rather than from the sessions, because a session that ran
 * on two models is one row here and two there — and which model answered is a fact
 * about the turn, which is the grain a bucket keeps it at.
 */
function rankModels(
  read: readonly BilledFileUsage[],
  range: { since: number; until: number },
): UsageProfileModel[] {
  const byModel = new Map<string, UsageProfileModel>();

  for (const { usage } of read) {
    for (const bucket of usage.buckets) {
      if (bucket.at < range.since || bucket.at >= range.until) continue;

      for (const [model, share] of Object.entries(bucket.byModel)) {
        const entry = byModel.get(model) ?? {
          model,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
          turns: 0,
        };
        addTotals(entry.tokens, share.tokens);
        entry.turns += share.turns;
        byModel.set(model, entry);
      }
    }
  }

  return [...byModel.values()].sort((a, b) => billedTokens(b.tokens) - billedTokens(a.tokens));
}

async function projectPath(slug: string, paths: Map<string, string>): Promise<string> {
  const known = paths.get(slug);
  if (known !== undefined) return known;

  const path = await resolveSlugPath(slug);
  paths.set(slug, path);
  return path;
}

/** The window as one turn saw it: everything it was handed, cached or not. */
function contextOf(tokens: SessionTokenTotals): number {
  return tokens.input + tokens.cacheRead + tokens.cacheCreate;
}

function addTotals(into: SessionTokenTotals, from: SessionTokenTotals): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreate += from.cacheCreate;
}
