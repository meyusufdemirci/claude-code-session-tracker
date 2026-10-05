import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { createConfig } from '../src/config.ts';
import { SessionRegistry } from '../src/core/registry.ts';
import type { UsageHistory, UsageLimits } from '../src/core/types.ts';
import { findTracker, formatSpan, formatTokens, status, summarize } from '../src/status.ts';
import type { Env, Snapshot } from '../src/status.ts';
import { endedSession, FakeSource, liveSession } from './helpers/fake-source.ts';
import { occupyPort, startServer } from './helpers/http.ts';

const NOW = 10_000_000;
const HOUR = 3_600_000;

/** Cache writes are billed and cache reads are not, so each fixture carries some of both. */
const tokens = (input: number, output: number) => ({ input, output: output - 10, cacheRead: 9_999, cacheCreate: 10 });

const window = (input: number, output: number, resetsAt: number) => ({
  startedAt: NOW - HOUR,
  resetsAt,
  resetsAtIsReported: false,
  tokens: tokens(input, output),
  turns: 1,
  limited: false,
});

const LIMITS: UsageLimits = {
  session: {
    windowMs: 5 * HOUR,
    clock: 'chained',
    current: window(100, 100, NOW + 4 * HOUR),
    reported: { percent: 42.9, fetchedAt: NOW, source: 'server', resetsAt: NOW + 2 * HOUR + 14 * 60_000 },
    historyDays: 7,
  },
  weekly: {
    windowMs: 168 * HOUR,
    clock: 'rolling',
    current: window(100, 150, NOW + 76 * HOUR),
    reference: window(600, 400, NOW - HOUR),
    historyDays: 28,
  },
  generatedAt: NOW,
};

const USAGE: UsageHistory = {
  range: { since: 0, until: NOW },
  bucketMs: 1_800_000,
  buckets: [
    { at: NOW - HOUR, tokens: tokens(700_000, 300_000), turns: 60, limited: false },
    { at: NOW - 1_800_000, tokens: tokens(150_000, 50_000), turns: 24, limited: false },
  ],
  projects: [],
  models: [],
  generatedAt: NOW,
};

const EMPTY: Snapshot = { limits: null, running: [], today: null };

describe('formatSpan', () => {
  it('keeps the two largest units', () => {
    strictEqual(formatSpan(30_000), 'under a minute');
    strictEqual(formatSpan(14 * 60_000), '14m');
    strictEqual(formatSpan(2 * HOUR), '2h');
    strictEqual(formatSpan(2 * HOUR + 14 * 60_000), '2h 14m');
    strictEqual(formatSpan(76 * HOUR + 59 * 60_000), '3d 4h');
    strictEqual(formatSpan(48 * HOUR), '2d');
  });
});

describe('formatTokens', () => {
  it('shortens thousands, millions and billions', () => {
    strictEqual(formatTokens(0), '0');
    strictEqual(formatTokens(950), '950');
    strictEqual(formatTokens(12_340), '12.3K');
    strictEqual(formatTokens(2_000), '2K');
    strictEqual(formatTokens(999_960), '1M');
    strictEqual(formatTokens(4_120_000), '4.1M');
    strictEqual(formatTokens(1_500_000_000), '1.5B');
  });
});

