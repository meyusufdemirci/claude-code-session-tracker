import { deepStrictEqual, match, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { logPath, open } from '../src/open.ts';
import type { Env } from '../src/open.ts';
import { FakeSource } from './helpers/fake-source.ts';
import { occupyPort, startServer } from './helpers/http.ts';

describe('logPath', () => {
  it('is the log autostart already writes on macOS and Windows', () => {
    strictEqual(logPath('darwin', {}, '/Users/y'), '/Users/y/Library/Logs/claude-code-session-tracker.log');
    strictEqual(logPath('win32', { LOCALAPPDATA: 'C:\\Local' }, 'C:\\Users\\y'), join('C:\\Local', 'claude-code-session-tracker', 'tracker.log'));
  });

  it('goes under the state directory everywhere else', () => {
    strictEqual(logPath('linux', {}, '/home/y'), '/home/y/.local/state/claude-code-session-tracker/tracker.log');
    strictEqual(logPath('linux', { XDG_STATE_HOME: '/state' }, '/home/y'), '/state/claude-code-session-tracker/tracker.log');
  });
});

// The command, with the machine stood in for: the real server plays a tracker that
// is running, and starting one is recorded rather than done.

interface Machine {
  env: Partial<Env>;
  started: string[][];
  opened: string[];
  waits: number[];
  out: string[];
  err: string[];
  io: { out: (text: string) => void; err: (text: string) => void };
}

/** `comesUp` is the port a tracker answers on once it has been started and waited for that many times. */
async function machine(t: TestContext, options: { ports: number[]; comesUp?: { port: number; after: number }; starts?: boolean }): Promise<Machine> {
  const started: string[][] = [];
  const opened: string[] = [];
  const waits: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const up = (): boolean => started.length > 0 && waits.length >= (options.comesUp?.after ?? Infinity);

  return {
    started,
    opened,
    waits,
    out,
    err,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    env: {
      ports: [...options.ports, ...(options.comesUp ? [options.comesUp.port] : [])],
      // A tracker that has not been started yet is not there to answer.
      fetch: (async (url: string, init?: RequestInit) => {
        if (options.comesUp && new URL(url).port === String(options.comesUp.port) && !up()) throw new Error('connection refused');
        return fetch(url, init);
      }) as typeof fetch,
      cli: '/opt/tracker/dist/cli.js',
      log: '/logs/tracker.log',
      start: (cli, log) => {
        started.push([cli, log]);
        return options.starts ?? true;
      },
      openBrowser: (url) => opened.push(url),
      wait: async (ms) => {
        waits.push(ms);
      },
    },
  };
}

describe('open', () => {
  it('opens the tracker that is already running, at the port it bound', async (t) => {
    const other = await occupyPort(t);
    other.server.on('request', (_req, res) => res.writeHead(404).end());
    const server = await startServer(t, [new FakeSource()]);
    const m = await machine(t, { ports: [other.port, server.port] });

    strictEqual(await open([], m.io, m.env), 0);

    deepStrictEqual(m.opened, [`http://127.0.0.1:${server.port}`]);
    deepStrictEqual(m.started, []);
    match(m.out.join(''), /Opened {2}http:\/\/127\.0\.0\.1:\d+\n/);
  });

  it('starts one when none is running, and opens it once it answers', async (t) => {
    const server = await startServer(t, [new FakeSource()]);
    const m = await machine(t, { ports: [], comesUp: { port: server.port, after: 3 } });

    strictEqual(await open([], m.io, m.env), 0);

    deepStrictEqual(m.started, [['/opt/tracker/dist/cli.js', '/logs/tracker.log']]);
    strictEqual(m.waits.length, 3);
    deepStrictEqual(m.opened, [`http://127.0.0.1:${server.port}`]);
    match(m.out.join(''), /Started the tracker and opened/);
    match(m.out.join(''), /\/logs\/tracker\.log/);
  });

  it('gives up on one that never answers, and names the log', async (t) => {
    const m = await machine(t, { ports: [] });

    strictEqual(await open([], m.io, m.env), 1);

    strictEqual(m.started.length, 1);
    strictEqual(m.waits.length, 40);
    deepStrictEqual(m.opened, []);
    match(m.err.join(''), /has not answered yet.*\/logs\/tracker\.log/);
  });

  it('says so when it cannot be started', async (t) => {
    const m = await machine(t, { ports: [], starts: false });

    strictEqual(await open([], m.io, m.env), 1);

    deepStrictEqual(m.waits, []);
    match(m.err.join(''), /Could not start the tracker/);
  });

  it('cannot start a copy it cannot find', async (t) => {
    const m = await machine(t, { ports: [] });

    strictEqual(await open([], m.io, { ...m.env, cli: undefined }), 1);

    deepStrictEqual(m.started, []);
    match(m.err.join(''), /Cannot tell where/);
  });

  it('prints its usage for --help, and refuses anything else', async (t) => {
    const m = await machine(t, { ports: [] });

    strictEqual(await open(['--help'], m.io, m.env), 0);
    match(m.out.join(''), /claude-code-session-tracker open/);
    strictEqual(await open(['now'], m.io, m.env), 1);
    match(m.err.join(''), /Usage/);
    deepStrictEqual(m.opened, []);
  });
});
