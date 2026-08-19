import type { SessionTokenTotals } from '../../core/types.ts';
import { readLines } from './lines.ts';

/** Matches the cap `detail.ts` reads assistant turns under. */
const MAX_RECORD_BYTES = 256 * 1024;

interface TranscriptRecord {
  type?: unknown;
  message?: unknown;
}

/**
 * Sums real token usage across a whole transcript.
 *
 * One assistant turn is written as one record per content block — a `thinking`
 * block, a `text` block, one per tool call — and *every* one of them repeats the
 * turn's `usage` totals. Summing per record would inflate the numbers by counting
 * the same usage several times over; turns are contiguous, so remembering only the
 * previous one's id is enough to collapse them.
 */
export async function scanTokens(path: string): Promise<SessionTokenTotals> {
  const tokens: SessionTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let previousTurn: string | undefined;

  for await (const line of readLines(path, MAX_RECORD_BYTES)) {
    if (line.truncated) continue;

    const text = line.text.trim();
    if (!text) continue;

    let record: TranscriptRecord;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      record = parsed as TranscriptRecord;
    } catch {
      continue;
    }

    if (record.type !== 'assistant') continue;
    const message = obj(record.message);
    if (!message) continue;

    const turn = str(message.id);
    if (turn !== undefined && turn === previousTurn) continue;
    previousTurn = turn;

    addUsage(tokens, obj(message.usage));
  }

  return tokens;
}

export function addUsage(totals: SessionTokenTotals, usage: Record<string, unknown> | undefined): void {
  if (!usage) return;
  totals.input += num(usage['input_tokens']) ?? 0;
  totals.output += num(usage['output_tokens']) ?? 0;
  totals.cacheRead += num(usage['cache_read_input_tokens']) ?? 0;
  totals.cacheCreate += num(usage['cache_creation_input_tokens']) ?? 0;
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