describe('summarize', () => {
  const about = { version: '1.2.3', url: 'http://127.0.0.1:3099', now: NOW };

  it("gives Claude Code's own percentage, rounded down, and when it resets", () => {
    match(summarize({ ...EMPTY, limits: LIMITS }, about), /5-hour limit {2}42% used, resets in 2h 14m\n/);
  });

  it('says so when the number is only a comparison with history', () => {
    // 250 billed against a heaviest window of 1,000. Cache reads are not billed.
    match(summarize({ ...EMPTY, limits: LIMITS }, about), /Weekly limit {2}25% of the heaviest window on record, resets in 3d 4h\n/);
  });

  it('has no percentage to give with nothing to measure against', () => {
    const limits = { ...LIMITS, session: { ...LIMITS.session, reported: undefined } };
    match(summarize({ ...EMPTY, limits }, about), /5-hour limit {2}no reading yet\n/);
  });

  it('leaves a reset that has already passed unsaid', () => {
    const limits = { ...LIMITS, session: { ...LIMITS.session, reported: { ...LIMITS.session.reported!, resetsAt: NOW - 1 } } };
    match(summarize({ ...EMPTY, limits }, about), /5-hour limit {2}42% used\n/);
  });

  it('says what today cost', () => {
    match(summarize({ ...EMPTY, today: { tokens: 1_200_000, turns: 84 } }, about), /Today {9}1\.2M tokens in 84 turns\n/);
    match(summarize({ ...EMPTY, today: { tokens: 12, turns: 1 } }, about), /12 tokens in 1 turn\n/);
    match(summarize({ ...EMPTY, today: { tokens: 0, turns: 0 } }, about), /Today {9}nothing billed yet\n/);
  });

  it('lists what is running, with what a waiting session waits for', () => {
    const text = summarize(
      {
        ...EMPTY,
        running: [
          liveSession('a', { title: 'Add the\n  plugin', project: { name: 'tracker', path: '/t', slug: '-t' } }),
          liveSession('b', { status: 'waiting', waitingFor: 'input needed', name: 'app-f0' }),
        ],
      },
      about,
    );
    match(text, /Running {7}2 sessions\n/);
    match(text, / {4}busy {5}tracker {2}Add the plugin\n/);
    match(text, / {4}waiting {2}app {6}app-f0 \(input needed\)\n/);
  });

  it('counts the sessions it has no room to list', () => {
    const running = Array.from({ length: 11 }, (_, index) => liveSession(`s${index}`));
    const text = summarize({ ...EMPTY, running }, about);
    strictEqual(text.match(/ {4}busy/g)?.length, 8);
    match(text, / {4}and 3 more\n/);
  });

  it('clips a title that would wrap', () => {
    const text = summarize({ ...EMPTY, running: [liveSession('a', { title: 'x'.repeat(200) })] }, about);
    match(text, /x{59}…\n/);
  });

  it('says so on a machine with nothing to report', () => {
    const text = summarize(EMPTY, { ...about, url: undefined });
    match(text, /Limits {8}no reading\n/);
    match(text, /Running {7}no sessions\n/);
    match(text, /Dashboard {5}not running\. Start it with: claude-code-session-tracker open\n/);
    ok(!text.includes('Today'));
  });
});

describe('findTracker', () => {
  it('finds the tracker past a port something else holds', async (t) => {
    const other = await occupyPort(t);
    other.server.on('request', (_req, res) => res.writeHead(404).end());
    const server = await startServer(t, [new FakeSource()]);

    const found = await findTracker({ fetch, ports: [other.port, server.port] });

    strictEqual(found?.port, server.port);
    strictEqual(found?.url, `http://127.0.0.1:${server.port}`);
    strictEqual(found?.claudeDir, createConfig().claudeDir);
  });

  it('is undefined when nothing answers as the tracker', async (t) => {
    const other = await occupyPort(t);
    other.server.on('request', (_req, res) => res.end('{"ok":true}'));
    strictEqual(await findTracker({ fetch, ports: [other.port] }), undefined);
  });
});

// The command, with the disk stood in for by a fake source and the tracker by the
// real server on a port of its own.

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(args: string[], env: Partial<Env>): Promise<Run> {
  let out = '';
  let err = '';
  const code = await status(args, { out: (text) => (out += text), err: (text) => (err += text) }, { now: () => NOW, version: '1.2.3', ...env });
  return { code, out, err };
}

function disk(source: FakeSource, seen: object[] = []): Env['registry'] {
  return (options) => {
    seen.push(options);
    const config = createConfig({ claudeDir: options.claudeDir });
    return { registry: new SessionRegistry(config, [source]), claudeDir: config.claudeDir };
  };
}

