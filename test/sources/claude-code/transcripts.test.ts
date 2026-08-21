import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { utimes } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { FileCache } from '../../../src/core/cache.ts';
import type { Session } from '../../../src/core/types.ts';
import {
  findCandidate,
  listRecentSessions,
  promptText,
} from '../../../src/sources/claude-code/transcripts.ts';
import type { RecentQuery } from '../../../src/sources/source.ts';
import { claudeHome, sessionId, type ClaudeHome } from '../../helpers/claude-dir.ts';
import { makeFile } from '../../helpers/temp.ts';
import {
  assistantRecord,
  commandRecord,
  lastPromptRecord,
  record,
  titleRecord,
  toolResultRecord,
  userRecord,
  writeTranscript,
} from '../../helpers/records.ts';

const CWD = '/Users/y/Work/app';

function list(home: ClaudeHome, options: Partial<RecentQuery> = {}) {
  return listRecentSessions(home.config, { limit: 50, ...options }, new FileCache<Session>());
}

/** Newest-first ordering comes from mtime, so tests that care about it set mtime. */
async function setMtime(path: string, ms: number): Promise<void> {
  await utimes(path, new Date(ms), new Date(ms));
}

describe('listRecentSessions', () => {
  it('reads the facts a row shows out of one transcript', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      userRecord('build me a dashboard', { timestamp: '2026-08-19T06:00:00.000Z', cwd: CWD }),
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5', usage: { input: 100, output: 20 } }),
      titleRecord('Build a dashboard'),
      lastPromptRecord({ lastPrompt: 'now add a token column' }),
      assistantRecord({
        id: 'msg_2',
        model: 'claude-sonnet-5',
        usage: { input: 300, output: 40 },
        timestamp: '2026-08-19T07:00:00.000Z',
        gitBranch: 'development',
        version: '2.1.235',
        cwd: CWD,
      }),
    ]);

    const { sessions, total } = await list(home);

    strictEqual(total, 1);
    const [session] = sessions;
    strictEqual(session?.id, sessionId(1));
    strictEqual(session?.status, 'ended', 'nothing without a live process is still running');
    strictEqual(session?.title, 'Build a dashboard');
    strictEqual(session?.firstPrompt, 'build me a dashboard');
    strictEqual(session?.lastPrompt, 'now add a token column');
    strictEqual(session?.model, 'claude-sonnet-5', 'the last turn, not the first');
    strictEqual(session?.version, '2.1.235');
    strictEqual(session?.project.gitBranch, 'development');
    strictEqual(session?.project.name, 'app');
    strictEqual(session?.startedAt, Date.parse('2026-08-19T06:00:00.000Z'));
    strictEqual(session?.lastActiveAt, Date.parse('2026-08-19T07:00:00.000Z'));
  });

  it('totals the tokens and names the window the model was working in', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5', usage: { input: 100, output: 20 } }),
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5', usage: { input: 100, output: 20 } }),
      assistantRecord({ id: 'msg_2', model: 'claude-opus-5', usage: { input: 300, output: 40 } }),
    ]);

    const [session] = (await list(home)).sessions;

    deepStrictEqual(session?.tokens, { input: 400, output: 60, cacheRead: 0, cacheCreate: 0 });
    strictEqual(session?.contextWindow, 1_000_000);
  });

  it('lists the most recently written transcript first', async (t) => {
    const home = await claudeHome(t);
    const older = await home.transcript(CWD, sessionId(1), [userRecord('first')]);
    const newer = await home.transcript(CWD, sessionId(2), [userRecord('second')]);
    await setMtime(older, 1_000_000);
    await setMtime(newer, 2_000_000);

    deepStrictEqual(
      (await list(home)).sessions.map((s) => s.id),
      [sessionId(2), sessionId(1)],
    );
  });

  it('opens only as many transcripts as the limit asks for, but counts them all', async (t) => {
    // The count comes from `stat`, so narrowing the page never costs a read.
    const home = await claudeHome(t);
    for (let i = 1; i <= 5; i += 1) {
      const path = await home.transcript(CWD, sessionId(i), [userRecord(`prompt ${i}`)]);
      await setMtime(path, 1_000_000 + i);
    }

    const { sessions, total } = await list(home, { limit: 2 });

    strictEqual(sessions.length, 2);
    strictEqual(total, 5);
    deepStrictEqual(
      sessions.map((s) => s.id),
      [sessionId(5), sessionId(4)],
    );
  });

  it('resolves a named session even when it sorts below the cut', async (t) => {
    // A live session that has been idle a while still deserves its title, whatever
    // stretch of history is on screen.
    const home = await claudeHome(t);
    const old = await home.transcript(CWD, sessionId(1), [titleRecord('The old one')]);
    await setMtime(old, 1_000);
    for (let i = 2; i <= 4; i += 1) {
      const path = await home.transcript(CWD, sessionId(i), [userRecord(`p${i}`)]);
      await setMtime(path, 1_000_000 + i);
    }

    const { sessions } = await list(home, { limit: 1, include: [sessionId(1)] });

    strictEqual(sessions.length, 2);
    strictEqual(sessions.find((s) => s.id === sessionId(1))?.title, 'The old one');
  });

  it('narrows to a window by mtime, and counts only what is inside it', async (t) => {
    const home = await claudeHome(t);
    const before = await home.transcript(CWD, sessionId(1), [userRecord('a')]);
    const inside = await home.transcript(CWD, sessionId(2), [userRecord('b')]);
    const after = await home.transcript(CWD, sessionId(3), [userRecord('c')]);
    await setMtime(before, 1_000);
    await setMtime(inside, 5_000);
    await setMtime(after, 9_000);

    const { sessions, total } = await list(home, { since: 5_000, until: 9_000 });

    strictEqual(total, 1, '`since` is inclusive and `until` exclusive');
    deepStrictEqual(
      sessions.map((s) => s.id),
      [sessionId(2)],
    );
  });

  it('never opens the middle of a transcript', async (t) => {
    // The whole listing budget rests on this: a 38 MB file costs the same as a
    // small one, because only its two ends are read.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      userRecord('opening prompt'),
      record({ type: 'padding', text: 'x'.repeat(200 * 1024) }),
      titleRecord('Buried in the middle'),
      record({ type: 'padding', text: 'y'.repeat(200 * 1024) }),
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5' }),
    ]);

    const [session] = (await list(home)).sessions;

    strictEqual(session?.firstPrompt, 'opening prompt', 'the head was read');
    strictEqual(session?.model, 'claude-opus-5', 'the tail was read');
    strictEqual(session?.title, undefined, 'and the middle was not');
  });

  it('falls back to the last real message when last-prompt carries only a uuid', async (t) => {
    // 71 of 790 transcripts are like this, and the uuid points at the leaf of the
    // conversation tree — often an attachment rather than the prompt.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      userRecord('the first thing'),
      userRecord('the last thing I asked'),
      toolResultRecord('a tool answered after it'),
      lastPromptRecord({ leafUuid: 'b8e0a0f2-0000-4000-8000-000000000000' }),
    ]);

    strictEqual((await list(home)).sessions[0]?.lastPrompt, 'the last thing I asked');
  });

  it('steps over the plumbing a session opens with', async (t) => {
    // A `/clear`, its caveat block, the context a slash command pasted in — none of
    // that is something the user asked for.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      commandRecord('/clear'),
      userRecord('Caveat: the messages below were generated by a slash command', {
        isMeta: true,
      }),
      userRecord('a sub-agent said this', { isSidechain: true }),
      toolResultRecord(),
      userRecord('what I actually asked'),
    ]);

    strictEqual((await list(home)).sessions[0]?.firstPrompt, 'what I actually asked');
  });

  it('uses a command when the command is all there is', async (t) => {
    // A 2 KB session that is nothing but `/clear` is honestly summarised as `/clear`.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [commandRecord('/commit', 'the parser fix')]);

    strictEqual((await list(home)).sessions[0]?.firstPrompt, '/commit the parser fix');
  });

  it('names the project from the recorded cwd, because slugs are lossy', async (t) => {
    // `-Users-y-Work-my-app` could be `my/app`, `my.app` or `my-app`; the record knows.
    const home = await claudeHome(t);
    await home.transcript('/Users/y/Work/my-app', sessionId(1), [
      userRecord('hello', { cwd: '/Users/y/Work/my-app' }),
    ]);

    const [session] = (await list(home)).sessions;

    strictEqual(session?.project.path, '/Users/y/Work/my-app');
    strictEqual(session?.project.name, 'my-app');
  });

  it('falls back to decoding the slug when no record carries a cwd', async (t) => {
    const home = await claudeHome(t);
    await home.transcript('/Users/y/Work/app', sessionId(1), [
      record({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5' } }),
    ]);

    strictEqual((await list(home)).sessions[0]?.project.path, '/Users/y/Work/app');
  });

  it('falls back to the file mtime when nothing inside carries a timestamp', async (t) => {
    const home = await claudeHome(t);
    const path = await home.transcript(CWD, sessionId(1), [userRecord('no timestamps here')]);
    await setMtime(path, 1_700_000_000_000);

    const [session] = (await list(home)).sessions;

    strictEqual(session?.lastActiveAt, 1_700_000_000_000);
    strictEqual(session?.startedAt, 1_700_000_000_000);
  });

  it('ignores anything in a project folder that is not a transcript', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [userRecord('real')]);
    await makeFile(home.config.projectsDir, 'x/notes.md', 'hello');
    await makeFile(home.config.projectsDir, 'x/12345.jsonl', '{"type":"user"}');

    strictEqual((await list(home)).total, 1);
  });

  it('ignores an empty transcript and one that holds nothing readable', async (t) => {
    const home = await claudeHome(t);
    await writeTranscript(home.config.projectsDir + '/x', `${sessionId(1)}.jsonl`, [], {
      trailingNewline: false,
    });
    await home.transcript(CWD, sessionId(2), ['not json at all', '{"broken":', 'undefined']);

    deepStrictEqual((await list(home)).sessions, []);
  });

  it('keeps the good records that were buried in broken ones', async (t) => {
    // The format is private and will change under us, so one unreadable line is a
    // line to step over — never a reason to lose the session it sits in.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [
      'not json at all',
      userRecord('the real prompt'),
      '{"half":',
      titleRecord('Still found it'),
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5' }),
      '\u0000 garbage',
    ]);

    const [session] = (await list(home)).sessions;

    strictEqual(session?.firstPrompt, 'the real prompt');
    strictEqual(session?.title, 'Still found it');
    strictEqual(session?.model, 'claude-opus-5');
  });

  it('reports no history rather than failing when there is no projects directory', async (t) => {
    const home = await claudeHome(t);
    const config = { ...home.config, projectsDir: '/nowhere/at/all' };

    deepStrictEqual(await listRecentSessions(config, { limit: 50 }, new FileCache<Session>()), {
      sessions: [],
      total: 0,
    });
  });

  it('reads an unchanged file once and hands back the same result', async (t) => {
    // What makes a 2 s poll over 800 transcripts cost nothing the second time.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [titleRecord('Cached')]);
    const cache = new FileCache<Session>();

    const first = await listRecentSessions(home.config, { limit: 50 }, cache);
    const second = await listRecentSessions(home.config, { limit: 50 }, cache);

    strictEqual(cache.size, 1);
    ok(first.sessions[0] === second.sessions[0], 'the very same object, not a re-read');
  });

  it('re-reads a transcript that has been appended to', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [titleRecord('Before')]);
    const cache = new FileCache<Session>();
    await listRecentSessions(home.config, { limit: 50 }, cache);

    await home.transcript(CWD, sessionId(1), [titleRecord('Before'), titleRecord('After')]);
    const second = await listRecentSessions(home.config, { limit: 50 }, cache);

    strictEqual(second.sessions[0]?.title, 'After');
  });
});

