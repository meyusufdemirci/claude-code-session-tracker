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
| `--claude-dir <path>` | Override the Claude data directory |
| `-h, --help` | Show usage |
| `-v, --version` | Show the version |

`--json` makes the tool scriptable:

```sh
npx claude-code-session-tracker --json | jq '.sessions[] | .project.name'
```

## What it reads

Everything comes from what Claude Code already writes to disk:

| Path | Used for |
| --- | --- |
| `~/.claude/sessions/<pid>.json` | Running sessions and their live status |
| `~/.claude/projects/**/*.jsonl` | Session history, titles, models, token counts |
| `~/.claude.json` | Per-project rollup metrics |

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

Phase 0 complete: CLI, server, static shell, and the source interface are in
place. Session listings land in Phase 1.

## License

MIT
