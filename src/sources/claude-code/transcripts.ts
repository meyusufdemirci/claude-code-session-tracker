import type { FileHandle } from 'node:fs/promises';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TrackerConfig } from '../../config.ts';
import type { FileCache } from '../../core/cache.ts';
import type { Session, SessionTokenTotals } from '../../core/types.ts';
import type { RecentQuery, RecentSessions, RecentWindow } from '../source.ts';
import { pathToSlug, projectNameFromPath, resolveSlugPath } from './slug.ts';
import { scanTokens } from './usage.ts';

/**
 * Enough of the opening to reach the first real prompt and the first timestamp.
 * Measured against 790 transcripts: 786 yield a prompt here, and the four that do
 * not never contained one.
 */
const HEAD_BYTES = 16 * 1024;

/**
 * Enough of the ending to reach the last `ai-title`, `last-prompt` and `assistant`
 * record. Measured against the same 790: every transcript that has a title at all
 * has one inside this window, so widening it would buy nothing.
 */
const TAIL_BYTES = 64 * 1024;

/** Transcripts are named after the session uuid. Nothing else in the folder is ours. */
const TRANSCRIPT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Listing everything opens ~800 files; keep the descriptor count polite. */
const MAX_OPEN_FILES = 24;

/**
 * How many transcripts a token-ordered window will open.
 *
 * Recency comes free from `stat`, so that ordering only ever opens the rows it
 * shows. Token totals are inside the files, so ranking by them means reading the
 * whole window first — 871 transcripts in ~1.4 s cold on the development machine,
 * and free afterwards, because `FileCache` keeps every one of them. This ceiling is
 * what stops a window nobody narrowed from becoming an unbounded read.
 */
const MAX_RANKED = 2_000;

/** Prompts are for recognising a session in a list, not for reading it. */
const MAX_PROMPT_CHARS = 280;

/**
 * The wrappers Claude Code puts around slash commands and their output. They are
 * plumbing, not something the user typed, so they never count as the first prompt.
 */
const COMMAND_BLOCK =
  /<(command-name|command-message|command-args|command-contents|local-command-caveat|local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * Finished sessions, newest first, read from `~/.claude/projects`.
 *
 * Finding the candidates costs one `readdir` per project plus a `stat` per file and
 * reads no contents at all, so both the sort by recency and the `since`/`until`
 * window are settled before a single transcript is opened. Only the chosen ones are
 * read: their first 16 KB and last 64 KB for the facts a row needs, plus a full
 * streaming pass to total the tokens a row shows. The full pass is the one place the
 * cost scales with a transcript's size rather than its position in the list, but
 * `FileCache` means it only runs once per file version — a live session pays it
 * every poll, a finished one never again.
 *
 * How many get chosen depends on `sort`. Recency is already known, so it opens
 * exactly `limit` of them; a token order is not, so it opens the whole window and
 * leaves the ranking to the caller, which is the only place that sees every source.
 */
export async function listRecentSessions(
  config: TrackerConfig,
  options: RecentQuery,
  cache: FileCache<Session>,
): Promise<RecentSessions> {
  const candidates = await listCandidates(config.projectsDir);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const within = candidates.filter((candidate) => inWindow(candidate.mtimeMs, options));
  const ranked = options.sort !== undefined && options.sort !== 'recent';
  const chosen = within.slice(0, ranked ? MAX_RANKED : Math.max(0, options.limit));

  // Named sessions are resolved even when they sort below the cut or fall outside
  // the window: a live session that has been idle for a while still deserves its
  // title in the listing, whatever stretch of history is on screen.
  const wanted = new Set(options.include ?? []);
  if (wanted.size > 0) {
    for (const candidate of chosen) wanted.delete(candidate.id);
    for (const candidate of candidates) if (wanted.delete(candidate.id)) chosen.push(candidate);
  }

  const sessions = await mapLimit(chosen, MAX_OPEN_FILES, (candidate) =>
    loadSession(candidate, cache),
  );

  return {
    sessions: sessions.filter((session): session is Session => session !== undefined),
    total: within.length,
  };
}

/**
 * Whether a transcript's last write falls inside the window.
 *
 * `mtimeMs` rather than the last timestamp inside the file, because the window has
 * to be settled before anything is opened — narrowing a listing must never cost more
 * than not narrowing it. The two agree to within the time it takes to flush a line,
 * which only shows at a boundary: a session that stopped just before midnight and
 * was flushed just after belongs to yesterday and lists under today.
 */
function inWindow(mtimeMs: number, { since, until }: RecentWindow): boolean {
  if (since !== undefined && mtimeMs < since) return false;
  if (until !== undefined && mtimeMs >= until) return false;
  return true;
}

/** A transcript we know the size and age of, but have not opened. */
export interface Candidate {
  id: string;
  path: string;
  slug: string;
  mtimeMs: number;
  size: number;
}

async function listCandidates(projectsDir: string): Promise<Candidate[]> {
  let projects: import('node:fs').Dirent[];
  try {
    projects = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    // No projects directory means no history — not an error.
    return [];
  }

  const perProject = await Promise.all(
    projects
      .filter((entry) => entry.isDirectory())
      .map((entry) => listProject(projectsDir, entry.name)),
  );
  return perProject.flat();
}

async function listProject(projectsDir: string, slug: string): Promise<Candidate[]> {
  const dir = join(projectsDir, slug);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const found = await Promise.all(
    names.map(async (name): Promise<Candidate | undefined> => {
      const match = TRANSCRIPT_FILE.exec(name);
      if (!match?.[1]) return undefined;

      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size === 0) return undefined;
        return { id: match[1].toLowerCase(), path, slug, mtimeMs: info.mtimeMs, size: info.size };
      } catch {
        // Deleted between the readdir and the stat.
        return undefined;
      }
    }),
  );

  return found.filter((candidate): candidate is Candidate => candidate !== undefined);
}

