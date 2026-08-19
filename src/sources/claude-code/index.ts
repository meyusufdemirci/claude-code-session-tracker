import { access } from 'node:fs/promises';
import type { TrackerConfig } from '../../config.ts';
import type { Session, SessionDetail } from '../../core/types.ts';
import type { SessionSource } from '../source.ts';

/**
 * Reads sessions out of `~/.claude`.
 *
 * Phase 0 wires the source up and reports availability. `live.ts` (Phase 1) and
 * `transcripts.ts` (Phase 2) fill in the listings behind this same interface.
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
    return [];
  }

  async listRecent(_options: { limit: number }): Promise<Session[]> {
    return [];
  }

  async detail(_id: string): Promise<SessionDetail | null> {
    return null;
  }
}
