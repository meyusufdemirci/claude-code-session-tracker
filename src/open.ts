import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { macLogPath, windowsLogPath } from './autostart.ts';
import { openBrowser } from './desktop.ts';
import { defaultIo, findTracker, PORTS } from './status.ts';
import type { Io, Running } from './status.ts';

/**
 * Opening the page, starting the tracker first when nothing is serving it.
 *
 * This is what the Claude Code plugin's `/tracker:open` runs. A tracker that is
 * already up, whoever started it (a terminal, `autostart on`, the menu bar app), is
 * the one that gets opened, at the port it actually bound, so a second copy is
 * never started beside it on the next port along.
 *
 * When none is up, one is started on its own, with no terminal to hold it open, and
 * it keeps running after this command returns. It is started with `--no-open` and
 * the page is opened from here once it answers, so both paths open the same way.
 */

const USAGE = `
  Usage
    $ claude-code-session-tracker open   Open the page, starting the tracker first if it is not running
`;

/** How long a tracker that was just started is given to answer. */
const START_TRIES = 40;
const START_PAUSE_MS = 250;

/** Where a tracker started here writes what it would have printed. */
export function logPath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (platform === 'darwin') return macLogPath(home);
  if (platform === 'win32') return windowsLogPath(env);
  return join(env['XDG_STATE_HOME'] ?? join(home, '.local', 'state'), 'claude-code-session-tracker', 'tracker.log');
}

/** What the command reads from the machine, so a test can stand in for each of them. */
export interface Env {
  ports: readonly number[];
  fetch: typeof fetch;
  /** The script this copy of the tracker was started from. */
  cli: string | undefined;
  log: string;
  /** Start the tracker on its own, with no browser. False when it could not be started. */
  start: (cli: string, log: string) => boolean;
  openBrowser: (url: string) => void;
  wait: (ms: number) => Promise<void>;
}

function defaultEnv(): Env {
  return {
    ports: PORTS,
    fetch,
    cli: process.argv[1],
    log: logPath(),
    start: startDetached,
    openBrowser,
    wait: (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
  };
}

function startDetached(cli: string, log: string): boolean {
  try {
    mkdirSync(dirname(log), { recursive: true });
    const fd = openSync(log, 'a');
    const child = spawn(process.execPath, [cli, '--no-open'], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => {});
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  }
}

export async function open(args: string[], io: Io = defaultIo, overrides: Partial<Env> = {}): Promise<number> {
  const env = { ...defaultEnv(), ...overrides };

  if (args.length > 0) {
    const help = args[0] === '--help' || args[0] === '-h';
    (help ? io.out : io.err)(`${USAGE}\n`);
    return help ? 0 : 1;
  }

  const running = await findTracker(env);
  if (running) {
    env.openBrowser(running.url);
    io.out(`\n  Opened  ${running.url}\n\n`);
    return 0;
  }

  if (env.cli === undefined) {
    io.err('\n  Cannot tell where this copy of the tracker is installed, so it cannot be started.\n\n');
    return 1;
  }
  if (!env.start(env.cli, env.log)) {
    io.err(`\n  Could not start the tracker. Its log is at ${env.log}\n\n`);
    return 1;
  }

  let started: Running | undefined;
  for (let tries = 0; tries < START_TRIES && !started; tries++) {
    await env.wait(START_PAUSE_MS);
    started = await findTracker(env);
  }
  if (!started) {
    io.err(`\n  Started the tracker, but it has not answered yet. Its log is at ${env.log}\n\n`);
    return 1;
  }

  env.openBrowser(started.url);
  io.out(`\n  Started the tracker and opened  ${started.url}\n  It keeps running in the background. Log  ${env.log}\n\n`);
  return 0;
}