/**
 * The cheap facts for one transcript, taken from the cache when the file has not
 * moved since we last looked.
 */
export async function loadSession(
  candidate: Candidate,
  cache: FileCache<Session>,
): Promise<Session | undefined> {
  const cached = cache.get(candidate.path, candidate);
  if (cached) return cached;

  const session = await readSession(candidate);
  if (session) cache.set(candidate.path, candidate, session);
  return session;
}

/**
 * Locate one transcript by session id.
 *
 * Costs the same `readdir` + `stat` sweep as the listing and reads no contents,
 * which is cheap enough that the detail endpoint need not trust a stale index.
 */
export async function findCandidate(
  projectsDir: string,
  id: string,
): Promise<Candidate | undefined> {
  const wanted = id.toLowerCase();
  const candidates = await listCandidates(projectsDir);
  // A resumed session can leave a transcript in more than one project folder;
  // the most recently written one is the live copy.
  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (candidate.id !== wanted) continue;
    if (!best || candidate.mtimeMs > best.mtimeMs) best = candidate;
  }
  return best;
}

async function readSession(candidate: Candidate): Promise<Session | undefined> {
  let head: Chunk;
  let tail: Chunk | undefined;
  // Run alongside the head/tail read rather than after it: the two scan the same
  // file independently, so there is no reason to pay for them one at a time.
  const tokensPromise = readTokens(candidate.path);
  try {
    ({ head, tail } = await readEnds(candidate.path, candidate.size));
  } catch {
    return undefined;
  }

  const headRecords = parseChunk(head);
  // A file small enough to be read whole has no separate tail; both ends are the same records.
  const tailRecords = tail ? parseChunk(tail) : headRecords;
  if (headRecords.length === 0 && tailRecords.length === 0) return undefined;

  const facts = readFacts(headRecords, tailRecords);
  const path = facts.cwd ?? (await resolveSlugPath(candidate.slug));
  // `mtimeMs` is fractional; every other time we report is whole milliseconds.
  const modifiedAt = Math.round(candidate.mtimeMs);

  const session: Session = {
    id: candidate.id,
    source: 'claude-code',
    // Anything without a live process behind it has ended, whatever it was doing last.
    status: 'ended',
    project: {
      name: projectNameFromPath(path),
      path,
      slug: facts.cwd ? pathToSlug(facts.cwd) : candidate.slug,
      ...(facts.gitBranch ? { gitBranch: facts.gitBranch } : {}),
    },
    startedAt: facts.startedAt ?? facts.lastActiveAt ?? modifiedAt,
    // The file's own mtime is the honest answer when the last records carry no timestamp.
    lastActiveAt: facts.lastActiveAt ?? modifiedAt,
    transcriptPath: candidate.path,
    sizeBytes: candidate.size,
    tokens: await tokensPromise,
  };

  if (facts.title) session.title = facts.title;
  if (facts.lastPrompt) session.lastPrompt = clip(facts.lastPrompt);
  if (facts.firstPrompt) session.firstPrompt = clip(facts.firstPrompt);
  if (facts.version) session.version = facts.version;
  if (facts.model) session.model = facts.model;

  return session;
}

