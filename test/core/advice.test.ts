import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findUsage, measureSession } from '../../src/core/advice.ts';
import type {
  SessionDetail,
  SessionTokenTotals,
  UsageFinding,
  UsageFindingKind,
  UsageProfileModel,
  UsageProfile,
  UsageProfileSession,
} from '../../src/core/types.ts';

const RANGE = { since: 1_000, until: 2_000 };

const totals = (parts: Partial<SessionTokenTotals> = {}): SessionTokenTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  ...parts,
});

/**
 * An ordinary session: it opens on a small static block, grows a little, and bills
 * a round number. Every test below is a deviation from this one, so what a case is
 * about is whatever it overrides.
 */
function session(id: string, parts: Partial<UsageProfileSession> = {}): UsageProfileSession {
  return {
    id,
    slug: '-Users-y-Work-app',
    project: 'app',
    turns: 20,
    opening: totals({ cacheCreate: 20_000 }),
    closingContext: 60_000,
    tokens: totals({ input: 1_000, output: 9_000, cacheCreate: 20_000 }),
    ...parts,
  };
}

/** Enough ordinary sessions for a median to mean something. */
const ordinary = (count = 6): UsageProfileSession[] =>
  Array.from({ length: count }, (_, index) => session(`ordinary-${index}`));

const model = (name: string, parts: Partial<SessionTokenTotals>): UsageProfileModel => ({
  model: name,
  tokens: totals(parts),
  turns: 10,
});

function profileOf(parts: Partial<UsageProfile> = {}): UsageProfile {
  return {
    range: RANGE,
    sessions: ordinary(),
    models: [model('claude-opus-5', { output: 50_000 })],
    generatedAt: 2_000,
    ...parts,
  };
}

const kinds = (findings: readonly UsageFinding[]): UsageFindingKind[] =>
  findings.map((finding) => finding.kind);

const find = <K extends UsageFindingKind>(
  findings: readonly UsageFinding[],
  kind: K,
): Extract<UsageFinding, { kind: K }> | undefined =>
  findings.find((finding): finding is Extract<UsageFinding, { kind: K }> => finding.kind === kind);

describe('findUsage', () => {
  it('says nothing about a range where every session looks like the others', () => {
    // The ordinary answer, and the one that matters most: the panel is hidden on an
    // empty list, so a quiet range costs the reader no attention at all.
    const { findings } = findUsage(profileOf());

    deepStrictEqual(findings, []);
  });

  it('says nothing at all about an empty range', () => {
    const result = findUsage(profileOf({ sessions: [], models: [] }));

    deepStrictEqual(result.findings, []);
    strictEqual(result.tokens, 0);
  });

  it('carries the range and the total it measured every share against', () => {
    const result = findUsage(profileOf());

    deepStrictEqual(result.range, RANGE);
    strictEqual(result.tokens, 6 * 30_000, 'six ordinary sessions at 30k billed each');
    strictEqual(result.generatedAt, 2_000);
  });
});

describe('findUsage — long sessions', () => {
  it('finds the session that grew several times past the range median', () => {
    const grew = session('grew', {
      turns: 240,
      closingContext: 420_000,
      tokens: totals({ input: 5_000, output: 60_000, cacheCreate: 200_000, cacheRead: 9_000_000 }),
    });

    const { findings } = findUsage(profileOf({ sessions: [...ordinary(), grew] }));
    const finding = find(findings, 'long-sessions');

    ok(finding, 'a long session is a finding');
    deepStrictEqual(
      finding.sessions.map((s) => s.id),
      ['grew'],
    );
    strictEqual(finding.medianClosingContext, 60_000);
  });

  it('ranks itself on billed tokens, not on the cache reads it actually spent', () => {
    // A long session's real weight is in re-reading its window, which the ceiling
    // barely counts. Ranking on that would put this row above every other by a
    // factor of ten and say nothing true about the limit.
    const grew = session('grew', {
      closingContext: 420_000,
      tokens: totals({ input: 5_000, output: 60_000, cacheCreate: 200_000, cacheRead: 9_000_000 }),
    });

    const { findings } = findUsage(profileOf({ sessions: [...ordinary(), grew] }));
    const finding = find(findings, 'long-sessions');

    strictEqual(finding?.tokens, 265_000, 'input, output and cache writes — no reads');
  });

  it('leaves a big session alone when it opened big', () => {
    // A large window on the first turn is a large repository and a wide `CLAUDE.md`.
    // Nothing the reader does mid-session touches it, so it is not this row's business.
    const wide = session('wide', {
      opening: totals({ cacheCreate: 180_000 }),
      closingContext: 400_000,
      tokens: totals({ output: 40_000, cacheCreate: 200_000 }),
    });

    const { findings } = findUsage(profileOf({ sessions: [...ordinary(), wide] }));

    strictEqual(find(findings, 'long-sessions'), undefined);
  });

  it('holds still until the range has enough sessions to have a middle', () => {
    const grew = session('grew', {
      closingContext: 420_000,
      tokens: totals({ output: 60_000, cacheCreate: 200_000 }),
    });

    const { findings } = findUsage(profileOf({ sessions: [session('a'), grew] }));

    strictEqual(find(findings, 'long-sessions'), undefined, 'two sessions have no median worth the name');
  });

  it('puts the heaviest of several long sessions first', () => {
    const heavy = session('heavy', {
      closingContext: 500_000,
      tokens: totals({ output: 90_000, cacheCreate: 300_000 }),
    });
    const lighter = session('lighter', {
      closingContext: 300_000,
      tokens: totals({ output: 20_000, cacheCreate: 80_000 }),
    });

    const { findings } = findUsage(profileOf({ sessions: [...ordinary(), lighter, heavy] }));

    deepStrictEqual(find(findings, 'long-sessions')?.sessions.map((s) => s.id), ['heavy', 'lighter']);
  });
});

