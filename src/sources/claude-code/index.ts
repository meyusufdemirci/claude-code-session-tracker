import { access } from 'node:fs/promises';
import type { TrackerConfig } from '../../config.ts';
import type { Session, SessionDetail } from '../../core/types.ts';
import type { SessionSource } from '../source.ts';
import { listLiveSessions } from './live.ts';

/**
 * Reads sessions out of `~/.claude`.
 *
 * `live.ts` covers the running sessions. `transcripts.ts` (Phase 2) will fill in
 * the finished ones behind this same interface.
 */
export class ClaudeCodeSource implements SessionSource {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';

  readonly #config: TrackerConfig;

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

  async listRecent(_options: { limit: number }): Promise<Session[]> {
    return [];
  }

  async detail(_id: string): Promise<SessionDetail | null> {
    return null;
  }
}
