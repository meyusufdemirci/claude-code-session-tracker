import type { Session, SessionDetail } from '../core/types.ts';

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
}
