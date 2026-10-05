# Claude Code plugin

```
/plugin marketplace add meyusufdemirci/claude-code-session-tracker
/plugin install session-tracker@claude-code-session-tracker
```

| Command | What it does |
| --- | --- |
| `/session-tracker:status` | Prints both limits and when they reset, what today has billed, and the sessions that are running |
| `/session-tracker:open` | Opens the page in your browser, starting the tracker first if it is not running |

```
  Claude Code Session Tracker 0.11.0

  5-hour limit  12% used, resets in 3h
  Weekly limit  12% used, resets in 4d 9h
  Today         3.9M tokens in 637 turns

  Running       2 sessions
    busy     my-app      Add the export dialog
    waiting  my-api      Fix the flaky login test (input needed)

  Dashboard     http://127.0.0.1:3099
```

- Claude runs `/session-tracker:status` by itself when you ask something it answers, such
  as how much of the weekly limit is left. `/session-tracker:open` only runs when you type it.
- The plugin holds no code of its own. Each command runs this CLI: the copy on your
  `PATH` when there is one, otherwise `npx claude-code-session-tracker` at the plugin's own version,
  which downloads the package the first time. Both need a version that has the
  `status` command, 0.11.0 or later.
- Only the installed copy is pre-approved. Claude Code asks before it runs the
  `npx` fallback, so install the CLI to skip the question.
- `/session-tracker:status` starts nothing. A tracker that is already running is asked,
  and when none is the same numbers are read straight from your Claude directory.
- `/session-tracker:open` reuses a tracker that is already running, whoever started it.
  One it starts keeps running in the background after the command returns, with
  its output in the same log `autostart` writes on macOS and Windows, and under
  `~/.local/state/claude-code-session-tracker/` on Linux. Stop it with the menu bar
  switch, or by ending the `claude-code-session-tracker` process.

The same two commands work in any terminal, as `claude-code-session-tracker status`
and `claude-code-session-tracker open`.
