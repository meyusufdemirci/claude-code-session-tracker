import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { LABEL, macLogPath, windowsLogPath, windowsPidPath } from './autostart.ts';
import { APP_NAME, FORMULA, PACKAGE } from './menubar.ts';
import { compareVersions, type InstallMethod } from './update.ts';

/**
 * The Update button: bring this copy to the newest version and come back as it.
 *
 * 1. Upgrade with whatever installed it — Homebrew, npm, pnpm or bun. A one-off
 *    runner has nothing installed, so the new version is fetched into its cache.
 * 2. Ask the new version for `--version`, so a broken upgrade leaves the old one
 *    running rather than nothing at all.
 * 3. Update the menu bar app too, when it is installed.
 * 4. Restart as the new version on the same port: through launchd when `autostart`
 *    started it, otherwise as a detached copy that outlives this one.
 *
 * Every program run is fixed here, never taken from the request.
 */

export interface Command {
  file: string;
  args: string[];
}

export interface Plan {
  /** Brings the installed copy to the newest version. Undefined for a runner, which has nothing installed. */
  upgrade?: Command;
  /** Runs the newest version with `args`. */
  run: (args: string[]) => Command;
  /** Why the button cannot do it here, in words for the page. */
  blocked?: string;
}

export type InstallState = 'idle' | 'installing' | 'restarting' | 'failed';

export interface InstallStatus {
  canInstall: boolean;
  installBlocked?: string;
  install: { state: InstallState; step?: string; error?: string };
}

/**
 * What updating looks like for this copy.
 *
 * `cli` is the path the tracker was started from, as given — the package
 * manager's own link, which an upgrade points at the new version.
 */
export function planFor(
  method: InstallMethod,
  cli: string | undefined,
  node: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): Plan {
  const nodeDir = dirname(node);
  const tool = (name: string): string => {
    const local = join(nodeDir, platform === 'win32' ? `${name}.cmd` : name);
    return existsSync(local) ? local : name;
  };
  const real = cli === undefined ? undefined : safeRealpath(cli);

  if (method === 'brew' && real) {
    const prefix = real.slice(0, real.indexOf(`${sep}Cellar${sep}`));
    const prefixNode = join(prefix, 'bin', 'node');
    return {
      upgrade: { file: join(prefix, 'bin', 'brew'), args: ['upgrade', FORMULA] },
      // Homebrew's own links, which follow an upgrade of the tracker and of node alike.
      run: (args) => ({ file: existsSync(prefixNode) ? prefixNode : node, args: [join(prefix, 'bin', PACKAGE), ...args] }),
      ...(writable(join(prefix, 'Cellar')) ? {} : { blocked: "Homebrew's folder is not yours to write to." }),
    };
  }

  if (method === 'runner') {
    return { run: (args) => ({ file: tool('npx'), args: ['-y', `${PACKAGE}@latest`, ...args] }) };
  }

  if ((method === 'npm' || method === 'pnpm' || method === 'bun') && cli && real) {
    const upgrade: Record<typeof method, Command> = {
      npm: { file: tool('npm'), args: ['install', '-g', `${PACKAGE}@latest`] },
      pnpm: { file: 'pnpm', args: ['add', '-g', `${PACKAGE}@latest`] },
      bun: { file: 'bun', args: ['add', '-g', `${PACKAGE}@latest`] },
    };
    const modules = real.slice(0, real.indexOf(`${sep}node_modules${sep}${PACKAGE}${sep}`) + `${sep}node_modules`.length);
    return {
      upgrade: upgrade[method],
      run: (args) => ({ file: node, args: [cli, ...args] }),
      ...(writable(modules) ? {} : { blocked: `${method}'s global folder needs admin rights, so run the command yourself.` }),
    };
  }

  return {
    run: (args) => ({ file: node, args: [cli ?? '', ...args] }),
    blocked: 'This copy was not installed by a package manager, so it cannot update itself.',
  };
}

export interface SelfUpdateOptions {
  plan: Plan;
  current: string;
  /** What the tracker was started with, so the new version starts the same way. */
  argv: string[];
  /** The port it is serving on, which the new version takes over. */
  port: () => number;
  /** Stop listening, so the new version can have the port. */
  close: () => Promise<void>;
  run?: (command: Command, timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
  detach?: (command: Command) => number | undefined;
  exit?: () => void;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Whether the menu bar app is installed, so it is updated alongside. */
  hasMenubarApp?: () => boolean;
}

export class SelfUpdate {
  readonly #options: Required<SelfUpdateOptions>;
  #state: InstallState = 'idle';
  #step: string | undefined;
  #error: string | undefined;

  constructor(options: SelfUpdateOptions) {
    this.#options = {
      run: runCommand,
      detach: detachCommand,
      exit: () => process.exit(0),
      platform: process.platform,
      env: process.env,
      hasMenubarApp: () => process.platform === 'darwin' && menubarAppInstalled(),
      ...options,
    };
  }

