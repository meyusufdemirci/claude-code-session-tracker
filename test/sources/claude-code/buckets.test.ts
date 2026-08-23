import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileCache } from '../../../src/core/cache.ts';
import {
  mergeBuckets,
  readUsageBuckets,
  type ProjectUsage,
  type FileUsage,
  type UsageBucket,
} from '../../../src/sources/claude-code/buckets.ts';
import { pathToSlug } from '../../../src/sources/claude-code/slug.ts';
import { claudeHome, sessionId } from '../../helpers/claude-dir.ts';
import { assistantRecord, rejectionRecord } from '../../helpers/records.ts';

const APP = '/Users/y/Work/app';
const SITE = '/Users/y/Work/site';

/**
 * A fixed day, so every half hour in here is one an eye can check.
 *
 * UTC on purpose: the sweep floors to the half hour in absolute time, and a test
 * that read the machine's timezone would pass or fail depending on where it ran.
 */
const DAY = '2026-01-05';
const iso = (clock: string): string => `${DAY}T${clock}:00.000Z`;
const at = (clock: string): number => Date.parse(iso(clock));
const SINCE = at('00:00');

const cache = (): FileCache<FileUsage> => new FileCache<FileUsage>();
const bySlug = (projects: readonly ProjectUsage[], cwd: string): ProjectUsage | undefined =>
  projects.find((project) => project.slug === pathToSlug(cwd));

describe('readUsageBuckets', () => {
  it('keeps each project’s half hours under its own slug', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);
    await home.transcript(SITE, sessionId(2), [
      assistantRecord({ id: 'msg_2', timestamp: iso('09:20'), usage: { output: 4 } }),
    ]);

    const projects = await readUsageBuckets(home.config, cache(), { since: SINCE });

    deepStrictEqual(
      projects.map((project) => project.slug).sort(),
      [pathToSlug(APP), pathToSlug(SITE)].sort(),
    );
    // The same half hour on the clock, and still two separate readings of it.
    strictEqual(bySlug(projects, APP)?.buckets.at(0)?.at, at('09:00'));
    strictEqual(bySlug(projects, APP)?.buckets.at(0)?.tokens.output, 10);
    strictEqual(bySlug(projects, SITE)?.buckets.at(0)?.at, at('09:00'));
    strictEqual(bySlug(projects, SITE)?.buckets.at(0)?.tokens.output, 4);
  });

  it('bills a subagent’s turns to the project that spawned it', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);
    await home.subagent(APP, sessionId(1), 'agent-writer', [
      assistantRecord({ id: 'msg_2', timestamp: iso('09:07'), usage: { output: 7 } }),
    ]);

    const projects = await readUsageBuckets(home.config, cache(), { since: SINCE });

    strictEqual(projects.length, 1);
    strictEqual(projects[0]?.buckets.length, 1);
    strictEqual(projects[0]?.buckets[0]?.tokens.output, 17);
    strictEqual(projects[0]?.buckets[0]?.turns, 2);
  });

  it('splits a half hour by the model that answered', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({
        id: 'msg_1',
        model: 'claude-opus-5',
        timestamp: iso('09:05'),
        usage: { input: 2, output: 10, cacheRead: 900, cacheCreate: 5 },
      }),
      assistantRecord({
        id: 'msg_2',
        model: 'claude-sonnet-5',
        timestamp: iso('09:20'),
        usage: { output: 4 },
      }),
    ]);

    const bucket = (await readUsageBuckets(home.config, cache(), { since: SINCE }))[0]
      ?.buckets[0];

    strictEqual(bucket?.turns, 2);
    deepStrictEqual(bucket?.byModel['claude-opus-5'], {
      tokens: { input: 2, output: 10, cacheRead: 900, cacheCreate: 5 },
      turns: 1,
    });
    deepStrictEqual(bucket?.byModel['claude-sonnet-5'], {
      tokens: { input: 0, output: 4, cacheRead: 0, cacheCreate: 0 },
      turns: 1,
    });
  });

  it('counts a turn that named no model in the totals but not in the split', async (t) => {
    // The split is read, the totals are measured, so the split may sum to less than
    // they do — never to more.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
      assistantRecord({ id: 'msg_2', timestamp: iso('09:10'), noModel: true, usage: { output: 6 } }),
    ]);

    const bucket = (await readUsageBuckets(home.config, cache(), { since: SINCE }))[0]
      ?.buckets[0];

    strictEqual(bucket?.tokens.output, 16);
    strictEqual(bucket?.turns, 2);
    deepStrictEqual(Object.keys(bucket?.byModel ?? {}), ['claude-opus-5']);
    strictEqual(bucket?.byModel['claude-opus-5']?.tokens.output, 10);
  });

  it('leaves out the turns Claude Code wrote itself', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({
        id: 'msg_1',
        model: '<synthetic>',
        timestamp: iso('09:05'),
        usage: { output: 10 },
      }),
    ]);

    // Nobody was billed for those, so they open no bucket — and a project with no
    // buckets in the window is not in the window.
    deepStrictEqual(await readUsageBuckets(home.config, cache(), { since: SINCE }), []);
  });

  it('drops buckets before `since` even when the file itself is recent', async (t) => {
    // A resumed session carries records from well before the cutoff; the file being
    // recent says nothing about the records inside it.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('08:00'), usage: { output: 10 } }),
      assistantRecord({ id: 'msg_2', timestamp: iso('10:00'), usage: { output: 4 } }),
    ]);

    const projects = await readUsageBuckets(home.config, cache(), { since: at('09:00') });

    strictEqual(projects[0]?.buckets.length, 1);
    strictEqual(projects[0]?.buckets[0]?.at, at('10:00'));
  });

  it('treats `until` as exclusive', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
      assistantRecord({ id: 'msg_2', timestamp: iso('10:05'), usage: { output: 4 } }),
    ]);

    const projects = await readUsageBuckets(home.config, cache(), {
      since: SINCE,
      until: at('10:00'),
    });

    strictEqual(projects[0]?.buckets.length, 1);
    strictEqual(projects[0]?.buckets[0]?.at, at('09:00'));
  });

  it('reads the same totals from a warm cache as from a cold one', async (t) => {
    // The cache hands the same bucket objects out on every sweep, so a merge that
    // kept a reference into one would add this sweep's totals to the next sweep's
    // starting point. Two transcripts in one project inside one half hour is what
    // makes that merge happen at all.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);
    await home.transcript(APP, sessionId(2), [
      assistantRecord({
        id: 'msg_2',
        model: 'claude-sonnet-5',
        timestamp: iso('09:20'),
        usage: { output: 4 },
      }),
    ]);

    const warm = cache();
    const cold = await readUsageBuckets(home.config, warm, { since: SINCE });
    const again = await readUsageBuckets(home.config, warm, { since: SINCE });

    deepStrictEqual(again, cold);
    strictEqual(again[0]?.buckets[0]?.tokens.output, 14);
    strictEqual(again[0]?.buckets[0]?.byModel['claude-sonnet-5']?.tokens.output, 4);
  });

  it('reads an empty projects directory as no usage rather than an error', async (t) => {
    const home = await claudeHome(t);

    deepStrictEqual(await readUsageBuckets(home.config, cache(), { since: SINCE }), []);
  });
});

