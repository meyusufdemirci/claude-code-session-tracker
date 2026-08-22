import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileCache } from '../../../src/core/cache.ts';
import {
  billedTokens,
  readUsageLimits,
  type UsageBucket,
} from '../../../src/sources/claude-code/limits.ts';
import { claudeHome, sessionId } from '../../helpers/claude-dir.ts';
import { assistantRecord, rejectionRecord, userRecord } from '../../helpers/records.ts';

const CWD = '/Users/y/Work/app';

/**
 * A fixed day, so every window boundary in here is one an eye can check.
 *
 * UTC on purpose: the reader floors to the half hour in absolute time, and a test
 * that read the machine's timezone would pass or fail depending on where it ran.
 */
const DAY = '2026-01-05';
const iso = (clock: string): string => `${DAY}T${clock}:00.000Z`;
const at = (clock: string): number => Date.parse(iso(clock));

const cache = (): FileCache<UsageBucket[]> => new FileCache<UsageBucket[]>();

describe('readUsageLimits', () => {
  it('floors a window to the half hour below its first turn', async (t) => {
    // Calibrated against a real refusal: the first turn landed at 08:37:29 and
    // Claude reported the window resetting at 13:30 — five hours from 08:30.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      userRecord('go', { timestamp: iso('08:37') }),
      assistantRecord({ id: 'msg_1', timestamp: iso('08:37'), usage: { output: 10 } }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('09:00'));

    strictEqual(limits.current?.startedAt, at('08:30'));
    strictEqual(limits.current?.resetsAt, at('13:30'));
    strictEqual(limits.current?.resetsAtIsReported, false);
  });

  it('sums the turns inside the window, cache reads kept apart', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({
        id: 'msg_1',
        timestamp: iso('08:40'),
        usage: { input: 5, output: 10, cacheRead: 900, cacheCreate: 20 },
      }),
      assistantRecord({
        id: 'msg_2',
        timestamp: iso('09:10'),
        usage: { input: 3, output: 7, cacheRead: 100, cacheCreate: 30 },
      }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('09:30'));

    strictEqual(limits.current?.turns, 2);
    deepStrictEqual(limits.current?.tokens, {
      input: 8,
      output: 17,
      cacheRead: 1_000,
      cacheCreate: 50,
    });
    // The cache reads dwarf the rest and are billed at a fraction of it, so the
    // number a window is sized by leaves them out.
    strictEqual(billedTokens(limits.current?.tokens), 75);
  });

  it('counts one turn once, however many records wrote it', async (t) => {
    // The same collapse `scanTokens` makes: a turn is written as one record per
    // content block and every one of them repeats the turn's totals.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 10 } }),
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 10 } }),
      assistantRecord({ id: 'msg_1', timestamp: iso('08:41'), usage: { output: 10 } }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('09:00'));

    strictEqual(limits.current?.turns, 1);
    strictEqual(limits.current?.tokens.output, 10);
  });

  it('bills a subagent to the window that spawned it', async (t) => {
    // Subagent transcripts live in a folder beside the session's own and are not
    // sessions, so nothing else in the tool looks at them — but their turns are
    // billed to the same five hours.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 10 } }),
    ]);
    await home.subagent(CWD, sessionId(1), 'agent-abc', [
      assistantRecord({ id: 'msg_sub', timestamp: iso('08:45'), usage: { output: 40 } }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('09:00'));

    strictEqual(limits.current?.turns, 2);
    strictEqual(limits.current?.tokens.output, 50);
  });

  it('opens a fresh window once the old one has emptied', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 100 } }),
      // Past 13:30, so this turn cannot belong to the window the first one opened.
      assistantRecord({ id: 'msg_2', timestamp: iso('14:05'), usage: { output: 7 } }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('15:00'));

    strictEqual(limits.current?.startedAt, at('14:00'));
    strictEqual(limits.current?.tokens.output, 7);
    // The morning's window has closed, which is what makes it a yardstick.
    strictEqual(limits.reference?.startedAt, at('08:30'));
    strictEqual(limits.reference?.tokens.output, 100);
  });

  it('chains one window straight into the next through continuous work', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 1 } }),
      assistantRecord({ id: 'msg_2', timestamp: iso('12:00'), usage: { output: 1 } }),
      // Inside no gap at all, but past 13:30 — so a second window, starting where
      // the first one ended rather than five hours after this turn.
      assistantRecord({ id: 'msg_3', timestamp: iso('13:35'), usage: { output: 1 } }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('14:00'));

    strictEqual(limits.current?.startedAt, at('13:30'));
    strictEqual(limits.current?.resetsAt, at('18:30'));
    strictEqual(limits.current?.turns, 1);
    strictEqual(limits.reference?.turns, 2);
  });

  it('takes Claude’s own reset time off a refusal', async (t) => {
    // The one moment Claude tells us where the window really ends. It beats our
    // own arithmetic, which only knows the turn timestamps.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 10 } }),
      rejectionRecord({ timestamp: iso('10:49'), resetsAt: at('13:45') / 1000 }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('11:00'));

    strictEqual(limits.current?.resetsAt, at('13:45'));
    strictEqual(limits.current?.resetsAtIsReported, true);
    strictEqual(limits.current?.limited, true);
    strictEqual(limits.lastLimited?.startedAt, at('08:30'));
  });

  it('leaves a weekly refusal to the weekly clock', async (t) => {
    // A different limit on a different cycle. Reading it as a five-hour one would
    // put a window's end hours or days away from where it is.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 10 } }),
      rejectionRecord({ timestamp: iso('09:00'), rateLimitType: 'weekly', resetsAt: at('20:00') / 1000 }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('10:00'));

    strictEqual(limits.current?.resetsAt, at('13:30'));
    strictEqual(limits.current?.limited, false);
    strictEqual(limits.lastLimited, undefined);
  });

  it('does not count Claude Code’s own synthetic messages as turns', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 10 } }),
      assistantRecord({
        id: 'msg_2',
        model: '<synthetic>',
        timestamp: iso('08:45'),
        usage: { output: 999 },
      }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('09:00'));

    strictEqual(limits.current?.turns, 1);
    strictEqual(limits.current?.tokens.output, 10);
  });

  it('never measures the window in progress against itself', async (t) => {
    // A window is always 100% of its own size, so a yardstick that could be the
    // current window would read full from its very first turn.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 5 } }),
      assistantRecord({ id: 'msg_2', timestamp: iso('14:05'), usage: { output: 5_000 } }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('15:00'));

    strictEqual(limits.current?.tokens.output, 5_000);
    strictEqual(limits.reference?.tokens.output, 5);
  });

  it('offers no yardstick until a window has closed', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 10 } }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('09:00'));

    strictEqual(limits.reference, undefined);
    strictEqual(limits.lastLimited, undefined);
    strictEqual(limits.historyDays, 7);
  });

  it('reports no window at all once five quiet hours have passed', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 10 } }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('20:00'));

    strictEqual(limits.current, undefined);
    strictEqual(limits.reference?.startedAt, at('08:30'));
  });

  it('merges windows across projects, because the limit is one account’s', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 10 } }),
    ]);
    await home.transcript('/Users/y/Work/other', sessionId(2), [
      assistantRecord({ id: 'msg_2', timestamp: iso('08:50'), usage: { output: 90 } }),
    ]);

    const limits = await readUsageLimits(home.config, cache(), at('09:00'));

    strictEqual(limits.current?.turns, 2);
    strictEqual(limits.current?.tokens.output, 100);
  });

  it('reads nothing rather than failing when there is no projects directory', async (t) => {
    const home = await claudeHome(t);
    const limits = await readUsageLimits(
      { ...home.config, projectsDir: '/nope/not/here' },
      cache(),
      at('09:00'),
    );

    strictEqual(limits.current, undefined);
    strictEqual(limits.reference, undefined);
  });

  it('reuses a cached read of a transcript that has not moved', async (t) => {
    // A week of history is hundreds of files. Re-reading the finished ones on every
    // poll is what this cache exists to prevent.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:40'), usage: { output: 10 } }),
    ]);

    const shared = cache();
    const first = await readUsageLimits(home.config, shared, at('09:00'));
    strictEqual(shared.size, 1);
    const second = await readUsageLimits(home.config, shared, at('09:00'));

    deepStrictEqual(second, first);
    strictEqual(shared.size, 1);
  });
});

describe('billedTokens', () => {
  it('adds input, output and newly-cached tokens, and nothing else', () => {
    strictEqual(billedTokens({ input: 1, output: 2, cacheRead: 400, cacheCreate: 8 }), 11);
  });

  it('reads nothing as zero', () => {
    strictEqual(billedTokens(undefined), 0);
  });
});
