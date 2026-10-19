import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Auto continue: a session that stopped on a limit picks up again once it resets.
 *
 * The tracker cannot type into a session, and should not try: Claude Code's own
 * session-to-session socket is authenticated, and what arrives over it is marked as
 * another agent's words rather than the user's. What Claude Code does offer is a
 * hook. The plugin registers one on `StopFailure` for `rate_limit` with
 * `asyncRewake`, so it runs in the background inside the session that stopped, and
 * when it exits 2 Claude Code wakes that session and shows it the hook's message.
 * That hook is `claude-code-session-tracker auto-continue wait`, below: it waits for
 * the reset, checks it is still wanted, and exits 2.
 *
 * So the waiting happens in each session, and the tracker is only the switch and
 * the window onto it. The switch is a file of ours rather than a browser setting,
 * because the hook, the page and the menu bar all read it, and none of them is
 * guaranteed to be running when another one changes it. Each waiting hook writes
 * down what it is waiting for, which is how the page and the menu bar can say
 * which sessions will continue, and when.
 *
 * Everything here is in this tool's own folder. Nothing is written to the Claude
 * directory: the plugin's install state is read from it, never changed.
 */

/** How the plugin is listed in Claude Code's plugin registry: `<plugin>@<marketplace>`. */
export const PLUGIN_NAME = 'session-tracker';

/**
 * How long after the reset a session is woken.
 *
 * The reset Claude names is the second the window empties, and a turn sent on that
 * second can still be refused by a server whose clock is a moment behind. A minute
 * costs nothing next to the hours already waited.
 */
export const GRACE_MS = 60_000;

/** How often a waiting hook looks up from its sleep to see whether it is still needed. */
const CHECK_EVERY_MS = 30_000;

/** How many times a reading still at 100% after the reset may push the wake back. */
const MAX_POSTPONES = 3;

/** How far back from the end of a transcript the refusal is looked for. */
const TAIL_BYTES = 512 * 1024;

/** How many continued sessions are remembered, for the "last run" line. */
const HISTORY_SIZE = 20;

/** What the session is told when it is woken, as the hook's message. */
export const WAKE_MESSAGE =
  'Auto continue (Claude Code Session Tracker): the usage limit that stopped this session has reset. ' +
  'Continue the task you were working on, picking up exactly where you left off.';

export type LimitClock = 'five_hour' | 'weekly';

/** A session whose hook is waiting for a reset. */
export interface PendingContinue {
  sessionId: string;
  /** The hook's own process, so one that died without cleaning up is not listed. */
  pid: number;
  cwd?: string;
  clock: LimitClock;
  /** When the limit resets, epoch milliseconds. */
  resetsAt: number;
  /** When the session is woken, if auto continue is on by then. */
  continueAt: number;
  /** When the session stopped. */
  since: number;
}

/** A session auto continue woke. */
export interface ContinuedSession {
  sessionId: string;
  cwd?: string;
  at: number;
}

/**
 * Whether the hook is there to do the waiting.
 *
 * `missing` — the plugin is not installed. `outdated` — it is, at a version from
 * before it carried the hook. `disabled` — installed with the hook, but switched off
 * in Claude Code. Only `ready` sessions can be continued.
 */
export type PluginState = 'ready' | 'missing' | 'outdated' | 'disabled';

export interface AutoContinueStatus {
  enabled: boolean;
  plugin: PluginState;
  /** Waiting sessions, the soonest first. */
  pending: PendingContinue[];
  /** The sessions woken most recently, the latest first. */
  continued: ContinuedSession[];
}

/** Where this tool keeps its own files: the settings, and what the hooks are waiting for. */
export function appDataDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  // For a source checkout run beside an installed tracker, so the two keep separate switches.
  const override = env['CLAUDE_CODE_SESSION_TRACKER_STATE_DIR'];
  if (override) return override;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'claude-code-session-tracker');
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'claude-code-session-tracker');
  return join(env['XDG_STATE_HOME'] ?? join(home, '.local', 'state'), 'claude-code-session-tracker');
}

