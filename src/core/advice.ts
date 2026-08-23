import type {
  LongSessionsFinding,
  ModelMixFinding,
  SessionCost,
  SessionDetail,
  SessionTokenTotals,
  StandingContextFinding,
  UsageFinding,
  UsageFindingKind,
  UsageFindings,
  UsageProfile,
  UsageProfileSession,
} from './types.ts';

/**
 * What is worth saying about a stretch of spend.
 *
 * Every rule here answers the same question — which measurable pattern accounts for
 * enough of this range to be worth a reader's attention — and answers it in billed
 * tokens, so the rows can be ranked against one another and read on one scale.
 *
 * Nothing in here reads a file, and nothing decides what a row says in English: a
 * finding is a measurement with a name on it, and the page it is drawn on is where
 * the wording lives. That is what lets the thresholds below be argued with in a
 * test rather than in a browser.
 *
 * The thresholds themselves are the whole design. A rule that fires on an ordinary
 * range makes the panel wallpaper, and a panel nobody reads is worse than no panel,
 * so each one is drawn from the range's own middle rather than from a number chosen
 * here — the same argument `UsageLimit.reference` settles by measuring the machine
 * against itself instead of against a ceiling nobody published.
 */

/** How much of the range a finding has to account for before it earns a row. */
const MIN_SHARE = 0.08;

/**
 * And how much it has to come to in absolute terms.
 *
 * A quiet afternoon can hand a single session 90% of a very small range, which is
 * true and not worth reading. This is the floor that keeps a share from speaking
 * for a total too small to matter.
 */
const MIN_TOKENS = 20_000;

/** How many rows the panel will ever show. Three is what fits before it stops being read. */
const MAX_FINDINGS = 3;

/**
 * Which findings outrank which, before their sizes are compared at all.
 *
 * Ranking on tokens alone read well on paper and badly on a real machine: one model
 * carrying 89% of a range outranks twenty overgrown sessions carrying 22% every
 * time, and would hold the top row forever. The two are not the same kind of claim.
 * A long session and a heavy preamble name spend that a different habit would not
 * have produced; a concentrated model mix only describes the shape of the spend,
 * and is the same observation tomorrow whatever the reader does about it.
 *
 * So the tiers come first and the sizes decide within them — which is the ordering
 * a reader was going to apply themselves anyway.
 */
const KIND_ORDER: Record<UsageFindingKind, number> = {
  'long-sessions': 0,
  'standing-context': 0,
  'model-mix': 1,
};

/**
 * How many sessions the range needs before its middle means anything.
 *
 * Every threshold below is a multiple of a median, and a median of two numbers is
 * just the smaller of them wearing a statistical word.
 */
const MIN_SESSIONS = 4;

/** A closing window this many times the range's median is a long session. */
const LONG_MULTIPLE = 2.5;

/**
 * ...and it has to have got there, not started there.
 *
 * A large window on the first turn is a large repository, a wide `CLAUDE.md`, a long
 * skill listing — none of which the reader can do anything about mid-session. A
 * large window that opened small is the thing this rule is actually about.
 */
const GROWTH_MULTIPLE = 4;

/** One model holding this much of a range is a mix worth reporting. */
const DOMINANT_SHARE = 0.8;

/**
 * How much of the window a session typically ends on has to have been there before
 * anyone typed.
 *
 * The rule this guards is not "opening a session costs something" — it always does,
 * and a row saying so would appear on every range ever measured. It is "these
 * sessions barely got past their own preamble", which is a deviation, actionable,
 * and quiet on any range where the sessions did some work.
 */
const STANDING_SHARE = 0.5;

/**
 * Every finding the range supports, heaviest first.
 *
 * An empty list is the ordinary answer and the important one: the panel is hidden
 * on it, so a range with nothing unusual in it costs the reader no attention at all.
 */
export function findUsage(profile: UsageProfile): UsageFindings {
  const tokens = profile.sessions.reduce((sum, session) => sum + billedTokens(session.tokens), 0);

  const findings = [
    longSessions(profile.sessions, tokens),
    standingContext(profile.sessions, tokens),
    modelMix(profile, tokens),
  ]
    .filter((finding): finding is UsageFinding => finding !== undefined)
    .filter((finding) => finding.tokens >= MIN_TOKENS && finding.share >= MIN_SHARE)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.tokens - a.tokens)
    .slice(0, MAX_FINDINGS);

  return { findings, range: profile.range, tokens, generatedAt: profile.generatedAt };
}

/**
 * What one session cost, from the numbers the drawer already has.
 *
 * The panel above is about a range and needs a sweep behind it; this needs nothing
 * but the session it is describing, which is why it is arithmetic rather than a
 * rule: there is no threshold to cross and nothing to compare against. Every
 * session has an answer here, and the honest one is often "not much".
 *
 * Nothing is returned for a transcript with no billed turns. A per-turn figure over
 * no turns is not zero, it is a division no one asked for.
 *
 * Every field is read as though it might be missing, because this runs over whatever
 * a source handed back: a detail short of a count is a source that reports less than
 * Claude Code's does, and the section going quiet is the right answer to that. It is
 * never a reason to fail the request that carried it.
 */
