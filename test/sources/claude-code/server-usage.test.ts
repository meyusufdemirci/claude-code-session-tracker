import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConfig } from '../../../src/config.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { keychainService, ServerUsage } from '../../../src/sources/claude-code/server-usage.ts';

const NOW = Date.parse('2026-10-01T10:00:00.000Z');
const config = createConfig({ claudeDir: '/nowhere' });

/** What the endpoint returns, cut down to what is read. */
const BODY = {
  five_hour: { utilization: 4.0, resets_at: '2026-10-01T11:39:59.831036+00:00' },
  seven_day: { utilization: 33.0, resets_at: '2026-10-02T23:59:59.831060+00:00' },
  seven_day_opus: null,
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(calls: Call[], respond: () => Response): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return respond();
  }) as unknown as typeof fetch;
}

const ok = (): Response => new Response(JSON.stringify(BODY), { status: 200 });

describe('ServerUsage', () => {
  it('reads both limits off the usage endpoint with the signed-in token', async () => {
    const calls: Call[] = [];
    const usage = new ServerUsage(config, {
      fetch: fakeFetch(calls, ok),
      readToken: async () => ({ value: 'tok', expiresAt: NOW + 1_000 }),
      now: () => NOW,
    });

    const reading = await usage.read();

    strictEqual(calls.length, 1);
    strictEqual(calls[0]?.url, 'https://api.anthropic.com/api/oauth/usage');
    strictEqual(calls[0]?.headers['Authorization'], 'Bearer tok');
    strictEqual(calls[0]?.headers['anthropic-beta'], 'oauth-2025-04-20');
    deepStrictEqual(reading, {
      fetchedAt: NOW,
      source: 'server',
      // Rounded to the minute, as the account file's resets are.
      session: { percent: 4, resetsAt: Date.parse('2026-10-01T11:40:00Z') },
      weekly: { percent: 33, resetsAt: Date.parse('2026-10-03T00:00:00Z') },
    });
  });

  it('asks at most once per five minutes, and once for overlapping polls', async () => {
    const calls: Call[] = [];
    let now = NOW;
    const usage = new ServerUsage(config, {
      fetch: fakeFetch(calls, ok),
      readToken: async () => ({ value: 'tok' }),
      now: () => now,
    });

    await Promise.all([usage.read(), usage.read()]);
    now += 4 * 60 * 1000;
    await usage.read();
    strictEqual(calls.length, 1);

    now += 2 * 60 * 1000;
    await usage.read();
    strictEqual(calls.length, 2);
  });

  it('keeps the last good reading when a later request fails', async () => {
    let now = NOW;
    let status = 200;
    const usage = new ServerUsage(config, {
      fetch: fakeFetch([], () => (status === 200 ? ok() : new Response('', { status }))),
      readToken: async () => ({ value: 'tok' }),
      now: () => now,
    });

    const first = await usage.read();
    status = 429;
    now += 10 * 60 * 1000;

    strictEqual(await usage.read(), first);
  });

  it('never sends an expired token, and asks nothing without one', async () => {
    const calls: Call[] = [];
    const expired = new ServerUsage(config, {
      fetch: fakeFetch(calls, ok),
      readToken: async () => ({ value: 'tok', expiresAt: NOW - 1 }),
      now: () => NOW,
    });
    const missing = new ServerUsage(config, {
      fetch: fakeFetch(calls, ok),
      readToken: async () => undefined,
      now: () => NOW,
    });

    strictEqual(await expired.read(), undefined);
    strictEqual(await missing.read(), undefined);
    strictEqual(calls.length, 0);
  });
});

describe('keychainService', () => {
  it('names the Keychain item the way Claude Code does', () => {
    strictEqual(keychainService(join(homedir(), '.claude')), 'Claude Code-credentials');
    // sha256('/Users/a/.claude-work') starts c7ed87c8… — a moved install keeps its own item.
    strictEqual(keychainService('/Users/a/.claude-work'), `Claude Code-credentials-c7ed87c8`);
  });
});