  status(): InstallStatus {
    const { blocked } = this.#options.plan;
    return {
      canInstall: blocked === undefined,
      ...(blocked ? { installBlocked: blocked } : {}),
      install: {
        state: this.#state,
        ...(this.#step ? { step: this.#step } : {}),
        ...(this.#error ? { error: this.#error } : {}),
      },
    };
  }

  /** Starts the update and returns at once; `status()` follows it. False when it cannot start. */
  start(latest: string): boolean {
    if (this.#options.plan.blocked || this.#state === 'installing' || this.#state === 'restarting') return false;
    this.#state = 'installing';
    this.#error = undefined;
    void this.#install(latest).catch((error: unknown) => this.#fail(error instanceof Error ? error.message : String(error)));
    return true;
  }

  async #install(latest: string): Promise<void> {
    const { plan, run } = this.#options;

    if (plan.upgrade) {
      this.#step = `Installing ${latest}`;
      const upgraded = await run(plan.upgrade, 10 * 60_000);
      if (!upgraded.ok) return this.#fail(`The upgrade failed: ${tail(upgraded.output)}`);
    } else {
      this.#step = `Downloading ${latest}`;
    }

    this.#step = 'Checking the new version';
    const checked = await run(plan.run(['--version']), 5 * 60_000);
    const version = checked.output.trim().split(/\s+/).pop() ?? '';
    if (!checked.ok || compareVersions(version, this.#options.current) <= 0) {
      return this.#fail(`The new version did not start: ${tail(checked.output) || 'no output'}`);
    }

    this.#state = 'restarting';
    this.#step = `Restarting as ${version}`;
    await this.#restart();
  }

  async #restart(): Promise<void> {
    const { plan, argv, port, close, detach, exit, platform, env, hasMenubarApp } = this.#options;
    // Let the page hear "restarting" before the server goes.
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));

    const menubar = hasMenubarApp();

    // `autostart` on macOS: launchd owns the tracker, so it is asked to start it
    // again, and it stops this one itself.
    if (platform === 'darwin' && env['XPC_SERVICE_NAME'] === LABEL && process.getuid) {
      if (menubar) detach(plan.run(['menubar', 'install']));
      detach({ file: '/bin/launchctl', args: ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`] });
      return;
    }

    const at = port();
    await close();
    const pid = detach(plan.run(restartArgs(argv, at)));
    // `autostart` on Windows stops the copy it started by its pid, so hand that on.
    if (platform === 'win32' && pid !== undefined) handOverWindowsPid(pid);
    // After the new tracker is on its way: installing the app quits the old app,
    // which stops a tracker it started — this one, which is going anyway.
    if (menubar) detach(plan.run(['menubar', 'install']));
    exit();
  }

  #fail(message: string): void {
    this.#state = 'failed';
    this.#step = undefined;
    this.#error = message;
  }
}

/** What the tracker was started with, on the port it holds now and without opening a second browser tab. */
export function restartArgs(argv: string[], port: number): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--port' || arg === '-p') {
      i++;
      continue;
    }
    if (arg.startsWith('--port=') || arg === '--open' || arg === '--no-open') continue;
    kept.push(arg);
  }
  return [...kept, '--port', String(port), '--no-open'];
}

/** The last few lines of a command's output: enough to say what went wrong. */
function tail(output: string): string {
  return output.trim().split('\n').slice(-4).join('\n');
}

/** Spawned straight, no shell — except Windows' `.cmd` shims, which only run through one. Every argument is fixed in `planFor`. */
function runCommand(command: Command, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveRun) => {
    execFile(
      command.file,
      command.args,
      { timeout: timeoutMs, env: childEnv(), windowsHide: true, shell: command.file.endsWith('.cmd'), maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolveRun({ ok: !error, output: `${stdout}${stderr}` || (error?.message ?? '') }),
    );
  });
}

function detachCommand(command: Command): number | undefined {
  const log = logPath();
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  const child = spawn(command.file, command.args, {
    detached: true,
    windowsHide: true,
    shell: command.file.endsWith('.cmd'),
    stdio: ['ignore', fd, fd],
    env: childEnv(),
  });
  child.unref();
  return child.pid;
}

/** Package managers, and the node they run on, found even from launchd's bare PATH. */
function childEnv(): NodeJS.ProcessEnv {
  const extra = [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.bun', 'bin')];
  return { ...process.env, PATH: [...extra, process.env['PATH'] ?? ''].join(process.platform === 'win32' ? ';' : ':') };
}

function logPath(): string {
  if (process.platform === 'darwin') return macLogPath();
  if (process.platform === 'win32') return windowsLogPath();
  return join(process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), PACKAGE, 'tracker.log');
}

function handOverWindowsPid(pid: number): void {
  try {
    if (readFileSync(windowsPidPath(), 'utf8').trim() === String(process.pid)) writeFileSync(windowsPidPath(), String(pid));
  } catch {
    // Not started by `autostart`.
  }
}

function menubarAppInstalled(): boolean {
  return [join('/Applications', APP_NAME), join(homedir(), 'Applications', APP_NAME)].some((path) => existsSync(path));
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
