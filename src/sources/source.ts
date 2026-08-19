import type { Session, SessionDetail } from '../core/types.ts';

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
  listRecent(options: { limit: number }): Promise<Session[]>;

  /** Full stats for one session. Expensive, so only ever called on demand. */
  detail(id: string): Promise<SessionDetail | null>;
}
