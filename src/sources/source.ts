import type { Session, SessionDetail, UsageHistory, UsageLimits } from '../core/types.ts';

export interface RecentSessions {
  sessions: Session[];
  /** How many the source could have returned, before `limit`. Lets the UI say "50 of 790". */
  total: number;
}

/**
 * How finished sessions are ordered.
 *
 * `recent` is free: a `stat` per file already knows it, so only the rows that will
 * be shown are ever opened. The token orders are not — the totals live inside the
 * transcripts, so asking for one makes the source read the whole window before it
 * can rank it.
 */
export type RecentSort = 'recent' | 'tokens-desc' | 'tokens-asc';

/** The stretch of time a listing covers, in epoch milliseconds. Open at either end. */
export interface RecentWindow {
  /** Inclusive, so a session last written exactly at `since` is in. */
  since?: number;
  /** Exclusive, so two back-to-back windows never both claim the same session. */
  until?: number;
}

export interface RecentQuery extends RecentWindow {
  limit: number;
  /**
   * Sessions that must be resolved even when they fall outside `limit` or the
   * window — the registry passes the running ones, so a long-idle live session
   * still gets its title rather than showing as a bare row.
   */
  include?: readonly string[];
  sort?: RecentSort;
}

/**
 * What stretch of history to read, and whose.
 *
 * Both ends are optional and both are the caller's: a source fills in its own
 * defaults and is free to narrow what it was asked for — which is why `UsageHistory`
 * reports the range it actually read rather than assuming this one.
 */
export interface UsageQuery {
  /** Inclusive. Left off, the source picks its own default depth. */
  since?: number;
  /** Exclusive. Left off, the range runs to now. */
  until?: number;
  /** Narrow the series to one project, by the slug the source itself reported. */
  project?: string;
}

/**
 * The single seam the whole tool hangs off.
 *
 * Everything that knows how one agent CLI stores its sessions lives behind this
 * interface. Supporting another CLI later means adding a folder next to
 * `claude-code/` — nothing above this line changes.
 */
export interface SessionSource {
  readonly id: string;
  readonly label: string;

  /** Cheap check: is this source's data present on the machine at all? */
  isAvailable(): Promise<boolean>;

  /** Currently running sessions. Cheap enough to call on every poll. */
  listLive(): Promise<Session[]>;

  /** Recently finished sessions, newest first. Cached; never reads whole transcripts. */
  listRecent(options: RecentQuery): Promise<RecentSessions>;

  /** Full stats for one session. Expensive, so only ever called on demand. */
  detail(id: string): Promise<SessionDetail | null>;

  /**
   * Usage against this CLI's own rate-limit windows.
   *
   * Optional, unlike the four above: a limit is a property of whoever bills the
   * requests, and another CLI may not have one, may not leave enough on disk to
   * measure it, or may simply be able to ask its own server. A source that does
   * not implement this is not broken — the page just leaves the cards off.
   */
  limits?(): Promise<UsageLimits>;

  /**
   * Where this CLI's tokens went over a stretch of history.
   *
   * Optional for the same reason `limits` is, and true of the same sources: it is a
   * claim about billing, and a CLI that leaves no usage on disk cannot make one. A
   * source that implements `limits` can almost always implement this too — they are
   * two readings of one sweep — but nothing here requires it.
   */
  usage?(query: UsageQuery): Promise<UsageHistory>;
}
