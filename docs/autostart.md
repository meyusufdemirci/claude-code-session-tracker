# Start it at login

```sh
claude-code-session-tracker autostart on
```

On macOS and Windows this adds the tracker to your login items, so every time
you log in it starts and opens the page. It starts it right away too. No admin
rights are needed, and `autostart off` takes it out again; `autostart status`
says which way it is set.

| | What `on` adds | Where you see it | Log |
| --- | --- | --- | --- |
| macOS | A LaunchAgent at `~/Library/LaunchAgents/com.meyusufdemirci.claude-code-session-tracker.plist`, which starts a script named `Claude Code Session Tracker` so that is the name Login Items shows | System Settings → General → Login Items | `~/Library/Logs/claude-code-session-tracker.log` |
| Windows | A `Claude Code Session Tracker` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` | Settings → Apps → Startup | `%LOCALAPPDATA%\claude-code-session-tracker\tracker.log` |

It needs a copy that stays on disk — Homebrew or `npm install -g` — since `npx`
and the other one-off runners unpack into a cache they are free to clear. Run
from one of those, `on` says so and changes nothing.
