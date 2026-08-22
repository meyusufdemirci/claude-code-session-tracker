import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConfig } from '../../src/config.ts';
import { clampLimit, parseSort, SessionRegistry } from '../../src/core/registry.ts';
import type { SessionDetail, UsageLimits } from '../../src/core/types.ts';
import { endedSession, FakeSource, liveSession } from '../helpers/fake-source.ts';

const config = createConfig({ claudeDir: '/nowhere' });

function registryOf(...sources: FakeSource[]): SessionRegistry {
  return new SessionRegistry(config, sources);
}

const tokens = (input: number, output = 0) => ({ input, output, cacheRead: 0, cacheCreate: 0 });

const usageWindow = {
  startedAt: 1_000,
  resetsAt: 19_000,
  resetsAtIsReported: false,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
  turns: 1,
  limited: false,
};


describe('SessionRegistry.list', () => {
  it('lets the running process win over the transcript for the same session', async () => {
    // The live registry knows the status and pid; the transcript only knows history.
    // Both halves are kept: status from the process, title from the file.
    const source = new FakeSource({
      recent: [endedSession('a', { title: 'From the transcript', model: 'claude-opus-5' })],
      live: [liveSession('a', { status: 'waiting', waitingFor: 'input needed' })],
    });

    const { sessions } = await registryOf(source).list();

    strictEqual(sessions.length, 1, 'one session, not two');
    strictEqual(sessions[0]?.status, 'waiting');
    strictEqual(sessions[0]?.waitingFor, 'input needed');
    strictEqual(sessions[0]?.title, 'From the transcript');
    strictEqual(sessions[0]?.model, 'claude-opus-5');
  });

  it('names the running sessions to the source, so none is left untitled', async () => {
    // A live session that has been idle a while sorts below the cut, and would
    // otherwise show as a bare row.
    const source = new FakeSource({ live: [liveSession('a'), liveSession('b')] });

    await registryOf(source).list({ limit: 5 });

    deepStrictEqual(source.queries[0]?.include, ['a', 'b']);
  });

  it('never lets the limit push out a running session', async () => {
    // They are the point of the tool, so the limit bounds the history underneath.
    const source = new FakeSource({
      live: [liveSession('x'), liveSession('y')],
      recent: [endedSession('a'), endedSession('b'), endedSession('c')],
    });

    const { sessions } = await registryOf(source).list({ limit: 2 });

    deepStrictEqual(
      sessions.map((s) => s.id),
      ['x', 'y'],
      'the two running ones fill the page on their own',
    );
  });

  it('keeps the running sessions at the top, newest first, whatever the ordering', async () => {
    // A session started seconds ago has no transcript yet, so any ordering read
    // out of the files would sort it below month-old history.
    const source = new FakeSource({
      live: [
        liveSession('old', { lastActiveAt: 10, tokens: tokens(9_000) }),
        liveSession('new', { lastActiveAt: 20, tokens: tokens(1) }),
      ],
      recent: [endedSession('a', { tokens: tokens(100_000) })],
    });

    const { sessions } = await registryOf(source).list({ sort: 'tokens-desc' });

    deepStrictEqual(
      sessions.map((s) => s.id),
      ['new', 'old', 'a'],
    );
  });

  it('ranks finished sessions by tokens, with recency breaking the tie', async () => {
    // The many sessions that billed nothing must hold still rather than shuffle.
    const source = new FakeSource({
      recent: [
        endedSession('cheap', { tokens: tokens(10), lastActiveAt: 1 }),
        endedSession('rich', { tokens: tokens(500, 500) }),
        endedSession('free-old', { lastActiveAt: 5 }),
        endedSession('free-new', { lastActiveAt: 9 }),
      ],
    });

    const desc = await registryOf(source).list({ sort: 'tokens-desc' });
    deepStrictEqual(
      desc.sessions.map((s) => s.id),
      ['rich', 'cheap', 'free-new', 'free-old'],
    );

    const asc = await registryOf(source).list({ sort: 'tokens-asc' });
    deepStrictEqual(
      asc.sessions.map((s) => s.id),
      ['free-new', 'free-old', 'cheap', 'rich'],
    );
  });

  it('orders by recency when nothing else is asked for', async () => {
    const source = new FakeSource({
      recent: [endedSession('a', { lastActiveAt: 1 }), endedSession('b', { lastActiveAt: 2 })],
    });

    deepStrictEqual(
      (await registryOf(source).list()).sessions.map((s) => s.id),
      ['b', 'a'],
    );
  });

  it('reports a total that is a property of the window, not of the page', async () => {
    const source = new FakeSource({
      recent: [endedSession('a'), endedSession('b'), endedSession('c')],
    });

    const { sessions, total } = await registryOf(source).list({ limit: 1 });

    strictEqual(sessions.length, 1);
    strictEqual(total, 3);
  });

  it('adds a running session to the total only when the window missed it', async () => {
    // The sources count transcripts inside the window. A session listed regardless
    // of the window has to be added on top, or it would be counted twice.
    const inside = new FakeSource({
      id: 'inside',
      recent: [endedSession('a', { lastActiveAt: 500 })],
      live: [liveSession('a', { lastActiveAt: 500 })],
    });
    strictEqual((await registryOf(inside).list({ since: 100, until: 900 })).total, 1);

    const outside = new FakeSource({
      id: 'outside',
      recent: [endedSession('a', { lastActiveAt: 500 })],
      live: [liveSession('b', { lastActiveAt: 5_000 })],
    });
    strictEqual((await registryOf(outside).list({ since: 100, until: 900 })).total, 2);
  });

  it('counts a session too new to have a transcript', async () => {
    const source = new FakeSource({
      live: [liveSession('brand-new', { transcriptPath: undefined })],
    });

    strictEqual((await registryOf(source).list()).total, 1);
  });

  it('merges several sources into one list', async () => {
    const a = new FakeSource({ id: 'a', recent: [endedSession('1', { lastActiveAt: 1 })] });
    const b = new FakeSource({ id: 'b', recent: [endedSession('2', { lastActiveAt: 2 })] });

    const { sessions, sources } = await registryOf(a, b).list();

    deepStrictEqual(
      sessions.map((s) => s.id),
      ['2', '1'],
    );
    deepStrictEqual(
      sources.map((s) => s.id),
      ['a', 'b'],
    );
  });

  it('reports an unavailable source without asking it for anything', async () => {
    const missing = new FakeSource({ id: 'gone', available: false, recent: [endedSession('a')] });

    const { sessions, sources } = await registryOf(missing).list();

    deepStrictEqual(sessions, []);
    deepStrictEqual(sources, [{ id: 'gone', label: 'Fake', available: false }]);
    strictEqual(missing.queries.length, 0);
  });
});

