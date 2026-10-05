# Session Tracker for Claude Code

See your Claude Code usage limits, the sessions running on this machine and
today's tokens without leaving the terminal, and open the local dashboard.

| Command | What it does |
| --- | --- |
| `/session-tracker:status` | Prints both limits and when they reset, what today has billed, and the sessions that are running |
| `/session-tracker:open` | Opens the dashboard in your browser, starting the tracker first if it is not running |

Claude runs `/session-tracker:status` by itself when you ask something it
answers, such as how much of the weekly limit is left. `/session-tracker:open`
only runs when you type it.

## What it runs

The plugin holds no code of its own. Each command runs the
[Claude Code Session Tracker](https://github.com/meyusufdemirci/claude-code-session-tracker)
CLI: the copy on your `PATH` when there is one, otherwise the npm package
`claude-code-session-tracker` through `npx`, at the same version as the plugin.
Only the installed copy is pre-approved. Claude Code asks you before it runs the
`npx` fallback, so install the CLI (`npm install -g claude-code-session-tracker`)
to skip the question.

- `status` starts nothing. It asks a tracker that is already running, and when
  none is it reads the same numbers from your Claude directory.
- `open` starts the tracker in the background if it is not running, then opens
  its page, which is served on `127.0.0.1` only.

## What it reads and sends

Everything comes from files Claude Code already keeps on your machine: its
session and transcript files, and the usage readout it caches. The tool never
writes to the Claude directory, and there is no telemetry and no update check.

It makes one outbound call: the usage endpoint Claude Code's own `/usage` reads,
at `api.anthropic.com`, at most every five minutes. For that it reads the token
Claude Code is signed in with, and sends it only there. Starting the tracker
with `--offline` turns the call off, and the token is then not read at all.

The first `npx` run downloads the package from the npm registry. See
[privacy](https://github.com/meyusufdemirci/claude-code-session-tracker/blob/main/docs/privacy.md)
for the full list.

## License

MIT
