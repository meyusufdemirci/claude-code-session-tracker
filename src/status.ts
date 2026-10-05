import { parseArgs } from 'node:util';
import { createConfig, DEFAULT_HOST, DEFAULT_PORT } from './config.ts';
import { SessionRegistry } from './core/registry.ts';
import type { SessionListResult } from './core/registry.ts';
import type { Session, SessionTokenTotals, UsageHistory, UsageLimit, UsageLimits } from './core/types.ts';
import { VERSION } from './version.ts';

/**
 * The tracker in a dozen lines of text, for a terminal rather than a browser.
 *
 * This is what the Claude Code plugin's `/session-tracker:status` prints, so it is written
 * to be read as it stands: the two limits, what is running, what today cost, and
 * where the page is. A tracker that is already running is asked, because it has the
 * sweep warm; when none is, the same numbers are read straight off the disk, the
 * way `--json` reads them, so nothing has to be started to get an answer.
 *
 * It never fails for want of data. A machine with no sessions, no limits and no
 * tracker still gets a summary that says so, because whatever runs this inline
 * drops the whole reply when the command exits non-zero.
 */

/** The CLI steps forward up to 20 times when its port is taken, so a tracker is somewhere in here. */
export const PORTS: readonly number[] = Array.from({ length: 21 }, (_, step) => DEFAULT_PORT + step);

/** How many running sessions are listed before the rest are only counted. */
const MAX_LISTED = 8;
const TITLE_WIDTH = 60;

/** A tracker that answered, and what it said about itself. */
export interface Running {
  port: number;
  url: string;
  version: string;
  /** The Claude directory it reads, which need not be the one this command was pointed at. */
  claudeDir: string;
}

/** What the summary is written from, wherever it was read. */
export interface Snapshot {
  limits: UsageLimits | null;
  /** Sessions whose process is alive, most recently active first. */
  running: Session[];
  /** Billed since local midnight. Null when no source can say. */
  today: { tokens: number; turns: number } | null;
}

/**
 * The tracker answering on the lowest port in the range, or undefined when none is.
 *
 * Every port is asked at once: a closed loopback port refuses at once, and the
 * timeout is only there for something else that holds one open and says nothing.
 */
export async function findTracker(env: Pick<Env, 'fetch' | 'ports'>): Promise<Running | undefined> {
  const answers = await Promise.all(env.ports.map((port) => health(env.fetch, port)));
  return answers.find((answer) => answer !== undefined);
}

/** The tracker's own health, or undefined when what answers on `port` is not the tracker. */
async function health(fetcher: typeof fetch, port: number): Promise<Running | undefined> {
  const body = await getJson<{ ok?: unknown; version?: unknown; claudeDir?: unknown }>(fetcher, port, '/api/health', 1_500);
  if (body?.ok !== true || typeof body.version !== 'string' || typeof body.claudeDir !== 'string') return undefined;
  return { port, url: `http://${DEFAULT_HOST}:${port}`, version: body.version, claudeDir: body.claudeDir };
}

