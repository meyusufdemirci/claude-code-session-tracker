# claude-code-session-tracker — Project Plan

`npx claude-code-session-tracker` → starts a local server → opens a localhost page
listing every Claude Code session on this machine, grouped by project, with live status.

**Guiding rule:** read-only, zero runtime dependencies, one command to run.
Everything that could grow later hides behind one seam (`src/sources/`) so v1 stays small.

---

## 1. What the data actually looks like (verified on this machine)

Three sources exist under `~/.claude`. All are read-only for us. We never write there.

### A. Live registry — `~/.claude/sessions/<pid>.json`
Tiny (~500 B each, 7 files right now). This is the *current sessions* source of truth.

```json
{
  "pid": 52449,
  "sessionId": "4ddb7bac-d3cd-4f01-a117-13f444c2ffc6",
  "cwd": "/Users/yusuf/Desktop/Work/Freelance/Timfog/Timfog-FS",
  "startedAt": 1787119735220,
  "procStart": "Wed Aug 19 06:08:54 2026",
  "version": "2.1.235",
  "kind": "interactive",
  "entrypoint": "cli",
  "messagingSocketPath": "/tmp/cc-socks/52449.sock",
  "name": "timfog-fs-f0",
  "nameSource": "derived",
  "status": "waiting",
  "waitingFor": "input needed",
  "updatedAt": 1787120011071,
  "statusUpdatedAt": 1787120011071
}
```

`status` observed: `busy` | `idle` | `waiting` (+ `waitingFor` text).
Files are **not** cleaned up reliably → liveness must be checked (see §4).

### B. Transcripts — `~/.claude/projects/<slug>/<sessionId>.jsonl`
**869 files / 1.0 GB on this machine, largest single file 38 MB.**
This is the history source. It must never be fully read on the list endpoint.

Newline-delimited JSON; record `type` values seen: `user`, `assistant`, `system`,
`attachment`, `mode`, `permission-mode`, `last-prompt`, `ai-title`,
`file-history-snapshot`, `file-history-delta`, `queue-operation`.

The three that matter most:

| record | payload | why we want it |
|---|---|---|
| `ai-title` | `{ aiTitle: "Add distributor application button to login page" }` | human-readable session title |
| `last-prompt` | `{ lastPrompt, leafUuid }` | what the user last asked |
| `assistant` | `message.model`, `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`, plus top-level `cwd`, `gitBranch`, `version`, `timestamp` | model, tokens, branch |

Bonus: `system` records with `subtype: "away_summary"` carry a written recap of what
the session accomplished — excellent detail-panel content.

Sub-agent transcripts live in `~/.claude/projects/<slug>/<sessionId>/subagents/*.jsonl`.

### C. Project rollup — `~/.claude.json` → `projects[<absolute cwd>]`
~200 KB, single read. Per-project last-run metrics we get for free:
`lastCost`, `lastDuration`, `lastSessionId`, `lastSessionFirstPrompt`,
`lastTotalInputTokens`, `lastTotalOutputTokens`, `lastModelUsage`,
`lastLinesAdded`, `lastLinesRemoved`, `lastSessionModified`.

---

## 2. Architecture

```
claude-code-session-tracker/
├── package.json           # bin + exports + engines, no runtime deps
├── tsconfig.json
├── src/
│   ├── cli.ts             # flags, port pick, browser open
│   ├── server.ts          # node:http — /api/* + static
│   ├── config.ts          # paths, env overrides (CLAUDE_CONFIG_DIR)
│   ├── core/
│   │   ├── types.ts       # the Session contract — the stable centre
│   │   ├── registry.ts    # merge sources, dedupe by id, sort
│   │   └── cache.ts       # memo keyed by `${path}:${mtimeMs}:${size}`
│   ├── sources/           # <<< the scalability seam
│   │   ├── source.ts      # interface SessionSource
│   │   └── claude-code/
│   │       ├── index.ts
│   │       ├── live.ts        # A: ~/.claude/sessions/*.json → Session records
│   │       ├── liveness.ts    # pid + start-time check, so stale files never show
│   │       ├── git.ts         # current branch from .git/HEAD
│   │       ├── transcripts.ts # B: jsonl head/tail reads, never full
│   │       ├── projects.ts    # C: ~/.claude.json rollup
│   │       └── slug.ts        # slug ⇄ path decoding
│   └── web/               # copied verbatim to dist/web
│       ├── index.html
│       ├── app.js
│       └── style.css
└── README.md
```

### Non-negotiables
- **Zero runtime dependencies.** `node:http`, `node:fs`, `node:path` only.
  Keeps `npx` cold start ~1 s and sidesteps every package-manager resolution quirk.
