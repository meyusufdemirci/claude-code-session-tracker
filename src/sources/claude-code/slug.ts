import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** The characters `pathToSlug` flattens into `-`, and therefore cannot tell apart. */
const FLATTENED = /[/._]/g;

/**
 * How far a slug walk may wander before giving up.
 *
 * A correct walk visits one directory per path segment. The budget only exists so
 * that a slug full of dashes cannot turn a fallback into a filesystem crawl.
 */
const WALK_BUDGET = 64;

/**
 * Encode an absolute path the way Claude Code names its project folders under
 * `~/.claude/projects`: every `/`, `.` and `_` becomes `-`.
 *
 * The mapping is lossy — `Timfog-FS` and `Timfog/FS` collapse to the same slug —
 * so a session's real `cwd` is always preferred over decoding. `resolveSlugPath`
 * below is only the fallback for a transcript that records no `cwd` at all.
 */
export function pathToSlug(path: string): string {
  return path.replace(FLATTENED, '-');
}

/** Display name for a project: the directory basename, falling back to the path. */
export function projectNameFromPath(path: string): string {
  return basename(path) || path;
}

/**
 * Turn a project folder name back into the directory it was made from.
 *
 * Decoding is ambiguous on its own — `-a-b` could be `/a/b`, `/a.b`, `/a_b` or a
 * directory literally called `a-b` — so instead of guessing we walk the real
 * filesystem and let it settle the ambiguity: at each level we look for entries
 * whose own slug matches the tokens we still have to place. Longest match first,
 * because `Tivi-FE` should win over `Tivi` when both exist.
 *
 * Everything about this is best-effort. When the walk finds nothing (the project
 * has been moved or deleted, or we are on a platform that slugs paths differently)
 * we hand back the naive `-` → `/` reading, which is at least recognisable.
 */
export async function resolveSlugPath(slug: string): Promise<string> {
  const tokens = slug.split('-');
  // A leading empty token is the root `/`. Without one this is not a path we encoded.
  if (tokens[0] === '') {
    const found = await walk('/', tokens.slice(1), { remaining: WALK_BUDGET });
    if (found) return found;
  }
  return slugToPathGuess(slug);
}

/** The unvalidated reading: every `-` was a `/`. Wrong for real dashes, but legible. */
export function slugToPathGuess(slug: string): string {
  return slug.replace(/-/g, '/') || slug;
}

async function walk(
  dir: string,
  tokens: string[],
  budget: { remaining: number },
): Promise<string | undefined> {
  if (tokens.length === 0) return dir;
  if (budget.remaining-- <= 0) return undefined;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Not a directory, or not ours to read — this branch of the walk is dead.
    return undefined;
  }

  const matches: { entry: string; tokens: number }[] = [];
  for (const entry of entries) {
    const asSlug = pathToSlug(entry);
    const width = asSlug.split('-').length;
    if (width <= tokens.length && tokens.slice(0, width).join('-') === asSlug) {
      matches.push({ entry, tokens: width });
    }
  }
  matches.sort((a, b) => b.tokens - a.tokens);

  for (const match of matches) {
    const found = await walk(join(dir, match.entry), tokens.slice(match.tokens), budget);
    if (found) return found;
  }
  return undefined;
}
