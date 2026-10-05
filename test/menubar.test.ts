import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { APP_NAME, appPaths, assetUrl, installPath, menubar, mismatch, readAsset, supportsApp } from '../src/menubar.ts';
import type { AppAsset, Env } from '../src/menubar.ts';
import { makeDir, makeFile, tempDir } from './helpers/temp.ts';

const ZIP = new TextEncoder().encode('not really a zip, but the same bytes every time');
const ASSET: AppAsset = {
  asset: 'claude-code-session-tracker-macos.zip',
  sha256: createHash('sha256').update(ZIP).digest('hex'),
  size: ZIP.length,
};

describe('readAsset', () => {
  it('reads what a release wrote', async (t) => {
    const file = await makeFile(await tempDir(t), 'menubar.json', JSON.stringify(ASSET));
    deepStrictEqual(readAsset(file), ASSET);
  });

  it('is absent from a build no release made', async (t) => {
    strictEqual(readAsset(join(await tempDir(t), 'menubar.json')), undefined);
  });

  it('counts anything but the exact shape as absent', async (t) => {
    const dir = await tempDir(t);
    const cases: Record<string, unknown> = {
      'not-json': 'nope',
      'a-path-for-a-name': { ...ASSET, asset: '../../evil.zip' },
      'not-a-zip': { ...ASSET, asset: 'app.dmg' },
      'a-short-checksum': { ...ASSET, sha256: 'abc123' },
      'an-uppercase-checksum': { ...ASSET, sha256: ASSET.sha256.toUpperCase() },
      'no-size': { asset: ASSET.asset, sha256: ASSET.sha256 },
      'an-empty-size': { ...ASSET, size: 0 },
    };
    for (const [name, contents] of Object.entries(cases)) {
      const file = await makeFile(dir, `${name}.json`, typeof contents === 'string' ? contents : JSON.stringify(contents));
      strictEqual(readAsset(file), undefined, name);
    }
  });
});

describe('assetUrl', () => {
  it("points at this version's own release", () => {
    strictEqual(
      assetUrl('0.10.0', ASSET),
      'https://github.com/meyusufdemirci/claude-code-session-tracker/releases/download/v0.10.0/claude-code-session-tracker-macos.zip',
    );
  });
});

describe('supportsApp', () => {
  it('starts at macOS 14, which is Darwin 23', () => {
    strictEqual(supportsApp('22.6.0'), false);
    strictEqual(supportsApp('23.0.0'), true);
    strictEqual(supportsApp('27.0.0'), true);
  });
});

describe('mismatch', () => {
  it('passes the bytes the package was published with', () => {
    strictEqual(mismatch(ZIP, ASSET), undefined);
  });

  it('names a different length', () => {
    match(mismatch(ZIP.slice(1), ASSET) ?? '', /bytes/);
  });

  it('names a different checksum when the length is the same', () => {
    const tampered = ZIP.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    match(mismatch(tampered, ASSET) ?? '', /checksum/);
  });
});

describe('installPath', () => {
  it('prefers /Applications when this user may write to it', async (t) => {
    const dir = await tempDir(t);
    const env = { systemApps: await makeDir(dir, 'Applications'), home: await makeDir(dir, 'home') };
    strictEqual(installPath(env), join(env.systemApps, APP_NAME));
  });

  it("falls back to the user's own Applications", async (t) => {
    const dir = await tempDir(t);
    const env = { systemApps: join(dir, 'nowhere'), home: await makeDir(dir, 'home') };
    strictEqual(installPath(env), join(env.home, 'Applications', APP_NAME));
  });

  it('goes over the copy that is already there', async (t) => {
    const dir = await tempDir(t);
    const env = { systemApps: await makeDir(dir, 'Applications'), home: await makeDir(dir, 'home') };
    const own = await makeDir(env.home, join('Applications', APP_NAME));
    strictEqual(installPath(env), own);
  });
});

// The command, with the machine stood in for: real files in a temp tree, and the
// programs it would run (ditto, open, pgrep, osascript, plutil) recorded and faked,
// so the same tests run on the Linux runner that never has them.

interface Machine {
  env: Partial<Env>;
  calls: string[][];
  out: string[];
  err: string[];
  io: { out: (text: string) => void; err: (text: string) => void };
  fetched: string[];
  shared: string;
  own: string;
}

async function machine(t: TestContext, options: { body?: Uint8Array; status?: number; running?: boolean } = {}): Promise<Machine> {
  const dir = await tempDir(t);
  const systemApps = await makeDir(dir, 'Applications');
  const home = await makeDir(dir, 'home');
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetched: string[] = [];
  let running = options.running ?? false;

  const run = (command: string, args: string[]): string | undefined => {
    calls.push([command, ...args]);
    if (command === 'pgrep') return running ? '123\n' : undefined;
    if (command === 'osascript') running = false;
    if (command === 'plutil') return '0.9.0\n';
    if (command === 'ditto' && args[0] === '-x') {
      const app = join(args[3] ?? '', APP_NAME);
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, 'marker'), 'new');
    } else if (command === 'ditto') {
      cpSync(args[0] ?? '', args[1] ?? '', { recursive: true });
    }
    return '';
  };

  return {
    env: {
      platform: 'darwin',
      darwinRelease: '24.0.0',
      home,
      systemApps,
      version: '0.10.0',
      asset: ASSET,
      cli: '/opt/homebrew/bin/claude-code-session-tracker',
      fetch: (async (url: string | URL | Request) => {
        fetched.push(String(url));
        return new Response(options.body ?? ZIP, { status: options.status ?? 200 });
      }) as typeof fetch,
      run,
    },
    calls,
    out,
    err,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    fetched,
    ...(([shared, own]) => ({ shared, own }))(appPaths({ systemApps, home }) as [string, string]),
  };
}

