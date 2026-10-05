import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isOneOffCache } from './autostart.ts';
import { VERSION } from './version.ts';

/**
 * Installing the macOS menu bar app.
 *
 * The app is built by the same release that publishes this package, and attached
 * to that version's GitHub release. This fetches the one built beside it, never a
 * newer or older one, and checks it against the checksum the package was published
 * with before anything is unpacked. Nothing here runs unless the user asks: there
 * is no install script, and the tracker itself never downloads anything.
 *
 * The app is signed to run locally rather than with a Developer ID. That is enough
 * here because macOS only stops to ask about files a browser marked as downloaded,
 * and nothing this writes is marked.
 */

export const APP_NAME = 'Claude Code Session Tracker.app';
export const BUNDLE_ID = 'com.meyusufdemirci.claude-code-session-tracker.app';
export const RELEASES = 'https://github.com/meyusufdemirci/claude-code-session-tracker/releases/download';

/** macOS 14, the oldest the app is built for, is Darwin 23. */
const MIN_DARWIN = 23;

/** What the release wrote into the package about the app it built: `dist/menubar.json`. */
export interface AppAsset {
  asset: string;
  sha256: string;
  size: number;
}

/**
 * The app this copy of the package vouches for, or undefined when it has none.
 *
 * Only a release writes the file, so a source checkout and a local build have
 * nothing to fetch. Anything that is not exactly the expected shape counts as
 * absent: the name goes into a URL and the checksum is the whole of the trust.
 */
export function readAsset(file: URL | string = new URL('./menubar.json', import.meta.url)): AppAsset | undefined {
  let parsed: Partial<AppAsset>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppAsset>;
  } catch {
    return undefined;
  }
  const { asset, sha256, size } = parsed;
  if (typeof asset !== 'string' || !/^[\w.-]+\.zip$/.test(asset)) return undefined;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return undefined;
  return { asset, sha256, size };
}

export function assetUrl(version: string, asset: AppAsset): string {
  return `${RELEASES}/v${version}/${asset.asset}`;
}

/** Whether a Darwin kernel release, as `os.release()` gives it, is new enough for the app. */
export function supportsApp(darwinRelease: string): boolean {
  return Number.parseInt(darwinRelease, 10) >= MIN_DARWIN;
}

/** Why `bytes` is not the app the package was published with, or undefined when it is. */
export function mismatch(bytes: Uint8Array, asset: AppAsset): string | undefined {
  if (bytes.length !== asset.size) return `it is ${bytes.length} bytes, not the ${asset.size} this version was published with`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== asset.sha256) return `its checksum is ${sha256}, not the ${asset.sha256} this version was published with`;
  return undefined;
}

/** Everywhere the app may already be: the shared folder, then the user's own. */
export function appPaths(env: Pick<Env, 'systemApps' | 'home'>): string[] {
  return [join(env.systemApps, APP_NAME), join(env.home, 'Applications', APP_NAME)];
}

/**
 * Where to put the app: over the copy that is already there, so there is never a
 * second one, else in /Applications when this user may write to it, else in their own.
 */
export function installPath(env: Pick<Env, 'systemApps' | 'home'>): string {
  const [shared, own] = appPaths(env) as [string, string];
  if (existsSync(shared)) return shared;
  if (existsSync(own)) return own;
  return writable(env.systemApps) ? shared : own;
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// The command

const USAGE = `
  Usage
    $ claude-code-session-tracker menubar install    Install the macOS menu bar app and widget, or update them
    $ claude-code-session-tracker menubar uninstall  Remove them
    $ claude-code-session-tracker menubar status     Say whether they are installed
`;

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** What the command reads from the machine, so a test can stand in for each of them. */
export interface Env {
  platform: NodeJS.Platform;
  darwinRelease: string;
  home: string;
  /** `/Applications`. */
  systemApps: string;
  version: string;
  asset: AppAsset | undefined;
  /** The script this copy of the tracker was started from. */
  cli: string | undefined;
  fetch: typeof fetch;
  /** Run a program and give back what it printed, or undefined when it failed. */
  run: (command: string, args: string[]) => string | undefined;
}

function defaultEnv(): Env {
  return {
    platform: process.platform,
    darwinRelease: release(),
    home: homedir(),
    systemApps: '/Applications',
    version: VERSION,
    asset: readAsset(),
    cli: process.argv[1],
    fetch,
    run: (command, args) => {
      try {
        return execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8' });
      } catch {
        return undefined;
      }
    },
  };
}

export async function menubar(args: string[], io: Io = defaultIo, overrides: Partial<Env> = {}): Promise<number> {
  const action = args[0];
  if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
    (action === undefined || action === '--help' || action === '-h' ? io.out : io.err)(`${USAGE}\n`);
    return action === undefined || action === '--help' || action === '-h' ? 0 : 1;
  }

  const env: Env = { ...defaultEnv(), ...overrides };
  if (env.platform !== 'darwin') {
    io.err('\n  The menu bar app is for macOS only.\n\n');
    return 1;
  }

  if (action === 'status') return status(env, io);
  if (action === 'uninstall') return uninstall(env, io);
  return install(env, io);
}

