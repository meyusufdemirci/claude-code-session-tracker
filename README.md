# claude-code-session-tracker

[![CI](https://github.com/meyusufdemirci/claude-code-session-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/meyusufdemirci/claude-code-session-tracker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/claude-code-session-tracker)](https://www.npmjs.com/package/claude-code-session-tracker)
[![node](https://img.shields.io/node/v/claude-code-session-tracker)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/claude-code-session-tracker)](./LICENSE)

See every Claude Code session on your machine in a local dashboard — grouped by
project, with live status, titles, and token usage.

```sh
npx claude-code-session-tracker
```

Then open the printed `http://127.0.0.1:3099`.

Run Claude Code in four terminals and you lose track of which one is waiting on
you, which is still working, and what you asked the one you abandoned yesterday.
Claude Code already writes all of that to `~/.claude`. This reads it — nothing
else — and puts it on one page.

## What you get

- **Active sessions**, checked twice against the OS so a stale file or a
  recycled PID never shows up as running.
- **Recent sessions** across every project, with Claude's own title, the first
  and last prompt, the model, and the branch.
- **A detail panel** per session: message and tool-call counts, token totals,
  elapsed and working time, subagent count, a copyable `claude --resume <id>`,
  and a button that shows the transcript in your file manager.
- **`--json`** for scripting, and an HTTP API if you would rather build your own.
- **No dependencies, no install scripts, no network calls, no writes** to your
  Claude directory.

## Requirements

Node 20 or newer, and Claude Code having run at least once on this machine.
macOS, Linux, and Windows are all covered by CI. Nothing else is needed —
if `~/.claude` does not exist yet, the page says so and fills in the moment
your first session starts.

## Run it with any package manager

```sh
npx      claude-code-session-tracker   # npm
pnpm dlx claude-code-session-tracker   # pnpm
yarn dlx claude-code-session-tracker   # yarn
bunx     claude-code-session-tracker   # bun
```

The package has **no runtime dependencies** and no install scripts, so every
runner behaves the same.

## Options

| Flag | Description |
| --- | --- |
| `-p, --port <number>` | Port to listen on, stepping forward up to 20 times if taken (default `3099`) |
| `--host <address>` | Address to bind (default `127.0.0.1` — see the warning below) |
| `--no-open` | Do not open a browser |
| `--json` | Print the session list as JSON and exit |
| `-n, --limit <number>` | How many sessions to list (default `50`; running ones are always shown) |
| `--claude-dir <path>` | Override the Claude data directory |
| `-h, --help` | Show usage |
| `-v, --version` | Show the version |

## Scripting

`--json` prints the same payload the page uses, then exits:

```sh
npx claude-code-session-tracker --json | jq '.sessions[] | .project.name'
```

```jsonc
{
  "sessions": [
    {
      "id": "279ed6ae-49fd-4234-a74e-145f5535341c",
      "source": "claude-code",
      "status": "busy",              // busy · waiting · idle · ended
      "project": { "name": "…", "path": "…", "slug": "…", "gitBranch": "main" },
      "title": "Disable dependabot", // Claude's own title, when it wrote one
      "firstPrompt": "…",
      "lastPrompt": "…",
      "model": "claude-sonnet-5",
      "version": "2.1.235",          // the Claude Code that wrote the session
      "startedAt": 1787142489923,
      "lastActiveAt": 1787142700231,
      "transcriptPath": "…/279ed6ae….jsonl",
      "sizeBytes": 136133,
      "live": { "pid": 4129, "kind": "interactive", "entrypoint": "cli" }
    }
  ],
  "sources": [ /* one entry per adapter, with whether it found its data */ ],
  "total": 794,
  "generatedAt": 1787142701002
}
```

Only running sessions carry `live`. Everything else is optional — a field that
was not in the transcript is absent rather than null.

## HTTP API

The server is the same one the page talks to, so anything the page can do you
can do with `curl`:

| Route | Returns |
| --- | --- |
| `GET /api/sessions?limit=N` | The list above. `limit` matches `--limit`, and running sessions are always included |
| `GET /api/sessions/:id` | One session with `counts`, `tokens`, `models`, `activeMs`, `awaySummary`, and `notes` |
| `GET /api/health` | `ok`, the version, the Node it runs on, the resolved Claude directory, and per-source status |
| `POST /api/sessions/:id/reveal` | Shows that transcript in your file manager. Requires a loopback `Origin` |

Every route refuses a request whose `Host` is not loopback. `reveal` is the only
one that acts rather than reports, so it is a POST, it checks `Origin` as well,
and the path it opens comes from our own lookup — never from the request.

## On the page

Click any row for the full read. Everything has a key:

| Key | Does |
| --- | --- |
| <kbd>/</kbd> | Jump to the filter |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move between sessions, across both tables |
| <kbd>Home</kbd> <kbd>End</kbd> | First and last session |
| <kbd>↵</kbd> | Open the selected session |
| <kbd>Esc</kbd> | Close the panel, or clear the filter |

The list refreshes every 2 seconds and says so when the server goes away. The
page takes the same limit from the query string, so `?limit=200` and
`--limit 200` show the same depth of history.

The theme follows your OS by default; **Auto / Light / Dark** in the top right
overrides it, and the choice is remembered.

## What it reads

Everything comes from what Claude Code already writes to disk:

| Path | Used for |
| --- | --- |
| `~/.claude/sessions/<pid>.json` | Running sessions and their live status |
| `<session cwd>/.git/HEAD` | The branch a running session is on |
| `~/.claude/projects/**/*.jsonl` | Session history — titles, prompts, models, branch |
| `~/.claude.json` | Per-project rollup metrics *(not read yet)* |

Set `CLAUDE_CONFIG_DIR` (or pass `--claude-dir`) if your Claude data lives
somewhere other than `~/.claude`. Some Claude Code versions accept a
comma-separated list there; the first entry wins.

## Privacy

**The tool never writes to the Claude directory**, binds to loopback only,
rejects requests that are not addressed to a loopback host, and makes no
outbound network calls of any kind. There is no telemetry and no update check.

Transcripts hold your prompts, your paths, and sometimes your secrets. That is why
the default bind is `127.0.0.1` and why every request has to be addressed to a
loopback host — a page on any website can otherwise point a browser at your
`localhost`. Passing `--host` to something else drops that guard, so the CLI says
so, loudly, before it starts.

For a machine you are SSH'd into, forward the port instead of opening the bind:

```sh
ssh -L 3099:127.0.0.1:3099 you@the-machine
```

## Troubleshooting

**Nothing is listed.** Check `curl -s 127.0.0.1:3099/api/health` — it prints the
directory that was searched. If that is not where your transcripts are, set
`CLAUDE_CONFIG_DIR` or pass `--claude-dir`.

**A session I just started is missing.** The list refreshes every 2 seconds and
a session appears once Claude Code has written its first record.

**A session shows as idle while it is clearly working.** Status comes from what
Claude Code itself records in `~/.claude/sessions/`. If that file is stale, the
row is honest about the file rather than guessing.

**The port is taken.** It steps forward automatically, up to 20 times; the
address it actually bound is the one printed. `--port` picks a different start.

**An old session has no title.** Titles are Claude's own, and older transcripts
predate them. The derived name and the first prompt stand in.

## Programmatic use

```js
import { createConfig, SessionRegistry } from 'claude-code-session-tracker/core';

const registry = new SessionRegistry(createConfig());
const { sessions } = await registry.list({ limit: 20 });
const detail = await registry.detail(sessions[0].id);
```

`createConfig()` takes `{ claudeDir, host, port }` overrides. `registry.detail()`
resolves to `null` for an unknown id rather than throwing.

## Development

Requires Node 22.6+ for the `dev` script (native TypeScript stripping); the
published package runs on Node 20+.

```sh
pnpm install
pnpm dev                       # run from source, watch mode
pnpm build                     # tsc + copy web assets
pnpm typecheck
npm pack                       # -> claude-code-session-tracker-<version>.tgz
pnpm smoke ./claude-code-session-tracker-0.1.0.tgz pnpm
```

`pnpm smoke` installs the packed tarball into a temporary directory with the
package manager you name, then runs the installed binary against a fixture
transcript. It is what CI runs — Node 20/22/24 × npm/pnpm/yarn/bun on Linux,
plus npm on macOS and Windows — so a change that only works from source fails
before it ships.

Everything that parses a transcript lives in `src/sources/claude-code/`. The
`Source` interface in `src/sources/source.ts` is the seam a second tool
(Codex, Cursor) would plug into; `src/core/` knows nothing about Claude Code.

Releasing is a tag: `npm version <patch|minor|major>` then `git push --follow-tags`.
The release workflow re-runs the checks and publishes with npm provenance.

Project plan and phase breakdown: [`PLAN.md`](./PLAN.md).

## How it stays fast

Feature-complete for v1 — phases 0 through 4 of [`PLAN.md`](./PLAN.md).

**Running sessions** come from `~/.claude/sessions/*.json`. Those files outlive the
processes that write them, so each one is checked twice before it becomes an Active
row: `process.kill(pid, 0)`, then the recorded start time against the real one, which
is what rules out a recycled PID.

**Recent sessions** come from the transcripts, which run to about a gigabyte on a
working machine. Listing them reads no file contents at all — one `readdir` per
project and a `stat` per file is enough to sort by recency. Only the sessions
actually shown are opened, and only their first 16 KB and last 64 KB, which is where
the title, the prompts, the model and the branch live. Results are memoised against
each file's size and mtime, so an untouched transcript is never read twice. Listing
all 794 transcripts on the development machine takes ~230 ms cold and ~75 ms warm.

**Opening a session** streams its transcript once, line by line, capping how much of
any single line it holds — the largest record on the development machine is 9.4 MB,
and memory should be a property of the reader, not of the biggest tool output in the
session. A 37 MB transcript answers in 99 ms; the slowest of all 795 is 140 ms.

Malformed lines are counted and skipped, never thrown on: the `.jsonl` format is
private and undocumented, and it will change under us. When it does, the detail
panel reports what it could not read in `notes` instead of pretending.

## Contributing

Issues and pull requests are welcome. `pnpm typecheck` and a passing
`pnpm smoke` against a fresh `npm pack` are what CI will ask of a change; both
run in well under a minute locally.

Since every number here was measured on one machine, a bug report that includes
your `GET /api/health` output and the `notes` from an affected session is worth
far more than a description.

## License

MIT © [Yusuf Demirci](https://github.com/meyusufdemirci)
