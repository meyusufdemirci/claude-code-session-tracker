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
}

export interface SessionTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface SessionDetail extends Session {
  counts: { user: number; assistant: number; tool: number; subagents: number };
  tokens: SessionTokenTotals;
  models: string[];
  awaySummary?: string;
  /** Lines we could not parse. Non-zero means the transcript format drifted. */
  skippedLines: number;
}
