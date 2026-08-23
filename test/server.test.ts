import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConfig } from '../src/config.ts';
import type { SessionDetail, UsageHistory, UsageLimits } from '../src/core/types.ts';
import { createServer, listen } from '../src/server.ts';
import { SessionRegistry } from '../src/core/registry.ts';
import { endedSession, FakeSource, liveSession } from './helpers/fake-source.ts';
import { occupyPort, startServer } from './helpers/http.ts';

/** A detail with no transcript on disk — enough to reach the reveal route's last check. */
const detailWithoutFile = { ...endedSession('a'), transcriptPath: undefined } as SessionDetail;

function source(): FakeSource {
  return new FakeSource({
    live: [liveSession('live-1')],
    recent: [
      endedSession('a', { lastActiveAt: 3_000 }),
      endedSession('b', { lastActiveAt: 2_000 }),
    ],
    details: { a: detailWithoutFile },
  });
}

describe('GET /api/health', () => {
  it('says what it is and what it can see', async (t) => {
    const server = await startServer(t, [source()]);

    const res = await server.fetch('/api/health');
    const body = res.json() as Record<string, unknown>;

    strictEqual(res.status, 200);
    strictEqual(body['ok'], true);
    ok(typeof body['version'] === 'string');
    ok(typeof body['claudeDir'] === 'string');
    ok(Array.isArray(body['sources']));
  });
});

describe('when a source throws', () => {
  it('answers a JSON 500 rather than leaving the socket open', async (t) => {
    // The `.jsonl` format is private and will change under us. A reader that throws
    // somewhere we did not anticipate must still close out the request.
    class BrokenSource extends FakeSource {
      override async listRecent(): Promise<never> {
        throw new Error('the transcript reader gave up');
      }
    }
    const server = await startServer(t, [new BrokenSource()]);

    const res = await server.fetch('/api/sessions');

    strictEqual(res.status, 500);
    strictEqual((res.json() as { error: string }).error, 'the transcript reader gave up');
  });
});

describe('GET /api/sessions', () => {
  it('returns the merged list', async (t) => {
    const server = await startServer(t, [source()]);

    const body = (await server.fetch('/api/sessions')).json() as {
      sessions: { id: string }[];
      total: number;
    };

    strictEqual(body.sessions.length, 3);
    strictEqual(body.sessions[0]?.id, 'live-1', 'running first');
  });

  it('reads limit, sort and the window off the query string', async (t) => {
    const only = new FakeSource({
      recent: [
        endedSession('a', { lastActiveAt: 1_000 }),
        endedSession('b', { lastActiveAt: 5_000 }),
        endedSession('c', { lastActiveAt: 9_000 }),
      ],
    });
    const server = await startServer(t, [only]);

    await server.fetch('/api/sessions?limit=2&sort=tokens-asc&since=1000&until=9000');

    const query = only.queries[0];
    strictEqual(query?.limit, 2);
    strictEqual(query?.sort, 'tokens-asc');
    strictEqual(query?.since, 1_000);
    strictEqual(query?.until, 9_000);
  });

  it('shrugs off parameters it cannot read', async (t) => {
    // A typo in a query string is not a reason to fail a request.
    const only = new FakeSource({ recent: [endedSession('a')] });
    const server = await startServer(t, [only]);

    const res = await server.fetch('/api/sessions?limit=lots&sort=sideways&since=yesterday');

    strictEqual(res.status, 200);
    strictEqual(only.queries[0]?.limit, 50);
    strictEqual(only.queries[0]?.sort, 'recent');
    strictEqual(only.queries[0]?.since, undefined);
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns one session in full', async (t) => {
    const server = await startServer(t, [source()]);

    const res = await server.fetch('/api/sessions/a');

    strictEqual(res.status, 200);
    strictEqual((res.json() as { id: string }).id, 'a');
  });

  it('answers 404 for a session nothing knows about', async (t) => {
    const server = await startServer(t, [source()]);

    strictEqual((await server.fetch('/api/sessions/nope')).status, 404);
  });

  it('answers 404 for an endpoint that does not exist', async (t) => {
    const server = await startServer(t, [source()]);

    // The rollup route the plan describes but nothing implements yet.
    strictEqual((await server.fetch('/api/projects')).status, 404);
  });

  it('refuses a method that would mean writing something', async (t) => {
    const server = await startServer(t, [source()]);

    strictEqual((await server.fetch('/api/sessions', { method: 'DELETE' })).status, 405);
  });
});

