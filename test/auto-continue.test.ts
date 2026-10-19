import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  appDataDir,
  AutoContinue,
  carriedOn,
  GRACE_MS,
  lastRefusal,
  WAKE,
  WAKE_MESSAGE,
  waitToContinue,
  type LimitClock,
  type LimitReading,
  type WaitEnv,
} from '../src/auto-continue.ts';
import { startServer } from './helpers/http.ts';
import { assistantRecord, rejectionRecord, userRecord } from './helpers/records.ts';

/** Transcript lines, each ended the way Claude Code ends them. */
const lines = (...records: string[]): string => records.map((record) => `${record}\n`).join('');
import { makeFile, tempDir } from './helpers/temp.ts';

const HOUR = 60 * 60 * 1000;
/** A reset on a whole second, the way Claude Code writes it. */
const RESET = 1_800_000_000_000;

async function fixture(t: TestContext, alive: (pid: number) => boolean = () => true) {
  const dir = await tempDir(t);
  const claudeDir = join(dir, 'claude');
  const autoContinue = new AutoContinue({ claudeDir, stateDir: join(dir, 'state'), alive });
  return { dir, claudeDir, autoContinue };
}

/** A clock that only moves when the hook sleeps, so hours of waiting take no time. */
function env(autoContinue: AutoContinue, start: number, readings?: () => Partial<Record<LimitClock, LimitReading>> | undefined) {
  let now = start;
  const said: string[] = [];
  const slept: number[] = [];
  const waitEnv: WaitEnv = {
    autoContinue,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    readings: async () => readings?.(),
    pid: 4242,
    say: (text) => said.push(text),
  };
  return { waitEnv, said, slept, now: () => now };
}

async function stoppedTranscript(dir: string, resetsAt = RESET): Promise<string> {
  return makeFile(dir, 'session.jsonl', lines(userRecord('Build it'), assistantRecord(), rejectionRecord({ resetsAt: resetsAt / 1000 })));
}

const input = (transcript?: string) => ({ session_id: 'abc', transcript_path: transcript, cwd: '/code/app', error: 'rate_limit' });

describe('the auto continue switch', () => {
  it('is off until turned on, and remembers being turned on', async (t) => {
    const { autoContinue, dir, claudeDir } = await fixture(t);
    strictEqual(autoContinue.enabled(), false);

    autoContinue.setEnabled(true);
    strictEqual(new AutoContinue({ claudeDir, stateDir: join(dir, 'state') }).enabled(), true);
    autoContinue.setEnabled(false);
    strictEqual(autoContinue.enabled(), false);
  });

  it('lives in the tool’s own folder on each platform', () => {
    strictEqual(appDataDir('darwin', {}, '/Users/me'), '/Users/me/Library/Application Support/claude-code-session-tracker');
    strictEqual(appDataDir('linux', {}, '/home/me'), '/home/me/.local/state/claude-code-session-tracker');
    strictEqual(appDataDir('linux', { XDG_STATE_HOME: '/state' }, '/home/me'), '/state/claude-code-session-tracker');
    strictEqual(appDataDir('win32', { LOCALAPPDATA: 'C:\\Local' }, 'C:\\me'), join('C:\\Local', 'claude-code-session-tracker'));
  });
});

