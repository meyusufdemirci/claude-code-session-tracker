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
│   ├── desktop.ts         # open a browser, reveal a file — the only outward calls
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
│   │       ├── detail.ts      # one session read in full — the only place that does
│   │       ├── lines.ts       # bounded line reader; caps what one record can cost
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
  // cheap-ish, cached; `include` names ids to resolve whatever the limit
  listRecent(o: { limit: number; include?: readonly string[] }):
    Promise<{ sessions: Session[]; total: number }>;
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
  firstPrompt?: string;
  name?: string;              // 'timfog-fs-f0'
  live?: { pid: number; procStart: string; kind: string; entrypoint: string };
  startedAt: number;
  lastActiveAt: number;
  version?: string;
  model?: string;             // last assistant turn
  sizeBytes?: number;
  transcriptPath?: string;
}

interface SessionDetail extends Session {   // computed lazily, full-stream
  counts: { user: number; assistant: number; tool: number; subagents: number };
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number };
  models: string[];
  awaySummary?: string;
  activeMs?: number;                        // summed turn durations, not wall-clock
  notes: { unreadable: number; oversized: number };   // what the read passed over
}
```

### HTTP API
| route | returns | cost |
|---|---|---|
| `GET /api/health` | version, source availability | free |
| `GET /api/sessions` | merged live + recent list | cached, ~100 ms warm |
| `GET /api/sessions/:id` | `SessionDetail` | streams one file, on demand |
| `GET /api/projects` | grouped rollup + `.claude.json` metrics | cheap |
| `POST /api/sessions/:id/reveal` | shows the transcript in the file manager | free |

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

### Phase 2 — Recent sessions from transcripts  *(~1 day)*  ✅ **DONE**
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
- *Landed:* `transcripts.ts` (candidates → head/tail read → facts), `core/cache.ts`,
  a filesystem-validated slug decoder, and the two-table UI with a filter box.
  **794 transcripts / 830 MB list in 234 ms cold and ~72 ms warm** — comfortably inside
  the budget, because the sort only needs `stat` and the reads only touch the ends.
  Verified against the real directory plus fixtures covering an empty file, a file of
  pure garbage, good records buried in broken ones, a 6 MB middle, multi-byte characters
  straddling both slice boundaries, a session with no `cwd`, one with no timestamps
  anywhere, and one that is nothing but a slash command.
- *Window sizes are measured, not guessed:* every transcript that has an `ai-title` at all
  has one inside the last 64 KB (692 of 790 have one; the other 98 never got a title), and
  786 of 790 yield a first prompt inside the first 16 KB. Widening either window buys nothing.
- *Four things the data forced:*
  - **`last-prompt` has two shapes.** 71 files carry `{ leafUuid }` with no text, and that
    uuid points at the leaf of the conversation tree — often an `attachment`, not the prompt.
    Chasing parent pointers would mean reading the middle, so the fallback re-reads the tail
    for the last real user message instead. Missing prompts: 73 → 4.
  - **Transcripts open with plumbing.** A `/clear`, its caveat block, the context a slash
    command pasted in. The first prompt is the first record that survives stripping those,
    with a command used only when it is all there is — a 2 KB session that is nothing but
    `/clear` is honestly summarised as `/clear`.
  - **Slug decoding needs the filesystem, not a heuristic.** `-Users-yusuf-Tivi-Tivi-FE` could
    be `Tivi/FE`, `Tivi.FE`, `Tivi_FE` or `Tivi-FE`. Rather than guess, the walk asks each
    directory which of its entries slugify to the tokens still to be placed, longest match
    first. It only ever runs for a transcript with no `cwd` — 1 file in 790.
  - **`limit` must not truncate running sessions.** They are the point of the tool, so the
    registry caps only the history underneath, and names the live ids to the transcript
    reader so a long-idle session still gets its title even from outside the top N.
- *Also:* `[hidden]` needed `display: none !important` — a class that sets `display` outranks
  the UA rule, so the "Show more" control stayed visible after everything had loaded.

### Phase 3 — Detail panel  *(~1 day)*  ✅ **DONE**
- `/api/sessions/:id` streams the file line-by-line (never `readFileSync`) to compute
  message counts, tool-call count, token totals, duration, subagent count.
- Surface `away_summary`, first prompt, last prompt.
- UI: click a row → side panel. Include a copyable `claude --resume <id>` and the cwd,
  plus "reveal transcript in Finder".
- **Done when:** the 38 MB transcript opens in < 2 s and memory stays flat.
- *Landed:* `lines.ts` (a bounded line reader), `detail.ts` (the streaming pass),
  `desktop.ts` (the two places we ask the desktop to do something), a
  `POST /api/sessions/:id/reveal` route, and the panel itself.
  **The 37 MB transcript answers in 99 ms over HTTP**, 67 ms warm; the slowest of all
  795 sessions is 140 ms. Every transcript on the machine was then read end to end:
  795 of 795, zero throws, zero unreadable lines.
- *Four things the data forced:*
  - **One assistant turn is written as several records — and each repeats the turn's
    token totals.** Claude Code writes one record per content block: the `thinking`,
    the `text`, one per tool call. All of them carry the *same* `usage` object, so
    summing per record inflates tokens by ~88% (90,387 records for 48,024 real turns).
    The records of a turn are contiguous in all 48,024 cases, so collapsing them needs
    only the previous id — not a set that grows with the file.
  - **`readline` has no ceiling, and transcripts do.** The largest single record on
    this machine is **9.4 MB** — a tool result — and reading the file with `readline`
    pushed peak RSS to 187 MB against a 43 MB baseline. A reader that caps how much of
    any one line it holds brings that to 95 MB and, more to the point, makes memory a
    property of the reader rather than of the biggest tool output in the session.
    The cap is 256 KB, measured not guessed: across 232,700 records every record above
    it is a tool result, an attachment, or a meta record, while the largest `assistant`
    record anywhere is 87 KB. Truncated records are counted and reported, never
    silently dropped.
  - **Tool results are `user` records.** They outnumber real messages ten to one
    (54,043 against 4,628), so "messages" had to mean what the user typed — skipping
    meta records, sidechains, and any turn whose content is nothing but tool results.
  - **Wall-clock is the wrong duration.** `system`/`turn_duration` records appear in
    93% of transcripts and sum to the time actually spent working, which is a small
    fraction of the elapsed span — one real session spans 2h 32m and worked 25m of
    it. The panel shows both, and reports no working time at all rather than `0` when
    the records are absent.
- *Also:* revealing a file is the one thing here that acts rather than reports, so it
  is a POST with an `Origin` check. The loopback guard only proves the *address* was
  loopback, which a form on any website can arrange; `Origin` is the browser's own
  account of who asked. The path is never taken from the request — the id is looked up
  and the transcript the source already vouches for is what gets revealed.
- *Also:* `<synthetic>` is Claude Code's stand-in on messages it wrote itself rather
  than a model anyone chose, so it is kept out of the model list. Its usage is zero.

### Phase 4 — Polish & publish  *(~half a day)*  ✅ **DONE** (publish pending)
- Dark/light, empty state (no `~/.claude`), error states, keyboard nav, relative timestamps.
- README with all four runner commands.
- `--json` prints the session list and exits — makes it scriptable.
- `npm publish --access public` with provenance; the name **`claude-code-session-tracker`
  is still available on npm** (re-checked; `claude-sessions`, `cc-sessions`,
  `claude-session-tracker` are all taken).
- **Done when:** `npx claude-code-session-tracker@latest` works on a clean machine.
- *Landed:* a three-state theme control, the no-data state, a disconnection banner,
  full keyboard navigation, `scripts/smoke.mjs`, and two GitHub workflows — CI
  (node 20/22/24 × npm/pnpm/yarn/bun on Linux, plus npm on macOS and Windows) and a
  tag-driven release that publishes with provenance. The tarball is **84 KB**, holds
  no dependencies and no install scripts, and every check runs against *it* rather
  than against `src/`.
- *Four things the work forced:*
  - **A theme needs three states, and a media query only gives two.** `prefers-color-scheme`
    can say what the OS wants but cannot be overridden, so "Auto" had to become a
    stored preference like the other two. An inline script in the page head resolves
    it to a literal `light`/`dark` before the first paint — which then lets the
    stylesheet carry two flat palettes and no media query at all.
  - **The empty state was unreachable.** The CLI exited `1` when no source could find
    its data, so the page that explains it could never load. Starting anyway is the
    better answer: the page polls, so a machine that has never run Claude Code fills
    in by itself the moment the first session starts. The CLI warns and carries on.
  - **A smoke test that runs `src/` proves nothing about a package.** What breaks on
    publish is the shape of the tarball — a missing executable bit, an asset resolved
    against `process.cwd()`, a stray `postinstall`. So the test installs the packed
    tarball with the named package manager into a temp directory, runs the *linked
    binary* against a fixture transcript, and asserts the things only a published
    package can get wrong: no install scripts, no runtime dependencies, a shim that
    is executable.
  - **`npx /abs/path.tgz` runs the tarball instead of installing it.** npm treats an
    absolute path as a command; `npx ./name.tgz` is the form that installs. Worth
    knowing before writing it into a README.
- *Also:* `node -e "fs.rmSync(...)"` in the `clean` script leaned on `fs` being a
  global, which it is under Node 22 and is not a documented promise. Now explicit.
- *Also:* rows use `:focus`, not `:focus-visible`. Whether a programmatic `.focus()`
  from an arrow key counts as "visible" is a browser heuristic; clicking a row hands
  focus straight to the panel, so a plain `:focus` rule only ever shows for the keyboard.
- *Not done:* the package is **not published yet**. `npm publish` is the one step here
  that cannot be taken back, so it waits for a decision, not a commit.

### Phase 5+ — only if wanted
- **Tell me when a session starts waiting.** The premise at the top of the README is
  that you lose track of which terminal is waiting on you, and the page only answers
  that while you are looking at it. The data is already on every row — `status` and
  `waitingFor` — so this is a client-side diff in `pollSessions`: on `busy|idle →
  waiting`, raise a `Notification` and put a count in `document.title` so a background
  tab says it too. `busy → idle` is the other edge worth raising: the long task
  finished. Permission is asked from a button, never on load; muted by default per
  edge, and the choice is remembered like the theme. No server change, no dependency,
  nothing leaves the machine.
- **A history page** — where the tokens went, per day, per project, per model, from
  the sweep the limit cards already pay for. See §7.
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
| `brew install` | a formula over the same npm tarball, generated by `scripts/formula.mjs` and pushed to `meyusufdemirci/homebrew-tap` on release; `depends_on "node"` makes it the one route that works with no Node already installed |
| fast cold start | `files: ["dist"]` allowlist keeps the tarball tiny |
| programmatic use | `exports` map exposes `.` (CLI) and `./core` (the source adapters) |
| repo dev | `packageManager: "pnpm@10"` pinned — affects contributors only, never consumers |
| CI | matrix: node 20/22/24 × npm/pnpm/yarn/bun, each running `npx <tarball> --json`; the release then does `brew install` + `brew test` + `brew audit --strict` on macOS before the tap moves |

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
| a website POSTing to the reveal endpoint | `Origin` must be loopback; the path comes from our own lookup, never the request; spawned with an argument array, so no shell |
| one enormous record exhausting memory | the detail reader caps how much of any single line it holds, and reports what it passed over |

---

## 6. Estimate

**~3.5 focused days to a publishable v1.** Phase 2 carries the real difficulty;
Phases 0, 1, and 4 are each half a day.

---

## 7. History page — where the tokens went

The two limit cards answer *how full is the window I am in*. They cannot answer
*where did my week go* — which project ate it, which model, which hours of which
days — and that question is the one you ask after a card goes red.

The data is already being read. `readUsageLimits` sweeps every billed transcript
of the last 28 days, reduces each to half-hour buckets, memoises those per file
version, and then throws all but two windows away. This page keeps them. A second
page over the same sweep is the cheapest large feature left in the repo: on a warm
cache it costs a `stat` per file and some arithmetic.

**A page of its own, not a section.** The dashboard is about right now — two cards,
who is running, what ran lately. History is about a stretch of past, has its own
range, its own selection, and wants the width. `/history`, linked from the masthead
both ways.

### 7.1 — Make the sweep answer two questions  *(~half a day)*  ✅ **DONE**

`readUsageLimits` becomes a caller rather than the owner. Split the walk-merge half
out as `readUsageBuckets(config, cache, { since, until })`, and let the limits reader
call it with its own 28 days. Nothing about the limit cards changes — same buckets,
same cache, same numbers.

Two attributions have to be added to the buckets, and they are not the same price:

- **Project is free.** `listBilledFiles` already walks `projects/<slug>/…` and knows
  the slug at the moment it reads the directory entry; it just drops it. Carry it on
  `BilledFile` and merge per `(slug, at)` instead of per `at`. No transcript is
  re-read, and the cache is untouched — the cached value is per *file*, and a file
  belongs to one project forever. Subagent transcripts live under their parent's
  slug, so their turns roll up to the project that spawned them, which is where they
  billed.
- **Model is not.** `scanBuckets` reads `message.model` only to skip `<synthetic>`
  and then discards it. `UsageBucket` gains `byModel: Record<string, { tokens, turns }>`,
  which changes the shape held in the cache. That cache is in-memory only, so the
  cost of the change is one cold sweep after a restart — no migration, no on-disk
  version to bump.

**Done when:** the limits cards report the same numbers they do today, and the
buckets behind them can say which project and which model each half hour was.

- *Landed:* `src/sources/claude-code/buckets.ts` — the sweep, the cache, and the
  parsing, with `readUsageBuckets(config, cache, { since, until })` returning half
  hours by project and `mergeBuckets` folding them for the clocks. `limits.ts` is
  now only the arithmetic of laying two clocks over what it found, down from 631
  lines to 278. `test/sources/claude-code/buckets.test.ts` covers the sweep in its
  own right; the twelve tests include the two the split could have got wrong.
- *Checked against the real directory:* `/api/limits` returns byte-identical JSON
  before and after the split, over 909 files, at the same 1.2 s cold and 9 ms warm.
- *Two things the work forced:*
  - **A cached bucket must be copied before it is merged into.** The cache hands the
    same object out on every sweep, so a merge that kept a reference into one would
    add this sweep's totals to the next sweep's starting point — invisible until two
    transcripts in one project land in one half hour, which is a normal Tuesday.
    `byModel` is copied per model for the same reason its tokens already were.
  - **`until` cannot be filtered by `mtime`.** `since` can — an append-only file last
    written before it cannot hold a record after it — but a file written *after*
    `until` can hold plenty from before, so the upper bound is only ever settled per
    bucket. The asymmetry is worth stating, because the symmetric version looks right.
- *Also:* on this machine the model split covers **all** 192,825,762 billed tokens of
  the last 28 days — every turn named its model, including a local `gemma4:e4b`, which
  is exactly the kind of row a split by model exists to show. The unattributed case is
  still handled rather than assumed away.

### 7.2 — `GET /api/usage/history`  *(~half a day)*  ✅ **DONE**

A fifth optional member on `SessionSource`, beside `limits?()`, because usage
history is the same kind of claim: something only whoever bills the requests can
answer, and a future adapter may not be able to. `SessionRegistry.usage()` picks the
first source that implements it, exactly as `limits()` does. `404` when none can.

```jsonc
{
  "range":    { "since": 0, "until": 0 },
  "bucketMs": 1800000,
  "buckets":  [ { "at": 0, "tokens": {…}, "turns": 0 } ],   // sparse: only half hours with usage
  "projects": [ { "slug": "…", "name": "…", "path": "…", "tokens": {…}, "turns": 0 } ],
  "models":   [ { "model": "claude-opus-5", "tokens": {…}, "turns": 0 } ],
  "generatedAt": 0
}
```

- **Half-hour grain on the wire, folded by the client.** Days are whole *local* days
  everywhere in this tool, and the server has no business guessing a timezone —
  `/api/sessions` already takes epoch milliseconds for the same reason. Buckets are
  sparse (only half hours that hold usage exist at all), so a working month is on the
  order of hundreds of entries, not 1,440.
- **`?project=<slug>` narrows the series** rather than shipping the full
  project × time cross, which is the one thing in this payload that could grow
  without a bound worth paying for.
- **`since`/`until` are the caller's**, as on `/api/sessions`. Capped at 90 days —
  past that the sweep stops being warm and the page stops being honest about the
  wait.

- *Landed:* `src/sources/claude-code/history.ts`, a fifth optional member `usage?()`
  on `SessionSource` with a `UsageQuery` beside `RecentQuery`, `SessionRegistry.usage()`
  on the `limits()` rule, and the route. Sixteen new tests across the reader, the
  registry and the route.
- *Measured on the real directory:* a week is `200 OK` in **446 ms cold, 13 ms warm**,
  and **19.7 KB** of JSON — 107 half hours, 23 projects, 3 models. The warm figure is
  the point of sharing the bucket cache with the limit cards: a page opened beside a
  running dashboard pays a `stat` per file.
- *Three things the work forced:*
  - **`project` narrows the series but never the project list.** The list is what the
    page draws its picker from, and a picker that loses every option but the chosen
    one cannot be used to choose again. Models narrow with the series, because "which
    models did *this* project use" is the question a selection asks.
  - **A slug that matched nothing must not be echoed back.** Asking for a project that
    billed nothing in the range is an empty series, and `project` is left off the reply
    rather than repeated — otherwise an empty page looks like a quiet project instead
    of a bad slug.
  - **The reply states the range it read, not the range it was asked for.** A caller
    that asks for a year gets 90 days and `range` says so, so the page cannot draw an
    axis over data it does not have. Same for a backwards range, which collapses to an
    empty one rather than being refused — that is a date picker mid-edit, not a bug.
- *Also:* `billedTokens` moved to `buckets.ts`. A project ranked on this page and a
  window filled on a limit card have to mean the same thing by "billed", or the page
  contradicts the card; keeping the definition beside the buckets is what enforces that.
- *Known, for 7.4:* a project whose directory has since been moved or deleted cannot
  have its slug walked back to a path, so it falls back to the naive `-` → `/` reading
  — legible, and wrong. On this machine one of 23 projects is in that state. The page
  should mark a project it could not find on disk rather than presenting the guess as
  a location.

### 7.3 — The page  *(~half a day)*  ✅ **DONE**

`src/web/history.html` + `history.js`, sharing `style.css`. `sendStatic` serves by
extension, so `/history` gets one explicit mapping to `/history.html` — a named
route, not a general extensionless fallback that would start guessing at paths.

The inline theme resolver in the head of `index.html` moves to `src/web/theme.js`
and is included by both pages: it still resolves `Auto` to a literal `light`/`dark`
before first paint, and there is one copy of it instead of two that can drift.

- *Landed:* `history.html`, `history.js`, `theme.js`, `format.js`, a `PAGES` map in
  `sendStatic`, and a nav in both mastheads. Four new route tests, and the page
  verified in a browser against the real directory: 32 projects and 4 models over 30
  days, no console errors, the dashboard unchanged beside it.
- *Scope moved:* the **project and model tables landed here**, not in 7.4. A shell
  with nothing in it cannot be reviewed, and both tables are ordinary markup over
  `/api/usage/history` — no chart work at all. 7.4 is now the two drawings (spend per
  day, hour of day) and the click-to-filter that ties them to the tables.
- *Three things the work forced:*
  - **`theme.js` cannot be a module.** A module is deferred, and deferring the theme
    shows a light page for a frame to everyone who chose dark — the very thing the
    inline script existed to prevent. So it is a plain blocking script that stamps the
    root immediately, then wires the buttons on `DOMContentLoaded` (they do not exist
    yet when the head runs). It owns the whole control now, which took ~45 lines out
    of `app.js` rather than copying them into a second page.
  - **`/history` is a named route, not a fallback.** Trying `path + '.html'` for any
    unknown path turns every 404 into a filesystem probe. There are two pages here,
    so there is a two-entry map — and a test that `/sessions` still 404s.
  - **The busiest day has to be computed in the browser.** The buckets arrive at
    half-hour grain in absolute time, and which local day one falls in is a question
    only the reader's timezone can answer. That is the same reason 7.2 ships the
    native grain instead of days, now with a first caller depending on it.
- *Also:* `formatCount`, `formatShare`, `formatDay` and the rest moved to
  `format.js`, imported by both pages. A share rounded down on one page and to
  nearest on the other would be a real bug the day someone compares them.
- *Seen on the real page, for 7.4:* two projects can share a basename — `iOS` appears
  twice (Tivi and Apa), `Trendradar` twice — so the name alone does not identify a
  row. The path underneath does, but the table should probably show the parent
  directory rather than leaning on it.

### 7.4 — What is actually on it  *(~1 day)*

Four reads, in the order the question gets asked. Every chart is hand-rolled SVG —
the repo has no runtime dependency and this feature is not the reason to get one.

1. **Spend per day**, a bar per local day across the range, with the days Claude
   refused a turn marked. This is the shape of the answer: which days were heavy.
2. **Projects**, a table ordered by spend with the share bar the limit cards already
   use. Clicking one narrows everything else on the page to it.
3. **Models**, the same table, one row per model — where an Opus habit shows up.
4. **Hour of day**, a 7 × 48 grid off the native bucket grain, which is free and says
   something the daily bars cannot: whether the five-hour window keeps getting
   opened at 09:00 or at 23:00.

The rules the rest of the tool keeps, kept here: billed is input + output + newly
cached, cache reads are shown apart and never folded in, `<synthetic>` is not a
model, and a range with nothing in it says so rather than drawing an empty axis.

### 7.5 — Range, state, and the trip back  *(~half a day)*

The Range control from the Recent table, reused: 7 / 30 / 90 days or a custom pair
of dates, in the query string alongside the selected project — `?range=30d&project=…`
— so a reload comes back to the same view and a bookmark keeps it. The page does not
poll: history does not move fast enough to be worth re-reading every two seconds, so
it loads on open and on a change of range, with a manual refresh.

### 7.6 — Tests and docs  *(~half a day)*

`test/sources/claude-code/history.test.ts`, mirroring `src/` as everything in `test/`
does, over real fixture files: two projects, two models, a subagent, a
`<synthetic>` record, and turns either side of a local midnight — the last being the
one that catches a server that bucketed by day in UTC. A route test for the 404 when
no source can measure it. Then the README section and a screenshot pair, light and
dark, beside the two already in `docs/`.

### Estimate

**~3 days.** 7.1 carries the only real risk — a cache shape change and an attribution
that must not quietly alter the limit cards — and 7.4 carries the most work.

### Risks

| risk | mitigation |
|---|---|
| a 90-day sweep is cold and slow the first time | the range is capped, the page says it is reading, and the 28 days the limit cards already warm are free |
| `byModel` grows every cached bucket | one small record per model *seen in that half hour* — in practice one, rarely two |
| a machine with hundreds of projects | the project list is ranked and cut to the top N, with the tail summed into one `other` row |
| per-day totals disagreeing with the limit cards | both read the same buckets from the same sweep; the only difference is where the edges fall, and the page says which |
