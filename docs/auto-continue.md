# Auto continue

When a usage limit reaches 100%, Claude Code stops the turn and the session sits
there until you type something. With auto continue on, each session that stopped
on the limit picks up by itself about a minute after the limit resets.

It is **off until you turn it on**, from any of three places, which all flip the
same switch:

- the **Auto continue** panel on the Settings page,
- the note under a full limit on the dashboard, which offers **Turn on auto continue**,
- **Auto continue paused sessions** at the bottom of the macOS menu bar panel,

or `claude-code-session-tracker auto-continue on` in a terminal.

## It needs the plugin

The waiting is done inside each session by the [Claude Code plugin](plugin.md),
so it has to be installed, at 0.13.0 or later:

```
/plugin marketplace add meyusufdemirci/claude-code-session-tracker
/plugin install session-tracker@claude-code-session-tracker
```

Only sessions started after the plugin is installed (or updated) carry its hook.
The Settings page and the menu bar say when the plugin is missing, too old, or
switched off.

## How it works

1. The plugin registers a hook on Claude Code's `StopFailure` event for
   `rate_limit`, with `asyncRewake` — Claude Code's own way for a background hook to
   wake a session that has gone idle.
2. When a turn is refused, the hook runs `claude-code-session-tracker auto-continue wait`
   in the background. It reads the reset Claude wrote on the refused turn and waits
   for it, plus a minute. While it waits, the page and the menu bar list the session
   as waiting.
3. At that moment it checks that auto continue is on, that you have not carried on
   in the session yourself, and — when a tracker is running — that the limit no
   longer reads as full. If all three hold, it exits with code 2, and Claude Code
   wakes the session with the message *the usage limit that stopped this session
   has reset; continue the task you were working on*.

What follows from that:

- **Any terminal.** Claude Code wakes the session itself, so it works the same in
  VS Code, Ghostty, tmux, iTerm or Terminal.
- **The session has to stay open.** The hook lives inside it; close the session and
  there is nothing left to continue. No tab, menu bar or tracker has to be running.
- **The switch is read at the reset**, not when the session stops, so turning it on
  while sessions are waiting still covers them.
- **Once per stop.** A session that is refused again waits for the next reset.
  A reading taken after the reset that still says full pushes the wake back to the
  reset it names, at most three times.
- **Weekly limits too.** The hook can wait for up to eight days.

## Where it keeps things

Nothing is written to the Claude directory. The switch and the list of waiting
sessions are in the tracker's own folder: `~/Library/Application Support/claude-code-session-tracker/`
on macOS, `%LOCALAPPDATA%\claude-code-session-tracker\` on Windows, and
`$XDG_STATE_HOME/claude-code-session-tracker/` (`~/.local/state/…`) elsewhere.
`CLAUDE_CODE_SESSION_TRACKER_STATE_DIR` points it somewhere else.
