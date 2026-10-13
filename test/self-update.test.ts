import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Command, planFor, restartArgs, SelfUpdate, type SelfUpdateOptions } from '../src/self-update.ts';
import { UpdateCheck } from '../src/update.ts';
import { FakeSource } from './helpers/fake-source.ts';
import { startServer } from './helpers/http.ts';

const at = (...parts: string[]): string => join('/', ...parts);

describe('planFor', () => {
  it('upgrades Homebrew with its own brew, and restarts through its own links', () => {
    const cli = at('opt', 'homebrew', 'Cellar', 'claude-code-session-tracker', '0.11.3', 'libexec', 'lib', 'node_modules', 'claude-code-session-tracker', 'dist', 'cli.js');
    const plan = planFor('brew', cli, at('opt', 'homebrew', 'bin', 'node'), 'darwin');
    deepStrictEqual(plan.upgrade, { file: at('opt', 'homebrew', 'bin', 'brew'), args: ['upgrade', 'meyusufdemirci/tap/claude-code-session-tracker'] });
    deepStrictEqual(plan.run(['--version']).args, [at('opt', 'homebrew', 'bin', 'claude-code-session-tracker'), '--version']);
  });

  it('has nothing to upgrade for a runner, and starts @latest instead', () => {
    const plan = planFor('runner', at('home', 'u', '.npm', '_npx', 'a', 'node_modules', 'claude-code-session-tracker', 'dist', 'cli.js'), at('usr', 'bin', 'node'), 'darwin');
    strictEqual(plan.upgrade, undefined);
    strictEqual(plan.blocked, undefined);
    deepStrictEqual(plan.run(['--version']).args, ['-y', 'claude-code-session-tracker@latest', '--version']);
  });

  it('upgrades npm with @latest and restarts from the same link', () => {
    const cli = at('usr', 'local', 'bin', 'claude-code-session-tracker');
    const plan = planFor('npm', cli, at('usr', 'local', 'bin', 'node'), 'darwin');
    deepStrictEqual(plan.upgrade?.args, ['install', '-g', 'claude-code-session-tracker@latest']);
    deepStrictEqual(plan.run(['--no-open']), { file: at('usr', 'local', 'bin', 'node'), args: [cli, '--no-open'] });
  });

  it('refuses a copy no package manager installed', () => {
    ok(planFor('unknown', at('src', 'claude-code-session-tracker', 'src', 'cli.ts')).blocked);
  });
});

/** A self-update whose every outside effect is recorded instead of done. */
function harness(overrides: Partial<SelfUpdateOptions> & { results?: Array<{ ok: boolean; output: string }> } = {}) {
  const ran: Command[] = [];
  const detached: Command[] = [];
  const events: string[] = [];
  const results = overrides.results ?? [{ ok: true, output: '' }, { ok: true, output: '0.12.0\n' }];
  const update = new SelfUpdate({
    plan: {
      upgrade: { file: 'brew', args: ['upgrade', 'x'] },
      run: (args) => ({ file: 'node', args: ['cli.js', ...args] }),
    },
    current: '0.11.3',
    argv: ['--port', '3099'],
    port: () => 3099,
    close: async () => void events.push('close'),
    run: async (command) => {
      ran.push(command);
      return results.shift() ?? { ok: true, output: '' };
    },
    detach: (command) => {
      detached.push(command);
      events.push('detach');
      return 1234;
    },
    exit: () => void events.push('exit'),
    platform: 'linux',
    env: {},
    hasMenubarApp: () => false,
    ...overrides,
  });
  return { update, ran, detached, events };
}

