import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TrackerConfig } from '../../config.ts';
import type { FileCache } from '../../core/cache.ts';
import type {
  Session,
  SessionContextDetail,
  SessionCounts,
  SessionDetail,
  SessionDetailNotes,
  SessionPromptUsage,
  SessionTokenTotals,
} from '../../core/types.ts';
import { buildContext, staticSliceOf, type StaticSlice } from './context.ts';
import { readLines } from './lines.ts';
import { findCandidate, loadSession, promptText, type Candidate } from './transcripts.ts';
import { addUsage } from './usage.ts';

/**
 * The largest single record we will hold in memory.
 *
 * Measured over 232,700 records in 838 MB: every record above this size is a tool
 * result, an attachment, or a meta record — never an assistant turn, whose largest
 * example anywhere in the corpus is 87 KB. So the cap costs us nothing we count,
 * while keeping a 37 MB transcript (four of whose records are ~9 MB each) from
 * deciding how much memory this process uses.
 */
const MAX_RECORD_BYTES = 256 * 1024;

/** `<sessionId>/subagents/agent-*.jsonl`. The `.meta.json` sidecars are not transcripts. */
const SUBAGENT_FILE = /^agent-.+\.jsonl$/;

/** Claude Code's stand-in on messages it produced itself. Not a model anyone chose. */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Everything about one session, from a full read of its transcript.
 *
 * The listing deliberately never opens the middle of a file; this is the one place
 * that does, which is why it is only ever reached by an explicit request for a
 * single session.
 */
export async function readDetail(
  config: TrackerConfig,
  id: string,
  sessions: FileCache<Session>,
  details: FileCache<SessionDetail>,
): Promise<SessionDetail | null> {
  const candidate = await findCandidate(config.projectsDir, id);
  if (!candidate) return null;

  const base = await loadSession(candidate, sessions);
  if (!base) return null;

  // Keyed on the file's size and mtime, so re-opening a panel on a finished session
  // costs nothing, while a session still being written to is always re-read.
  const cached = details.get(candidate.path, candidate);
  if (cached) return cached;

  const detail: SessionDetail = { ...base, ...(await scan(candidate)) };
  details.set(candidate.path, candidate, detail);
  return detail;
}

interface Stats {
  counts: SessionCounts;
  tokens: SessionTokenTotals;
  models: string[];
  awaySummary?: string;
  activeMs?: number;
  promptUsage: SessionPromptUsage[];
  notes: SessionDetailNotes;
  context?: SessionContextDetail;
}

