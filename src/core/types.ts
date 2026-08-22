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

/**
 * A snapshot of how full the context window is right now, unlike `tokens` on
 * `SessionDetail`, which sums every turn ever billed.
 *
 * Transcripts carry no per-category breakdown (no line tells us "this many tokens
 * were the system prompt"), so this only splits what the usage numbers actually
 * support: the first turn's cache write as a proxy for the static system prompt,
 * tools, skills, and agent definitions, versus what the window has grown by since.
 */
export interface SessionContextDetail {
  /** The first turn's cache-write — static system/tools/skills/agents, plus the opening prompt. */
  staticTokens: number;
  /** Grown since that first turn: later prompts, replies, and tool results still in view. */
  conversationTokens: number;
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
 * One five-hour usage window — what Claude Code calls a session limit.
 *
 * The quota itself is enforced server-side and never written to disk. The only
 * trace it leaves in a transcript is a rejection record on the turn that got cut
 * off, so everything here is measured rather than read: the window's bounds from
 * the turn timestamps, its size from the `usage` totals those turns carry.
 */
export interface UsageWindow {
  /** The window's first billed turn, floored to the half hour — where Claude puts it. */
  startedAt: number;
  /** The moment the window empties. From Claude itself when it told us, else `startedAt` plus five hours. */
  resetsAt: number;
  /** True when that reset time is Claude's own, taken off a rejection record rather than derived. */
  resetsAtIsReported: boolean;
  tokens: SessionTokenTotals;
  /** Assistant turns billed inside the window — turns, not records. */
  turns: number;
  /** Claude Code recorded a five-hour rate-limit rejection inside this window. */
  limited: boolean;
}

/** Usage against the five-hour limit: the window in progress, and a yardstick for it. */
export interface UsageLimits {
  /** The window the clock is inside. Absent when nothing has run for five hours. */
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
  generatedAt: number;
}
