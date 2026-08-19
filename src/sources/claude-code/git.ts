import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** A session's cwd can be nested a few levels below the repo root. */
const MAX_WALK_UP = 32;

/**
 * Current branch for a working directory, read straight from `.git/HEAD`.
 *
 * A live session shows the branch it is on *now*, so we read the repository
 * rather than the transcript — the transcript only knows the branch as of its
 * last recorded message. Two small reads, no `git` subprocess.
 *
 * Everything here is best-effort: not a repo, a bare `.git`, a detached HEAD
 * mid-rebase — each just means no branch to show.
 */
export async function readGitBranch(cwd: string): Promise<string | undefined> {
  const gitDir = await findGitDir(cwd);
  if (!gitDir) return undefined;

  const head = (await readTextFile(join(gitDir, 'HEAD')))?.trim();
  if (!head) return undefined;

  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  if (ref?.[1]) return ref[1].trim();

  // Detached HEAD: the raw commit is more useful than showing nothing.
  const sha = /^[0-9a-f]{40}$/i.exec(head);
  return sha ? `${sha[0].slice(0, 7)} (detached)` : undefined;
}

/** Walk up looking for `.git`, following the `gitdir:` pointer a worktree leaves. */
async function findGitDir(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd);

  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    const dotGit = join(dir, '.git');
    const info = await statSafe(dotGit);

    if (info?.isDirectory()) return dotGit;

    if (info?.isFile()) {
      // `.git` is a file only in a worktree or submodule, where it points elsewhere.
      const contents = (await readTextFile(dotGit))?.trim() ?? '';
      const pointer = /^gitdir:\s*(.+)$/m.exec(contents)?.[1]?.trim();
      if (pointer) return isAbsolute(pointer) ? pointer : resolve(dir, pointer);
      return undefined;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return undefined;
}

async function statSafe(path: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