async function scan(candidate: Candidate): Promise<Stats> {
  const counts: SessionCounts = { user: 0, assistant: 0, tool: 0, subagents: 0 };
  const tokens: SessionTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  // A Set keeps first-seen order, which is the order a reader expects: the model the
  // session opened with, then whatever it was switched to.
  const models = new Set<string>();
  const notes: SessionDetailNotes = { unreadable: 0, oversized: 0 };

  let awaySummary: string | undefined;
  let activeMs = 0;
  let sawTurnDuration = false;
  /**
   * The turn the previous record belonged to.
   *
   * One assistant turn is written as one record per content block — a `thinking`
   * block, a `text` block, one per tool call — and *every* one of them repeats the
   * turn's `usage` totals. Summing per record inflates tokens by ~88% across this
   * machine's corpus (90,387 records for 48,024 turns). The records of a turn are
   * contiguous in all 48,024 cases, so remembering the previous id is enough to
   * collapse them — no set of every id in the file, no memory that grows with length.
   */
  let previousTurn: string | undefined;

  // The context section reads only these two snapshots, not the running `tokens`
  // total: the first turn's usage stands in for the static system/tools/skills/agents
  // block, and the last turn's usage is what the window holds right now. `lastModel`
  // tracks the most recently seen one regardless of `models`' first-seen order, since
  // it decides which context window the last turn was actually working inside.
  let firstTurnUsage: SessionTokenTotals | undefined;
  let lastTurnUsage: SessionTokenTotals | undefined;
  let lastModel: string | undefined;

  /**
   * The memory files and listings that went into the window before anything ran.
   *
   * Only the ones written *ahead of the first turn* belong to the static block —
   * those are what its cache write paid for. Claude Code goes on emitting the same
   * attachment types later, as the session reaches a directory with its own
   * `CLAUDE.md`, and those are conversation growth rather than the standing cost.
   */
  const staticSlices: StaticSlice[] = [];

  // Every real user record opens a new bucket; the assistant turns that follow it,
  // up to the next one, are what it cost. Pushed to `promptUsage` as each closes.
  const promptUsage: SessionPromptUsage[] = [];
  let currentPrompt: SessionPromptUsage | undefined;

  for await (const line of readLines(candidate.path, MAX_RECORD_BYTES)) {
    if (line.truncated) {
      notes.oversized += 1;
      continue;
    }

    const text = line.text.trim();
    if (!text) continue;

    let record: TranscriptRecord;
    try {
      const parsed: unknown = JSON.parse(text);
      // Valid JSON is not necessarily a record. An array or a bare `null` parses
      // happily and would otherwise be counted as a record with no fields.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not a record');
      }
      record = parsed as TranscriptRecord;
    } catch {
      // The format is private and will change under us. One record we cannot read is
      // a note in the margin, not a failed request.
      notes.unreadable += 1;
      continue;
    }

    switch (str(record.type)) {
      case 'assistant': {
        const message = obj(record.message);
        if (!message) break;

        const turn = str(message.id);
        // An unidentified record cannot be folded into anything, so it stands alone.
        if (turn === undefined || turn !== previousTurn) {
          previousTurn = turn;
          counts.assistant += 1;
          addUsage(tokens, obj(message.usage));
          if (currentPrompt) addUsage(currentPrompt.tokens, obj(message.usage));

          const turnUsage: SessionTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
          addUsage(turnUsage, obj(message.usage));
          firstTurnUsage ??= turnUsage;
          lastTurnUsage = turnUsage;
        }

        const model = str(message.model);
        if (model && model !== SYNTHETIC_MODEL) {
          models.add(model);
          lastModel = model;
        }
        counts.tool += countBlocks(message.content, 'tool_use');
        break;
      }

      case 'user':
        if (isUserMessage(record)) {
          counts.user += 1;
          if (currentPrompt) promptUsage.push(currentPrompt);
          currentPrompt = {
            text: promptText(record) ?? '(no text)',
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
          };
        }
        break;

      case 'attachment': {
        if (firstTurnUsage) break;
        const slice = staticSliceOf(record.attachment);
        if (slice) staticSlices.push(slice);
        break;
      }

      case 'system': {
        switch (str(record.subtype)) {
          case 'away_summary':
            // Rewritten as the session goes on; the last one is the current recap.
            awaySummary = str(record.content) ?? awaySummary;
            break;
          case 'turn_duration': {
            const ms = num(record.durationMs);
            if (ms !== undefined && ms > 0) {
              activeMs += ms;
              sawTurnDuration = true;
            }
            break;
          }
        }
        break;
      }
    }
  }

  counts.subagents = await countSubagents(candidate);
  if (currentPrompt) promptUsage.push(currentPrompt);
  promptUsage.sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens));

  return {
    counts,
    tokens,
    models: [...models],
    ...(awaySummary ? { awaySummary } : {}),
    // Zero and "never recorded" are different answers; only report a number we saw.
    ...(sawTurnDuration ? { activeMs } : {}),
    promptUsage,
    notes,
    ...(lastTurnUsage ? { context: buildContext(firstTurnUsage, lastTurnUsage, lastModel, staticSlices) } : {}),
  };
}

function totalTokens(tokens: SessionTokenTotals): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
}

/**
 * Sub-agents write their own transcripts beside the session's, one file per agent.
 * Counting the files is the whole measurement — nothing in them is opened.
 */
async function countSubagents(candidate: Candidate): Promise<number> {
  try {
    const names = await readdir(join(dirname(candidate.path), candidate.id, 'subagents'));
    return names.filter((name) => SUBAGENT_FILE.test(name)).length;
  } catch {
    // No folder means no sub-agents, which is the common case.
    return 0;
  }
}

/**
 * Did the user say something here, or is this the transcript stitching the
 * conversation back together?
 *
 * Tool results are written as `user` records and outnumber real messages ten to one
 * (54,043 against 4,628 on this machine), so counting records rather than messages
 * would report a number an order of magnitude too large.
 */
function isUserMessage(record: TranscriptRecord): boolean {
  if (record.isMeta === true || record.isSidechain === true) return false;

  const content = obj(record.message)?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => typeof block === 'object' && block !== null && str((block as Block).type) !== 'tool_result',
  );
}

function countBlocks(content: unknown, type: string): number {
  if (!Array.isArray(content)) return 0;
  let found = 0;
  for (const block of content) {
    if (typeof block === 'object' && block !== null && str((block as Block).type) === type) found += 1;
  }
  return found;
}

interface Block {
  type?: unknown;
}

/** As in the listing: every field is `unknown`, because the format is not ours. */
interface TranscriptRecord {
  type?: unknown;
  subtype?: unknown;
  attachment?: unknown;
  content?: unknown;
  durationMs?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: unknown;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
