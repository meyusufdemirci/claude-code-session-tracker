---
name: status
description: Show the Claude Code usage limits (5-hour and weekly), the sessions running on this machine and the tokens billed today. Use when the user asks how much of their limit is left, when it resets, what sessions are running, or how much they have used today.
allowed-tools: Bash(claude-code-session-tracker status:*), Bash(npx -y claude-code-session-tracker@0.11.0 status:*)
---

This is the Claude Code Session Tracker's summary of this machine, read just now:

```
!`claude-code-session-tracker status 2>/dev/null || npx -y claude-code-session-tracker@0.11.0 status`
```

Show the user that summary exactly as printed, in a code block, and add nothing
to it unless they asked a question it answers, in which case answer that in one
line first. Do not recompute or round the numbers.

When the Dashboard line says it is not running, mention once that
`/session-tracker:open` starts it and opens the page.
