import type { Session, SessionDetail } from '../core/types.ts';

export interface RecentSessions {
  sessions: Session[];
  /** How many the source could have returned, before `limit`. Lets the UI say "50 of 790". */
  total: number;
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

  /**
   * Recently finished sessions, newest first. Cached; never reads whole transcripts.
   *
   * `include` names sessions that must be resolved even if they fall outside
   * `limit` — the registry uses it so a long-idle live session still gets its
   * title and prompt, rather than showing as a bare row.
   */
  listRecent(options: { limit: number; include?: readonly string[] }): Promise<RecentSessions>;

  /** Full stats for one session. Expensive, so only ever called on demand. */
  detail(id: string): Promise<SessionDetail | null>;
}
