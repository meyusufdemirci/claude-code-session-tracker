import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { listLiveSessions } from '../../../src/sources/claude-code/live.ts';
import { claudeHome, sessionId } from '../../helpers/claude-dir.ts';
import { makeFile } from '../../helpers/temp.ts';

/** Two processes that are certainly running while this test does: us and our parent. */
const ALIVE = process.pid;
const ALSO_ALIVE = process.ppid;

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid ?? 0;
}

/** A record shaped like the ones in `~/.claude/sessions`, minus the liveness claim. */
function liveJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: sessionId(1),
    cwd: '/Users/y/Work/app',
    startedAt: 1_787_119_735_220,
    updatedAt: 1_787_120_011_071,
    version: '2.1.235',
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'app-f0',
    status: 'waiting',
    waitingFor: 'input needed',
    ...overrides,
  };
}

describe('listLiveSessions', () => {
  it('turns a session file into a row', async (t) => {
    const home = await claudeHome(t);
    await home.liveRecord(ALIVE, liveJson());

    const [session, ...rest] = await listLiveSessions(home.config);

    deepStrictEqual(rest, []);
    strictEqual(session?.id, sessionId(1));
    strictEqual(session?.source, 'claude-code');
    strictEqual(session?.status, 'waiting');
    strictEqual(session?.waitingFor, 'input needed');
    strictEqual(session?.name, 'app-f0');
    strictEqual(session?.version, '2.1.235');
    strictEqual(session?.project.name, 'app');
    strictEqual(session?.project.path, '/Users/y/Work/app');
    strictEqual(session?.live?.pid, ALIVE);
    strictEqual(session?.lastActiveAt, 1_787_120_011_071);
  });

  it('leaves out a session whose process has gone', async (t) => {
    // Session files are not cleaned up reliably, so this is the common case, not
    // the exception — most of what is in that directory is history.
    const home = await claudeHome(t);
    await home.liveRecord(deadPid(), liveJson());

    deepStrictEqual(await listLiveSessions(home.config), []);
  });

  it('reads only the files that are ours to read', async (t) => {
    // The directory also holds `<pid>.<hash>.key` files and whatever else arrives.
    const home = await claudeHome(t);
    await makeFile(home.config.sessionsDir, `${ALIVE}.abc123.key`, 'secret');
    await makeFile(home.config.sessionsDir, 'notes.txt', 'hello');
    await makeFile(home.config.sessionsDir, `${ALIVE}.json.bak`, JSON.stringify(liveJson()));

    deepStrictEqual(await listLiveSessions(home.config), []);
  });

  it('skips a half-written file and keeps the rest of the listing', async (t) => {
    const home = await claudeHome(t);
    await home.liveRecord(ALIVE, '{"sessionId": "half');
    await home.liveRecord(ALSO_ALIVE, liveJson({ sessionId: sessionId(2) }));

    const sessions = await listLiveSessions(home.config);

    strictEqual(sessions.length, 1);
    strictEqual(sessions[0]?.id, sessionId(2));
  });

  it('skips a record with nothing to identify it by', async (t) => {
    // Without a session id there is nothing to merge against, and without a cwd
    // there is no project to file it under.
    const home = await claudeHome(t);
    await home.liveRecord(ALIVE, liveJson({ sessionId: undefined }));

    deepStrictEqual(await listLiveSessions(home.config), []);

    const other = await claudeHome(t);
    await other.liveRecord(ALIVE, liveJson({ cwd: undefined }));

    deepStrictEqual(await listLiveSessions(other.config), []);
  });

  it('reads an unfamiliar status as idle rather than dropping the session', async (t) => {
    // A new status in a future Claude Code release is still a running session.
    const home = await claudeHome(t);
    await home.liveRecord(ALIVE, liveJson({ status: 'compacting' }));

    strictEqual((await listLiveSessions(home.config))[0]?.status, 'idle');
  });

  it('believes the pid inside the file over the one in its name', async (t) => {
    const home = await claudeHome(t);
    await home.liveRecord(4_000_001, liveJson({ pid: ALIVE }));

    strictEqual((await listLiveSessions(home.config))[0]?.live?.pid, ALIVE);
  });

  it('keeps the newest record when one session is written under two pids', async (t) => {
    // Resuming a session leaves the old file behind, both naming one session id.
    const home = await claudeHome(t);
    await home.liveRecord(ALIVE, liveJson({ updatedAt: 100, name: 'older' }));
    await home.liveRecord(ALSO_ALIVE, liveJson({ updatedAt: 200, name: 'newer' }));

    const sessions = await listLiveSessions(home.config);

    strictEqual(sessions.length, 1);
    strictEqual(sessions[0]?.name, 'newer');
  });

  it('falls back to the status timestamp, then to the start time', async (t) => {
    const home = await claudeHome(t);
    await home.liveRecord(
      ALIVE,
      liveJson({ updatedAt: undefined, statusUpdatedAt: 500, startedAt: 100 }),
    );
    strictEqual((await listLiveSessions(home.config))[0]?.lastActiveAt, 500);

    const other = await claudeHome(t);
    await other.liveRecord(
      ALIVE,
      liveJson({ updatedAt: undefined, statusUpdatedAt: undefined, startedAt: 100 }),
    );
    strictEqual((await listLiveSessions(other.config))[0]?.lastActiveAt, 100);
  });

  it('shows the branch the working directory is on now', async (t) => {
    const home = await claudeHome(t);
    const repo = await makeFile(home.config.claudeDir, 'repo/.git/HEAD', 'ref: refs/heads/main\n');
    const cwd = repo.replace('/.git/HEAD', '');
    await home.liveRecord(ALIVE, liveJson({ cwd }));

    strictEqual((await listLiveSessions(home.config))[0]?.project.gitBranch, 'main');
  });

  it('lists the most recently active session first', async (t) => {
    const home = await claudeHome(t);
    await home.liveRecord(ALIVE, liveJson({ sessionId: sessionId(1), updatedAt: 100 }));
    await home.liveRecord(ALSO_ALIVE, liveJson({ sessionId: sessionId(2), updatedAt: 200 }));

    deepStrictEqual(
      (await listLiveSessions(home.config)).map((s) => s.id),
      [sessionId(2), sessionId(1)],
    );
  });

  it('reports nothing rather than failing when there is no sessions directory', async (t) => {
    // A machine that has never run Claude Code, or a custom CLAUDE_CONFIG_DIR.
    const home = await claudeHome(t);
    const config = { ...home.config, sessionsDir: '/nowhere/at/all' };

    deepStrictEqual(await listLiveSessions(config), []);
  });
});
