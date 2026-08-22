import { access } from 'node:fs/promises';
import type { TrackerConfig } from '../../config.ts';
import { FileCache } from '../../core/cache.ts';
import type { Session, SessionDetail, UsageLimits } from '../../core/types.ts';
import type { RecentQuery, RecentSessions, SessionSource } from '../source.ts';
import { readDetail } from './detail.ts';
import { readUsageLimits, type UsageBucket } from './limits.ts';
import { listLiveSessions } from './live.ts';
import { listRecentSessions } from './transcripts.ts';

/**
 * Reads sessions out of `~/.claude`.
 *
 * `live.ts` covers the running sessions, `transcripts.ts` the finished ones, and
 * `detail.ts` the one session someone asked to look at. The caches live here rather
 * than inside any of them, so they survive across requests: a transcript that has
 * not been appended to since the last poll is never re-read.
 */
export class ClaudeCodeSource implements SessionSource {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';

  readonly #config: TrackerConfig;
  readonly #transcripts = new FileCache<Session>();
  /**
   * Full reads are far more expensive and far rarer than listings, so this holds
   * fewer of them — enough that reopening a panel is free, not enough to keep a
   * morning's browsing resident.
   */
  readonly #details = new FileCache<SessionDetail>(64);
  /**
   * Half-hour usage buckets, one entry per transcript.
   *
   * Separate from `#transcripts` because it answers a different question about the
   * same files — when the tokens were billed, not how many in total — and because it
   * covers subagent transcripts too, which are not sessions and so never appear there.
   */
  readonly #buckets = new FileCache<UsageBucket[]>();

  constructor(config: TrackerConfig) {
    this.#config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await access(this.#config.claudeDir);
      return true;
    } catch {
      return false;
    }
  }

  async listLive(): Promise<Session[]> {
    return listLiveSessions(this.#config);
  }

  async listRecent(options: RecentQuery): Promise<RecentSessions> {
    return listRecentSessions(this.#config, options, this.#transcripts);
  }

  async detail(id: string): Promise<SessionDetail | null> {
    return readDetail(this.#config, id, this.#transcripts, this.#details);
  }

  async limits(): Promise<UsageLimits> {
    return readUsageLimits(this.#config, this.#buckets);
  }
}