const ran = (m: Machine, command: string): string[][] => m.calls.filter((call) => call[0] === command);

describe('menubar', () => {
  it('prints its usage, and fails on a word it does not know', async (t) => {
    const m = await machine(t);
    strictEqual(await menubar([], m.io, m.env), 0);
    match(m.out.join(''), /menubar install/);
    strictEqual(await menubar(['bogus'], m.io, m.env), 1);
    match(m.err.join(''), /menubar install/);
  });

  it('is for macOS only', async (t) => {
    const m = await machine(t);
    for (const action of ['install', 'uninstall', 'status']) {
      strictEqual(await menubar([action], m.io, { ...m.env, platform: 'linux' }), 1, action);
    }
    match(m.err.join(''), /macOS only/);
    strictEqual(m.calls.length, 0);
  });
});

describe('menubar install', () => {
  it("fetches this version's app, puts it in place and opens it", async (t) => {
    const m = await machine(t);
    strictEqual(await menubar(['install'], m.io, m.env), 0);
    deepStrictEqual(m.fetched, [assetUrl('0.10.0', ASSET)]);
    strictEqual(readFileSync(join(m.shared, 'marker'), 'utf8'), 'new');
    deepStrictEqual(ran(m, 'open'), [['open', m.shared]]);
    match(m.out.join(''), /Installed/);
    // Nothing was running, so nothing is asked to quit.
    strictEqual(ran(m, 'osascript').length, 0);
  });

  it('replaces a copy that is there, after asking a running one to quit', async (t) => {
    const m = await machine(t, { running: true });
    await makeFile(m.shared, 'marker', 'old');
    await makeFile(m.shared, 'left-over-from-the-old-version', '');

    strictEqual(await menubar(['install'], m.io, m.env), 0);
    strictEqual(readFileSync(join(m.shared, 'marker'), 'utf8'), 'new');
    strictEqual(existsSync(join(m.shared, 'left-over-from-the-old-version')), false);
    match(m.out.join(''), /Updated/);

    const order = m.calls.map((call) => call[0]);
    ok(order.indexOf('osascript') !== -1, 'asked the running copy to quit');
    ok(order.indexOf('osascript') < order.lastIndexOf('ditto'), 'quit before the files were replaced');
  });

  it('says so when the tracker itself was only fetched for one run', async (t) => {
    const m = await machine(t);
    const cli = '/Users/a/.npm/_npx/1a2b/node_modules/claude-code-session-tracker/dist/cli.js';
    strictEqual(await menubar(['install'], m.io, { ...m.env, cli }), 0);
    match(m.out.join(''), /Install and start/);
  });

  it('refuses a download that is not the app this version was published with', async (t) => {
    const tampered = ZIP.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const m = await machine(t, { body: tampered, running: true });
    await makeFile(m.shared, 'marker', 'old');

    strictEqual(await menubar(['install'], m.io, m.env), 1);
    match(m.err.join(''), /Refusing to install/);
    // The copy already installed is neither stopped nor touched.
    strictEqual(readFileSync(join(m.shared, 'marker'), 'utf8'), 'old');
    strictEqual(m.calls.length, 0);
  });

  it('says what the release answered when the app is not there', async (t) => {
    const m = await machine(t, { status: 404 });
    strictEqual(await menubar(['install'], m.io, m.env), 1);
    match(m.err.join(''), /answered 404/);
    strictEqual(m.calls.length, 0);
  });

  it('downloads nothing for a copy no release built', async (t) => {
    const m = await machine(t);
    strictEqual(await menubar(['install'], m.io, { ...m.env, asset: undefined }), 1);
    match(m.err.join(''), /macos\/build\.sh install/);
    strictEqual(m.fetched.length, 0);
  });

  it('downloads nothing on a macOS older than the app runs on', async (t) => {
    const m = await machine(t);
    strictEqual(await menubar(['install'], m.io, { ...m.env, darwinRelease: '22.6.0' }), 1);
    match(m.err.join(''), /macOS 14/);
    strictEqual(m.fetched.length, 0);
  });
});

describe('menubar uninstall', () => {
  it('removes every copy, after asking a running one to quit', async (t) => {
    const m = await machine(t, { running: true });
    await makeFile(m.shared, 'marker', '');
    await makeFile(m.own, 'marker', '');

    strictEqual(await menubar(['uninstall'], m.io, m.env), 0);
    strictEqual(existsSync(m.shared), false);
    strictEqual(existsSync(m.own), false);
    strictEqual(ran(m, 'osascript').length, 1);
  });

  it('has nothing to do when the app is not installed', async (t) => {
    const m = await machine(t);
    strictEqual(await menubar(['uninstall'], m.io, m.env), 0);
    match(m.out.join(''), /not installed/);
    strictEqual(m.calls.length, 0);
  });
});

describe('menubar status', () => {
  it('says how to install it when it is not there', async (t) => {
    const m = await machine(t);
    strictEqual(await menubar(['status'], m.io, m.env), 0);
    match(m.out.join(''), /not installed/);
  });

  it('says how to catch up when the app is a version behind the tracker', async (t) => {
    const m = await machine(t);
    await makeFile(m.own, 'marker', '');
    strictEqual(await menubar(['status'], m.io, m.env), 0);
    const said = m.out.join('');
    ok(said.includes(m.own));
    match(said, /\(0\.9\.0\)/);
    match(said, /This tracker is 0\.10\.0/);
  });

  it('says nothing more when the two match', async (t) => {
    const m = await machine(t);
    await makeFile(m.own, 'marker', '');
    strictEqual(await menubar(['status'], m.io, { ...m.env, version: '0.9.0' }), 0);
    strictEqual(m.out.join('').includes('This tracker is'), false);
  });
});