export function measureSession(detail: SessionDetail): SessionCost | undefined {
  // The billed ones, not every assistant turn: a turn that carried no usage read
  // nothing back, and dividing by it would understate what the rest each held.
  const turns = detail.counts?.billed ?? 0;
  const reread = detail.tokens?.cacheRead ?? 0;
  if (turns <= 0 || reread <= 0) return undefined;

  return {
    turns,
    reread,
    perTurn: Math.round(reread / turns),
    ...(detail.context ? { staticTokens: detail.context.staticTokens } : {}),
    subagents: detail.counts?.subagents ?? 0,
  };
}

/**
 * Sessions whose window grew several times past what the range considers normal.
 *
 * What this costs is not really in the tokens it reports. A window that reached
 * half a million was re-read at that size on every turn after it got there, and
 * those re-reads are cache hits, which the ceiling barely counts — so the honest
 * ranking is the billed spend, and the size of the window belongs in the evidence
 * beside it, where it explains the number rather than inflating it.
 */
function longSessions(
  sessions: readonly UsageProfileSession[],
  total: number,
): LongSessionsFinding | undefined {
  if (sessions.length < MIN_SESSIONS || total === 0) return undefined;

  const median = medianOf(sessions.map((session) => session.closingContext));
  if (median === 0) return undefined;

  const long = sessions.filter(
    (session) =>
      session.closingContext >= median * LONG_MULTIPLE &&
      session.closingContext >= contextOf(session.opening) * GROWTH_MULTIPLE,
  );
  if (long.length === 0) return undefined;

  const tokens = long.reduce((sum, session) => sum + billedTokens(session.tokens), 0);

  return {
    kind: 'long-sessions',
    tokens,
    share: tokens / total,
    sessions: [...long].sort((a, b) => billedTokens(b.tokens) - billedTokens(a.tokens)),
    medianClosingContext: median,
  };
}

/**
 * Sessions that barely got past their own preamble.
 *
 * The measurement that makes this a finding rather than a truism is the pair of
 * medians: what a session here opens holding, against what it ends holding. Every
 * range spends something on opening sessions, so reporting that alone would put a
 * row on the panel forever. Reporting that half of a typical window was already
 * there before anyone typed says something a reader can act on — and goes quiet by
 * itself on any range whose sessions did some work.
 *
 * What it costs is summed from each session's own opening turn rather than from a
 * median times a count: the two agree on a tidy range and part company on a real
 * one, and only the sum is a measurement. The median is carried alongside because
 * it is what the row says out loud — a reader wants to know what one session costs
 * to open, not what twelve of them came to.
 */
function standingContext(
  sessions: readonly UsageProfileSession[],
  total: number,
): StandingContextFinding | undefined {
  if (sessions.length < MIN_SESSIONS || total === 0) return undefined;

  const opening = medianOf(sessions.map((session) => contextOf(session.opening)));
  const closing = medianOf(sessions.map((session) => session.closingContext));
  if (opening === 0 || closing === 0) return undefined;
  if (opening / closing < STANDING_SHARE) return undefined;

  const tokens = sessions.reduce((sum, session) => sum + billedTokens(session.opening), 0);
  if (tokens === 0) return undefined;

  return {
    kind: 'standing-context',
    tokens,
    share: tokens / total,
    medianOpeningContext: opening,
    sessions: sessions.length,
  };
}

/**
 * One model carrying the range more or less alone.
 *
 * Needs at least two models to be a mix at all: a machine that has only ever run one
 * is not concentrated, it is unremarkable, and saying otherwise would put a row on
 * the panel that no choice the reader makes could ever clear.
 */
function modelMix(profile: UsageProfile, total: number): ModelMixFinding | undefined {
  const [top] = profile.models;
  if (!top || profile.models.length < 2 || total === 0) return undefined;

  const tokens = billedTokens(top.tokens);
  const share = tokens / total;
  if (share < DOMINANT_SHARE) return undefined;

  return { kind: 'model-mix', tokens, share, models: [...profile.models] };
}

/**
 * Input, output and newly-cached tokens — what a window is measured in.
 *
 * Mirrors `billedTokens` in `buckets.ts`, as the page mirrors it again for the token
 * column. Three definitions of one sum is two more than anyone wants, but the
 * alternative is core reaching into a source for arithmetic, and the seam is worth
 * more than the duplication. Cache reads are left out of all three: they are billed
 * at a fraction of the rest, and folding them in would let a long conversation read
 * as a hundred times the spend it is.
 */
function billedTokens(tokens: SessionTokenTotals): number {
  return tokens.input + tokens.output + tokens.cacheCreate;
}

/** The window as one turn saw it: everything it was handed, cached or not. */
function contextOf(tokens: SessionTokenTotals): number {
  return tokens.input + tokens.cacheRead + tokens.cacheCreate;
}

/**
 * The middle value, taking the lower of the two on an even count.
 *
 * A mean would be pulled by the very sessions every rule here is trying to find,
 * which would raise the bar in exact proportion to how badly it needs holding still.
 */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}