/**
 * Token totals never fail a listing. A transcript deleted between the `stat` and
 * this read (or one that trips the stream reader some other way) just shows zero
 * tokens rather than dropping the row `readEnds` still managed to build.
 */
async function readTokens(path: string): Promise<SessionTokenTotals> {
  try {
    return await scanTokens(path);
  } catch {
    return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  }
}

/** A slice of a transcript, plus whether its edges cut a line in half. */
interface Chunk {
  text: string;
  partialStart: boolean;
  partialEnd: boolean;
}

/**
 * The first 16 KB and last 64 KB of a transcript, in one open.
 *
 * Slicing at byte offsets cuts both lines and multi-byte characters, but only at
 * the edges — and those edges are exactly the partial lines we discard, so a
 * mangled character can never reach the parser.
 */
async function readEnds(path: string, size: number): Promise<{ head: Chunk; tail?: Chunk }> {
  const handle = await open(path, 'r');
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      // Small enough that the two windows would overlap; one read covers both ends.
      const text = await readAt(handle, 0, size);
      return { head: { text, partialStart: false, partialEnd: false } };
    }

    const head = await readAt(handle, 0, HEAD_BYTES);
    const tail = await readAt(handle, size - TAIL_BYTES, TAIL_BYTES);
    return {
      head: { text: head, partialStart: false, partialEnd: true },
      tail: { text: tail, partialStart: true, partialEnd: false },
    };
  } finally {
    await handle.close();
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<string> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  // Only the region actually written is ever read back out of the buffer.
  return buffer.subarray(0, bytesRead).toString('utf8');
}

/**
 * Every record Claude Code writes. All fields are `unknown` because the format is
 * private and undocumented — it will change under us, and a field that has changed
 * shape must cost us that one field, never the listing.
 */
interface TranscriptRecord {
  type?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  version?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  aiTitle?: unknown;
  lastPrompt?: unknown;
  message?: unknown;
}

function parseChunk(chunk: Chunk): TranscriptRecord[] {
  const lines = chunk.text.split('\n');
  // Order matters: popping first keeps the indices right on a single-line chunk.
  if (chunk.partialEnd) lines.pop();
  if (chunk.partialStart) lines.shift();

  const records: TranscriptRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) records.push(parsed as TranscriptRecord);
    } catch {
      // One unreadable line is not a failure; skip it and keep the rest.
    }
  }
  return records;
}

interface TranscriptFacts {
  startedAt?: number;
  lastActiveAt?: number;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  title?: string;
  lastPrompt?: string;
  firstPrompt?: string;
}

/**
 * Head answers "how did this session open", tail answers "where did it end up".
 *
 * Claude Code rewrites `ai-title` and `last-prompt` on every turn rather than
 * amending them, so the tail holds the current values and the last one wins.
 */
