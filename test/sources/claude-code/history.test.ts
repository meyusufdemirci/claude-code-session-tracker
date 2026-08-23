import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileCache } from '../../../src/core/cache.ts';
import type { FileUsage, UsageBucket } from '../../../src/sources/claude-code/buckets.ts';
import { readUsageHistory } from '../../../src/sources/claude-code/history.ts';
import { pathToSlug } from '../../../src/sources/claude-code/slug.ts';
import { claudeHome, sessionId } from '../../helpers/claude-dir.ts';
import { assistantRecord, rejectionRecord } from '../../helpers/records.ts';

const APP = '/Users/y/Work/app';
const SITE = '/Users/y/Work/site';

/** A fixed day in UTC, so every bucket in here is one an eye can check. */
const DAY = '2026-01-05';
const iso = (clock: string): string => `${DAY}T${clock}:00.000Z`;
const at = (clock: string): number => Date.parse(iso(clock));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = at('12:00');

const cache = (): FileCache<FileUsage> => new FileCache<FileUsage>();
const paths = (): Map<string, string> => new Map<string, string>();

/** The whole fixed day, so a test says what it means rather than leaning on defaults. */
const RANGE = { since: at('00:00'), until: at('23:30') };

describe('readUsageHistory', () => {
  it('reports the series, the projects and the models over one range', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
      assistantRecord({ id: 'msg_2', timestamp: iso('11:05'), usage: { output: 2 } }),
    ]);
    await home.transcript(SITE, sessionId(2), [
      assistantRecord({
        id: 'msg_3',
        model: 'claude-sonnet-5',
        timestamp: iso('09:20'),
        usage: { output: 4 },
      }),
    ]);

    const history = await readUsageHistory(home.config, cache(), paths(), RANGE, NOW);

    deepStrictEqual(history.range, RANGE);
    strictEqual(history.bucketMs, 30 * 60 * 1000);
    strictEqual(history.generatedAt, NOW);
    // Sparse and in order: the quiet half hours between them do not exist.
    deepStrictEqual(
      history.buckets.map((bucket) => bucket.at),
      [at('09:00'), at('11:00')],
    );
    strictEqual(history.buckets[0]?.tokens.output, 14);
    strictEqual(history.buckets[0]?.turns, 2);
    deepStrictEqual(
      history.projects.map((project) => project.slug),
      [pathToSlug(APP), pathToSlug(SITE)],
    );
    deepStrictEqual(
      history.models.map((model) => model.model),
      ['claude-opus-5', 'claude-sonnet-5'],
    );
  });

  it('ranks projects and models by billed tokens, not by cache reads', async (t) => {
    // The ranking the limit cards use. A long conversation reads cache by the
    // million; ranking on that would sort by how much was said, not how much was done.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);
    await home.transcript(SITE, sessionId(2), [
      assistantRecord({
        id: 'msg_2',
        model: 'claude-sonnet-5',
        timestamp: iso('09:20'),
        usage: { output: 1, cacheRead: 900_000 },
      }),
    ]);

    const history = await readUsageHistory(home.config, cache(), paths(), RANGE, NOW);

    strictEqual(history.projects[0]?.slug, pathToSlug(APP));
    strictEqual(history.models[0]?.model, 'claude-opus-5');
    // Kept, though — shown apart on the page rather than dropped from it.
    strictEqual(history.projects[1]?.tokens.cacheRead, 900_000);
  });

  it('puts a name and a directory on every project', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);

    const history = await readUsageHistory(home.config, cache(), paths(), RANGE, NOW);

    // The directory does not exist on this machine, so the walk cannot settle the
    // slug and the naive reading stands in — legible, and never a throw.
    strictEqual(history.projects[0]?.path, APP);
    strictEqual(history.projects[0]?.name, 'app');
  });

  it('resolves a project’s directory once, however many times it is asked for', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);

    const known = paths();
    const shared = cache();
    await readUsageHistory(home.config, shared, known, RANGE, NOW);
    known.set(pathToSlug(APP), '/somewhere/else');
    const second = await readUsageHistory(home.config, shared, known, RANGE, NOW);

    // Proof it was read from the map rather than walked again.
    strictEqual(second.projects[0]?.path, '/somewhere/else');
    strictEqual(known.size, 1);
  });

  it('narrows the series and the models to one project, and leaves the project list whole', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);
    await home.transcript(SITE, sessionId(2), [
      assistantRecord({
        id: 'msg_2',
        model: 'claude-sonnet-5',
        timestamp: iso('11:20'),
        usage: { output: 4 },
      }),
    ]);

    const history = await readUsageHistory(
      home.config,
      cache(),
      paths(),
      { ...RANGE, project: pathToSlug(SITE) },
      NOW,
    );

    strictEqual(history.project, pathToSlug(SITE));
    deepStrictEqual(
      history.buckets.map((bucket) => bucket.at),
      [at('11:00')],
    );
    deepStrictEqual(
      history.models.map((model) => model.model),
      ['claude-sonnet-5'],
    );
    // The picker keeps every option, or it cannot be used to pick again.
    strictEqual(history.projects.length, 2);
  });

  it('reads a project that billed nothing as an empty series, not as no narrowing', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);

    const history = await readUsageHistory(
      home.config,
      cache(),
      paths(),
      { ...RANGE, project: '-not-a-project' },
      NOW,
    );

    deepStrictEqual(history.buckets, []);
    deepStrictEqual(history.models, []);
    // Left off rather than echoed: claiming the narrowing happened would make an
    // empty page look like a quiet one.
    strictEqual(history.project, undefined);
    strictEqual(history.projects.length, 1);
  });

  it('marks the half hours Claude refused a turn in', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
      rejectionRecord({ timestamp: iso('11:20'), resetsAt: at('13:30') / 1000 }),
    ]);

    const history = await readUsageHistory(home.config, cache(), paths(), RANGE, NOW);

    strictEqual(history.buckets[0]?.limited, false);
    strictEqual(history.buckets[1]?.at, at('11:00'));
    strictEqual(history.buckets[1]?.limited, true);
  });

  it('covers the last thirty days when no range is asked for', async (t) => {
    const home = await claudeHome(t);

    const history = await readUsageHistory(home.config, cache(), paths(), {}, NOW);

    strictEqual(history.range.until, NOW);
    strictEqual(history.range.since, NOW - 30 * DAY_MS);
  });

  it('runs an open-ended range up to now', async (t) => {
    const home = await claudeHome(t);

    const history = await readUsageHistory(
      home.config,
      cache(),
      paths(),
      { since: NOW - 3 * DAY_MS },
      NOW,
    );

    deepStrictEqual(history.range, { since: NOW - 3 * DAY_MS, until: NOW });
  });

  it('narrows a range wider than ninety days, and says it did', async (t) => {
    const home = await claudeHome(t);

    const history = await readUsageHistory(
      home.config,
      cache(),
      paths(),
      { since: NOW - 365 * DAY_MS },
      NOW,
    );

    // The range on the way back is the one that was read, so a page cannot draw an
    // axis a year wide over three months of data.
    strictEqual(history.range.since, NOW - 90 * DAY_MS);
  });

  it('reads a backwards range as an empty one rather than refusing it', async (t) => {
    // A date picker mid-edit, not a caller doing something wrong.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);

    const history = await readUsageHistory(
      home.config,
      cache(),
      paths(),
      { since: at('11:00'), until: at('10:00') },
      NOW,
    );

    deepStrictEqual(history.range, { since: at('10:00'), until: at('10:00') });
    deepStrictEqual(history.buckets, []);
    deepStrictEqual(history.projects, []);
  });

  it('keeps the half hours either side of midnight apart', async (t) => {
    // The one test that guards the grain. Days on the page are *local* days, folded
    // in the browser, which is only possible because nothing here folds them first:
    // a reader that rolled its buckets up into days would have had to pick a
    // timezone, and the only one it could pick is the wrong one.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('23:45'), usage: { output: 10 } }),
      assistantRecord({
        id: 'msg_2',
        timestamp: `2026-01-06T00:15:00.000Z`,
        usage: { output: 4 },
      }),
    ]);

    const history = await readUsageHistory(
      home.config,
      cache(),
      paths(),
      { since: at('00:00'), until: at('23:30') + 2 * 60 * 60 * 1000 },
      NOW,
    );

    deepStrictEqual(
      history.buckets.map((bucket) => bucket.at),
      [at('23:30'), Date.parse('2026-01-06T00:00:00.000Z')],
    );
    strictEqual(history.buckets[0]?.tokens.output, 10);
    strictEqual(history.buckets[1]?.tokens.output, 4);
  });

  it('bills a subagent’s turns to the project that spawned it', async (t) => {
    // True of the sweep, and worth asserting of the payload as well: a project's row
    // is what someone reads, and a fan-out that billed elsewhere would understate it.
    const home = await claudeHome(t);
    await home.transcript(APP, sessionId(1), [
      assistantRecord({ id: 'msg_1', timestamp: iso('09:05'), usage: { output: 10 } }),
    ]);
    await home.subagent(APP, sessionId(1), 'agent-writer', [
      assistantRecord({
        id: 'msg_2',
        model: 'claude-sonnet-5',
        timestamp: iso('09:07'),
        usage: { output: 7 },
      }),
    ]);

    const history = await readUsageHistory(home.config, cache(), paths(), RANGE, NOW);

    strictEqual(history.projects.length, 1);
    strictEqual(history.projects[0]?.tokens.output, 17);
    strictEqual(history.projects[0]?.turns, 2);
    // And the model it answered on is the subagent's own, not its parent's.
    deepStrictEqual(
      history.models.map((model) => model.model),
      ['claude-opus-5', 'claude-sonnet-5'],
    );
  });

  it('reads a machine that has never run Claude Code as an empty range', async (t) => {
    const home = await claudeHome(t);

    const history = await readUsageHistory(home.config, cache(), paths(), RANGE, NOW);

    deepStrictEqual(history.buckets, []);
    deepStrictEqual(history.projects, []);
    deepStrictEqual(history.models, []);
    ok(history.generatedAt === NOW);
  });
});
