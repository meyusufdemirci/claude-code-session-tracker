import type { TrackerConfig } from '../config.ts';
import { ClaudeCodeSource } from '../sources/claude-code/index.ts';
import type { RecentSort, RecentWindow, SessionSource, UsageQuery } from '../sources/source.ts';
import { findUsage } from './advice.ts';
import type {
  Session,
  SessionDetail,
  UsageFindings,
  UsageHistory,
  UsageLimits,
} from './types.ts';

export interface SourceStatus {
  id: string;
  label: string;
  available: boolean;
}

export interface SessionListResult {
  sessions: Session[];
  sources: SourceStatus[];
  generatedAt: number;
  /** Sessions the sources know about, before `limit`. `sessions.length` is what was returned. */
  total: number;
}

/** What one listing asks for, on top of the window and ordering the sources take. */
export interface SessionListQuery extends RecentWindow {
  limit?: number;
  sort?: RecentSort;
}

const DEFAULT_LIMIT = 50;
/** A ceiling so one request can never ask us to open an unbounded number of files. */
const MAX_LIMIT = 2_000;

/** Newest first — what a list of sessions means with no further instruction. */
const byRecency = (a: Session, b: Session): number => b.lastActiveAt - a.lastActiveAt;

/**
 * The same total the token column shows — input plus output, cache reads and writes
 * left out — so the number on screen and the order it is in can never disagree.
 */
function totalTokens(session: Session): number {
  return session.tokens ? session.tokens.input + session.tokens.output : 0;
}

/** Recency breaks a token tie, so the many sessions that billed nothing hold still. */
const ORDERS: Record<RecentSort, (a: Session, b: Session) => number> = {
  recent: byRecency,
  'tokens-desc': (a, b) => totalTokens(b) - totalTokens(a) || byRecency(a, b),
  'tokens-asc': (a, b) => totalTokens(a) - totalTokens(b) || byRecency(a, b),
};

/**
 * Merges every registered source into one list.
 *
 * A live record always wins over a transcript record for the same session id: the
 * live registry knows the current status and pid, the transcript only knows history.
 * The merge keeps both halves — status and branch from the process, title and
 * prompts from the file.
 */
export class SessionRegistry {
  private readonly sources: SessionSource[];

  constructor(config: TrackerConfig, sources?: SessionSource[]) {
    this.sources = sources ?? [new ClaudeCodeSource(config)];
  }

  async statuses(): Promise<SourceStatus[]> {
    return Promise.all(
      this.sources.map(async (source) => ({
        id: source.id,
        label: source.label,
        available: await source.isAvailable(),
      })),
    );
  }

  async list(options: SessionListQuery = {}): Promise<SessionListResult> {
    const limit = clampLimit(options.limit);
    const sort = options.sort ?? 'recent';
    const sources = await this.statuses();
    const available = this.sources.filter(
      (source) => sources.find((s) => s.id === source.id)?.available,
    );

    const merged = new Map<string, Session>();
    let total = 0;

    // Live first, but only to learn which ids exist: each source is then asked to
    // resolve those transcripts whatever the limit, so no running session is left
    // without its title. The history is laid down before the live records so the
    // live half — status, pid, current branch — is what survives the merge.
    const running = new Map<string, Session[]>();
    for (const source of available) running.set(source.id, await source.listLive());

    for (const source of available) {
      const include = running.get(source.id)?.map((session) => session.id);
      const recent = await source.listRecent({
        limit,
        sort,
        include,
        since: options.since,
        until: options.until,
      });
      total += recent.total;
      for (const session of recent.sessions) merged.set(session.id, session);
    }
    for (const sessions of running.values()) {
      for (const session of sessions) {
        const previous = merged.get(session.id);
        merged.set(session.id, previous ? { ...previous, ...session } : session);
      }
    }

    const all = [...merged.values()];
    // Running sessions are the point of the tool, so neither `limit` nor the window
    // touches them — both bound the history underneath, and both are asked for in
    // order to read that history, not to lose sight of what is running. A session
    // started seconds ago has no transcript on disk yet, which would otherwise sort
    // it below month-old ones, and `sort` is about the same history, so the live
    // half stays newest-first however the rest is ranked.
    const live = all.filter((session) => session.live).sort(byRecency);
    // The sources hand back everything in the window when the ordering needs reading
    // to settle, so this is the first point that can rank across all of them at once.
    const ended = all.filter((session) => !session.live).sort(ORDERS[sort]);

    return {
      sessions: [...live, ...ended.slice(0, Math.max(0, limit - live.length))],
      sources,
      generatedAt: Date.now(),
      // What the sources counted is the transcripts inside the window. A running
      // session is listed whatever the window says, so the ones that count did not
      // already cover — a transcript outside the window, or a session so new it has
      // yet to flush a first line — are added on top rather than folded in. Counting
      // them here rather than off the merged map is what keeps the total a property
      // of the window alone: a token ordering reads far more transcripts than a
      // limit's worth, and that must not show up as a bigger number.
      total: total + live.filter((session) => !counted(session, options)).length,
    };
  }

