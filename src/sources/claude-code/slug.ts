import { basename } from 'node:path';

/**
 * Encode an absolute path the way Claude Code names its project folders under
 * `~/.claude/projects`: every `/`, `.` and `_` becomes `-`.
 *
 * The mapping is lossy — `Timfog-FS` and `Timfog/FS` collapse to the same slug —
 * so it is only ever used in this direction. Decoding a slug back to a path is a
 * Phase 2 problem, solved there by reading the `cwd` recorded inside transcripts.
 */
export function pathToSlug(path: string): string {
  return path.replace(/[/._]/g, '-');
}

/** Display name for a project: the directory basename, falling back to the path. */
export function projectNameFromPath(path: string): string {
  return basename(path) || path;
}