describe('GET /api/limits', () => {
  const limits: UsageLimits = {
    session: {
      windowMs: 18_000,
      clock: 'chained',
      current: {
        startedAt: 1_000,
        resetsAt: 19_000,
        resetsAtIsReported: false,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
        turns: 1,
        limited: false,
      },
      historyDays: 7,
    },
    weekly: { windowMs: 604_800_000, clock: 'rolling', historyDays: 28 },
    generatedAt: 2_000,
  };

  it('returns the window the source measured', async (t) => {
    const server = await startServer(t, [new FakeSource({ limits })]);

    const res = await server.fetch('/api/limits');

    strictEqual(res.status, 200);
    strictEqual((res.json() as UsageLimits).session.current?.resetsAt, 19_000);
  });

  it('404s when no source can measure one', async (t) => {
    // Not an error the page should shout about — it just does not draw the strip.
    const server = await startServer(t, [source()]);

    const res = await server.fetch('/api/limits');

    strictEqual(res.status, 404);
  });
});

describe('GET /api/usage/history', () => {
  const usage: UsageHistory = {
    range: { since: 1_000, until: 2_000 },
    bucketMs: 1_800_000,
    buckets: [{ at: 1_000, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 }, turns: 1, limited: false }],
    projects: [
      {
        slug: '-Users-y-Work-app',
        name: 'app',
        path: '/Users/y/Work/app',
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
        turns: 1,
      },
    ],
    models: [
      { model: 'claude-opus-5', tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 }, turns: 1 },
    ],
    generatedAt: 2_000,
  };

  it('returns what the source read', async (t) => {
    const server = await startServer(t, [new FakeSource({ usage })]);

    const res = await server.fetch('/api/usage/history');

    strictEqual(res.status, 200);
    strictEqual((res.json() as UsageHistory).projects[0]?.name, 'app');
  });

  it('reads the range and the project off the query string', async (t) => {
    const measuring = new FakeSource({ usage });
    const server = await startServer(t, [measuring]);

    await server.fetch('/api/usage/history?since=1000&until=2000&project=-Users-y-Work-app');

    deepStrictEqual(measuring.usageQueries.at(-1), {
      since: 1_000,
      until: 2_000,
      project: '-Users-y-Work-app',
    });
  });

  it('passes on the ends it was not given rather than inventing them', async (t) => {
    // The source owns the defaults — it is the one that knows what it can afford to read.
    const measuring = new FakeSource({ usage });
    const server = await startServer(t, [measuring]);

    await server.fetch('/api/usage/history');

    deepStrictEqual(measuring.usageQueries.at(-1), {
      since: undefined,
      until: undefined,
      project: undefined,
    });
  });

  it('404s when no source can say', async (t) => {
    const server = await startServer(t, [source()]);

    const res = await server.fetch('/api/usage/history');

    strictEqual(res.status, 404);
  });
});

describe('the loopback guard', () => {
  it('answers a request addressed to a loopback host', async (t) => {
    const server = await startServer(t, [source()]);

    for (const host of [`127.0.0.1:${server.port}`, 'localhost', '[::1]', 'LOCALHOST']) {
      const res = await server.fetch('/api/health', { headers: { host } });
      strictEqual(res.status, 200, `expected ${host} to be accepted`);
    }
  });

  it('refuses one addressed to anything else', async (t) => {
    // The address being loopback only proves the packet arrived locally, which a
    // DNS rebind arranges for free. The Host header is what names who was asked.
    const server = await startServer(t, [source()]);

    for (const host of ['evil.example.com', 'attacker.test:80']) {
      const res = await server.fetch('/api/health', { headers: { host } });
      strictEqual(res.status, 403, `expected ${host} to be refused`);
    }
  });
});