describe('the plugin’s state', () => {
  const register = (claudeDir: string, installPath: string) =>
    makeFile(claudeDir, 'plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'session-tracker@claude-code-session-tracker': [{ scope: 'user', installPath }] } }));

  it('is missing when Claude Code has not installed it', async (t) => {
    strictEqual((await fixture(t)).autoContinue.plugin(), 'missing');
  });

  it('is outdated when the installed copy carries no hook', async (t) => {
    const { autoContinue, claudeDir, dir } = await fixture(t);
    await register(claudeDir, join(dir, 'install'));
    strictEqual(autoContinue.plugin(), 'outdated');
  });

  it('is ready with the hook, and disabled when switched off in Claude Code', async (t) => {
    const { autoContinue, claudeDir, dir } = await fixture(t);
    await register(claudeDir, join(dir, 'install'));
    await makeFile(dir, 'install/hooks/hooks.json', '{}');
    strictEqual(autoContinue.plugin(), 'ready');

    await makeFile(claudeDir, 'settings.json', JSON.stringify({ enabledPlugins: { 'session-tracker@claude-code-session-tracker': false } }));
    strictEqual(autoContinue.plugin(), 'disabled');
  });
});

describe('the waiting sessions', () => {
  const entry = (pid: number, continueAt: number) => ({ sessionId: `s${pid}`, pid, clock: 'five_hour' as const, resetsAt: continueAt - GRACE_MS, continueAt, since: 0 });

  it('lists live hooks soonest first, and clears away one whose process is gone', async (t) => {
    const { autoContinue, dir } = await fixture(t, (pid) => pid !== 3);
    autoContinue.register(entry(1, 2000));
    autoContinue.register(entry(2, 1000));
    autoContinue.register(entry(3, 500));

    deepStrictEqual(autoContinue.pending().map((pending) => pending.pid), [2, 1]);
    deepStrictEqual((await readdir(join(dir, 'state', 'auto-continue'))).sort(), ['1.json', '2.json']);
  });
});

describe('reading the transcript', () => {
  it('finds the refusal that ended the last turn, and its reset in milliseconds', async (t) => {
    const transcript = await stoppedTranscript(await tempDir(t));
    const stop = lastRefusal(transcript);
    strictEqual(stop?.clock, 'five_hour');
    strictEqual(stop?.resetsAt, RESET);
  });

  it('reads a weekly refusal, per-model ones included, as the week', async (t) => {
    const dir = await tempDir(t);
    const transcript = await makeFile(dir, 'w.jsonl', lines(rejectionRecord({ rateLimitType: 'seven_day_opus', resetsAt: RESET / 1000 })));
    strictEqual(lastRefusal(transcript)?.clock, 'weekly');
  });

  it('ignores a refusal a later turn got past', async (t) => {
    const dir = await tempDir(t);
    const transcript = await makeFile(dir, 'ok.jsonl', lines(rejectionRecord({ resetsAt: RESET / 1000 }), userRecord('again'), assistantRecord({ id: 'msg_2' })));
    strictEqual(lastRefusal(transcript), undefined);
  });

  it('counts a typed prompt or a turn that went through as carrying on, but not another refusal', async (t) => {
    const transcript = await stoppedTranscript(await tempDir(t));
    const offset = lastRefusal(transcript)?.offset ?? 0;
    strictEqual(carriedOn(transcript, offset), false);

    await appendFile(transcript, lines(rejectionRecord({ resetsAt: RESET / 1000 })));
    strictEqual(carriedOn(transcript, offset), false);

    await appendFile(transcript, lines(userRecord('carry on')));
    strictEqual(carriedOn(transcript, offset), true);
  });
});

describe('the hook', () => {
  it('waits until a minute past the reset and wakes the session, when auto continue is on', async (t) => {
    const { autoContinue, dir } = await fixture(t);
    autoContinue.setEnabled(true);
    const transcript = await stoppedTranscript(dir);
    const run = env(autoContinue, RESET - 2 * HOUR);

    const pending = waitToContinue(input(transcript), run.waitEnv);
    strictEqual(await pending, WAKE);

    strictEqual(run.now(), RESET + GRACE_MS);
    deepStrictEqual(run.said, [WAKE_MESSAGE]);
    deepStrictEqual(autoContinue.continued().map((entry) => entry.sessionId), ['abc']);
    deepStrictEqual(autoContinue.pending(), [], 'its line is gone once it is done');
  });

  it('says what it is waiting for while it waits', async (t) => {
    const { autoContinue, dir } = await fixture(t);
    const transcript = await stoppedTranscript(dir);
    const run = env(autoContinue, RESET - HOUR);
    let seen: ReturnType<AutoContinue['pending']> = [];
    const sleep = run.waitEnv.sleep;
    run.waitEnv.sleep = async (ms) => {
      if (seen.length === 0) seen = autoContinue.pending();
      await sleep(ms);
    };

    await waitToContinue(input(transcript), run.waitEnv);
    strictEqual(seen.length, 1);
    deepStrictEqual({ ...seen[0] }, { sessionId: 'abc', pid: 4242, cwd: '/code/app', clock: 'five_hour', resetsAt: RESET, continueAt: RESET + GRACE_MS, since: RESET - HOUR });
  });

  it('leaves the session be when auto continue is off at the reset', async (t) => {
    const { autoContinue, dir } = await fixture(t);
    const run = env(autoContinue, RESET - HOUR);

    strictEqual(await waitToContinue(input(await stoppedTranscript(dir)), run.waitEnv), 0);
    deepStrictEqual(run.said, []);
  });

  it('reads the switch at the reset, so turning it on while waiting still counts', async (t) => {
    const { autoContinue, dir } = await fixture(t);
    const run = env(autoContinue, RESET - HOUR);
    const sleep = run.waitEnv.sleep;
    run.waitEnv.sleep = async (ms) => {
      autoContinue.setEnabled(true);
      await sleep(ms);
    };

    strictEqual(await waitToContinue(input(await stoppedTranscript(dir)), run.waitEnv), WAKE);
  });

  it('stops waiting as soon as the session carries on without it', async (t) => {
    const { autoContinue, dir } = await fixture(t);
    autoContinue.setEnabled(true);
    const transcript = await stoppedTranscript(dir);
    const run = env(autoContinue, RESET - 2 * HOUR);
    const sleep = run.waitEnv.sleep;
    run.waitEnv.sleep = async (ms) => {
      await appendFile(transcript, lines(userRecord('never mind')));
      await sleep(ms);
    };

    strictEqual(await waitToContinue(input(transcript), run.waitEnv), 0);
    ok(run.now() < RESET, 'it did not sit out the whole wait');
  });

  it('waits for the next reset when a reading taken after this one is still full', async (t) => {
    const { autoContinue, dir } = await fixture(t);
    autoContinue.setEnabled(true);
    const later = RESET + HOUR;
    let asked = 0;
    const run = env(autoContinue, RESET - HOUR, () => {
      asked++;
      return asked === 1 ? { five_hour: { percent: 100, fetchedAt: RESET + 1, resetsAt: later } } : undefined;
    });

    strictEqual(await waitToContinue(input(await stoppedTranscript(dir)), run.waitEnv), WAKE);
    strictEqual(run.now(), later + GRACE_MS);
  });

  it('takes the reset at its word over a reading from before it', async (t) => {
    const { autoContinue, dir } = await fixture(t);
    autoContinue.setEnabled(true);
    const run = env(autoContinue, RESET - HOUR, () => ({ five_hour: { percent: 100, fetchedAt: RESET - 10, resetsAt: RESET } }));

    strictEqual(await waitToContinue(input(await stoppedTranscript(dir)), run.waitEnv), WAKE);
    strictEqual(run.now(), RESET + GRACE_MS);
  });

  it('falls back to the tracker’s reading when the session keeps no transcript', async (t) => {
    const { autoContinue } = await fixture(t);
    autoContinue.setEnabled(true);
    const run = env(autoContinue, RESET - HOUR, () => ({ weekly: { percent: 100, fetchedAt: RESET - HOUR, resetsAt: RESET } }));

    strictEqual(await waitToContinue(input(), run.waitEnv), WAKE);
    strictEqual(run.now(), RESET + GRACE_MS);
  });

  it('does nothing for another error, or a rate limit with no reset to wait for', async (t) => {
    const { autoContinue } = await fixture(t);
    autoContinue.setEnabled(true);

    strictEqual(await waitToContinue({ ...input(), error: 'overloaded' }, env(autoContinue, RESET).waitEnv), 0);
    strictEqual(await waitToContinue(input(), env(autoContinue, RESET).waitEnv), 0);
    deepStrictEqual(autoContinue.pending(), []);
  });
});

describe('the auto continue route', () => {
  const sameOrigin = { origin: 'http://127.0.0.1:3099', 'content-type': 'application/json' };

  it('says where the switch stands', async (t) => {
    const server = await startServer(t, []);
    const res = await server.fetch('/api/auto-continue');
    strictEqual(res.status, 200);
    deepStrictEqual(res.json(), { enabled: false, plugin: 'missing', pending: [], continued: [] });
  });

  it('turns it on for the tracker’s own page', async (t) => {
    const server = await startServer(t, []);
    const res = await server.fetch('/api/auto-continue', { method: 'POST', headers: sameOrigin, body: '{"enabled":true}' });
    strictEqual(res.status, 200);
    strictEqual((res.json() as { enabled: boolean }).enabled, true);
    strictEqual(((await server.fetch('/api/auto-continue')).json() as { enabled: boolean }).enabled, true);
  });

  it('refuses another website, and a body that is not a switch', async (t) => {
    const server = await startServer(t, []);
    const body = '{"enabled":true}';
    strictEqual((await server.fetch('/api/auto-continue', { method: 'POST', body })).status, 403);
    strictEqual((await server.fetch('/api/auto-continue', { method: 'POST', body, headers: { origin: 'https://evil.example.com' } })).status, 403);
    strictEqual((await server.fetch('/api/auto-continue', { method: 'POST', headers: sameOrigin, body: '{"enabled":"yes"}' })).status, 400);
    strictEqual((await server.fetch('/api/auto-continue', { method: 'DELETE', headers: sameOrigin })).status, 405);
    strictEqual(((await server.fetch('/api/auto-continue')).json() as { enabled: boolean }).enabled, false);
  });
});
