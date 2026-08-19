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
  /** Sessions the sources know about, before `limit`. `sessions.length` is what was returned. */
  total: number;
}

const DEFAULT_LIMIT = 50;
/** A ceiling so one request can never ask us to open an unbounded number of files. */
const MAX_LIMIT = 2_000;

/**
 * Merges every registered source into one list.
 *
 * A live record always wins over a transcript record for the same session id: the
 * live registry knows the current status and pid, the transcript only knows history.
 * The merge keeps both halves — status and branch from the process, title and
 * prompts from the file.
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
    const limit = clampLimit(options.limit);
    const sources = await this.statuses();
    const available = this.sources.filter(
      (source) => sources.find((s) => s.id === source.id)?.available,
    );

    const merged = new Map<string, Session>();
    let total = 0;

    // Live first, but only to learn which ids exist: each source is then asked to
    // resolve those transcripts whatever the limit, so no running session is left
    // without its title. The history is laid down before the live records so the
    // live half — status, pid, current branch — is what survives the merge.
    const running = new Map<string, Session[]>();
    for (const source of available) running.set(source.id, await source.listLive());

    for (const source of available) {
      const include = running.get(source.id)?.map((session) => session.id);
      const recent = await source.listRecent({ limit, include });
      total += recent.total;
      for (const session of recent.sessions) merged.set(session.id, session);
    }
    for (const sessions of running.values()) {
      for (const session of sessions) {
        const previous = merged.get(session.id);
        merged.set(session.id, previous ? { ...previous, ...session } : session);
      }
    }

    const byRecency = (a: Session, b: Session): number => b.lastActiveAt - a.lastActiveAt;
    const all = [...merged.values()];
    // Running sessions are the point of the tool, so `limit` never truncates them —
    // it bounds the history underneath. A session started seconds ago has no
    // transcript on disk yet, which would otherwise sort it below month-old ones.
    const live = all.filter((session) => session.live).sort(byRecency);
    const ended = all.filter((session) => !session.live).sort(byRecency);

    return {
      sessions: [...live, ...ended.slice(0, Math.max(0, limit - live.length))],
      sources,
      generatedAt: Date.now(),
      // A live session almost always has a transcript and is already counted; the
      // max covers the seconds before its first line is flushed.
      total: Math.max(total, merged.size),
    };
  }

  /**
   * One session, read in full.
   *
   * The same merge rule as `list()`: the transcript supplies the history and the
   * totals, the live registry overrides status, pid and current branch — so a panel
   * open on a running session says `busy`, not `ended`.
   */
  async detail(id: string): Promise<SessionDetail | null> {
    for (const source of this.sources) {
      if (!(await source.isAvailable())) continue;

      const detail = await source.detail(id);
      if (!detail) continue;

      const live = (await source.listLive()).find((session) => session.id === id);
      return live ? { ...detail, ...live } : detail;
    }
    return null;
  }
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}
