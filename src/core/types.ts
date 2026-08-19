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

export interface SessionDetail extends Session {
  counts: SessionCounts;
  tokens: SessionTokenTotals;
  /** Every model that answered in this session, in the order first seen. */
  models: string[];
  /** Claude's own recap of what the session achieved, when it wrote one. */
  awaySummary?: string;
  /** Summed turn durations: time spent working, which is far less than wall-clock. */
  activeMs?: number;
  notes: SessionDetailNotes;
}
