import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Builders for the transcript records the readers care about.
 *
 * The `.jsonl` format is private and undocumented, so these shapes are the test
 * suite's written-down copy of what was observed on a real machine. When Claude
 * Code changes the format, the honest failure is a test here going red — which is
 * the whole reason the fixtures are built from named helpers rather than pasted
 * JSON blobs spread across the files.
 */

/** Token counts in our names; the builders write them under the real keys. */
export interface UsageCounts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
}

/** The fields every record type may carry alongside its own. */
export interface CommonFields {
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

export interface AssistantOptions extends CommonFields {
  /** `message.id`. One turn is written as several records that all repeat this. */
  id?: string;
  model?: string;
  usage?: UsageCounts;
  /** Omits the `usage` object entirely, as a turn that recorded none would. */
  noUsage?: boolean;
  /** How many `tool_use` blocks this record's content holds. */
  toolUses?: number;
  /** Assistant text, written as a `text` block beside any tool calls. */
  text?: string;
}

/**
 * One `assistant` record — that is, one *content block* of an assistant turn.
 *
 * Claude Code writes a record per block (the thinking, the text, one per tool
 * call) and every one of them repeats the turn's totals, so several records
 * sharing an `id` describe one turn's usage, not several.
 */
export function assistantRecord(options: AssistantOptions = {}): string {
  const { id = 'msg_1', model = 'claude-opus-5', usage = {}, noUsage = false } = options;
  const content: unknown[] = [];
  if (options.text) content.push({ type: 'text', text: options.text });
  for (let i = 0; i < (options.toolUses ?? 0); i += 1) {
    content.push({ type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: {} });
  }

  return record({
    type: 'assistant',
    ...common(options),
    message: {
      id,
      role: 'assistant',
      model,
      ...(content.length > 0 ? { content } : {}),
      ...(noUsage ? {} : { usage: usageKeys(usage) }),
    },
  });
}

export interface UserOptions extends CommonFields {
  /** Records the transcript wrote itself — the `/clear` caveat, pasted context. */
  isMeta?: boolean;
  /** A sub-agent's message, replayed into the parent transcript. */
  isSidechain?: boolean;
  /** Writes `content` as a block list rather than a plain string. */
  asBlocks?: boolean;
}

/** A `user` record carrying something the user actually typed. */
export function userRecord(text: string, options: UserOptions = {}): string {
  return record({
    type: 'user',
    ...common(options),
    ...(options.isMeta ? { isMeta: true } : {}),
    ...(options.isSidechain ? { isSidechain: true } : {}),
    message: {
      role: 'user',
      content: options.asBlocks ? [{ type: 'text', text }] : text,
    },
  });
}

/**
 * A tool result, which Claude Code also writes as a `user` record.
 *
 * These outnumber real messages ten to one, so every reader has to tell them
 * apart from something a person typed.
 */
export function toolResultRecord(text = 'ok', options: CommonFields = {}): string {
  return record({
    type: 'user',
    ...common(options),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: text }],
    },
  });
}

/** A `system` record — `away_summary`, `turn_duration`, and the rest. */
export function systemRecord(
  options: CommonFields & { subtype: string; content?: string; durationMs?: number },
): string {
  const { subtype, content, durationMs } = options;
  return record({
    type: 'system',
    subtype,
    ...common(options),
    ...(content !== undefined ? { content } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
}

/** The human-readable title, rewritten on every turn rather than amended. */
export function titleRecord(aiTitle: string, options: CommonFields = {}): string {
  return record({ type: 'ai-title', ...common(options), aiTitle });
}

/**
 * `last-prompt`, in either of its two shapes.
 *
 * 71 of 790 transcripts carry only a `leafUuid`, and that uuid points at the leaf
 * of the conversation tree — often an attachment rather than the prompt — so a
 * reader has to fall back to the last real user message instead of chasing it.
 */
export function lastPromptRecord(
  options: CommonFields & { lastPrompt?: string; leafUuid?: string } = {},
): string {
  const { lastPrompt, leafUuid } = options;
  return record({
    type: 'last-prompt',
    ...common(options),
    ...(lastPrompt !== undefined ? { lastPrompt } : {}),
    ...(leafUuid !== undefined ? { leafUuid } : {}),
  });
}

/** A slash command as the transcript wraps it: plumbing, not something typed. */
export function commandRecord(name: string, args?: string, options: UserOptions = {}): string {
  const body =
    `<command-name>${name}</command-name>` +
    (args === undefined ? '' : `<command-args>${args}</command-args>`) +
    '<command-message>running</command-message>';
  return userRecord(body, options);
}

/** Any other record type, spelled out where a test needs one. */
export function record(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function common(options: CommonFields): Record<string, unknown> {
  return {
    ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.gitBranch !== undefined ? { gitBranch: options.gitBranch } : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
  };
}

/** The real `usage` key names, kept in exactly one place. */
function usageKeys(counts: UsageCounts): Record<string, number> {
  return {
    input_tokens: counts.input ?? 0,
    output_tokens: counts.output ?? 0,
    cache_read_input_tokens: counts.cacheRead ?? 0,
    cache_creation_input_tokens: counts.cacheCreate ?? 0,
  };
}

export interface TranscriptOptions {
  /**
   * Whether the file ends in a newline. A session still being written to does not,
   * and its last record is usually the interesting one.
   */
  trailingNewline?: boolean;
}

/** Writes `lines` as a `.jsonl` transcript and returns its path. */
export async function writeTranscript(
  dir: string,
  name: string,
  lines: readonly string[],
  options: TranscriptOptions = {},
): Promise<string> {
  const target = join(dir, name);
  await mkdir(dirname(target), { recursive: true });
  const body = lines.join('\n') + (options.trailingNewline === false ? '' : '\n');
  await writeFile(target, body);
  return target;
}
