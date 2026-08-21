import { deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addUsage, scanTokens } from '../../../src/sources/claude-code/usage.ts';
import type { SessionTokenTotals } from '../../../src/core/types.ts';
import { assistantRecord, record, userRecord, writeTranscript } from '../../helpers/records.ts';
import { tempDir } from '../../helpers/temp.ts';

const ZERO: SessionTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

describe('scanTokens', () => {
  it('counts one turn once, however many records wrote it', async (t) => {
    // The bug this module exists to prevent: Claude Code writes a record per content
    // block — thinking, text, one per tool call — and every one repeats the turn's
    // totals. Summing per record inflated the real numbers by ~88%.
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'turn.jsonl', [
      assistantRecord({ id: 'msg_1', usage: { input: 100, output: 20 } }),
      assistantRecord({ id: 'msg_1', usage: { input: 100, output: 20 } }),
      assistantRecord({ id: 'msg_1', usage: { input: 100, output: 20 } }),
    ]);

    deepStrictEqual(await scanTokens(path), {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheCreate: 0,
    });
  });

  it('sums turns that differ', async (t) => {
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'turns.jsonl', [
      assistantRecord({ id: 'msg_1', usage: { input: 100, output: 20, cacheRead: 5 } }),
      assistantRecord({ id: 'msg_2', usage: { input: 200, output: 30, cacheCreate: 7 } }),
    ]);

    deepStrictEqual(await scanTokens(path), {
      input: 300,
      output: 50,
      cacheRead: 5,
      cacheCreate: 7,
    });
  });

  it('only collapses records that are next to each other', async (t) => {
    // The de-dup remembers one id, not a set, because on every one of the 48,024
    // turns measured the records of a turn were contiguous. This test is the
    // boundary of that claim: if the format ever interleaves turns, it goes red.
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'split.jsonl', [
      assistantRecord({ id: 'msg_1', usage: { input: 100 } }),
      assistantRecord({ id: 'msg_2', usage: { input: 200 } }),
      assistantRecord({ id: 'msg_1', usage: { input: 100 } }),
    ]);

    deepStrictEqual((await scanTokens(path)).input, 400);
  });

  it('ignores records that are not assistant turns', async (t) => {
    // Tool results are `user` records and outnumber real messages ten to one.
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'mixed.jsonl', [
      userRecord('hello'),
      record({ type: 'system', subtype: 'away_summary', content: 'did things' }),
      record({ type: 'file-history-snapshot' }),
      assistantRecord({ id: 'msg_1', usage: { input: 10, output: 1 } }),
    ]);

    deepStrictEqual(await scanTokens(path), { input: 10, output: 1, cacheRead: 0, cacheCreate: 0 });
  });

  it('skips malformed lines instead of throwing', async (t) => {
    // The format is private and will change under us; a bad line is a line to step
    // over, never a reason to lose the session.
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'broken.jsonl', [
      'not json at all',
      '{"type":"assistant","message":',
      '[]',
      'null',
      '',
      '   ',
      assistantRecord({ id: 'msg_1', usage: { input: 10 } }),
    ]);

    deepStrictEqual((await scanTokens(path)).input, 10);
  });

  it('reads a turn that recorded no usage as zero', async (t) => {
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'nousage.jsonl', [
      assistantRecord({ id: 'msg_1', noUsage: true }),
      record({ type: 'assistant', message: { id: 'msg_2', usage: { input_tokens: 'lots' } } }),
    ]);

    deepStrictEqual(await scanTokens(path), ZERO);
  });

  it('passes over a record too large to hold', async (t) => {
    // Anything above the 256 KB cap is a tool result, an attachment, or a meta
    // record — the largest assistant record ever measured was 87 KB — so a capped
    // line is not a turn we are missing.
    const dir = await tempDir(t);
    const path = await writeTranscript(dir, 'oversized.jsonl', [
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', usage: { input_tokens: 999 }, padding: 'x'.repeat(300 * 1024) },
      }),
      assistantRecord({ id: 'msg_2', usage: { input: 10 } }),
    ]);

    deepStrictEqual((await scanTokens(path)).input, 10);
  });
});

describe('addUsage', () => {
  it('adds the real key names into our own', () => {
    const totals: SessionTokenTotals = { ...ZERO };
    addUsage(totals, {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    });

    deepStrictEqual(totals, { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 });
  });

  it('leaves totals alone when there is no usage to add', () => {
    const totals: SessionTokenTotals = { ...ZERO };
    addUsage(totals, undefined);
    addUsage(totals, { input_tokens: null, output_tokens: Number.NaN });

    deepStrictEqual(totals, ZERO);
  });
});