describe('findCandidate', () => {
  it('finds a transcript by session id', async (t) => {
    const home = await claudeHome(t);
    const path = await home.transcript(CWD, sessionId(1), [userRecord('hi')]);

    strictEqual((await findCandidate(home.config.projectsDir, sessionId(1)))?.path, path);
  });

  it('matches an id whatever case it is written in', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [userRecord('hi')]);

    ok(await findCandidate(home.config.projectsDir, sessionId(1).toUpperCase()));
  });

  it('takes the live copy when a resumed session left one in two projects', async (t) => {
    const home = await claudeHome(t);
    const stale = await home.transcript('/Users/y/old', sessionId(1), [userRecord('old')]);
    const current = await home.transcript('/Users/y/new', sessionId(1), [userRecord('new')]);
    await setMtime(stale, 1_000);
    await setMtime(current, 2_000);

    strictEqual((await findCandidate(home.config.projectsDir, sessionId(1)))?.path, current);
  });

  it('finds nothing for an id with no transcript', async (t) => {
    const home = await claudeHome(t);

    strictEqual(await findCandidate(home.config.projectsDir, sessionId(9)), undefined);
  });
});

describe('promptText', () => {
  it('reads what a user record said', () => {
    strictEqual(promptText(JSON.parse(userRecord('hello there'))), 'hello there');
    strictEqual(promptText(JSON.parse(userRecord('in blocks', { asBlocks: true }))), 'in blocks');
  });

  it('collapses whitespace and clips a very long prompt', () => {
    strictEqual(promptText(JSON.parse(userRecord('a\n\n  b'))), 'a b');

    const long = promptText(JSON.parse(userRecord('x'.repeat(400))));
    strictEqual(long?.length, 280);
    strictEqual(long?.endsWith('…'), true);
  });

  it('says nothing for a record that is not a prompt', () => {
    strictEqual(promptText(JSON.parse(toolResultRecord())), undefined);
    strictEqual(promptText(JSON.parse(userRecord('meta', { isMeta: true }))), undefined);
    strictEqual(promptText(JSON.parse(userRecord('   '))), undefined);
    strictEqual(promptText(JSON.parse(assistantRecord({}))), undefined);
  });
});
