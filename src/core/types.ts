/** Live status of a session, as reported by Claude Code itself. */
export type SessionStatus = 'busy' | 'waiting' | 'idle' | 'ended';

export interface SessionProject {
  /** Directory basename, e.g. `Timfog-FS`. */
  name: string;
  /** Absolute working directory. */
  path: string;
  /** On-disk folder name under `~/.claude/projects`. */
  slug: string;
  gitBranch?: string;
}

/** Present only while the session's process is alive. */
export interface SessionLiveInfo {
  pid: number;
  /** Process start time, used to detect pid reuse. */
  procStart?: string;
  kind?: string;
  entrypoint?: string;
  socketPath?: string;
}

export interface Session {
  /** Claude Code session uuid. */
  id: string;
  /** Id of the source that produced this record, e.g. `claude-code`. */
  source: string;
  status: SessionStatus;
  /** Free text from Claude Code, e.g. `input needed`. */
  waitingFor?: string;
  project: SessionProject;
  /** Claude-generated session title, when one exists. */
  title?: string;
  /** Short derived handle, e.g. `timfog-fs-f0`. */
  name?: string;
  lastPrompt?: string;
  /** The opening ask, recovered from the head of the transcript. */
  firstPrompt?: string;
  live?: SessionLiveInfo;
  startedAt: number;
  lastActiveAt: number;
  /** Claude Code version that wrote the session. */
  version?: string;
  /** Model on the most recent assistant turn, e.g. `claude-opus-5`. */
  model?: string;
  /** That model's context window, when the model is recognized. Absent means unknown, never guessed. */
  contextWindow?: number;
  transcriptPath?: string;
  sizeBytes?: number;
  tokens?: SessionTokenTotals;
}

export interface SessionTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface SessionCounts {
  /** Messages the user actually sent. Tool results are not messages. */
  user: number;
  /** Assistant turns, not records — one turn is written as several records. */
  assistant: number;
  /** `tool_use` blocks across every turn. */
  tool: number;
  /** Transcripts under `<sessionId>/subagents/`. */
  subagents: number;
}

/** What a full read had to pass over. Both being zero is the normal case. */
export interface SessionDetailNotes {
  /** Lines that were not valid JSON. Non-zero means the format drifted under us. */
  unreadable: number;
  /**
   * Records too large to hold. Always a tool result, an attachment, or a meta
   * record on the machine this was measured against — never a turn we count.
   */
  oversized: number;
}

/** Token usage attributed to the prompt that triggered it. */
export interface SessionPromptUsage {
  /** The prompt text that opened this turn, clipped like `firstPrompt`. */
  text: string;
  tokens: SessionTokenTotals;
}

/** Where one row of the static block came from. */
export type SessionContextPart =
  /** A `CLAUDE.md` or `AGENTS.md` inlined before the first turn. */
  | 'memory'
  /** The skill listing. */
  | 'skills'
  /** The deferred-tool listing — names only, not the schemas behind them. */
  | 'tools'
  /** The sub-agent listing. */
  | 'agents'
  /** Instructions the MCP servers supplied. */
  | 'mcp'
  /** Everything the transcript never wrote down. Derived, not read. */
  | 'rest';

/**
 * One row of what the static block is made of.
 *
 * Nothing on disk states a per-item token cost, so every `tokens` here bar `rest`'s
 * is estimated from the recorded text. `rest` is the other way round: it is the
 * measured static total minus everything we could name, which is why it is the row
 * that carries the base system prompt and the built-in tool schemas.
 */
export interface SessionContextPartUsage {
  part: SessionContextPart;
  /** A memory file's path, or the name of the listing and how much it lists. */
  label: string;
  tokens: number;
}

/**
 * A snapshot of how full the context window is right now, unlike `tokens` on
 * `SessionDetail`, which sums every turn ever billed.
 *
 * The usage numbers carry no per-category breakdown (no line tells us "this many
 * tokens were the system prompt"), so the top-level split is only what they support:
 * the first turn's cache write as a proxy for the static system prompt, tools,
 * skills, and agent definitions, versus what the window has grown by since. What
 * does get written down is the *text* of the memory files and listings that went in,
 * and `staticParts` prices that text to say which of them the static half went on.
 */
