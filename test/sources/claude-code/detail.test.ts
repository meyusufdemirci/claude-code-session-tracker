import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileCache } from '../../../src/core/cache.ts';
import type { Session, SessionDetail } from '../../../src/core/types.ts';
import { readDetail } from '../../../src/sources/claude-code/detail.ts';
import { claudeHome, sessionId, type ClaudeHome } from '../../helpers/claude-dir.ts';
import { makeFile } from '../../helpers/temp.ts';
import {
  agentListingAttachment,
  assistantRecord,
  deferredToolsAttachment,
  mcpInstructionsAttachment,
  memoryAttachment,
  record,
  skillListingAttachment,
  systemRecord,
  titleRecord,
  toolResultRecord,
  userRecord,
} from '../../helpers/records.ts';

const CWD = '/Users/y/Work/app';
const ID = sessionId(1);

function detailOf(home: ClaudeHome, id = ID): Promise<SessionDetail | null> {
  return readDetail(home.config, id, new FileCache<Session>(), new FileCache<SessionDetail>());
}

describe('readDetail', () => {
  it('counts what the user said, not what the transcript wrote back', async (t) => {
    // Tool results are `user` records and outnumber real messages ten to one, so
    // counting records rather than messages reports a number ten times too large.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      userRecord('first question'),
      assistantRecord({ id: 'msg_1', toolUses: 2 }),
      toolResultRecord(),
      toolResultRecord(),
      assistantRecord({ id: 'msg_1', text: 'here you go' }),
      userRecord('caveat block', { isMeta: true }),
      userRecord('a sub-agent spoke', { isSidechain: true }),
      userRecord('second question'),
      assistantRecord({ id: 'msg_2', toolUses: 1 }),
    ]);

    const detail = await detailOf(home);

    deepStrictEqual(detail?.counts, { user: 2, assistant: 2, tool: 3, subagents: 0 });
  });

  it('counts one assistant turn once, however many records wrote it', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      assistantRecord({ id: 'msg_1', usage: { input: 100, output: 20 } }),
      assistantRecord({ id: 'msg_1', usage: { input: 100, output: 20 } }),
      assistantRecord({ id: 'msg_1', usage: { input: 100, output: 20 } }),
      assistantRecord({ id: 'msg_2', usage: { input: 300, output: 40, cacheRead: 7 } }),
    ]);

    const detail = await detailOf(home);

    strictEqual(detail?.counts.assistant, 2);
    deepStrictEqual(detail?.tokens, { input: 400, output: 60, cacheRead: 7, cacheCreate: 0 });
  });

  it('lists the models in the order the session used them', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5' }),
      assistantRecord({ id: 'msg_2', model: 'claude-sonnet-5' }),
      assistantRecord({ id: 'msg_3', model: 'claude-opus-5' }),
    ]);

    deepStrictEqual((await detailOf(home))?.models, ['claude-opus-5', 'claude-sonnet-5']);
  });

  it('leaves out the stand-in Claude Code uses for its own messages', async (t) => {
    // `<synthetic>` is not a model anyone chose, and its usage is zero.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5' }),
      assistantRecord({ id: 'msg_2', model: '<synthetic>' }),
    ]);

    deepStrictEqual((await detailOf(home))?.models, ['claude-opus-5']);
  });

  it('surfaces the latest away summary', async (t) => {
    // It is rewritten as the session goes on, so the last one is the current recap.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      systemRecord({ subtype: 'away_summary', content: 'an early recap' }),
      systemRecord({ subtype: 'away_summary', content: 'what it ended up doing' }),
      systemRecord({ subtype: 'something_else', content: 'not a recap' }),
    ]);

    strictEqual((await detailOf(home))?.awaySummary, 'what it ended up doing');
  });

  it('reports time actually worked, not time elapsed', async (t) => {
    // One real session spans 2h 32m and worked 25m of it, so wall-clock would be
    // the wrong answer by an order of magnitude.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      systemRecord({ subtype: 'turn_duration', durationMs: 1_500 }),
      systemRecord({ subtype: 'turn_duration', durationMs: 2_500 }),
      systemRecord({ subtype: 'turn_duration', durationMs: 0 }),
      systemRecord({ subtype: 'turn_duration' }),
    ]);

    strictEqual((await detailOf(home))?.activeMs, 4_000);
  });

  it('says nothing rather than zero when no turn duration was recorded', async (t) => {
    // 7% of transcripts have none, and "0 seconds of work" would be a lie.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [userRecord('hello')]);

    strictEqual((await detailOf(home))?.activeMs, undefined);
  });

  it('counts sub-agent transcripts without opening them', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [userRecord('go')]);
    const subagents = `-Users-y-Work-app/${ID}/subagents`;
    await makeFile(home.config.projectsDir, `${subagents}/agent-one.jsonl`, '{}');
    await makeFile(home.config.projectsDir, `${subagents}/agent-two.jsonl`, '{}');
    await makeFile(home.config.projectsDir, `${subagents}/agent-two.meta.json`, '{}');

    strictEqual((await detailOf(home))?.counts.subagents, 2);
  });

  it('notes the records it could not read, rather than dropping them silently', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      'not json at all',
      '[]',
      'null',
      userRecord('a real one'),
    ]);

    const detail = await detailOf(home);

    strictEqual(detail?.notes.unreadable, 3, 'an array and a bare null are not records');
    strictEqual(detail?.counts.user, 1);
  });

  it('notes the records it refused to hold, and reads on past them', async (t) => {
    // A 9.4 MB tool result must not decide how much memory this process uses.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      record({ type: 'user', message: { role: 'user', content: 'x'.repeat(300 * 1024) } }),
      userRecord('a normal one'),
    ]);

    const detail = await detailOf(home);

    strictEqual(detail?.notes.oversized, 1);
    strictEqual(detail?.counts.user, 1);
  });

  it('bills each assistant turn to the prompt that asked for it', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      userRecord('the cheap question'),
      assistantRecord({ id: 'msg_1', usage: { input: 10, output: 5 } }),
      userRecord('the expensive question'),
      assistantRecord({ id: 'msg_2', usage: { input: 900, output: 100 } }),
      assistantRecord({ id: 'msg_2', usage: { input: 900, output: 100 } }),
    ]);

    const usage = (await detailOf(home))?.promptUsage;

    strictEqual(usage?.length, 2);
    strictEqual(usage?.[0]?.text, 'the expensive question', 'most expensive first');
    deepStrictEqual(usage?.[0]?.tokens, { input: 900, output: 100, cacheRead: 0, cacheCreate: 0 });
    deepStrictEqual(usage?.[1]?.tokens, { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 });
  });

  it('measures the context window from the first and last turns', async (t) => {
    // The first turn's cache write stands in for the static system/tools block; the
    // last turn's usage is what the window is actually holding right now.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5', usage: { cacheCreate: 5_000 } }),
      assistantRecord({
        id: 'msg_2',
        model: 'claude-opus-5',
        usage: { input: 100, cacheRead: 20_000, cacheCreate: 500 },
      }),
    ]);

    deepStrictEqual((await detailOf(home))?.context, {
      staticTokens: 5_000,
      conversationTokens: 15_600,
      // Nothing was recorded to name, so the whole block falls to the remainder.
      staticParts: [{ part: 'rest', label: 'System prompt + tool schemas', tokens: 5_000 }],
      windowTokens: 1_000_000,
      freeTokens: 979_400,
    });
  });

  it('says what the static block went on, largest first', async (t) => {
    // Nothing on disk prices these; each row is the recorded text divided by four,
    // and the rest of the measured block is whatever the transcript never wrote.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      userRecord('the opening prompt'),
      memoryAttachment('CLAUDE.md', 'm'.repeat(8_000)),
      memoryAttachment('backend/CLAUDE.md', 'b'.repeat(4_000)),
      skillListingAttachment('s'.repeat(2_000), ['commit', 'review']),
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5', usage: { cacheCreate: 10_000 } }),
    ]);

    const parts = (await detailOf(home))?.context?.staticParts;

    deepStrictEqual(parts, [
      { part: 'memory', label: 'CLAUDE.md', tokens: 2_000 },
      { part: 'memory', label: 'backend/CLAUDE.md', tokens: 1_000 },
      { part: 'skills', label: 'Skills (2)', tokens: 500 },
      { part: 'rest', label: 'System prompt + tool schemas', tokens: 6_500 },
    ]);
  });

  it('reads the listings the same way, whichever shape they arrive in', async (t) => {
    // Three attachment types, three different keys for the same thing: a string, an
    // array of lines, an array of blocks.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      deferredToolsAttachment(['aaa', 'bbb']),
      agentListingAttachment(['c'.repeat(399)], ['Explore']),
      mcpInstructionsAttachment(['d'.repeat(799)], ['github']),
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5', usage: { cacheCreate: 5_000 } }),
    ]);

    const parts = (await detailOf(home))?.context?.staticParts;

    deepStrictEqual(parts?.slice(0, 3), [
      { part: 'mcp', label: 'MCP instructions (1)', tokens: 200 },
      { part: 'agents', label: 'Agent listing (1)', tokens: 100 },
      // Two three-character names, each joined with a newline: eight characters.
      { part: 'tools', label: 'Deferred tools (2)', tokens: 2 },
    ]);
  });

  it('counts only the attachments that beat the first turn into the window', async (t) => {
    // Claude Code keeps emitting these as the session reaches new directories, but a
    // memory file pulled in on turn nine is conversation growth, not standing cost.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      memoryAttachment('CLAUDE.md', 'm'.repeat(4_000)),
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5', usage: { cacheCreate: 10_000 } }),
      memoryAttachment('later/CLAUDE.md', 'l'.repeat(40_000)),
      assistantRecord({ id: 'msg_2', model: 'claude-opus-5', usage: { cacheRead: 10_000, cacheCreate: 9_000 } }),
    ]);

    const parts = (await detailOf(home))?.context?.staticParts;

    // The 40K file that arrived on turn two is nowhere here — and the remainder is
    // last however large, being the row a reader can do nothing with.
    deepStrictEqual(parts, [
      { part: 'memory', label: 'CLAUDE.md', tokens: 1_000 },
      { part: 'rest', label: 'System prompt + tool schemas', tokens: 9_000 },
    ]);
  });

  it('scales the rows back rather than claim a block bigger than the one measured', async (t) => {
    // Four characters to the token understates prose, so an estimate can outrun the
    // measurement. Fitting it is honest; reporting 12K inside a 6K block is not.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      memoryAttachment('CLAUDE.md', 'm'.repeat(32_000)),
      memoryAttachment('backend/CLAUDE.md', 'b'.repeat(16_000)),
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5', usage: { cacheCreate: 6_000 } }),
    ]);

    const parts = (await detailOf(home))?.context?.staticParts;

    deepStrictEqual(parts, [
      { part: 'memory', label: 'CLAUDE.md', tokens: 4_000 },
      { part: 'memory', label: 'backend/CLAUDE.md', tokens: 2_000 },
    ]);
    strictEqual(parts?.some((entry) => entry.part === 'rest'), false, 'nothing left to attribute');
  });

  it('ignores the attachments that cost the window nothing', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      record({ type: 'attachment', attachment: { type: 'opened_file_in_ide', filename: 'a.ts' } }),
      record({ type: 'attachment', attachment: { type: 'some_type_added_next_release', content: 'x'.repeat(400) } }),
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5', usage: { cacheCreate: 5_000 } }),
    ]);

    deepStrictEqual((await detailOf(home))?.context?.staticParts, [
      { part: 'rest', label: 'System prompt + tool schemas', tokens: 5_000 },
    ]);
  });

  it('never reports a static block larger than the window is holding', async (t) => {
    // A `/clear` or a compaction partway through leaves the first turn's cache
    // write larger than what remains, which would otherwise go negative.
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      assistantRecord({ id: 'msg_1', model: 'claude-opus-5', usage: { cacheCreate: 90_000 } }),
      assistantRecord({ id: 'msg_2', model: 'claude-opus-5', usage: { input: 1_000 } }),
    ]);

    const context = (await detailOf(home))?.context;

    strictEqual(context?.staticTokens, 1_000);
    strictEqual(context?.conversationTokens, 0);
  });

  it('leaves the window out for a model it does not know', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      assistantRecord({ id: 'msg_1', model: 'claude-opus-9', usage: { input: 100 } }),
    ]);

    const context = (await detailOf(home))?.context;

    strictEqual(context?.windowTokens, undefined);
    strictEqual(context?.freeTokens, undefined);
    strictEqual(context?.conversationTokens, 100);
  });

  it('carries the listing facts through, so the panel needs one request', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [
      userRecord('the opening prompt', { cwd: CWD }),
      titleRecord('A named session'),
    ]);

    const detail = await detailOf(home);

    strictEqual(detail?.title, 'A named session');
    strictEqual(detail?.firstPrompt, 'the opening prompt');
    strictEqual(detail?.project.name, 'app');
    ok(detail?.transcriptPath?.endsWith(`${ID}.jsonl`));
  });

  it('answers null for a session with no transcript', async (t) => {
    const home = await claudeHome(t);

    strictEqual(await detailOf(home, sessionId(9)), null);
  });

  it('reads a finished transcript once, however often the panel is reopened', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [userRecord('hello')]);
    const sessions = new FileCache<Session>();
    const details = new FileCache<SessionDetail>();

    const first = await readDetail(home.config, ID, sessions, details);
    const second = await readDetail(home.config, ID, sessions, details);

    ok(first === second, 'the very same object, not a second full read');
  });

  it('re-reads a session that is still being written to', async (t) => {
    const home = await claudeHome(t);
    await home.transcript(CWD, ID, [userRecord('one')]);
    const sessions = new FileCache<Session>();
    const details = new FileCache<SessionDetail>();
    await readDetail(home.config, ID, sessions, details);

    await home.transcript(CWD, ID, [userRecord('one'), userRecord('two')]);

    strictEqual((await readDetail(home.config, ID, sessions, details))?.counts.user, 2);
  });
});