describe('POST /api/sessions/:id/reveal', () => {
  it('is the one route that acts, so it will not answer a GET', async (t) => {
    const server = await startServer(t, [source()]);

    const res = await server.fetch('/api/sessions/a/reveal');

    strictEqual(res.status, 405);
    strictEqual(res.headers['allow'], 'POST');
  });

  it('refuses a POST with no Origin at all', async (t) => {
    // Browsers always send one on a POST, so a missing Origin is not our page.
    const server = await startServer(t, [source()]);

    strictEqual((await server.fetch('/api/sessions/a/reveal', { method: 'POST' })).status, 403);
  });

  it('refuses a POST from a page on the web', async (t) => {
    const server = await startServer(t, [source()]);

    for (const origin of ['https://evil.example.com', 'null', 'not a url']) {
      const res = await server.fetch('/api/sessions/a/reveal', {
        method: 'POST',
        headers: { origin },
      });
      strictEqual(res.status, 403, `expected ${origin} to be refused`);
    }
  });

  it('accepts our own page, and still reveals nothing it cannot vouch for', async (t) => {
    // The path is never taken from the request: the id is looked up and the
    // transcript the source vouches for is what gets revealed. With no transcript
    // on disk there is nothing to show, which is a 404 rather than a spawn.
    const server = await startServer(t, [source()]);

    const res = await server.fetch('/api/sessions/a/reveal', {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${server.port}` },
    });

    strictEqual(res.status, 404);
  });
});

describe('static assets', () => {
  it('serves the page at the root', async (t) => {
    const server = await startServer(t, [source()]);

    const res = await server.fetch('/');

    strictEqual(res.status, 200);
    strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
    ok(res.body.includes('<!doctype html>') || res.body.includes('<!DOCTYPE html>'));
  });

  it('serves the history page at /history', async (t) => {
    // A named route rather than an extension guess, so this is the whole of what
    // makes an extensionless path work.
    const server = await startServer(t, [source()]);

    const res = await server.fetch('/history');

    strictEqual(res.status, 200);
    strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
    ok(res.body.includes('/history.js'));
  });

  it('serves the assets both pages share', async (t) => {
    const server = await startServer(t, [source()]);

    for (const path of ['/style.css', '/theme.js', '/format.js']) {
      strictEqual((await server.fetch(path)).status, 200, `expected ${path} to be served`);
    }
  });

  it('does not invent a page for any other extensionless path', async (t) => {
    const server = await startServer(t, [source()]);

    strictEqual((await server.fetch('/sessions')).status, 404);
  });

  it('will not serve a file from outside the web directory', async (t) => {
    // Transcripts and the whole disk sit above that folder.
    const server = await startServer(t, [source()]);

    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
      const res = await server.fetch(path);
      ok(res.status === 403 || res.status === 404, `expected ${path} to be refused`);
      ok(!res.body.includes('"name": "claude-code-session-tracker"'));
    }
  });

  it('answers 404 for an asset that is not there', async (t) => {
    const server = await startServer(t, [source()]);

    strictEqual((await server.fetch('/nothing.css')).status, 404);
  });
});

describe('listen', () => {
  it('steps forward when the port is taken', async (t) => {
    // Two dashboards at once should not be a failure to start.
    const taken = await occupyPort(t);
    const config = createConfig({ port: taken.port });
    const server = createServer({ config, registry: new SessionRegistry(config, []) });
    t.after(() => new Promise((resolve) => server.close(() => resolve(null))));

    strictEqual(await listen(server, config), taken.port + 1);
  });

  it('gives up rather than scanning the machine', async (t) => {
    const taken = await occupyPort(t);
    const config = createConfig({ port: taken.port });
    const server = createServer({ config, registry: new SessionRegistry(config, []) });
    t.after(() => new Promise((resolve) => server.close(() => resolve(null))));

    await rejects(
      () => listen(server, config, 0),
      'a single attempt at a taken port is an error, not an endless walk',
    );
  });

  it('reports a failure to bind that stepping forward cannot fix', async (t) => {
    const config = createConfig({ host: '203.0.113.1', port: 0 });
    const server = createServer({ config, registry: new SessionRegistry(config, []) });
    t.after(() => new Promise((resolve) => server.close(() => resolve(null))));

    await rejects(() => listen(server, config));
  });
});