async function install(env: Env, io: Io): Promise<number> {
  if (!supportsApp(env.darwinRelease)) {
    io.err('\n  The menu bar app needs macOS 14 or later.\n\n');
    return 1;
  }
  const { asset } = env;
  if (!asset) {
    io.err(
      '\n  This copy of the tracker was not built by a release, so there is no app published beside it.\n' +
        '  From a source checkout, build the app instead: macos/build.sh install\n\n',
    );
    return 1;
  }

  const url = assetUrl(env.version, asset);
  let bytes: Uint8Array;
  try {
    const response = await env.fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      io.err(`\n  Could not download the app: ${url} answered ${response.status}.\n\n`);
      return 1;
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    io.err(`\n  Could not download the app from ${url}:\n  ${error instanceof Error ? error.message : String(error)}\n\n`);
    return 1;
  }

  const wrong = mismatch(bytes, asset);
  if (wrong) {
    io.err(`\n  Refusing to install what ${url} returned: ${wrong}.\n\n`);
    return 1;
  }

  const target = installPath(env);
  const scratch = mkdtempSync(join(tmpdir(), 'cst-menubar-'));
  try {
    const zip = join(scratch, asset.asset);
    writeFileSync(zip, bytes);
    // ditto, as the release used to pack it: it puts the bundle's symlinks and signature back as they were.
    const unpacked = join(scratch, 'unpacked');
    if (env.run('ditto', ['-x', '-k', zip, unpacked]) === undefined || !existsSync(join(unpacked, APP_NAME))) {
      io.err('\n  The download did not unpack into the app.\n\n');
      return 1;
    }

    const updating = existsSync(target);
    await quit(env);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    if (env.run('ditto', [join(unpacked, APP_NAME), target]) === undefined) {
      io.err(`\n  Could not copy the app to ${target}.\n\n`);
      return 1;
    }
    env.run('open', [target]);

    io.out(
      `\n  ${updating ? 'Updated  ' : 'Installed'}  ${target}  (${env.version})\n\n` +
        '  It is open now: look for the gauge in the menu bar. The widget is in the\n' +
        '  widget gallery under "Claude Code Session Tracker".\n\n' +
        (isOneOff(env.cli)
          ? '  This copy of the tracker was fetched for one run, and the app needs one that\n' +
            '  stays installed. Its panel offers to install it: choose "Install and start".\n\n'
          : '') +
        '  Remove it with: claude-code-session-tracker menubar uninstall\n\n',
    );
    return 0;
  } catch (error) {
    io.err(`\n  Could not install the app to ${target}:\n  ${error instanceof Error ? error.message : String(error)}\n\n`);
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function uninstall(env: Env, io: Io): Promise<number> {
  const installed = appPaths(env).filter((path) => existsSync(path));
  if (installed.length === 0) {
    io.out('\n  The menu bar app is not installed.\n\n');
    return 0;
  }

  await quit(env);
  try {
    for (const path of installed) rmSync(path, { recursive: true });
  } catch (error) {
    io.err(`\n  Could not remove the app:\n  ${error instanceof Error ? error.message : String(error)}\n\n`);
    return 1;
  }
  io.out(`\n  Removed  ${installed.join('\n           ')}\n\n  The tracker itself is still installed.\n\n`);
  return 0;
}

function status(env: Env, io: Io): number {
  const installed = appPaths(env).find((path) => existsSync(path));
  if (!installed) {
    io.out('\n  The menu bar app is not installed. Install it with: claude-code-session-tracker menubar install\n\n');
    return 0;
  }

  const version = env.run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(installed, 'Contents', 'Info.plist')])?.trim();
  const behind = version !== undefined && version !== env.version;
  io.out(
    `\n  Installed  ${installed}${version ? `  (${version})` : ''}\n` +
      (behind ? `\n  This tracker is ${env.version}. Bring the app to the same version with:\n  claude-code-session-tracker menubar install\n` : '') +
      '\n',
  );
  return 0;
}

/** Ask a running copy to quit and wait for it to go, so its files can be replaced under it. */
async function quit(env: Env): Promise<void> {
  // The app's own executable, not its widget's, wherever the bundle was started from.
  const running = (): boolean => env.run('pgrep', ['-f', `${APP_NAME}/Contents/MacOS/`]) !== undefined;
  if (!running()) return;
  env.run('osascript', ['-e', `quit app id "${BUNDLE_ID}"`]);
  for (let tries = 0; tries < 50 && running(); tries++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

function isOneOff(cli: string | undefined): boolean {
  if (cli === undefined) return false;
  try {
    return isOneOffCache(realpathSync(cli));
  } catch {
    return isOneOffCache(cli);
  }
}