export interface AutoContinueOptions {
  claudeDir: string;
  /** This tool's own folder. Defaults to `appDataDir()`. */
  stateDir?: string;
  /** Whether a process is still running. */
  alive?: (pid: number) => boolean;
}

/** The switch, the plugin's state, and the sessions waiting on it. */
export class AutoContinue {
  readonly #claudeDir: string;
  readonly #stateDir: string;
  readonly #alive: (pid: number) => boolean;

  constructor(options: AutoContinueOptions) {
    this.#claudeDir = options.claudeDir;
    this.#stateDir = options.stateDir ?? appDataDir();
    this.#alive = options.alive ?? isAlive;
  }

  get #settingsPath(): string {
    return join(this.#stateDir, 'settings.json');
  }

  get #pendingDir(): string {
    return join(this.#stateDir, 'auto-continue');
  }

  get #historyPath(): string {
    return join(this.#stateDir, 'auto-continue-history.json');
  }

  /** Off until someone turns it on: it is the one thing this tool does to a session. */
  enabled(): boolean {
    return readJson<{ autoContinue?: unknown }>(this.#settingsPath)?.autoContinue === true;
  }

  setEnabled(on: boolean): void {
    const settings = readJson<Record<string, unknown>>(this.#settingsPath) ?? {};
    writeJson(this.#settingsPath, { ...settings, autoContinue: on });
  }

  /**
   * Read off Claude Code's plugin registry and settings, never written to.
   *
   * A hook only exists in a plugin version that ships one, so being installed is not
   * enough: the installed copy's own folder has to hold the hook file.
   */
  plugin(): PluginState {
    const registry = readJson<{ plugins?: Record<string, unknown> }>(join(this.#claudeDir, 'plugins', 'installed_plugins.json'));
    const key = Object.keys(registry?.plugins ?? {}).find((name) => name.startsWith(`${PLUGIN_NAME}@`));
    if (!key) return 'missing';

    const installs = registry?.plugins?.[key];
    const paths = (Array.isArray(installs) ? installs : [installs])
      .map((install) => (install && typeof install === 'object' ? (install as { installPath?: unknown }).installPath : undefined))
      .filter((path): path is string => typeof path === 'string');
    if (!paths.some((path) => existsSync(join(path, 'hooks', 'hooks.json')))) return 'outdated';

    const settings = readJson<{ enabledPlugins?: Record<string, unknown> }>(join(this.#claudeDir, 'settings.json'));
    return settings?.enabledPlugins?.[key] === false ? 'disabled' : 'ready';
  }

  /** Sessions with a hook still waiting. One whose hook has gone is cleared away. */
  pending(): PendingContinue[] {
    let names: string[];
    try {
      names = readdirSync(this.#pendingDir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }

    const pending: PendingContinue[] = [];
    for (const name of names) {
      const path = join(this.#pendingDir, name);
      const entry = toPending(readJson(path));
      if (entry && this.#alive(entry.pid)) pending.push(entry);
      else if (entry) rmSync(path, { force: true });
    }
    return pending.sort((a, b) => a.continueAt - b.continueAt);
  }

  continued(): ContinuedSession[] {
    const history = readJson<unknown[]>(this.#historyPath);
    return Array.isArray(history) ? history.filter(isContinued).sort((a, b) => b.at - a.at) : [];
  }

  status(): AutoContinueStatus {
    return { enabled: this.enabled(), plugin: this.plugin(), pending: this.pending(), continued: this.continued() };
  }

  /** One file per hook, named for its process, so two hooks in one session cannot overwrite each other. */
  register(entry: PendingContinue): void {
    writeJson(join(this.#pendingDir, `${entry.pid}.json`), entry);
  }

  unregister(pid: number): void {
    rmSync(join(this.#pendingDir, `${pid}.json`), { force: true });
  }

  recordContinued(entry: ContinuedSession): void {
    writeJson(this.#historyPath, [entry, ...this.continued()].slice(0, HISTORY_SIZE));
  }
}

/* ------------------------------------------------------------------ the hook */

/** What Claude Code hands a `StopFailure` hook on stdin — the fields this one reads. */
export interface StopFailureInput {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  error?: unknown;
}

/** The reading of one limit the hook asks a running tracker for. */
export interface LimitReading {
  percent: number;
  fetchedAt: number;
  resetsAt?: number;
}

export interface WaitEnv {
  autoContinue: AutoContinue;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The running tracker's reading of each limit, or undefined when none is running. */
  readings: () => Promise<Partial<Record<LimitClock, LimitReading>> | undefined>;
  pid: number;
  /** Where the wake message goes: stderr, which Claude Code shows the session. */
  say: (text: string) => void;
}

/** The exit code that wakes the session. */
export const WAKE = 2;

/**
 * Wait for the limit that stopped this session to reset, then wake it.
 *
 * Returns the exit code: `WAKE` to continue the session, 0 to leave it be. It leaves
 * it be whenever there is any doubt — no reset to wait for, the session already
 * carried on, auto continue off when the moment comes, or the limit still full —
 * since a session woken for nothing burns a turn on a refusal and wakes no one.
 *
 * The switch is read at the reset, not now. Sessions stop with it off, and the page
 * offers to turn it on for exactly those, so the hook waits either way.
 */
export async function waitToContinue(input: StopFailureInput, env: WaitEnv): Promise<number> {
  if (input.error !== 'rate_limit' || typeof input.session_id !== 'string') return 0;
  const sessionId = input.session_id;
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : undefined;
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;

  const stop = await findStop(transcript, env);
  if (!stop) return 0;

  const since = env.now();
  let resetsAt = stop.resetsAt;
  const entry = (): PendingContinue => ({
    sessionId,
    pid: env.pid,
    ...(cwd ? { cwd } : {}),
    clock: stop.clock,
    resetsAt,
    continueAt: resetsAt + GRACE_MS,
    since,
  });

  env.autoContinue.register(entry());
  try {
    for (let postponed = 0; ; postponed++) {
      // Looked up from every so often rather than slept through: a session the user
      // has carried on with frees its hook, and its line on the page, at once.
      while (env.now() < resetsAt + GRACE_MS) {
        if (transcript && carriedOn(transcript, stop.offset)) return 0;
        await env.sleep(Math.min(CHECK_EVERY_MS, resetsAt + GRACE_MS - env.now()));
      }
      if (transcript && carriedOn(transcript, stop.offset)) return 0;
      if (!env.autoContinue.enabled()) return 0;

      const later = stillFull(await env.readings(), stop.clock, resetsAt);
      if (later === undefined) break;
      if (postponed >= MAX_POSTPONES) return 0;
      resetsAt = later;
      env.autoContinue.register(entry());
    }

    env.autoContinue.recordContinued({ sessionId, ...(cwd ? { cwd } : {}), at: env.now() });
    env.say(WAKE_MESSAGE);
    return WAKE;
  } finally {
    env.autoContinue.unregister(env.pid);
  }
}

/** Which limit stopped the session, when it resets, and where the transcript stood then. */
interface Stop {
  clock: LimitClock;
  resetsAt: number;
  /** The transcript's length once the refusal was in it: anything past it is the session carrying on. */
  offset: number;
}

/** How long Claude Code is given to write the refused turn down after the hook starts. */
const FIND_TRIES = 10;
const FIND_PAUSE_MS = 500;

/**
 * The refusal is the one place Claude Code writes the reset down, so it is read off
 * the transcript. A session that keeps no transcript falls back to the running
 * tracker: whichever limit it reads as full is the one that stopped the session.
 */
async function findStop(transcript: string | undefined, env: WaitEnv): Promise<Stop | undefined> {
  if (transcript) {
    for (let attempt = 0; attempt < FIND_TRIES; attempt++) {
      const found = lastRefusal(transcript);
      if (found) return found;
      await env.sleep(FIND_PAUSE_MS);
    }
  }

  const readings = await env.readings();
  const now = env.now();
  // The week first: when both are full, the session waits for the later reset.
  for (const clock of ['weekly', 'five_hour'] as const) {
    const reading = readings?.[clock];
    if (reading && reading.percent >= 100 && reading.resetsAt !== undefined && reading.resetsAt > now) {
      return { clock, resetsAt: reading.resetsAt, offset: transcript ? sizeOf(transcript) : 0 };
    }
  }
  return undefined;
}

/**
 * When a reading taken after the reset still says full, the reset it names next.
 *
 * Only a reading taken after the reset can say so: one from before it is about the
 * window that just emptied. With no tracker running there is nothing to ask, and the
 * reset Claude named is taken at its word.
 */
function stillFull(readings: Partial<Record<LimitClock, LimitReading>> | undefined, clock: LimitClock, resetsAt: number): number | undefined {
  const reading = readings?.[clock];
  if (!reading || reading.fetchedAt < resetsAt || reading.percent < 100) return undefined;
  return reading.resetsAt !== undefined && reading.resetsAt > resetsAt ? reading.resetsAt : undefined;
}

/**
 * The refusal that ended the last turn, when it did.
 *
 * Read backwards from the end: the first assistant record met is the last turn's,
 * and only a refusal there means the session is stopped on it. One further back
 * was followed by a turn that went through.
 */
export function lastRefusal(transcript: string): Stop | undefined {
  const tail = readTail(transcript);
  if (!tail) return undefined;

  const lines = tail.text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const record = parseLine(lines[index]);
    if (record?.['type'] !== 'assistant') continue;

    const quota = record['quotaLimits'];
    if (!quota || typeof quota !== 'object') return undefined;
    const { status, rateLimitType, resetsAt } = quota as Record<string, unknown>;
    if (status !== 'rejected' || typeof resetsAt !== 'number') return undefined;
    const clock = rateLimitType === 'five_hour' ? 'five_hour'
      : typeof rateLimitType === 'string' && (rateLimitType.startsWith('seven_day') || rateLimitType === 'weekly') ? 'weekly'
      : undefined;
    if (!clock) return undefined;
    // Seconds on the wire, milliseconds everywhere in this tool.
    return { clock, resetsAt: resetsAt * 1000, offset: tail.size };
  }
  return undefined;
}

/**
 * Whether the session moved on after it stopped: a prompt typed, or a turn that went
 * through. Claude Code's own bookkeeping records in between do not count, and neither
 * does a further refusal.
 */
export function carriedOn(transcript: string, offset: number): boolean {
  const tail = readTail(transcript, offset);
  if (!tail) return false;
  return tail.text.split('\n').some((line) => {
    const record = parseLine(line);
    if (record?.['type'] === 'user') return record['isMeta'] !== true;
    if (record?.['type'] === 'assistant') return record['isApiErrorMessage'] !== true;
    return false;
  });
}

/** The end of a file from `from`, or its last `TAIL_BYTES` — whole lines only. */
function readTail(path: string, from?: number): { text: string; size: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const start = from ?? Math.max(0, size - TAIL_BYTES);
    if (start >= size) return { text: '', size };
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    // A tail that starts mid-line starts with half a record.
    if (from === undefined && start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, size };
  } finally {
    closeSync(fd);
  }
}

function sizeOf(path: string): number {
  return readTail(path, Number.MAX_SAFE_INTEGER)?.size ?? 0;
}

function parseLine(line: string | undefined): Record<string, unknown> | undefined {
  if (!line?.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------- files */

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Written beside and renamed into place, so a reader never sees half a file. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function toPending(value: unknown): PendingContinue | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  const numbers = ['pid', 'resetsAt', 'continueAt', 'since'] as const;
  if (typeof entry['sessionId'] !== 'string' || numbers.some((key) => typeof entry[key] !== 'number')) return undefined;
  if (entry['clock'] !== 'five_hour' && entry['clock'] !== 'weekly') return undefined;
  return value as PendingContinue;
}

function isContinued(value: unknown): value is ContinuedSession {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry['sessionId'] === 'string' && typeof entry['at'] === 'number';
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Running, but someone else's to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