describe('findUsage — standing context', () => {
  /** A session that opens on its static block and ends barely past it. */
  const short = (id: string, parts: Partial<UsageProfileSession> = {}): UsageProfileSession =>
    session(id, { closingContext: 30_000, ...parts });

  const barelyUsed = (count = 4): UsageProfileSession[] =>
    Array.from({ length: count }, (_, index) => short(`short-${index}`));

  it('sums what each session paid to open rather than multiplying a median', () => {
    // The two agree on a tidy range and part company on a real one. Only the sum is
    // a measurement, so only the sum is what the row is ranked on.
    const sessions = [
      ...barelyUsed(),
      short('wide-one', {
        opening: totals({ cacheCreate: 120_000 }),
        closingContext: 200_000,
        tokens: totals({ output: 20_000, cacheCreate: 120_000 }),
      }),
    ];

    const finding = find(findUsage(profileOf({ sessions })).findings, 'standing-context');

    ok(finding);
    strictEqual(finding.tokens, 4 * 20_000 + 120_000);
    strictEqual(finding.medianOpeningContext, 20_000, 'the median is what the row says out loud');
    strictEqual(finding.sessions, 5);
  });

  it('counts a resumed session by what it was billed, not by what it was handed', () => {
    // A resumed session reads its static block back from cache at a fraction of the
    // price. Counting the window it opened with would charge it the full rate for a
    // block it never wrote.
    const resumed = short('resumed', { opening: totals({ cacheRead: 300_000, cacheCreate: 2_000 }) });

    const finding = find(
      findUsage(profileOf({ sessions: [...barelyUsed(), resumed] })).findings,
      'standing-context',
    );

    strictEqual(finding?.tokens, 4 * 20_000 + 2_000);
  });

  it('stays quiet on a range whose sessions did some work', () => {
    // Every range spends something on opening sessions. Saying so on its own would
    // put a row on the panel forever, which is why the rule compares the window a
    // session opens on with the one it ends on rather than reporting the first alone.
    const { findings } = findUsage(profileOf({ sessions: ordinary() }));

    strictEqual(find(findings, 'standing-context'), undefined, 'opened at 20k, ended at 60k');
  });

  it('stays quiet when opening a session costs almost nothing', () => {
    const cheap = Array.from({ length: 6 }, (_, index) =>
      short(`cheap-${index}`, {
        opening: totals({ cacheCreate: 400 }),
        closingContext: 700,
        tokens: totals({ output: 300, cacheCreate: 400 }),
      }),
    );

    const { findings } = findUsage(profileOf({ sessions: cheap }));

    strictEqual(find(findings, 'standing-context'), undefined, 'below the floor, so not worth a row');
  });
});

describe('findUsage — model mix', () => {
  it('reports one model carrying the range', () => {
    const finding = find(
      findUsage(
        profileOf({
          models: [model('claude-opus-5', { output: 180_000 }), model('claude-sonnet-5', { output: 4_000 })],
        }),
      ).findings,
      'model-mix',
    );

    ok(finding);
    strictEqual(finding.models[0]?.model, 'claude-opus-5');
    ok(finding.share >= 0.8, 'dominant, or it would not be a finding');
  });

  it('says nothing about a machine that has only ever run one model', () => {
    // Not concentrated — unremarkable. A row here is one no choice could ever clear.
    const { findings } = findUsage(
      profileOf({ models: [model('claude-opus-5', { output: 180_000 })] }),
    );

    strictEqual(find(findings, 'model-mix'), undefined);
  });

  it('says nothing about a range two models actually share', () => {
    const { findings } = findUsage(
      profileOf({
        models: [model('claude-opus-5', { output: 100_000 }), model('claude-sonnet-5', { output: 80_000 })],
      }),
    );

    strictEqual(find(findings, 'model-mix'), undefined);
  });
});

