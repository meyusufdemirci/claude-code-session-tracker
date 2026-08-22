import type { Session, SessionDetail, UsageLimits } from '../../src/core/types.ts';
import type { RecentQuery, RecentSessions, SessionSource } from '../../src/sources/source.ts';

/**
 * A source that answers from arrays instead of a disk.
 *
 * The registry's job is merging and ordering, which has nothing to do with Claude
 * Code — so testing it through a fake is also the test of whether `SessionSource`
 * is really the seam it claims to be. Anything the registry needs that this fake
 * cannot provide would be a leak of Claude Code's shape into `core/`.
 */
export interface FakeSourceOptions {
  id?: string;
  label?: string;
  available?: boolean;
  live?: Session[];
  recent?: Session[];
  details?: Record<string, SessionDetail>;
  /** Left out entirely to model a source that cannot measure a rate-limit window. */
  limits?: UsageLimits;
}

export class FakeSource implements SessionSource {
  readonly id: string;
  readonly label: string;
  /** Every `listRecent` call this source received, in order. */
  readonly queries: RecentQuery[] = [];

  readonly #available: boolean;
  readonly #live: Session[];
  readonly #recent: Session[];
  readonly #details: Record<string, SessionDetail>;

  constructor(options: FakeSourceOptions = {}) {
    this.id = options.id ?? 'fake';
    this.label = options.label ?? 'Fake';
    this.#available = options.available ?? true;
    this.#live = options.live ?? [];
    this.#recent = options.recent ?? [];
    this.#details = options.details ?? {};
    // Assigned rather than declared, because `limits` is optional on the interface
    // and a source that leaves it off is the case the registry has to handle.
    if (options.limits) {
      const limits = options.limits;
      this.limits = async (): Promise<UsageLimits> => limits;
    }
  }

  limits?: () => Promise<UsageLimits>;

  async isAvailable(): Promise<boolean> {
    return this.#available;
  }

  async listLive(): Promise<Session[]> {
    return this.#live;
  }

  async listRecent(query: RecentQuery): Promise<RecentSessions> {
    this.queries.push(query);
    // Mirrors a real source: the window and the limit bound the history, and the
    // named ids come back whatever those say.
    const inWindow = this.#recent.filter(
      (session) =>
        (query.since === undefined || session.lastActiveAt >= query.since) &&
        (query.until === undefined || session.lastActiveAt < query.until),
    );
    const named = new Set(query.include ?? []);
    const chosen = inWindow.slice(0, query.limit);
    for (const session of this.#recent) {
      if (named.has(session.id) && !chosen.includes(session)) chosen.push(session);
    }
    return { sessions: chosen, total: inWindow.length };
  }

  async detail(id: string): Promise<SessionDetail | null> {
    return this.#details[id] ?? null;
  }
}

/** A finished session, with only the fields a test cares about spelled out. */
export function endedSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    source: 'fake',
    status: 'ended',
    project: { name: 'app', path: '/Users/y/Work/app', slug: '-Users-y-Work-app' },
    startedAt: 1_000,
    lastActiveAt: 1_000,
    transcriptPath: `/transcripts/${id}.jsonl`,
    ...overrides,
  };
}

/** A running session: the same, plus the `live` block that marks it as such. */
export function liveSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    ...endedSession(id),
    status: 'busy',
    live: { pid: 1234 },
    ...overrides,
  };
}