export interface SessionContextDetail {
  /** The first turn's cache-write — static system/tools/skills/agents, plus the opening prompt. */
  staticTokens: number;
  /** Grown since that first turn: later prompts, replies, and tool results still in view. */
  conversationTokens: number;
  /** What `staticTokens` went on, largest first, with the unnamed remainder last. */
  staticParts: SessionContextPartUsage[];
  /** The active model's context window, when the model is recognized. */
  windowTokens?: number;
  /** `windowTokens` minus the current total, when `windowTokens` is known. */
  freeTokens?: number;
}

export interface SessionDetail extends Session {
  counts: SessionCounts;
  tokens: SessionTokenTotals;
  /** Every model that answered in this session, in the order first seen. */
  models: string[];
  /** Claude's own recap of what the session achieved, when it wrote one. */
  awaySummary?: string;
  /** Summed turn durations: time spent working, which is far less than wall-clock. */
  activeMs?: number;
  /** One entry per user prompt, sorted by token usage, highest first. */
  promptUsage: SessionPromptUsage[];
  notes: SessionDetailNotes;
  /** Absent only when the transcript has no assistant turns to measure. */
  context?: SessionContextDetail;
}

/**
 * One window of one limit — five hours for the session limit, seven days for the weekly.
 *
 * The quota itself is enforced server-side and never written to disk. The only
 * trace it leaves in a transcript is a rejection record on the turn that got cut
 * off, so everything here is measured rather than read: the window's bounds from
 * the turn timestamps, its size from the `usage` totals those turns carry.
 */
export interface UsageWindow {
  /** Where the window opens. Five-hour windows are floored to the half hour — where Claude puts them. */
  startedAt: number;
  /** The moment the window empties. From Claude itself when it told us, else `startedAt` plus its length. */
  resetsAt: number;
  /** True when that reset time is Claude's own, taken off a rejection record rather than derived. */
  resetsAtIsReported: boolean;
  tokens: SessionTokenTotals;
  /** Assistant turns billed inside the window — turns, not records. */
  turns: number;
  /** Claude Code recorded a rate-limit rejection on this limit's clock inside this window. */
  limited: boolean;
}

/**
 * How a limit's windows were placed on the clock.
 *
 * `chained` — laid end to end from the turn timestamps, which is all the five-hour
 * window ever needs: a gap of five quiet hours closes one and the next turn opens
 * the next.
 * `reported` — pinned to a reset Claude itself wrote down on a turn it refused.
 * `rolling` — counted back from the moment of measurement, because nothing on disk
 * says where this clock's week actually starts.
 */
export type UsageClock = 'chained' | 'reported' | 'rolling';

/** One rate limit: the window in progress, and what there is to read it against. */
export interface UsageLimit {
  /** How long one window of this limit runs. */
  windowMs: number;
  /** Where the windows' edges came from — see `UsageClock`. */
  clock: UsageClock;
  /** The window the clock is inside. Absent when nothing has been billed in one. */
  current?: UsageWindow;
  /**
   * The heaviest window that has already closed.
   *
   * The real ceiling is never written anywhere we can read, so the honest
   * denominator is the most this machine has already pushed through one window.
   * When that window is `limited`, it is not just a high-water mark — it is a
   * point where Claude actually said no.
   */
  reference?: UsageWindow;
  /**
   * The most recent window Claude actually cut short, when there is one in history.
   *
   * Worth reporting on its own rather than folding into `reference`, which is the
   * heaviest window and may well be a heavier one that was never refused — the
   * ceiling is weighted by model, not counted in tokens. This is the only number
   * on either side of the seam that Claude itself put a stop to.
   */
  lastLimited?: UsageWindow;
  /** How many days back `reference` looked. */
  historyDays: number;
}

/**
 * Both limits Claude Code bills against, measured from the same sweep.
 *
 * They are two clocks over one set of turns, not two readings — which is why they
 * are returned together: the transcripts are read once and counted twice.
 */
export interface UsageLimits {
  /** The five-hour window Claude Code calls a session limit. */
  session: UsageLimit;
  /** The seven-day window it calls a weekly limit. */
  weekly: UsageLimit;
  generatedAt: number;
}

/**
 * One session, as a finding refers to it.
 *
 * Small on purpose: a finding names a session so the reader can open it, and the
 * drawer is where everything else about it already lives. Nothing here needs a
 * transcript opened — every field is a by-product of the sweep the limit cards and
 * the history page already pay for.
 */
