# claude-code-session-tracker

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
| `--host <address>` | Address to bind (default `127.0.0.1`) |
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
pnpm dev          # run from source, watch mode
pnpm build        # tsc + copy web assets
pnpm typecheck
```

Project plan and phase breakdown: [`PLAN.md`](./PLAN.md).

## Status

Phases 0–2 complete. The dashboard shows **Active** sessions above **Recent** ones,
with a filter box over both, polled every 2 seconds.

Session files outlive the processes that write them, so each one is checked twice
before it becomes an Active row: `process.kill(pid, 0)`, then the recorded start
time against the real one, which is what rules out a recycled PID.

Recent sessions come from the transcripts, which run to about a gigabyte on a
working machine. Listing them reads no file contents at all — one `readdir` per
project and a `stat` per file is enough to sort by recency. Only the sessions
actually shown are opened, and only their first 16 KB and last 64 KB, which is
where the title, the prompts, the model and the branch live. Results are memoised
against each file's size and mtime, so an untouched transcript is never read twice.
Listing all 794 transcripts on the development machine takes ~230 ms cold and
~75 ms warm.

Clicking a session for full token and message counts is Phase 3.

## License

MIT
