import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compareVersions, installMethod, UpdateCheck, updateCommand } from '../src/update.ts';
import { FakeSource } from './helpers/fake-source.ts';
import { startServer } from './helpers/http.ts';

/** A registry that answers `version`, counting how often it was asked. */
function registry(version: string | (() => never)): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fake = (async () => {
    calls++;
    if (typeof version === 'function') version();
    return new Response(JSON.stringify({ name: 'claude-code-session-tracker', version }), { status: 200 });
  }) as typeof fetch;
  return { fetch: fake, calls: () => calls };
}

describe('compareVersions', () => {
  it('orders by number, not by string', () => {
    ok(compareVersions('0.10.0', '0.9.9') > 0);
    ok(compareVersions('0.11.3', '0.11.4') < 0);
    strictEqual(compareVersions('1.2.3', 'v1.2.3'), 0);
  });

  it('puts a prerelease before its release', () => {
    ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0);
    ok(compareVersions('1.0.0', '1.0.0-beta.1') > 0);
  });

  it('calls anything unreadable equal, so it never claims an update', () => {
    strictEqual(compareVersions('garbage', '0.1.0'), 0);
  });
});

describe('installMethod', () => {
  const at = (...parts: string[]): string => join('/', ...parts);

  it('tells each way of installing apart by where the file lives', () => {
    strictEqual(installMethod(at('opt', 'homebrew', 'Cellar', 'claude-code-session-tracker', '0.11.3', 'libexec', 'lib', 'node_modules', 'claude-code-session-tracker', 'dist', 'cli.js')), 'brew');
    strictEqual(installMethod(at('home', 'u', '.npm', '_npx', 'abc', 'node_modules', 'claude-code-session-tracker', 'dist', 'cli.js')), 'runner');
    strictEqual(installMethod(at('usr', 'local', 'lib', 'node_modules', 'claude-code-session-tracker', 'dist', 'cli.js')), 'npm');
    strictEqual(installMethod(at('home', 'u', 'Library', 'pnpm', 'global', '5', 'node_modules', 'claude-code-session-tracker', 'dist', 'cli.js')), 'pnpm');
    strictEqual(installMethod(at('home', 'u', '.bun', 'install', 'global', 'node_modules', 'claude-code-session-tracker', 'dist', 'cli.js')), 'bun');
    strictEqual(installMethod(at('home', 'u', 'src', 'claude-code-session-tracker', 'src', 'cli.ts')), 'unknown');
    strictEqual(installMethod(undefined), 'unknown');
  });

  it('always offers @latest to a one-off runner, whose cache would hand back the old copy', () => {
    strictEqual(updateCommand('runner'), 'npx claude-code-session-tracker@latest');
    strictEqual(updateCommand('brew'), 'brew upgrade meyusufdemirci/tap/claude-code-session-tracker');
  });
});

describe('UpdateCheck', () => {
  it('says when the registry has something newer, and how to get it', async () => {
    const npm = registry('0.12.0');
    const check = new UpdateCheck({ current: '0.11.3', method: 'npm', fetch: npm.fetch });

    deepStrictEqual(await check.status(), {
      current: '0.11.3',
      latest: '0.12.0',
      available: true,
      method: 'npm',
      command: 'npm install -g claude-code-session-tracker@latest',
      notesUrl: 'https://ccst.nefarius.co',
      checked: true,
    });
  });

  it('says nothing is available when this is the newest', async () => {
    const check = new UpdateCheck({ current: '0.12.0', method: 'brew', fetch: registry('0.12.0').fetch });
    strictEqual((await check.status()).available, false);
  });

  it('asks the registry once, then answers from memory', async () => {
    let now = 0;
    const npm = registry('0.12.0');
    const check = new UpdateCheck({ current: '0.11.3', fetch: npm.fetch, now: () => now });

    await Promise.all([check.status(), check.status()]);
    await check.status();
    strictEqual(npm.calls(), 1);

    now += 7 * 60 * 60 * 1000;
    await check.status();
    strictEqual(npm.calls(), 2);
  });

  it('keeps quiet when the registry cannot be reached', async () => {
    const check = new UpdateCheck({
      current: '0.11.3',
      fetch: registry(() => {
        throw new Error('offline');
      }).fetch,
    });
    const status = await check.status();
    strictEqual(status.available, false);
    strictEqual(status.latest, undefined);
  });

  it('asks nothing at all under --offline', async () => {
    const npm = registry('0.12.0');
    const status = await new UpdateCheck({ offline: true, current: '0.11.3', fetch: npm.fetch }).status();
    strictEqual(npm.calls(), 0);
    strictEqual(status.checked, false);
    strictEqual(status.available, false);
  });
});

describe('GET /api/update', () => {
  it('serves the check', async (t) => {
    const updates = new UpdateCheck({ current: '0.11.3', method: 'brew', fetch: registry('0.12.0').fetch });
    const server = await startServer(t, [new FakeSource({})], updates);

    const res = await server.fetch('/api/update');
    const body = res.json() as Record<string, unknown>;

    strictEqual(res.status, 200);
    strictEqual(body['available'], true);
    strictEqual(body['latest'], '0.12.0');
  });
});
