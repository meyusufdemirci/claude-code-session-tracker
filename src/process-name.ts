import { existsSync, linkSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isInGuardedFolder } from './autostart.ts';

/**
 * Giving the running server the project's name in port and process lists.
 *
 * `process.title` reaches `ps`, but `lsof`, Activity Monitor and `top` name a
 * program by the file it was started from, which for `npx` and every other way of
 * running the tracker is `node`. So the server starts itself again, in place, from
 * a hard link to node named after the project — what the login launcher does too
 * (see `buildLauncherScript`).
 *
 * Homebrew's node loads `libnode` from `../lib` beside its own file, which a link
 * elsewhere does not have, so on macOS dyld is pointed at that folder; elsewhere
 * such a node is left as it is. So is a copy in a folder macOS guards, which would
 * refuse the link as a new program, and a node too old for `process.execve`.
 */

export const PROCESS_NAME = 'claude-code-session-tracker';

/** Holds dyld's fallback path as it was before the link's was added, so the server can put it back. */
const LIB_MARKER = 'CLAUDE_CODE_SESSION_TRACKER_LIB';

export function linkDir(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (platform === 'darwin') return join(home, 'Library', 'Caches', PROCESS_NAME);
  if (platform === 'linux') return join(env['XDG_CACHE_HOME'] || join(home, '.cache'), PROCESS_NAME);
  return undefined;
}

export interface Relaunch {
  file: string;
  env: Record<string, string | undefined>;
}

/** The link to run and the environment to run it with, or undefined to stay as node. */
export function prepareRelaunch(
  node: string,
  dir: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): Relaunch | undefined {
  const real = safeRealpath(node);
  const lib = join(dirname(real), '..', 'lib');
  const shared = hasLibnode(lib);
  if (shared && platform !== 'darwin') return undefined;

  const link = join(dir, PROCESS_NAME);
  if (!sameFile(link, real)) {
    // Linked under a temporary name and renamed over, so a server already running
    // from the old link keeps its file and a second one never sees a half-made link.
    const temp = `${link}.${process.pid}`;
    try {
      mkdirSync(dir, { recursive: true });
      rmSync(temp, { force: true });
      linkSync(real, temp);
      renameSync(temp, link);
    } catch {
      try {
        rmSync(temp, { force: true });
      } catch {
        // Nothing was made where nothing could be.
      }
      return undefined;
    }
  }

  if (!shared) return { file: link, env };
  // Someone else's fallback path is theirs to keep; ours goes after it.
  const fallback = env['DYLD_FALLBACK_LIBRARY_PATH'] ?? '';
  return { file: link, env: { ...env, DYLD_FALLBACK_LIBRARY_PATH: fallback ? `${fallback}:${lib}` : lib, [LIB_MARKER]: fallback } };
}

/** Starts this server again from the link, or returns to carry on as node. */
export function relaunchUnderOwnName(argv: string[], cli: string | undefined = process.argv[1]): void {
  if (basename(process.execPath) === PROCESS_NAME) {
    forgetLibraryPath(process.env);
    return;
  }

  const dir = linkDir();
  if (cli === undefined || dir === undefined || process.execve === undefined || isInGuardedFolder(cli)) return;

  const relaunch = prepareRelaunch(process.execPath, dir);
  if (relaunch === undefined) return;
  try {
    process.execve(relaunch.file, [relaunch.file, ...process.execArgv, cli, ...argv], relaunch.env);
  } catch {
    // The link would not start; node runs it as before.
  }
}

/** What the server starts — the browser, a detached copy — should not inherit dyld's path. */
export function forgetLibraryPath(env: Record<string, string | undefined>): void {
  const before = env[LIB_MARKER];
  if (before === undefined) return;
  delete env[LIB_MARKER];
  if (before) env['DYLD_FALLBACK_LIBRARY_PATH'] = before;
  else delete env['DYLD_FALLBACK_LIBRARY_PATH'];
}

function hasLibnode(lib: string): boolean {
  try {
    return readdirSync(lib).some((name) => name.startsWith('libnode.'));
  } catch {
    return false;
  }
}

function sameFile(a: string, b: string): boolean {
  if (!existsSync(a)) return false;
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.ino === right.ino && left.dev === right.dev;
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
