import type { TrackerConfig } from '../config.ts';
import { ClaudeCodeSource } from '../sources/claude-code/index.ts';
import type { SessionSource } from '../sources/source.ts';
import type { Session, SessionDetail } from './types.ts';

export interface SourceStatus {
  id: string;
  label: string;
  available: boolean;
}

export interface SessionListResult {
  sessions: Session[];
  sources: SourceStatus[];
  generatedAt: number;
}

const DEFAULT_LIMIT = 50;

/**
 * Merges every registered source into one list.
 *
 * A live record always wins over a transcript record for the same session id:
 * the live registry knows the current status, the transcript only knows history.
 */
export class SessionRegistry {
  private readonly sources: SessionSource[];

  constructor(config: TrackerConfig, sources?: SessionSource[]) {
    this.sources = sources ?? [new ClaudeCodeSource(config)];
  }

  async statuses(): Promise<SourceStatus[]> {
    return Promise.all(
      this.sources.map(async (source) => ({
        id: source.id,
        label: source.label,
        available: await source.isAvailable(),
      })),
    );
  }

  async list(options: { limit?: number } = {}): Promise<SessionListResult> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const sources = await this.statuses();
    const available = this.sources.filter(
      (source) => sources.find((s) => s.id === source.id)?.available,
    );

    const merged = new Map<string, Session>();

    // Recent first, so live records overwrite them on id collision.
    for (const source of available) {
      for (const session of await source.listRecent({ limit })) {
        merged.set(session.id, session);
      }
    }
    for (const source of available) {
      for (const session of await source.listLive()) {
        const previous = merged.get(session.id);
        merged.set(session.id, previous ? { ...previous, ...session } : session);
      }
    }

    const sessions = [...merged.values()]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, limit);

    return { sessions, sources, generatedAt: Date.now() };
  }

  async detail(id: string): Promise<SessionDetail | null> {
    for (const source of this.sources) {
      if (!(await source.isAvailable())) continue;
      const detail = await source.detail(id);
      if (detail) return detail;
    }
    return null;
  }
}