describe('mergeBuckets', () => {
  it('folds every project into one series of half hours', async (t) => {
    // What the limit clocks want: they bill one account, not one project.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);
    await home.transcript(SITE, sessionId(2), [
      assistantRecord({
        id: 'msg_2',
        model: 'claude-sonnet-5',
        timestamp: iso('09:20'),
        usage: { output: 4 },
      }),
      assistantRecord({ id: 'msg_3', timestamp: iso('11:00'), usage: { output: 1 } }),
    ]);

    const buckets = mergeBuckets(await readUsageBuckets(home.config, cache(), { since: SINCE }));

    deepStrictEqual(
      buckets.map((bucket) => bucket.at),
      [at('09:00'), at('11:00')],
    );
    strictEqual(buckets[0]?.tokens.output, 14);
    strictEqual(buckets[0]?.turns, 2);
    strictEqual(buckets[0]?.byModel['claude-opus-5']?.tokens.output, 10);
    strictEqual(buckets[0]?.byModel['claude-sonnet-5']?.tokens.output, 4);
  });

  it('carries a refusal recorded in any one of them', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);
    await home.transcript(SITE, sessionId(2), [
      rejectionRecord({ timestamp: iso('09:20'), resetsAt: at('13:30') / 1000 }),
    ]);

    const buckets = mergeBuckets(await readUsageBuckets(home.config, cache(), { since: SINCE }));

    strictEqual(buckets.length, 1);
    strictEqual(buckets[0]?.fiveHourLimited, true);
    strictEqual(buckets[0]?.fiveHourResetsAt, at('13:30'));
    // The refusal itself bills nothing — it is the turn that did not happen.
    strictEqual(buckets[0]?.turns, 1);
  });

  it('reads no projects as no buckets', () => {
    deepStrictEqual(mergeBuckets([]), []);
  });
});