- **ESM, Node ≥ 20.** Assets resolved via `import.meta.url`, never `process.cwd()`.
- **Bind `127.0.0.1` only.** Transcripts contain prompts, paths, sometimes secrets.
- **Never crash on a malformed line.** Skip it, count it, move on. The `.jsonl` format
  is private and undocumented — it will change under us.

### The one interface everything hangs off
```ts
export interface SessionSource {
  id: string;                        // 'claude-code'
  isAvailable(): Promise<boolean>;   // does ~/.claude exist?
  listLive(): Promise<Session[]>;    // cheap, every poll
  listRecent(o: { limit: number }): Promise<Session[]>;  // cheap-ish, cached
  detail(id: string): Promise<SessionDetail>;            // expensive, on demand
}
```
Adding Codex / Cursor / any other agent CLI later = one new folder under `sources/`.
Nothing above it changes.

### Data model
```ts
type SessionStatus = 'busy' | 'waiting' | 'idle' | 'ended';

interface Session {
  id: string;                 // sessionId uuid
  source: string;             // 'claude-code'
  status: SessionStatus;
  waitingFor?: string;
  project: { name: string; path: string; slug: string; gitBranch?: string };
  title?: string;             // ai-title
  lastPrompt?: string;
  name?: string;              // 'timfog-fs-f0'
  live?: { pid: number; procStart: string; kind: string; entrypoint: string };
  startedAt: number;
  lastActiveAt: number;
  version?: string;
  sizeBytes?: number;
  transcriptPath?: string;
}

interface SessionDetail extends Session {   // computed lazily, full-stream
  counts: { user: number; assistant: number; tool: number; subagents: number };
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number };
  models: string[];
  awaySummary?: string;
  firstPrompt?: string;
}
```

### HTTP API
| route | returns | cost |
|---|---|---|
| `GET /api/health` | version, source availability | free |
| `GET /api/sessions` | merged live + recent list | cached, ~100 ms warm |
| `GET /api/sessions/:id` | `SessionDetail` | streams one file, on demand |
| `GET /api/projects` | grouped rollup + `.claude.json` metrics | cheap |

v1 client **polls `/api/sessions` every 2 s**. SSE is a Phase 5 upgrade, not a v1 need.

---

## 3. Phases

Each phase ends with something runnable. No phase depends on a later one.

### Phase 0 — Scaffold that already works via npx  *(~half a day)*  ✅ **DONE**
- `package.json`: `"type": "module"`, `"bin": { "claude-code-session-tracker": "./dist/cli.js" }`,
  `"engines": { "node": ">=20" }`, `"files": ["dist"]`, no `postinstall`.
- `tsc` build → `dist`; shebang preserved, `chmod +x` in the build script.
- CLI flags: `--port` (default 4747, auto-increment if taken), `--host`, `--open` / `--no-open`,
  `--json`, `--help`, `--version`.
- Server returns a static "hello" page.
- **Done when:** `npm pack` → `npx ./claude-code-session-tracker-0.1.0.tgz` serves the page.
- *Landed:* zero-dep ESM build (`tsc` + `scripts/build.js`), all flags above, port auto-increment,
  loopback-only bind with a Host-header guard against DNS rebinding, `CLAUDE_CONFIG_DIR` honoured,
  and the `SessionSource` seam stubbed so Phase 1 only fills in `live.ts`.

### Phase 1 — Live sessions  *(~half a day)*  ✅ **DONE**
- `sources/claude-code/live.ts`: glob `~/.claude/sessions/*.json`, parse, filter dead PIDs.
- Liveness: `process.kill(pid, 0)` **and** cross-check `procStart` against the real process
  start time — guards against PID reuse showing a stale session as running.
- `/api/sessions` returns live sessions only.
- UI: one table — project name · session name · status badge · branch · uptime · version · PID.
- **Done when:** starting a `claude` in another terminal makes a row appear within 2 s,
  and its badge flips `busy` → `waiting` as it asks for input.
- *Landed:* `live.ts` (read + validate), `liveness.ts` (the two-gate pid check),
  `slug.ts`, `git.ts`. Verified against 6 real sessions plus fixtures covering a
  recycled pid, a dead pid, a missing/garbage `procStart`, malformed JSON, and a
  record with no session id — each handled as intended.
- *Two things the data forced:*
  - **`procStart` is UTC, `ps` prints local.** A session recorded at `05:30:26` shows
    as `08:30:26` under `ps` in a UTC+3 zone. A naive string compare would have marked
    every session dead, so the check parses both readings and accepts either.
  - **Branch comes from `.git/HEAD`, not the transcript.** Live records carry no branch,
    and a running session's *current* branch is what the row should show — the transcript
    only knows the branch as of its last message. Two small reads, no `git` subprocess.
