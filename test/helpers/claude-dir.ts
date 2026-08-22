import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createConfig, type TrackerConfig } from '../../src/config.ts';
import { pathToSlug } from '../../src/sources/claude-code/slug.ts';
import { writeTranscript } from './records.ts';
import { tempDir } from './temp.ts';

/**
 * A throwaway `~/.claude` — the directory layout the whole source adapter reads.
 *
 * Built from `createConfig` rather than by hand so a test can never disagree with
 * the code about where a transcript lives.
 */
export interface ClaudeHome {
  config: TrackerConfig;
  /** Writes `<projects>/<slug for cwd>/<id>.jsonl`. Returns its path. */
  transcript(cwd: string, id: string, lines: readonly string[]): Promise<string>;
  /**
   * Writes `<projects>/<slug>/<sessionId>/subagents/<name>.jsonl`.
   *
   * Not a session — nothing lists these — but their turns are billed to the same
   * window as the session that spawned them, so anything counting tokens has to
   * find them.
   */
  subagent(cwd: string, sessionId: string, name: string, lines: readonly string[]): Promise<string>;
  /** Writes `<sessions>/<pid>.json`, the live registry's record. Returns its path. */
  liveRecord(pid: number, value: unknown): Promise<string>;
  /**
   * Writes the account file, where Claude Code caches its own usage readout.
   *
   * Given a reset, it holds a `cachedUsageUtilization` block pinning the all-models
   * weekly clock; given a string, it holds that verbatim, for the tests about a file
   * that says something else or nothing at all.
   */
  accountFile(value: { weeklyResetsAt: number } | string): Promise<string>;
}

export async function claudeHome(t: TestContext): Promise<ClaudeHome> {
  const root = await tempDir(t);
  const config = createConfig({ claudeDir: join(root, '.claude') });
  await mkdir(config.projectsDir, { recursive: true });
  await mkdir(config.sessionsDir, { recursive: true });

  return {
    config,
    transcript: (cwd, id, lines) =>
      writeTranscript(join(config.projectsDir, pathToSlug(cwd)), `${id}.jsonl`, lines),
    subagent: (cwd, sessionId, name, lines) =>
      writeTranscript(
        join(config.projectsDir, pathToSlug(cwd), sessionId, 'subagents'),
        `${name}.jsonl`,
        lines,
      ),
    accountFile: async (value) => {
      await writeFile(
        config.claudeJsonPath,
        typeof value === 'string' ? value : JSON.stringify(utilization(value.weeklyResetsAt)),
      );
      return config.claudeJsonPath;
    },
    liveRecord: async (pid, value) => {
      const path = join(config.sessionsDir, `${pid}.json`);
      await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
      return path;
    },
  };
}

/** The shape Claude Code caches its usage readout in, cut down to what is read. */
function utilization(weeklyResetsAt: number): unknown {
  return {
    cachedUsageUtilization: {
      fetchedAtMs: weeklyResetsAt,
      utilization: {
        seven_day: { utilization: 42, resets_at: new Date(weeklyResetsAt).toISOString() },
        // The per-model weeks sit right beside it, and are not this limit's clock.
        seven_day_opus: null,
      },
    },
  };
}

/**
 * Session ids are uuids and the transcript reader will not look at a file whose
 * name is not one, so tests need real-shaped ones rather than `s1`.
 */
export function sessionId(n: number): string {
  const tail = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}
