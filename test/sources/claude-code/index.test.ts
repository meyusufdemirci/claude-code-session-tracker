import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConfig } from '../../../src/config.ts';
import { ClaudeCodeSource } from '../../../src/sources/claude-code/index.ts';
import { claudeHome, sessionId } from '../../helpers/claude-dir.ts';
import { titleRecord, userRecord } from '../../helpers/records.ts';

const CWD = '/Users/y/Work/app';

describe('ClaudeCodeSource', () => {
  it('is available when the Claude directory exists', async (t) => {
    const home = await claudeHome(t);

    strictEqual(await new ClaudeCodeSource(home.config).isAvailable(), true);
  });

  it('is unavailable on a machine that has never run Claude Code', async () => {
    // Which is a state to report on the page, not an error to exit on.
    const source = new ClaudeCodeSource(createConfig({ claudeDir: '/nowhere/at/all' }));

    strictEqual(await source.isAvailable(), false);
  });

  it('names itself the same way the page and the API do', () => {
    const source = new ClaudeCodeSource(createConfig({ claudeDir: '/nowhere' }));

    strictEqual(source.id, 'claude-code');
    strictEqual(source.label, 'Claude Code');
  });

  it('answers the three questions the registry asks', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [userRecord('hello'), titleRecord('A session')]);
    const source = new ClaudeCodeSource(home.config);

    deepStrictEqual(await source.listLive(), []);

    const recent = await source.listRecent({ limit: 10 });
    strictEqual(recent.total, 1);
    strictEqual(recent.sessions[0]?.title, 'A session');

    const detail = await source.detail(sessionId(1));
    strictEqual(detail?.counts.user, 1);
    strictEqual(await source.detail(sessionId(9)), null);
  });

  it('keeps its caches across requests, not inside one', async (t) => {
    // What makes a 2 s poll over 800 transcripts cost nothing the second time.
    const home = await claudeHome(t);
    await home.transcript(CWD, sessionId(1), [userRecord('hello')]);
    const source = new ClaudeCodeSource(home.config);

    const first = await source.listRecent({ limit: 10 });
    const second = await source.listRecent({ limit: 10 });

    ok(first.sessions[0] === second.sessions[0], 'the very same object, not a re-read');
  });
});