function populated(): FakeSource {
  return new FakeSource({
    live: [liveSession('live-1', { title: 'Ship it' })],
    recent: [endedSession('old', { title: 'Finished long ago' })],
    limits: LIMITS,
    usage: USAGE,
  });
}

const unreachable = (t: TestContext): Env['fetch'] => {
  const calls = t.mock.fn(async () => {
    throw new Error('connection refused');
  });
  return calls as unknown as Env['fetch'];
};

describe('status', () => {
  it('reads the disk when no tracker is running', async (t) => {
    const result = await run([], { fetch: unreachable(t), ports: [1], registry: disk(populated()) });

    strictEqual(result.code, 0);
    match(result.out, /Claude Code Session Tracker 1\.2\.3\n/);
    match(result.out, /5-hour limit {2}42%/);
    match(result.out, /Today {9}1\.2M tokens in 84 turns\n/);
    match(result.out, /Running {7}1 session\n {4}busy {5}app {2}Ship it\n/);
    ok(!result.out.includes('Finished long ago'));
    match(result.out, /Dashboard {5}not running/);
  });

  it('asks only for today', async (t) => {
    const source = populated();
    await run([], { fetch: unreachable(t), ports: [1], registry: disk(source) });

    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    strictEqual(source.usageQueries[0]?.since, midnight.getTime());
    strictEqual(source.usageQueries[0]?.until, NOW);
  });

  it('asks a running tracker, and says where its page is', async (t) => {
    const server = await startServer(t, [populated()]);
    const result = await run([], { fetch, ports: [server.port], registry: disk(new FakeSource()) });

    strictEqual(result.code, 0);
    match(result.out, /5-hour limit {2}42%/);
    match(result.out, /Running {7}1 session\n/);
    match(result.out, new RegExp(`Dashboard {5}http://127\\.0\\.0\\.1:${server.port}\\n`));
  });

  it('reads the disk when the tracker reads some other directory', async (t) => {
    const server = await startServer(t, [new FakeSource()]);
    const result = await run(['--claude-dir', '/somewhere/else'], { fetch, ports: [server.port], registry: disk(populated()) });

    match(result.out, /Running {7}1 session\n/);
    // Still running, though, so its page is still worth pointing at.
    match(result.out, new RegExp(`Dashboard {5}http://127\\.0\\.0\\.1:${server.port}\\n`));
  });

  it('asks nobody with --offline', async (t) => {
    const fetcher = unreachable(t);
    const seen: object[] = [];
    const result = await run(['--offline'], { fetch: fetcher, ports: [1], registry: disk(populated(), seen) });

    strictEqual((fetcher as unknown as { mock: { callCount(): number } }).mock.callCount(), 0);
    strictEqual((seen[0] as { offline: boolean }).offline, true);
    match(result.out, /Running {7}1 session\n/);
  });

  it('has something to say on a machine with no Claude data', async (t) => {
    const result = await run([], { fetch: unreachable(t), ports: [1], registry: disk(new FakeSource({ available: false })) });

    strictEqual(result.code, 0);
    match(result.out, /Limits {8}no reading\n/);
    match(result.out, /Running {7}no sessions\n/);
  });

  it('says what went wrong without failing', async (t) => {
    const source = populated();
    source.listLive = async () => {
      throw new Error('disk on fire');
    };
    const result = await run([], { fetch: unreachable(t), ports: [1], registry: disk(source) });

    strictEqual(result.code, 0);
    match(result.out, /Could not read .*\n {2}disk on fire\n/);
  });

  it('refuses a flag it does not know', async (t) => {
    const result = await run(['--nope'], { fetch: unreachable(t), ports: [1], registry: disk(populated()) });

    strictEqual(result.code, 1);
    match(result.err, /Usage/);
    strictEqual(result.out, '');
  });

  it('prints its usage for --help', async (t) => {
    const result = await run(['--help'], { fetch: unreachable(t), ports: [1], registry: disk(populated()) });

    strictEqual(result.code, 0);
    match(result.out, /claude-code-session-tracker status/);
  });
});