async function getJson<T>(fetcher: typeof fetch, port: number, path: string, timeoutMs: number): Promise<T | undefined> {
  try {
    const response = await fetcher(`http://${DEFAULT_HOST}:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/** What the page's limit cards and history count: cache writes are billed, cache reads are not. */
function billed(tokens: SessionTokenTotals | undefined): number {
  return tokens ? tokens.input + tokens.output + tokens.cacheCreate : 0;
}

function localMidnight(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function snapshotOf(limits: UsageLimits | null, list: SessionListResult, usage: UsageHistory | null): Snapshot {
  return {
    limits,
    running: list.sessions.filter((session) => session.status !== 'ended'),
    today: usage && {
      tokens: usage.buckets.reduce((sum, bucket) => sum + billed(bucket.tokens), 0),
      turns: usage.buckets.reduce((sum, bucket) => sum + bucket.turns, 0),
    },
  };
}

/** Undefined when the tracker stopped answering part way, so the caller can read the disk instead. */
async function fromTracker(fetcher: typeof fetch, port: number, now: number): Promise<Snapshot | undefined> {
  // A cold sweep of a large history takes a while, and the tracker is the one doing it.
  const slow = 60_000;
  const [limits, list, usage] = await Promise.all([
    getJson<UsageLimits>(fetcher, port, '/api/limits', slow),
    // Running sessions are always listed, whatever the limit.
    getJson<SessionListResult>(fetcher, port, '/api/sessions?limit=1', slow),
    getJson<UsageHistory>(fetcher, port, `/api/usage/history?since=${localMidnight(now)}&until=${now}`, slow),
  ]);
  if (!list || !Array.isArray(list.sessions)) return undefined;
  return snapshotOf(limits ?? null, list, usage ?? null);
}

async function fromDisk(registry: SessionRegistry, now: number): Promise<Snapshot> {
  const [limits, list, usage] = await Promise.all([
    registry.limits(),
    registry.list({ limit: 1 }),
    registry.usage({ since: localMidnight(now), until: now }),
  ]);
  return snapshotOf(limits, list, usage);
}

/**
 * How full a window is, worked out the way the page does: Claude Code's own
 * percentage when there is one, else this window against the heaviest on record.
 */
function limitShare(limit: UsageLimit): number | undefined {
  const percent = limit.reported?.percent;
  if (typeof percent === 'number') return percent / 100;

  const ceiling = billed(limit.reference?.tokens);
  return ceiling ? billed(limit.current?.tokens) / ceiling : undefined;
}

/** Rounded down, as on the page, so the number never reads higher than the bar it stands for. */
function formatShare(share: number): string {
  const percent = share * 100;
  if (percent <= 0) return '0%';
  return percent >= 1 ? `${Math.floor(percent)}%` : `${percent.toFixed(1)}%`;
}

/** `3d 4h`, `2h 14m`, `14m`: a span rather than a clock time, so no timezone or locale is involved. */
export function formatSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${minutes}m`;
}

/** `950`, `12.3K`, `4.1M`. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  const [value, unit] = count < 999_950 ? [count / 1_000, 'K'] : count < 999_950_000 ? [count / 1_000_000, 'M'] : [count / 1_000_000_000, 'B'];
  return `${value.toFixed(1).replace(/\.0$/, '')}${unit}`;
}

function limitText(limit: UsageLimit, now: number): string {
  const share = limitShare(limit);
  if (share === undefined) return 'no reading yet';

  // Without Claude Code's own figure the ceiling is unknown, so the number is a comparison and says so.
  const parts = [typeof limit.reported?.percent === 'number' ? `${formatShare(share)} used` : `${formatShare(share)} of the heaviest window on record`];
  const resetsAt = limit.reported?.resetsAt ?? limit.current?.resetsAt;
  if (resetsAt !== undefined && resetsAt > now) parts.push(`resets in ${formatSpan(resetsAt - now)}`);
  return parts.join(', ');
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

function sessionLines(sessions: Session[]): string[] {
  const listed = sessions.slice(0, MAX_LISTED);
  const width = Math.min(24, Math.max(...listed.map((session) => session.project.name.length)));
  const lines = listed.map((session) => {
    const project = clip(session.project.name, width).padEnd(width);
    const about = session.title ?? session.name ?? session.lastPrompt ?? '';
    const waiting = session.status === 'waiting' && session.waitingFor ? ` (${session.waitingFor})` : '';
    return `    ${session.status.padEnd(7)}  ${project}  ${clip(about, TITLE_WIDTH)}${waiting}`.trimEnd();
  });
  if (sessions.length > listed.length) lines.push(`    and ${sessions.length - listed.length} more`);
  return lines;
}

/** The summary itself. Pure, so what it says can be tested without a machine behind it. */
export function summarize(snapshot: Snapshot, about: { version: string; url: string | undefined; now: number }): string {
  const lines = ['', `  Claude Code Session Tracker ${about.version}`, ''];

  if (snapshot.limits) {
    lines.push(`  5-hour limit  ${limitText(snapshot.limits.session, about.now)}`);
    lines.push(`  Weekly limit  ${limitText(snapshot.limits.weekly, about.now)}`);
  } else {
    lines.push('  Limits        no reading');
  }
  if (snapshot.today) {
    const { tokens, turns } = snapshot.today;
    lines.push(`  Today         ${tokens > 0 ? `${formatTokens(tokens)} tokens in ${turns} ${turns === 1 ? 'turn' : 'turns'}` : 'nothing billed yet'}`);
  }

  lines.push('');
  if (snapshot.running.length === 0) {
    lines.push('  Running       no sessions');
  } else {
    lines.push(`  Running       ${snapshot.running.length} ${snapshot.running.length === 1 ? 'session' : 'sessions'}`);
    lines.push(...sessionLines(snapshot.running));
  }

  lines.push('');
  lines.push(`  Dashboard     ${about.url ?? 'not running. Start it with: claude-code-session-tracker open'}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// The command

const USAGE = `
  Usage
    $ claude-code-session-tracker status   Print the limits, the running sessions and today's tokens

  Options
    --claude-dir <p>  Override the Claude data directory (default $CLAUDE_CONFIG_DIR or ~/.claude)
    --offline         Read the disk only: ask neither a running tracker nor Anthropic's server
`;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const defaultIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** What the command reads from the machine, so a test can stand in for each of them. */
export interface Env {
  version: string;
  ports: readonly number[];
  fetch: typeof fetch;
  now: () => number;
  /** The registry that reads the disk when no tracker is asked. */
  registry: (options: { claudeDir: string | undefined; offline: boolean }) => { registry: SessionRegistry; claudeDir: string };
}

function defaultEnv(): Env {
  return {
    version: VERSION,
    ports: PORTS,
    fetch,
    now: () => Date.now(),
    registry: ({ claudeDir, offline }) => {
      const config = createConfig({ claudeDir, offline });
      return { registry: new SessionRegistry(config), claudeDir: config.claudeDir };
    },
  };
}

export async function status(args: string[], io: Io = defaultIo, overrides: Partial<Env> = {}): Promise<number> {
  const env = { ...defaultEnv(), ...overrides };

  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        'claude-dir': { type: 'string' },
        offline: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
  if (values.help) {
    io.out(`${USAGE}\n`);
    return 0;
  }

  const now = env.now();
  const disk = env.registry({ claudeDir: values['claude-dir'], offline: values.offline });
  const tracker = values.offline ? undefined : await findTracker(env);

  let snapshot: Snapshot | undefined;
  try {
    // A tracker reading some other directory has the wrong answer, however warm it is.
    if (tracker && tracker.claudeDir === disk.claudeDir) snapshot = await fromTracker(env.fetch, tracker.port, now);
    snapshot ??= await fromDisk(disk.registry, now);
  } catch (error) {
    // Said, not thrown: see the note at the top about exiting non-zero.
    io.out(`\n  Could not read ${disk.claudeDir}:\n  ${error instanceof Error ? error.message : String(error)}\n\n`);
    return 0;
  }

  io.out(summarize(snapshot, { version: env.version, url: tracker?.url, now }));
  return 0;
}