function readFacts(head: TranscriptRecord[], tail: TranscriptRecord[]): TranscriptFacts {
  const facts: TranscriptFacts = {};

  for (const record of head) {
    if (facts.startedAt === undefined) facts.startedAt = timestampOf(record);
    if (facts.cwd === undefined) facts.cwd = str(record.cwd);
  }

  const firstPrompt = pickFirstPrompt(head);
  if (firstPrompt) facts.firstPrompt = firstPrompt;

  for (const record of tail) {
    const at = timestampOf(record);
    if (at !== undefined) facts.lastActiveAt = at;

    switch (str(record.type)) {
      case 'ai-title':
        facts.title = str(record.aiTitle) ?? facts.title;
        break;
      case 'last-prompt':
        facts.lastPrompt = str(record.lastPrompt) ?? facts.lastPrompt;
        break;
      case 'assistant':
        facts.model = modelOf(record) ?? facts.model;
        break;
    }

    facts.cwd = str(record.cwd) ?? facts.cwd;
    facts.gitBranch = str(record.gitBranch) ?? facts.gitBranch;
    facts.version = str(record.version) ?? facts.version;
  }

  if (facts.lastPrompt === undefined) facts.lastPrompt = pickLastPrompt(tail);

  return facts;
}

/** The first thing the user actually asked for. */
function pickFirstPrompt(records: TranscriptRecord[]): string | undefined {
  return pickPrompt(records, 1);
}

/**
 * The last thing they asked for.
 *
 * Only needed when the `last-prompt` record carries no text — it sometimes holds
 * just a `leafUuid`, and that uuid points at the leaf of the conversation tree
 * (often an attachment), not at the prompt. Reading back through the records we
 * already have is both cheaper and more direct than chasing parent pointers.
 */
function pickLastPrompt(records: TranscriptRecord[]): string | undefined {
  return pickPrompt(records, -1);
}

/**
 * Walk the records in `direction` and return the first real prompt found.
 *
 * Transcripts are full of plumbing — a `/clear` that started the session, the
 * caveat block that comes with it, the context a slash command pasted in. A plain
 * prompt is what we want, so a command is only used when it is all there is:
 * a session that is nothing but `/commit` really was about running `/commit`.
 */
function pickPrompt(records: TranscriptRecord[], direction: 1 | -1): string | undefined {
  let command: string | undefined;

  const start = direction === 1 ? 0 : records.length - 1;
  for (let i = start; i >= 0 && i < records.length; i += direction) {
    const prompt = promptOf(records[i] as TranscriptRecord);
    if (!prompt) continue;
    if (!prompt.isCommand) return prompt.text;
    command ??= prompt.text;
  }

  return command;
}

/**
 * What a single `user` record actually said, clipped for display — or nothing when
 * the record is plumbing (a tool result, a meta record) rather than a prompt.
 */
export function promptText(record: TranscriptRecord): string | undefined {
  const prompt = promptOf(record);
  return prompt ? clip(prompt.text) : undefined;
}

/** The text a user record carries, or nothing when it is plumbing rather than a prompt. */
function promptOf(record: TranscriptRecord): { text: string; isCommand: boolean } | undefined {
  if (str(record.type) !== 'user') return undefined;
  if (record.isMeta === true || record.isSidechain === true) return undefined;

  const text = messageText(record).trim();
  if (!text) return undefined;

  const plain = text.replace(COMMAND_BLOCK, '').trim();
  if (plain) return { text: plain, isCommand: false };

  const name = COMMAND_NAME.exec(text)?.[1]?.trim();
  if (!name) return undefined;

  const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
  return { text: args ? `${name} ${args}` : name, isCommand: true };
}

/** Message content is a plain string on older records and a block list on newer ones. */
function messageText(record: TranscriptRecord): string {
  const message = record.message;
  if (typeof message !== 'object' || message === null) return '';

  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((block) =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
        ? (str((block as { text?: unknown }).text) ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

function modelOf(record: TranscriptRecord): string | undefined {
  const message = record.message;
  if (typeof message !== 'object' || message === null) return undefined;
  return str((message as { model?: unknown }).model);
}

function timestampOf(record: TranscriptRecord): number | undefined {
  const raw = str(record.timestamp);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_PROMPT_CHARS
    ? `${collapsed.slice(0, MAX_PROMPT_CHARS - 1)}…`
    : collapsed;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