export interface UsageProfileSession {
  id: string;
  /** The folder under `~/.claude/projects` that billed it. */
  slug: string;
  /** Directory basename, e.g. `Timfog-FS`. */
  project: string;
  /** Assistant turns billed — turns, not records. */
  turns: number;
  /**
   * The first turn's usage — what opening the session came to.
   *
   * Kept whole rather than summed, because the two halves mean different things: a
   * fresh session writes its static block to cache and is billed for it, while a
   * resumed one reads the same block back at a fraction of the price. Only the
   * totals can tell those apart.
   */
  opening: SessionTokenTotals;
  /**
   * How much the model was holding on the session's last turn — input plus cache,
   * which is the window as that turn saw it.
   *
   * Against the opening window it is the only honest way to say a session grew: a
   * large closing window is ordinary work on a large codebase, whereas a large one
   * that opened small is a session nobody let go of.
   */
  closingContext: number;
  /** Billed usage across the session, as the limit cards define it — cache reads carried, not folded in. */
  tokens: SessionTokenTotals;
}

/**
 * One model's share of a profile's range.
 *
 * Shaped like the history page's own model row and deliberately not the same type:
 * that one belongs to a question about where tokens went, this one to a question
 * about what the spending looked like, and a source may well be able to answer one
 * and not the other.
 */
export interface UsageProfileModel {
  model: string;
  tokens: SessionTokenTotals;
  /** Assistant turns this model answered — turns, not records. */
  turns: number;
}

/**
 * How a stretch of spend was shaped, rather than how much of it there was.
 *
 * The input to `findUsage`, and a type of its own rather than a reading of some
 * other one: where the tokens went is a question about projects and hours, while
 * this asks what the spending looked like, which is a question about sessions. One
 * sweep can answer both, and a source that can answer neither simply says nothing.
 */
export interface UsageProfile {
  /** The range these were measured over. */
  range: { since: number; until: number };
  /** Every session that billed inside the range, heaviest first. */
  sessions: UsageProfileSession[];
  /** Every model's share of the range, heaviest first. */
  models: UsageProfileModel[];
  generatedAt: number;
}

/** Which reading of the range a finding is. */
export type UsageFindingKind = 'long-sessions' | 'standing-context' | 'model-mix';

/**
 * One thing worth saying about a stretch of spend.
 *
 * Data, not prose. What a row says in English is a matter of how the page words
 * things and belongs beside every other sentence on it; what is *true* is measured
 * here and can be tested without a browser.
 *
 * Every finding is counted in billed tokens — input, output and newly-cached, the
 * same definition the limit cards use — so `share` means one thing across all of
 * them and the bars can be read against each other. Cache reads are what a long
 * session actually spends most of, and they appear in the evidence a row shows
 * rather than in its ranking, because they are not what the ceiling counts.
 */
export interface UsageFindingBase {
  kind: UsageFindingKind;
  /** Billed tokens this finding accounts for. Findings are ranked by it. */
  tokens: number;
  /** That, over every billed token in the range. */
  share: number;
}

/** Sessions that were never let go of, and what they came to. */
export interface LongSessionsFinding extends UsageFindingBase {
  kind: 'long-sessions';
  /** The ones over the threshold, heaviest first. */
  sessions: UsageProfileSession[];
  /** The closing window a session in this range typically reached. */
  medianClosingContext: number;
}

/** What every session paid before anything was asked of it. */
export interface StandingContextFinding extends UsageFindingBase {
  kind: 'standing-context';
  /** The opening window a session in this range typically started from. */
  medianOpeningContext: number;
  /** How many sessions paid it. */
  sessions: number;
}

/** One model carrying the range more or less alone. */
export interface ModelMixFinding extends UsageFindingBase {
  kind: 'model-mix';
  /** Every model in the range, heaviest first — the first is the one this is about. */
  models: UsageProfileModel[];
}

export type UsageFinding = LongSessionsFinding | StandingContextFinding | ModelMixFinding;

/** Everything the panel draws, and the range it was measured over. */
export interface UsageFindings {
  findings: UsageFinding[];
  range: { since: number; until: number };
  /** Billed tokens across the range — the denominator every `share` was taken against. */
  tokens: number;
  generatedAt: number;
}
