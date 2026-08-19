import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Everything the tool needs to know about where things live and how to serve them. */
export interface TrackerConfig {
  /** Root of the Claude Code data directory (usually `~/.claude`). */
  claudeDir: string;
  /** `<claudeDir>/sessions` — one JSON file per running session, keyed by pid. */
  sessionsDir: string;
  /** `<claudeDir>/projects` — one folder per project, holding `<sessionId>.jsonl` transcripts. */
  projectsDir: string;
  /** `~/.claude.json` — per-project rollup metrics. */
  claudeJsonPath: string;
  host: string;
  port: number;
}

export const DEFAULT_PORT = 4747;
export const DEFAULT_HOST = '127.0.0.1';

/**
 * Resolve the Claude Code data directory.
 *
 * `CLAUDE_CONFIG_DIR` wins when set. Some Claude Code versions accept a
 * comma-separated list there, so we take the first entry.
 */
export function resolveClaudeDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env['CLAUDE_CONFIG_DIR']?.split(',')[0]?.trim();
  if (fromEnv) return resolve(fromEnv);
  return join(homedir(), '.claude');
}

export function createConfig(
  overrides: Partial<Pick<TrackerConfig, 'claudeDir' | 'host' | 'port'>> = {},
): TrackerConfig {
  const claudeDir = overrides.claudeDir ? resolve(overrides.claudeDir) : resolveClaudeDir();
  return {
    claudeDir,
    sessionsDir: join(claudeDir, 'sessions'),
    projectsDir: join(claudeDir, 'projects'),
    claudeJsonPath: join(homedir(), '.claude.json'),
    host: overrides.host ?? DEFAULT_HOST,
    port: overrides.port ?? DEFAULT_PORT,
  };
}
