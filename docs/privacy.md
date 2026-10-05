# Privacy

**The tool never writes to the Claude directory**, binds to loopback only,
and rejects requests that are not addressed to a loopback host. Its one outbound
call is the usage endpoint Claude Code's own `/usage` reads, at
`api.anthropic.com`, sent only Claude Code's own token and at most every five
minutes; `--offline` turns it off and the tool then makes no network calls at all.
There is no telemetry and no update check. The one other download is the one you
ask for by name: `menubar install` fetches the macOS app from this project's GitHub
releases, once, and checks it against the checksum the package was published with. With
`--with-tracker` it also runs `brew install` or `npm install -g` for the tracker itself. The history page's export is written in
the browser and saved to your disk, and **Share** only opens X's or LinkedIn's own
compose page when you click it — the image goes by your clipboard, never by us.

Transcripts hold your prompts, your paths, and sometimes your secrets. That is why
the default bind is `127.0.0.1` and why every request has to be addressed to a
loopback host — a page on any website can otherwise point a browser at your
`localhost`. Passing `--host` to something else drops that guard, so the CLI says
so, loudly, before it starts.

For a machine you are SSH'd into, forward the port instead of opening the bind:

```sh
ssh -L 3099:127.0.0.1:3099 you@the-machine
```

## What it reads

Everything comes from what Claude Code already writes to disk:

| Path | Used for |
| --- | --- |
| `~/.claude/sessions/<pid>.json` | Running sessions and their live status |
| `<session cwd>/.git/HEAD` | The branch a running session is on |
| `~/.claude/projects/**/*.jsonl` | Session history — titles, prompts, models, branch |
| `~/.claude/projects/*/*/subagents/agent-*.jsonl` | Subagent turns, for the limit windows they bill to |
| `~/.claude.json` | The usage readout Claude Code caches — how full each limit is, and when it resets |
| Keychain item `Claude Code-credentials` (macOS), or `~/.claude/.credentials.json` | The token Claude Code is signed in with, to ask the server for the same readout. Read, never refreshed or written. Not read with `--offline` |

Set `CLAUDE_CONFIG_DIR` (or pass `--claude-dir`) if your Claude data lives
somewhere other than `~/.claude`. Some Claude Code versions accept a
comma-separated list there; the first entry wins.
