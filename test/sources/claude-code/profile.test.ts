import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileCache } from '../../../src/core/cache.ts';
import type { FileUsage } from '../../../src/sources/claude-code/buckets.ts';
import { readUsageProfile } from '../../../src/sources/claude-code/profile.ts';
import { pathToSlug } from '../../../src/sources/claude-code/slug.ts';
import { claudeHome, sessionId } from '../../helpers/claude-dir.ts';
import { assistantRecord } from '../../helpers/records.ts';

const APP = '/Users/y/Work/app';
const SITE = '/Users/y/Work/site';

/** A fixed day in UTC, so every boundary in here is one an eye can check. */
const DAY = '2026-01-05';
const iso = (clock: string): string => `${DAY}T${clock}:00.000Z`;
const at = (clock: string): number => Date.parse(iso(clock));

const NOW = at('20:00');
const cache = (): FileCache<FileUsage> => new FileCache<FileUsage>();
const paths = (): Map<string, string> => new Map<string, string>();

/** One billed turn. Everything a profile row knows comes from a pair of these. */
const turn = (id: string, clock: string, usage: Record<string, number>): string =>
  assistantRecord({ id, timestamp: iso(clock), usage });

describe('readUsageProfile', () => {
  it('reads a session as the pair of windows it opened and closed on', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      turn('msg_1', '09:00', { input: 2, cacheCreate: 20_000, output: 500 }),
      turn('msg_2', '09:20', { input: 2, cacheRead: 60_000, cacheCreate: 900, output: 400 }),
    ]);

    const profile = await readUsageProfile(home.config, cache(), paths(), {}, NOW);

    strictEqual(profile.sessions.length, 1);
    const [session] = profile.sessions;
    strictEqual(session?.id, sessionId(1));
    strictEqual(session.slug, pathToSlug(APP));
    strictEqual(session.project, 'app');
    strictEqual(session.turns, 2);
    deepStrictEqual(session.opening, { input: 2, output: 500, cacheRead: 0, cacheCreate: 20_000 });
    strictEqual(session.closingContext, 2 + 60_000 + 900, 'input plus cache on the last turn');
  });

  it('bills a subagent to the session that spawned it', async (t) => {
    // A subagent's turns are counted against the same window as its parent's, so a
    // reader looking at a heavy session has to be shown the whole of what it cost.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      turn('msg_1', '09:00', { cacheCreate: 20_000, output: 500 }),
      turn('msg_2', '09:20', { cacheRead: 40_000, output: 400 }),
    ]);
    await home.subagent(APP, sessionId(1), 'agent-one', [
      turn('msg_a', '09:10', { cacheCreate: 5_000, output: 700 }),
    ]);

    const profile = await readUsageProfile(home.config, cache(), paths(), {}, NOW);

    strictEqual(profile.sessions.length, 1, 'one session, not a session and an agent');
    const [session] = profile.sessions;
    strictEqual(session?.turns, 3);
    strictEqual(session.tokens.output, 500 + 400 + 700);
    strictEqual(session.tokens.cacheCreate, 20_000 + 5_000);
  });

  it('reads the windows off the session, never off one of its subagents', async (t) => {
    // A subagent runs in a window of its own. Reading one as the parent's would say
    // the session opened at a size it never saw.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      turn('msg_1', '09:00', { cacheCreate: 20_000 }),
      turn('msg_2', '09:20', { cacheRead: 40_000 }),
    ]);
    await home.subagent(APP, sessionId(1), 'agent-one', [
      turn('msg_a', '09:05', { cacheCreate: 300_000 }),
      turn('msg_b', '09:06', { cacheRead: 500_000 }),
    ]);

    const [session] = (await readUsageProfile(home.config, cache(), paths(), {}, NOW)).sessions;

    strictEqual(session?.opening.cacheCreate, 20_000);
    strictEqual(session.closingContext, 40_000);
  });

  it('drops a session that left no transcript of its own', async (t) => {
    // Only the session's own file knows what it opened and closed holding, and that
    // pair is the whole point of a row.
    const home = await claudeHome(t);
    await home.subagent(APP, sessionId(9), 'agent-one', [
      turn('msg_a', '09:05', { cacheCreate: 5_000 }),
    ]);

    const profile = await readUsageProfile(home.config, cache(), paths(), {}, NOW);

    deepStrictEqual(profile.sessions, []);
  });

  it('puts the heaviest session first', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      turn('msg_1', '09:00', { cacheCreate: 1_000, output: 100 }),
      turn('msg_2', '09:10', { cacheRead: 2_000, output: 100 }),
    ]);
    await home.transcript(SITE, sessionId(2), [
      turn('msg_3', '10:00', { cacheCreate: 90_000, output: 8_000 }),
      turn('msg_4', '10:10', { cacheRead: 200_000, output: 8_000 }),
    ]);

    const profile = await readUsageProfile(home.config, cache(), paths(), {}, NOW);

    deepStrictEqual(
      profile.sessions.map((session) => session.project),
      ['site', 'app'],
    );
  });

  it('leaves out a session whose turns all landed before the range', async (t) => {
    // `mtime` gets the sweep down to a plausible set and can do no more: a resumed
    // transcript is written today and can hold nothing but last month's records.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [turn('msg_1', '02:00', { cacheCreate: 40_000 })]);
    await home.transcript(SITE, sessionId(2), [turn('msg_2', '12:00', { cacheCreate: 40_000 })]);

    const profile = await readUsageProfile(
      home.config,
      cache(),
      paths(),
      { since: at('06:00') },
      NOW,
    );

    deepStrictEqual(
      profile.sessions.map((session) => session.project),
      ['site'],
    );
  });

  it('narrows to one project when asked, by the slug the sweep reported', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [turn('msg_1', '09:00', { cacheCreate: 40_000 })]);
    await home.transcript(SITE, sessionId(2), [turn('msg_2', '10:00', { cacheCreate: 40_000 })]);

    const profile = await readUsageProfile(
      home.config,
      cache(),
      paths(),
      { project: pathToSlug(SITE) },
      NOW,
    );

    deepStrictEqual(
      profile.sessions.map((session) => session.project),
      ['site'],
    );
  });

  it('splits the range by the model that answered, heaviest first', async (t) => {
    // From the buckets rather than the sessions: a session that ran on two models is
    // one row there and two here, and which model answered is a fact about the turn.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({
        id: 'msg_1',
        timestamp: iso('09:00'),
        model: 'claude-sonnet-5',
        usage: { output: 1_000 },
      }),
      assistantRecord({
        id: 'msg_2',
        timestamp: iso('09:20'),
        model: 'claude-opus-5',
        usage: { output: 40_000 },
      }),
    ]);

    const profile = await readUsageProfile(home.config, cache(), paths(), {}, NOW);

    deepStrictEqual(
      profile.models.map((model) => model.model),
      ['claude-opus-5', 'claude-sonnet-5'],
    );
    strictEqual(profile.models[0]?.turns, 1);
  });

  it('reports the range it read, not the one it was asked for', async (t) => {
    const home = await claudeHome(t);
    const profile = await readUsageProfile(
      home.config,
      cache(),
      paths(),
      { since: NOW - 400 * 24 * 60 * 60 * 1000 },
      NOW,
    );

    strictEqual(profile.range.until, NOW);
    strictEqual(profile.range.since, NOW - 90 * 24 * 60 * 60 * 1000, 'capped at ninety days');
  });

  it('answers an empty machine with an empty profile rather than an error', async (t) => {
    const home = await claudeHome(t);

    const profile = await readUsageProfile(home.config, cache(), paths(), {}, NOW);

    deepStrictEqual(profile.sessions, []);
    deepStrictEqual(profile.models, []);
    strictEqual(profile.generatedAt, NOW);
  });

  it('reads a transcript once per version of itself', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [turn('msg_1', '09:00', { cacheCreate: 40_000 })]);

    const warm = cache();
    const cold = await readUsageProfile(home.config, warm, paths(), {}, NOW);
    const again = await readUsageProfile(home.config, warm, paths(), {}, NOW);

    deepStrictEqual(again.sessions, cold.sessions);
    ok(warm.size > 0, 'the sweep left something behind to reuse');
  });
});
