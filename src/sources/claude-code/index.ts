import { access } from 'node:fs/promises';
import type { TrackerConfig } from '../../config.ts';
import { FileCache } from '../../core/cache.ts';
import type { Session, SessionDetail } from '../../core/types.ts';
import type { RecentSessions, SessionSource } from '../source.ts';
import { listLiveSessions } from './live.ts';
import { listRecentSessions } from './transcripts.ts';

/**
 * Reads sessions out of `~/.claude`.
 *
 * `live.ts` covers the running sessions, `transcripts.ts` the finished ones. The
 * cache lives here rather than inside either, so it survives across requests: a
 * transcript that has not been appended to since the last poll is never re-read.
 */
export class ClaudeCodeSource implements SessionSource {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';

  readonly #config: TrackerConfig;
  readonly #transcripts = new FileCache<Session>();

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

  async listRecent(options: {
    limit: number;
    include?: readonly string[];
  }): Promise<RecentSessions> {
    return listRecentSessions(this.#config, options, this.#transcripts);
  }

  async detail(_id: string): Promise<SessionDetail | null> {
    return null;
  }
}