describe('findUsage — what reaches the panel', () => {
  it('drops a finding that accounts for too little of the range to matter', () => {
    // True, and not worth reading: a share of a total this small says nothing about
    // where the week went.
    const tiny = Array.from({ length: 6 }, (_, index) =>
      session(`tiny-${index}`, {
        opening: totals({ cacheCreate: 300 }),
        tokens: totals({ output: 500, cacheCreate: 300 }),
      }),
    );

    const { findings } = findUsage(profileOf({ sessions: tiny }));

    deepStrictEqual(findings, []);
  });

  it('ranks what survives by what it accounts for, heaviest first', () => {
    const grew = session('grew', {
      closingContext: 900_000,
      tokens: totals({ output: 400_000, cacheCreate: 900_000 }),
    });

    const { findings } = findUsage(
      profileOf({
        sessions: [...ordinary(), grew],
        models: [
          model('claude-opus-5', { output: 1_400_000 }),
          model('claude-sonnet-5', { output: 1_000 }),
        ],
      }),
    );
    // Measured on a real machine: one model carrying 89% of a range outranks twenty
    // overgrown sessions carrying 22% on size alone, and would hold the top row
    // forever. Spend a different habit would not have produced comes first.
    deepStrictEqual(kinds(findings), ['long-sessions', 'model-mix']);
  });

  it('ranks findings of one tier against each other by size', () => {
    const grew = session('grew', {
      closingContext: 900_000,
      tokens: totals({ output: 400_000, cacheCreate: 900_000 }),
    });
    const sessions = [
      ...Array.from({ length: 5 }, (_, index) =>
        session(`short-${index}`, { closingContext: 30_000 }),
      ),
      grew,
    ];

    const { findings } = findUsage(profileOf({ sessions }));
    const ranked = findings.map((finding) => finding.tokens);

    deepStrictEqual(kinds(findings), ['long-sessions', 'standing-context']);
    deepStrictEqual([...ranked].sort((a, b) => b - a), ranked);
  });

  it('never shows more than three rows', () => {
    const grew = session('grew', {
      closingContext: 900_000,
      tokens: totals({ output: 400_000, cacheCreate: 900_000 }),
    });

    const { findings } = findUsage(
      profileOf({
        sessions: [...ordinary(), grew],
        models: [model('claude-opus-5', { output: 1_400_000 }), model('claude-sonnet-5', { output: 1_000 })],
      }),
    );

    ok(findings.length <= 3);
    ok(new Set(kinds(findings)).size === findings.length, 'and never the same row twice');
  });
});

describe('measureSession', () => {
  /** Only the fields `measureSession` reads; the rest of a detail is not its business. */
  const detail = (parts: {
    billed?: number;
    subagents?: number;
    cacheRead?: number;
    staticTokens?: number;
    noContext?: boolean;
  } = {}): SessionDetail => {
    const {
      billed = 100,
      subagents = 0,
      cacheRead = 5_000_000,
      staticTokens = 26_000,
      noContext = false,
    } = parts;
    return {
      // Two more assistant turns than billed ones, as a real transcript has: the
      // notices Claude Code writes itself are turns that nobody paid for.
      counts: { user: 40, assistant: billed + 2, billed, tool: 200, subagents },
      tokens: totals({ input: 300, output: 90_000, cacheRead, cacheCreate: 120_000 }),
      ...(noContext ? {} : { context: { staticTokens, conversationTokens: 400_000, staticParts: [] } }),
    } as unknown as SessionDetail;
  };

  it('undoes the multiplication a turn count hides', () => {
    // The reads are the window handed back once per turn, so the window an average
    // turn worked inside is the one number the drawer cannot show on its own.
    const cost = measureSession(detail({ billed: 100, cacheRead: 5_000_000 }));

    ok(cost);
    strictEqual(cost.turns, 100, 'the billed turns, not the two that billed nothing');
    strictEqual(cost.reread, 5_000_000);
    strictEqual(cost.perTurn, 50_000);
  });

  it('carries the static block, which every turn reads back too', () => {
    strictEqual(measureSession(detail({ staticTokens: 26_000 }))?.staticTokens, 26_000);
  });

  it('leaves the static block off a session that recorded no context', () => {
    const cost = measureSession(detail({ noContext: true }));

    ok(cost);
    strictEqual('staticTokens' in cost, false, 'never guessed at');
  });

  it('counts the subagents that bill here without appearing here', () => {
    strictEqual(measureSession(detail({ subagents: 4 }))?.subagents, 4);
  });

  it('says nothing about a transcript that never billed a turn', () => {
    // A per-turn figure over no turns is not zero, it is a division nobody asked for.
    strictEqual(measureSession(detail({ billed: 0 })), undefined);
  });

  it('says nothing about a session whose window was never read back', () => {
    strictEqual(measureSession(detail({ cacheRead: 0 })), undefined);
  });

  it('goes quiet on a detail that carries no counts at all', () => {
    // A source reporting less than Claude Code's does is a quiet section, never a
    // failed request — this runs inside the one that serves the panel.
    strictEqual(measureSession({} as SessionDetail), undefined);
  });
});
