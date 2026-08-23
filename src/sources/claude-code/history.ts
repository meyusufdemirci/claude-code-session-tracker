import type { TrackerConfig } from '../../config.ts';
import type { FileCache } from '../../core/cache.ts';
import type {
  SessionTokenTotals,
  UsageHistory,
  UsageHistoryModel,
  UsageHistoryProject,
} from '../../core/types.ts';
import type { UsageQuery } from '../source.ts';
import {
  BUCKET_MS,
  billedTokens,
  mergeBuckets,
  readUsageBuckets,
  type FileUsage,
  type ProjectUsage,
  type UsageBucket,
} from './buckets.ts';
import { projectNameFromPath, resolveSlugPath } from './slug.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a range with no `since` covers. A month is what the question is usually about. */
const DEFAULT_SPAN_MS = 30 * DAY_MS;

/**
 * The widest range this will read.
 *
 * Not a limit of the arithmetic — the sweep would happily walk a year — but of what
 * can be answered while someone waits. Past three months the transcripts stop being
 * the handful still being appended to and the read stops being warm, so the range is
 * narrowed and `range` on the way back says so rather than the page pretending it
 * asked for what it got.
 */
const MAX_SPAN_MS = 90 * DAY_MS;

/**
 * Where the tokens went, over the same sweep the limit cards are measured from.
 *
 * The cards ask how full the window in progress is; this asks what the spend was
 * made of. One read of the transcripts answers both, and the cache is shared, so a
 * page open beside a warm dashboard costs a `stat` per file and some arithmetic.
 *
 * The one thing here that touches the disk again is turning a project slug back into
 * a directory, which is a filesystem walk. `paths` remembers those for the life of
 * the process: a project does not move while the page is open.
 */
export async function readUsageHistory(
  config: TrackerConfig,
  cache: FileCache<FileUsage>,
  paths: Map<string, string>,
  query: UsageQuery = {},
  now: number = Date.now(),
): Promise<UsageHistory> {
  const range = resolveRange(query, now);
  const projects = await readUsageBuckets(config, cache, range);

  // Narrowed for the series and the models, never for the project list itself: the
  // page draws its picker from that list, and a picker that loses every option but
  // the chosen one cannot be used to choose again.
  const selected =
    query.project === undefined
      ? projects
      : projects.filter((project) => project.slug === query.project);
  const buckets = mergeBuckets(selected);

  return {
    range,
    bucketMs: BUCKET_MS,
    buckets: buckets.map((bucket) => ({
      at: bucket.at,
      tokens: bucket.tokens,
      turns: bucket.turns,
      limited: bucket.fiveHourLimited || bucket.weeklyLimited,
    })),
    projects: await rankProjects(projects, paths),
    models: rankModels(buckets),
    // Echoed only when it actually named a project in the range. Asking for a slug
    // that billed nothing is an empty series, and saying so is the honest answer;
    // claiming the narrowing happened would make an empty page look like a quiet one.
    ...(query.project !== undefined && selected.length > 0 ? { project: query.project } : {}),
    generatedAt: now,
  };
}

/**
 * The range actually read: the caller's, with the ends filled in and the span capped.
 *
 * `until` before `since` is not an error to refuse — it is a date picker mid-edit —
 * so it collapses to an empty range, which reads as a page with nothing on it.
 */
function resolveRange(query: UsageQuery, now: number): { since: number; until: number } {
  const until = query.until ?? now;
  const since = query.since ?? until - DEFAULT_SPAN_MS;
  if (since >= until) return { since: until, until };
  return { since: Math.max(since, until - MAX_SPAN_MS), until };
}

/** Every project in the range, heaviest first, with a name to put on screen. */
async function rankProjects(
  projects: readonly ProjectUsage[],
  paths: Map<string, string>,
): Promise<UsageHistoryProject[]> {
  const ranked = await Promise.all(
    projects.map(async (project) => {
      const path = await projectPath(project.slug, paths);
      return {
        slug: project.slug,
        name: projectNameFromPath(path),
        path,
        ...totalOf(project.buckets),
      };
    }),
  );
  return ranked.sort(heaviestFirst);
}

async function projectPath(slug: string, paths: Map<string, string>): Promise<string> {
  const known = paths.get(slug);
  if (known !== undefined) return known;

  const path = await resolveSlugPath(slug);
  paths.set(slug, path);
  return path;
}

/** Every model that answered in the range, heaviest first. */
function rankModels(buckets: readonly UsageBucket[]): UsageHistoryModel[] {
  const totals = new Map<string, { tokens: SessionTokenTotals; turns: number }>();

  for (const bucket of buckets) {
    for (const [model, usage] of Object.entries(bucket.byModel)) {
      const existing = totals.get(model);
      if (!existing) {
        totals.set(model, { tokens: { ...usage.tokens }, turns: usage.turns });
        continue;
      }
      existing.tokens.input += usage.tokens.input;
      existing.tokens.output += usage.tokens.output;
      existing.tokens.cacheRead += usage.tokens.cacheRead;
      existing.tokens.cacheCreate += usage.tokens.cacheCreate;
      existing.turns += usage.turns;
    }
  }

  return [...totals.entries()]
    .map(([model, usage]) => ({ model, ...usage }))
    .sort(heaviestFirst);
}

function totalOf(buckets: readonly UsageBucket[]): { tokens: SessionTokenTotals; turns: number } {
  const tokens: SessionTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let turns = 0;

  for (const bucket of buckets) {
    tokens.input += bucket.tokens.input;
    tokens.output += bucket.tokens.output;
    tokens.cacheRead += bucket.tokens.cacheRead;
    tokens.cacheCreate += bucket.tokens.cacheCreate;
    turns += bucket.turns;
  }

  return { tokens, turns };
}

/**
 * Ranked by billed tokens, exactly as the limit cards size a window.
 *
 * Cache reads are the reason this is not a plain total: they outweigh everything
 * else fifty to one, so ranking on them would sort projects by how long their
 * conversations ran rather than by how much work went through them.
 */
function heaviestFirst(
  a: { tokens: SessionTokenTotals },
  b: { tokens: SessionTokenTotals },
): number {
  return billedTokens(b.tokens) - billedTokens(a.tokens);
}
