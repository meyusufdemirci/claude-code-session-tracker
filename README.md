# claude-code-session-tracker

[![CI](https://github.com/meyusufdemirci/claude-code-session-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/meyusufdemirci/claude-code-session-tracker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/claude-code-session-tracker)](https://www.npmjs.com/package/claude-code-session-tracker)

See every Claude Code session on your machine in a local dashboard — grouped by
project, with live status, titles, and token usage.

```sh
npx claude-code-session-tracker
```

Then open the printed `http://127.0.0.1:4747`.

## Run it with any package manager

```sh
npx     claude-code-session-tracker    # npm
pnpm dlx claude-code-session-tracker   # pnpm
yarn dlx claude-code-session-tracker   # yarn
bunx    claude-code-session-tracker    # bun
```

The package has **no runtime dependencies** and no install scripts, so every
runner behaves the same.

## Options

| Flag | Description |
| --- | --- |
| `-p, --port <number>` | Port to listen on, stepping forward if taken (default `4747`) |
| `--host <address>` | Address to bind (default `127.0.0.1` — see the warning below) |
| `--no-open` | Do not open a browser |
| `--json` | Print the session list as JSON and exit |
| `-n, --limit <number>` | How many sessions to list (default `50`; running ones are always shown) |
| `--claude-dir <path>` | Override the Claude data directory |
| `-h, --help` | Show usage |
| `-v, --version` | Show the version |

`--json` makes the tool scriptable:

```sh
npx claude-code-session-tracker --json | jq '.sessions[] | .project.name'
```

The page takes the same limit from the query string, so `?limit=200` and
`--limit 200` show the same depth of history.

## On the page

Click any row for the full read: message and tool-call counts, token totals,
elapsed and working time, the first and last prompt, a copyable
`claude --resume <id>`, and a button that shows the transcript in your file
manager.

Everything has a key:

| Key | Does |
| --- | --- |
| <kbd>/</kbd> | Jump to the filter |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move between sessions, across both tables |
| <kbd>Home</kbd> <kbd>End</kbd> | First and last session |
| <kbd>↵</kbd> | Open the selected session |
| <kbd>Esc</kbd> | Close the panel, or clear the filter |

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
somewhere other than `~/.claude`.

**The tool never writes to the Claude directory**, binds to loopback only,
rejects requests that are not addressed to a loopback host, and makes no
outbound network calls of any kind.

Transcripts hold your prompts, your paths, and sometimes your secrets. That is why
the default bind is `127.0.0.1` and why every request has to be addressed to a
loopback host — a page on any website can otherwise point a browser at your
`localhost`. Passing `--host` to something else drops that guard, so the CLI says
so, loudly, before it starts.

Nothing on disk is required to run it: with no `~/.claude` the CLI warns, starts
anyway, and the page explains where it looked and keeps checking — so it fills in
by itself the moment you start your first session.

## Programmatic use

```js
import { createConfig, SessionRegistry } from 'claude-code-session-tracker/core';

const registry = new SessionRegistry(createConfig());
const { sessions } = await registry.list({ limit: 20 });
```

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

Releasing is a tag: `npm version <patch|minor|major>` then `git push --follow-tags`.
The release workflow re-runs the checks and publishes with npm provenance.

Project plan and phase breakdown: [`PLAN.md`](./PLAN.md).

## Status

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
private and undocumented, and it will change under us.

## License

MIT