describe('SessionRegistry.detail', () => {
  it('lets the running process override the transcript here too', async () => {
    // A panel open on a running session must say `busy`, not `ended`.
    const detail = { ...endedSession('a'), title: 'Read from the file' } as SessionDetail;
    const source = new FakeSource({ details: { a: detail }, live: [liveSession('a')] });

    const merged = await registryOf(source).detail('a');

    strictEqual(merged?.status, 'busy');
    strictEqual(merged?.title, 'Read from the file');
  });

  it('answers null when no source knows the session', async () => {
    strictEqual(await registryOf(new FakeSource()).detail('nope'), null);
  });

  it('does not ask a source that has no data on this machine', async () => {
    const detail = endedSession('a') as SessionDetail;
    const missing = new FakeSource({ available: false, details: { a: detail } });

    strictEqual(await registryOf(missing).detail('a'), null);
  });
});

describe('SessionRegistry.limits', () => {
  const limits: UsageLimits = {
    session: { windowMs: 18_000, clock: 'chained', current: usageWindow, historyDays: 7 },
    weekly: { windowMs: 604_800_000, clock: 'rolling', historyDays: 28 },
    generatedAt: 2_000,
  };

  it('answers from the first source that can measure a window', async () => {
    const cannot = new FakeSource({ id: 'cannot' });
    const can = new FakeSource({ id: 'can', limits });

    deepStrictEqual(await registryOf(cannot, can).limits(), limits);
  });

  it('skips a source that is not available', async () => {
    // Present but with nothing on disk to read: its answer would be an empty window,
    // which is a different claim from "this machine has no window open".
    const absent = new FakeSource({ id: 'absent', available: false, limits });

    strictEqual(await registryOf(absent).limits(), null);
  });

  it('says nobody can when no source implements it', async () => {
    // `limits` is optional on the seam, and a source without one is not broken —
    // the page just leaves the strip off.
    strictEqual(await registryOf(new FakeSource()).limits(), null);
  });
});

describe('parseSort', () => {
  it('takes the orderings it knows', () => {
    strictEqual(parseSort('recent'), 'recent');
    strictEqual(parseSort('tokens-desc'), 'tokens-desc');
    strictEqual(parseSort('tokens-asc'), 'tokens-asc');
  });

  it('reads anything else as the default, because it is a typo in a query string', () => {
    strictEqual(parseSort('sideways'), 'recent');
    strictEqual(parseSort(null), 'recent');
    strictEqual(parseSort(undefined), 'recent');
    strictEqual(parseSort('constructor'), 'recent', 'and not something off the prototype');
  });
});

describe('clampLimit', () => {
  it('defaults when there is no number to read', () => {
    strictEqual(clampLimit(undefined), 50);
    strictEqual(clampLimit(Number.NaN), 50);
    strictEqual(clampLimit(Number.POSITIVE_INFINITY), 50);
  });

  it('holds the limit inside what one request may open', () => {
    strictEqual(clampLimit(0), 1);
    strictEqual(clampLimit(-5), 1);
    strictEqual(clampLimit(10_000), 2_000);
    strictEqual(clampLimit(7.9), 7);
  });
});
