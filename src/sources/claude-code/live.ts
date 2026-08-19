import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TrackerConfig } from '../../config.ts';
import type { Session, SessionStatus } from '../../core/types.ts';
import { readGitBranch } from './git.ts';
import { filterAlive } from './liveness.ts';
import { pathToSlug, projectNameFromPath } from './slug.ts';

/** `<pid>.json`. The directory also holds `<pid>.<hash>.key` files, which are not ours to read. */
const SESSION_FILE = /^(\d+)\.json$/;

const KNOWN_STATUSES = new Set<SessionStatus>(['busy', 'waiting', 'idle']);

/**
 * One record Claude Code writes per running session. Everything is optional
 * because the format is private and undocumented — fields will come and go, and
 * a missing one must never take the whole listing down.
 */
interface LiveRecord {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
  procStart?: unknown;
  version?: unknown;
  kind?: unknown;
  entrypoint?: unknown;
  messagingSocketPath?: unknown;
  name?: unknown;
  status?: unknown;
  waitingFor?: unknown;
  updatedAt?: unknown;
  statusUpdatedAt?: unknown;
}

/**
 * Every Claude Code session running on this machine right now.
 *
 * The files in `~/.claude/sessions` are the source of truth for *status*, but not
 * for *existence*: they outlive the processes that wrote them, so each one is
 * checked against a real process before it becomes a row (see `liveness.ts`).
 */
export async function listLiveSessions(config: TrackerConfig): Promise<Session[]> {
  const running = dedupe(await filterAlive(await readSessionFiles(config.sessionsDir)));

  // Sessions frequently share a working directory; read each repo's HEAD once.
  const branches = new Map<string, Promise<string | undefined>>();
  const branchOf = (cwd: string): Promise<string | undefined> => {
    let pending = branches.get(cwd);
    if (!pending) {
      pending = readGitBranch(cwd);
      branches.set(cwd, pending);
    }
    return pending;
  };

  const sessions = await Promise.all(
    running.map(async (record) => toSession(record, await branchOf(record.cwd))),
  );

  return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/** A session record we have validated enough to trust. */
interface ParsedRecord {
  id: string;
  pid: number;
  cwd: string;
  procStart: string | undefined;
  startedAt: number;
  lastActiveAt: number;
  status: SessionStatus;
  waitingFor: string | undefined;
  name: string | undefined;
  version: string | undefined;
  kind: string | undefined;
  entrypoint: string | undefined;
  socketPath: string | undefined;
}

async function readSessionFiles(dir: string): Promise<ParsedRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // No sessions directory means no running sessions — not an error.
    return [];
  }

  const parsed = await Promise.all(
    names.map(async (name) => {
      const match = SESSION_FILE.exec(name);
      if (!match?.[1]) return null;
      return parseRecord(await readJson(join(dir, name)), Number.parseInt(match[1], 10));
    }),
  );

  return parsed.filter((record): record is ParsedRecord => record !== null);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // Half-written or malformed: skip this file, keep the rest of the listing.
    return null;
  }
}

function parseRecord(value: unknown, pidFromName: number): ParsedRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as LiveRecord;

  const id = str(record.sessionId);
  const cwd = str(record.cwd);
  if (!id || !cwd) return null;

  // The filename is the pid; the field inside should agree, and wins if it does not.
  const pid = num(record.pid) ?? pidFromName;
  if (!Number.isInteger(pid)) return null;

  const startedAt = num(record.startedAt) ?? 0;
  const updatedAt = num(record.updatedAt) ?? num(record.statusUpdatedAt) ?? startedAt;

  return {
    id,
    pid,
    cwd,
    procStart: str(record.procStart),
    startedAt,
    lastActiveAt: Math.max(updatedAt, startedAt),
    status: toStatus(record.status),
    waitingFor: str(record.waitingFor),
    name: str(record.name),
    version: str(record.version),
    kind: str(record.kind),
    entrypoint: str(record.entrypoint),
    socketPath: str(record.messagingSocketPath),
  };
}

/**
 * One session id can appear under two pids — resuming a session leaves the old
 * file behind. Keep whichever was touched last. Runs after the liveness filter,
 * so a stale record can never displace the one that is actually running.
 */
function dedupe(records: ParsedRecord[]): ParsedRecord[] {
  const newest = new Map<string, ParsedRecord>();
  for (const record of records) {
    const existing = newest.get(record.id);
    if (!existing || record.lastActiveAt > existing.lastActiveAt) newest.set(record.id, record);
  }
  return [...newest.values()];
}

function toSession(record: ParsedRecord, gitBranch: string | undefined): Session {
  const session: Session = {
    id: record.id,
    source: 'claude-code',
    status: record.status,
    project: {
      name: projectNameFromPath(record.cwd),
      path: record.cwd,
      slug: pathToSlug(record.cwd),
      ...(gitBranch ? { gitBranch } : {}),
    },
    startedAt: record.startedAt,
    lastActiveAt: record.lastActiveAt,
    live: {
      pid: record.pid,
      ...(record.procStart ? { procStart: record.procStart } : {}),
      ...(record.kind ? { kind: record.kind } : {}),
      ...(record.entrypoint ? { entrypoint: record.entrypoint } : {}),
      ...(record.socketPath ? { socketPath: record.socketPath } : {}),
    },
  };

  if (record.waitingFor) session.waitingFor = record.waitingFor;
  if (record.name) session.name = record.name;
  if (record.version) session.version = record.version;

  return session;
}

function toStatus(value: unknown): SessionStatus {
  const status = str(value);
  // An unfamiliar status is still a running session; `idle` is the safe reading.
  return status && KNOWN_STATUSES.has(status as SessionStatus) ? (status as SessionStatus) : 'idle';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
