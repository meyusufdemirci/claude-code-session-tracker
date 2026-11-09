import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The effort level a running session's model is configured for.
 *
 * Claude Code writes no effort into the transcript or the live record, so the
 * settings files are the only place it can be read from — and they say what a
 * session would get now, not what an ended one ran with. That is why only running
 * sessions are given one. A mid-session `/effort` or a `--effort` flag is invisible
 * here too; this is the configured level, not a recorded one.
 *
 * Files are tried most specific first, as Claude Code layers them: the project's
 * local settings, the project's shared settings, then the user's own. Inside each,
 * a level set for this model beats the file's general `effortLevel`.
 */
export async function readEffort(
  claudeDir: string,
  cwd: string | undefined,
  model: string | undefined,
): Promise<string | undefined> {
  const files = [
    ...(cwd ? [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json')] : []),
    join(claudeDir, 'settings.json'),
  ];
  for (const file of files) {
    const effort = effortIn(await readJson(file), model);
    if (effort) return effort;
  }
  return undefined;
}

/** One settings object's answer: the model's own level, else the general one. */
export function effortIn(settings: unknown, model: string | undefined): string | undefined {
  if (!isObject(settings)) return undefined;
  if (model && isObject(settings.modelSettings)) {
    const perModel = settings.modelSettings;
    // Transcripts record a dated snapshot id as often as the alias settings are keyed by.
    const entry = perModel[model] ?? perModel[model.replace(/-\d{8}$/, '')];
    if (isObject(entry) && typeof entry.effortLevel === 'string' && entry.effortLevel) {
      return entry.effortLevel;
    }
  }
  return typeof settings.effortLevel === 'string' && settings.effortLevel ? settings.effortLevel : undefined;
}

/** A missing or half-written settings file is simply no answer. */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
