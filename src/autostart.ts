import { execFileSync, spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

/**
 * Starting the tracker when the user logs in.
 *
 * macOS gets a LaunchAgent, which is what System Settings lists under Login Items;
 * Windows gets an entry in the per-user Run key, which is what Settings lists under
 * Startup apps. Both start the same program the user just ran, with its default
 * of opening the page, so logging in lands on the dashboard. Neither needs admin
 * rights, and `off` removes exactly what `on` wrote.
 */

export const LABEL = 'com.meyusufdemirci.claude-code-session-tracker';
export const ENTRY_NAME = 'Claude Code Session Tracker';
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** The node binary and the script it runs, as paths that will still be there at the next login. */
export interface Launcher {
  node: string;
  cli: string;
}

/**
 * Where the running copy lives, made fit to be started again later.
 *
 * Two kinds of path will not survive: a one-off runner's cache (`npx` and friends
 * download into a folder they are free to clear), which is refused, and a version
 * manager's per-shell link (fnm's `fnm_multishells`), which is followed to the
 * install it points at. Everything else is kept as given rather than resolved, so
 * Homebrew's `bin` link survives an upgrade that its versioned Cellar path would not.
 */
export function resolveLauncher(
  node: string,
  cli: string | undefined,
): Launcher | { error: string } {
  if (cli === undefined) return { error: 'Cannot tell where this copy of the tracker is installed.' };

  const real = safeRealpath(cli);
  if (isOneOffCache(real)) {
    return {
      error:
        'This copy was fetched for one run and may be cleared, so it cannot start at login.\n' +
        'Install it first, then run this again:\n\n' +
        '  brew install meyusufdemirci/tap/claude-code-session-tracker\n' +
        '  npm install -g claude-code-session-tracker\n',
    };
  }

  return { node: stable(node), cli: stable(cli) };
}

function stable(path: string): string {
  return path.includes('fnm_multishells') ? safeRealpath(path) : path;
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** npx, pnpm dlx, yarn dlx and bunx each unpack into a cache or a temp folder. */
export function isOneOffCache(path: string): boolean {
  const markers = [`${sep}_npx${sep}`, `${sep}dlx${sep}`, `${sep}xfs-`, `${sep}bunx-`];
  const temp = [tmpdir(), safeRealpath(tmpdir())];
  return markers.some((marker) => path.includes(marker)) || temp.some((dir) => path.startsWith(dir + sep));
}

// macOS

export function plistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function macLogPath(home: string = homedir()): string {
  return join(home, 'Library', 'Logs', 'claude-code-session-tracker.log');
}

/**
 * What the LaunchAgent runs: a two-line script named after the project.
 *
 * Login Items lists a job by its executable's file name, which for the tracker
 * itself would be `cli.js`, or `node`. The script gives it a name worth reading
 * and then becomes the tracker.
 *
 * Port and process lists name a running program by its file, too, so node is run
 * from a hard link named after the project, kept next to the script. The link is
 * made again at every login, so it follows a Node upgrade, and plain node runs
 * when it cannot be made (node on another volume) or cannot start from there.
 * Homebrew's node is the case for the second: it loads `libnode` from `../lib`
 * beside its own file, so a link anywhere else dies in dyld before running a line.
 * Trying the link once does not tell: the first run of a new link can still find
 * the library through the original's path, and the next one, at login, does not.
 *
 * A copy in a folder macOS guards (Desktop, Documents, Downloads, iCloud Drive, or
 * another volume) skips the link: access there is granted per program, and while
 * `node` may have it, the link is a new program that is refused.
 *
 * Node is found through PATH when the tracker could run on its own, as its
 * `#!/usr/bin/env node` would, so Homebrew's `node` link survives an upgrade.
 */
export function launcherScriptPath(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', 'claude-code-session-tracker', ENTRY_NAME);
}

export function buildLauncherScript(
  launcher: Launcher,
  runnable = isExecutable(launcher.cli),
  linkable = !isInGuardedFolder(launcher.cli),
): string {
  const header = `#!/bin/sh
# Written by \`claude-code-session-tracker autostart on\`; removed by \`autostart off\`.
`;
  const cli = shellQuote(launcher.cli);
  if (!linkable) return `${header}exec ${runnable ? cli : `${shellQuote(launcher.node)} ${cli}`}\n`;

  const node = runnable ? `$(command -v node) || node=${shellQuote(launcher.node)}` : shellQuote(launcher.node);
  return `${header}node=${node}
link="$(dirname "$0")/claude-code-session-tracker"
real=$(realpath "$node" 2>/dev/null) || real=$node
if ls "\${real%/*}"/../lib/libnode.*.dylib >/dev/null 2>&1; then rm -f "$link"
else ln -fL "$node" "$link" 2>/dev/null || rm -f "$link"; fi
[ -x "$link" ] && exec "$link" ${cli}
exec "$node" ${cli}
`;
}

/** Folders whose files macOS hands out per program, after asking the user. */
export function isInGuardedFolder(path: string, home: string = homedir()): boolean {
  const real = safeRealpath(path);
  const guarded = ['Desktop', 'Documents', 'Downloads', join('Library', 'Mobile Documents')].map((folder) => join(home, folder) + sep);
  return real.startsWith('/Volumes/') || guarded.some((folder) => real.startsWith(folder) || path.startsWith(folder));
}

/**
 * The LaunchAgent. launchd starts jobs with almost no PATH, so it is given one
 * that finds `node` for the tracker's `#!/usr/bin/env node`. It is restarted only
 * when it crashes — a clean exit is the user quitting it.
 */
export function buildPlist(launcher: Launcher, home: string = homedir()): string {
  const path = [...new Set([dirname(launcher.cli), dirname(launcher.node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])];
  const log = macLogPath(home);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXml(launcherScriptPath(home))}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${escapeXml(path.join(':'))}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>${escapeXml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(log)}</string>
</dict>
</plist>
`;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    // A source checkout's `cli.ts` is executable but not something `env node` runs.
    return !path.endsWith('.ts');
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Windows

export function windowsLogPath(env: Record<string, string | undefined> = process.env): string {
  const base = env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  return join(base, 'claude-code-session-tracker', 'tracker.log');
}

/**
 * What the Run key starts: this CLI's `autostart launch`, which starts the tracker
 * itself with no console window and returns. Pointing the key at the tracker
 * directly would leave a console open for as long as it runs, and closing that
 * window would stop it.
 */
export function runKeyCommand(launcher: Launcher): string {
  return `"${launcher.node}" "${launcher.cli}" autostart launch`;
}

// The command

const USAGE = `
  Usage
    $ claude-code-session-tracker autostart on      Start at login and open the page (starts it now, too)
    $ claude-code-session-tracker autostart off     Stop starting at login
    $ claude-code-session-tracker autostart status  Say whether it starts at login
`;

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export async function autostart(args: string[], io: Io = defaultIo): Promise<number> {
  const action = args[0];
  if (action !== 'on' && action !== 'off' && action !== 'status' && action !== 'launch') {
    (action === undefined || action === '--help' || action === '-h' ? io.out : io.err)(`${USAGE}\n`);
    return action === undefined || action === '--help' || action === '-h' ? 0 : 1;
  }

  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    io.err('\n  Starting at login is set up for macOS and Windows only.\n\n');
    return 1;
  }

  if (action === 'status') return status(io);
  if (action === 'off') return process.platform === 'darwin' ? macOff(io) : windowsOff(io);

  const launcher = resolveLauncher(process.execPath, process.argv[1]);
  if ('error' in launcher) {
    io.err(`\n  ${launcher.error.replace(/\n/g, '\n  ')}\n`);
    return 1;
  }

  if (action === 'launch') {
    launchDetached(launcher);
    return 0;
  }
  return process.platform === 'darwin' ? macOn(launcher, io) : windowsOn(launcher, io);
}

async function macOn(launcher: Launcher, io: Io): Promise<number> {
  const plist = plistPath();
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(dirname(macLogPath()), { recursive: true });
  const script = launcherScriptPath();
  mkdirSync(dirname(script), { recursive: true });
  // A link left by an earlier `on` would hold on to a copy of node that is never used.
  rmSync(join(dirname(script), 'claude-code-session-tracker'), { force: true });
  writeFileSync(script, buildLauncherScript(launcher));
  chmodSync(script, 0o755);
  writeFileSync(plist, buildPlist(launcher));

  // Bootstrapping a label that is already loaded fails, so take any old one down
  // first. `bootout` returns before the job is gone, and a bootstrap in that gap
  // fails with an I/O error, so wait it out.
  if (quietly('launchctl', ['bootout', `${guiDomain()}/${LABEL}`])) await waitUntilUnloaded();
  try {
    execFileSync('launchctl', ['bootstrap', guiDomain(), plist], { stdio: 'pipe' });
  } catch (error) {
    io.err(`\n  Wrote ${plist}, but launchd would not load it:\n  ${commandError(error)}\n\n`);
    return 1;
  }

  io.out(
    `\n  On  The tracker starts and opens the page every time you log in.\n` +
      `      It is starting now, too.\n\n` +
      `  Login item  ${plist}\n  Log         ${macLogPath()}\n\n` +
      `  Turn it off with: claude-code-session-tracker autostart off\n\n`,
  );
  return 0;
}

async function waitUntilUnloaded(): Promise<void> {
  for (let tries = 0; tries < 50 && quietly('launchctl', ['print', `${guiDomain()}/${LABEL}`]); tries++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

/** The logged-in user's launchd domain, where Login Items live. */
function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function macOff(io: Io): number {
  const plist = plistPath();
  quietly('launchctl', ['bootout', `${guiDomain()}/${LABEL}`]);
  const existed = existsSync(plist);
  rmSync(plist, { force: true });
  rmSync(dirname(launcherScriptPath()), { recursive: true, force: true });
  io.out(existed ? '\n  Off  The tracker no longer starts at login, and the one it started has stopped.\n\n' : '\n  Off  It was not set to start at login.\n\n');
  return 0;
}

function windowsOn(launcher: Launcher, io: Io): number {
  try {
    execFileSync('reg', ['add', RUN_KEY, '/v', ENTRY_NAME, '/t', 'REG_SZ', '/d', runKeyCommand(launcher), '/f'], { stdio: 'pipe', windowsHide: true });
  } catch (error) {
    io.err(`\n  Could not add the startup entry:\n  ${commandError(error)}\n\n`);
    return 1;
  }
  launchDetached(launcher);

  io.out(
    `\n  On  The tracker starts and opens the page every time you log in.\n` +
      `      It is starting now, too.\n\n` +
      `  Startup app  ${ENTRY_NAME}  (${RUN_KEY})\n  Log          ${windowsLogPath()}\n\n` +
      `  Turn it off with: claude-code-session-tracker autostart off\n\n`,
  );
  return 0;
}

function windowsOff(io: Io): number {
  const existed = quietly('reg', ['delete', RUN_KEY, '/v', ENTRY_NAME, '/f']);
  stopLaunched();
  io.out(existed ? '\n  Off  The tracker no longer starts at login, and the one it started has stopped.\n\n' : '\n  Off  It was not set to start at login.\n\n');
  return 0;
}

function status(io: Io): number {
  const on = process.platform === 'darwin' ? existsSync(plistPath()) : quietly('reg', ['query', RUN_KEY, '/v', ENTRY_NAME]);
  io.out(on ? '\n  On  The tracker starts at login.\n\n' : '\n  Off  The tracker does not start at login.\n\n');
  return 0;
}

export function windowsPidPath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(windowsLogPath(env)), 'tracker.pid');
}

/**
 * Start the tracker on its own, with no console, its output going to the log.
 *
 * Windows has no launchd to own the process, so its pid is written down: that is
 * how `off` stops it, and how `on` run twice replaces it rather than starting a
 * second one on the next free port.
 */
function launchDetached(launcher: Launcher): void {
  stopLaunched();
  const log = process.platform === 'darwin' ? macLogPath() : windowsLogPath();
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  const child = spawn(launcher.node, [launcher.cli], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  if (child.pid !== undefined && process.platform === 'win32') writeFileSync(windowsPidPath(), String(child.pid));
  child.unref();
}

/**
 * Stop the copy `launch` started, if it is still running. A pid can be reused
 * once its process is gone, so it is only signalled while it still names a
 * `node.exe` — never some other program that happens to hold the number now.
 */
function stopLaunched(): void {
  if (process.platform !== 'win32') return;
  const pidFile = windowsPidPath();
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
  } catch {
    return;
  }
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 0) return;

  try {
    const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: 'pipe', windowsHide: true }).toString();
    if (!/^"node\.exe"/im.test(row)) return;
    process.kill(pid);
  } catch {
    // Already gone, or not ours to stop.
  }
}

/** Run a command whose failure only means there was nothing to undo. True when it succeeded. */
function quietly(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function commandError(error: unknown): string {
  const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
  return stderr || (error instanceof Error ? error.message : String(error));
}
