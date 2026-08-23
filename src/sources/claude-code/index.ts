import { access } from 'node:fs/promises';
import type { TrackerConfig } from '../../config.ts';
import { FileCache } from '../../core/cache.ts';
import type {
  Session,
  SessionDetail,
  UsageHistory,
  UsageLimits,
  UsageProfile,
} from '../../core/types.ts';
import type { RecentQuery, RecentSessions, SessionSource, UsageQuery } from '../source.ts';
import { readDetail } from './detail.ts';
import { readUsageHistory } from './history.ts';
import type { FileUsage } from './buckets.ts';
import { readUsageLimits } from './limits.ts';
import { readUsageProfile } from './profile.ts';
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
   * One entry serves every reading of the sweep: both limit clocks, and the history
   * that asks the same half hours which project and which model they belonged to.
   */
  readonly #buckets = new FileCache<FileUsage>();

  /**
   * Project slug to the directory it was made from.
   *
   * Not a `FileCache`: there is no file to stamp it against. Decoding a slug is a
   * filesystem walk and the answer cannot change while the process runs — a project
   * that moves gets a new slug — so it is remembered outright.
   */
  readonly #projectPaths = new Map<string, string>();

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

  async usage(query: UsageQuery): Promise<UsageHistory> {
    return readUsageHistory(this.#config, this.#buckets, this.#projectPaths, query);
  }

  async profile(query: UsageQuery): Promise<UsageProfile> {
    return readUsageProfile(this.#config, this.#buckets, this.#projectPaths, query);
  }
}