  /**
   * Usage against the rate-limit windows, from the first source that can measure them.
   *
   * Not merged across sources, unlike the listings. A limit belongs to whoever bills
   * the requests, so two sources reporting one would be two different limits — adding
   * them would describe neither. The first available source that implements it owns
   * the answer; `null` means nobody does.
   */
  async limits(): Promise<UsageLimits | null> {
    for (const source of this.sources) {
      if (!source.limits) continue;
      if (!(await source.isAvailable())) continue;
      return source.limits();
    }
    return null;
  }

  /**
   * Where the tokens went, from the first source that can say.
   *
   * The same rule as `limits`, for the same reason: usage is billed to whoever bills
   * the requests, so two sources answering would be two different histories. `null`
   * means nobody can, and the page leaves the section off rather than showing a
   * range with nothing in it.
   */
  async usage(query: UsageQuery): Promise<UsageHistory | null> {
    for (const source of this.sources) {
      if (!source.usage) continue;
      if (!(await source.isAvailable())) continue;
      return source.usage(query);
    }
    return null;
  }

  /**
   * What is worth saying about a stretch of spend.
   *
   * The one place a source's measurements are turned into findings, and deliberately
   * above the seam: what counts as a session worth mentioning is an argument about
   * how people use these tools, not about how one CLI stores its transcripts. A
   * second source would hand over a profile of its own and get the same rules
   * applied to it, or implement no profile and simply leave the panel off.
   */
  async advice(query: UsageQuery): Promise<UsageFindings | null> {
    for (const source of this.sources) {
      if (!source.profile) continue;
      if (!(await source.isAvailable())) continue;
      return findUsage(await source.profile(query));
    }
    return null;
  }

  /**
   * One session, read in full.
   *
   * The same merge rule as `list()`: the transcript supplies the history and the
   * totals, the live registry overrides status, pid and current branch — so a panel
   * open on a running session says `busy`, not `ended`.
   */
  async detail(id: string): Promise<SessionDetail | null> {
    for (const source of this.sources) {
      if (!(await source.isAvailable())) continue;

      const detail = await source.detail(id);
      if (!detail) continue;

      const live = (await source.listLive()).find((session) => session.id === id);
      return live ? { ...detail, ...live } : detail;
    }
    return null;
  }
}

/**
 * Whether the sources' own count already covers this session.
 *
 * They count transcripts in the window, so a live session is in that count when it
 * has one and it was last written inside the window. `lastActiveAt` stands in for
 * the file's mtime here; for a session that is still running the two are the same
 * moment to within a flush.
 */
function counted(session: Session, { since, until }: RecentWindow): boolean {
  if (session.transcriptPath === undefined) return false;
  if (since !== undefined && session.lastActiveAt < since) return false;
  if (until !== undefined && session.lastActiveAt >= until) return false;
  return true;
}

/** An unrecognised `sort` is a typo in a query string, not a reason to fail a request. */
export function parseSort(raw: string | null | undefined): RecentSort {
  return raw !== null && raw !== undefined && Object.hasOwn(ORDERS, raw)
    ? (raw as RecentSort)
    : 'recent';
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}
