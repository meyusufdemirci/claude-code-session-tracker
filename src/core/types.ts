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