- *Also:* liveness is decided per record, not per pid, so two records naming the same
  pid cannot vouch for each other.

### Phase 2 — Recent sessions from transcripts  *(~1 day)*  ← the hard one
- `readdir` + `stat` pass over `~/.claude/projects/*` for the candidate list and mtimes.
  No file contents read at this stage.
- For the top N by mtime: **tail-read last 64 KB** (`ai-title`, `last-prompt`, last `assistant`
  record → model/branch/version, last timestamp) and **head-read first 16 KB** (first user
  prompt, `startedAt`). Never the middle.
- Memoize on `${path}:${mtimeMs}:${size}` — an unchanged file is never re-read.
- Merge with live by `sessionId`: live wins for `status`, transcript supplies title/branch/prompt.
- Project name: prefer `cwd` from the records (slug decoding is lossy — real directory names
  contain dashes). Fall back to slug heuristics validated with `existsSync`.
- UI: "Active" section above "Recent", client-side search box, `?limit=` param.
- **Done when:** all 869 files list in < 500 ms warm / < 1.5 s cold. (Shell tail-reading
  every file already measures 1.3 s — Node with parallel FDs will beat it.)

### Phase 3 — Detail panel  *(~1 day)*
- `/api/sessions/:id` streams the file line-by-line (`readline`, never `readFileSync`) to
  compute message counts, tool-call count, per-model token totals, duration, subagent count.
- Surface `away_summary`, first prompt, last prompt.
- UI: click a row → side panel. Include a copyable `claude --resume <id>` and the cwd,
  plus "reveal transcript in Finder".
- **Done when:** the 38 MB transcript opens in < 2 s and memory stays flat.

### Phase 4 — Polish & publish  *(~half a day)*
- Dark/light, empty state (no `~/.claude`), error states, keyboard nav, relative timestamps.
- README with all four runner commands.
- `--json` prints the session list and exits — makes it scriptable.
- `npm publish --access public` with provenance; the name **`claude-code-session-tracker`
  is available on npm** (`claude-sessions`, `cc-sessions`, `claude-session-tracker` are all taken).
- **Done when:** `npx claude-code-session-tracker@latest` works on a clean machine.

### Phase 5+ — only if wanted
- SSE `/api/events` replacing the 2 s poll.
- A second source adapter (Codex / Cursor) — the real test of the `sources/` seam.
- Per-project cost rollup from `.claude.json` `lastCost` + token pricing.
- Transcript viewer (render the conversation, not just stats).
- Interactive: `messagingSocketPath` allows sending to a running session — powerful, but
  it breaks the read-only guarantee. Opt-in behind a flag if ever.
- Split into `packages/core` + `packages/cli` + `packages/web` **only** when the web app
  needs its own build step. Not before.

---

## 4. Package-manager support (the "scalable" ask)

Works everywhere from day one, because of what we *don't* do:

| requirement | how |
|---|---|
| `npx claude-code-session-tracker` | `bin` field + shebang + executable bit |
| `pnpm dlx` / `yarn dlx` / `bunx` | zero deps, no `postinstall`, no native modules |
| Yarn PnP | no `__dirname`, no filesystem assumptions outside the package; assets via `import.meta.url` |
| fast cold start | `files: ["dist"]` allowlist keeps the tarball tiny |
| programmatic use | `exports` map exposes `.` (CLI) and `./core` (the source adapters) |
| repo dev | `packageManager: "pnpm@10"` pinned — affects contributors only, never consumers |
| CI | matrix: node 20/22/24 × npm/pnpm/yarn/bun, each running `npx <tarball> --json` |

---

## 5. Risks and how each is handled

| risk | mitigation |
|---|---|
| `.jsonl` format is private and will change | all parsing confined to `sources/claude-code/`; tolerate unknown fields; skip bad lines rather than throw |
| 1 GB of transcripts | stat-only listing, head/tail reads, mtime-keyed cache, streaming for detail |
| PID reuse marks a dead session live | cross-check `procStart` with the real process start time |
| slug → path decoding is ambiguous | prefer `cwd` from record contents; slug only as fallback |
| prompts contain secrets | localhost bind only, no telemetry, no outbound calls, read-only |
| `CLAUDE_CONFIG_DIR` set to a custom path | honour the env var in `config.ts` from Phase 0 |

---

## 6. Estimate

**~3.5 focused days to a publishable v1.** Phase 2 carries the real difficulty;
Phases 0, 1, and 4 are each half a day.