async function settle(update: SelfUpdate): Promise<void> {
  for (let i = 0; i < 50 && update.status().install.state === 'installing'; i++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
}

describe('restartArgs', () => {
  it('keeps every option but the port and the browser, which the restart decides', () => {
    deepStrictEqual(restartArgs(['-p', '4000', '--offline', '--port=5', '--no-open', '--limit', '9'], 3100), ['--offline', '--limit', '9', '--port', '3100', '--no-open']);
  });
});

describe('SelfUpdate', () => {
  it('upgrades, checks the new version, then hands the port to it and leaves', async () => {
    const { update, ran, detached, events } = harness();

    ok(update.start('0.12.0'));
    await settle(update);

    deepStrictEqual(ran.map((c) => c.args), [['upgrade', 'x'], ['cli.js', '--version']]);
    deepStrictEqual(detached, [{ file: 'node', args: ['cli.js', '--port', '3099', '--no-open'] }]);
    deepStrictEqual(events, ['close', 'detach', 'exit']);
    strictEqual(update.status().install.state, 'restarting');
  });

  it('updates the menu bar app too, once the new tracker is on its way', async () => {
    const { update, detached } = harness({ hasMenubarApp: () => true });
    update.start('0.12.0');
    await settle(update);
    deepStrictEqual(detached.map((c) => c.args.slice(1)), [['--port', '3099', '--no-open'], ['menubar', 'install']]);
  });

  it('asks launchd to restart it when autostart started it', async () => {
    const { update, detached, events } = harness({
      platform: 'darwin',
      env: { XPC_SERVICE_NAME: 'com.meyusufdemirci.claude-code-session-tracker' },
    });
    update.start('0.12.0');
    await settle(update);
    strictEqual(detached.length, 1);
    strictEqual(detached[0]?.file, '/bin/launchctl');
    deepStrictEqual(events, ['detach']);
  });

  it('keeps running and says why when the upgrade fails', async () => {
    const { update, detached, events } = harness({ results: [{ ok: false, output: 'Error: permission denied\n' }] });
    update.start('0.12.0');
    await settle(update);

    const { install } = update.status();
    strictEqual(install.state, 'failed');
    ok(install.error?.includes('permission denied'));
    strictEqual(detached.length, 0);
    deepStrictEqual(events, []);
  });

  it('keeps running when the new version does not answer with a newer number', async () => {
    const { update, events } = harness({ results: [{ ok: true, output: '' }, { ok: true, output: '0.11.3\n' }] });
    update.start('0.12.0');
    await settle(update);
    strictEqual(update.status().install.state, 'failed');
    deepStrictEqual(events, []);
  });

  it('runs one update at a time, and none where it is blocked', async () => {
    const { update } = harness();
    ok(update.start('0.12.0'));
    strictEqual(update.start('0.12.0'), false);

    const blocked = harness({ plan: { run: (args) => ({ file: 'node', args }), blocked: 'no' } }).update;
    strictEqual(blocked.start('0.12.0'), false);
    strictEqual(blocked.status().canInstall, false);
  });
});

describe('POST /api/update/install', () => {
  const newer = (async () => new Response(JSON.stringify({ version: '0.12.0' }))) as typeof fetch;

  async function serve(t: Parameters<typeof startServer>[0], current = '0.11.3') {
    const updates = new UpdateCheck({ current, method: 'brew', fetch: newer });
    return startServer(t, [new FakeSource({})], updates, harness().update);
  }

  it('refuses a request from any other origin', async (t) => {
    const server = await serve(t);
    strictEqual((await server.fetch('/api/update/install', { method: 'POST' })).status, 403);
    strictEqual((await server.fetch('/api/update/install', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  });

  it('refuses a GET', async (t) => {
    const server = await serve(t);
    strictEqual((await server.fetch('/api/update/install')).status, 405);
  });

  it('starts the update for the page', async (t) => {
    const server = await serve(t);
    const res = await server.fetch('/api/update/install', { method: 'POST', headers: { origin: `http://127.0.0.1:${server.port}` } });
    strictEqual(res.status, 202);
  });

  it('has nothing to do when this is the newest', async (t) => {
    const server = await serve(t, '0.12.0');
    const res = await server.fetch('/api/update/install', { method: 'POST', headers: { origin: `http://127.0.0.1:${server.port}` } });
    strictEqual(res.status, 409);
  });
});
